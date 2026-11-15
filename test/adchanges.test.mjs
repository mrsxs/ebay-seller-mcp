import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { adTargetReached, applyAdChange, bulkFailures, campaignSnapshot, planAdChange } from '../lib/adchanges.mjs';
import { createPreviewStore, ListingError } from '../lib/listing.mjs';

const camp = (extra = {}) => ({ campaign_id: '148', name: '常规', status: 'RUNNING', funding: 'cps', ad_rate_strategy: 'FIXED', bid_percentage: 5, dynamic_adjustment: null, daily_budget: null, ...extra });
const ADS = [{ listing_id: '111111111111', bid_percentage: 5 }, { listing_id: '222222222222', bid_percentage: 6 }];

test('planAdChange: campaign status actions', () => {
  const p = planAdChange({ action: 'pause' }, camp(), ADS);
  assert.deepEqual(p.request, { method: 'POST', path: '/sell/marketing/v1/ad_campaign/148/pause', body: null });
  assert.deepEqual(p.target, { status: 'PAUSED' });
  assert.throws(() => planAdChange({ action: 'resume' }, camp(), ADS), /只有暂停的活动能恢复/);
  assert.match(planAdChange({ action: 'end' }, camp(), ADS).notes[0], /不能恢复/);
  assert.throws(() => planAdChange({ action: 'pause' }, camp({ status: 'ENDED' }), ADS), /已经结束/);
  assert.throws(() => planAdChange({ action: 'fly' }, camp(), ADS), /action 只能是/);
});

test('planAdChange: ad rate strategy and budget', () => {
  const dyn = planAdChange({ action: 'update_ad_rate', strategy: 'DYNAMIC', adjustment: 2, cap: 12 }, camp(), ADS);
  assert.deepEqual(dyn.request.body, { adRateStrategy: 'DYNAMIC', dynamicAdRatePreferences: [{ adRateAdjustmentPercent: '2', adRateCapPercent: '12' }] });
  assert.deepEqual(dyn.changes[0], { field: '费率策略', before: '固定费率 5%', after: '动态费率（建议费率 +2 个百分点，最高 12%）' });
  assert.throws(() => planAdChange({ action: 'update_ad_rate', strategy: 'FIXED', bid_percentage: 5 }, camp(), ADS), /没有变化/);
  assert.throws(() => planAdChange({ action: 'update_ad_rate', strategy: 'FIXED', bid_percentage: 150 }, camp(), ADS), /2~100/);
  assert.throws(() => planAdChange({ action: 'update_budget', daily_budget: 10 }, camp(), ADS), /按点击付费/);
  const b = planAdChange({ action: 'update_budget', daily_budget: 12.5 }, camp({ funding: 'cpc', daily_budget: { value: 10, currency: 'USD' } }), []);
  assert.deepEqual(b.request.body, { daily: { amount: { value: '12.50', currency: 'USD' } } });
});

test('planAdChange: listing-level changes', () => {
  const u = planAdChange({ action: 'update_bids', listings: [{ listing_id: '111111111111', bid_percentage: 7 }, { listing_id: '222222222222', bid_percentage: 6 }] }, camp(), ADS);
  assert.deepEqual(u.request.body.requests, [{ listingId: '111111111111', bidPercentage: '7' }], 'unchanged rows are not sent');
  assert.deepEqual(u.target, { bids: { 111111111111: 7 } });
  assert.throws(() => planAdChange({ action: 'update_bids', listings: [{ listing_id: '333333333333', bid_percentage: 7 }] }, camp(), ADS), /不在这个活动里/);
  assert.throws(() => planAdChange({ action: 'update_bids', listings: [{ listing_id: '111111111111', bid_percentage: 7 }] }, camp({ ad_rate_strategy: 'DYNAMIC' }), ADS), /动态费率/);
  const add = planAdChange({ action: 'add_listings', listings: [{ listing_id: '333333333333' }] }, camp(), ADS);
  assert.deepEqual(add.request.body.requests, [{ listingId: '333333333333', bidPercentage: '5' }]);
  assert.throws(() => planAdChange({ action: 'add_listings', listings: [{ listing_id: '111111111111' }] }, camp(), ADS), /已经在这个活动里/);
  assert.deepEqual(planAdChange({ action: 'add_listings', listings: ['333333333333'] }, camp({ ad_rate_strategy: 'DYNAMIC', bid_percentage: null }), ADS).request.body.requests, [{ listingId: '333333333333' }]);
  assert.deepEqual(add.target, { present: { 333333333333: 5 } });
  assert.throws(() => planAdChange({ action: 'resume' }, camp({ status: 'PAUSED', funding: 'cpc' }), []), /Seller Hub/);
  const rm = planAdChange({ action: 'remove_listings', listings: ['222222222222'] }, camp(), ADS);
  assert.deepEqual([rm.request.path.endsWith('/bulk_delete_ads_by_listing_id'), rm.target], [true, { absent: ['222222222222'] }]);
  assert.throws(() => planAdChange({ action: 'remove_listings', listings: ['abc'] }, camp(), ADS), (e) => e instanceof ListingError && /ItemID/.test(e.message));
  assert.throws(() => planAdChange({ action: 'remove_listings', listings: ['111111111111', '111111111111'] }, camp(), ADS), /重复/);
  assert.throws(() => planAdChange({ action: 'update_bids', listings: [] }, camp(), ADS), /1~500/);
});

