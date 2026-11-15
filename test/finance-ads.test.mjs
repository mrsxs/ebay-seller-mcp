import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellValue, createReportStore, parseAd, parseCampaign, parseReportTsv, reportBody, reportRange, reportTotals } from '../lib/ads.mjs';
import { mergeTransactionSummaries, parseFunds, parsePayout, parseTransaction, payoutsPath, summarizeTransactions, transactionsPath } from '../lib/finance.mjs';

const SALE = {
  transactionId: '14-1', orderId: '14-1', buyer: { username: 'buyer_x' }, transactionType: 'SALE', bookingEntry: 'CREDIT', transactionStatus: 'FUNDS_ON_HOLD',
  transactionDate: '2026-11-13T15:21:09.251Z', amount: { value: '14.91', currency: 'USD' }, totalFeeAmount: { value: '3.08', currency: 'USD' },
  orderLineItems: [{ lineItemId: '1', marketplaceFees: [{ feeType: 'FINAL_VALUE_FEE', amount: { value: '2.45', currency: 'USD' } }, { feeType: 'INTERNATIONAL_FEE', amount: { value: '0.23', currency: 'USD' }, feeMemo: 'memo' }] }],
  transactionMemo: 'Funds on hold',
};
const AD_FEE = { transactionId: 'NS-1', transactionType: 'NON_SALE_CHARGE', bookingEntry: 'DEBIT', transactionStatus: 'PAYOUT', feeType: 'AD_FEE', amount: { value: '5.00', currency: 'USD' },
  references: [{ referenceType: 'ITEM_ID', referenceId: '123456789012' }] };

test('finance: paths, transactions without buyer data, summaries', () => {
  const p = new URL(`https://x${transactionsPath({ days: 30, type: 'SALE', limit: 20, offset: 40, now: Date.parse('2026-11-15T00:00:00Z') })}`);
  assert.equal(p.searchParams.get('filter'), 'transactionDate:[2026-10-16T00:00:00.000Z..],transactionType:{SALE}');
  assert.equal(new URL(`https://x${payoutsPath({ days: 7, now: Date.parse('2026-11-15T00:00:00Z') })}`).searchParams.get('filter'), 'payoutDate:[2026-11-08T00:00:00.000Z..]');
  const t = parseTransaction(SALE);
  assert.equal(t.order_id, '14-1');
  assert.deepEqual(t.fees.map((f) => f.type), ['FINAL_VALUE_FEE', 'INTERNATIONAL_FEE']);
  assert.ok(!JSON.stringify(t).includes('buyer_x'), 'buyer username is not returned');
  const s = summarizeTransactions([t, parseTransaction(AD_FEE)]);
  assert.deepEqual(s.fees_by_type, { FINAL_VALUE_FEE: 2.45, INTERNATIONAL_FEE: 0.23, AD_FEE: 5 });
  assert.equal(s.by_type.length, 2);
  const m = mergeTransactionSummaries([
    { creditCount: 2, creditAmount: { value: '10.5', currency: 'USD' }, creditBookingEntry: 'CREDIT', nonSaleChargeCount: 1, nonSaleChargeAmount: { value: '10', currency: 'USD' }, nonSaleChargeBookingEntry: 'DEBIT' },
    { creditCount: 1, creditAmount: { value: '4.5', currency: 'USD' }, refundCount: 1, refundAmount: { value: '3', currency: 'USD' }, refundBookingEntry: 'DEBIT',
      nonSaleChargeCount: 1, nonSaleChargeAmount: { value: '3', currency: 'USD' }, nonSaleChargeBookingEntry: 'CREDIT' },
  ]);
  assert.deepEqual(m.credits, { count: 3, credit: 15, debit: 0, net: 15, currency: 'USD' });
  assert.deepEqual(m.refunds, { count: 1, credit: 0, debit: 3, net: -3, currency: 'USD' });
  assert.deepEqual(m.non_sale_charges, { count: 2, credit: 3, debit: 10, net: -7, currency: 'USD' }, 'a credited charge is not added to the debits');
  assert.deepEqual(parseFunds({ availableFunds: { value: '-2.52', currency: 'USD' } }).available, { value: -2.52, currency: 'USD' });
  const po = parsePayout({ payoutId: '1', payoutStatus: 'SUCCEEDED', amount: { value: '47.10', currency: 'USD', convertedToCurrency: 'CNY', convertedToValue: '313.98', exchangeRate: '6.67' },
    payoutInstrument: { instrumentType: 'BANK', nickname: 'My bank', accountLastFourDigits: '1234' }, bankReference: 'REF' });
  assert.deepEqual(po.converted, { value: 313.98, currency: 'CNY', rate: 6.67 });
  assert.ok(!/1234|My bank|REF/.test(JSON.stringify(po)), 'no bank details');
});

