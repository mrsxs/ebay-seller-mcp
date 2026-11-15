import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  applyChange, buildReviseXml, inventoryXml, planEnd, planRelist, planRevise, reviseSnapshot, reviseSteps, staleFields,
} from '../lib/changes.mjs';
import { createPreviewStore, ListingError } from '../lib/listing.mjs';

const NOW = Date.parse('2026-11-15T00:00:00Z');
const single = (extra = {}) => ({
  item_id: '111111111111', title: 'Old Title', status: 'Active', listing_type: 'FixedPriceItem', url: 'https://www.ebay.com/itm/111111111111', currency: 'USD', site: 'US',
  category: { id: '262323', name: 'Dioramas' }, condition: { id: 1000, name: 'New', description: null }, sku: 'S-1', price: 9.99, quantity_available: 10, quantity_sold: 0, best_offer: false,
  images: ['https://i.ebayimg.com/a.jpg', 'https://i.ebayimg.com/b.jpg'], aspects: { Brand: 'Unbranded', Type: 'Diorama' }, variations: null,
  policies: { fulfillment: { id: '1', name: 'Ship' }, return: { id: '2', name: 'Ret' }, payment: { id: '3', name: 'Pay' } },
  location: { country: 'CN', location: 'Shenzhen', postal_code: '518000' }, end_time: '2026-12-13T00:00:00Z', relisted_item_id: null, description: '<p>old</p>', ...extra,
});
const VARS = (items) => ({
  specifics: [{ name: 'Size', values: ['S', 'L'] }, { name: 'Color', values: ['Red'] }],
  picture_by: 'Color', pictures: { Red: ['https://i.ebayimg.com/red.jpg'] },
  items: items ?? [
    { sku: 'M-S', values: { Size: 'S', Color: 'Red' }, price: 9.99, quantity_available: 5, quantity_sold: 0 },
    { sku: 'M-L', values: { Size: 'L', Color: 'Red' }, price: 12.99, quantity_available: 3, quantity_sold: 2 },
  ],
});
const multi = (extra = {}) => single({ sku: 'M', price: null, quantity_available: null, variations: VARS(), quantity_sold: 2, ...extra });

test('planRevise: only real changes are kept; single-SKU price and quantity go to inventory', () => {
  const p = planRevise({ title: 'Old Title', price: 8.99, quantity: 10, best_offer: true }, single(), { now: NOW });
  assert.deepEqual(p.intent, { best_offer: true, inventory: [{ sku: null, price: 8.99 }] });
  assert.deepEqual(p.changes.map((c) => c.field), ['议价', '价格（美元）']);
  assert.throws(() => planRevise({ title: 'Old Title' }, single(), { now: NOW }), /没有任何变化/);
  assert.throws(() => planRevise({ nonsense: 1 }, single(), { now: NOW }), /不认识的修改项/);
  assert.throws(() => planRevise({ quantity: 0 }, single(), { now: NOW }), /不小于 1/);
  assert.throws(() => planRevise({ price: 1 }, single({ status: 'Completed' }), { now: NOW }), /不是在售状态/);
  assert.throws(() => planRevise({ price: 1 }, single({ currency: 'GBP', site: 'UK' }), { now: NOW }), /美国站、美元/);
  assert.match(planRevise({ price: 8.99 }, single({ best_offer: true }), { now: NOW }).notes[0], /议价/);
});

test('planRevise: title, category and location are locked after sales or within 12 hours of the end; location needs a postcode', () => {
  assert.throws(() => planRevise({ title: 'New' }, single({ quantity_sold: 1 }), { now: NOW }), /已经有销量.*标题/);
  assert.throws(() => planRevise({ category_id: '1' }, single({ quantity_sold: 1 }), { now: NOW }), /类目/);
  assert.throws(() => planRevise({ location: { country: 'US', location: 'LA', postal_code: '90001' } }, single({ end_time: '2026-11-15T06:00:00Z' }), { now: NOW }), /12 小时内到期.*发货地/);
  assert.throws(() => planRevise({ location: { country: 'CN', location: 'Yiwu' } }, single(), { now: NOW }), /postal_code/);
  assert.throws(() => planRevise({ location: { country: 'CN', location: 5, postal_code: '1' } }, single(), { now: NOW }), /应是字符串/);
  assert.ok(planRevise({ title: 'New' }, single(), { now: NOW }).intent.title);
});

