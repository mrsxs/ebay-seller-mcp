#!/usr/bin/env node
// eBay 卖家 MCP（stdio）：Terapeak 商品调研（已售成交、走势、类目、在售竞争）和 eBay 前台搜索。
// 全部通过本机紫鸟店铺浏览器里已登录的 eBay Seller Hub 页面取数（不走开放平台、不需要 App Key），只读。
// 协议：每行一条 JSON-RPC 2.0 消息；stdout 只写协议消息，诊断写 stderr。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { withBrowserLock } from '../lib/browser-lock.mjs';
import { createBrowserSession, EBAY_SITE, navigateAndWait, PageBlockedError, SEARCH_SITE } from '../lib/browser.mjs';
import { CooldownError, createCooldown, isVerifyMessage } from '../lib/cooldown.mjs';
import { createTerapeakApi, EbayError } from '../lib/ebay.mjs';
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
const CACHE_TTL = { research: 30 * 60_000, search: 10 * 60_000 };
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
  || err instanceof ShopConfigError;
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

const INSTRUCTIONS = 'eBay 市场调研（通过本机紫鸟店铺浏览器里已登录的 eBay Seller Hub 取数，只读）。'
  + 'Terapeak（已售成交，最多 3 年）：ebay_research（成交均价、成交件数、售罄率、卖家数、成交总额 + 按成交件数排的 listing）、ebay_research_trend（每天 / 周 / 月的成交均价和件数）、'
  + 'ebay_research_categories（各类目成交件数，可往下钻）、ebay_research_active（在售 listing 数、均价、推广占比 + 在售 listing）。'
  + '前台：ebay_search（买家看到的搜索结果：排名、价格、运费、发货地、已售件数）。金额美元，eBay 美国站。';

// ---- 工具定义 ----
const shopArg = { type: 'string', description: '店铺名或紫鸟店铺 ID；不填 = 默认店（见 ebay_shops）' };
const keywordArg = { type: 'string', description: '关键词（英文，和买家搜索一样），如 "model trees"' };
const daysArg = { type: 'integer', enum: DAY_RANGES, default: 90, description: '统计最近多少天：7 / 30 / 90 / 180 / 365 / 730 / 1095（3 年）' };
const categoryArg = { type: 'string', description: 'eBay 类目 ID（用 ebay_research_categories 查）' };
const pageArg = { type: 'integer', minimum: 1, maximum: 20, default: 1 };
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const LOCAL_RO = { ...RO, openWorldHint: false };
const obj = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });

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
eBay 卖家 MCP（stdio）：通过本机紫鸟店铺浏览器里已登录的 eBay Seller Hub 做 Terapeak 商品调研和前台搜索。

环境变量：
  EBAY_SHOPS     店铺数组 JSON，如 [{"name":"美国站","store_id":"12345678901234","default":true}]
  EBAY_STORE_ID  只有一家店时可以只设紫鸟店铺 ID
  EBAY_DATA_DIR  浏览器锁 / 冷却文件目录（默认 ~/.ebay-seller-mcp）
  ZINIAO_CLI     ziniao-cli 命令路径（默认自动查找）
`);
  process.exit(0);
}

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
