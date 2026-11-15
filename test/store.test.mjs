import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orderErrorMessage, ordersPath, parseOrder, parseStandards, parseTraffic, summarizeOrders, trafficPath, trafficRange } from '../lib/store.mjs';

test('trafficRange uses calendar days in Los Angeles, also across daylight-saving changes', () => {
  // 11-01 夏令时结束：洛杉矶 11-01 23:30 → 昨天是 10-31
  assert.deepEqual(trafficRange(7, Date.parse('2026-11-02T07:30:00Z')), { start: '2026-10-25', end: '2026-10-31', days: 7 });
  // 03-08 夏令时开始：洛杉矶 03-09 00:30 → 昨天是 03-08
  assert.deepEqual(trafficRange(7, Date.parse('2026-03-09T07:30:00Z')), { start: '2026-03-02', end: '2026-03-08', days: 7 });
});

test('trafficRange ends yesterday in Los Angeles time; trafficPath builds the filter', () => {
  const now = Date.parse('2026-11-15T04:00:00Z'); // 洛杉矶还是 11-14 晚上
  const r = trafficRange(7, now);
  assert.deepEqual(r, { start: '2026-11-07', end: '2026-11-13', days: 7 });
  assert.throws(() => trafficRange(5, now), /days/);
  const p = new URL(`https://x${trafficPath({ range: r, by: 'listing', itemIds: ['123456789012'] })}`);
  assert.equal(p.searchParams.get('dimension'), 'LISTING');
  assert.equal(p.searchParams.get('filter'), 'marketplace_ids:{EBAY_US},date_range:[20261107..20261113],listing_ids:{123456789012}');
  assert.equal(p.searchParams.get('sort'), '-LISTING_IMPRESSION_TOTAL');
  assert.match(p.searchParams.get('metric'), /LISTING_VIEWS_TOTAL/);
});

test('parseTraffic maps metrics by header order, sorts days and computes rates from raw counts', () => {
  const json = {
    header: { metrics: [{ key: 'LISTING_VIEWS_TOTAL' }, { key: 'LISTING_IMPRESSION_SEARCH_RESULTS_PAGE' }, { key: 'LISTING_VIEWS_SOURCE_SEARCH_RESULTS_PAGE' }, { key: 'TRANSACTION' }, { key: 'CLICK_THROUGH_RATE' }] },
    records: [
      { dimensionValues: [{ value: '20261108' }], metricValues: [{ value: 40 }, { value: 500 }, { value: 10 }, { value: 2 }, { value: 0.02 }] },
      { dimensionValues: [{ value: '20261107' }], metricValues: [{ value: 10 }, { value: 0 }, { value: 0 }, { value: 0 }, { value: 0, applicable: false }] },
    ],
    lastUpdatedDate: '2026-11-15T00:00:00Z',
  };
  const out = parseTraffic(json, 'day');
  assert.deepEqual(out.rows.map((r) => r.date), ['2026-11-07', '2026-11-08']);
  assert.deepEqual(out.rows[1], { date: '2026-11-08', views: 40, search_impressions: 500, views_from_search: 10, transactions: 2, search_ctr: 0.02, conversion: 0.05 });
  assert.equal(out.rows[0].search_ctr, null, 'no impressions → no rate');
  assert.equal(out.totals.views, 50);
  assert.equal(out.totals.conversion, 0.04);
  // 文档里的另一种日期格式也能排对
  const doc = parseTraffic({ header: { metrics: [{ key: 'LISTING_VIEWS_TOTAL' }] }, records: [
    { dimensionValues: [{ value: 'Thu Jun 02 00:00:00 GMT-07:00 2016' }], metricValues: [{ value: 1 }] },
    { dimensionValues: [{ value: 'Wed Jun 01 00:00:00 GMT-07:00 2016' }], metricValues: [{ value: 2 }] },
  ] }, 'day');
  assert.deepEqual(doc.rows.map((r) => r.date), ['2016-06-01', '2016-06-02']);
  // eBay 标了不适用的值：合计是 null，不当 0
  const na = parseTraffic({ header: { metrics: [{ key: 'LISTING_IMPRESSION_SEARCH_RESULTS_PAGE' }, { key: 'LISTING_VIEWS_SOURCE_SEARCH_RESULTS_PAGE' }] }, records: [
    { dimensionValues: [{ value: '20261107' }], metricValues: [{ value: 100 }, { value: 0, applicable: false }] },
  ] }, 'day');
  assert.equal(na.rows[0].search_ctr, null);
  assert.deepEqual([na.totals.views_from_search, na.totals.search_ctr, na.incomplete.includes('views_from_search')], [null, null, true]);
  const byListing = parseTraffic({ header: json.header, records: [{ dimensionValues: [{ value: '123456789012' }], metricValues: [{ value: 1 }, { value: 2 }, { value: 1 }, { value: 0 }, { value: 0 }] }] }, 'listing');
  assert.equal(byListing.rows[0].item_id, '123456789012');
  assert.equal(byListing.totals, null, 'no store totals from a listing report (eBay returns at most 200 listings)');
});

test('ordersPath filters by creation date and status', () => {
  const p = new URL(`https://x${ordersPath({ days: 30, status: 'unshipped', limit: 20, offset: 40, now: Date.parse('2026-11-15T00:00:00Z') })}`);
  assert.equal(p.searchParams.get('filter'), 'creationdate:[2026-10-16T00:00:00.000Z..],orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}');
  assert.deepEqual([p.searchParams.get('limit'), p.searchParams.get('offset')], ['20', '40']);
  assert.equal(new URL(`https://x${ordersPath({ status: 'all' })}`).searchParams.get('filter').includes('orderfulfillmentstatus'), false);
  assert.match(new URL(`https://x${ordersPath({ status: 'shipped' })}`).searchParams.get('filter'), /orderfulfillmentstatus:\{FULFILLED\|IN_PROGRESS\}$/);
});