test('ads: campaigns and ads', () => {
  const c = parseCampaign({ campaignId: '1', campaignName: '常规', campaignStatus: 'RUNNING', fundingStrategy: { fundingModel: 'COST_PER_SALE', adRateStrategy: 'DYNAMIC', dynamicAdRatePreferences: [{ adRateAdjustmentPercent: '0', adRateCapPercent: '15' }] } });
  assert.deepEqual([c.funding, c.ad_rate_strategy, c.dynamic_adjustment], ['cps', 'DYNAMIC', { adjustment: 0, cap: 15 }]);
  const cpc = parseCampaign({ campaignId: '2', fundingStrategy: { fundingModel: 'COST_PER_CLICK' }, budget: { daily: { amount: { value: '10.00', currency: 'USD' } } } });
  assert.deepEqual(cpc.daily_budget, { value: 10, currency: 'USD' });
  assert.deepEqual(parseAd({ adId: 'a', listingId: '123456789012', bidPercentage: '5.0', adStatus: 'ACTIVE' }), { ad_id: 'a', listing_id: '123456789012', bid_percentage: 5, status: 'ACTIVE' });
});

test('ads: report bodies use the minimum dimensions eBay requires', () => {
  const range = reportRange(30, Date.parse('2026-11-15T04:00:00Z'));
  assert.deepEqual(range, { from: '2026-10-16T00:00:00.000Z', to: '2026-11-14T23:59:59.000Z' }, 'yesterday is included to the end of the day');
  assert.deepEqual(reportBody({ kind: 'listing', range }).dimensions, [{ dimensionKey: 'listing_id' }, { dimensionKey: 'campaign_id' }]);
  assert.deepEqual(reportBody({ kind: 'campaign', range }).dimensions.map((d) => d.dimensionKey), ['day', 'campaign_id']);
  assert.deepEqual(reportBody({ kind: 'transaction', range, funding: 'cps' }).metricKeys, ['sales', 'ad_fees', 'sale_amount']);
  assert.deepEqual(reportBody({ kind: 'account', range, funding: 'cpc', campaignIds: ['9'] }).fundingModels, ['COST_PER_CLICK']);
  assert.throws(() => reportBody({ kind: 'keyword', range, funding: 'cps' }), /按点击付费/);
  assert.throws(() => reportBody({ kind: 'nope', range }), /report 只能是/);
  assert.throws(() => reportRange(5), /days/);
});

test('ads: TSV report parsing and totals', () => {
  const tsv = 'day\timpressions\tclicks\tctr\tsales\tsale_amount\tad_fees\r\nOct 16, 2026\t10503\t7\t7.0E-4\t1\tUSD 17.01\tUSD 2.55\r\nOct 17, 2026\t8330\t7\t8.0E-4\t1\tUSD 19.07\tUSD 2.10\r\n';
  const { columns, rows } = parseReportTsv(tsv);
  assert.deepEqual(rows[0], { day: '2026-10-16', impressions: 10503, clicks: 7, ctr: 0.0007, sales: 1, sale_amount: { value: 17.01, currency: 'USD' }, ad_fees: { value: 2.55, currency: 'USD' } });
  assert.deepEqual(reportTotals(rows, columns), { impressions: 18833, clicks: 14, sales: 2, sale_amount: { value: 36.08, currency: 'USD' }, ad_fees: { value: 4.65, currency: 'USD' } });
  const ids = parseReportTsv('listing_id\tcampaign_id\timpressions\n012345678901\t148387216018\t5\n').rows[0];
  assert.deepEqual([ids.listing_id, ids.campaign_id], ['012345678901', '148387216018'], 'ID columns stay strings');
  assert.equal(cellValue('USD 1,234.50').value, 1234.5);
  assert.equal(cellValue(''), null);
});

