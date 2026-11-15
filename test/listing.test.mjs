import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { authorizeUrl, readRedirect } from '../lib/auth-flow.mjs';
import { describe, imageMime, parseErrors, parseFees, TokenRejectedError, tradingCall, uploadImage } from '../lib/ebay-api.mjs';
import {
  allImages, applyDefaults, buildItemXml, createImageUploader, createPreviewStore, descriptionHtml, duplicateItemId, isImageBytes, ListingError, listingSummary,
  normalizeListing, parseItemDefaults, pickDefaults, publishPreview, readImageFile,
} from '../lib/listing.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'ebay-listing-'));
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 2)]);

const base = (extra = {}) => ({
  title: 'Miniature Camouflage Net 1/35 Diorama',
  category_id: '262323',
  description: 'Line one\nline two\n\nSecond paragraph & more',
  images: ['/abs/main.jpg', 'https://example.com/b.jpg'],
  aspects: { Brand: 'Unbranded', Type: ['Diorama'] },
  price: 3.99,
  quantity: 10,
  ...extra,
});

const DEFAULTS = {
  policies: {
    fulfillment: [{ id: '111', name: 'Ship from China' }],
    return: [{ id: '222', name: '30-day returns' }],
    payment: [{ id: '333', name: 'Immediate pay' }],
  },
  defaults: { country: 'CN', location: 'Shenzhen, Guangdong', postal_code: null, fulfillment_policy_id: '111', return_policy_id: '222', payment_policy_id: '333' },
};

test('normalizeListing: single-SKU listing, defaults and plain-text description', () => {
  const l = normalizeListing(base());
  assert.equal(l.conditionId, 1000);
  assert.equal(l.price, 3.99);
  assert.equal(l.quantity, 10);
  assert.deepEqual(l.aspects, [{ name: 'Brand', values: ['Unbranded'] }, { name: 'Type', values: ['Diorama'] }]);
  assert.equal(l.description, '<p>Line one<br>line two</p>\n<p>Second paragraph &amp; more</p>');
  assert.deepEqual(l.images.map((i) => i.kind), ['file', 'url']);
  assert.equal(descriptionHtml('<p>already html</p>'), '<p>already html</p>');
});

test('normalizeListing rejects bad input', () => {
  const bad = (extra, re) => assert.throws(() => normalizeListing(base(extra)), (e) => e instanceof ListingError && re.test(e.message));
  bad({ title: 'x'.repeat(81) }, /最多 80/);
  bad({ images: ['relative/a.jpg'] }, /绝对路径/);
  bad({ images: ['http://example.com/a.jpg'] }, /https/);
  bad({ images: Array(25).fill('/a.jpg') }, /最多 24/);
  bad({ images: [] }, /至少一张/);
  bad({ price: 0 }, /大于 0/);
  bad({ price: 1.234 }, /两位小数/);
  bad({ quantity: 0 }, /不小于 1/);
  bad({ category_id: 'abc' }, /叶子类目/);
  bad({ condition_id: 12 }, /condition_id/);
  bad({ aspects: { Brand: 'A', brand: 'B' } }, /重复/);
  bad({ aspects: { Brand: 'x'.repeat(66) } }, /最多 65/);
  bad({ policies: { fulfillment_policy_id: 'abc' } }, /数字政策/);
  bad({ policies: { shipping: '1' } }, /未知字段/);
  bad({ location: { country: 'china' } }, /两位国家代码/);
});

const variations = (extra = {}) => ({
  specifics: ['Size', 'Color'],
  picture_by: 'Color',
  items: [
    { sku: 'A-1', price: 3.99, quantity: 5, values: { Size: '10x15cm', Color: 'MC Camo' }, image: '/abs/mc.jpg' },
    { sku: 'A-2', price: 4.99, quantity: 5, values: { Size: '15x20cm', Color: 'MC Camo' } },
    { sku: 'A-3', price: 3.99, quantity: 0, values: { size: '10x15cm', color: 'Desert' }, image: '/abs/desert.jpg' },
  ],
  ...extra,
});

