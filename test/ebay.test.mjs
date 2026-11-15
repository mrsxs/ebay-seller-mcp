import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CooldownError, createCooldown, isVerifyMessage } from '../lib/cooldown.mjs';
import { createTerapeakApi, EbayError } from '../lib/ebay.mjs';
import { parseCard, parseResults, readSearchPage, searchUrl } from '../lib/search.mjs';
import { UNIFIED_SEARCH } from '../lib/terapeak-queries.mjs';
import {
  activeSearchRequest, categoryRequest, laDate, monthly, parseActiveSearch, parseCategoryTree, parseSoldSearch, parseTrend, researchRange, soldSearchRequest, trendRequest,
} from '../lib/terapeak.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 2026-11-14 07:10 UTC = 洛杉矶 2026-11-13 23:10（冬令时）
const NOW = Date.UTC(2026, 10, 14, 7, 10);

test('日期：和 Terapeak 页面一样按洛杉矶时间，截止今天 23:59:59，往前 N 天的 0 点开始（跨夏令时）', () => {
  assert.equal(laDate(NOW), '2026-11-13');
  assert.deepEqual(researchRange(30, NOW), { days: 30, start: '2026-10-14', end: '2026-11-13', startDateTime: '2026-10-14T07:00:00.000Z', endDateTime: '2026-11-14T07:59:59.000Z' });
  assert.equal(researchRange(90, NOW).startDateTime, '2026-08-15T07:00:00.000Z');
  assert.equal(researchRange(7, Date.UTC(2026, 6, 1, 12)).endDateTime, '2026-07-02T06:59:59.000Z');
  assert.throws(() => researchRange(10, NOW), /days 只能是/);
});

test('请求参数：查询原样发送；已售带类目和分页；在售用游标翻页；走势按周', () => {
  const range = researchRange(90, NOW);
  const sold = soldSearchRequest({ keyword: 'model trees', range, categoryId: '220', offset: 20, limit: 20 });
  assert.equal(sold.query, UNIFIED_SEARCH);
  assert.match(UNIFIED_SEARCH, /diagnostic @include/); // 网关要求原样，不能删字段
  assert.deepEqual(sold.variables.terapeakResearchInput.categoryIds, ['220']);
  assert.deepEqual(sold.variables.terapeakListingInput, { pagination: { limit: 20, offset: 20 } });
  assert.equal(sold.variables.includeSoldSearchResults, true);
  assert.equal(sold.variables.includeActiveSearch, false);
  assert.deepEqual(sold.extra.moduleContext, ['aggregates', 'searchResults', 'resultsHeader']);
  const active = activeSearchRequest({ keyword: 'model trees', page: 2, now: NOW });
  assert.equal(Buffer.from(active.variables.activeSearchInput.pagination.pageCursor, 'base64').toString(), 'limit=50,page=1');
  assert.equal(active.variables.includeActiveSearchResults, true);
  assert.equal(trendRequest({ keyword: 'x', range, interval: 'week' }).variables.input.groupBy.intervalUnit, 'WEEK');
  assert.equal(trendRequest({ keyword: 'x', range, interval: 'month' }).variables.input.groupBy.intervalUnit, 'DAY'); // 按月接口不支持，本地汇总
  assert.equal(categoryRequest({ keyword: 'x', range }).variables.categoryInput.categoryId, '0');
});

