#!/usr/bin/env node
// eBay 卖家 MCP（stdio）：Terapeak 商品调研（已售成交、走势、类目、在售竞争）、eBay 前台搜索，和刊登（预检 → 确认后发布）。
// 调研和搜索通过本机紫鸟店铺浏览器里已登录的 eBay Seller Hub 页面取数（只读）；刊登走 eBay 开放平台（开发者密钥 + 店铺授权）。
// 协议：每行一条 JSON-RPC 2.0 消息；stdout 只写协议消息，诊断写 stderr。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { authorizeStore } from '../lib/auth-flow.mjs';
import { LockBusyError, withBrowserLock, withLock } from '../lib/browser-lock.mjs';
import { createBrowserSession, EBAY_SITE, navigateAndWait, PageBlockedError, SEARCH_SITE } from '../lib/browser.mjs';
import { CooldownError, createCooldown, isVerifyMessage } from '../lib/cooldown.mjs';
import { ApiError, describe, FINANCES_BASE, parseFees, restCall, TokenRejectedError, tradingCall, uploadImage } from '../lib/ebay-api.mjs';
import { createTerapeakApi, EbayError } from '../lib/ebay.mjs';
import {
  activeItemIds, allImages, applyDefaults, buildItemXml, createImageUploader, createPreviewStore, ListingError, listingSummary, newPreviewId,
  newUuid, normalizeListing, parseItemDefaults, pickDefaults, publishPreview,
} from '../lib/listing.mjs';
import { applyChange, buildReviseXml, END_REASONS, planEnd, planRelist, planRevise, reviseSnapshot, reviseSteps } from '../lib/changes.mjs';
import { parseItemDetail, parseSellingList, sellingRequest } from '../lib/manage.mjs';
import { ORDER_STATUS, orderErrorMessage, ordersPath, parseOrder, parseStandards, parseTraffic, summarizeOrders, TRAFFIC_DAYS, trafficPath, trafficRange } from '../lib/store.mjs';
import { AD_ACTIONS, applyAdChange, campaignSnapshot, loadAllAds, planAdChange } from '../lib/adchanges.mjs';
import { AD_DAYS, adsPath, CAMPAIGN_STATUS, campaignsPath, createReportStore, parseAd, parseCampaign, parseReportTsv, REPORTS, reportBody, reportRange, reportText, reportTotals } from '../lib/ads.mjs';
import { FIN_DAYS, mergeTransactionSummaries, parseFunds, parsePayout, parseTransaction, payoutsPath, sinceIso, summarizeTransactions, transactionsPath, TX_STATUSES, TX_TYPES } from '../lib/finance.mjs';
import { AuthError, createTokenProvider, defaultKeysFile, LISTING_SCOPES, MARKETING_SCOPES, READ_SCOPES } from '../lib/oauth.mjs';
import { CONDITIONS, parseResults, readSearchPage, searchUrl, SORTS } from '../lib/search.mjs';
import { ShopConfigError, parseShops, resolveShop } from '../lib/shops.mjs';
import {
  activeSearchRequest, categoryRequest, DAY_RANGES, INTERVALS, monthly, parseActiveSearch, parseCategoryTree, parseSoldSearch, parseTrend, researchRange,
  soldSearchRequest, trendRequest,
} from '../lib/terapeak.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const DATA_DIR = process.env.EBAY_DATA_DIR || join(homedir(), '.ebay-seller-mcp');

class QueryError extends Error {}

// 配置错误不让进程退出（客户端只会显示 exited with code 1），而是在每次调用时说明
let SHOPS = [];
let configError = null;
try {
  SHOPS = parseShops(process.env);
} catch (err) {
  configError = err;
}
const shopFor = (ref) => {
  if (configError) throw configError;
  return resolveShop(SHOPS, ref);
};

// ---- 浏览器：每家店一个工作标签页；本进程内排队，跨进程用数据目录里的锁文件 ----
// 每家店两个工作标签页：Seller Hub Research（Terapeak 接口）和前台搜索页
const sessions = new Map();
const sessionFor = (site, storeId) => {
  const key = `${site.urlPrefix}|${storeId}`;
  if (!sessions.has(key)) sessions.set(key, createBrowserSession(site));
  return sessions.get(key);
};
let queue = Promise.resolve();
const exclusive = (fn) => {
  const run = queue.then(() => withBrowserLock(DATA_DIR, fn, { owner: `ebay-seller-mcp ${process.pid}` }));
  queue = run.catch(() => {});
  return run;
};