test('normalizeListing: variations are validated', () => {
  const l = normalizeListing(base({ price: undefined, quantity: undefined, variations: variations() }));
  assert.equal(l.variations.items.length, 3);
  assert.deepEqual(l.variations.items[2].values, { Size: '10x15cm', Color: 'Desert' }, 'value keys are matched case-insensitively');
  const bad = (v, re, extra = {}) => assert.throws(() => normalizeListing(base({ price: undefined, quantity: undefined, variations: v, ...extra })), (e) => e instanceof ListingError && re.test(e.message));
  bad(variations(), /不要再传 price/, { price: 1 });
  bad(variations(), /不要再写在 aspects/, { aspects: { Color: 'Green' } });
  bad(variations({ items: [{ price: 1, quantity: 1, values: { Size: 'a' } }] }), /缺少规格「Color」/);
  bad(variations({ items: [{ price: 1, quantity: 1, values: { Size: 'a', Color: 'b', Extra: 'c' } }] }), /只能有 specifics/);
  bad(variations({ picture_by: undefined, items: [{ price: 1, quantity: 1, values: { Size: 'a', Color: 'b' } }, { price: 1, quantity: 1, values: { Size: 'A', Color: 'B' } }] }), /组合重复/);
  bad(variations({ picture_by: undefined, items: [{ sku: 'x', price: 1, quantity: 1, values: { Size: 'a', Color: 'b' } }, { sku: 'X', price: 1, quantity: 1, values: { Size: 'c', Color: 'b' } }] }), /sku 重复/);
  bad(variations({ items: [{ price: 1, quantity: 1, values: { Size: 'a', Color: 'b' } }] }), /每个「Color」都要有图/);
  bad(variations({ picture_by: undefined }), /picture_by/);
  bad(variations({ picture_by: 'Weight' }), /picture_by 应是 specifics/);
  bad(variations({ picture_by: undefined, items: [{ price: 1, quantity: 0, values: { Size: 'a', Color: 'b' } }] }), /大于 0/);
  bad(variations(), /SKU 写在/, { sku: 'TOP' });
});

test('applyDefaults fills policies and location from the store, and refuses unknown policies', () => {
  const l = applyDefaults(normalizeListing(base()), DEFAULTS);
  assert.deepEqual(l.policies, { fulfillment: '111', return: '222', payment: '333' });
  assert.deepEqual(l.location, { country: 'CN', location: 'Shenzhen, Guangdong', postalCode: null });
  assert.throws(() => applyDefaults(normalizeListing(base({ policies: { return_policy_id: '999' } })), DEFAULTS), /不是这家店的/);
  assert.throws(() => applyDefaults(normalizeListing(base()), { policies: DEFAULTS.policies, defaults: null }), /政策/);
  assert.throws(() => applyDefaults(normalizeListing(base({ policies: { fulfillment_policy_id: '111', return_policy_id: '222', payment_policy_id: '333' } })), { policies: DEFAULTS.policies, defaults: null }), /发货地/);
  const withZip = { ...DEFAULTS, defaults: { ...DEFAULTS.defaults, postal_code: '10001' } };
  const own = applyDefaults(normalizeListing(base({ location: { country: 'US', location: 'Los Angeles, CA' } })), withZip);
  assert.deepEqual(own.location, { country: 'US', location: 'Los Angeles, CA', postalCode: null }, 'a given location is not mixed with the default postcode');
  assert.throws(() => applyDefaults(normalizeListing(base({ location: { location: 'Yiwu' } })), withZip), /同时写 country/);
});

test('buildItemXml escapes text, keeps description in CDATA and adds policies and UUID', () => {
  const l = applyDefaults(normalizeListing(base({ title: 'Net <1/35> & "camo"', description: '<p>a]]>b</p>' })), DEFAULTS);
  const pictures = new Map([['/abs/main.jpg', 'https://i.ebayimg.com/1.jpg'], ['https://example.com/b.jpg', 'https://i.ebayimg.com/2.jpg']]);
  const xml = buildItemXml(l, { pictures, uuid: 'ABCDEF0123456789ABCDEF0123456789' });
  assert.match(xml, /<Title>Net &lt;1\/35&gt; &amp; &quot;camo&quot;<\/Title>/);
  assert.match(xml, /<Description><!\[CDATA\[<p>a]]]]><!\[CDATA\[>b<\/p>]]><\/Description>/);
  assert.match(xml, /<ShippingProfileID>111<\/ShippingProfileID>.*<ReturnProfileID>222<\/ReturnProfileID>.*<PaymentProfileID>333<\/PaymentProfileID>/);
  assert.match(xml, /<StartPrice>3\.99<\/StartPrice><Quantity>10<\/Quantity>/);
  assert.match(xml, /<PictureURL>https:\/\/i\.ebayimg\.com\/1\.jpg<\/PictureURL><PictureURL>https:\/\/i\.ebayimg\.com\/2\.jpg<\/PictureURL>/);
  assert.match(xml, /<UUID>ABCDEF0123456789ABCDEF0123456789<\/UUID>/);
  assert.match(xml, /<Country>CN<\/Country><Location>Shenzhen, Guangdong<\/Location>/);
  assert.doesNotMatch(xml, /<PostalCode>/);
  assert.throws(() => buildItemXml(l, { pictures: new Map(), uuid: 'X' }), /还没上传/);
});