const ORDER = {
  orderId: '01-11111-22222', creationDate: '2026-11-13T02:00:00.000Z', orderFulfillmentStatus: 'NOT_STARTED', orderPaymentStatus: 'PAID',
  buyer: { username: 'buyer_name_x', taxAddress: { postalCode: '90001', countryCode: 'US' }, buyerRegistrationAddress: { fullName: 'Jane Doe', contactAddress: { addressLine1: '1 Main St', city: 'LA', countryCode: 'US' }, primaryPhone: { phoneNumber: '5551234' }, email: 'jane@example.com' } },
  pricingSummary: { priceSubtotal: { value: '20.00', currency: 'USD' }, deliveryCost: { value: '0.00', currency: 'USD' }, total: { value: '21.60', currency: 'USD' } },
  cancelStatus: { cancelState: 'NONE_REQUESTED' },
  paymentSummary: { totalDueSeller: { value: '20.00', currency: 'USD' }, refunds: [] },
  fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: 'Jane Doe', contactAddress: { addressLine1: '1 Main St', city: 'LA', postalCode: '90001', countryCode: 'US' }, primaryPhone: { phoneNumber: '5551234' }, email: 'jane@example.com' }, shippingServiceCode: 'US_StandardSppedPAK' } }],
  lineItems: [{ legacyItemId: '123456789012', sku: 'A-1', title: 'Tree', variationAspects: [{ name: 'Size', value: 'S' }], quantity: 2, total: { value: '21.60', currency: 'USD' },
    lineItemFulfillmentStatus: 'NOT_STARTED', lineItemFulfillmentInstructions: { shipByDate: '2026-11-16T00:00:00.000Z' }, properties: { soldViaAdCampaign: true } }],
};

test('parseOrder keeps business fields and drops every piece of buyer information except the country', () => {
  const o = parseOrder(ORDER);
  assert.equal(o.ship_to_country, 'US');
  assert.equal(o.ship_by, '2026-11-16T00:00:00.000Z');
  assert.deepEqual(o.total, { value: 21.6, currency: 'USD' });
  assert.deepEqual(o.items[0], { item_id: '123456789012', title: 'Tree', sku: 'A-1', variation: 'Size: S', quantity: 2, total: { value: 21.6, currency: 'USD' }, status: 'NOT_STARTED', sold_via_ad: true });
  const text = JSON.stringify(o);
  for (const pii of ['buyer_name_x', 'Jane', '1 Main St', '5551234', 'jane@example.com', '90001', 'LA"']) assert.ok(!text.includes(pii), `leaked ${pii}`);
});

test('summarizeOrders counts statuses, sums sales without cancelled orders, ranks items', () => {
  const a = parseOrder(ORDER);
  const b = parseOrder({ ...ORDER, orderId: '2', orderFulfillmentStatus: 'FULFILLED', cancelStatus: { cancelState: 'CANCELED' } });
  const s = summarizeOrders([a, b]);
  assert.deepEqual(s.by_status, { NOT_STARTED: 1, FULFILLED: 1 });
  assert.deepEqual(s.sales_by_currency, { USD: 21.6 });
  assert.deepEqual(s.top_items[0], { sku: 'A-1', item_id: '123456789012', title: 'Tree', quantity: 2, orders: 1 }, 'cancelled orders do not count as sold');
  assert.equal(s.cancelled, 1);
});

test('parseStandards', () => {
  const out = parseStandards({ standardsProfiles: [{ program: 'PROGRAM_US', standardsLevel: 'TOP_RATED', defaultProgram: true, cycle: { cycleType: 'CURRENT', evaluationDate: '2026-10-21' },
    metrics: [{ metricKey: 'SHIPPING_MISS_RATE', name: 'Late shipment rate', value: { value: '0.00', numerator: 0, denominator: 392 }, level: 'TOP_RATED', type: 'RATE', thresholdUpperBound: 3, thresholdMetaData: 'max' }] }] });
  assert.deepEqual(out[0].program, 'PROGRAM_US');
  assert.deepEqual([out[0].metrics[0].key, out[0].metrics[0].threshold_upper, out[0].metrics[0].threshold_lower, out[0].metrics[0].type], ['SHIPPING_MISS_RATE', 3, null, 'RATE']);
});

test('traffic reports shorter than the requested range list the missing days', () => {
  const range = { start: '2026-11-07', end: '2026-11-13', days: 7 };
  const rec = (d) => ({ dimensionValues: [{ value: d }], metricValues: [{ value: 1 }] });
  const out = parseTraffic({ header: { metrics: [{ key: 'LISTING_VIEWS_TOTAL' }] }, records: ['20261107', '20261108', '20261109', '20261110', '20261111'].map(rec) }, 'day', range);
  assert.deepEqual([out.totals_days, out.missing_days, out.totals.views], [5, ['2026-11-12', '2026-11-13'], 5]);
});

test('order API errors keep only the HTTP status and error codes', () => {
  const err = Object.assign(new Error('eBay 接口出错（HTTP 400）：order 12-345 for buyer jane@example.com is invalid'), { status: 400, codes: [32100] });
  const msg = orderErrorMessage(err);
  assert.match(msg, /HTTP 400，错误码 32100/);
  assert.ok(!msg.includes('jane') && !msg.includes('12-345'));
  assert.equal(orderErrorMessage(new Error('network')), null);
});
