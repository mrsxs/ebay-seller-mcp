// 广告管理（Marketing API，写操作）：暂停 / 恢复 / 结束活动、改费率策略、改单个商品费率、加 / 移商品、改日预算。
// 和改 listing 一样两步走：ebay_ad_change_preview 读当前活动算出「改前 → 改后」存成修改记录（kind=ad），
// ebay_ad_change_apply 在用户确认后执行：按活动加锁，重新读活动和活动里的商品，和预检时的快照比，变了就拒绝；
// 结果不确定后再执行先对账（目标状态已经达到就不再发）。
import { ListingError } from './listing.mjs';

/** 发出去后结果还不确定的状态（再执行时先对账）；partial（批量里部分失败）不自动重发，要重新预检剩下的 */
const RECOVER = new Set(['sending', 'unknown']);

export const AD_ACTIONS = {
  pause: '暂停活动', resume: '恢复活动', end: '结束活动（不能恢复）', update_ad_rate: '改活动的费率策略', update_bids: '改商品的广告费率',
  add_listings: '往活动里加商品', remove_listings: '把商品移出活动', update_budget: '改日预算（按点击付费）',
};
const BASE = '/sell/marketing/v1/ad_campaign';
const pct = (v, what) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 2 || n > 100) throw new ListingError(`${what} 应是 2~100 之间的百分比（eBay 按成交付费的广告费率范围）`);
  return Math.round(n * 10) / 10;
};
const listingId = (v, what) => {
  if (!/^\d{9,15}$/.test(String(v ?? ''))) throw new ListingError(`${what} 应是 eBay ItemID（9~15 位数字）`);
  return String(v);
};

/** 活动快照：状态、费率策略、预算、活动里每个商品的费率（对比用，不含广告费等变化快的数据） */
export function campaignSnapshot(c, ads) {
  return {
    status: c.status,
    strategy: JSON.stringify([c.ad_rate_strategy, c.bid_percentage, c.dynamic_adjustment]),
    budget: JSON.stringify(c.daily_budget),
    bidding: c.bidding ?? null,
    dates: JSON.stringify([c.start, c.end]),
    bids: Object.fromEntries((ads ?? []).map((a) => [a.listing_id, a.bid_percentage])),
  };
}

/**
 * 校验参数，生成请求和「改前 → 改后」。c：parseCampaign 的结果；ads：活动里的商品（parseAd）
 * 返回 { request: { method, path, body }, changes, notes, target }，target 用于执行后 / 对账时判断是否已生效
 */