test('adTargetReached and bulkFailures', () => {
  assert.equal(adTargetReached({ status: 'PAUSED' }, camp({ status: 'PAUSED' }), ADS), true);
  assert.equal(adTargetReached({ bids: { 111111111111: 7 } }, camp(), ADS), false);
  assert.equal(adTargetReached({ absent: ['333333333333'] }, camp(), ADS), true);
  assert.equal(adTargetReached({ present: { 111111111111: 7 } }, camp(), ADS), false, 'present at another bid does not count');
  assert.equal(adTargetReached({ present: { 111111111111: 5 } }, camp(), ADS), true);
  assert.equal(adTargetReached({ strategy: { adRateStrategy: 'DYNAMIC', dynamicAdRatePreferences: [{ adRateAdjustmentPercent: '2', adRateCapPercent: '12' }] } }, camp({ ad_rate_strategy: 'DYNAMIC', dynamic_adjustment: { adjustment: 2, cap: 12 } }), ADS), true);
  assert.deepEqual(bulkFailures({ responses: [{ listingId: '1', statusCode: 200 }, { listingId: '2', statusCode: 400, errors: [{ errorId: 35045, message: 'bad' }] }] }),
    [{ listing_id: '2', status: 400, errors: ['[35045] bad'] }]);
});

function setup(plan, states) {
  let t = Date.parse('2026-11-15T00:00:00Z');
  const store = createPreviewStore({ dir: mkdtempSync(join(tmpdir(), 'ebay-ad-')), now: () => t });
  const [c0, ads0] = states[0];
  store.save({ id: 'aaaaaaaaaaaaaaaa', kind: 'ad', store_id: 'S', campaign_id: '148', created_at: new Date(t).toISOString(), status: 'ready', request: plan.request, target: plan.target, snapshot: campaignSnapshot(c0, ads0), changes: plan.changes });
  let i = 0;
  const sent = [];
  const run = (send) => applyAdChange({ previews: store, id: 'aaaaaaaaaaaaaaaa', storeId: 'S', lockCampaign: (cid, fn) => fn(),
    load: async () => { const [c, ads] = states[Math.min(i++, states.length - 1)]; return { c, ads }; }, send: async (req) => { sent.push(req); return send(req); } });
  return { store, run, sent, advance: (ms) => { t += ms; } };
}

test('applyAdChange: success, stale refusal, already in target state, bulk partial failure', async () => {
  const plan = planAdChange({ action: 'pause' }, camp(), ADS);
  const ok = setup(plan, [[camp(), ADS]]);
  assert.equal((await ok.run(async () => ({ _status: 204 }))).ok, true);
  assert.equal(ok.store.load('aaaaaaaaaaaaaaaa').status, 'applied');
  assert.equal((await ok.run(async () => ({}))).already_applied, true);
  assert.equal(ok.sent.length, 1);

  // 预检后费率被别处改了：拒绝
  const st = setup(plan, [[camp({ bid_percentage: 9 }), ADS]]);
  st.store.update('aaaaaaaaaaaaaaaa', { snapshot: campaignSnapshot(camp(), ADS) });
  await assert.rejects(st.run(async () => ({})), /预检之后有变化（strategy）/);
  assert.equal(st.sent.length, 0);

  const done = setup(plan, [[camp({ status: 'PAUSED' }), ADS]]);
  assert.equal((await done.run(async () => ({}))).already_applied, true);
  assert.equal(done.sent.length, 0);

  const bids = planAdChange({ action: 'update_bids', listings: [{ listing_id: '111111111111', bid_percentage: 7 }, { listing_id: '222222222222', bid_percentage: 8 }] }, camp(), ADS);
  const part = setup(bids, [[camp(), ADS]]);
  const r = await part.run(async () => ({ responses: [{ listingId: '111111111111', statusCode: 200 }, { listingId: '222222222222', statusCode: 400, errors: [{ errorId: 1, message: 'x' }] }] }));
  assert.deepEqual([r.ok, r.partial, part.store.load('aaaaaaaaaaaaaaaa').status], [false, true, 'partial']);
  await assert.rejects(part.run(async () => ({})), /部分生效/, 'a partial batch is never resent as a whole');
  // 批量接口没给每个商品的结果：当作结果不确定
  const inc = setup(bids, [[camp(), ADS]]);
  await assert.rejects(inc.run(async () => ({ responses: [{ listingId: '111111111111', statusCode: 200 }] })), /没有返回每个商品/);
  assert.equal(inc.store.load('aaaaaaaaaaaaaaaa').status, 'unknown');
});