test('buildItemXml: variations with picture sets per value', () => {
  const l = applyDefaults(normalizeListing(base({ price: undefined, quantity: undefined, variations: variations() })), DEFAULTS);
  const pictures = new Map(allImages(l).map((img, i) => [img.ref, `https://i.ebayimg.com/${i}.jpg`]));
  assert.equal(allImages(l).length, 4, 'main images + one per colour, deduplicated');
  const xml = buildItemXml(l, { pictures, uuid: 'U' });
  assert.match(xml, /<VariationSpecificsSet><NameValueList><Name>Size<\/Name><Value>10x15cm<\/Value><Value>15x20cm<\/Value><\/NameValueList><NameValueList><Name>Color<\/Name><Value>MC Camo<\/Value><Value>Desert<\/Value><\/NameValueList><\/VariationSpecificsSet>/);
  assert.match(xml, /<Variation><SKU>A-2<\/SKU><StartPrice>4\.99<\/StartPrice><Quantity>5<\/Quantity>/);
  assert.match(xml, /<Pictures><VariationSpecificName>Color<\/VariationSpecificName><VariationSpecificPictureSet><VariationSpecificValue>MC Camo<\/VariationSpecificValue><PictureURL>https:\/\/i\.ebayimg\.com\/2\.jpg<\/PictureURL><\/VariationSpecificPictureSet>/);
  assert.doesNotMatch(xml, /<Item>.*<StartPrice>[^<]*<\/StartPrice><Quantity>[^<]*<\/Quantity><UUID>/s, 'no item-level price for variation listings');
  const s = listingSummary(l, DEFAULTS);
  assert.equal(s.variations.length, 3);
  assert.equal(s.policies.return.name, '30-day returns');
});

test('parseFees and parseErrors read Trading API responses', () => {
  const xml = `<Fees><Fee><Name>AuctionLengthFee</Name><Fee currencyID="USD">0.0</Fee></Fee><Fee><Name>InsertionFee</Name><Fee currencyID="USD">0.35</Fee></Fee>
    <Fee><Name>ListingFee</Name><Fee currencyID="USD">0.35</Fee></Fee></Fees>`;
  assert.deepEqual(parseFees(xml), { total: 0.35, currency: 'USD', items: [{ name: 'InsertionFee', currency: 'USD', amount: 0.35 }] });
  const errs = parseErrors(`<Errors><ShortMessage>Dup</ShortMessage><LongMessage>Duplicate UUID used.</LongMessage><ErrorCode>488</ErrorCode><SeverityCode>Error</SeverityCode>
    <ErrorParameters ParamID="0"><Value>ABC</Value></ErrorParameters><ErrorParameters ParamID="1"><Value>123456789012</Value></ErrorParameters></Errors>
    <Errors><ShortMessage>W</ShortMessage><ErrorCode>21917091</ErrorCode><SeverityCode>Warning</SeverityCode></Errors>`);
  assert.equal(errs.length, 2);
  assert.equal(errs[1].severity, 'Warning');
  assert.equal(duplicateItemId(errs), '123456789012');
  assert.equal(duplicateItemId([{ code: '1', params: [] }]), null);
  assert.deepEqual(describe(errs.slice(0, 1)), ['[488] Duplicate UUID used.']);
});

const fakeFetch = (status, body) => async () => ({ status, ok: status < 400, text: async () => body, json: async () => JSON.parse(body) });