test('planRevise: images and description are shown in full order / text, aspects replace the whole set', () => {
  const p = planRevise({ images: ['https://i.ebayimg.com/b.jpg', '/abs/new.jpg'], aspects: { Brand: 'Unbranded', Material: 'Plastic' }, description: 'Brand new text' }, single(), { now: NOW });
  assert.deepEqual(p.newImages, [{ kind: 'file', ref: '/abs/new.jpg' }]);
  const img = p.changes.find((c) => c.field.startsWith('图片'));
  assert.deepEqual(img.after, ['1. 原第 2 张', '2. 新图 new.jpg']);
  assert.deepEqual(p.changes.find((c) => c.field.startsWith('描述')), { field: '描述（整段替换，下面是开头的文字）', before: 'old', after: 'Brand new text' });
  assert.ok(p.changes.find((c) => c.field.startsWith('商品属性')).after.some((s) => s.startsWith('Type') && s.includes('删除')));
  assert.ok(p.notes.some((n) => n.includes('整组替换')));
  assert.throws(() => planRevise({ aspects: { Size: 'XL' } }, multi(), { now: NOW }), /规格名/);
  assert.throws(() => planRevise({ images: [] }, single(), { now: NOW }), /完整图片列表/);
});

test('planRevise: variation rules', () => {
  const p = planRevise({ variations: {
    update: [{ sku: 'm-s', price: 8.99, quantity: 5 }],
    add: [{ sku: 'M-XL', price: 14.99, quantity: 4, values: { size: 'XL', color: 'Blue' }, image: '/abs/blue.jpg' }],
    remove: ['M-L'],
  } }, multi(), { now: NOW });
  assert.deepEqual(p.intent.inventory, [{ sku: 'M-S', price: 8.99 }], 'unchanged quantity is dropped');
  assert.deepEqual(p.intent.variations.added[0].values, { Size: 'XL', Color: 'Blue' });
  assert.deepEqual(p.intent.variations.removed, [{ sku: 'M-L', values: { Size: 'L', Color: 'Red' } }]);
  assert.deepEqual(p.changes.find((c) => c.field.startsWith('规格图')).after, { 新增或加图: ['Blue'], 删除: [] });
  const bad = (v, re) => assert.throws(() => planRevise({ variations: v }, multi(), { now: NOW }), (e) => e instanceof ListingError && re.test(e.message));
  bad({ update: [{ sku: 'NOPE', price: 1 }] }, /找不到 SKU/);
  bad({ update: {} }, /应是数组/);
  bad({ update: [{ sku: 'M-S', price: 1 }, { sku: 'M-S', quantity: 1 }] }, /重复/);
  bad({ update: [{ sku: 'M-S', price: 1 }], remove: ['M-S'] }, /既要改又要删/);
  bad({ add: [{ sku: 'M-S', price: 1, quantity: 1, values: { Size: 'X', Color: 'Y' } }] }, /已经存在/);
  bad({ add: [{ sku: 'N', price: 1, quantity: 1, values: { Size: 'S', Color: 'Red' } }] }, /组合已经存在/);
  bad({ add: [{ sku: 'N', price: 1, quantity: 1, values: { Size: 'S' } }] }, /缺少规格「Color」/);
  bad({ add: [{ sku: 'N', price: 1, quantity: 1, values: { Size: null, Color: 'Z' } }] }, /应是字符串/);
  bad({ remove: ['M-S', 'M-L'] }, /不能把所有规格都删掉/);
  assert.throws(() => planRevise({ price: 1 }, multi(), { now: NOW }), /variations\.update/);
  assert.throws(() => planRevise({ variations: { update: [] } }, single(), { now: NOW }), /不是多规格/);
  assert.throws(() => planRevise({ variations: { update: [{ sku: 'X', price: 1 }] } }, multi({ variations: VARS([{ sku: null, values: { Size: 'S', Color: 'Red' }, price: 1, quantity_available: 1, quantity_sold: 0 }]) }), { now: NOW }), /没有 SKU/);
});