// 结果缓存：Terapeak 是按天汇总的数据，前台搜索变化快一些；同样的查询短时间内不重复发请求
const CACHE_TTL = { research: 30 * 60_000, search: 10 * 60_000, api: 30 * 60_000, taxonomy: 24 * 3600_000 };
const cache = new Map();
const inflight = new Map();
/** 命中缓存时不碰浏览器；同样的查询正在跑时等它的结果，不再发第二次。出错不缓存 */
async function cachedResult(kind, key, load) {
  const k = `${kind}|${key}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_TTL[kind]) return { ...hit.value, cached: true };
  if (inflight.has(k)) return inflight.get(k);
  const p = (async () => {
    const value = await load();
    cache.set(k, { at: Date.now(), value });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return value;
  })();
  inflight.set(k, p);
  try {
    return await p;
  } finally {
    inflight.delete(k);
  }
}

const isUserError = (err) => err instanceof QueryError || err instanceof CooldownError || err instanceof EbayError || err instanceof PageBlockedError
  || err instanceof ShopConfigError || err instanceof AuthError || err instanceof ApiError || err instanceof ListingError;
const cooldown = createCooldown({ dir: DATA_DIR });

/** 在某家店的工作标签页里执行：fn({ cdp, graphql, fresh })；site 决定用哪个标签页，home 是新开标签页时直接打开的地址 */
function withEbay(shopRef, fn, { site = EBAY_SITE, home } = {}) {
  const shop = shopFor(shopRef);
  return exclusive(async () => {
    cooldown.check(shop);
    const session = sessionFor(site, shop.storeId);
    try {
      const cdp = await session.connect(shop.storeId, () => {}, { home });
      const fresh = session.info()?.justOpened === true;
      const out = await fn({ cdp, graphql: createTerapeakApi(cdp), fresh });
      return { shop: shop.name, ...out };
    } catch (err) {
      if (isVerifyMessage(err?.message)) cooldown.note(shop, err);
      if (!isUserError(err)) session.reset();
      throw err;
    }
  });
}

/** 进浏览器排队之前先查参数，错了立刻返回 */
function precheck(a) {
  if (a.keyword !== undefined) {
    const k = a.keyword.trim();
    if (!k) throw new QueryError('keyword 不能为空');
    if (k.length > 200) throw new QueryError('keyword 最多 200 个字符');
  }
  if (a.query !== undefined && !a.query.trim()) throw new QueryError('query 不能为空');
  if (a.campaign_id !== undefined && !/^\d{1,20}$/.test(a.campaign_id)) throw new QueryError('campaign_id 应是数字活动 ID（ebay_ad_campaigns 查）');
  if (a.item_id !== undefined && !/^\d{9,15}$/.test(a.item_id)) throw new QueryError('item_id 应是 eBay 的 ItemID（9~15 位数字，ebay_listings 查）');
  if (a.query !== undefined && a.query.length > 350) throw new QueryError('query 最多 350 个字符');
  if (a.category_id !== undefined && !/^\d{1,12}$/.test(a.category_id)) throw new QueryError('category_id 应是数字类目 ID（用 ebay_research_categories 查）');
  for (const k of ['price_min', 'price_max']) if (a[k] !== undefined && !(Number.isFinite(a[k]) && a[k] >= 0)) throw new QueryError(`${k} 应是不小于 0 的数字（美元）`);
  if (a.price_min !== undefined && a.price_max !== undefined && a.price_min > a.price_max) throw new QueryError('price_min 不能大于 price_max');
}

const RESEARCH_NOTE = '数据来自 Terapeak（eBay Seller Hub → Research），eBay 美国站；日期按美国太平洋时间，金额美元；只统计已付款、未退款的成交。';
const rangeOut = (r) => ({ days: r.days, start: r.start, end: r.end });
const keyOf = (a, keys) => JSON.stringify(keys.map((k) => a[k] ?? null));

const research = (a) => {
  const range = researchRange(a.days ?? 90);
  const pageSize = a.page_size ?? 20;
  const page = a.page ?? 1;
  return cachedResult('research', `${shopFor(a.shop).storeId}|sold|${keyOf(a, ['keyword', 'category_id'])}|${range.start}|${range.end}|${page}|${pageSize}`, () => withEbay(a.shop, async ({ graphql }) => {
    const req = soldSearchRequest({ keyword: a.keyword.trim(), range, categoryId: a.category_id, offset: (page - 1) * pageSize, limit: pageSize });
    const out = parseSoldSearch(await graphql(req.query, req.variables, req.extra, { require: 'terapeakResearch.summary', consumes: ['terapeakResearch', 'soldSearchResults'] }));
    return { keyword: a.keyword.trim(), ...rangeOut(range), category_id: a.category_id ?? null, page, ...out,
      note: `${RESEARCH_NOTE}summary：avg_sold_price 成交均价（avg_sold_price_change 较上一个同长度周期，比例）、价格区间、平均运费、free_shipping_share 包邮占比、`
        + 'items_sold 成交件数、total_sales 成交总额、sold_listings / unsold_listings 有成交 / 没成交的 listing 数、sell_through 售罄率（有成交 listing 占比）、sellers 卖家数。'
        + 'listings：按成交件数排的 listing，avg_sold_price 是这条 listing 的成交均价。' };
  }));
};

const researchTrend = (a) => {
  const range = researchRange(a.days ?? 90);
  const interval = a.interval ?? 'day';
  return cachedResult('research', `${shopFor(a.shop).storeId}|trend|${keyOf(a, ['keyword', 'category_id'])}|${range.start}|${range.end}|${interval}`, () => withEbay(a.shop, async ({ graphql }) => {
    const req = trendRequest({ keyword: a.keyword.trim(), range, categoryId: a.category_id, interval });
    const data = await graphql(req.query, req.variables, req.extra, { require: 'terapeakResearch.salesTrends', consumes: ['terapeakResearch'] });
    const points = interval === 'month' ? monthly(parseTrend(data, { raw: true })) : parseTrend(data);
    return { keyword: a.keyword.trim(), ...rangeOut(range), interval, points,
      note: `${RESEARCH_NOTE}每个点是这一${{ day: '天', week: '周', month: '月' }[interval]}的成交均价和成交件数（date 是这段的第一天）。成交均价受个别高价商品影响大，看走势时结合件数。` };
  }));
};

const researchCategories = (a) => {
  const range = researchRange(a.days ?? 90);
  return cachedResult('research', `${shopFor(a.shop).storeId}|cat|${keyOf(a, ['keyword', 'category_id'])}|${range.start}|${range.end}`, () => withEbay(a.shop, async ({ graphql }) => {
    const req = categoryRequest({ keyword: a.keyword.trim(), range, categoryId: a.category_id ?? '0' });
    const tree = parseCategoryTree(await graphql(req.query, req.variables, req.extra, { require: 'category', consumes: ['category'] }));
    if (!tree) throw new EbayError(`类目 ${a.category_id} 不存在（eBay 美国站），不传 category_id 从根类目开始查`);
    return { keyword: a.keyword.trim(), ...rangeOut(range), ...tree,
      note: `${RESEARCH_NOTE}children 是这个类目下有成交的子类目，按成交件数排；把子类目的 id 作为 category_id 再查一次可以往下钻，也可以用在 ebay_research / ebay_research_trend 上。` };
  }));
};

const researchActive = (a) => {
  const page = a.page ?? 1;
  return cachedResult('research', `${shopFor(a.shop).storeId}|active|${keyOf(a, ['keyword'])}|${page}|${a.limit ?? 50}`, () => withEbay(a.shop, async ({ graphql }) => {
    const req = activeSearchRequest({ keyword: a.keyword.trim(), page });
    const out = parseActiveSearch(await graphql(req.query, req.variables, req.extra, { require: 'activeTabAggregates.summary', consumes: ['activeTabAggregates', 'activeSearchResults'] }));
    out.listings = out.listings.slice(0, a.limit ?? 50);
    return { keyword: a.keyword.trim(), page, ...out,
      note: 'Terapeak 在售 listing（eBay 美国站，标题匹配关键词），金额美元。summary：listings 在售数、avg_price 平均售价、avg_shipping 平均运费、包邮占比、promoted_share 付费推广占比。'
        + 'listings：price 当前价、shipping 运费、watchers 关注人数、promoted 是否付费推广、listed_at 上架日期。' };
  }));
};

const search = (a) => {
  const page = a.page ?? 1;
  const url = searchUrl({ keyword: a.keyword.trim(), sort: a.sort ?? 'best_match', condition: a.condition, buyItNow: a.buy_it_now === true, priceMin: a.price_min, priceMax: a.price_max, categoryId: a.category_id, page });
  return cachedResult('search', `${shopFor(a.shop).storeId}|${url}|${a.limit ?? 60}`, () => withEbay(a.shop, async ({ cdp, fresh }) => {
    // 新开的标签页已经打开了这个地址；复用的标签页要跳过去
    if (!fresh) await navigateAndWait(cdp, url, SEARCH_SITE);
    const raw = await cdp.callInPage(readSearchPage, null, 15_000);
    if (raw?.path?.startsWith('/b/')) throw new EbayError('eBay 把这个关键词直接转到了类目页（不是搜索结果页），暂不支持：换一个更具体的关键词，或先用 ebay_research_categories 找类目 ID 再传 category_id');
    const items = parseResults(raw);
    // 没有有效商品（过滤掉占位卡片后）：只有整页加载完、而且有结果区域才算真的没结果；否则是页面没加载全或结构变了（都不缓存）
    if (!items.length) {
      if (!raw?.has_results) throw new EbayError('eBay 搜索页里没找到结果列表（页面结构可能改版了，或这个关键词没有结果页）');
      if (!raw?.complete) throw new EbayError('eBay 搜索页还没加载完（结果列表是空的），请稍后再试');
    }
    return { keyword: a.keyword.trim(), sort: a.sort ?? 'best_match', page, total: raw?.total || null, items: items.slice(0, a.limit ?? 60),
      note: 'eBay 前台搜索结果（买家看到的样子，按这家店紫鸟浏览器的收货地显示运费），金额美元。position 是在这一页的排名位置；price_max 是多规格的价格上限，was_price 是划线原价；'
        + 'sold 是卡片上的「已售」件数（「1.2K+ sold」取下限）；shipping 0 = 包邮，null = 卡片上没写。分不出哪些是广告位（推广情况看 ebay_research_active）。' };
  }, { site: SEARCH_SITE, home: url }));
};

const shops = () => {
  if (configError) throw configError;
  return {
    shops: SHOPS.map((s) => ({ name: s.name, store_id: s.storeId, default: s.isDefault })),
    data_dir: DATA_DIR.startsWith(homedir()) ? `~${DATA_DIR.slice(homedir().length)}` : DATA_DIR,
    note: SHOPS.length ? '工具里的 shop 参数填店铺名或紫鸟店铺 ID；不填 = 默认店。' : '没有配置店铺：设置 EBAY_SHOPS（JSON 数组）或 EBAY_STORE_ID。',
  };
};

// ---- 刊登（eBay 开放平台）：密钥 + 店铺授权在 EBAY_API_KEYS 指向的文件里 ----
const KEYS_FILE = defaultKeysFile();
const tokens = createTokenProvider({ file: KEYS_FILE });
const previews = createPreviewStore({ dir: DATA_DIR });
const reports = createReportStore({ dir: DATA_DIR });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AUTH_HINT = (storeId) => `npx -y ebay-seller-mcp@latest auth --store-id ${storeId}`;

/** 用这家店的用户令牌调接口；令牌被拒（401 / 授权错误）时换一次新令牌再试（被拒的请求不会生效） */
async function withUserToken(shop, fn, { listing = false, needScopes = null } = {}) {
  const get = () => tokens.userToken(shop.storeId, { needScopes: [...(listing ? LISTING_SCOPES : []), ...(needScopes ?? [])] });
  try {
    return await fn(await get());
  } catch (err) {
    if (!(err instanceof TokenRejectedError)) throw err;
    tokens.forget(shop.storeId);
    try {
      return await fn(await get());
    } catch (again) {
      if (again instanceof TokenRejectedError) throw new AuthError(`eBay 拒绝了这家店的授权（可能被撤销）：运行「${AUTH_HINT(shop.storeId)}」重新授权`);
      throw again;
    }
  }
}

const appGet = async (path) => {
  try {
    return await restCall({ token: await tokens.appToken(), path });
  } catch (err) {
    if (!(err instanceof TokenRejectedError)) throw err;
    throw new AuthError('eBay 拒绝了开发者密钥的应用令牌：到 developer.ebay.com 的 Application Keys 检查密钥集是否被停用');
  }
};

const failIf = (r, what) => {
  if (r.ack === 'Failure' || r.ack === 'PartialFailure') throw new ApiError(`${what}失败：${describe(r.errors).join('；') || r.ack}`);
  return r;
};

/** 店里的运费 / 退货 / 付款政策 + 最近几条在售 listing 用的发货地和政策（当默认值） */
function loadDefaults(shop) {
  return cachedResult('api', `${shop.storeId}|defaults`, () => withUserToken(shop, async (token) => {
    const get = (path) => restCall({ token, path });
    const [f, r, p] = await Promise.all(['fulfillment_policy', 'return_policy', 'payment_policy'].map((k) => get(`/sell/account/v1/${k}?marketplace_id=EBAY_US`)));
    const policies = {
      fulfillment: (f.fulfillmentPolicies ?? []).map((x) => ({
        id: String(x.fulfillmentPolicyId), name: x.name, handling_days: x.handlingTime?.value ?? null,
        services: (x.shippingOptions ?? []).flatMap((o) => (o.shippingServices ?? []).map((s) => ({ scope: o.optionType, service: s.shippingServiceCode, free: s.freeShipping === true, cost: s.shippingCost ? Number(s.shippingCost.value) : null }))),
      })),
      return: (r.returnPolicies ?? []).map((x) => ({ id: String(x.returnPolicyId), name: x.name, returns_accepted: x.returnsAccepted === true, period_days: x.returnPeriod?.value ?? null, paid_by: x.returnShippingCostPayer ?? null })),
      payment: (p.paymentPolicies ?? []).map((x) => ({ id: String(x.paymentPolicyId), name: x.name, immediate_pay: x.immediatePay === true })),
    };
    const sell = failIf(await tradingCall({ token, call: 'GetMyeBaySelling', body: sellingRequest({ status: 'active', pageSize: 5, sort: 'StartTimeDescending' }) }), '读在售 listing ');
    const items = [];
    for (const id of activeItemIds(sell.xml).slice(0, 3)) {
      const g = await tradingCall({ token, call: 'GetItem', body: `<ItemID>${id}</ItemID><DetailLevel>ReturnAll</DetailLevel>` });
      if (g.ack !== 'Failure') items.push(parseItemDefaults(g.xml));
    }
    return { shop: shop.name, ebay_user_id: tokens.grantInfo(shop.storeId).ebay_user_id, policies, defaults: pickDefaults(items), recent_categories: [...new Set(items.map((x) => x.category_id).filter(Boolean))] };
  }));
}

const listings = async (a) => {
  const shop = shopFor(a.shop);
  const status = a.status ?? 'active';
  const page = a.page ?? 1;
  return withUserToken(shop, async (token) => {
    const r = failIf(await tradingCall({ token, call: 'GetMyeBaySelling', body: sellingRequest({ status, page, pageSize: a.page_size ?? 50, sort: status === 'active' ? 'StartTimeDescending' : undefined }) }), '读 listing 列表');
    const out = parseSellingList(r.xml, status);
    return { shop: shop.name, status, page, ...out,
      note: `${status === 'active' ? '在售' : '已结束未售出（可重新上架）'}的 listing，按上架时间从新到旧。price 是单价（多规格时是最低价，price_max 是最高价），quantity_available 可售数量，`
        + 'quantity_sold 已售件数，watchers 关注人数，variations 规格数。改某一条先用 ebay_listing_get 看详情。' };
  });
};

const listingGet = async (a) => {
  const shop = shopFor(a.shop);
  return withUserToken(shop, async (token) => {
    const r = failIf(await tradingCall({ token, call: 'GetItem', body: `<ItemID>${a.item_id}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics>` }), '读 listing ');
    const d = parseItemDetail(r.xml);
    const { description, ...rest } = d;
    const full = a.include_description === true;
    return { shop: shop.name, ...rest, description: full ? description : description.slice(0, 1500), description_chars: description.length, description_truncated: !full && description.length > 1500,
      note: 'quantity_available = 可售数量（总数减已售）；多规格的价格、数量在 variations.items 里。改这条 listing 用 ebay_listing_revise_preview；要完整描述传 include_description=true。' };
  });
};

const listingDefaults = async (a) => {
  const out = await loadDefaults(shopFor(a.shop));
  return { ...out, note: 'policies：店里的运费（fulfillment）/ 退货（return）/ 付款（payment）政策；defaults：最近在售 listing 最常用的发货地和政策组合，ebay_listing_preview 不传 policies / location 时就用它。'
    + 'recent_categories 是最近 listing 用的类目 ID。' };
};

const categorySuggest = (a) => cachedResult('taxonomy', `suggest|${a.query.trim().toLowerCase()}`, async () => {
  const j = await appGet(`/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(a.query.trim())}`);
  const list = (j.categorySuggestions ?? []).map((s) => ({
    category_id: s.category?.categoryId, name: s.category?.categoryName,
    path: [...(s.categoryTreeNodeAncestors ?? [])].sort((x, y) => x.categoryTreeNodeLevel - y.categoryTreeNodeLevel).map((x) => x.categoryName).concat(s.category?.categoryName).join(' > '),
  }));
  return { query: a.query.trim(), suggestions: list.slice(0, 10),
    note: 'eBay 美国站按关键词推荐的叶子类目（刊登只能用叶子类目），排在前面的更匹配。也可以参考 ebay_listing_defaults 的 recent_categories（店里已有商品用的类目）和 ebay_research_categories（这类商品实际成交最多的类目）。' };
});

const categoryAspects = (a) => cachedResult('taxonomy', `aspects|${a.category_id}`, async () => {
  const id = a.category_id;
  const [asp, cond, struct] = await Promise.all([
    appGet(`/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${id}`),
    appGet(`/sell/metadata/v1/marketplace/EBAY_US/get_item_condition_policies?filter=${encodeURIComponent(`categoryIds:{${id}}`)}`).catch((err) => ({ error: err.message })),
    appGet(`/sell/metadata/v1/marketplace/EBAY_US/get_listing_structure_policies?filter=${encodeURIComponent(`categoryIds:{${id}}`)}`).catch((err) => ({ error: err.message })),
  ]);
  const order = { required: 0, recommended: 1, optional: 2 };
  const aspects = (asp.aspects ?? []).map((x) => {
    const c = x.aspectConstraint ?? {};
    const values = (x.aspectValues ?? []).map((v) => v.localizedValue);
    return {
      name: x.localizedAspectName,
      usage: c.aspectRequired ? 'required' : String(c.aspectUsage ?? 'OPTIONAL').toLowerCase(),
      mode: c.aspectMode === 'SELECTION_ONLY' ? 'select_only' : 'free_text',
      multi: c.itemToAspectCardinality === 'MULTI',
      for_variations: c.aspectEnabledForVariations === true,
      max_length: c.aspectMaxLength ?? null,
      values: values.slice(0, 25), values_total: values.length,
    };
  }).sort((x, y) => (order[x.usage] ?? 3) - (order[y.usage] ?? 3));
  const condPolicy = cond.itemConditionPolicies?.[0];
  return {
    category_id: id,
    aspects: aspects.filter((x) => x.usage !== 'optional').concat(aspects.filter((x) => x.usage === 'optional').slice(0, 20)),
    optional_more: Math.max(0, aspects.filter((x) => x.usage === 'optional').length - 20),
    conditions: condPolicy ? (condPolicy.itemConditions ?? []).map((c) => ({ condition_id: Number(c.conditionId), name: c.conditionDescription })) : null,
    condition_required: condPolicy?.itemConditionRequired ?? null,
    variations_supported: struct.listingStructurePolicies?.[0]?.variationsSupported ?? null,
    note: 'aspects：这个类目的商品属性（required 必填，recommended 建议填，optional 可选，只列前 20 个）；select_only 只能从 values 里选，free_text 可以自己写（values 是常见值）；'
      + 'multi 可以填多个值；for_variations 可以当多规格的规格名。conditions：能用的商品状态（condition_id）。variations_supported：这个类目能不能做多规格。',
  };
});

const uploadImages = (token) => createImageUploader({
  dir: DATA_DIR,
  upload: async (img, data) => {
    try {
      return await uploadImage({ token, ref: img.ref, data, filename: basename(img.ref) });
    } catch (err) {
      if (err instanceof ApiError && !(err instanceof TokenRejectedError)) throw new ListingError(`${basename(img.ref)}：${err.message}`);
      throw err;
    }
  },
});

const listingPreview = async (a) => {
  const shop = shopFor(a.shop);
  const { shop: _s, ...input } = a;
  const defaults = await loadDefaults(shop);
  const listing = applyDefaults(normalizeListing(input), defaults);
  return withUserToken(shop, async (token) => {
    const pictures = await uploadImages(token)(allImages(listing));
    const id = newPreviewId();
    const uuid = newUuid();
    const itemXml = buildItemXml(listing, { pictures, uuid });
    const v = await tradingCall({ token, call: 'VerifyAddFixedPriceItem', body: itemXml, timeoutMs: 120_000 });
    const ok = v.ack === 'Success' || v.ack === 'Warning';
    const fees = parseFees(v.xml);
    const summary = listingSummary(listing, defaults);
    if (ok) previews.save({ id, store_id: shop.storeId, created_at: new Date().toISOString(), uuid, item_xml: itemXml, summary, fees, status: 'ready' });
    return {
      shop: shop.name, ok, preview_id: ok ? id : null, errors: describe(v.errors), warnings: describe(v.warnings), fees, summary,
      note: ok
        ? 'eBay 校验通过（还没有刊登）。把 summary（标题、类目、价格 / 规格、数量、政策、发货地）和 fees（刊登费用）给用户核对；用户明确同意后，用 preview_id 调 ebay_listing_publish 发布。24 小时内有效；要改内容就重新预检。'
        : 'eBay 校验没通过（没有刊登）：按 errors 改参数后重新预检。warnings 不影响刊登，但最好处理。',
    };
  }, { listing: true });
};

const listingPublish = async (a) => {
  const shop = shopFor(a.shop);
  if (a.confirm !== true) throw new QueryError('confirm 要传 true：发布前必须把预检摘要给用户看过并得到明确同意');
  previews.load(a.preview_id); // 先查格式和记录在不在，再拿令牌
  // 这条预检的跨进程锁：同一时间只有一个任务在发它；进程退出锁就释放
  const lock = (id, fn) => withLock(DATA_DIR, fn, { key: `publish:${id}`, what: '这条预检的发布', waitMs: 5000, owner: `ebay-seller-mcp ${process.pid}` }).catch((err) => {
    if (err instanceof LockBusyError) throw new ListingError('这条预检正在被另一个任务发布，等它结束后再用同一个 preview_id 调 ebay_listing_publish 查结果；不要重新预检，也不要换别的方式刊登。');
    throw err;
  });
  // 令牌被拒时 withUserToken 换令牌重来：被拒的请求没有生效
  const r = await withUserToken(shop, (token) => publishPreview({
    previews, id: a.preview_id, storeId: shop.storeId, describe, lock,
    add: (xml) => tradingCall({ token, call: 'AddFixedPriceItem', body: xml, timeoutMs: 180_000 }),
  }), { listing: true });
  if (!r.ok && r.still_unknown) {
    return { shop: shop.name, ok: false, outcome_unknown: true, errors: r.errors, warnings: r.warnings,
      note: '这次重发 eBay 报了错，但之前那次发布的结果仍然不确定（可能已经刊登）。先到 Seller Hub → Listings 看有没有这个商品：有就不用再发；'
        + '没有的话稍后用同一个 preview_id 再试。只有确认 Seller Hub 里没有这个商品时，才可以重新预检（新预检会当成新商品刊登）。' };
  }
  if (!r.ok) return { shop: shop.name, ok: false, errors: r.errors, warnings: r.warnings, note: 'eBay 拒绝了刊登（没有刊登）：按 errors 改参数后重新预检、确认、发布。' };
  const url = r.item_id ? `https://www.ebay.com/itm/${r.item_id}` : null;
  const note = r.already_published
    ? (r.item_id ? '这条预检之前已经刊登过了，没有重复刊登，这是原来的 ItemID。' : '这条预检之前已经刊登过了（eBay 按 UUID 认出来），但没返回 ItemID，请到 Seller Hub → Listings 查看。')
    : '已刊登。刊登后的修改请在 Seller Hub 里做。';
  return { shop: shop.name, ok: true, item_id: r.item_id, url, already_published: r.already_published === true, summary: r.rec.summary,
    ...(r.xml ? { fees: parseFees(r.xml), warnings: r.warnings } : {}), note };
};

