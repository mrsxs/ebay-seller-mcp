// 修改已有 listing：改内容 / 改价改库存 / 增删规格（revise）、下架（end）、重新上架（relist）。
// 和刊登一样两步走：*_preview 读当前 listing，算出「改前 → 改后」，连同要发的请求和一份快照存成修改记录；
// ebay_listing_apply 在用户确认后执行：按 listing 加锁，重新读 listing，和快照对比，预检后被别处改过就拒绝。
//
// eBay 规则（Trading API 参考文档）：
// - 改价改库存用 ReviseInventoryStatus：Quantity 是「可售数量」，一次最多 4 个（规格逐个算），规格要用 ItemID + SKU 指定
// - ReviseFixedPriceItem：PictureDetails、ItemSpecifics 都是整组替换；有销量（或 12 小时内结束）时不能改标题、类目、发货地；改 Location 要同时给 PostalCode
// - 规格只需要传要变的那几个；传 VariationSpecificsSet 时要包含所有在用的规格值；Pictures 也是整组替换
// - EndFixedPriceItem 要 EndingReason；已结束会报 1047
// - RelistFixedPriceItem 支持 UUID 防重复（重复报 488）；同一条结束的 listing 可以多次重新上架，每次都是新 ItemID；
//   不显式给数量时，可售为 0 的规格可能恢复成原来的数量，所以按当前可售数量逐个写明
//
// 结果不确定（超时、断线、进程中途退出）后再执行同一条记录：逐步判断每一步现在是「已生效」「没生效」还是「被别处改过」，
// 只重发确定没生效的部分；看不清的停下来让人确认，不靠重发碰运气（避免把这期间卖掉的库存补回去、覆盖别人的修改）。
import { createHash } from 'node:crypto';
import { cdata, pickText, tag, text } from './ebay-api.mjs';
import { aspectList, descriptionHtml, duplicateItemId, imageRef, isObj, LIMITS, ListingError, money, nameValues, qty, str } from './listing.mjs';

export const END_REASONS = { NotAvailable: '缺货 / 不再销售', Incorrect: '刊登信息有误', LostOrBroken: '商品丢失或损坏', OtherListingError: '其他刊登错误' };
/** 发出去后结果还没确定的状态（再执行时走对账） */
export const RECOVER = new Set(['sending', 'unknown', 'partial']);
const REVISE_FIELDS = ['title', 'description', 'images', 'aspects', 'condition_id', 'condition_description', 'category_id', 'policies', 'location', 'best_offer', 'price', 'quantity', 'variations'];
const RIS_BATCH = 4;
const FIELD_NAMES = {
  title: '标题', description: '描述', images: '图片', aspects: '商品属性', condition_id: '商品状态', condition_description: '状态说明', category_id: '类目',
  policies: '政策', location: '发货地', best_offer: '议价', variations: '规格结构 / 规格图', stock: '库存', price: '价格', relist: '重新上架记录', status: '在售状态',
};

