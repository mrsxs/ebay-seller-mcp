// 自家店铺数据（eBay 开放平台，只读）：订单（Sell Fulfillment）、流量报告和卖家表现（Sell Analytics）。
// 订单接口返回里有买家用户名、姓名、地址、电话、邮箱：这里一律不输出，只保留收货国家。
export const TRAFFIC_DAYS = [7, 14, 30, 60, 90];
// eBay getOrders 只支持这两种组合：NOT_STARTED|IN_PROGRESS（没发完）、FULFILLED|IN_PROGRESS（发了货，含部分发货）
export const ORDER_STATUS = { all: null, unshipped: 'NOT_STARTED|IN_PROGRESS', shipped: 'FULFILLED|IN_PROGRESS' };

const TZ = 'America/Los_Angeles';
const laDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ms)); // YYYY-MM-DD
const num = (v) => {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n) ? null : n;
};
const money = (m) => (m ? { value: num(m.value), currency: m.currency ?? null } : null);
const ratio = (a, b) => (b > 0 ? Math.round((a / b) * 10000) / 10000 : null);

// ---- 流量 ----
const METRICS = [
  ['TOTAL_IMPRESSION_TOTAL', 'impressions_total'],
  ['LISTING_IMPRESSION_TOTAL', 'listing_impressions'],
  ['LISTING_IMPRESSION_SEARCH_RESULTS_PAGE', 'search_impressions'],
  ['LISTING_IMPRESSION_STORE', 'store_impressions'],
  ['LISTING_VIEWS_TOTAL', 'views'],
  ['LISTING_VIEWS_SOURCE_SEARCH_RESULTS_PAGE', 'views_from_search'],
  ['TRANSACTION', 'transactions'],
];

/** 日历上的加减天数（按日期算，不按 24 小时算，夏令时切换那天也对） */
const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** 流量报告的日期范围：美国太平洋时间，到昨天为止（eBay 不收未来日期，当天数据也不全） */
export function trafficRange(days, now = Date.now()) {
  if (!TRAFFIC_DAYS.includes(days)) throw new Error(`days 只能是 ${TRAFFIC_DAYS.join(' / ')}`);
  const today = laDate(now);
  return { start: addDays(today, -days), end: addDays(today, -1), days };
}

/** DAY 维度的值：常见 YYYYMMDD，文档里也有 "Wed Jun 01 00:00:00 GMT-07:00 2016" 这种，统一成太平洋时间的 YYYY-MM-DD */
export function dayValue(v) {
  const s = String(v ?? '');
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s.replace(/GMT([+-]\d{2}):?(\d{2})/, 'GMT$1$2'));
  return Number.isFinite(t) ? laDate(t) : s || null;
}

export function trafficPath({ range, by = 'day', itemIds = [] }) {
  const compact = (d) => d.replace(/-/g, '');
  let filter = `marketplace_ids:{EBAY_US},date_range:[${compact(range.start)}..${compact(range.end)}]`;
  if (itemIds.length) filter += `,listing_ids:{${itemIds.join('|')}}`;
  const q = new URLSearchParams({ dimension: by === 'listing' ? 'LISTING' : 'DAY', metric: METRICS.map(([k]) => k).join(','), filter });
  if (by === 'listing') q.set('sort', '-LISTING_IMPRESSION_TOTAL');
  return `/sell/analytics/v1/traffic_report?${q}`;
}

/** 按表头的指标顺序取值（eBay 返回的顺序和请求的顺序不一样）；点击率、转化率自己用原始次数算。
 * 某个值 eBay 标了不适用（applicable:false）就是 null，合计和比率都不把它当 0。按商品时 eBay 最多返回 200 条，不给全店合计（看 by=day）。 */
export function parseTraffic(json, by = 'day', range = null) {
  const keys = (json.header?.metrics ?? []).map((m) => m.key);
  const name = Object.fromEntries(METRICS);
  const rows = (json.records ?? []).map((r) => {
    const row = {};
    const dim = r.dimensionValues?.[0]?.value ?? null;
    if (by === 'listing') row.item_id = dim;
    else row.date = dayValue(dim);
    keys.forEach((k, i) => {
      if (name[k]) row[name[k]] = r.metricValues?.[i]?.applicable === false ? null : num(r.metricValues?.[i]?.value);
    });
    return row;
  });
  if (by !== 'listing') rows.sort((x, y) => String(x.date).localeCompare(String(y.date)));
  const rate = (a, b) => (a === null || a === undefined || b === null || b === undefined ? null : ratio(a, b));
  const rates = (r) => ({ ...r, search_ctr: rate(r.views_from_search, r.search_impressions), conversion: rate(r.transactions, r.views) });
  if (by === 'listing') return { rows: rows.map(rates), totals: null, listings_in_report: rows.length, last_updated: json.lastUpdatedDate ?? null };
  // 合计：有任何一天缺这个值，合计就是 null，并在 incomplete 里列出来
  const incomplete = METRICS.map(([, k]) => k).filter((k) => rows.some((r) => r[k] === null || r[k] === undefined));
  const totals = Object.fromEntries(METRICS.map(([, k]) => [k, incomplete.includes(k) ? null : rows.reduce((sum, r) => sum + r[k], 0)]));
  // eBay 可能只给到 lastUpdatedDate 为止：列出要的日期里缺了哪几天，合计只覆盖有数据的那些天
  const have = new Set(rows.map((r) => r.date));
  const missing = [];
  if (range) for (let d = range.start; d <= range.end; d = addDays(d, 1)) if (!have.has(d)) missing.push(d);
  return { rows: rows.map(rates), totals: rates(totals), totals_days: rows.length, missing_days: missing, incomplete, last_updated: json.lastUpdatedDate ?? null };
}