test('解析：已售汇总（百分数转比例、售罄率）、成交 listing、在售、走势、类目', () => {
  const sold = parseSoldSearch({
    terapeakResearch: { summary: {
      soldPrice: { avgPrice: { amount: '28.35' }, percentage: '-1.0800', priorAvgPrice: { amount: '28.66' } },
      priceRange: { minPrice: { amount: '0.19' }, maxPrice: { amount: '300.00' } }, avgShipping: { amount: '8.12' }, freeShippingPercent: '33.24',
      itemSoldCount: '3492', unsoldListingsCount: '9795', soldListingsCount: '1818', sellerCount: '962', totalRevenue: { amount: '98994.08' },
    } },
    soldSearchResults: { listingMetrics: { nextPageAvailable: true, listings: [{
      bidCount: '0', buyingFormat: 'FIXED_PRICE', itemSoldCount: '78', lastSoldDateTime: '2026-11-13T15:43:00Z',
      listing: { id: '100000000001', title: 'Fictional Pine Trees', image: { url: 'https://x' } }, avgSoldPrice: { amount: '19.52' }, avgShipping: { amount: '2.44' },
      totalSales: { amount: '1522.85' }, freeShippingPercent: '0.00',
    }] } },
  });
  assert.deepEqual(sold.summary, {
    avg_sold_price: 28.35, avg_sold_price_change: -0.0108, prior_avg_sold_price: 28.66, min_sold_price: 0.19, max_sold_price: 300, avg_shipping: 8.12,
    free_shipping_share: 0.3324, items_sold: 3492, total_sales: 98994.08, sold_listings: 1818, unsold_listings: 9795, sell_through: 0.1565, sellers: 962,
  });
  assert.deepEqual(sold.listings[0], {
    listing_id: '100000000001', title: 'Fictional Pine Trees', url: 'https://www.ebay.com/itm/100000000001', format: '一口价', bids: 0, items_sold: 78,
    avg_sold_price: 19.52, avg_shipping: 2.44, total_sales: 1522.85, free_shipping_share: 0, last_sold: '2026-11-13',
  });
  assert.equal(sold.next_page, true);
  assert.deepEqual(parseSoldSearch({}), { summary: null, listings: [], next_page: false });

  const active = parseActiveSearch({
    activeTabAggregates: { summary: { listingCount: '14575', averageListingPrice: { amount: '55.13621269' }, averageShippingPrice: { amount: '39.69' }, freeShippingPercentage: '62.85', promotedListingsPercentage: '64.22' } },
    activeSearchResults: {
      searchListingsMetrics: { itemsPriceRange: { minPrice: { converted: { value: 0.99 } }, maxPrice: { converted: { value: 380 } } } },
      diagnostic: [{ key: 'internal', message: 'buyer_id=SECRET' }],
      paginationOutput: { nextCursor: 'abc' },
      listings: [{ listingId: '100000000002', searchIndexData: { title: 'Fictional Tree Kit', currentPrice: { amount: '12.5' }, fullCalculatedShipping: { shipCost: { amount: '0' } }, listingFormat: 'AUCTION', bidderCount: 3, watchCount: 7, isPromotedListing: true, startTime: '2026-10-01T00:00:00Z' } }],
    },
  });
  assert.deepEqual(active.summary, { listings: 14575, avg_price: 55.14, avg_shipping: 39.69, free_shipping_share: 0.6285, promoted_share: 0.6422, min_price: 0.99, max_price: 380 });
  assert.deepEqual(active.listings[0], { listing_id: '100000000002', title: 'Fictional Tree Kit', url: 'https://www.ebay.com/itm/100000000002', price: 12.5, shipping: 0, format: '拍卖', bids: 3, watchers: 7, promoted: true, listed_at: '2026-09-30' }); // 2026-10-01T00:00Z 在洛杉矶还是 9 月 30 日
  assert.equal(JSON.stringify(active).includes('SECRET'), false);

  assert.deepEqual(parseTrend({ terapeakResearch: { salesTrends: { performanceMetrics: [{ avgPrice: { amount: '21.97' }, itemSoldCount: '50', soldDateTime: '2026-08-15T07:00:00Z' }] } } }),
    [{ date: '2026-08-15', avg_sold_price: 21.97, items_sold: 50 }]);

  assert.deepEqual(monthly([
    { date: '2026-10-30', avg_sold_price: 10, items_sold: 1 }, { date: '2026-10-31', avg_sold_price: 20, items_sold: 3 },
    { date: '2026-11-01', avg_sold_price: null, items_sold: 0 }, { date: '2026-11-02', avg_sold_price: 5, items_sold: 2 },
  ]), [{ date: '2026-10-01', avg_sold_price: 17.5, items_sold: 4 }, { date: '2026-11-01', avg_sold_price: 5, items_sold: 2 }]);
  // 用原始精度加权，只在最后舍入一次
  const rawDays = parseTrend({ terapeakResearch: { salesTrends: { performanceMetrics: [
    { avgPrice: { amount: '1.004' }, itemSoldCount: '10', soldDateTime: '2026-10-05T07:00:00Z' }, { avgPrice: { amount: '1.014' }, itemSoldCount: '5', soldDateTime: '2026-10-06T07:00:00Z' }] } } }, { raw: true });
  assert.equal(monthly(rawDays)[0].avg_sold_price, 1.01);

  const tree = parseCategoryTree({ category: { category: {
    categoryId: '220', name: 'Toys & Hobbies', leafCategory: false, terapeakSoldCount: '2789',
    ancestors: [{ categoryId: '0', name: 'Root' }],
    children: [{ categoryId: '1', name: 'A', terapeakSoldCount: '5' }, { categoryId: '2', name: 'B', terapeakSoldCount: '0' }, { categoryId: '3', name: 'C', terapeakSoldCount: '90' }],
  } } });
  assert.equal(tree.path, 'Toys & Hobbies');
  assert.deepEqual(tree.children.map((c) => c.id), ['3', '1']);
  assert.equal(parseCategoryTree({ category: { category: null } }), null);
});