test('tradingCall: auth failures, network failures and warnings', async () => {
  await assert.rejects(tradingCall({ token: 't', call: 'GetUser', fetchImpl: fakeFetch(200, '<Ack>Failure</Ack><Errors><ErrorCode>931</ErrorCode><SeverityCode>Error</SeverityCode></Errors>') }), TokenRejectedError);
  await assert.rejects(tradingCall({ token: 't', call: 'GetUser', fetchImpl: fakeFetch(401, '') }), TokenRejectedError);
  await assert.rejects(tradingCall({ token: 't', call: 'AddFixedPriceItem', fetchImpl: async () => { throw new Error('socket hang up'); } }), (e) => e.unknownOutcome === true);
  await assert.rejects(tradingCall({ token: 't', call: 'AddFixedPriceItem', fetchImpl: fakeFetch(503, '') }), (e) => e.unknownOutcome === true);
  const r = await tradingCall({ token: 't', call: 'X', fetchImpl: fakeFetch(200, '<Ack>Warning</Ack><Errors><ErrorCode>1</ErrorCode><SeverityCode>Warning</SeverityCode><LongMessage>w</LongMessage></Errors>') });
  assert.equal(r.ack, 'Warning');
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 1);
});

test('uploadImage: files go to create_image_from_file as multipart, URLs to create_image_from_url', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, opts });
    return { status: 201, ok: true, json: async () => ({ imageUrl: 'https://i.ebayimg.com/x.jpg', expirationDate: '2026-12-15T02:32:27Z' }) };
  };
  const r = await uploadImage({ token: 'secret-token', ref: '/abs/a b.jpg', data: JPEG, filename: 'a b.jpg', fetchImpl });
  assert.deepEqual(r, { url: 'https://i.ebayimg.com/x.jpg', expiresAt: Date.parse('2026-12-15T02:32:27Z') });
  assert.match(seen[0].url, /\/commerce\/media\/v1_beta\/image\/create_image_from_file$/);
  assert.ok(seen[0].opts.body instanceof FormData);
  assert.equal(seen[0].opts.body.get('image').type, 'image/jpeg');
  assert.equal(seen[0].opts.headers.Authorization, 'Bearer secret-token');
  await uploadImage({ token: 't', ref: 'https://example.com/a.jpg', data: null, fetchImpl });
  assert.match(seen[1].url, /create_image_from_url$/);
  assert.deepEqual(JSON.parse(seen[1].opts.body), { imageUrl: 'https://example.com/a.jpg' });
  const fail = async () => ({ status: 400, ok: false, json: async () => ({ errors: [{ message: 'Image too small' }] }) });
  await assert.rejects(uploadImage({ token: 't', ref: '/a.jpg', data: JPEG, fetchImpl: fail }), /HTTP 400.*Image too small/);
  await assert.rejects(uploadImage({ token: 't', ref: '/a.jpg', data: JPEG, fetchImpl: async () => ({ status: 401, ok: false, json: async () => ({}) }) }), TokenRejectedError);
  assert.equal(imageMime(PNG), 'image/png');
});

test('images: only real image files are read and uploads are cached by content', async () => {
  const dir = tmp();
  const a = join(dir, 'a.jpg');
  const b = join(dir, 'b.png');
  const same = join(dir, 'same-as-a.jpg');
  const txt = join(dir, 'notes.jpg');
  writeFileSync(a, JPEG);
  writeFileSync(b, PNG);
  writeFileSync(same, JPEG);
  writeFileSync(txt, 'x'.repeat(300));
  assert.ok(isImageBytes(JPEG) && isImageBytes(PNG));
  assert.ok(isImageBytes(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')));
  assert.ok(!isImageBytes(Buffer.from('#!/bin/sh\necho hi')));
  await assert.rejects(readImageFile(txt), /不是图片文件/);
  await assert.rejects(readImageFile(join(dir, 'missing.jpg')), /找不到图片文件/);
  await assert.rejects(readImageFile(dir), /不是普通文件/);
  const big = join(dir, 'big.jpg');
  writeFileSync(big, Buffer.concat([JPEG, Buffer.alloc(12 * 1024 * 1024)]));
  await assert.rejects(readImageFile(big), /太大/);
  assert.deepEqual(await readImageFile(a), JPEG);
  let uploads = 0;
  let t = Date.parse('2026-11-15T00:00:00Z');
  const upload = async (img) => ({ url: `https://i.ebayimg.com/${++uploads}-${img.ref.split('/').pop()}`, expiresAt: t + 30 * 24 * 3600_000 });
  const uploadAll = createImageUploader({ dir, upload, now: () => t });
  const imgs = [a, b, same].map((ref) => ({ kind: 'file', ref }));
  const m1 = await uploadAll(imgs, { concurrency: 1 });
  assert.equal(uploads, 2, 'identical content is uploaded once');
  assert.equal(m1.get(same), m1.get(a));
  const m2 = await createImageUploader({ dir, upload, now: () => t })(imgs);
  assert.equal(uploads, 2, 'second run is served from the cache file');
  assert.equal(m2.get(b), m1.get(b));
  t += 29 * 24 * 3600_000;
  await createImageUploader({ dir, upload, now: () => t })(imgs);
  assert.equal(uploads, 4, 'images close to eBay expiry are uploaded again');
});

test('preview store: ids are validated, records expire after 24h, files are private', () => {
  let t = Date.parse('2026-11-15T00:00:00Z');
  const dir = tmp();
  const store = createPreviewStore({ dir, now: () => t });
  assert.throws(() => store.load('../etc/passwd'), /格式不对/);
  assert.throws(() => store.load('0123456789abcdef'), /找不到预检记录/);
  store.save({ id: '0123456789abcdef', created_at: new Date(t).toISOString(), status: 'ready' });
  assert.equal(store.update('0123456789abcdef', { status: 'sending' }).status, 'sending');
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'listing-previews', '0123456789abcdef.json')).mode & 0o777, 0o600);
  assert.equal(store.expired(store.load('0123456789abcdef')), false);
  t += 25 * 3600_000;
  assert.equal(store.expired(store.load('0123456789abcdef')), true);
});