test('buildReviseXml: changed fields only; variations add/remove with full specifics and picture sets', () => {
  const d = multi({ quantity_sold: 0, variations: VARS(VARS().items.map((x) => ({ ...x, quantity_sold: 0 }))) });
  const p = planRevise({
    title: 'New <Title> & more', location: { country: 'CN', location: 'Yiwu', postal_code: '322000' }, images: ['https://i.ebayimg.com/a.jpg', '/abs/new.jpg'],
    variations: { add: [{ sku: 'M-XL', price: 14.99, quantity: 4, values: { Size: 'XL', Color: 'Blue' }, image: '/abs/blue.jpg' }], remove: ['M-S'] },
  }, d, { now: NOW });
  const pics = new Map([['/abs/new.jpg', 'https://i.ebayimg.com/new.jpg'], ['/abs/blue.jpg', 'https://i.ebayimg.com/blue.jpg']]);
  const xml = buildReviseXml('111111111111', p.intent, d, pics);
  assert.match(xml, /^<Item><ItemID>111111111111<\/ItemID><Title>New &lt;Title&gt; &amp; more<\/Title>/);
  assert.match(xml, /<PictureDetails><PictureURL>https:\/\/i\.ebayimg\.com\/a\.jpg<\/PictureURL><PictureURL>https:\/\/i\.ebayimg\.com\/new\.jpg<\/PictureURL><\/PictureDetails>/);
  assert.match(xml, /<Country>CN<\/Country><Location>Yiwu<\/Location><PostalCode>322000<\/PostalCode>/);
  assert.match(xml, /<VariationSpecificsSet><NameValueList><Name>Size<\/Name><Value>L<\/Value><Value>XL<\/Value><\/NameValueList><NameValueList><Name>Color<\/Name><Value>Red<\/Value><Value>Blue<\/Value><\/NameValueList><\/VariationSpecificsSet>/);
  assert.match(xml, /<Variation><SKU>M-XL<\/SKU><StartPrice>14\.99<\/StartPrice><Quantity>4<\/Quantity><VariationSpecifics>/);
  assert.match(xml, /<Variation><Delete>true<\/Delete><SKU>M-S<\/SKU><VariationSpecifics><NameValueList><Name>Size<\/Name><Value>S<\/Value>/);
  assert.match(xml, /<Pictures><VariationSpecificName>Color<\/VariationSpecificName><VariationSpecificPictureSet><VariationSpecificValue>Red<\/VariationSpecificValue><PictureURL>https:\/\/i\.ebayimg\.com\/red\.jpg<\/PictureURL><\/VariationSpecificPictureSet><VariationSpecificPictureSet><VariationSpecificValue>Blue<\/VariationSpecificValue>/);
  assert.equal(buildReviseXml('1', { inventory: [{ sku: null, price: 1 }] }, single(), new Map()), null, 'price-only changes have no content step');
});