// ---- 自家店铺数据（eBay 开放平台，只读）：订单、流量、卖家表现 ----
const orders = async (a) => {
  const shop = shopFor(a.shop);
  const pageSize = a.page_size ?? 50;
  const page = a.page ?? 1;
  return withUserToken(shop, async (token) => {
    let j;
    try {
      j = await restCall({ token, path: ordersPath({ days: a.days ?? 30, status: a.status ?? 'all', limit: pageSize, offset: (page - 1) * pageSize }) });
    } catch (err) {
      // 订单接口的报错原文可能带订单 / 买家信息：只给状态码和错误码
      if (err instanceof ApiError && !(err instanceof TokenRejectedError) && orderErrorMessage(err)) throw new ApiError(orderErrorMessage(err));
      throw err;
    }
    const list = (j.orders ?? []).map(parseOrder);
    return {
      shop: shop.name, days: a.days ?? 30, status: a.status ?? 'all', page, total: j.total ?? list.length, orders: list, summary: summarizeOrders(list),
      note: '自家店铺订单（eBay 美国站，按下单时间从新到旧，时间是 UTC）。fulfillment_status：NOT_STARTED 未发货 / IN_PROGRESS 部分发货 / FULFILLED 已发货；'
        + 'status=unshipped 是还没发完的（含部分发货），shipped 是发了货的（也含部分发货）。'
        + 'total 订单总额（含运费），due_seller 是 eBay 记录的卖家应收（可能包含 eBay 代收代缴的销售税，实际到手以回款为准）；ship_by 最晚发货时间；sold_via_ad 是否通过推广售出。summary 只统计这一页（已取消的不算销售额和热销商品）。'
        + '买家姓名、用户名、地址、电话、邮箱一律不返回，只给收货国家。',
    };
  });
};

const listingTitles = (shop, token) => cachedResult('api', `${shop.storeId}|titles`, async () => {
  const out = {};
  for (let page = 1; page <= 5; page++) {
    const r = failIf(await tradingCall({ token, call: 'GetMyeBaySelling', body: sellingRequest({ status: 'active', page, pageSize: 200 }) }), '读在售 listing ');
    const l = parseSellingList(r.xml, 'active');
    for (const it of l.items) out[it.item_id] = it.title;
    if (page >= l.pages) break;
  }
  return { titles: out };
});