test('ads: report tasks are reused for 24 hours', () => {
  let t = Date.parse('2026-11-15T00:00:00Z');
  const store = createReportStore({ dir: mkdtempSync(join(tmpdir(), 'ebay-rep-')), now: () => t });
  const k = store.key('S', { a: 1 });
  assert.notEqual(k, store.key('S', { a: 2 }));
  store.set(k, { task_id: '1', created_at: t });
  assert.equal(store.get(k).task_id, '1');
  t += 25 * 3600_000;
  assert.equal(store.get(k), null);
});

test('restCall: a truncated success body is not an empty success', async () => {
  const { restCall } = await import('../lib/ebay-api.mjs');
  const res = (status, body) => async () => ({ status, ok: status < 400, text: async () => body, headers: { get: () => null } });
  await assert.rejects(restCall({ token: 't', path: '/x', fetchImpl: res(200, '{"campaigns":[') }), /内容不完整/);
  await assert.rejects(restCall({ token: 't', path: '/x', method: 'POST', body: {}, fetchImpl: res(200, '{"responses":[') }), (e) => e.unknownOutcome === true);
  await assert.rejects(restCall({ token: 't', path: '/x', method: 'POST', body: {}, fetchImpl: res(502, '') }), (e) => e.unknownOutcome === true);
  await assert.rejects(restCall({ token: 't', path: '/x', method: 'POST', fetchImpl: async () => { throw new Error('reset'); } }), (e) => e.unknownOutcome === true);
  await assert.rejects(restCall({ token: 't', path: '/x', fetchImpl: async () => { throw new Error('reset'); } }), (e) => e.unknownOutcome === false);
  assert.deepEqual(await restCall({ token: 't', path: '/x', method: 'POST', fetchImpl: res(204, '') }), { _status: 204, _location: null });
});

test('round 2: empty success bodies, CPC report dimensions, corrupt gzip, report header check', async () => {
  const { restCall } = await import('../lib/ebay-api.mjs');
  const { reportText } = await import('../lib/ads.mjs');
  const { gzipSync, gunzipSync } = await import('node:zlib');
  const res = (status, body) => async () => ({ status, ok: status < 400, text: async () => body, headers: { get: () => null } });
  await assert.rejects(restCall({ token: 't', path: '/x', fetchImpl: res(200, '') }), /内容不完整/, 'an empty 200 is not an empty list');
  await assert.rejects(restCall({ token: 't', path: '/x', method: 'POST', body: {}, fetchImpl: res(200, '') }), (e) => e.unknownOutcome === true);
  const range = reportRange(7, Date.parse('2026-11-15T04:00:00Z'));
  assert.deepEqual(reportBody({ kind: 'campaign', range, funding: 'cpc' }).dimensions.map((d) => d.dimensionKey), ['day', 'campaign_id', 'ad_group_id']);
  assert.deepEqual(reportBody({ kind: 'listing', range, funding: 'cpc' }).dimensions.map((d) => d.dimensionKey), ['listing_id', 'campaign_id', 'ad_group_id']);
  assert.deepEqual(reportBody({ kind: 'listing', range, funding: 'cps' }).dimensions.map((d) => d.dimensionKey), ['listing_id', 'campaign_id']);
  const gz = gzipSync(Buffer.from('day\timpressions\nOct 16, 2026\t5\n'));
  assert.match(reportText(gz, gunzipSync), /^day\timpressions/);
  assert.throws(() => reportText(gz.subarray(0, 12), gunzipSync), /解压失败/);
  assert.throws(() => parseReportTsv('garbage\n', ['day']), /缺少 day/);
  assert.throws(() => parseReportTsv('', []), /空的/);
});

test('fees_by_type nets refunded fees', () => {
  const refund = { transactionId: 'R-1', transactionType: 'REFUND', bookingEntry: 'DEBIT', amount: { value: '14.91', currency: 'USD' },
    orderLineItems: [{ marketplaceFees: [{ feeType: 'FINAL_VALUE_FEE', amount: { value: '2.45', currency: 'USD' } }] }] };
  const s = summarizeTransactions([parseTransaction(SALE), parseTransaction(refund)]);
  assert.equal(s.fees_by_type.FINAL_VALUE_FEE, 0, 'a full refund returns the final value fee');
  assert.equal(s.fees_by_type.INTERNATIONAL_FEE, 0.23);
});
