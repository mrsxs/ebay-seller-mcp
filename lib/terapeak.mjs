// Terapeak 商品调研（eBay Seller Hub → Research）：按关键词看已售（成交）汇总和成交 listing、每日走势、类目分布，以及在售竞争。
// 数据是 eBay 美国站（EBAY-US）；日期按美国太平洋时间（Terapeak 页面就是这么算的）；金额美元。
import { CATEGORY_TREE_SOLD, SOLD_CHARTS, UNIFIED_SEARCH } from './terapeak-queries.mjs';

export const DAY_RANGES = [7, 30, 90, 180, 365, 730, 1095];
const TZ = 'America/Los_Angeles';
const DAY_MS = 86_400_000;

// ---- 日期（美国太平洋时间） ----

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const laParts = (ms) => Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
/** 这个时刻在洛杉矶的 UTC 偏移（分钟，夏令时 -420 / 冬令时 -480） */
function offsetMinutes(ms) {
  const p = laParts(ms);
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000) / 60_000);
}
/** 这个时刻在洛杉矶是哪一天 YYYY-MM-DD */
export function laDate(ms) {
  const p = laParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}
/** 洛杉矶某天某个钟点 → UTC 毫秒（处理夏令时切换） */
export function laTime(date, h, m, s) {
  const [y, mo, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, m, s);
  let t = guess - offsetMinutes(guess) * 60_000;
  const again = guess - offsetMinutes(t) * 60_000;
  if (again !== t) t = again;
  return t;
}
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** 和 Terapeak 页面一样：截止到洛杉矶今天 23:59:59，往前 days 天的 0 点开始 */
export function researchRange(days, now = Date.now()) {
  if (!DAY_RANGES.includes(days)) throw new RangeError(`days 只能是：${DAY_RANGES.join('、')}`);
  const end = laDate(now);
  const start = addDays(end, -days);
  return { days, start, end, startDateTime: new Date(laTime(start, 0, 0, 0)).toISOString(), endDateTime: new Date(laTime(end, 23, 59, 59)).toISOString() };
}

// ---- 请求参数 ----

const soldInput = (keyword, range, categoryId) => ({
  title: keyword,
  marketplaceId: 'EBAY-US',
  dateTimeRange: { startDateTime: range.startDateTime, endDateTime: range.endDateTime },
  checkoutStatus: ['COMPLETED'],
  refundStatus: ['NO_REFUND'],
  wackoTransaction: false,
  ...(categoryId ? { categoryIds: [String(categoryId)] } : {}),
});