const traffic = async (a) => {
  const shop = shopFor(a.shop);
  const range = trafficRange(a.days ?? 30);
  const by = a.by ?? 'day';
  const itemIds = a.item_id ? [a.item_id] : [];
  return cachedResult('api', `${shop.storeId}|traffic|${by}|${range.start}|${range.end}|${a.item_id ?? ''}|${a.limit ?? 30}`, () => withUserToken(shop, async (token) => {
    const out = parseTraffic(await restCall({ token, path: trafficPath({ range, by, itemIds }) }), by, range);
    if (by === 'listing') {
      const { titles } = await listingTitles(shop, token);
      out.rows = out.rows.slice(0, a.limit ?? 30).map((r) => ({ item_id: r.item_id, title: titles[r.item_id] ?? null, ...r }));
    }
    return { shop: shop.name, by, ...range, item_id: a.item_id ?? null, ...out,
      note: '自家店铺流量（eBay 美国站，Seller Hub 流量报告同源；日期按美国太平洋时间，到昨天为止）。impressions_total 总曝光（含站内外各种展示）；listing_impressions 商品曝光，'
        + '其中 search_impressions 搜索结果页曝光、store_impressions 店铺页曝光；views 商品页浏览，views_from_search 来自搜索的浏览；transactions 成交笔数。'
        + 'search_ctr = 来自搜索的浏览 ÷ 搜索曝光；conversion = 成交笔数 ÷ 浏览（比例，0~1）；值为 null 表示 eBay 没给（incomplete 里列出缺的项）。'
        + 'totals 只覆盖有数据的 totals_days 天；missing_days 是要的日期里 eBay 还没给的天（通常是最近一两天还没更新）。'
        + '按商品时按商品曝光从高到低，eBay 最多返回 200 条，不给全店合计（全店合计用 by=day）。' };
  }));
};

const sellerStandards = async (a) => {
  const shop = shopFor(a.shop);
  return cachedResult('api', `${shop.storeId}|standards`, () => withUserToken(shop, async (token) => ({
    shop: shop.name,
    programs: parseStandards(await restCall({ token, path: '/sell/analytics/v1/seller_standards_profile' })),
    note: '卖家表现（eBay 卖家等级评估）：level 是 TOP_RATED 优秀 / ABOVE_STANDARD 合格 / BELOW_STANDARD 不合格；metrics 是各项考核指标（交易缺陷率、延迟发货率、未解决纠纷等）的当前值、等级和门槛'
      + '（threshold_lower 下限 / threshold_upper 上限，type、threshold_meta 说明怎么比）。'
      + 'program 里 PROGRAM_US 是美国站，PROGRAM_GLOBAL 是全球。',
  })));
};

// ---- 财务（Finances API，只读）----
const finGet = (token, path) => restCall({ token, path, base: FINANCES_BASE });

const financeSummary = async (a) => {
  const shop = shopFor(a.shop);
  const days = a.days ?? 30;
  return cachedResult('api', `${shop.storeId}|finsum|${days}`, () => withUserToken(shop, async (token) => {
    const funds = parseFunds(await finGet(token, '/sell/finances/v1/seller_funds_summary'));
    const since = sinceIso(days);
    const sums = [];
    for (const st of TX_STATUSES) sums.push(await finGet(token, `/sell/finances/v1/transaction_summary?${new URLSearchParams({ filter: `transactionDate:[${since}..],transactionStatus:{${st}}` })}`));
    const ps = await finGet(token, `/sell/finances/v1/payout_summary?${new URLSearchParams({ filter: `payoutDate:[${since}..]` })}`);
    return {
      shop: shop.name, days, funds, period: mergeTransactionSummaries(sums),
      payouts: { count: ps.payoutCount ?? 0, transactions: ps.transactionCount ?? 0, amount: ps.amount ? { value: Number(ps.amount.value), currency: ps.amount.currency } : null },
      note: 'funds 是现在的资金：total 总额、available 可提现（可能是负数）、processing 处理中、on_hold 冻结。period 是最近 N 天各类交易：count 笔数，credit 入账金额、debit 扣款金额、net = 入账 − 扣款。'
        + 'credits 是入账类（销售为主，也含卖家补偿等其他入账，不完全等于销售额；只看销售用 ebay_transactions type=SALE）、refunds 退款、non_sale_charges 非销售扣费（广告费、店铺订阅等）、'
        + 'shipping_labels 运单、disputes 纠纷、on_hold 冻结中。payouts 是这段时间的回款。费用明细用 ebay_transactions。',
    };
  }));
};

const transactions = async (a) => {
  const shop = shopFor(a.shop);
  const pageSize = a.page_size ?? 50;
  const page = a.page ?? 1;
  return withUserToken(shop, async (token) => {
    const j = await finGet(token, transactionsPath({ days: a.days ?? 30, type: a.type, limit: pageSize, offset: (page - 1) * pageSize }));
    const list = (j.transactions ?? []).map(parseTransaction);
    return { shop: shop.name, days: a.days ?? 30, type: a.type ?? 'all', page, total: j.total ?? list.length, transactions: list, summary: summarizeTransactions(list),
      note: '每笔资金交易（eBay 美国站，时间 UTC）：type 是 SALE 销售 / REFUND 退款 / NON_SALE_CHARGE 非销售扣费（fee_type 说明是什么费，如广告费、店铺订阅）/ SHIPPING_LABEL 运单 / DISPUTE 纠纷 等；'
        + 'booking 是 CREDIT 入账 / DEBIT 扣款；status 是资金状态（PAYOUT 已回款、FUNDS_ON_HOLD 冻结…）。销售的 fees 是这笔订单被扣的各项费用（FINAL_VALUE_FEE 成交费、INTERNATIONAL_FEE 国际费、广告费等）。'
        + 'summary 只统计这一页。不返回买家信息。' };
  });
};

const payouts = async (a) => {
  const shop = shopFor(a.shop);
  const pageSize = a.page_size ?? 50;
  const page = a.page ?? 1;
  return withUserToken(shop, async (token) => {
    const j = await finGet(token, payoutsPath({ days: a.days ?? 90, limit: pageSize, offset: (page - 1) * pageSize }));
    return { shop: shop.name, days: a.days ?? 90, page, total: j.total ?? 0, payouts: (j.payouts ?? []).map(parsePayout),
      note: '回款记录：status 是 SUCCEEDED 已到账 / INITIATED 已发起 / RETRYABLE_FAILED 失败待重试 等；converted 是换汇后的金额和汇率；fee 是回款手续费。不返回银行卡信息。' };
  });
};

// ---- 广告（Marketing API）----
const campaignList = (shop, token, status = 'all') => cachedResult('api', `${shop.storeId}|campaigns|${status}`, async () => {
  const campaigns = [];
  for (let offset = 0; offset < 5000; offset += 200) {
    const j = await restCall({ token, path: campaignsPath(status, offset) });
    campaigns.push(...(j.campaigns ?? []).map(parseCampaign));
    if (campaigns.length >= Number(j.total ?? 0) || !(j.campaigns ?? []).length) break;
  }
  return { campaigns };
});

const adCampaigns = async (a) => {
  const shop = shopFor(a.shop);
  return withUserToken(shop, async (token) => {
    const { campaigns } = await campaignList(shop, token, a.status ?? 'all');
    return { shop: shop.name, status: a.status ?? 'all', campaigns,
      note: '推广活动：funding 是 cps 按成交付费（Promoted Listings Standard，卖出才收广告费）/ cpc 按点击付费（Advanced）；ad_rate_strategy 是 FIXED 固定费率（bid_percentage）/ DYNAMIC 动态费率（dynamic_adjustment 是在 eBay 建议费率上加减的百分比和上限）；'
        + 'daily_budget 是按点击付费的日预算。看效果用 ebay_ad_report，看活动里有哪些商品用 ebay_ad_campaign_ads。' };
  }, { needScopes: READ_SCOPES });
};

const adCampaignAds = async (a) => {
  const shop = shopFor(a.shop);
  return withUserToken(shop, async (token) => {
    const pageSize = a.page_size ?? 200;
    const page = a.page ?? 1;
    const j = await restCall({ token, path: adsPath(a.campaign_id, (page - 1) * pageSize, pageSize) });
    const { titles } = await listingTitles(shop, token);
    const ads = (j.ads ?? []).map(parseAd).map((x) => ({ ...x, title: titles[x.listing_id] ?? null }));
    const total = Number(j.total ?? ads.length);
    return { shop: shop.name, campaign_id: a.campaign_id, page, total, has_more: page * pageSize < total, ads,
      note: '活动里的商品：bid_percentage 是这个商品的广告费率（成交价的百分比，按成交付费活动）；status 是广告状态。title 为空表示这个商品已经不在售。' };
  });
};