test('Terapeak 请求：跳转 / 限流 / 检查页 → 安全验证；401 → 登录；GraphQL 错误 → EbayError', async () => {
  const api = (r) => createTerapeakApi({}, async () => r);
  const verify = (e) => e instanceof EbayError && isVerifyMessage(e.message);
  await assert.rejects(api({ redirected: true, status: 0, text: '' })('q', {}), verify);
  await assert.rejects(api({ status: 429, text: '' })('q', {}), verify);
  await assert.rejects(api({ status: 403, text: '<html><title>Access Denied</title></html>' })('q', {}), verify);
  await assert.rejects(api({ status: 200, url: 'https://www.ebay.com/splashui/challenge?x', text: '<html>Pardon Our Interruption</html>' })('q', {}), verify);
  await assert.rejects(api({ status: 401, text: '' })('q', {}), /未登录或登录已失效/);
  await assert.rejects(api({ status: 502, text: '{"error":"EMPTY_RESPONSE","message":"No response"}' })('q', {}), /Terapeak 查询失败（HTTP 502）/);
  // 服务端错误消息不原样输出（可能带内部 ID）
  await assert.rejects(api({ status: 200, text: '{"errors":[{"message":"bad field buyer_id=SECRET","extensions":{"code":"BAD_USER_INPUT"}}],"data":null}' })('q', {}),
    (e) => e instanceof EbayError && /GraphQL 错误 BAD_USER_INPUT/.test(e.message) && !e.message.includes('SECRET'));
  // 带部分数据的认证错误也要失败
  await assert.rejects(api({ status: 200, text: '{"errors":[{"message":"authentication required"}],"data":{"x":1}}' })('q', {}), /未登录或登录已失效/);
  await assert.rejects(api({ status: 200, text: '{"errors":[{"message":"Too many requests"}],"data":{"x":1}}' })('q', {}), verify);
  // 缺少必需的分支：当接口异常，不当空结果
  await assert.rejects(api({ status: 200, text: '{"data":{"terapeakResearch":null}}' })('q', {}, {}, { require: 'terapeakResearch.summary' }), /数据不完整/);
  // 非认证、不落在要用分支上的错误：照常返回
  assert.deepEqual(await api({ status: 200, text: '{"errors":[{"message":"minor","path":["other"]}],"data":{"terapeakResearch":{"summary":{}}}}' })('q', {}, {}, { require: 'terapeakResearch.summary', consumes: ['terapeakResearch'] }), { terapeakResearch: { summary: {} } });
  // 部分失败：错误落在要用的分支下 → 整次失败；只落在 diagnostic 上 → 忽略；没有 path → 保守失败
  const sold = { require: 'terapeakResearch.summary', consumes: ['terapeakResearch', 'soldSearchResults'] };
  const body = (errors) => JSON.stringify({ errors, data: { terapeakResearch: { summary: {} }, soldSearchResults: { listingMetrics: { listings: [], nextPageAvailable: null } } } });
  await assert.rejects(api({ status: 200, text: body([{ message: 'x', path: ['soldSearchResults', 'listingMetrics', 'nextPageAvailable'] }]) })('q', {}, {}, sold), /GraphQL 错误/);
  await assert.rejects(api({ status: 200, text: body([{ message: 'x' }]) })('q', {}, {}, sold), /GraphQL 错误/);
  assert.ok(await api({ status: 200, text: body([{ message: 'x', path: ['activeSearchResults', 'diagnostic', 0] }]) })('q', {}, {}, sold));
  assert.ok(await api({ status: 200, text: body([{ message: 'x', path: ['somethingElse'] }]) })('q', {}, {}, sold));
  await assert.rejects(api({ status: 200, text: JSON.stringify({ errors: [{ message: 'x', path: ['category', 'category', 'children', 0, 'terapeakSoldCount'] }], data: { category: { category: { children: [] } } } }) })('q', {}, {}, { require: 'category', consumes: ['category'] }), /GraphQL 错误/);
  assert.deepEqual(await api({ status: 200, text: '{"data":{"x":1}}' })('q', {}), { x: 1 });
  let sent;
  await createTerapeakApi({}, async (_c, req) => { sent = req; return { status: 200, text: '{"data":{"x":1}}' }; })('Q', { a: 1 }, { queryName: 'N' });
  assert.deepEqual(JSON.parse(sent.body), { query: 'Q', variables: { a: 1 }, queryName: 'N' });
  assert.equal(sent.method, 'POST');
});