/** 已售：汇总 + 成交 listing（一次请求） */
export function soldSearchRequest({ keyword, range, categoryId, offset = 0, limit = 50 }) {
  return {
    query: UNIFIED_SEARCH,
    variables: {
      terapeakResearchInput: soldInput(keyword, range, categoryId),
      terapeakListingInput: { pagination: { limit, offset } },
      activeResearchInput: { title: keyword, ...(categoryId ? { categoryIds: [String(categoryId)] } : {}) },
      activeSearchInput: { limit: 20 },
      includeSoldAggregates: true,
      includeActiveListingCount: false,
      includeActiveAggregates: false,
      includeSoldSearchResults: true,
      includeActiveSearchResults: false,
      includeActiveSearch: false,
    },
    extra: { queryName: 'UnifiedSearch', moduleContext: ['aggregates', 'searchResults', 'resultsHeader'] },
  };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/** 在售：汇总 + 在售 listing（一次请求；page 从 1 开始，每页 50） */
export function activeSearchRequest({ keyword, page = 1, now = Date.now() }) {
  return {
    query: UNIFIED_SEARCH,
    variables: {
      terapeakResearchInput: { title: keyword, marketplaceId: 'EBAY-US', dateTimeRange: { startTime: now - DAY_MS, endTime: now } },
      terapeakListingInput: { pagination: { limit: 50, offset: 0 } },
      activeResearchInput: { title: keyword, marketplaceId: 'EBAY_US' },
      activeSearchInput: {
        pagination: { maxPageSize: 50, pageCursor: b64(`limit=50,page=${page - 1}`) },
        keyword: { itemSearchScope: 'ITEM_TITLE_SEARCH', keyword },
        filter: { siteId: [0] },
      },
      includeSoldAggregates: false,
      includeActiveListingCount: false,
      includeActiveAggregates: true,
      includeSoldSearchResults: false,
      includeActiveSearchResults: true,
      includeActiveSearch: true,
    },
    extra: { queryName: 'UnifiedSearch', moduleContext: ['aggregates', 'searchResults', 'resultsHeader'] },
  };
}

// 接口只支持按天 / 按周分组（按月返回 DOWNSTREAM_SERVICE_ERROR），按月用按天的数据在本地汇总
export const INTERVALS = { day: 'DAY', week: 'WEEK', month: 'DAY' };

/** 已售走势：按天 / 周的成交均价和成交件数（按月见 monthly()） */
export function trendRequest({ keyword, range, categoryId, interval = 'day' }) {
  return {
    query: SOLD_CHARTS,
    variables: {
      input: { ...soldInput(keyword, range, categoryId), groupBy: { intervalUnit: INTERVALS[interval], intervalValue: 1, timezoneId: TZ } },
    },
    extra: {},
  };
}

/** 已售类目分布：某个类目（默认根类目）下各子类目的成交件数 */
export function categoryRequest({ keyword, range, categoryId = '0' }) {
  return {
    query: CATEGORY_TREE_SOLD,
    variables: {
      categoryInput: { categoryId: String(categoryId) },
      filter: {
        keyword, marketplaceId: 'EBAY-US', dateRange: { startDateTime: range.startDateTime, endDateTime: range.endDateTime },
        checkoutStatus: ['COMPLETED'], refundStatus: ['NO_REFUND'], wackoTransaction: false,
      },
      isFullTree: true,
    },
    extra: { marketplaceId: 'EBAY-US' },
  };
}

// ---- 解析 ----

const num = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const round = (v, d = 2) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);
const money = (m) => round(num(m?.amount ?? m?.value));
/** 接口给的是百分数（"33.24" = 33.24%），转成比例 */
const pct = (v) => (num(v) === null ? null : round(num(v) / 100, 4));
const FORMATS = { FIXED_PRICE: '一口价', AUCTION: '拍卖', AUCTION_WITH_BIN: '拍卖（可一口价）' };
/** ISO 时间 → 洛杉矶日期；无效时间返回 null */
const laDay = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? laDate(Date.parse(v)) : null);
const itemUrl = (id) => (/^\d{6,20}$/.test(String(id ?? '')) ? `https://www.ebay.com/itm/${id}` : null);

export function parseSoldSummary(data) {
  const s = data?.terapeakResearch?.summary;
  if (!s) return null;
  const sold = num(s.soldListingsCount);
  const unsold = num(s.unsoldListingsCount);
  return {
    avg_sold_price: money(s.soldPrice?.avgPrice),
    avg_sold_price_change: pct(s.soldPrice?.percentage),
    prior_avg_sold_price: money(s.soldPrice?.priorAvgPrice),
    min_sold_price: money(s.priceRange?.minPrice),
    max_sold_price: money(s.priceRange?.maxPrice),
    avg_shipping: money(s.avgShipping),
    free_shipping_share: pct(s.freeShippingPercent),
    items_sold: num(s.itemSoldCount),
    total_sales: money(s.totalRevenue),
    sold_listings: sold,
    unsold_listings: unsold,
    sell_through: sold !== null && unsold !== null && sold + unsold > 0 ? round(sold / (sold + unsold), 4) : null,
    sellers: num(s.sellerCount),
    ...(s.dataQuality?.resultsTruncated ? { truncated_at: num(s.dataQuality.resultsTruncated.truncationLimit) } : {}),
  };
}

export function parseSoldListing(l) {
  const id = l?.listing?.id ?? null;
  return {
    listing_id: id === null ? null : String(id),
    title: l?.listing?.title ?? null,
    url: itemUrl(id),
    format: FORMATS[l?.buyingFormat] ?? l?.buyingFormat ?? null,
    bids: num(l?.bidCount),
    items_sold: num(l?.itemSoldCount),
    avg_sold_price: money(l?.avgSoldPrice),
    avg_shipping: money(l?.avgShipping),
    total_sales: money(l?.totalSales),
    free_shipping_share: pct(l?.freeShippingPercent),
    last_sold: laDay(l?.lastSoldDateTime),
  };
}