test('reviseSteps batches inventory rows by four and builds the body from the rows', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ sku: `S${i}`, price_after: 1 + i, quantity_after: i }));
  const steps = reviseSteps('<Item/>', { inventory: rows });
  assert.deepEqual(steps.map((s) => s.call), ['ReviseFixedPriceItem', 'ReviseInventoryStatus', 'ReviseInventoryStatus']);
  assert.equal(steps[1].rows.length, 4);
  assert.equal(inventoryXml('111', steps[2].rows), '<InventoryStatus><ItemID>111</ItemID><SKU>S4</SKU><StartPrice>5.00</StartPrice><Quantity>4</Quantity></InventoryStatus>');
  assert.equal(inventoryXml('111', [{ sku: null, quantity_after: 7 }]), '<InventoryStatus><ItemID>111</ItemID><Quantity>7</Quantity></InventoryStatus>');
});

test('staleFields: sales are not a change, external edits are', () => {
  const d = single();
  const p = planRevise({ title: 'New', price: 8.99, quantity: 20 }, d, { now: NOW });
  const snap = reviseSnapshot(p.intent, d);
  assert.deepEqual(staleFields(snap, single({ quantity_available: 3, quantity_sold: 7 })), [], '7 sold: total unchanged');
  assert.deepEqual(staleFields(snap, single({ quantity_available: 1 })), ['stock'], 'stock corrected elsewhere');
  assert.deepEqual(staleFields(snap, single({ title: 'Changed elsewhere', price: 7.99 })), ['title', 'price']);
  const v = multi();
  const pv = planRevise({ variations: { add: [{ sku: 'M-XL', price: 1, quantity: 1, values: { Size: 'XL', Color: 'Red' } }] } }, v, { now: NOW });
  assert.deepEqual(staleFields(reviseSnapshot(pv.intent, v), multi({ variations: { ...VARS(), pictures: { Red: ['https://i.ebayimg.com/other.jpg'] } } })), ['variations'], 'variation pictures changed elsewhere');
});

test('planEnd and planRelist', () => {
  const e = planEnd(single(), 'Incorrect');
  assert.equal(e.steps[0].call, 'EndFixedPriceItem');
  assert.match(e.steps[0].body, /<ItemID>111111111111<\/ItemID><EndingReason>Incorrect<\/EndingReason>/);
  assert.throws(() => planEnd(single(), 'Sold'), /reason/);
  assert.throws(() => planEnd(single({ status: 'Completed' })), /不是在售状态/);
  const ended = single({ status: 'Completed', end_time: '2026-11-13T00:00:00Z' });
  const r = planRelist(ended, 'UUID1', { now: NOW });
  assert.match(r.steps[0].body, /^<Item><ItemID>111111111111<\/ItemID><UUID>UUID1<\/UUID><Quantity>10<\/Quantity><\/Item>$/);
  const rv = planRelist(multi({ status: 'Completed', end_time: '2026-11-13T00:00:00Z', variations: VARS([
    { sku: 'M-S', values: { Size: 'S', Color: 'Red' }, price: 9.99, quantity_available: 5, quantity_sold: 0 },
    { sku: 'M-L', values: { Size: 'L', Color: 'Red' }, price: 12.99, quantity_available: 0, quantity_sold: 4 },
  ]) }), 'U2', { now: NOW });
  assert.match(rv.steps[0].body, /<Variation><SKU>M-L<\/SKU><StartPrice>12\.99<\/StartPrice><Quantity>0<\/Quantity>/, 'sold-out variations stay at zero');
  assert.throws(() => planRelist(single(), 'U', { now: NOW }), /还在售/);
  assert.throws(() => planRelist(single({ status: 'Completed', end_time: '2026-07-01T00:00:00Z' }), 'U', { now: NOW }), /90 天/);
  assert.throws(() => planRelist(single({ status: 'Completed', quantity_available: 0 }), 'U', { now: NOW }), /可售数量是 0/);
  assert.match(planRelist({ ...ended, relisted_item_id: '222' }, 'U', { now: NOW }).notes.join(), /已经重新上架过/);
});

