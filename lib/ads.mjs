// 广告（eBay Sell Marketing API）：推广活动、活动里的商品、效果报表。
// 效果报表是异步的：先建报表任务，eBay 生成要 1~几分钟，生成好了再下载（TSV，gzip）。
// 同样的条件 24 小时内复用同一个报表任务（记在数据目录 ad-reports.json），不重复建。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fsutil.mjs';

export const AD_DAYS = [7, 14, 30, 60, 90];
export const CAMPAIGN_STATUS = { all: null, running: 'RUNNING', paused: 'PAUSED', ended: 'ENDED', scheduled: 'SCHEDULED' };
export const FUNDING = { cps: 'COST_PER_SALE', cpc: 'COST_PER_CLICK' };

const CPS_METRICS = ['impressions', 'clicks', 'ctr', 'sales', 'sale_amount', 'ad_fees', 'avg_cost_per_sale'];
const CPC_METRICS = ['cpc_impressions', 'cpc_clicks', 'cpc_ctr', 'cpc_attributed_sales', 'cpc_sale_amount_listingsite_currency', 'cpc_ad_fees_listingsite_currency',
  'cpc_return_on_ad_spend', 'cpc_conversion_rate', 'cost_per_click'];
/** 报表种类 → eBay 报表类型和必须的维度（eBay 规定的最少维度） */
export const REPORTS = {
  account: { type: 'ACCOUNT_PERFORMANCE_REPORT', dims: ['day'], label: '全账户按天' },
  // 按点击付费的活动和商品报表，eBay 还要求 ad_group_id 维度（实测）
  campaign: { type: 'CAMPAIGN_PERFORMANCE_SUMMARY_REPORT', dims: ['day', 'campaign_id'], cpcDims: ['day', 'campaign_id', 'ad_group_id'], label: '按活动按天' },
  listing: { type: 'LISTING_PERFORMANCE_REPORT', dims: ['listing_id', 'campaign_id'], cpcDims: ['listing_id', 'campaign_id', 'ad_group_id'], label: '按商品' },
  transaction: { type: 'TRANSACTION_REPORT', dims: ['transaction_id', 'listing_id', 'day', 'campaign_id'], label: '广告带来的每笔成交',
    metrics: { cps: ['sales', 'ad_fees', 'sale_amount'], cpc: ['cpc_attributed_sales', 'cpc_sale_amount_listingsite_currency'] } },
  keyword: { type: 'KEYWORD_PERFORMANCE_REPORT', dims: ['keyword_match_type', 'seller_keyword_id', 'ad_group_id', 'campaign_id'], cpcOnly: true, label: '按关键词（按点击付费）' },
  search_query: { type: 'SEARCH_QUERY_PERFORMANCE_REPORT', dims: ['ad_group_id', 'search_query', 'campaign_id'], cpcOnly: true, label: '按买家搜索词（按点击付费）' },
};

const num = (v) => {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n) ? null : n;
};
const money = (m) => (m && m.value !== undefined ? { value: num(m.value), currency: m.currency ?? null } : null);

// ---- 活动 ----
export function campaignsPath(status = 'all', offset = 0) {
  const q = new URLSearchParams({ limit: '200', offset: String(offset) });
  if (CAMPAIGN_STATUS[status]) q.set('campaign_status', CAMPAIGN_STATUS[status]);
  return `/sell/marketing/v1/ad_campaign?${q}`;
}

export function parseCampaign(c) {
  const f = c.fundingStrategy ?? {};
  return {
    campaign_id: c.campaignId ?? null,
    name: c.campaignName ?? null,
    status: c.campaignStatus ?? null,
    funding: f.fundingModel === 'COST_PER_CLICK' ? 'cpc' : f.fundingModel === 'COST_PER_SALE' ? 'cps' : f.fundingModel ?? null,
    ad_rate_strategy: f.adRateStrategy ?? null,
    bid_percentage: num(f.bidPercentage),
    dynamic_adjustment: (f.dynamicAdRatePreferences ?? []).map((p) => ({ adjustment: num(p.adRateAdjustmentPercent), cap: num(p.adRateCapPercent) }))[0] ?? null,
    daily_budget: money(c.budget?.daily?.amount),
    targeting: c.campaignTargetingType ?? null,
    // 按点击付费的出价设置原样留着（快照对比用）
    bidding: f.fundingModel === 'COST_PER_CLICK' ? JSON.stringify([f.biddingStrategy ?? null, f.bidPreferences ?? null]) : null,
    start: c.startDate ?? null,
    end: c.endDate ?? null,
  };
}

export const adsPath = (campaignId, offset = 0, limit = 500) => `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad?limit=${limit}&offset=${offset}`;
export const parseAd = (a) => ({ ad_id: a.adId ?? null, listing_id: a.listingId ?? null, bid_percentage: num(a.bidPercentage), status: a.adStatus ?? null });