export function planAdChange(a, c, ads) {
  const action = a.action;
  if (!AD_ACTIONS[action]) throw new ListingError(`action 只能是：${Object.keys(AD_ACTIONS).join('、')}`);
  const path = `${BASE}/${encodeURIComponent(c.campaign_id)}`;
  const inCampaign = new Map((ads ?? []).map((x) => [x.listing_id, x]));
  const notes = [];
  if (c.status === 'ENDED') throw new ListingError('这个活动已经结束了，不能再改');

  if (action === 'pause' || action === 'resume' || action === 'end') {
    const target = { pause: 'PAUSED', resume: 'RUNNING', end: 'ENDED' }[action];
    // 按点击付费活动的广告组、关键词、出价这里核对不到：恢复（重新开始花钱）只在 Seller Hub 里做
    if (action === 'resume' && c.funding === 'cpc') throw new ListingError('按点击付费的活动请在 Seller Hub 里恢复（这里核对不到它的广告组、关键词和出价）');
    if (action === 'pause' && c.status !== 'RUNNING') throw new ListingError(`活动现在是 ${c.status}，只有进行中的活动能暂停`);
    if (action === 'resume' && c.status !== 'PAUSED') throw new ListingError(`活动现在是 ${c.status}，只有暂停的活动能恢复`);
    if (action === 'end') notes.push('结束后不能恢复；活动里的商品不再推广，已经产生的广告费照常结算。');
    return { request: { method: 'POST', path: `${path}/${action}`, body: null }, changes: [{ field: '活动状态', before: c.status, after: target }], notes, target: { status: target } };
  }

  if (action === 'update_ad_rate') {
    if (c.funding !== 'cps') throw new ListingError('只有按成交付费的活动有费率策略');
    const strategy = String(a.strategy ?? '').toUpperCase();
    let body;
    let after;
    if (strategy === 'FIXED') {
      const bid = pct(a.bid_percentage, 'bid_percentage');
      body = { adRateStrategy: 'FIXED', bidPercentage: String(bid) };
      after = `固定费率 ${bid}%`;
    } else if (strategy === 'DYNAMIC') {
      const adj = Number(a.adjustment ?? 0);
      if (!Number.isFinite(adj) || adj < -100 || adj > 100) throw new ListingError('adjustment 是在 eBay 建议费率上加减的百分点（-100~100）');
      const cap = a.cap === undefined ? null : pct(a.cap, 'cap');
      body = { adRateStrategy: 'DYNAMIC', dynamicAdRatePreferences: [{ adRateAdjustmentPercent: String(adj), ...(cap !== null ? { adRateCapPercent: String(cap) } : {}) }] };
      after = `动态费率（建议费率 ${adj >= 0 ? '+' : ''}${adj} 个百分点${cap !== null ? `，最高 ${cap}%` : ''}）`;
    } else throw new ListingError('strategy 应是 FIXED（固定费率，传 bid_percentage）或 DYNAMIC（动态费率，传 adjustment 和可选的 cap）');
    const before = c.ad_rate_strategy === 'FIXED' ? `固定费率 ${c.bid_percentage}%` : c.dynamic_adjustment ? `动态费率（建议费率 ${c.dynamic_adjustment.adjustment >= 0 ? '+' : ''}${c.dynamic_adjustment.adjustment} 个百分点，最高 ${c.dynamic_adjustment.cap}%）` : c.ad_rate_strategy;
    if (before === after) throw new ListingError('和现在的费率策略一样，没有变化');
    return { request: { method: 'POST', path: `${path}/update_ad_rate_strategy`, body }, changes: [{ field: '费率策略', before, after }], notes, target: { strategy: body } };
  }

  if (action === 'update_budget') {
    if (c.funding !== 'cpc') throw new ListingError('只有按点击付费的活动有日预算');
    const v = Number(a.daily_budget);
    if (!Number.isFinite(v) || v <= 0 || Math.round(v * 100) / 100 !== v) throw new ListingError('daily_budget 应是大于 0 的美元金额（最多两位小数）');
    if (c.daily_budget?.value === v) throw new ListingError('和现在的日预算一样，没有变化');
    return { request: { method: 'POST', path: `${path}/update_campaign_budget`, body: { daily: { amount: { value: v.toFixed(2), currency: 'USD' } } } },
      changes: [{ field: '日预算（美元）', before: c.daily_budget?.value ?? null, after: v }], notes, target: { budget: v } };
  }

  // ---- 商品级别 ----
  if (c.funding !== 'cps') throw new ListingError('按商品加减、改费率只支持按成交付费的活动（按点击付费的要在 Seller Hub 里按广告组管理）');
  const items = Array.isArray(a.listings) ? a.listings : null;
  if (!items || !items.length || items.length > 500) throw new ListingError('listings 应是 1~500 个商品：update_bids / add_listings 传 [{ "listing_id": "...", "bid_percentage": 5 }]，remove_listings 传 ["ItemID", ...]');
  const seen = new Set();
  const rows = items.map((it, i) => {
    const id = listingId(typeof it === 'object' && it !== null ? it.listing_id : it, `listings[${i}]`);
    if (seen.has(id)) throw new ListingError(`listings 里 ${id} 重复了`);
    seen.add(id);
    return { id, bid: typeof it === 'object' && it !== null && it.bid_percentage !== undefined ? pct(it.bid_percentage, `listings[${i}].bid_percentage`) : null };
  });
  if (action === 'update_bids') {
    if (c.ad_rate_strategy === 'DYNAMIC') throw new ListingError('这个活动是动态费率，单个商品的费率由 eBay 自动调；要改先用 update_ad_rate 换成固定费率，或调动态费率的加减幅度');
    const changes = rows.map((r) => {
      const cur = inCampaign.get(r.id);
      if (!cur) throw new ListingError(`商品 ${r.id} 不在这个活动里（要加进来用 add_listings）`);
      if (r.bid === null) throw new ListingError(`listings 里 ${r.id} 要给 bid_percentage`);
      return { field: `广告费率（${r.id}）`, before: cur.bid_percentage, after: r.bid };
    }).filter((x) => x.before !== x.after);
    if (!changes.length) throw new ListingError('这些商品的费率和现在一样，没有变化');
    const req = rows.filter((r) => inCampaign.get(r.id).bid_percentage !== r.bid);
    return { request: { method: 'POST', path: `${path}/bulk_update_ads_bid_by_listing_id`, body: { requests: req.map((r) => ({ listingId: r.id, bidPercentage: String(r.bid) })) } },
      changes, notes, target: { bids: Object.fromEntries(req.map((r) => [r.id, r.bid])) } };
  }
  if (action === 'add_listings') {
    const fixed = c.ad_rate_strategy === 'FIXED';
    for (const r of rows) {
      if (inCampaign.has(r.id)) throw new ListingError(`商品 ${r.id} 已经在这个活动里了`);
      if (!fixed && r.bid !== null) throw new ListingError('动态费率的活动加商品时不用给 bid_percentage（eBay 自动定费率）');
      if (fixed && r.bid === null && c.bid_percentage === null) throw new ListingError(`listings 里 ${r.id} 要给 bid_percentage`);
    }
    if (fixed && rows.some((r) => r.bid === null)) notes.push(`没给费率的商品用活动的固定费率 ${c.bid_percentage}%`);
    return { request: { method: 'POST', path: `${path}/bulk_create_ads_by_listing_id`, body: { requests: rows.map((r) => ({ listingId: r.id, ...(fixed ? { bidPercentage: String(r.bid ?? c.bid_percentage) } : {}) })) } },
      changes: rows.map((r) => ({ field: `加入活动（${r.id}）`, before: null, after: fixed ? `费率 ${r.bid ?? c.bid_percentage}%` : '动态费率' })), notes,
      // 固定费率要连费率一起核对（别处以别的费率加进来的不算这次的）
      target: { present: Object.fromEntries(rows.map((r) => [r.id, fixed ? (r.bid ?? c.bid_percentage) : null])) } };
  }
  if (action === 'remove_listings') {
    for (const r of rows) if (!inCampaign.has(r.id)) throw new ListingError(`商品 ${r.id} 不在这个活动里`);
    return { request: { method: 'POST', path: `${path}/bulk_delete_ads_by_listing_id`, body: { requests: rows.map((r) => ({ listingId: r.id })) } },
      changes: rows.map((r) => ({ field: `移出活动（${r.id}）`, before: `费率 ${inCampaign.get(r.id).bid_percentage ?? '动态'}%`, after: null })), notes, target: { absent: rows.map((r) => r.id) } };
  }
  throw new ListingError(`不支持的 action：${action}`);
}