// ---- applyChange ----
const OK = { ack: 'Success', errors: [], warnings: [], xml: '<ItemID>222222222222</ItemID>' };
const FAIL = (code) => ({ ack: 'Failure', errors: [{ code, params: [] }], warnings: [] });
const UNKNOWN = () => { throw Object.assign(new Error('timeout'), { unknownOutcome: true }); };

function setup(rec, items) {
  let t = NOW;
  const store = createPreviewStore({ dir: mkdtempSync(join(tmpdir(), 'ebay-changes-')), now: () => t });
  store.save({ id: 'aaaaaaaaaaaaaaaa', store_id: 'S', item_id: '111111111111', created_at: new Date(t).toISOString(), status: 'ready', ...rec });
  let idx = 0;
  const calls = [];
  const locked = [];
  const run = (call) => applyChange({
    previews: store, id: 'aaaaaaaaaaaaaaaa', storeId: 'S', describe: (l) => l.map((e) => e.code),
    lockItem: (itemId, fn) => { locked.push(itemId); return fn(); },
    getItem: async () => items[Math.min(idx++, items.length - 1)],
    call: async (step) => { calls.push(step); return call(step); },
  });
  return { store, run, calls, locked, rec: () => store.load('aaaaaaaaaaaaaaaa'), advance: (ms) => { t += ms; } };
}
const reviseRec = (input, d) => {
  const p = planRevise(input, d, { now: NOW });
  const snapshot = reviseSnapshot(p.intent, d);
  return { kind: 'revise', intent: p.intent, snapshot, changes: p.changes, title: d.title, steps: reviseSteps(buildReviseXml(d.item_id, p.intent, d, new Map()), snapshot) };
};

test('applyChange: locks the listing, refuses stale listings, runs all steps once', async () => {
  const d = single();
  const rec = reviseRec({ title: 'New', price: 8.99 }, d);
  const stale = setup(rec, [single({ price: 7.5 })]);
  await assert.rejects(stale.run(async () => OK), /预检之后有变化（价格）/);
  assert.equal(stale.calls.length, 0);

  const s = setup(rec, [d]);
  const r = await s.run(async () => OK);
  assert.equal(r.ok, true);
  assert.deepEqual(s.locked, ['111111111111']);
  assert.deepEqual(s.calls.map((c) => c.call), ['ReviseFixedPriceItem', 'ReviseInventoryStatus']);
  assert.equal(s.calls[1].body, '<InventoryStatus><ItemID>111111111111</ItemID><StartPrice>8.99</StartPrice></InventoryStatus>');
  assert.equal(s.rec().status, 'applied');
  assert.equal((await s.run(async () => OK)).already_applied, true);
  assert.equal(s.calls.length, 2);
  await assert.rejects(setup({ ...rec, kind: undefined }, [d]).run(async () => OK), /ebay_listing_publish/);
});

test('applyChange recovery: a quantity write that took effect is not replayed even if items sold meanwhile', async () => {
  const d = single();
  const rec = reviseRec({ quantity: 20 }, d);
  // 发出去后结果不确定；其实已生效（可售 20），之后又卖出 3 件 → 可售 17、已售 3。
  // 「可售 + 已售」= 20 = 目标可售 20 + 发送时已售 0，判断为已生效，不再重发
  const after = single({ quantity_available: 17, quantity_sold: 3 });
  const s = setup(rec, [d, after]);
  await assert.rejects(s.run(UNKNOWN), /不确定是否已生效/);
  assert.equal(s.rec().status, 'unknown');
  s.advance(48 * 3600_000);
  const r = await s.run(async () => OK);
  assert.equal(r.ok, true);
  assert.equal(s.calls.length, 1, 'not sent again: 3 sold units are not restocked');
});