test('preview cleanup keeps records whose publish outcome is unknown', () => {
  let t = Date.parse('2026-11-15T00:00:00Z');
  const dir = tmp();
  const store = createPreviewStore({ dir, now: () => t });
  store.save({ id: '1111111111111111', created_at: new Date(t).toISOString(), status: 'unknown' });
  store.save({ id: '2222222222222222', created_at: new Date(t).toISOString(), status: 'ready' });
  store.save({ id: '3333333333333333', created_at: new Date(t).toISOString(), status: 'sending' });
  t += 8 * 24 * 3600_000;
  store.save({ id: '4444444444444444', created_at: new Date(t).toISOString(), status: 'ready' });
  assert.equal(store.load('1111111111111111').status, 'unknown');
  assert.equal(store.load('3333333333333333').status, 'sending');
  assert.throws(() => store.load('2222222222222222'), /找不到预检记录/);
});

test('publishPreview: success, duplicate UUID, failure, unknown outcome, recovery after expiry, wrong store', async () => {
  let t = Date.parse('2026-11-15T00:00:00Z');
  const store = createPreviewStore({ dir: tmp(), now: () => t });
  const lock = (id, fn) => fn();
  const rec = (id) => store.save({ id, store_id: 'S', created_at: new Date(t).toISOString(), status: 'ready', item_xml: '<Item/>', summary: { title: 'x' } });
  const pub = (id, add, storeId = 'S') => publishPreview({ previews: store, id, storeId, add, lock, describe: (l) => l.map((e) => e.code) });

  rec('aaaaaaaaaaaaaaaa');
  let seenStatus;
  const ok = await pub('aaaaaaaaaaaaaaaa', async () => {
    seenStatus = store.load('aaaaaaaaaaaaaaaa').status;
    return { ack: 'Success', errors: [], warnings: [], xml: '<ItemID>110000000001</ItemID>' };
  });
  assert.equal(seenStatus, 'sending', 'state is persisted before the request is sent');
  assert.equal(ok.item_id, '110000000001');
  assert.equal(store.load('aaaaaaaaaaaaaaaa').status, 'published');
  let calls = 0;
  const again = await pub('aaaaaaaaaaaaaaaa', async () => { calls++; return {}; });
  assert.equal(calls, 0);
  assert.equal(again.already_published, true);

  rec('bbbbbbbbbbbbbbbb');
  const dup = await pub('bbbbbbbbbbbbbbbb', async () => ({ ack: 'Failure', errors: [{ code: '488', params: ['X', '110000000002'] }], warnings: [] }));
  assert.deepEqual([dup.item_id, dup.already_published], ['110000000002', true]);

  rec('cccccccccccccccc');
  const failed = await pub('cccccccccccccccc', async () => ({ ack: 'Failure', errors: [{ code: '21919301', params: [] }], warnings: [] }));
  assert.equal(failed.ok, false);
  assert.equal(store.load('cccccccccccccccc').status, 'failed');

  rec('dddddddddddddddd');
  await assert.rejects(pub('dddddddddddddddd', async () => { throw Object.assign(new Error('timeout'), { unknownOutcome: true }); }), /不确定是否已刊登/);
  assert.equal(store.load('dddddddddddddddd').status, 'unknown');
  t += 30 * 3600_000;
  const recovered = await pub('dddddddddddddddd', async () => ({ ack: 'Failure', errors: [{ code: '488', params: ['110000000003'] }], warnings: [] }));
  assert.equal(recovered.item_id, '110000000003', 'an unknown outcome can be retried with the same UUID even after 24h');
  await assert.rejects(pub('cccccccccccccccc', async () => ({})), /超过 24 小时/, 'a definitive failure needs a new preview after 24h');

  // 对账重发时 eBay 报错：保持 unknown，不能当成没刊登
  rec('ffffffffffffffff');
  await assert.rejects(pub('ffffffffffffffff', async () => { throw Object.assign(new Error('timeout'), { unknownOutcome: true }); }), /不确定/);
  const retry = await pub('ffffffffffffffff', async () => ({ ack: 'Failure', errors: [{ code: '10007', params: [] }], warnings: [] }));
  assert.deepEqual([retry.ok, retry.still_unknown], [false, true]);
  assert.equal(store.load('ffffffffffffffff').status, 'unknown');

  rec('eeeeeeeeeeeeeeee');
  await assert.rejects(pub('eeeeeeeeeeeeeeee', async () => { throw new Error('token rejected'); }), /token rejected/);
  assert.equal(store.load('eeeeeeeeeeeeeeee').status, 'ready', 'a request that was not sent leaves the record as it was');
  await assert.rejects(pub('eeeeeeeeeeeeeeee', async () => ({}), 'OTHER'), /不是这家店的/);
});