const hash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
/** eBay 图片地址的身份：同一张图 GetItem 可能返回不同尺寸的地址（$_1 / $_57），按 /z/<图片 ID>/ 比 */
export const imageId = (u) => String(u).match(/\/z\/([^/]+)\//)?.[1] ?? String(u).split('?')[0];
const sortObj = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
const isEbayImage = (u) => /^https:\/\/i\.ebayimg\.com\//i.test(u);
const plain = (html, max = 300) => {
  const t = String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};
const aspectsMap = (list) => Object.fromEntries(list.map((x) => [x.name, x.values.length === 1 ? x.values[0] : x.values]));
const curPolicies = (d) => [d.policies.fulfillment?.id ?? null, d.policies.return?.id ?? null, d.policies.payment?.id ?? null].join('|');
const varKey = (d) => (d.variations ? hash(JSON.stringify({
  items: d.variations.items.map((x) => [x.sku, x.values]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  specifics: d.variations.specifics, by: d.variations.picture_by, pictures: d.variations.pictures,
})) : null);
/** 某个 SKU（单规格用 null）现在的价格、可售、已售 */
function rowOf(d, sku) {
  if (sku === null) return { price: d.price, available: d.quantity_available ?? 0, sold: d.quantity_sold ?? 0 };
  const v = d.variations?.items.find((x) => x.sku === sku);
  return v ? { price: v.price, available: v.quantity_available ?? 0, sold: v.quantity_sold ?? 0 } : null;
}
const totalOf = (r) => (r ? r.available + r.sold : null);
const strOrNum = (v, what, opts) => str(typeof v === 'number' && Number.isFinite(v) ? String(v) : v, what, opts);
const arr = (v, what) => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new ListingError(`${what} 应是数组`);
  return v;
};

function requireActive(d) {
  if (d.status !== 'Active') throw new ListingError(`这条 listing 现在不是在售状态（${d.status ?? '未知'}），不能修改`);
  if (d.listing_type !== 'FixedPriceItem') throw new ListingError('只支持一口价 listing');
}
function requireUs(d) {
  if ((d.currency && d.currency !== 'USD') || (d.site && d.site !== 'US')) throw new ListingError(`只支持 eBay 美国站、美元的 listing（这条是 ${d.site ?? '?'} / ${d.currency ?? '?'}）`);
}

/**
 * 校验 revise 参数并和当前 listing 对比。返回：
 * - intent：要改成什么（只含真的有变化的项）
 * - newImages：要先上传的新图（本地文件 / 非 eBay 网址）
 * - changes：给用户看的「改前 → 改后」
 */
export function planRevise(a, d, { now = Date.now() } = {}) {
  requireActive(d);
  requireUs(d);
  for (const k of Object.keys(a)) if (!REVISE_FIELDS.includes(k)) throw new ListingError(`不认识的修改项：${k}`);
  const intent = {};
  const changes = [];
  const newImages = [];
  const sold = d.quantity_sold > 0;
  const endsSoon = d.end_time && Date.parse(d.end_time) - now < 12 * 3600_000;
  const lockedWhy = sold ? '这条 listing 已经有销量' : endsSoon ? '这条 listing 12 小时内到期' : null;

  if (a.title !== undefined) {
    const t = str(a.title, 'title', { max: LIMITS.title });
    if (t !== d.title) {
      if (lockedWhy) throw new ListingError(`${lockedWhy}，eBay 不允许改标题`);
      intent.title = t;
      changes.push({ field: '标题', before: d.title, after: t });
    }
  }
  if (a.description !== undefined) {
    const html = descriptionHtml(str(a.description, 'description', { max: LIMITS.description }));
    if (html !== d.description) {
      intent.description = html;
      changes.push({ field: '描述（整段替换，下面是开头的文字）', before: plain(d.description), after: plain(html) });
    }
  }
  if (a.images !== undefined) {
    if (!Array.isArray(a.images) || !a.images.length || a.images.length > LIMITS.images) throw new ListingError(`images 是改后的完整图片列表（1~${LIMITS.images} 张，第一张是主图），会整组替换原来的图`);
    const refs = a.images.map((x, i) => (typeof x === 'string' && isEbayImage(x.trim()) ? { kind: 'ebay', ref: x.trim() } : imageRef(x, `images[${i}]`)));
    if (JSON.stringify(refs.map((r) => r.ref)) !== JSON.stringify(d.images)) {
      intent.images = refs;
      newImages.push(...refs.filter((r) => r.kind !== 'ebay'));
      const label = (r, i) => `${i + 1}. ${r.kind === 'ebay' ? (d.images.includes(r.ref) ? `原第 ${d.images.indexOf(r.ref) + 1} 张` : r.ref) : `新图 ${r.ref.split('/').pop()}`}`;
      changes.push({ field: '图片（整组替换，第一张是主图）', before: d.images.map((u, i) => `${i + 1}. ${u}`), after: refs.map(label) });
    }
  }
  if (a.aspects !== undefined) {
    const list = aspectList(a.aspects, 'aspects');
    if (!list.length) throw new ListingError('aspects 是改后的完整商品属性（整组替换），不能为空');
    const after = aspectsMap(list);
    if (sortObj(after) !== sortObj(d.aspects)) {
      if (d.variations) {
        const vNames = d.variations.specifics.map((s) => s.name.toLowerCase());
        const clash = list.find((x) => vNames.includes(x.name.toLowerCase()));
        if (clash) throw new ListingError(`「${clash.name}」是规格名，不能写在 aspects 里`);
      }
      const names = new Set([...Object.keys(after), ...Object.keys(d.aspects)]);
      const diff = [...names].filter((n) => JSON.stringify(after[n]) !== JSON.stringify(d.aspects[n]))
        .map((n) => `${n}：${d.aspects[n] === undefined ? '（无）' : JSON.stringify(d.aspects[n])} → ${after[n] === undefined ? '（删除）' : JSON.stringify(after[n])}`);
      intent.aspects = list;
      changes.push({ field: '商品属性（整组替换）', before: null, after: diff });
    }
  }
  if (a.condition_id !== undefined) {
    if (!Number.isInteger(a.condition_id) || a.condition_id < 1000 || a.condition_id > 7000) throw new ListingError('condition_id 应是 eBay 商品状态 ID');
    if (a.condition_id !== d.condition.id) {
      if (endsSoon) throw new ListingError('这条 listing 12 小时内到期，eBay 不允许改商品状态');
      intent.condition_id = a.condition_id;
      changes.push({ field: '商品状态', before: d.condition.id, after: a.condition_id });
    }
  }
  if (a.condition_description !== undefined) {
    const cd = str(a.condition_description, 'condition_description', { max: 1000 });
    if (cd !== (d.condition.description ?? '')) {
      intent.condition_description = cd;
      changes.push({ field: '状态说明', before: d.condition.description, after: cd });
    }
  }
  if (a.category_id !== undefined) {
    if (!/^\d{1,10}$/.test(String(a.category_id))) throw new ListingError('category_id 应是叶子类目 ID');
    if (String(a.category_id) !== d.category.id) {
      if (lockedWhy) throw new ListingError(`${lockedWhy}，eBay 不允许改类目`);
      intent.category_id = String(a.category_id);
      changes.push({ field: '类目', before: `${d.category.id} ${d.category.name ?? ''}`.trim(), after: intent.category_id });
    }
  }
  if (a.policies !== undefined) {
    if (!isObj(a.policies)) throw new ListingError('policies 应是对象：{ fulfillment_policy_id, return_policy_id, payment_policy_id }（只传要换的）');
    const cur = { fulfillment: d.policies.fulfillment?.id ?? null, return: d.policies.return?.id ?? null, payment: d.policies.payment?.id ?? null };
    const next = { ...cur };
    const keyOf = { fulfillment_policy_id: 'fulfillment', return_policy_id: 'return', payment_policy_id: 'payment' };
    for (const [k, v] of Object.entries(a.policies)) {
      if (!keyOf[k]) throw new ListingError(`policies 有未知字段 ${k}`);
      if (!(typeof v === 'string' || typeof v === 'number') || !/^\d{1,20}$/.test(String(v))) throw new ListingError(`policies.${k} 应是数字政策 ID（用 ebay_listing_defaults 查）`);
      next[keyOf[k]] = String(v);
    }
    if (JSON.stringify(next) !== JSON.stringify(cur)) {
      if (!next.fulfillment || !next.return || !next.payment) throw new ListingError('这条 listing 没有用业务政策，不能只换其中一个：三个政策 ID 都要传');
      intent.policies = next;
      for (const k of ['fulfillment', 'return', 'payment']) {
        if (next[k] !== cur[k]) changes.push({ field: { fulfillment: '运费政策', return: '退货政策', payment: '付款政策' }[k], before: d.policies[k]?.name ?? cur[k], after: next[k] });
      }
    }
  }
  if (a.location !== undefined) {
    if (!isObj(a.location)) throw new ListingError('location 应是对象：{ country, location, postal_code }（整组替换）');
    for (const k of Object.keys(a.location)) if (!['country', 'location', 'postal_code'].includes(k)) throw new ListingError(`location 有未知字段 ${k}`);
    const loc = {
      country: a.location.country === undefined ? null : str(a.location.country, 'location.country', { max: 2 }),
      location: a.location.location === undefined ? null : str(a.location.location, 'location.location', { max: 45 }),
      postal_code: a.location.postal_code === undefined ? null : str(a.location.postal_code, 'location.postal_code（字符串，保留开头的 0）', { max: 20 }),
    };
    // eBay：改 Location 时要同时给对应的 PostalCode，否则 Location 不会更新
    if (!/^[A-Z]{2}$/.test(loc.country ?? '') || !loc.location || !loc.postal_code) throw new ListingError('location 要同时写 country（两位代码）、location 和 postal_code（eBay 改发货地时要求同时给邮编）');
    if (JSON.stringify(loc) !== JSON.stringify(d.location)) {
      if (lockedWhy) throw new ListingError(`${lockedWhy}，eBay 不允许改发货地`);
      intent.location = loc;
      changes.push({ field: '发货地', before: d.location, after: loc });
    }
  }
  if (a.best_offer !== undefined) {
    if (typeof a.best_offer !== 'boolean') throw new ListingError('best_offer 应是 true / false');
    if (d.variations && a.best_offer) throw new ListingError('多规格 listing 不能开议价');
    if (a.best_offer !== d.best_offer) {
      intent.best_offer = a.best_offer;
      changes.push({ field: '议价', before: d.best_offer, after: a.best_offer });
    }
  }

  // ---- 价格 / 库存 ----
  const inventory = [];
  if (a.price !== undefined || a.quantity !== undefined) {
    if (d.variations) throw new ListingError('多规格 listing 的价格和数量用 variations.update 按 SKU 改');
    const row = { sku: null };
    if (a.price !== undefined && money(a.price, 'price') !== d.price) {
      row.price = a.price;
      changes.push({ field: '价格（美元）', before: d.price, after: a.price });
    }
    if (a.quantity !== undefined && qty(a.quantity, 'quantity', 1) !== d.quantity_available) {
      row.quantity = a.quantity;
      changes.push({ field: '可售数量（不含已卖出）', before: d.quantity_available, after: a.quantity });
    }
    if (row.price !== undefined || row.quantity !== undefined) inventory.push(row);
  }

  if (a.variations !== undefined) {
    if (!d.variations) throw new ListingError('这条 listing 不是多规格，价格和数量直接传 price / quantity');
    const v = a.variations;
    if (!isObj(v)) throw new ListingError('variations 应是对象：{ update: [...], add: [...], remove: [...] }');
    for (const k of Object.keys(v)) if (!['update', 'add', 'remove'].includes(k)) throw new ListingError(`variations 有未知字段 ${k}`);
    if (d.variations.items.some((x) => !x.sku)) throw new ListingError('这条 listing 有规格没有 SKU，eBay 接口没法单独改它们：先在 Seller Hub 里给每个规格填上 SKU');
    const bySku = new Map(d.variations.items.map((x) => [x.sku.toLowerCase(), x]));
    const need = (sku, what) => {
      const hit = typeof sku === 'string' ? bySku.get(sku.trim().toLowerCase()) : undefined;
      if (!hit) throw new ListingError(`${what}：找不到 SKU「${sku}」（规格要用 SKU 指定，用 ebay_listing_get 查）`);
      return hit;
    };
    const touched = new Set();
    for (const [i, u] of arr(v.update, 'variations.update').entries()) {
      if (!isObj(u)) throw new ListingError(`variations.update[${i}] 应是对象 { sku, price?, quantity? }`);
      for (const k of Object.keys(u)) if (!['sku', 'price', 'quantity'].includes(k)) throw new ListingError(`variations.update[${i}] 有未知字段 ${k}`);
      const cur = need(u.sku, `variations.update[${i}]`);
      if (touched.has(cur.sku)) throw new ListingError(`SKU「${cur.sku}」重复了`);
      touched.add(cur.sku);
      const row = { sku: cur.sku };
      if (u.price !== undefined && money(u.price, `variations.update[${i}].price`) !== cur.price) row.price = u.price;
      if (u.quantity !== undefined && qty(u.quantity, `variations.update[${i}].quantity`, 0) !== cur.quantity_available) row.quantity = u.quantity;
      if (row.price === undefined && row.quantity === undefined) continue;
      inventory.push(row);
      const label = Object.values(cur.values).join(' / ');
      if (row.price !== undefined) changes.push({ field: `价格（${cur.sku} ${label}）`, before: cur.price, after: row.price });
      if (row.quantity !== undefined) changes.push({ field: `可售数量（${cur.sku} ${label}，不含已卖出）`, before: cur.quantity_available, after: row.quantity });
    }
    const removed = arr(v.remove, 'variations.remove').map((sku, i) => {
      const cur = need(sku, `variations.remove[${i}]`);
      if (touched.has(cur.sku)) throw new ListingError(`SKU「${cur.sku}」既要改又要删（或重复）`);
      touched.add(cur.sku);
      return cur;
    });
    const names = d.variations.specifics.map((s) => s.name);
    const combos = new Set(d.variations.items.filter((x) => !removed.includes(x)).map((x) => JSON.stringify(names.map((n) => String(x.values[n] ?? '').toLowerCase()))));
    const added = arr(v.add, 'variations.add').map((it, i) => {
      const w = `variations.add[${i}]`;
      if (!isObj(it) || !isObj(it.values)) throw new ListingError(`${w} 应是 { sku, price, quantity, values: {${names.join(', ')}}, image? }`);
      for (const k of Object.keys(it)) if (!['sku', 'price', 'quantity', 'values', 'image'].includes(k)) throw new ListingError(`${w} 有未知字段 ${k}`);
      const sku = str(it.sku, `${w}.sku`, { max: LIMITS.sku });
      if (bySku.has(sku.toLowerCase()) || [...touched].some((t) => t.toLowerCase() === sku.toLowerCase())) throw new ListingError(`${w}.sku「${sku}」已经存在`);
      touched.add(sku);
      const keys = Object.keys(it.values);
      const values = {};
      for (const n of names) {
        const key = keys.find((k) => k.trim().toLowerCase() === n.toLowerCase());
        if (key === undefined) throw new ListingError(`${w}.values 缺少规格「${n}」`);
        values[n] = strOrNum(it.values[key], `${w}.values「${n}」`, { max: LIMITS.aspectValue });
      }
      if (keys.length !== names.length) throw new ListingError(`${w}.values 只能有这几个规格：${names.join('、')}`);
      const combo = JSON.stringify(names.map((n) => values[n].toLowerCase()));
      if (combos.has(combo)) throw new ListingError(`${w} 的规格组合已经存在：${names.map((n) => values[n]).join(' / ')}`);
      combos.add(combo);
      let image = null;
      if (it.image !== undefined) {
        if (!d.variations.picture_by) throw new ListingError(`${w}.image：这条 listing 没有按规格配图`);
        image = typeof it.image === 'string' && isEbayImage(it.image.trim()) ? { kind: 'ebay', ref: it.image.trim() } : imageRef(it.image, `${w}.image`);
        if (image.kind !== 'ebay') newImages.push(image);
      }
      return { sku, price: money(it.price, `${w}.price`), quantity: qty(it.quantity, `${w}.quantity`, 0), values, image };
    });
    if (removed.length >= d.variations.items.length && !added.length) throw new ListingError('不能把所有规格都删掉（要下架用 ebay_listing_end_preview）');
    if (added.length + d.variations.items.length - removed.length > LIMITS.variations) throw new ListingError(`规格最多 ${LIMITS.variations} 个`);
    if (added.length || removed.length) {
      intent.variations = { added, removed: removed.map((x) => ({ sku: x.sku, values: x.values })) };
      for (const x of added) changes.push({ field: '新增规格', before: null, after: { sku: x.sku, ...x.values, price: x.price, quantity: x.quantity } });
      for (const x of removed) changes.push({ field: '删除规格', before: { sku: x.sku, ...x.values, quantity_available: x.quantity_available, quantity_sold: x.quantity_sold }, after: null });
      const by = d.variations.picture_by;
      if (by) {
        const remaining = new Set([...d.variations.items.filter((x) => !removed.includes(x)).map((x) => x.values[by]), ...added.map((x) => x.values[by])]);
        const dropped = Object.keys(d.variations.pictures).filter((val) => !remaining.has(val));
        const gained = added.filter((x) => x.image).map((x) => x.values[by]);
        if (dropped.length || gained.length) changes.push({ field: `规格图（按「${by}」，整组替换）`, before: Object.keys(d.variations.pictures), after: { 新增或加图: [...new Set(gained)], 删除: dropped } });
      }
    }
  }
  if (inventory.length) intent.inventory = inventory;
  if (!changes.length) throw new ListingError('和现在的 listing 比没有任何变化');
  const notes = [];
  if (inventory.some((r) => r.price !== undefined) && d.best_offer) notes.push('改价会清掉议价的自动接受 / 自动拒绝价格，需要的话改完再在 Seller Hub 里设置');
  if (intent.aspects) notes.push('商品属性是整组替换：没写在新属性里的会被删掉');
  if (intent.images) notes.push('图片是整组替换：没写在新列表里的图会从 listing 上去掉');
  return { intent, newImages, changes, notes };
}

/** 增删规格后整组的规格图（值 → 图片地址）；不需要动规格图时返回 null */
function variationPictureSets(intent, d, url) {
  const by = d.variations?.picture_by;
  if (!intent.variations || !by || !(intent.variations.added.some((x) => x.image) || intent.variations.removed.length)) return null;
  const removedSkus = new Set(intent.variations.removed.map((x) => x.sku));
  const used = new Set([...d.variations.items.filter((x) => !removedSkus.has(x.sku)).map((x) => x.values[by]), ...intent.variations.added.map((x) => x.values[by])]);
  const sets = new Map(Object.entries(d.variations.pictures));
  for (const x of intent.variations.added) if (x.image) sets.set(x.values[by], [...(sets.get(x.values[by]) ?? []).filter((u) => u !== url(x.image)), url(x.image)]);
  return new Map([...sets].filter(([value]) => used.has(value)).map(([value, urls]) => [value, urls.slice(0, 12)]));
}
const resolver = (pictures) => (img) => {
  if (img.kind === 'ebay') return img.ref;
  const u = pictures.get(img.ref);
  if (!u) throw new Error(`图片还没上传：${img.ref}`);
  return u;
};

/** 预检时的快照：改动涉及的每一项「改前 / 改后」，执行前和对账时用。pictures：新图上传后的地址 */
export function reviseSnapshot(intent, d, pictures = new Map()) {
  const url = resolver(pictures);
  const s = {};
  if (intent.title !== undefined) s.title = { before: d.title, after: intent.title };
  if (intent.description !== undefined) s.description = { before: hash(d.description), after: hash(intent.description) };
  if (intent.images !== undefined) s.images = { before: hash(d.images.join('\n')), after: intent.images.map((i) => imageId(url(i))) };
  if (intent.aspects !== undefined) s.aspects = { before: hash(sortObj(d.aspects)), after: hash(sortObj(aspectsMap(intent.aspects))) };
  if (intent.condition_id !== undefined) s.condition_id = { before: d.condition.id, after: intent.condition_id };
  if (intent.condition_description !== undefined) s.condition_description = { before: d.condition.description ?? null, after: intent.condition_description };
  if (intent.category_id !== undefined) s.category_id = { before: d.category.id, after: intent.category_id };
  if (intent.policies !== undefined) s.policies = { before: curPolicies(d), after: [intent.policies.fulfillment, intent.policies.return, intent.policies.payment].join('|') };
  if (intent.location !== undefined) s.location = { before: JSON.stringify(d.location), after: JSON.stringify(intent.location) };
  if (intent.best_offer !== undefined) s.best_offer = { before: d.best_offer, after: intent.best_offer };
  if (intent.variations !== undefined) {
    const sets = variationPictureSets(intent, d, url);
    s.variations = {
      before: varKey(d),
      // 要删的规格现在的库存总数：预检后被补了货就不该照删
      removed_totals: intent.variations.removed.map((x) => [x.sku, totalOf(rowOf(d, x.sku))]),
      added: intent.variations.added.map((x) => ({ sku: x.sku, values: x.values, price: x.price, quantity: x.quantity })),
      pictures_after: sets ? Object.fromEntries([...sets].map(([value, urls]) => [value, urls.map(imageId)])) : null,
    };
  }
  if (intent.inventory) {
    s.inventory = intent.inventory.map((r) => {
      const cur = rowOf(d, r.sku);
      return { sku: r.sku, price_before: cur.price, price_after: r.price, total_before: totalOf(cur), quantity_after: r.quantity };
    });
  }
  return s;
}

const CURRENT = {
  title: (d) => d.title,
  description: (d) => hash(d.description),
  aspects: (d) => hash(sortObj(d.aspects)),
  condition_id: (d) => d.condition.id,
  condition_description: (d) => d.condition.description ?? null,
  category_id: (d) => d.category.id,
  policies: (d) => curPolicies(d),
  location: (d) => JSON.stringify(d.location),
  best_offer: (d) => d.best_offer,
};

/** 第一次执行前：快照里每一项现在都还是「改前」的值？返回变了的项（销量引起的可售数量变化不算：看可售 + 已售的总数） */
export function staleFields(snap, d) {
  const out = [];
  for (const [k, v] of Object.entries(snap)) {
    if (CURRENT[k]) {
      if (JSON.stringify(CURRENT[k](d)) !== JSON.stringify(v.before)) out.push(k);
    } else if (k === 'images') {
      if (hash(d.images.join('\n')) !== v.before) out.push(k);
    } else if (k === 'variations') {
      if (varKey(d) !== v.before) out.push(k);
      else if (v.removed_totals.some(([sku, total]) => totalOf(rowOf(d, sku)) !== total)) out.push('stock');
    } else if (k === 'inventory') {
      for (const r of v) {
        const cur = rowOf(d, r.sku);
        if (!cur) out.push('variations');
        else {
          if (r.price_after !== undefined && cur.price !== r.price_before) out.push('price');
          if (r.quantity_after !== undefined && totalOf(cur) !== r.total_before) out.push('stock');
        }
      }
    }
  }
  return [...new Set(out)];
}

/** 内容那一步现在的状态：applied 已生效 / pending 没生效 / conflict 既不是改前也不是改后 */
function contentState(snap, intent, d) {
  const states = [];
  for (const [k, v] of Object.entries(snap)) {
    if (k === 'inventory') continue;
    if (CURRENT[k]) {
      const cur = JSON.stringify(CURRENT[k](d));
      states.push(cur === JSON.stringify(v.after) ? 'after' : cur === JSON.stringify(v.before) ? 'before' : 'other');
    } else if (k === 'images') {
      if (hash(d.images.join('\n')) === v.before) states.push('before');
      else states.push(JSON.stringify(d.images.map(imageId)) === JSON.stringify(v.after) ? 'after' : 'other');
    } else if (k === 'variations') {
      const items = new Map((d.variations?.items ?? []).map((x) => [x.sku, x]));
      // 新增的规格：规格值、价格都对，库存总数（可售 + 已售）= 新增时的数量
      const added = v.added.every((x) => {
        const c = items.get(x.sku);
        return c && JSON.stringify(c.values) === JSON.stringify(x.values) && c.price === x.price && totalOf(rowOf(d, x.sku)) === x.quantity;
      });
      const removed = intent.variations.removed.every((x) => !items.has(x.sku));
      const pics = !v.pictures_after || JSON.stringify(Object.fromEntries(Object.entries(d.variations?.pictures ?? {}).map(([val, urls]) => [val, urls.map(imageId)])))
        === JSON.stringify(v.pictures_after);
      const untouched = varKey(d) === v.before && v.removed_totals.every(([sku, total]) => totalOf(rowOf(d, sku)) === total);
      states.push(added && removed && pics ? 'after' : untouched ? 'before' : 'other');
    }
  }
  if (states.every((s) => s === 'after')) return 'applied';
  if (states.every((s) => s === 'before')) return 'pending';
  return 'conflict';
}

/**
 * 改价改库存的一行现在的状态。数量看「可售 + 已售」的总数：生效后总数 = 目标可售 + 发送时的已售，没生效时总数不变；
 * 卖出只是把可售挪到已售，总数不变，所以这期间有销量也判断得清。
 */
function rowState(r, sent, d) {
  const cur = rowOf(d, r.sku);
  if (!cur) return 'conflict';
  const parts = [];
  if (r.price_after !== undefined) parts.push(cur.price === r.price_after ? 'after' : cur.price === r.price_before ? 'before' : 'other');
  if (r.quantity_after !== undefined) {
    const base = sent ?? { total: r.total_before, sold: cur.sold };
    const target = r.quantity_after + base.sold;
    const t = totalOf(cur);
    parts.push(t === target ? 'after' : t === base.total ? 'before' : 'other');
  }
  if (parts.every((p) => p === 'after')) return 'applied';
  if (parts.every((p) => p === 'before')) return 'pending';
  return 'conflict';
}

/** 内容 / 规格结构的修改 → ReviseFixedPriceItem 请求体；没有就返回 null。pictures：图片引用 → eBay 地址 */
export function buildReviseXml(itemId, intent, d, pictures) {
  const url = resolver(pictures);
  const parts = [];
  if (intent.title !== undefined) parts.push(text('Title', intent.title));
  if (intent.description !== undefined) parts.push(tag('Description', cdata(intent.description)));
  if (intent.images !== undefined) parts.push(tag('PictureDetails', intent.images.map((i) => text('PictureURL', url(i))).join('')));
  if (intent.aspects !== undefined) parts.push(tag('ItemSpecifics', nameValues(intent.aspects)));
  if (intent.condition_id !== undefined) parts.push(text('ConditionID', intent.condition_id));
  if (intent.condition_description !== undefined) parts.push(text('ConditionDescription', intent.condition_description));
  if (intent.category_id !== undefined) parts.push(tag('PrimaryCategory', text('CategoryID', intent.category_id)));
  if (intent.policies !== undefined) {
    parts.push(tag('SellerProfiles',
      tag('SellerShippingProfile', text('ShippingProfileID', intent.policies.fulfillment))
      + tag('SellerReturnProfile', text('ReturnProfileID', intent.policies.return))
      + tag('SellerPaymentProfile', text('PaymentProfileID', intent.policies.payment))));
  }
  if (intent.location !== undefined) parts.push(text('Country', intent.location.country) + text('Location', intent.location.location) + text('PostalCode', intent.location.postal_code));
  if (intent.best_offer !== undefined) parts.push(tag('BestOfferDetails', text('BestOfferEnabled', String(intent.best_offer))));
  if (intent.variations !== undefined) {
    const names = d.variations.specifics.map((s) => s.name);
    const removedSkus = new Set(intent.variations.removed.map((x) => x.sku));
    const remaining = d.variations.items.filter((x) => !removedSkus.has(x.sku)).map((x) => x.values).concat(intent.variations.added.map((x) => x.values));
    const valuesOf = (n) => [...new Set(remaining.map((v) => v[n]))];
    const spec = (values) => tag('VariationSpecifics', nameValues(names.map((n) => ({ name: n, values: [values[n]] }))));
    let body = tag('VariationSpecificsSet', nameValues(names.map((n) => ({ name: n, values: valuesOf(n) }))));
    for (const x of intent.variations.added) body += tag('Variation', text('SKU', x.sku) + text('StartPrice', x.price.toFixed(2)) + text('Quantity', x.quantity) + spec(x.values));
    for (const x of intent.variations.removed) body += tag('Variation', text('Delete', 'true') + text('SKU', x.sku) + spec(x.values));
    // 规格图整组替换：保留还在用的值原来的图，加上新规格的图
    const sets = variationPictureSets(intent, d, url);
    if (sets) {
      body += tag('Pictures', text('VariationSpecificName', d.variations.picture_by) + [...sets]
        .map(([value, urls]) => tag('VariationSpecificPictureSet', text('VariationSpecificValue', value) + urls.map((u) => text('PictureURL', u)).join(''))).join(''));
    }
    parts.push(tag('Variations', body));
  }
  if (!parts.length) return null;
  return tag('Item', text('ItemID', itemId) + parts.join(''));
}

/** 改价改库存的请求体（一次最多 4 行） */
export const inventoryXml = (itemId, rows) => rows.map((r) => tag('InventoryStatus', text('ItemID', itemId) + (r.sku ? text('SKU', r.sku) : '')
  + (r.price_after !== undefined ? text('StartPrice', r.price_after.toFixed(2)) : '') + (r.quantity_after !== undefined ? text('Quantity', r.quantity_after) : ''))).join('');

/** revise 的执行步骤：内容一步（如果有）+ 改价改库存每 4 行一步（请求体在发送时按还没生效的行生成） */
export function reviseSteps(contentXml, snap) {
  const steps = [];
  if (contentXml) steps.push({ call: 'ReviseFixedPriceItem', body: contentXml });
  const rows = snap.inventory ?? [];
  for (let i = 0; i < rows.length; i += RIS_BATCH) steps.push({ call: 'ReviseInventoryStatus', rows: rows.slice(i, i + RIS_BATCH) });
  return steps;
}

// ---- 下架 / 重新上架 ----
const stockKey = (d) => JSON.stringify(d.variations ? d.variations.items.map((x) => [x.sku, x.quantity_available, totalOf(rowOf(d, x.sku))]) : [[null, d.quantity_available, totalOf(rowOf(d, null))]]);

export function planEnd(d, reason = 'NotAvailable') {
  if (!END_REASONS[reason]) throw new ListingError(`reason 只能是：${Object.keys(END_REASONS).join('、')}`);
  requireActive(d);
  const available = d.variations ? d.variations.items.reduce((s, v) => s + (v.quantity_available ?? 0), 0) : d.quantity_available;
  return {
    steps: [{ call: 'EndFixedPriceItem', body: text('ItemID', d.item_id) + text('EndingReason', reason) }],
    // 下架前检查：标题和库存总数没被别处改过（卖出不算）
    snapshot: { title: d.title, totals: endTotals(d) },
    changes: [{ field: '下架', before: `在售：${d.title}（可售 ${available}，已售 ${d.quantity_sold}）`, after: `结束刊登（原因：${END_REASONS[reason]}）` }],
    notes: ['下架后要恢复只能重新上架（ebay_listing_relist_preview），会变成新的 ItemID，原来的浏览和销量记录不会带过去。'],
  };
}

export function planRelist(d, uuid, { now = Date.now() } = {}) {
  if (d.status === 'Active') throw new ListingError('这条 listing 还在售，不需要重新上架');
  if (d.listing_type !== 'FixedPriceItem') throw new ListingError('只支持一口价 listing');
  requireUs(d);
  if (d.end_time && now - Date.parse(d.end_time) > 90 * 24 * 3600_000) throw new ListingError('这条 listing 结束超过 90 天，eBay 不能重新上架了，要按新商品刊登');
  let body = text('ItemID', d.item_id) + text('UUID', uuid);
  const changes = [{ field: '重新上架', before: `已结束（${d.end_time ?? '时间未知'}）：${d.title}`, after: '按原样重新刊登（新 ItemID）' }];
  if (d.variations) {
    // 逐个规格写明当前可售数量：不写的话，可售为 0 的规格可能恢复成原来的数量
    if (!d.variations.items.some((v) => (v.quantity_available ?? 0) > 0)) throw new ListingError('所有规格的可售数量都是 0，重新上架也买不了：请先在 Seller Hub 里确认数量后再上架');
    const names = d.variations.specifics.map((s) => s.name);
    const varXml = (v) => tag('Variation', (v.sku ? text('SKU', v.sku) : '') + text('StartPrice', v.price.toFixed(2)) + text('Quantity', v.quantity_available ?? 0)
      + tag('VariationSpecifics', nameValues(names.map((n) => ({ name: n, values: [v.values[n]] })))));
    body += tag('Variations', d.variations.items.map(varXml).join(''));
    changes.push({ field: '各规格（价格 / 可售数量）', before: null, after: d.variations.items.map((v) => `${v.sku ?? ''} ${Object.values(v.values).join(' / ')}：$${v.price}，可售 ${v.quantity_available}`) });
  } else {
    if (!(d.quantity_available > 0)) throw new ListingError('这条 listing 的可售数量是 0，重新上架也买不了：请先在 Seller Hub 里确认数量');
    body += text('Quantity', d.quantity_available);
    changes.push({ field: '价格 / 可售数量', before: null, after: `$${d.price}，可售 ${d.quantity_available}` });
  }
  const notes = ['重新上架会生成新的 ItemID，图片、属性、规格、政策沿用原来的；可能产生刊登费。'];
  if (d.relisted_item_id) notes.push(`这条之前已经重新上架过（新 ItemID ${d.relisted_item_id}），再上架会多出一条在售 listing。`);
  return {
    steps: [{ call: 'RelistFixedPriceItem', body: tag('Item', body) }],
    snapshot: { relisted: d.relisted_item_id ?? null, stock: stockKey(d) },
    changes,
    notes,
  };
}

const CONFLICT = '这条修改之前的执行结果不确定，而 listing 现在既不是改前也不是改后的样子（可能被别处改过），为了不覆盖，停止执行。'
  + '请用 ebay_listing_get 看现在的样子，需要的话重新预检。';
const endTotals = (d) => JSON.stringify(d.variations ? d.variations.items.map((x) => [x.sku, totalOf(rowOf(d, x.sku))]) : [totalOf(rowOf(d, null))]);

/** 第一次执行前的检查：预检之后被别处改过就拒绝（返回变了的项） */
function freshCheck(rec, d) {
  if (rec.kind === 'revise') {
    if (d.status !== 'Active') return ['status'];
    return staleFields(rec.snapshot, d);
  }
  if (rec.kind === 'end') return [...(d.title !== rec.snapshot.title ? ['title'] : []), ...(endTotals(d) !== rec.snapshot.totals ? ['stock'] : [])];
  if (rec.kind === 'relist') {
    if (d.status === 'Active') return ['status'];
    return [...((d.relisted_item_id ?? null) !== rec.snapshot.relisted ? ['relist'] : []), ...(stockKey(d) !== rec.snapshot.stock ? ['stock'] : [])];
  }
  return [];
}

/**
 * 结果不确定后，内容 / 下架 / 重新上架这一步现在的状态：applied / pending / conflict。
 * pending 的下架 / 重新上架也要过快照检查（被别处改过就算 conflict）。
 */
function lifecycleState(rec, step, d) {
  if (step.call === 'ReviseFixedPriceItem') return { state: contentState(rec.snapshot, rec.intent, d) };
  if (step.call === 'EndFixedPriceItem') {
    if (d.status !== 'Active') return { state: 'applied', result: { ended: true } };
    return { state: freshCheck(rec, d).length ? 'conflict' : 'pending' };
  }
  if (step.call === 'RelistFixedPriceItem') {
    // RelistedItemID 是「最近一次」重新上架的结果，分不清是不是这次的：变了就停下来让人确认，不自动当成结果
    if ((d.relisted_item_id ?? null) !== rec.snapshot.relisted) {
      return { state: 'conflict', message: `原 listing 已经被重新上架过（新 ItemID ${d.relisted_item_id}），很可能就是这次操作的结果，但也可能是别处上架的。`
        + '请到 Seller Hub 确认；不要再执行这条修改，确认需要再上架时重新预检。' };
    }
    return { state: stockKey(d) !== rec.snapshot.stock ? 'conflict' : 'pending' };
  }
  return { state: 'conflict' };
}

/**
 * 执行一条修改记录。lockItem(itemId, fn)：按 listing 加跨进程锁（同一条 listing 的不同修改也排队）。
 * 锁内：重新读记录和 listing → 第一次执行先检查有没有被别处改过；结果不确定后再执行就逐步对账 → 按顺序发送还没生效的部分。
 * 改价改库存的每一步发送前都重新读一次 listing：逐行判断（还没生效 / 已生效 / 被别处改过），并记下发送时的已售和总数（对账用）。
 * 每一步成功后把 done 和结果一起存。
 */
export async function applyChange({ previews, id, storeId, lockItem, getItem, call, describe, now = () => new Date().toISOString() }) {
  const head = previews.load(id);
  if (!head.kind || head.kind === 'publish') throw new ListingError('这是新刊登的预检，用 ebay_listing_publish 发布');
  if (!['revise', 'end', 'relist'].includes(head.kind)) throw new ListingError('这不是 listing 的修改记录（广告修改用 ebay_ad_change_apply）');
  if (head.store_id !== storeId) throw new ListingError('这条修改不是这家店的（shop 参数要和预检时一样）');
  return lockItem(head.item_id, async () => {
    const rec = previews.load(id);
    if (rec.status === 'applied') return { ok: true, already_applied: true, rec, result: rec.result ?? {} };
    const recovering = RECOVER.has(rec.status);
    if (!recovering && previews.expired(rec)) throw new ListingError('修改预检已超过 24 小时，请重新预检');
    let d = await getItem(rec.item_id);
    const done = [...(rec.done ?? [])];
    let result = { ...(rec.result ?? {}) };
    const sent = { ...(rec.sent ?? {}) };
    const save = (patch) => previews.update(id, { done, result, sent, ...patch });
    const stop = (message) => {
      if (recovering || done.length) save({ status: recovering ? rec.status : 'partial' });
      throw new ListingError(message);
    };
    if (!recovering) {
      const stale = freshCheck(rec, d);
      if (stale.length) throw new ListingError(`这条 listing 在预检之后有变化（${stale.map((k) => FIELD_NAMES[k] ?? k).join('、')}），为了不覆盖别处的修改，请重新预检`);
    }
    const warnings = [];
    let first = true;
    for (const [i, step] of rec.steps.entries()) {
      if (done.includes(i)) continue;
      let rows = null;
      if (step.call === 'ReviseInventoryStatus') {
        if (!first) d = await getItem(rec.item_id);
        const states = step.rows.map((r) => rowState(r, sent[i]?.[r.sku ?? ''], d));
        if (states.includes('conflict')) stop(recovering ? CONFLICT : '执行到一半时发现这条 listing 的价格或库存被别处改过，为了不覆盖，停止执行。请用 ebay_listing_get 看现在的样子，需要的话重新预检。');
        rows = step.rows.filter((_, k) => states[k] === 'pending');
        // 每一行都记下判断时的基准：要发的行用现在的（马上发）；已经是目标状态、不用发的行没有基准就补上，
        // 否则之后再卖出会被误判成「没生效」而重发，把卖掉的补回去
        const base = (r) => ({ sold: rowOf(d, r.sku).sold, total: totalOf(rowOf(d, r.sku)) });
        sent[i] = { ...(sent[i] ?? {}) };
        step.rows.forEach((r, k) => {
          const key = r.sku ?? '';
          if (states[k] === 'pending' || (states[k] === 'applied' && !sent[i][key])) sent[i][key] = base(r);
        });
        if (!rows.length) {
          done.push(i);
          save({});
          first = false;
          continue;
        }
      } else if (recovering) {
        const s = lifecycleState(rec, step, d);
        if (s.state === 'conflict') stop(s.message ?? CONFLICT);
        if (s.state === 'applied') {
          done.push(i);
          result = { ...result, ...(s.result ?? {}) };
          save({});
          first = false;
          continue;
        }
      }
      first = false;
      save({ status: 'sending', sending_at: now(), sending_step: i });
      let r;
      try {
        r = await call(rows ? { call: step.call, body: inventoryXml(rec.item_id, rows) } : step);
      } catch (err) {
        if (!err?.unknownOutcome) {
          // 明确没发出去（令牌被拒、参数错误等）：一步都没做过就退回原状态，否则留给对账
          save({ status: recovering || done.length ? 'partial' : rec.status === 'failed' ? 'failed' : 'ready' });
          throw err;
        }
        save({ status: 'unknown', unknown_at: now() });
        throw new ListingError(`修改请求没有收到 eBay 的明确回复，不确定是否已生效${done.length ? `（前 ${done.length} 步已完成）` : ''}。先用 ebay_listing_get 看看现在的样子；`
          + '再用同一个 change_id 调 ebay_listing_apply 会先对账，只补做确定没生效的部分（不会重复上架 / 重复补库存）。');
      }
      if (step.call === 'RelistFixedPriceItem') {
        const dup = duplicateItemId(r.errors);
        if (dup !== null) {
          done.push(i);
          result = { ...result, new_item_id: dup || null, duplicate: true };
          save({});
          continue;
        }
      }
      if (step.call === 'EndFixedPriceItem' && r.errors.some((e) => e.code === '1047')) {
        done.push(i);
        result = { ...result, ended: true, already_ended: true };
        save({});
        continue;
      }
      if (r.ack !== 'Success' && r.ack !== 'Warning') {
        const partial = recovering || done.length > 0;
        save({ status: partial ? 'partial' : 'failed', failed_at: now() });
        return { ok: false, partial, errors: describe(r.errors), warnings: describe(r.warnings), rec };
      }
      warnings.push(...describe(r.warnings));
      if (step.call === 'RelistFixedPriceItem') result = { ...result, new_item_id: pickText(r.xml, 'ItemID') ?? null };
      if (step.call === 'EndFixedPriceItem') result = { ...result, ended: true, end_time: pickText(r.xml, 'EndTime') ?? null };
      done.push(i);
      save({});
    }
    save({ status: 'applied', applied_at: now() });
    return { ok: true, rec, result, warnings };
  });
}