/** 现在的活动是不是已经是目标状态 */
export function adTargetReached(target, c, ads) {
  const bids = new Map((ads ?? []).map((x) => [x.listing_id, x.bid_percentage]));
  if (target.status) return c.status === target.status;
  if (target.strategy) {
    const t = target.strategy;
    if (t.adRateStrategy === 'FIXED') return c.ad_rate_strategy === 'FIXED' && c.bid_percentage === Number(t.bidPercentage);
    const p = t.dynamicAdRatePreferences[0];
    return c.ad_rate_strategy === 'DYNAMIC' && c.dynamic_adjustment?.adjustment === Number(p.adRateAdjustmentPercent) && (p.adRateCapPercent === undefined || c.dynamic_adjustment?.cap === Number(p.adRateCapPercent));
  }
  if (target.budget !== undefined) return c.daily_budget?.value === target.budget;
  if (target.bids) return Object.entries(target.bids).every(([id, b]) => bids.get(id) === b);
  if (target.present) return Object.entries(target.present).every(([id, bid]) => bids.has(id) && (bid === null || bids.get(id) === bid));
  if (target.absent) return target.absent.every((id) => !bids.has(id));
  return false;
}

/** 批量结果是否完整：请求的每个商品恰好一条结果，状态码是有效的 HTTP 状态 */
export function bulkComplete(requests, res) {
  if (!Array.isArray(res?.responses) || res.responses.length !== requests.length) return false;
  const want = new Set(requests.map((r) => String(r.listingId)));
  const seen = new Set();
  for (const r of res.responses) {
    const id = String(r?.listingId ?? '');
    const code = Number(r?.statusCode);
    if (!want.has(id) || seen.has(id) || !Number.isInteger(code) || code < 100 || code > 599) return false;
    seen.add(id);
  }
  return seen.size === want.size;
}

/** 批量接口的逐个结果：哪些商品失败了 */
export function bulkFailures(json) {
  return (json?.responses ?? []).filter((r) => Number(r.statusCode) >= 400)
    .map((r) => ({ listing_id: r.listingId ?? null, status: r.statusCode, errors: (r.errors ?? []).map((e) => `[${e.errorId}] ${e.message ?? ''}`.slice(0, 200)) }));
}

/**
 * 执行一条广告修改记录。lockCampaign(campaignId, fn) 按活动加锁；load()：重新读活动和活动里的商品 → { c, ads }；send(request) 发请求
 */