const adReport = async (a) => {
  const shop = shopFor(a.shop);
  const kind = a.report ?? 'account';
  const funding = a.funding ?? 'cps';
  const range = reportRange(a.days ?? 30);
  let body;
  try {
    body = reportBody({ kind, funding, range, campaignIds: a.campaign_id ? [a.campaign_id] : [] });
  } catch (err) {
    throw new QueryError(err.message);
  }
  const key = reports.key(shop.storeId, body);
  return withUserToken(shop, async (token) => {
    const rec = await withLock(DATA_DIR, async () => {
      const hit = reports.get(key);
      if (hit) return hit;
      const r = await restCall({ token, method: 'POST', path: '/sell/marketing/v1/ad_report_task', body });
      const taskId = String(r._location ?? '').split('/').pop();
      if (!/^\d+$/.test(taskId)) throw new ApiError('eBay 没有返回报表任务编号，稍后再试');
      const created = { task_id: taskId, created_at: Date.now() };
      reports.set(key, created);
      return created;
    }, { key: 'ad-report-tasks', what: '广告报表任务记录', waitMs: 30_000, owner: `ebay-seller-mcp ${process.pid}` });
    const base = { shop: shop.name, report: kind, label: REPORTS[kind].label, funding, from: range.from.slice(0, 10), to: range.to.slice(0, 10), campaign_id: a.campaign_id ?? null, task_id: rec.task_id };
    for (let i = 0; i < 5; i++) {
      const s = await restCall({ token, path: `/sell/marketing/v1/ad_report_task/${rec.task_id}` });
      if (s.reportTaskStatus === 'FAILED') {
        reports.drop(key);
        throw new ApiError(`eBay 生成报表失败${s.reportTaskStatusMessage ? `：${String(s.reportTaskStatusMessage).slice(0, 200)}` : ''}，可以再调一次重新生成`);
      }
      if (s.reportTaskStatus === 'SUCCESS' && s.reportHref) {
        // 报表下载地址只接受 eBay 自己的，避免把令牌发到别处
        if (!/^https:\/\/api\.ebay\.com\/sell\/marketing\/v1\/ad_report\/\d+$/.test(s.reportHref)) throw new ApiError('eBay 返回的报表地址不对，没有下载');
        const res = await restCall({ token, path: s.reportHref, base: '', raw: true, timeoutMs: 60_000 });
        const buf = Buffer.from(await res.arrayBuffer());
        let parsed;
        try {
          parsed = parseReportTsv(reportText(buf, gunzipSync), body.dimensions.map((d) => d.dimensionKey));
        } catch (err) {
          throw new ApiError(err.message);
        }
        const { columns, rows } = parsed;
        const needTitles = columns.includes('listing_id');
        const titles = needTitles ? (await listingTitles(shop, token)).titles : {};
        const names = columns.includes('campaign_id') ? Object.fromEntries((await campaignList(shop, token)).campaigns.map((c) => [c.campaign_id, c.name])) : {};
        const decorated = rows.map((r) => ({ ...(r.campaign_id ? { campaign_name: names[r.campaign_id] ?? null } : {}), ...(r.listing_id ? { title: titles[r.listing_id] ?? null } : {}), ...r }));
        const limit = a.limit ?? 200;
        return { ...base, status: 'ready', generated: s.reportTaskCompletionDate ?? null, columns, total_rows: rows.length, totals: reportTotals(rows, columns), rows: decorated.slice(0, limit),
          note: '推广效果（eBay 美国站）：impressions 曝光、clicks 点击、ctr 点击率（比例）、sales 广告带来的成交数、sale_amount 成交额、ad_fees 广告费、avg_cost_per_sale 每单广告费；'
            + '按点击付费的列以 cpc_ 开头（cpc_return_on_ad_spend 是 ROAS）。totals 是各行相加（比率列不加）。rows 最多返回 limit 条。' };
      }
      if (i < 4) await sleep(4000);
    }
    return { ...base, status: 'pending', created_at: new Date(rec.created_at).toISOString(),
      note: 'eBay 还在生成这份报表（通常 1~3 分钟）。过一会儿用同样的参数再调一次 ebay_ad_report 就能拿到结果，不会重复生成。' };
  }, { needScopes: MARKETING_SCOPES });
};

// ---- 广告管理（写）：预检 → 用户确认 → 执行 ----
async function loadCampaign(token, campaignId) {
  const c = parseCampaign(await restCall({ token, path: `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}` }));
  if (c.campaign_id !== String(campaignId) || !c.status || !c.funding) throw new ApiError('eBay 返回的活动信息不完整，稍后再试');
  // 全部读完才能做快照对比；读不全、总数不对、有重复都不改
  const ads = c.funding === 'cps' ? await loadAllAds((offset) => restCall({ token, path: adsPath(campaignId, offset) }), parseAd) : [];
  return { c, ads };
}
const forgetCampaigns = (shop) => {
  for (const k of cache.keys()) if (k.startsWith(`api|${shop.storeId}|campaigns`)) cache.delete(k);
};

const adChangePreview = async (a) => {
  const shop = shopFor(a.shop);
  const { shop: _s, campaign_id: campaignId, ...input } = a;
  return withUserToken(shop, async (token) => {
    const { c, ads } = await loadCampaign(token, campaignId);
    const plan = planAdChange(input, c, ads);
    const rec = previews.save({ id: newPreviewId(), kind: 'ad', store_id: shop.storeId, campaign_id: campaignId, created_at: new Date().toISOString(), status: 'ready',
      request: plan.request, target: plan.target, snapshot: campaignSnapshot(c, ads), changes: plan.changes, notes: plan.notes, title: c.name, action: input.action });
    return { shop: shop.name, change_id: rec.id, campaign: { campaign_id: c.campaign_id, name: c.name, status: c.status, funding: c.funding, ad_rate_strategy: c.ad_rate_strategy },
      action: input.action, action_label: AD_ACTIONS[input.action], changes: plan.changes, notes: plan.notes,
      note: '还没有改 eBay 上的广告。把 changes（改前 → 改后）和 notes 给用户核对；用户明确同意后，用 change_id 调 ebay_ad_change_apply（confirm=true）执行。24 小时内有效。' };
  }, { needScopes: MARKETING_SCOPES });
};

const adChangeApply = async (a) => {
  const shop = shopFor(a.shop);
  if (a.confirm !== true) throw new QueryError('confirm 要传 true：执行前必须把 changes（改前 → 改后）给用户看过并得到明确同意');
  previews.load(a.change_id);
  const lockCampaign = (cid, fn) => withLock(DATA_DIR, fn, { key: `campaign:${shop.storeId}:${cid}`, what: '这个广告活动的修改', waitMs: 5000, owner: `ebay-seller-mcp ${process.pid}` }).catch((err) => {
    if (err instanceof LockBusyError) throw new ListingError('这个广告活动正在被另一个任务修改，等它结束后再用同一个 change_id 调 ebay_ad_change_apply，不要重新预检。');
    throw err;
  });
  try {
    const r = await withUserToken(shop, (token) => applyAdChange({
      previews, id: a.change_id, storeId: shop.storeId, lockCampaign,
      load: (cid) => loadCampaign(token, cid),
      send: (req) => restCall({ token, method: req.method, path: req.path, body: req.body ?? undefined }),
    }), { needScopes: MARKETING_SCOPES });
    const campaign = { campaign_id: r.rec.campaign_id, name: r.rec.title };
    if (!r.ok) {
      return { shop: shop.name, ok: false, campaign, partial: r.partial === true, failed: r.failed,
        note: r.partial ? '部分商品没改成功（failed 里是失败的商品和原因），其余已生效：用 ebay_ad_campaign_ads 看现状，失败的按原因调整后重新预检。' : 'eBay 拒绝了这次修改（没有生效）：按 failed 里的原因调整后重新预检。' };
    }
    return { shop: shop.name, ok: true, campaign, action: r.rec.action, changes: r.rec.changes, already_applied: r.already_applied === true,
      note: r.already_applied ? '活动已经是改后的状态了，没有重复执行。' : '已生效。用 ebay_ad_campaigns / ebay_ad_campaign_ads 可以看改后的样子。' };
  } finally {
    forgetCampaigns(shop);
  }
};

// ---- 修改已有 listing：预检（算出改前 → 改后，存成修改记录）→ 用户确认 → ebay_listing_apply ----
const fetchItem = async (token, itemId) => parseItemDetail(failIf(await tradingCall({ token, call: 'GetItem', body: `<ItemID>${itemId}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics>` }), '读 listing ').xml);

const changeOut = (shop, rec, d) => ({
  shop: shop.name, change_id: rec.id, kind: rec.kind, item: { item_id: d.item_id, title: d.title, url: d.url }, changes: rec.changes, notes: rec.notes, steps: rec.steps.length,
  note: '还没有修改 eBay 上的 listing。把 changes（改前 → 改后）和 notes 给用户核对；用户明确同意后，用 change_id 调 ebay_listing_apply（confirm=true）执行。24 小时内有效；要调整就重新预检。',
});

const saveChange = (shop, kind, d, extra) => previews.save({ id: newPreviewId(), kind, store_id: shop.storeId, item_id: d.item_id, created_at: new Date().toISOString(), status: 'ready', ...extra });

const revisePreview = async (a) => {
  const shop = shopFor(a.shop);
  const { shop: _s, item_id: itemId, ...input } = a;
  return withUserToken(shop, async (token) => {
    const d = await fetchItem(token, itemId);
    const plan = planRevise(input, d);
    if (plan.intent.policies) {
      const known = (await loadDefaults(shop)).policies;
      for (const [k, id] of Object.entries(plan.intent.policies)) {
        if (!known[k].some((p) => p.id === id)) throw new ListingError(`${{ fulfillment: '运费', return: '退货', payment: '付款' }[k]}政策 ${id} 不是这家店的（用 ebay_listing_defaults 查）`);
      }
    }
    const pictures = plan.newImages.length ? await uploadImages(token)(plan.newImages) : new Map();
    const snapshot = reviseSnapshot(plan.intent, d, pictures);
    const steps = reviseSteps(buildReviseXml(d.item_id, plan.intent, d, pictures), snapshot);
    const rec = saveChange(shop, 'revise', d, { steps, intent: plan.intent, snapshot, changes: plan.changes, notes: plan.notes, title: d.title });
    return changeOut(shop, rec, d);
  }, { listing: true });
};

const endPreview = async (a) => {
  const shop = shopFor(a.shop);
  return withUserToken(shop, async (token) => {
    const d = await fetchItem(token, a.item_id);
    const plan = planEnd(d, a.reason ?? 'NotAvailable');
    const rec = saveChange(shop, 'end', d, { steps: plan.steps, snapshot: plan.snapshot, changes: plan.changes, notes: plan.notes, title: d.title });
    return changeOut(shop, rec, d);
  }, { listing: true });
};

const relistPreview = async (a) => {
  const shop = shopFor(a.shop);
  return withUserToken(shop, async (token) => {
    const d = await fetchItem(token, a.item_id);
    const plan = planRelist(d, newUuid());
    const summary = { images: d.images.length, category: d.category, policies: Object.fromEntries(Object.entries(d.policies).map(([k, v]) => [k, v?.name ?? null])) };
    const rec = saveChange(shop, 'relist', d, { steps: plan.steps, snapshot: plan.snapshot, changes: [...plan.changes, { field: '沿用原 listing', before: null, after: summary }], notes: plan.notes, title: d.title });
    return changeOut(shop, rec, d);
  }, { listing: true });
};

