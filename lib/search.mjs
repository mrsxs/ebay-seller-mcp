// eBay 前台搜索（www.ebay.com/sch）：买家看到的搜索结果——排名位置、标题、新旧、价格（区间、划线原价）、购买方式、运费、发货地、已售件数。
// 不输出「是否广告位」：页面上每张卡片都带同样显示的 Sponsored 标记（打乱的字母），分不出来；推广情况看 Terapeak 在售数据。
// 在店铺浏览器的搜索工作标签页里真实打开搜索页（页面内 fetch 搜索页会被转到浏览器检查页），读出每张商品卡片的原始文字，Node 侧再分类。

export const SORTS = { best_match: 12, price_low: 15, price_high: 16, newly_listed: 10, ending_soon: 1 };
export const CONDITIONS = { new: 1000, used: 3000 };

export function searchUrl({ keyword, sort = 'best_match', condition, buyItNow = false, priceMin, priceMax, categoryId, page = 1 }) {
  const q = new URLSearchParams({ _nkw: keyword, _sacat: String(categoryId ?? 0), _ipg: '60', _sop: String(SORTS[sort]) });
  if (page > 1) q.set('_pgn', String(page));
  if (condition) q.set('LH_ItemCondition', String(CONDITIONS[condition]));
  if (buyItNow) q.set('LH_BIN', '1');
  if (priceMin !== undefined) q.set('_udlo', String(priceMin));
  if (priceMax !== undefined) q.set('_udhi', String(priceMax));
  return `https://www.ebay.com/sch/i.html?${q}`;
}

// ---- 这个函数会被序列化到页面里执行（读当前打开的搜索页），必须自包含 ----
export function readSearchPage() {
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const cards = [...document.querySelectorAll('ul.srp-results > li[data-listingid]')].map((li) => ({
    listing_id: li.getAttribute('data-listingid'),
    pos: Number(li.getAttribute('data-item-pos')) || null,
    title: text(li.querySelector('.s-card__title')),
    subtitle: text(li.querySelector('.s-card__subtitle')),
    price: text(li.querySelector('.s-card__price')),
    // 价格行逐段读：「$A to $B」是价格区间，划线的是原价
    price_parts: (() => {
      const row = li.querySelector('.s-card__price')?.closest('.s-card__attribute-row');
      if (!row) return [];
      return [...row.querySelectorAll('*')].filter((e) => !e.children.length && e.textContent.trim())
        .map((e) => ({ t: e.textContent.trim(), struck: getComputedStyle(e).textDecorationLine.includes('line-through') || !!e.closest('s, del, strike') }));
    })(),
    rows: [...li.querySelectorAll('.s-card__attribute-row')].map(text).filter(Boolean),
  }));
  return {
    url: location.href, path: location.pathname, title: document.title,
    has_results: Boolean(document.querySelector('ul.srp-results')),
    complete: document.readyState === 'complete',
    total: text(document.querySelector('.srp-controls__count-heading')), cards,
  };
}

// ---- Node 侧：把卡片文字分类 ----

const money = (s) => {
  const m = String(s ?? '').replace(/,/g, '').match(/\$\s*(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
};
/** "57 sold" / "1.2K+ sold" / "10K+ sold" → 下限数字和原文 */
function soldCount(s) {
  const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([Kk])?\+?\s+sold/);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] ? 1000 : 1));
}

export function parseCard(c) {
  const rows = Array.isArray(c?.rows) ? c.rows : [];
  const out = {
    position: c?.pos ?? null,
    listing_id: c?.listing_id ? String(c.listing_id) : null,
    title: String(c?.title ?? '').replace(/Opens in a new window or tab$/i, '').replace(/^New Listing/i, '').trim() || null,
    url: /^\d{6,20}$/.test(String(c?.listing_id ?? '')) ? `https://www.ebay.com/itm/${c.listing_id}` : null,
    condition: c?.subtitle || null,
    price: money(c?.price),
    price_max: null,
    was_price: null,
    price_text: c?.price || null,
    format: null,
    best_offer: false,
    bids: null,
    shipping: null,
    location: null,
    sold: null,
    sold_text: null,
    notes: [],
  };
  // 价格行：「$A to $B」→ 区间上限；划线的金额 → 原价
  const parts = Array.isArray(c?.price_parts) ? c.price_parts : [];
  const priceRow = parts.map((p) => p.t).join('').replace(/\s+/g, '');
  const toIdx = parts.findIndex((p) => /^to$/i.test(p.t));
  if (toIdx > 0) out.price_max = money(parts.slice(toIdx + 1).find((p) => /\$/.test(p.t))?.t);
  out.was_price = money(parts.find((p) => p.struck && /\$/.test(p.t))?.t);
  for (const r of rows) {
    if (r === c?.price || (priceRow && r.replace(/\s+/g, '') === priceRow)) continue;
    if (/^or Best Offer$/i.test(r)) out.best_offer = true;
    else if (/^Buy It Now$/i.test(r)) out.format = '一口价';
    else if (/(\d+)\s+bids?\b/i.test(r)) {
      out.format = '拍卖';
      out.bids = Number(r.match(/(\d+)\s+bids?\b/i)[1]);
    } else if (/delivery|shipping/i.test(r)) out.shipping = /free/i.test(r) ? 0 : money(r);
    else if (/^Located in /i.test(r)) out.location = r.replace(/^Located in /i, '');
    else if (/\bsold\b/i.test(r)) {
      out.sold = soldCount(r);
      out.sold_text = r;
    } else out.notes.push(r);
  }
  if (!out.format && out.best_offer) out.format = '一口价';
  if (!out.notes.length) delete out.notes;
  return out;
}

/** 去掉占位卡片（没有标题或 eBay 的「Shop on eBay」） */
export function parseResults(raw) {
  return (raw?.cards || []).map(parseCard).filter((x) => x.listing_id && x.title && !/^Shop on eBay$/i.test(x.title));
}