// ---- 订单 ----
export function ordersPath({ days = 30, status = 'all', limit = 50, offset = 0, now = Date.now() }) {
  const from = new Date(now - days * 24 * 3600_000).toISOString();
  const parts = [`creationdate:[${from}..]`];
  if (ORDER_STATUS[status]) parts.push(`orderfulfillmentstatus:{${ORDER_STATUS[status]}}`);
  return `/sell/fulfillment/v1/order?${new URLSearchParams({ filter: parts.join(','), limit: String(limit), offset: String(offset) })}`;
}

/** 一个订单：只留经营需要的字段，买家信息只留收货国家 */
export function parseOrder(o) {
  const ship = o.fulfillmentStartInstructions?.[0]?.shippingStep ?? {};
  const lines = (o.lineItems ?? []).map((l) => ({
    item_id: l.legacyItemId ?? null,
    title: l.title ?? '',
    sku: l.sku ?? null,
    variation: (l.variationAspects ?? []).map((a) => `${a.name}: ${a.value}`).join(' / ') || null,
    quantity: num(l.quantity),
    total: money(l.total),
    status: l.lineItemFulfillmentStatus ?? null,
    ship_by: l.lineItemFulfillmentInstructions?.shipByDate ?? null,
    sold_via_ad: l.properties?.soldViaAdCampaign === true,
  }));
  return {
    order_id: o.orderId ?? null,
    created: o.creationDate ?? null,
    fulfillment_status: o.orderFulfillmentStatus ?? null,
    payment_status: o.orderPaymentStatus ?? null,
    cancel_state: o.cancelStatus?.cancelState ?? null,
    total: money(o.pricingSummary?.total),
    subtotal: money(o.pricingSummary?.priceSubtotal),
    shipping: money(o.pricingSummary?.deliveryCost),
    due_seller: money(o.paymentSummary?.totalDueSeller),
    refunds: (o.paymentSummary?.refunds ?? []).length,
    ship_to_country: ship.shipTo?.contactAddress?.countryCode ?? null,
    shipping_service: ship.shippingServiceCode ?? null,
    ship_by: lines.map((l) => l.ship_by).filter(Boolean).sort()[0] ?? null,
    items: lines.map(({ ship_by: _s, ...l }) => l),
  };
}

export function summarizeOrders(orders) {
  const byStatus = {};
  const sales = {};
  const skus = new Map();
  for (const o of orders) {
    byStatus[o.fulfillment_status ?? 'UNKNOWN'] = (byStatus[o.fulfillment_status ?? 'UNKNOWN'] ?? 0) + 1;
    // 已取消的订单只计入状态统计，不算销售额和热销商品
    if (o.cancel_state === 'CANCELED') continue;
    if (o.total?.value !== null && o.total?.value !== undefined) {
      sales[o.total.currency ?? '?'] = Math.round(((sales[o.total.currency ?? '?'] ?? 0) + o.total.value) * 100) / 100;
    }
    for (const l of o.items) {
      const k = l.sku || l.item_id || l.title;
      const cur = skus.get(k) ?? { sku: l.sku, item_id: l.item_id, title: l.title, quantity: 0, orders: 0 };
      cur.quantity += l.quantity ?? 0;
      cur.orders += 1;
      skus.set(k, cur);
    }
  }
  return { orders: orders.length, cancelled: orders.filter((o) => o.cancel_state === 'CANCELED').length, by_status: byStatus, sales_by_currency: sales,
    top_items: [...skus.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 10) };
}

// ---- 卖家表现 ----
export function parseStandards(json) {
  return (json.standardsProfiles ?? []).map((p) => ({
    program: p.program ?? null,
    level: p.standardsLevel ?? null,
    default: p.defaultProgram === true,
    cycle: p.cycle?.cycleType ?? null,
    evaluated: p.cycle?.evaluationDate ?? null,
    // 门槛原样保留：有的指标是「不低于」下限，有的是「不超过」上限，type / meta 说明怎么比
    metrics: (p.metrics ?? []).map((m) => ({
      key: m.metricKey ?? null, name: m.name ?? null, value: m.value ?? null, level: m.level ?? null, type: m.type ?? null,
      threshold_lower: m.thresholdLowerBound ?? null, threshold_upper: m.thresholdUpperBound ?? null, threshold_meta: m.thresholdMetaData ?? null,
    })),
  }));
}

/** 订单接口报错：eBay 的原文可能带订单 / 买家信息，只留 HTTP 状态和错误码 */
export function orderErrorMessage(err) {
  if (!err?.status) return null;
  return `eBay 订单接口出错（HTTP ${err.status}${err.codes?.length ? `，错误码 ${err.codes.join(', ')}` : ''}），稍后再试；一直出错请到 Seller Hub 的 Orders 页面查看`;
}