test('parseItemDefaults reads the item, not the seller block; pickDefaults takes the most common combination', () => {
  const xml = `<Item><Seller><Site>HongKong</Site></Seller><Site>US</Site><Country>CN</Country><Location>Shenzhen</Location><PrimaryCategory><CategoryID>262323</CategoryID></PrimaryCategory>
    <SellerProfiles><SellerShippingProfile><ShippingProfileID>1</ShippingProfileID></SellerShippingProfile><SellerReturnProfile><ReturnProfileID>2</ReturnProfileID></SellerReturnProfile>
    <SellerPaymentProfile><PaymentProfileID>3</PaymentProfileID></SellerPaymentProfile></SellerProfiles></Item>`;
  const d = parseItemDefaults(xml);
  assert.equal(d.site, 'US');
  assert.deepEqual([d.fulfillment_policy_id, d.return_policy_id, d.payment_policy_id, d.category_id], ['1', '2', '3', '262323']);
  const other = { ...d, return_policy_id: '9' };
  const best = pickDefaults([other, d, d]);
  assert.equal(best.return_policy_id, '2');
  assert.equal(best.from_listings, 2);
  assert.equal(pickDefaults([]), null);
});

test('authorizeUrl and readRedirect', () => {
  const url = new URL(authorizeUrl({ app_id: 'app', ru_name: 'ru' }, 'st8'));
  assert.equal(url.searchParams.get('redirect_uri'), 'ru');
  assert.equal(url.searchParams.get('state'), 'st8');
  assert.match(url.searchParams.get('scope'), /sell\.inventory(\s|$)/);
  assert.throws(() => authorizeUrl({ app_id: 'app' }, 's'), /ru_name/);
  const page = 'https://auth2.ebay.com/oauth2/ThirdPartyAuthSucessFailure';
  assert.deepEqual(readRedirect(`${page}?isAuthSuccessful=true&state=st8&code=v%5E1.1%23abc&expires_in=299`, 'st8'), { status: 'ok', code: 'v^1.1#abc' });
  assert.equal(readRedirect(`${page}?isAuthSuccessful=true&state=other&code=x`, 'st8').status, 'error');
  assert.equal(readRedirect(`${page}?isAuthSuccessful=false`, 'st8').status, 'declined');
  assert.equal(readRedirect('https://evil.example.com/?code=x&state=st8', 'st8').status, 'pending');
  assert.equal(readRedirect('about:blank', 'st8').status, 'pending');
});