const listingApply = async (a) => {
  const shop = shopFor(a.shop);
  if (a.confirm !== true) throw new QueryError('confirm 要传 true：执行前必须把 changes（改前 → 改后）给用户看过并得到明确同意');
  previews.load(a.change_id);
  // 按 listing 加锁：同一条 listing 的不同修改也排队，不会读到同一份旧状态后互相覆盖
  const lockItem = (itemId, fn) => withLock(DATA_DIR, fn, { key: `item:${shop.storeId}:${itemId}`, what: '这条 listing 的修改', waitMs: 5000, owner: `ebay-seller-mcp ${process.pid}` }).catch((err) => {
    if (err instanceof LockBusyError) throw new ListingError('这条 listing 正在被另一个任务修改，等它结束后再用同一个 change_id 调 ebay_listing_apply，不要重新预检。');
    throw err;
  });
  const r = await withUserToken(shop, (token) => applyChange({
    previews, id: a.change_id, storeId: shop.storeId, describe, lockItem,
    getItem: (itemId) => fetchItem(token, itemId),
    call: (step) => tradingCall({ token, call: step.call, body: step.body, timeoutMs: 180_000 }),
  }), { listing: true });
  const item = { item_id: r.rec.item_id, title: r.rec.title, url: `https://www.ebay.com/itm/${r.rec.item_id}` };
  if (!r.ok) {
    return { shop: shop.name, ok: false, item, errors: r.errors, warnings: r.warnings,
      note: r.partial
        ? 'eBay 报错了，但这条修改之前已经部分生效或结果不确定：先用 ebay_listing_get 看现在的样子，再决定用同一个 change_id 重试（会先对账），还是重新预检。'
        : 'eBay 拒绝了这次修改（没有生效）：按 errors 调整后重新预检。' };
  }
  const result = r.result ?? {};
  const note = r.already_applied ? '这条修改之前已经执行过了，没有重复执行。'
    : result.new_item_id ? `已重新上架，新 ItemID ${result.new_item_id}。` : result.already_ended ? '这条 listing 已经是结束状态。' : result.ended ? '已下架。' : '已生效。';
  return { shop: shop.name, ok: true, kind: r.rec.kind, item, ...(result.new_item_id ? { new_item_id: result.new_item_id, new_url: `https://www.ebay.com/itm/${result.new_item_id}` } : {}),
    changes: r.rec.changes, warnings: r.warnings ?? [], note };
};

const INSTRUCTIONS = 'eBay 市场调研（通过本机紫鸟店铺浏览器里已登录的 eBay Seller Hub 取数，只读）。'
  + 'Terapeak（已售成交，最多 3 年）：ebay_research（成交均价、成交件数、售罄率、卖家数、成交总额 + 按成交件数排的 listing）、ebay_research_trend（每天 / 周 / 月的成交均价和件数）、'
  + 'ebay_research_categories（各类目成交件数，可往下钻）、ebay_research_active（在售 listing 数、均价、推广占比 + 在售 listing）。'
  + '前台：ebay_search（买家看到的搜索结果：排名、价格、运费、发货地、已售件数）。金额美元，eBay 美国站。'
  + '刊登（eBay 开放平台）：先 ebay_listing_defaults（店里的政策和发货地）、ebay_category_suggest（找类目）、ebay_category_aspects（类目必填属性和能用的商品状态），'
  + '再 ebay_listing_preview（eBay 只校验不刊登，返回 preview_id、费用和摘要），把摘要给用户确认后才能 ebay_listing_publish(preview_id, confirm=true) 正式刊登。'
  + '自家店铺数据（只读）：ebay_orders（订单）、ebay_traffic（流量：曝光、浏览、点击率、转化）、ebay_seller_standards（卖家等级）；'
  + '财务：ebay_finance_summary（资金和收支合计）、ebay_transactions（每笔交易和费用）、ebay_payouts（回款）；广告：ebay_ad_campaigns、ebay_ad_campaign_ads、ebay_ad_report（效果报表，异步），'
  + '改广告用 ebay_ad_change_preview → 用户确认 → ebay_ad_change_apply。'
  + '已有 listing：ebay_listings / ebay_listing_get 查；改内容、改价改库存、增删规格用 ebay_listing_revise_preview，下架用 ebay_listing_end_preview，重新上架用 ebay_listing_relist_preview，'
  + '都只生成「改前 → 改后」的修改记录，用户确认后才能 ebay_listing_apply(change_id, confirm=true) 执行。';

// ---- 工具定义 ----
const shopArg = { type: 'string', description: '店铺名或紫鸟店铺 ID；不填 = 默认店（见 ebay_shops）' };
const keywordArg = { type: 'string', description: '关键词（英文，和买家搜索一样），如 "model trees"' };
const daysArg = { type: 'integer', enum: DAY_RANGES, default: 90, description: '统计最近多少天：7 / 30 / 90 / 180 / 365 / 730 / 1095（3 年）' };
const categoryArg = { type: 'string', description: 'eBay 类目 ID（用 ebay_research_categories 查）' };
const pageArg = { type: 'integer', minimum: 1, maximum: 20, default: 1 };
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const LOCAL_RO = { ...RO, openWorldHint: false };
const obj = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const LISTING_RO = { ...RO, idempotentHint: true };
const imageArg = { type: 'string', description: '图片文件的完整路径（绝对路径，JPG / PNG / WEBP 等，≤12MB，最长边建议 ≥1600 像素）或 https 网址' };