test('applyChange recovery: a write that did not take effect is resent; anything else stops', async () => {
  const d = single();
  const rec = reviseRec({ quantity: 20, price: 8.99 }, d);
  const s = setup(rec, [d, single({ quantity_available: 8, quantity_sold: 2 })]);
  await assert.rejects(s.run(UNKNOWN));
  const r = await s.run(async () => OK);
  assert.equal(r.ok, true);
  assert.equal(s.calls.length, 2, 'not applied (total still 10, price still 9.99) → sent again');

  const c = setup(rec, [d, single({ quantity_available: 4, quantity_sold: 0, price: 7 })]);
  await assert.rejects(c.run(UNKNOWN));
  await assert.rejects(c.run(async () => OK), /既不是改前也不是改后/);
  assert.equal(c.calls.length, 1);
});

test('applyChange recovery: content step with a variation add is skipped once the listing shows it, remaining steps are sent', async () => {
  const d = multi();
  const rec = reviseRec({ variations: { add: [{ sku: 'M-XL', price: 14.99, quantity: 4, values: { Size: 'XL', Color: 'Red' } }], update: [{ sku: 'M-S', price: 8.99 }] } }, d);
  const added = multi({ variations: VARS([...VARS().items, { sku: 'M-XL', values: { Size: 'XL', Color: 'Red' }, price: 14.99, quantity_available: 4, quantity_sold: 0 }]) });
  const s = setup(rec, [d, added]);
  await assert.rejects(s.run(UNKNOWN), /不确定是否已生效/);
  const r = await s.run(async () => OK);
  assert.equal(r.ok, true);
  assert.deepEqual(s.calls.map((c) => c.call), ['ReviseFixedPriceItem', 'ReviseInventoryStatus']);
  const wrong = multi({ variations: VARS([...VARS().items, { sku: 'M-XL', values: { Size: 'XXL', Color: 'Red' }, price: 1, quantity_available: 1, quantity_sold: 0 }]) });
  const c = setup(rec, [d, wrong]);
  await assert.rejects(c.run(UNKNOWN));
  await assert.rejects(c.run(async () => OK), /既不是改前也不是改后/, 'a same-SKU variation with other values is not taken as ours');
});

test('applyChange: rejection before anything changed → failed; after a step → partial with per-step done', async () => {
  const d = single();
  const rec = reviseRec({ title: 'New', price: 8.99 }, d);
  const a = setup(rec, [d]);
  const ra = await a.run(async () => FAIL('21916'));
  assert.deepEqual([ra.ok, ra.partial, a.rec().status], [false, false, 'failed']);
  const b = setup(rec, [d]);
  const rb = await b.run(async (step) => (step.call === 'ReviseFixedPriceItem' ? OK : FAIL('21916')));
  assert.deepEqual([rb.ok, rb.partial, b.rec().status, b.rec().done], [false, true, 'partial', [0]]);
});