test('前台搜索：地址参数；卡片分类（价格、议价、竞拍、运费、发货地、已售、广告位）', () => {
  const u = new URL(searchUrl({ keyword: 'model trees', sort: 'price_low', condition: 'new', buyItNow: true, priceMin: 5, priceMax: 30, page: 2 }));
  assert.deepEqual(Object.fromEntries(u.searchParams), { _nkw: 'model trees', _sacat: '0', _ipg: '60', _sop: '15', _pgn: '2', LH_ItemCondition: '1000', LH_BIN: '1', _udlo: '5', _udhi: '30' });

  const a = parseCard({ listing_id: '100000000003', pos: 3, title: 'Fictional Trees Opens in a new window or tab', subtitle: 'Brand New', price: '$11.89',
    price_parts: [{ t: '$11.89', struck: false }], rows: ['$11.89', 'or Best Offer', '+$2.29 delivery', 'Located in China', '57 sold'] });
  assert.deepEqual(a, { position: 3, listing_id: '100000000003', title: 'Fictional Trees', url: 'https://www.ebay.com/itm/100000000003', condition: 'Brand New',
    price: 11.89, price_max: null, was_price: null, price_text: '$11.89', format: '一口价', best_offer: true, bids: null, shipping: 2.29, location: 'China', sold: 57, sold_text: '57 sold' });
  // 价格区间、划线原价不进备注
  const r = parseCard({ listing_id: '100000000006', title: 'x', price: '$11.99', price_parts: [{ t: '$11.99' }, { t: 'to' }, { t: '$14.99' }], rows: ['$11.99 to $14.99', '85+ sold'] });
  assert.deepEqual([r.price, r.price_max, r.was_price, r.sold, 'notes' in r], [11.99, 14.99, null, 85, false]);
  const w = parseCard({ listing_id: '100000000007', title: 'x', price: '$10.48', price_parts: [{ t: '$10.48' }, { t: '$11.65', struck: true }], rows: ['$10.48$11.65'] });
  assert.deepEqual([w.price, w.was_price, 'notes' in w], [10.48, 11.65, false]);
  const b = parseCard({ listing_id: '100000000004', pos: 4, title: 'New ListingFictional Auction', subtitle: 'Pre-Owned', price: '$1,050.00',
    rows: ['$1,050.00', '12 bids', 'Free delivery', '1.2K+ sold', 'Save up to 15% when you buy more'], footer: '' });
  assert.deepEqual([b.title, b.price, b.format, b.bids, b.shipping, b.sold, 'sponsored' in b, b.notes], ['Fictional Auction', 1050, '拍卖', 12, 0, 1200, false, ['Save up to 15% when you buy more']]);
  assert.equal(parseResults({ cards: [{ listing_id: '123456', title: 'Shop on eBay' }, { listing_id: '', title: 'x' }, { listing_id: '100000000005', title: 'Real' }] }).length, 1);
  assert.doesNotMatch(readSearchPage.toString(), /setTimeout|import\(|fetch\(/);
});

test('冷却：只认明确的 eBay 安全验证；写在数据目录，其他进程也能看到', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ebm-cd-'));
  try {
    let t = 0;
    const a = createCooldown({ dir, now: () => t });
    const b = createCooldown({ dir, now: () => t });
    const shop = { storeId: '1', name: '美国站' };
    a.note(shop, new Error('eBay 未登录或登录已失效'));
    b.check(shop);
    a.note(shop, new EbayError('触发了 eBay 安全验证（浏览器检查 / 验证码 / 请求太频繁）'));
    assert.throws(() => b.check(shop), CooldownError);
    t = 10 * 60_000;
    b.check(shop);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP：握手、工具列表、参数错误在连浏览器之前返回', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ebm-mcp-'));
  const env = { ...process.env, EBAY_DATA_DIR: dataDir, EBAY_API_KEYS: join(dataDir, 'api-keys.json'), EBAY_SHOPS: JSON.stringify([{ name: '测试店', store_id: '12345678901234' }]) };
  const child = spawn(process.execPath, [join(ROOT, 'bin', 'ebay-seller-mcp.mjs')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    let buf = '';
    const waiting = new Map();
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        waiting.get(msg.id)?.(msg);
      }
    });
    let n = 0;
    const rpc = (method, params) => new Promise((resolve) => {
      const id = ++n;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const text = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result.content[0].text;
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'ebay-seller-mcp');
    const tools = (await rpc('tools/list', {})).result.tools;
    assert.deepEqual(tools.map((t) => t.name), ['ebay_shops', 'ebay_research', 'ebay_research_trend', 'ebay_research_categories', 'ebay_research_active', 'ebay_search',
      'ebay_orders', 'ebay_traffic', 'ebay_seller_standards', 'ebay_listings', 'ebay_listing_get', 'ebay_listing_defaults', 'ebay_category_suggest', 'ebay_category_aspects', 'ebay_listing_preview', 'ebay_listing_publish',
      'ebay_listing_revise_preview', 'ebay_listing_end_preview', 'ebay_listing_relist_preview', 'ebay_listing_apply']);
    // 只有预检（上传图片 / 存修改记录）、发布和执行修改不是只读
    assert.deepEqual(tools.filter((t) => t.annotations.readOnlyHint !== true).map((t) => t.name),
      ['ebay_listing_preview', 'ebay_listing_publish', 'ebay_listing_revise_preview', 'ebay_listing_end_preview', 'ebay_listing_relist_preview', 'ebay_listing_apply']);
    assert.match(await text('ebay_listing_apply', { change_id: '0123456789abcdef', confirm: false }), /confirm 要传 true/);
    assert.match(await text('ebay_listing_get', { item_id: 'abc' }), /item_id 应是 eBay 的 ItemID/);
    assert.match(await text('ebay_listing_publish', { preview_id: '0123456789abcdef', confirm: false }), /confirm 要传 true/);
    assert.match(await text('ebay_listing_publish', { preview_id: '../x', confirm: true }), /格式不对/);
    assert.match(await text('ebay_listing_preview', { title: 'x', category_id: '1', description: 'd', images: 'not-array' }), /images 必须是数组/);
    assert.match(await text('ebay_category_suggest', { query: '  ' }), /query 不能为空/);
    assert.deepEqual(JSON.parse(await text('ebay_shops', {})).shops, [{ name: '测试店', store_id: '12345678901234', default: true }]);
    assert.match(await text('ebay_research', {}), /缺少参数：keyword/);
    assert.match(await text('ebay_research', { keyword: '   ' }), /keyword 不能为空/);
    assert.match(await text('ebay_research', { keyword: 'x', days: 10 }), /days 只能是/);
    assert.match(await text('ebay_research', { keyword: 'x', category_id: '1&a=b' }), /category_id 应是/);
    assert.match(await text('ebay_search', { keyword: 'x', price_min: 10, price_max: 5 }), /price_min 不能大于 price_max/);
    assert.match(await text('ebay_search', { keyword: 'x', price_min: '5' }), /price_min 必须是数字/);
    assert.match(await text('ebay_search', { keyword: 'x', page: 4 }), /page 不能大于 3/);
    assert.match(await text('ebay_research', { keyword: 'x', shop: '别的店' }), /没有找到店铺「别的店」/);
    assert.match(await text('ebay_shops', { constructor: 1 }), /未知参数：constructor/);
    assert.equal((await rpc('nope/method', {})).error.code, -32601);
  } finally {
    child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('页面状态：验证码立刻停、检查页等一会儿（卡住才算验证）、登录页两次确认、标题也认检查页', async () => {
  const { classifyPage, waitReady } = await import('../lib/browser.mjs');
  assert.equal(classifyPage({ href: 'https://www.ebay.com/splashui/captcha?x', ready: false }), 'captcha');
  assert.equal(classifyPage({ href: 'https://www.ebay.com/splashui/challenge?x' }), 'challenge');
  assert.equal(classifyPage({ href: 'https://www.ebay.com/sch/i.html', title: 'Pardon Our Interruption...', ready: true }), 'challenge');
  assert.equal(classifyPage({ href: 'https://signin.ebay.com/ws/x' }), 'login');
  assert.equal(classifyPage({ href: 'https://www.ebay.com/sch/i.html', title: 'x', ready: true }), 'ready');

  const site = { readyHost: 'www.ebay.com', readyExpr: 'true', name: '测试页' };
  const run = (pages) => {
    let t = 0;
    let i = 0;
    const cdp = { evaluate: async () => pages[Math.min(i++, pages.length - 1)] };
    return waitReady(cdp, site, { now: () => t, pause: async (ms) => { t += ms; } });
  };
  const challenge = { href: 'https://www.ebay.com/splashui/challenge?x', ready: false };
  const ok = { href: 'https://www.ebay.com/sh/research', ready: true, title: 'Research' };
  await run([challenge, challenge, ok]); // 检查页自动放行
  await assert.rejects(run([challenge]), (e) => isVerifyMessage(e.message) && /一直没放行/.test(e.message));
  await assert.rejects(run([{ href: 'https://www.ebay.com/splashui/captcha?x' }]), (e) => isVerifyMessage(e.message) && /验证码/.test(e.message));
  await assert.rejects(run([{ href: 'https://signin.ebay.com/x' }]), /未登录或登录已失效/);
  await assert.rejects(run([{ href: 'https://www.ebay.com/x', ready: false }]), /加载超时/);
});