const TOOLS = [
  { name: 'ebay_shops', description: '列出已配置的 eBay 店铺（名称、紫鸟店铺 ID、哪家是默认店）。', annotations: LOCAL_RO, inputSchema: obj({}), run: shops },
  {
    name: 'ebay_research',
    description: 'Terapeak 已售调研：关键词在 eBay 美国站最近 N 天的成交均价（和上期比）、价格区间、平均运费、包邮占比、成交件数、成交总额、售罄率、卖家数，'
      + '以及按成交件数排的 listing（每条的成交件数、成交均价、运费、成交总额、最近成交日期）。可按类目筛选。',
    annotations: RO,
    inputSchema: obj({ shop: shopArg, keyword: keywordArg, days: daysArg, category_id: categoryArg, page: pageArg, page_size: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }, ['keyword']),
    run: research,
  },
  {
    name: 'ebay_research_trend',
    description: 'Terapeak 已售走势：关键词每天 / 每周 / 每月的成交均价和成交件数，看季节性和价格变化。',
    annotations: RO,
    inputSchema: obj({ shop: shopArg, keyword: keywordArg, days: daysArg, category_id: categoryArg, interval: { type: 'string', enum: Object.keys(INTERVALS), default: 'day', description: 'day 按天 / week 按周 / month 按月' } }, ['keyword']),
    run: researchTrend,
  },
  {
    name: 'ebay_research_categories',
    description: 'Terapeak 类目分布：关键词的成交落在哪些类目（各子类目成交件数），传 category_id 往下钻；得到的类目 ID 可用于其他工具筛选。',
    annotations: RO,
    inputSchema: obj({ shop: shopArg, keyword: keywordArg, days: daysArg, category_id: { ...categoryArg, description: '从哪个类目往下看（不填 = 根类目）' } }, ['keyword']),
    run: researchCategories,
  },
  {
    name: 'ebay_research_active',
    description: 'Terapeak 在售竞争：关键词当前在售 listing 数、平均售价、平均运费、包邮占比、付费推广占比、价格区间，以及在售 listing（价格、运费、关注人数、是否推广、上架日期）。',
    annotations: RO,
    inputSchema: obj({ shop: shopArg, keyword: keywordArg, page: pageArg, limit: { type: 'integer', minimum: 1, maximum: 50, default: 50 } }, ['keyword']),
    run: researchActive,
  },
  {
    name: 'ebay_search',
    description: 'eBay 前台搜索（买家看到的结果）：每条的排名位置、标题、新旧、价格（含区间和划线原价）、一口价 / 拍卖 / 可议价、运费、发货地、已售件数。可按排序、新旧、只看一口价、价格区间、类目筛选。',
    annotations: RO,
    inputSchema: obj({
      shop: shopArg, keyword: keywordArg,
      sort: { type: 'string', enum: Object.keys(SORTS), default: 'best_match', description: 'best_match 最佳匹配 / price_low 价格+运费从低到高 / price_high 从高到低 / newly_listed 最新上架 / ending_soon 即将结束' },
      condition: { type: 'string', enum: Object.keys(CONDITIONS), description: 'new 全新 / used 二手；不填 = 全部' },
      buy_it_now: { type: 'boolean', description: 'true = 只看一口价' },
      price_min: { type: 'number', description: '最低价（美元）' },
      price_max: { type: 'number', description: '最高价（美元）' },
      category_id: categoryArg,
      page: { type: 'integer', minimum: 1, maximum: 3, default: 1, description: '第几页（每页 60 条，最多 3 页）' },
      limit: { type: 'integer', minimum: 1, maximum: 60, default: 60 },
    }, ['keyword']),
    run: search,
  },
  {
    name: 'ebay_orders',
    description: '自家店铺订单（eBay 官方接口）：最近 N 天的订单，每单的订单号、下单时间、发货 / 付款 / 取消状态、总额、运费、卖家应收、收货国家、最晚发货时间、商品（ItemID、标题、SKU、规格、数量、金额、是否推广售出）；'
      + '可只看未发货 / 已发货，翻页；附这一页的状态统计、销售额和卖得最多的商品。不返回买家个人信息。',
    annotations: LISTING_RO,
    inputSchema: obj({
      shop: shopArg,
      days: { type: 'integer', enum: [7, 14, 30, 60, 90], default: 30, description: '最近多少天下的单' },
      status: { type: 'string', enum: Object.keys(ORDER_STATUS), default: 'all', description: 'all 全部 / unshipped 没发完（含部分发货）/ shipped 发了货（含部分发货）' },
      page: { type: 'integer', minimum: 1, maximum: 100, default: 1 },
      page_size: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    }),
    run: orders,
  },
  {
    name: 'ebay_traffic',
    description: '自家店铺流量（eBay 官方流量报告，和 Seller Hub 流量页同源）：按天或按商品的总曝光、商品曝光（搜索结果页 / 店铺页）、浏览、来自搜索的浏览、成交笔数，以及搜索点击率、转化率；可只看某个 ItemID。数据到昨天。',
    annotations: LISTING_RO,
    inputSchema: obj({
      shop: shopArg,
      days: { type: 'integer', enum: TRAFFIC_DAYS, default: 30, description: '最近多少天（美国太平洋时间，到昨天）' },
      by: { type: 'string', enum: ['day', 'listing'], default: 'day', description: 'day 按天 / listing 按商品（按曝光从高到低）' },
      item_id: { type: 'string', description: '只看这个 ItemID' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 30, description: '按商品时最多返回多少条' },
    }),
    run: traffic,
  },
  {
    name: 'ebay_seller_standards',
    description: '卖家表现：eBay 卖家等级（优秀 / 合格 / 不合格）和各项考核指标（交易缺陷率、延迟发货率、未解决纠纷等）的当前值和门槛。',
    annotations: LISTING_RO,
    inputSchema: obj({ shop: shopArg }),
    run: sellerStandards,
  },
  {
    name: 'ebay_finance_summary',
    description: '财务概况（eBay 官方财务接口）：现在的资金（总额、可提现、处理中、冻结），最近 N 天的销售入账、退款、非销售扣费（广告费、店铺订阅等）、运单、纠纷合计，以及这段时间的回款笔数和金额。',
    annotations: LISTING_RO,
    inputSchema: obj({ shop: shopArg, days: { type: 'integer', enum: FIN_DAYS, default: 30, description: '最近多少天' } }),
    run: financeSummary,
  },
  {
    name: 'ebay_transactions',
    description: '资金交易明细：每笔销售 / 退款 / 扣费 / 运单 / 纠纷的时间、金额、入账或扣款、资金状态、关联订单，销售的各项费用拆分（成交费、国际费、广告费…），非销售扣费的费用类型；可按类型筛选、翻页；附这一页按类型和费用类型的合计。不返回买家信息。',
    annotations: LISTING_RO,
    inputSchema: obj({
      shop: shopArg,
      days: { type: 'integer', enum: FIN_DAYS, default: 30 },
      type: { type: 'string', enum: TX_TYPES, description: '只看某类：SALE 销售 / REFUND 退款 / NON_SALE_CHARGE 非销售扣费 / SHIPPING_LABEL 运单 / DISPUTE 纠纷 / TRANSFER / ADJUSTMENT …；不填 = 全部' },
      page: { type: 'integer', minimum: 1, maximum: 100, default: 1 },
      page_size: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    }),
    run: transactions,
  },
  {
    name: 'ebay_payouts',
    description: '回款记录：每笔回款的时间、状态（已到账 / 已发起 / 失败）、金额、换汇后金额和汇率、包含的交易数、手续费。不返回银行卡信息。',
    annotations: LISTING_RO,
    inputSchema: obj({ shop: shopArg, days: { type: 'integer', enum: FIN_DAYS, default: 90 }, page: { type: 'integer', minimum: 1, maximum: 100, default: 1 }, page_size: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }),
    run: payouts,
  },
  {
    name: 'ebay_ad_campaigns',
    description: '推广活动列表：每个活动的 ID、名称、状态（进行中 / 暂停 / 已结束）、付费方式（按成交 / 按点击）、费率策略（固定费率多少 / 动态费率加减多少）、日预算、开始结束时间。',
    annotations: LISTING_RO,
    inputSchema: obj({ shop: shopArg, status: { type: 'string', enum: Object.keys(CAMPAIGN_STATUS), default: 'all', description: 'all 全部 / running 进行中 / paused 暂停 / ended 已结束 / scheduled 未开始' } }),
    run: adCampaigns,
  },
  {
    name: 'ebay_ad_campaign_ads',
    description: '某个推广活动里的商品：每个商品的 ItemID、标题、广告费率、广告状态。',
    annotations: LISTING_RO,
    inputSchema: obj({
      shop: shopArg, campaign_id: { type: 'string', description: '活动 ID（ebay_ad_campaigns 查）' },
      page: { type: 'integer', minimum: 1, maximum: 500, default: 1 }, page_size: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
    }, ['campaign_id']),
    run: adCampaignAds,
  },
  {
    name: 'ebay_ad_report',
    description: '推广效果报表（eBay 官方广告报表）：曝光、点击、点击率、广告带来的成交数和成交额、广告费、每单广告费（按点击付费还有 ROAS、转化率、单次点击费）。'
      + 'report：account 全账户按天 / campaign 按活动按天 / listing 按商品 / transaction 广告带来的每笔成交 / keyword 按关键词、search_query 按买家搜索词（这两个只有按点击付费）。'
      + 'eBay 生成报表要 1~3 分钟：第一次调用可能返回 status=pending，过一会儿用同样参数再调就能拿到结果。',
    annotations: LISTING_RO,
    inputSchema: obj({
      shop: shopArg,
      report: { type: 'string', enum: Object.keys(REPORTS), default: 'account' },
      funding: { type: 'string', enum: ['cps', 'cpc'], default: 'cps', description: 'cps 按成交付费 / cpc 按点击付费' },
      days: { type: 'integer', enum: AD_DAYS, default: 30, description: '最近多少个整天（到昨天）' },
      campaign_id: { type: 'string', description: '只看某个活动' },
      limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200, description: '最多返回多少行' },
    }),
    run: adReport,
  },
  {
    name: 'ebay_ad_change_preview',
    description: '广告修改预检（不会改 eBay 上的东西）：读当前活动，算出「改前 → 改后」，返回 change_id。action：pause 暂停 / resume 恢复 / end 结束活动；'
      + 'update_ad_rate 改费率策略（strategy=FIXED + bid_percentage，或 DYNAMIC + adjustment / cap）；update_bids 改商品费率、add_listings 加商品、remove_listings 移出商品（listings，按成交付费活动）；update_budget 改日预算（按点击付费）。',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: obj({
      shop: shopArg,
      campaign_id: { type: 'string', description: '活动 ID（ebay_ad_campaigns 查）' },
      action: { type: 'string', enum: Object.keys(AD_ACTIONS), description: Object.entries(AD_ACTIONS).map(([k, v]) => `${k} ${v}`).join(' / ') },
      strategy: { type: 'string', enum: ['FIXED', 'DYNAMIC'], description: 'update_ad_rate：FIXED 固定费率 / DYNAMIC 动态费率' },
      bid_percentage: { type: 'number', description: 'update_ad_rate + FIXED：固定费率（2~100%）' },
      adjustment: { type: 'number', description: 'update_ad_rate + DYNAMIC：在 eBay 建议费率上加减的百分点（如 2 = 建议费率 +2 个百分点）' },
      cap: { type: 'number', description: 'update_ad_rate + DYNAMIC：动态费率上限（%）' },
      listings: { type: 'array', description: 'update_bids / add_listings：[{ "listing_id": "ItemID", "bid_percentage": 6 }]；remove_listings：["ItemID", …]（最多 500 个）' },
      daily_budget: { type: 'number', description: 'update_budget：新的日预算（美元）' },
    }, ['campaign_id', 'action']),
    run: adChangePreview,
  },
  {
    name: 'ebay_ad_change_apply',
    description: '执行广告修改（会改 eBay 上的广告）：只能执行 ebay_ad_change_preview 生成的修改记录（按 change_id）。必须先把 changes 给用户看、用户明确同意后才能调用，confirm 传 true。'
      + '执行前会重新读活动，预检后被改过就拒绝；同一个 change_id 不会重复执行。',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: obj({ shop: shopArg, change_id: { type: 'string', description: 'ebay_ad_change_preview 返回的 change_id' }, confirm: { type: 'boolean', description: '用户已经看过改动并明确同意时传 true' } }, ['change_id', 'confirm']),
    run: adChangeApply,
  },
  {
    name: 'ebay_listings',
    description: '自家店铺的 listing 列表：在售（active）或已结束未售出（unsold，可重新上架）。每条的 ItemID、标题、SKU、价格（多规格的价格区间）、可售数量、已售件数、关注人数、规格数。',
    annotations: LISTING_RO,
    inputSchema: obj({
      shop: shopArg,
      status: { type: 'string', enum: ['active', 'unsold'], default: 'active', description: 'active 在售 / unsold 已结束未售出' },
      page: { type: 'integer', minimum: 1, maximum: 100, default: 1 },
      page_size: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    }),
    run: listings,
  },
  {
    name: 'ebay_listing_get',
    description: '一条 listing 的详情：标题、类目、状态、价格和可售数量（多规格逐个规格）、已售件数、图片、商品属性、规格配图、运费 / 退货 / 付款政策、发货地、描述。改 listing 前先看。',
    annotations: LISTING_RO,
    inputSchema: obj({
      shop: shopArg,
      item_id: { type: 'string', description: 'eBay ItemID（ebay_listings 查）' },
      include_description: { type: 'boolean', description: 'true = 返回完整描述（默认只给前 1500 个字符）' },
    }, ['item_id']),
    run: listingGet,
  },
  {
    name: 'ebay_listing_defaults',
    description: '刊登前先看：这家店的运费 / 退货 / 付款政策（ID、名称、运费方式），以及最近在售商品常用的发货地和政策组合（预检不传 policies / location 时用它）、最近用过的类目。',
    annotations: LISTING_RO,
    inputSchema: obj({ shop: shopArg }),
    run: listingDefaults,
  },
  {
    name: 'ebay_category_suggest',
    description: '按商品关键词（英文）找 eBay 美国站的刊登类目（叶子类目 ID 和完整路径）。',
    annotations: LISTING_RO,
    inputSchema: obj({ query: { type: 'string', minLength: 1, description: '商品关键词（英文），如 "miniature camouflage net diorama"' } }, ['query']),
    run: categorySuggest,
  },
  {
    name: 'ebay_category_aspects',
    description: '某个类目的刊登要求：商品属性（必填 / 建议 / 可选，可选值，能否当多规格的规格名）、能用的商品状态（condition_id）、能不能做多规格。',
    annotations: LISTING_RO,
    inputSchema: obj({ category_id: { type: 'string', description: '叶子类目 ID（ebay_category_suggest 查）' } }, ['category_id']),
    run: categoryAspects,
  },
  {
    name: 'ebay_listing_preview',
    description: '刊登预检（不会刊登）：把图片上传到 eBay 图片服务，再让 eBay 按真实刊登规则校验（必填属性、类目、价格、政策等），返回错误 / 警告、刊登费用和要发布的内容摘要。'
      + '校验通过才给 preview_id（24 小时有效）。一口价、GTC 长期在售、美元、eBay 美国站。单规格传 price + quantity；多规格传 variations。',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: obj({
      shop: shopArg,
      title: { type: 'string', description: '英文标题，最多 80 个字符；放买家会搜的词' },
      category_id: { type: 'string', description: '叶子类目 ID（ebay_category_suggest 查）' },
      condition_id: { type: 'integer', default: 1000, description: '商品状态：全新 = 1000（用 ebay_category_aspects 查这个类目能用哪些）' },
      condition_description: { type: 'string', description: '状态补充说明（非全新时用）' },
      description: { type: 'string', description: '商品描述（英文）：HTML，或纯文本（空行分段）' },
      images: { type: 'array', items: imageArg, description: '商品图 1~24 张，第一张是主图' },
      aspects: { type: 'object', description: '商品属性（Item specifics），如 {"Brand": "Unbranded", "Material": "Polyester", "Color": ["Green", "Brown"]}；类目必填的都要填' },
      price: { type: 'number', description: '单规格：一口价（美元，两位小数）' },
      quantity: { type: 'integer', description: '单规格：可售数量' },
      sku: { type: 'string', description: '单规格：商家编码（可选）' },
      best_offer: { type: 'boolean', description: '单规格：是否接受议价，默认 false' },
      variations: {
        type: 'object',
        description: '多规格：{ "specifics": ["Size", "Color"], "picture_by": "Color", "items": [{ "sku": "NET-S-GRN", "price": 3.99, "quantity": 50, "values": {"Size": "10x15cm", "Color": "MC Camo"}, "image": "/path/MC.jpg" }] }。'
          + 'specifics 是规格名（最多 5 个，不要和 aspects 重名）；items 每个规格的价格、数量、规格值（每个规格名都要有值，组合不能重复）；picture_by 按哪个规格配图（每个值都要有 image）。',
      },
      policies: { type: 'object', description: '{ fulfillment_policy_id, return_policy_id, payment_policy_id }；不传用 ebay_listing_defaults 的默认组合' },
      location: { type: 'object', description: '发货地 { country: "CN", location: "Shenzhen, Guangdong", postal_code }；不传用店里已有商品的' },
    }, ['title', 'category_id', 'description', 'images']),
    run: listingPreview,
  },
  {
    name: 'ebay_listing_publish',
    description: '正式刊登（会在 eBay 上架、可能产生刊登费）：只能发布 ebay_listing_preview 校验通过的内容（按 preview_id，内容不能再改）。'
      + '必须先把预检摘要和费用给用户看、用户明确同意后才能调用，confirm 传 true。同一个 preview_id 重复调用不会重复刊登。',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: obj({
      shop: shopArg,
      preview_id: { type: 'string', description: 'ebay_listing_preview 返回的 preview_id' },
      confirm: { type: 'boolean', description: '用户已经看过预检摘要并明确同意刊登时传 true' },
    }, ['preview_id', 'confirm']),
    run: listingPublish,
  },
  {
    name: 'ebay_listing_revise_preview',
    description: '修改在售 listing 的预检（不会改 eBay 上的东西）：对比当前 listing 算出「改前 → 改后」，存成修改记录，返回 change_id。只传要改的项：'
      + '标题、描述、图片（完整新列表，整组替换）、商品属性（完整新属性，整组替换）、商品状态、类目、政策、发货地、议价、单规格的价格 / 可售数量，多规格用 variations 按 SKU 改价改量、新增或删除规格。'
      + '已有销量的 listing，eBay 不允许改标题、类目、发货地。',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: obj({
      shop: shopArg,
      item_id: { type: 'string', description: '要改的 ItemID' },
      title: { type: 'string', description: '新标题（≤80 个字符）' },
      description: { type: 'string', description: '新描述（HTML 或纯文本，整段替换）' },
      images: { type: 'array', items: { type: 'string' }, description: '改后的完整图片列表（第一张是主图）：原来的 eBay 图片地址保留不动，新图传本地绝对路径或 https 网址' },
      aspects: { type: 'object', description: '改后的完整商品属性（整组替换，没写的属性会被删掉）：先用 ebay_listing_get 拿到现在的属性再改' },
      condition_id: { type: 'integer', description: '新的商品状态 ID' },
      condition_description: { type: 'string', description: '商品状态说明' },
      category_id: { type: 'string', description: '新的叶子类目 ID（没有销量时才能改）' },
      policies: { type: 'object', description: '要换的政策：{ fulfillment_policy_id?, return_policy_id?, payment_policy_id? }（ebay_listing_defaults 查）' },
      location: { type: 'object', description: '新发货地（整组）：{ country, location, postal_code }（没有销量时才能改）' },
      best_offer: { type: 'boolean', description: '单规格：是否接受议价' },
      price: { type: 'number', description: '单规格：新价格（美元）' },
      quantity: { type: 'integer', description: '单规格：新的可售数量（不含已卖出的）' },
      variations: {
        type: 'object',
        description: '多规格：{ "update": [{ "sku": "A-1", "price": 12.99, "quantity": 30 }], "add": [{ "sku": "A-9", "price": 12.99, "quantity": 20, "values": {"Size": "XL", "Color": "Red"}, "image": "/path/red.jpg" }], "remove": ["A-3"] }。'
          + 'update 按 SKU 改价格 / 可售数量；add 新增规格（values 要包含所有规格名）；remove 删除规格（按 SKU）。',
      },
    }, ['item_id']),
    run: revisePreview,
  },
  {
    name: 'ebay_listing_end_preview',
    description: '下架（结束在售 listing）的预检：不会改 eBay 上的东西，返回 change_id 和要下架的 listing 信息。下架后只能用重新上架恢复，会变成新 ItemID。',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: obj({
      shop: shopArg,
      item_id: { type: 'string', description: '要下架的 ItemID' },
      reason: { type: 'string', enum: Object.keys(END_REASONS), default: 'NotAvailable', description: Object.entries(END_REASONS).map(([k, v]) => `${k} ${v}`).join(' / ') },
    }, ['item_id']),
    run: endPreview,
  },
  {
    name: 'ebay_listing_relist_preview',
    description: '重新上架的预检：对已结束的 listing（ebay_listings status=unsold 查，90 天内）按原样重新刊登。不会改 eBay 上的东西，返回 change_id；执行后是新的 ItemID，可能产生刊登费。',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: obj({ shop: shopArg, item_id: { type: 'string', description: '已结束 listing 的 ItemID' } }, ['item_id']),
    run: relistPreview,
  },
  {
    name: 'ebay_listing_apply',
    description: '执行修改 / 下架 / 重新上架（会改 eBay 上的 listing）：只能执行 ebay_listing_revise_preview / end_preview / relist_preview 生成的修改记录（按 change_id，内容不能再改）。'
      + '必须先把 changes（改前 → 改后）给用户看、用户明确同意后才能调用，confirm 传 true。执行前会重新读 listing，预检后被改过就拒绝；同一个 change_id 重复调用不会重复执行。',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: obj({
      shop: shopArg,
      change_id: { type: 'string', description: '预检返回的 change_id' },
      confirm: { type: 'boolean', description: '用户已经看过改动并明确同意时传 true' },
    }, ['change_id', 'confirm']),
    run: listingApply,
  },
];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** 按 inputSchema 做参数检查：未知参数、必填、类型、枚举、范围 */
function checkArgs(tool, args) {
  const { properties, required = [] } = tool.inputSchema;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new QueryError('arguments 必须是对象。');
  for (const key of Object.keys(args)) if (!Object.hasOwn(properties, key)) throw new QueryError(`未知参数：${key}`);
  for (const key of required) if (args[key] === undefined || args[key] === '') throw new QueryError(`缺少参数：${key}`);
  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (spec.type === 'integer' && !Number.isInteger(value)) throw new QueryError(`${key} 必须是整数。`);
    if (spec.type === 'number' && !(typeof value === 'number' && Number.isFinite(value))) throw new QueryError(`${key} 必须是数字。`);
    if (spec.type === 'string' && typeof value !== 'string') throw new QueryError(`${key} 必须是字符串。`);
    if (spec.type === 'boolean' && typeof value !== 'boolean') throw new QueryError(`${key} 必须是 true / false。`);
    if (spec.type === 'array' && !Array.isArray(value)) throw new QueryError(`${key} 必须是数组。`);
    if (spec.type === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value))) throw new QueryError(`${key} 必须是对象。`);
    if (spec.enum && !spec.enum.includes(value)) throw new QueryError(`${key} 只能是：${spec.enum.join('、')}`);
    if (spec.minimum !== undefined && value < spec.minimum) throw new QueryError(`${key} 不能小于 ${spec.minimum}。`);
    if (spec.maximum !== undefined && value > spec.maximum) throw new QueryError(`${key} 不能大于 ${spec.maximum}。`);
  }
}