test('applyAdChange: unknown outcome is reconciled instead of resent blindly', async () => {
  const plan = planAdChange({ action: 'pause' }, camp(), ADS);
  const unknown = async () => { throw Object.assign(new Error('timeout'), { unknownOutcome: true }); };
  const applied = setup(plan, [[camp(), ADS], [camp({ status: 'PAUSED' }), ADS]]);
  await assert.rejects(applied.run(unknown), /不确定是否已生效/);
  applied.advance(48 * 3600_000);
  assert.equal((await applied.run(async () => ({}))).already_applied, true);
  assert.equal(applied.sent.length, 1, 'took effect: not sent again');

  const notApplied = setup(plan, [[camp(), ADS], [camp(), ADS]]);
  await assert.rejects(notApplied.run(unknown));
  assert.equal((await notApplied.run(async () => ({ _status: 204 }))).ok, true);
  assert.equal(notApplied.sent.length, 2, 'no effect and nothing else changed: sent again');

  const other = setup(plan, [[camp(), ADS], [camp({ bid_percentage: 9 }), ADS]]);
  await assert.rejects(other.run(unknown));
  await assert.rejects(other.run(async () => ({})), /既不是改前也不是改后/);

  // listing 的修改记录不能当广告修改执行
  const s2 = createPreviewStore({ dir: mkdtempSync(join(tmpdir(), 'ebay-ad2-')) });
  s2.save({ id: 'bbbbbbbbbbbbbbbb', kind: 'revise', store_id: 'S', created_at: new Date().toISOString(), status: 'ready' });
  await assert.rejects(applyAdChange({ previews: s2, id: 'bbbbbbbbbbbbbbbb', storeId: 'S', lockCampaign: (c, fn) => fn(), load: async () => ({}), send: async () => ({}) }), /不是广告修改记录/);
});

test('bulkComplete requires exactly one valid result per requested listing', async () => {
  const { bulkComplete } = await import('../lib/adchanges.mjs');
  const req = [{ listingId: '1' }, { listingId: '2' }];
  assert.equal(bulkComplete(req, { responses: [{ listingId: '1', statusCode: 200 }, { listingId: '2', statusCode: 400 }] }), true);
  assert.equal(bulkComplete(req, { responses: [{ listingId: '1', statusCode: 200 }, { listingId: '1', statusCode: 200 }] }), false, 'duplicates do not cover listing 2');
  assert.equal(bulkComplete(req, { responses: [{ listingId: '1', statusCode: 200 }, { listingId: '2' }] }), false, 'missing status code');
  assert.equal(bulkComplete(req, { responses: [{ listingId: '1', statusCode: 200 }] }), false);
  assert.equal(bulkComplete(req, {}), false);
});

test('loadAllAds refuses incomplete, duplicated or invalid pages', async () => {
  const { loadAllAds } = await import('../lib/adchanges.mjs');
  const parse = (a) => ({ listing_id: a.listingId, bid_percentage: 5 });
  const ad = (i) => ({ listingId: String(100000000000 + i) });
  const pages = (list) => async (offset) => list[offset / 2];
  assert.equal((await loadAllAds(pages([{ total: 3, ads: [ad(1), ad(2)] }, { total: 3, ads: [ad(3)] }]), parse, { pageSize: 2 })).length, 3);
  assert.equal((await loadAllAds(pages([{ total: 0, ads: [] }]), parse, { pageSize: 2 })).length, 0);
  for (const bad of [null, false, '', -1, '3']) {
    await assert.rejects(loadAllAds(pages([{ total: bad, ads: [] }]), parse, { pageSize: 2 }), /总数/, `total ${JSON.stringify(bad)}`);
  }
  await assert.rejects(loadAllAds(pages([{ total: 4, ads: [ad(1), ad(2)] }, { total: 4, ads: [ad(1), ad(2)] }]), parse, { pageSize: 2 }), /重复/);
  await assert.rejects(loadAllAds(pages([{ total: 3, ads: [ad(1), ad(2)] }, { total: 3, ads: [] }]), parse, { pageSize: 2 }), /不完整/);
  await assert.rejects(loadAllAds(pages([{ total: 1, ads: [{ listingId: 'x' }] }]), parse, { pageSize: 2 }), /无效的 ItemID/);
  await assert.rejects(loadAllAds(pages([{ total: 3, ads: [ad(1), ad(2)] }, { total: 4, ads: [ad(3)] }]), parse, { pageSize: 2 }), /总数变了/);
});