test('applyChange: end and relist (snapshot checks, 1047, 488, recovery keeps the new ItemID)', async () => {
  const live = single();
  const end = { kind: 'end', ...planEnd(live) };
  const e1 = setup(end, [single({ title: 'Renamed elsewhere' })]);
  await assert.rejects(e1.run(async () => OK), /有变化（标题）/);
  const e2 = setup(end, [live]);
  const r2 = await e2.run(async () => FAIL('1047'));
  assert.deepEqual([r2.ok, r2.result.already_ended], [true, true]);

  const ended = single({ status: 'Completed', end_time: '2026-11-13T00:00:00Z' });
  const relist = { kind: 'relist', ...planRelist(ended, 'UUID', { now: NOW }) };
  assert.equal((await setup(relist, [ended]).run(async () => OK)).result.new_item_id, '222222222222');
  assert.equal((await setup(relist, [ended]).run(async () => ({ ack: 'Failure', errors: [{ code: '488', params: ['333333333333'] }], warnings: [] }))).result.new_item_id, '333333333333');
  await assert.rejects(setup(relist, [{ ...ended, relisted_item_id: '444444444444' }]).run(async () => OK), /有变化（重新上架记录）/);
  // 结果不确定后原 listing 出现了新的重新上架记录：分不清是不是这次的，停下来让人确认，不自动当成结果
  const rc = setup(relist, [ended, { ...ended, relisted_item_id: '555555555555' }]);
  await assert.rejects(rc.run(UNKNOWN));
  await assert.rejects(rc.run(async () => OK), /555555555555.*Seller Hub/);
  assert.equal(rc.calls.length, 1);
  // 没有新记录、库存没变：带同一个 UUID 重发（eBay 认出重复会返回原 ItemID）
  const rs = setup(relist, [ended]);
  await assert.rejects(rs.run(UNKNOWN));
  const rr = await rs.run(async () => ({ ack: 'Failure', errors: [{ code: '488', params: ['666666666666'] }], warnings: [] }));
  assert.deepEqual([rr.ok, rr.result.new_item_id, rs.calls.length], [true, '666666666666', 2]);
  assert.equal(rs.calls[1].body, rs.calls[0].body, 'same request, same UUID');
  // 结果不确定后库存被改了：不重发
  const rk = setup(relist, [ended, { ...ended, quantity_available: 1, quantity_sold: 0 }]);
  await assert.rejects(rk.run(UNKNOWN));
  await assert.rejects(rk.run(async () => OK), /既不是改前也不是改后/);
  // 下架：结果不确定后标题被改了，不再下架
  const ek = setup(end, [live, single({ title: 'Renamed' })]);
  await assert.rejects(ek.run(UNKNOWN));
  await assert.rejects(ek.run(async () => OK), /既不是改前也不是改后/);
  assert.equal(ek.calls.length, 1);
});

test('applyChange: inventory baseline is taken right before each send (sales during earlier steps)', async () => {
  const d = single();
  const rec = reviseRec({ title: 'New', quantity: 9 }, d);
  // 改内容期间卖出 2 件（可售 8、已售 2，总数 10）；把可售设成 9 生效后总数 = 9 + 2 = 11，之后再卖 1 件总数不变
  const afterContent = single({ title: 'New', quantity_available: 8, quantity_sold: 2 });
  const later = single({ title: 'New', quantity_available: 8, quantity_sold: 3 });
  // 读：开始 d → 改库存前 afterContent → 对账时 later
  const s = setup(rec, [d, afterContent, later]);
  await assert.rejects(s.run(async (step) => (step.call === 'ReviseFixedPriceItem' ? OK : UNKNOWN())), /不确定是否已生效/);
  assert.deepEqual(s.rec().sent[1], { '': { sold: 2, total: 10 } });
  const r = await s.run(async () => OK);
  assert.equal(r.ok, true);
  assert.equal(s.calls.length, 2, 'the quantity write (total 11 = 9 + 2 sold at send) took effect; it is not sent again');
  // 已经是想要的状态（卖出后可售正好等于目标）：不用发
  const n = setup(reviseRec({ quantity: 8 }, d), [single({ quantity_available: 8, quantity_sold: 2 })]);
  assert.equal((await n.run(async () => OK)).ok, true);
  assert.equal(n.calls.length, 0);
});

test('applyChange: retrying a subset keeps the baseline of rows that already took effect', async () => {
  const d = multi();
  const rec = reviseRec({ variations: { update: [{ sku: 'M-S', quantity: 9 }, { sku: 'M-L', quantity: 6 }] } }, d);
  const itemsAfter = (s, l) => multi({ variations: VARS([{ ...VARS().items[0], ...s }, { ...VARS().items[1], ...l }]) });
  // 第一次发送：结果不确定；其实 M-S 生效了（总数 5→9），M-L 没生效
  const firstSeen = itemsAfter({ quantity_available: 9, quantity_sold: 0 }, {});
  // 对账重发 M-L 又不确定；之后 M-S 卖出 1 件
  const thenSold = itemsAfter({ quantity_available: 8, quantity_sold: 1 }, { quantity_available: 6, quantity_sold: 2 });
  const s = setup(rec, [d, firstSeen, thenSold]);
  await assert.rejects(s.run(UNKNOWN));
  await assert.rejects(s.run(UNKNOWN));
  assert.equal(s.calls[1].body, '<InventoryStatus><ItemID>111111111111</ItemID><SKU>M-L</SKU><Quantity>6</Quantity></InventoryStatus>', 'only the row that did not take effect is resent');
  const r = await s.run(async () => OK);
  assert.equal(r.ok, true);
  assert.equal(s.calls.length, 2, 'M-S still counts as applied after its sale; M-L (total 8 = 6 + 2) too');
});