async function callTool(name, args) {
  const tool = BY_NAME.get(name);
  if (!tool) return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true };
  try {
    const input = args ?? {};
    checkArgs(tool, input);
    precheck(input);
    return { content: [{ type: 'text', text: JSON.stringify(await tool.run(input)) }] };
  } catch (error) {
    if (!isUserError(error)) process.stderr.write(`[ebay-seller-mcp] ${error?.stack ?? error}\n`);
    return { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true };
  }
}

const listed = TOOLS.map(({ run, ...tool }) => tool);

async function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'ebay-seller-mcp', version: VERSION },
        instructions: INSTRUCTIONS,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listed };
    case 'tools/call':
      return callTool(params?.name, params?.arguments);
    default:
      if (id === undefined) return undefined; // 通知（如 notifications/initialized）不回复
      throw Object.assign(new Error(`不支持的方法：${method}`), { code: -32601 });
  }
}

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(`ebay-seller-mcp ${VERSION}
eBay 卖家 MCP（stdio）：通过本机紫鸟店铺浏览器里已登录的 eBay Seller Hub 做 Terapeak 商品调研和前台搜索；通过 eBay 开放平台刊登（预检 → 确认后发布）。

命令：
  ebay-seller-mcp                          启动 MCP 服务（stdio）
  ebay-seller-mcp auth --store-id <ID>     授权店铺（刊登用）：在这家店的紫鸟店铺浏览器里打开 eBay 授权页，点同意后保存授权
  ebay-seller-mcp auth --shop <店铺名>      同上，按 EBAY_SHOPS 里的店铺名

环境变量：
  EBAY_SHOPS     店铺数组 JSON，如 [{"name":"美国站","store_id":"12345678901234","default":true}]
  EBAY_STORE_ID  只有一家店时可以只设紫鸟店铺 ID
  EBAY_DATA_DIR  浏览器锁 / 冷却文件 / 预检记录目录（默认 ~/.ebay-seller-mcp）
  EBAY_API_KEYS  eBay 开发者密钥和店铺授权文件（默认 ~/.config/ebay-seller-mcp/api-keys.json）
  ZINIAO_CLI     ziniao-cli 命令路径（默认自动查找）
`);
  process.exit(0);
}

if (process.argv[2] === 'auth') {
  const argOf = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const run = async () => {
    const storeIdArg = argOf('--store-id');
    let storeId;
    if (storeIdArg !== undefined) {
      if (!/^\d{5,24}$/.test(storeIdArg)) throw new QueryError('--store-id 应是紫鸟店铺 ID（ziniao-cli store list 里的 storeId）');
      storeId = storeIdArg;
    } else {
      storeId = shopFor(argOf('--shop')).storeId;
    }
    const r = await authorizeStore({ storeId, file: KEYS_FILE, log: (m) => process.stderr.write(`${m}\n`) });
    process.stdout.write(`授权成功：eBay 账号 ${r.ebay_user_id ?? '（未知）'}，有效期到 ${r.expires_at.slice(0, 10)}。授权保存在 ${KEYS_FILE}\n`);
  };
  run().then(() => process.exit(0), (err) => {
    process.stderr.write(`授权失败：${err?.message ?? err}\n`);
    process.exit(1);
  });
} else {
  createInterface({ input: process.stdin }).on('line', async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'JSON 解析失败' } });
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      send({ id: null, error: { code: -32600, message: '请求必须是 JSON 对象' } });
      return;
    }
    try {
      const result = await handle(message);
      if (message.id !== undefined && result !== undefined) send({ id: message.id, result });
    } catch (error) {
      if (message.id !== undefined) send({ id: message.id, error: { code: error.code ?? -32603, message: String(error.message ?? error) } });
    }
  }).on('close', () => process.exit(0));
}