export function parseSoldSearch(data) {
  const m = data?.soldSearchResults?.listingMetrics;
  return {
    summary: parseSoldSummary(data),
    listings: (Array.isArray(m?.listings) ? m.listings : []).map(parseSoldListing),
    next_page: m?.nextPageAvailable === true,
  };
}

export function parseActiveListing(l) {
  const d = l?.searchIndexData ?? {};
  const id = l?.listingId ?? null;
  return {
    listing_id: id === null ? null : String(id),
    title: d.title ?? null,
    url: itemUrl(id),
    price: money(d.currentPrice),
    shipping: money(d.fullCalculatedShipping?.shipCost),
    format: FORMATS[d.listingFormat] ?? d.listingFormat ?? null,
    bids: num(d.bidderCount),
    watchers: num(d.watchCount),
    promoted: d.isPromotedListing === true,
    listed_at: laDay(d.startTime),
  };
}

export function parseActiveSearch(data) {
  const s = data?.activeTabAggregates?.summary;
  const r = data?.activeSearchResults;
  const range = r?.searchListingsMetrics?.itemsPriceRange;
  return {
    summary: s ? {
      listings: num(s.listingCount),
      avg_price: money(s.averageListingPrice),
      avg_shipping: money(s.averageShippingPrice),
      free_shipping_share: pct(s.freeShippingPercentage),
      promoted_share: pct(s.promotedListingsPercentage),
      min_price: money(range?.minPrice?.converted),
      max_price: money(range?.maxPrice?.converted),
    } : null,
    listings: (Array.isArray(r?.listings) ? r.listings : []).map(parseActiveListing),
    next_page: Boolean(r?.paginationOutput?.nextCursor),
  };
}

/** raw=true 时成交均价不舍入（给 monthly 加权用，最后再舍入） */
export function parseTrend(data, { raw = false } = {}) {
  const rows = data?.terapeakResearch?.salesTrends?.performanceMetrics;
  return (Array.isArray(rows) ? rows : []).map((p) => ({
    date: laDay(p?.soldDateTime),
    avg_sold_price: raw ? num(p?.avgPrice?.amount) : money(p?.avgPrice),
    items_sold: num(p?.itemSoldCount),
  }));
}

/** 按天的点汇总成按月：件数相加，成交均价按件数加权（= 当月成交额 ÷ 当月件数） */
export function monthly(points) {
  const months = new Map();
  for (const p of points) {
    if (!p.date) continue;
    const key = `${p.date.slice(0, 7)}-01`;
    const m = months.get(key) ?? { date: key, sales: 0, items_sold: 0, priced: 0 };
    const n = p.items_sold ?? 0;
    m.items_sold += n;
    if (p.avg_sold_price !== null && n > 0) {
      m.sales += p.avg_sold_price * n;
      m.priced += n;
    }
    months.set(key, m);
  }
  return [...months.values()].map((m) => ({ date: m.date, avg_sold_price: m.priced ? Math.round((m.sales / m.priced) * 100) / 100 : null, items_sold: m.items_sold }));
}

const cat = (c) => ({ id: String(c?.categoryId ?? ''), name: c?.name ?? null, leaf: c?.leafCategory === true, items_sold: num(c?.terapeakSoldCount) });

/** 类目：当前类目、祖先路径、按成交件数排的子类目（只留有成交的） */
export function parseCategoryTree(data) {
  const c = data?.category?.category;
  if (!c) return null;
  const ancestors = (Array.isArray(c.ancestors) ? c.ancestors : []).filter((a) => String(a?.categoryId) !== '0').map(cat);
  return {
    category: cat(c),
    path: [...ancestors.map((a) => a.name), c.categoryId === '0' ? null : c.name].filter(Boolean).join(' > ') || null,
    children: (Array.isArray(c.children) ? c.children : []).map(cat).filter((x) => (x.items_sold ?? 0) > 0).sort((a, b) => b.items_sold - a.items_sold),
  };
}