test('applyChange: a row already at its target is given a baseline, so later sales do not trigger a resend', async () => {
  const d = multi();
  const rec = reviseRec({ variations: { update: [{ sku: 'M-S', quantity: 4 }, { sku: 'M-L', quantity: 6 }] } }, d);
  const its = (s, l) => multi({ variations: VARS([{ ...VARS().items[0], ...s }, { ...VARS().items[1], ...l }]) });
  // M-S 卖出 1 件后正好是目标 4（总数 5 不变）→ 不用发；M-L 要发，结果不确定
  const atTarget = its({ quantity_available: 4, quantity_sold: 1 }, {});
  // 之后 M-S 又卖 1 件；M-L 其实没生效
  const later = its({ quantity_available: 3, quantity_sold: 2 }, {});
  const s = setup(rec, [atTarget, later]);
  await assert.rejects(s.run(UNKNOWN));
  assert.equal(s.calls[0].body, '<InventoryStatus><ItemID>111111111111</ItemID><SKU>M-L</SKU><Quantity>6</Quantity></InventoryStatus>');
  assert.deepEqual(s.rec().sent[0]['M-S'], { sold: 1, total: 5 });
  await s.run(async () => OK);
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1].body, s.calls[0].body, 'only M-L is resent; M-S is not restocked');
});

test('applyChange recovery: a variation deletion is not resent after the removed SKU was restocked', async () => {
  const d = multi();
  const rec = reviseRec({ variations: { remove: ['M-S'] } }, d);
  const restocked = multi({ variations: VARS([{ ...VARS().items[0], quantity_available: 100 }, VARS().items[1]]) });
  const s = setup(rec, [d, restocked]);
  await assert.rejects(s.run(UNKNOWN));
  await assert.rejects(s.run(async () => OK), /既不是改前也不是改后/);
  assert.equal(s.calls.length, 1);
});

test('preview cleanup keeps partially applied change records', () => {
  let t = NOW;
  const store = createPreviewStore({ dir: mkdtempSync(join(tmpdir(), 'ebay-clean-')), now: () => t });
  store.save({ id: '1111111111111111', created_at: new Date(t).toISOString(), status: 'partial', kind: 'revise' });
  t += 8 * 24 * 3600_000;
  store.save({ id: '2222222222222222', created_at: new Date(t).toISOString(), status: 'ready' });
  assert.equal(store.load('1111111111111111').status, 'partial');
});

test('snapshot: deleting a variation that was restocked elsewhere is refused; images must match exactly', () => {
  const d = multi();
  const p = planRevise({ variations: { remove: ['M-S'] } }, d, { now: NOW });
  const snap = reviseSnapshot(p.intent, d);
  assert.deepEqual(staleFields(snap, multi({ variations: VARS([{ ...VARS().items[0], quantity_available: 100 }, VARS().items[1]]) })), ['stock']);
  const pi = planRevise({ images: ['/abs/new.jpg'] }, single(), { now: NOW });
  const snapImg = reviseSnapshot(pi.intent, single(), new Map([['/abs/new.jpg', 'https://i.ebayimg.com/00/s/x/z/NEWID/$_1.JPG?set_id=1']]));
  assert.deepEqual(snapImg.images.after, ['NEWID']);
});
