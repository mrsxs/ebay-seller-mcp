#!/usr/bin/env node
// eBay 卖家 MCP（stdio）：Terapeak 商品调研（已售成交、走势、类目、在售竞争）、eBay 前台搜索，和刊登（预检 → 确认后发布）。
// 调研和搜索通过本机紫鸟店铺浏览器里已登录的 eBay Seller Hub 页面取数（只读）；刊登走 eBay 开放平台（开发者密钥 + 店铺授权）。
// 协议：每行一条 JSON-RPC 2.0 消息；stdout 只写协议消息，诊断写 stderr。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { authorizeStore } from '../lib/auth-flow.mjs';
import { LockBusyError, withBrowserLock, withLock } from '../lib/browser-lock.mjs';
import { createBrowserSession, EBAY_SITE, navigateAndWait, PageBlockedError, SEARCH_SITE } from '../lib/browser.mjs';
import { CooldownError, createCooldown, isVerifyMessage } from '../lib/cooldown.mjs';
import { ApiError, describe, parseFees, restCall, TokenRejectedError, tradingCall, uploadImage } from '../lib/ebay-api.mjs';
import { createTerapeakApi, EbayError } from '../lib/ebay.mjs';
import {
  activeItemIds, allImages, applyDefaults, buildItemXml, createImageUploader, createPreviewStore, ListingError, listingSummary, newPreviewId,
  newUuid, normalizeListing, parseItemDefaults, pickDefaults, publishPreview,
} from '../lib/listing.mjs';
import { applyChange, buildReviseXml, END_REASONS, planEnd, planRelist, planRevise, reviseSnapshot, reviseSteps } from '../lib/changes.mjs';
import { parseItemDetail, parseSellingList, sellingRequest } from '../lib/manage.mjs';
import { AuthError, createTokenProvider, defaultKeysFile, LISTING_SCOPES } from '../lib/oauth.mjs';
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
const AUTH_HINT = (storeId) => `npx -y ebay-seller-mcp@latest auth --store-id ${storeId}`;

/** 用这家店的用户令牌调接口；令牌被拒（401 / 授权错误）时换一次新令牌再试（被拒的请求不会生效） */
async function withUserToken(shop, fn, { listing = false } = {}) {
  const get = () => tokens.userToken(shop.storeId, listing ? { needScopes: LISTING_SCOPES } : {});
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