export async function applyAdChange({ previews, id, storeId, lockCampaign, load, send, now = () => new Date().toISOString() }) {
  const head = previews.load(id);
  if (head.kind !== 'ad') throw new ListingError('这不是广告修改记录（改 listing 用 ebay_listing_apply，新刊登用 ebay_listing_publish）');
  if (head.store_id !== storeId) throw new ListingError('这条修改不是这家店的（shop 参数要和预检时一样）');
  return lockCampaign(head.campaign_id, async () => {
    const rec = previews.load(id);
    if (rec.status === 'applied') return { ok: true, already_applied: true, rec };
    if (rec.status === 'partial') throw new ListingError('这条广告修改之前已经部分生效，不能整批重发：用 ebay_ad_campaign_ads 看现状，剩下的重新预检');
    const recovering = RECOVER.has(rec.status);
    if (!recovering && previews.expired(rec)) throw new ListingError('修改预检已超过 24 小时，请重新预检');
    const { c, ads } = await load(rec.campaign_id);
    const snap = campaignSnapshot(c, ads);
    if (adTargetReached(rec.target, c, ads)) {
      previews.update(id, { status: 'applied', applied_at: now(), note: 'already' });
      return { ok: true, already_applied: true, rec };
    }
    if (!recovering) {
      const changed = Object.keys(rec.snapshot).filter((k) => JSON.stringify(rec.snapshot[k]) !== JSON.stringify(snap[k]));
      if (changed.length) throw new ListingError(`这个活动在预检之后有变化（${changed.join('、')}），为了不覆盖别处的修改，请重新预检`);
    } else if (JSON.stringify(rec.snapshot) !== JSON.stringify(snap)) {
      // 结果不确定后：既不是改前也不是改后 → 停下来
      throw new ListingError('这条广告修改之前的执行结果不确定，而活动现在既不是改前也不是改后的样子，为了不覆盖，停止执行。请用 ebay_ad_campaigns / ebay_ad_campaign_ads 看现状，需要的话重新预检。');
    }
    previews.update(id, { status: 'sending', sending_at: now() });
    let res;
    try {
      res = await send(rec.request);
    } catch (err) {
      if (err?.unknownOutcome) {
        previews.update(id, { status: 'unknown', unknown_at: now() });
        throw new ListingError('广告修改请求没有收到 eBay 的明确回复，不确定是否已生效。再用同一个 change_id 调 ebay_ad_change_apply 会先对账（已经生效就不再发）。');
      }
      previews.update(id, { status: recovering ? 'unknown' : rec.status === 'failed' ? 'failed' : 'ready' });
      throw err;
    }
    const all = (rec.request.body?.requests ?? []).length;
    // 批量接口要每个请求的商品都恰好有一条结果、状态码有效才算数：否则当作结果不确定，下次执行先对账
    if (all && !bulkComplete(rec.request.body.requests, res)) {
      previews.update(id, { status: 'unknown', unknown_at: now() });
      throw new ListingError('eBay 没有返回每个商品的处理结果，不确定是否已生效。再用同一个 change_id 调 ebay_ad_change_apply 会先对账。');
    }
    const failed = bulkFailures(res);
    if (failed.length) {
      previews.update(id, { status: failed.length === all ? 'failed' : 'partial', failed_at: now() });
      return { ok: false, partial: failed.length < all, failed, rec };
    }
    previews.update(id, { status: 'applied', applied_at: now() });
    return { ok: true, rec };
  });
}

/**
 * 读完活动里的全部商品（快照对比、对账都要完整的列表）。fetchPage(offset) → eBay 原始的一页。
 * total 必须是非负整数，每个商品要有合法的 ItemID，不能重复，最后数量要等于 total；否则报错，不拿残缺的列表去对账。
 */
export async function loadAllAds(fetchPage, parse, { pageSize = 500, max = 100_000 } = {}) {
  const ads = [];
  const seen = new Set();
  let total = null;
  for (let offset = 0; offset < max; offset += pageSize) {
    const j = await fetchPage(offset);
    if (typeof j?.total !== 'number' || !Number.isInteger(j.total) || j.total < 0) throw new ListingError('eBay 返回的活动商品列表不完整（没有有效的总数），稍后再试');
    if (total !== null && j.total !== total) throw new ListingError('读活动商品时总数变了（可能正在被修改），稍后再试');
    total = j.total;
    const page = j.ads ?? [];
    if (!Array.isArray(page) || (total > ads.length && !page.length)) throw new ListingError('eBay 返回的活动商品列表不完整，稍后再试');
    for (const raw of page) {
      const a = parse(raw);
      if (!/^\d{9,15}$/.test(String(a.listing_id ?? ''))) throw new ListingError('eBay 返回的活动商品里有无效的 ItemID，稍后再试');
      if (seen.has(a.listing_id)) throw new ListingError('读活动商品时出现重复的商品（翻页不一致），稍后再试');
      seen.add(a.listing_id);
      ads.push(a);
    }
    if (ads.length >= total) break;
  }
  if (ads.length !== total) throw new ListingError(`这个活动有 ${total} 个商品，只读到 ${ads.length} 个，没法安全核对，请在 Seller Hub 里改`);
  return ads;
}