// ---- 报表 ----
/** 报表日期：最近 N 个整天（UTC），从 N 天前 00:00 到昨天 23:59:59（eBay 按时间戳截取） */
export function reportRange(days, now = Date.now()) {
  if (!AD_DAYS.includes(days)) throw new Error(`days 只能是 ${AD_DAYS.join(' / ')}`);
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  return { from: `${day(now - days * 86400_000)}T00:00:00.000Z`, to: `${day(now - 86400_000)}T23:59:59.000Z` };
}

export function reportBody({ kind, funding = 'cps', range, campaignIds = [] }) {
  const r = REPORTS[kind];
  if (!r) throw new Error(`report 只能是：${Object.keys(REPORTS).join('、')}`);
  if (r.cpcOnly && funding !== 'cpc') throw new Error(`${r.label}只有按点击付费（cpc）的活动才有`);
  const metrics = r.metrics?.[funding] ?? (funding === 'cpc' ? CPC_METRICS : CPS_METRICS);
  const dims = (funding === 'cpc' && r.cpcDims) || r.dims;
  const body = { reportType: r.type, dateFrom: range.from, dateTo: range.to, marketplaceId: 'EBAY_US', reportFormat: 'TSV_GZIP', fundingModels: [FUNDING[funding]],
    dimensions: dims.map((d) => ({ dimensionKey: d })), metricKeys: metrics };
  if (campaignIds.length) body.campaignIds = campaignIds;
  return body;
}

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
/** 报表单元格：「USD 17.01」→ 金额；「Oct 16, 2026」→ 2026-10-16；7.0E-4 → 数字 */
export function cellValue(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = s.match(/^([A-Z]{3}) (-?[\d,.]+)$/);
  if (m) return { value: Number(m[2].replace(/,/g, '')), currency: m[1] };
  m = s.match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/);
  if (m && MONTHS[m[1]]) return `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, '0')}`;
  if (/^-?\d+(\.\d+)?(E-?\d+)?$/i.test(s) && !/^0\d/.test(s)) return Number(s);
  return s;
}

/** 下载的报表文件 → 文本：有 gzip 文件头就必须解压成功（坏的压缩包不能当成空报表） */
export function reportText(buf, gunzip) {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return gunzip(buf).toString('utf8');
    } catch {
      throw new Error('报表文件下载不完整（解压失败），请稍后用同样参数再调一次');
    }
  }
  return buf.toString('utf8');
}

/** TSV 报表 → 行（列名用 eBay 的）。expectDims：请求的维度，表头里必须都有，否则说明文件不对 */
export function parseReportTsv(text, expectDims = []) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) throw new Error('报表文件是空的，请稍后用同样参数再调一次');
  const columns = lines[0].split('\t').map((c) => c.trim());
  const missing = expectDims.filter((d) => !columns.includes(d));
  if (missing.length) throw new Error(`报表文件格式不对（缺少 ${missing.join('、')} 列），请稍后用同样参数再调一次`);
  const idCols = new Set(['campaign_id', 'listing_id', 'transaction_id', 'ad_group_id', 'seller_keyword_id', 'search_query', 'keyword_match_type']);
  const rows = lines.slice(1).map((l) => {
    const cells = l.split('\t');
    return Object.fromEntries(columns.map((c, i) => [c, idCols.has(c) ? (cells[i]?.trim() || null) : cellValue(cells[i])]));
  });
  return { columns, rows };
}

/** 报表合计：数字和金额列相加（比率列不加） */
export function reportTotals(rows, columns) {
  const out = {};
  for (const c of columns) {
    if (/ctr|rate|avg_|return_on|cost_per_click/.test(c)) continue;
    const vals = rows.map((r) => r[c]).filter((v) => v !== null && v !== undefined);
    if (!vals.length) continue;
    if (vals.every((v) => typeof v === 'number')) out[c] = Math.round(vals.reduce((a, b) => a + b, 0) * 100) / 100;
    else if (vals.every((v) => typeof v === 'object' && typeof v.value === 'number')) {
      const cur = vals[0].currency;
      if (vals.every((v) => v.currency === cur)) out[c] = { value: Math.round(vals.reduce((a, b) => a + b.value, 0) * 100) / 100, currency: cur };
    }
  }
  return out;
}

/** 报表任务记录：同样的条件 24 小时内复用 */
export function createReportStore({ dir, now = () => Date.now() }) {
  const file = join(dir, 'ad-reports.json');
  const load = () => {
    try {
      const d = JSON.parse(readFileSync(file, 'utf8'));
      return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    } catch {
      return {};
    }
  };
  return {
    key: (storeId, body) => createHash('sha256').update(JSON.stringify([storeId, body])).digest('hex').slice(0, 24),
    get(key) {
      const r = load()[key];
      return r && now() - r.created_at < 24 * 3600_000 ? r : null;
    },
    set(key, rec) {
      const d = load();
      for (const [k, v] of Object.entries(d)) if (!(now() - v.created_at < 24 * 3600_000)) delete d[k];
      d[key] = rec;
      try {
        writeFileAtomic(file, JSON.stringify(d));
      } catch {
        // 写不了只是下次会重新建任务
      }
    },
    drop(key) {
      const d = load();
      delete d[key];
      try {
        writeFileAtomic(file, JSON.stringify(d));
      } catch {
        // 同上
      }
    },
  };
}
