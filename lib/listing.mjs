// 刊登：参数校验、拼 Trading API 的 <Item>、图片上传（eBay 图片服务）、预检记录。
// 流程固定两步：ebay_listing_preview 只让 eBay 校验（VerifyAddFixedPriceItem，不刊登）并把要发的内容存成预检记录；
// ebay_listing_publish 只能发布某个预检记录里原样的内容（AddFixedPriceItem），带 UUID，重复发布 eBay 会拒绝并返回已有的 ItemID。
import { createHash, randomBytes } from 'node:crypto';
import { constants, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { cdata, decode, esc, pick, pickAll, pickText, tag, text } from './ebay-api.mjs';
import { writeFileAtomic } from './fsutil.mjs';

export class ListingError extends Error {}

export const LIMITS = {
  title: 80, description: 500_000, images: 24, aspects: 45, aspectName: 65, aspectValue: 65, aspectValues: 30,
  sku: 80, variationSpecifics: 5, variations: 250, imageBytes: 12 * 1024 * 1024, price: 1_000_000, quantity: 1_000_000,
};
export const PREVIEW_TTL_MS = 24 * 3600_000;
const IMAGE_CACHE_TTL_MS = 7 * 24 * 3600_000;
const POLICY_ID = /^\d{1,20}$/;

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const str = (v, what, { max, min = 1 } = {}) => {
  if (typeof v !== 'string') throw new ListingError(`${what} 应是字符串`);
  const s = v.trim();
  if (s.length < min) throw new ListingError(`${what} 不能为空`);
  if (max && s.length > max) throw new ListingError(`${what} 最多 ${max} 个字符（现在 ${s.length}）`);
  return s;
};
export const money = (v, what) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > LIMITS.price) throw new ListingError(`${what} 应是大于 0 的美元金额`);
  if (Math.round(v * 100) / 100 !== v) throw new ListingError(`${what} 最多两位小数`);
  return v;
};
export const qty = (v, what, min) => {
  if (!Number.isInteger(v) || v < min || v > LIMITS.quantity) throw new ListingError(`${what} 应是不小于 ${min} 的整数`);
  return v;
};

/** 纯文本描述转成简单 HTML；已经是 HTML 就原样用 */
export function descriptionHtml(s) {
  if (/<[a-z][\s\S]*>/i.test(s)) return s;
  return s.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
}

export function imageRef(v, what) {
  const s = str(v, what, { max: 2048 });
  if (/^https:\/\//i.test(s)) {
    try {
      new URL(s);
    } catch {
      throw new ListingError(`${what} 不是合法网址`);
    }
    return { kind: 'url', ref: s };
  }
  if (/^[a-z]+:\/\//i.test(s)) throw new ListingError(`${what}：网址只支持 https://`);
  if (!isAbsolute(s)) throw new ListingError(`${what} 应是图片文件的完整路径（绝对路径）或 https 网址：${s}`);
  return { kind: 'file', ref: s };
}

export function aspectList(v, what) {
  if (v === undefined) return [];
  if (!isObj(v)) throw new ListingError(`${what} 应是对象：{"Brand": "Unbranded", "Color": ["Green", "Brown"]}`);
  const out = Object.entries(v).map(([name, values]) => {
    const n = str(name, `${what} 的属性名`, { max: LIMITS.aspectName });
    const arr = (Array.isArray(values) ? values : [values]).map((x) => str(typeof x === 'number' ? String(x) : x, `${what}「${n}」的值`, { max: LIMITS.aspectValue }));
    if (!arr.length) throw new ListingError(`${what}「${n}」至少要一个值`);
    if (arr.length > LIMITS.aspectValues) throw new ListingError(`${what}「${n}」最多 ${LIMITS.aspectValues} 个值`);
    return { name: n, values: [...new Set(arr)] };
  });
  if (out.length > LIMITS.aspects) throw new ListingError(`${what} 最多 ${LIMITS.aspects} 项`);
  const seen = new Set();
  for (const a of out) {
    const k = a.name.toLowerCase();
    if (seen.has(k)) throw new ListingError(`${what} 里属性「${a.name}」重复了`);
    seen.add(k);
  }
  return out;
}

function variationsOf(v, itemAspects) {
  if (v === undefined) return null;
  if (!isObj(v)) throw new ListingError('variations 应是对象：{ specifics: ["Size", "Color"], picture_by: "Color", items: [...] }');
  for (const k of Object.keys(v)) if (!['specifics', 'picture_by', 'items'].includes(k)) throw new ListingError(`variations 有未知字段 ${k}`);
  if (!Array.isArray(v.specifics) || !v.specifics.length || v.specifics.length > LIMITS.variationSpecifics) throw new ListingError(`variations.specifics 应是 1~${LIMITS.variationSpecifics} 个规格名，如 ["Size", "Color"]`);
  const names = v.specifics.map((n) => str(n, 'variations.specifics 的规格名', { max: LIMITS.aspectName }));
  const lower = names.map((n) => n.toLowerCase());
  if (new Set(lower).size !== names.length) throw new ListingError('variations.specifics 有重复的规格名');
  for (const a of itemAspects) if (lower.includes(a.name.toLowerCase())) throw new ListingError(`「${a.name}」已经是多规格的规格名，不要再写在 aspects 里`);
  let pictureBy = null;
  if (v.picture_by !== undefined) {
    pictureBy = names.find((n) => n.toLowerCase() === String(v.picture_by).trim().toLowerCase());
    if (!pictureBy) throw new ListingError('variations.picture_by 应是 specifics 里的一个规格名（按它配图）');
  }
  if (!Array.isArray(v.items) || !v.items.length || v.items.length > LIMITS.variations) throw new ListingError(`variations.items 应是 1~${LIMITS.variations} 个规格`);
  const skus = new Set();
  const combos = new Set();
  const items = v.items.map((it, i) => {
    const w = `variations.items[${i}]`;
    if (!isObj(it)) throw new ListingError(`${w} 应是对象`);
    for (const k of Object.keys(it)) if (!['sku', 'price', 'quantity', 'values', 'image'].includes(k)) throw new ListingError(`${w} 有未知字段 ${k}`);
    if (!isObj(it.values)) throw new ListingError(`${w}.values 应是对象，如 {"Size": "10x15cm", "Color": "MC Camo"}`);
    const keys = Object.keys(it.values);
    const values = {};
    for (const n of names) {
      const key = keys.find((k) => k.trim().toLowerCase() === n.toLowerCase());
      if (key === undefined) throw new ListingError(`${w}.values 缺少规格「${n}」`);
      values[n] = str(typeof it.values[key] === 'number' ? String(it.values[key]) : it.values[key], `${w}.values「${n}」`, { max: LIMITS.aspectValue });
    }
    if (keys.length !== names.length) throw new ListingError(`${w}.values 只能有 specifics 里的规格（${names.join('、')}）`);
    const combo = JSON.stringify(names.map((n) => values[n].toLowerCase()));
    if (combos.has(combo)) throw new ListingError(`${w} 和前面的规格组合重复：${names.map((n) => values[n]).join(' / ')}`);
    combos.add(combo);
    const sku = it.sku === undefined ? null : str(it.sku, `${w}.sku`, { max: LIMITS.sku });
    if (sku) {
      if (skus.has(sku.toLowerCase())) throw new ListingError(`${w}.sku 重复：${sku}`);
      skus.add(sku.toLowerCase());
    }
    return { sku, price: money(it.price, `${w}.price`), quantity: qty(it.quantity, `${w}.quantity`, 0), values, image: it.image === undefined ? null : imageRef(it.image, `${w}.image`) };
  });
  if (!items.some((it) => it.quantity > 0)) throw new ListingError('variations.items 至少一个规格的 quantity 要大于 0');
  if (pictureBy) {
    for (const value of new Set(items.map((it) => it.values[pictureBy]))) {
      if (!items.some((it) => it.values[pictureBy] === value && it.image)) throw new ListingError(`按「${pictureBy}」配图时，每个「${pictureBy}」都要有图：「${value}」没有 image`);
    }
  } else if (items.some((it) => it.image)) {
    throw new ListingError('规格配了 image 时要用 variations.picture_by 指定按哪个规格配图');
  }
  return { specifics: names, pictureBy, items };
}

/** 刊登参数校验 + 规范化（不访问网络） */
export function normalizeListing(a) {
  const title = str(a.title, 'title', { max: LIMITS.title });
  if (!/^\d{1,10}$/.test(String(a.category_id ?? ''))) throw new ListingError('category_id 应是叶子类目 ID（用 ebay_category_suggest 查）');
  const conditionId = a.condition_id ?? 1000;
  if (!Number.isInteger(conditionId) || conditionId < 1000 || conditionId > 7000) throw new ListingError('condition_id 应是 eBay 商品状态 ID（全新 = 1000，用 ebay_category_aspects 查这个类目能用哪些）');
  const description = descriptionHtml(str(a.description, 'description', { max: LIMITS.description }));
  if (!Array.isArray(a.images) || !a.images.length) throw new ListingError('images 至少一张图（图片文件完整路径或 https 网址），第一张是主图');
  if (a.images.length > LIMITS.images) throw new ListingError(`images 最多 ${LIMITS.images} 张`);
  const images = a.images.map((x, i) => imageRef(x, `images[${i}]`));
  const aspects = aspectList(a.aspects, 'aspects');
  const variations = variationsOf(a.variations, aspects);
  let price = null;
  let quantity = null;
  if (variations) {
    if (a.price !== undefined || a.quantity !== undefined) throw new ListingError('多规格商品的价格和数量写在 variations.items 里，不要再传 price / quantity');
    if (a.best_offer) throw new ListingError('多规格商品不能开议价（best_offer）');
  } else {
    price = money(a.price, 'price');
    quantity = qty(a.quantity, 'quantity', 1);
  }
  const sku = a.sku === undefined ? null : str(a.sku, 'sku', { max: LIMITS.sku });
  if (sku && variations) throw new ListingError('多规格商品的 SKU 写在 variations.items[].sku 里');
  const policies = a.policies === undefined ? {} : a.policies;
  if (!isObj(policies)) throw new ListingError('policies 应是对象：{ fulfillment_policy_id, return_policy_id, payment_policy_id }');
  for (const k of Object.keys(policies)) {
    if (!['fulfillment_policy_id', 'return_policy_id', 'payment_policy_id'].includes(k)) throw new ListingError(`policies 有未知字段 ${k}`);
    if (!POLICY_ID.test(String(policies[k]))) throw new ListingError(`policies.${k} 应是数字政策 ID（用 ebay_listing_defaults 查）`);
  }
  const location = a.location === undefined ? {} : a.location;
  if (!isObj(location)) throw new ListingError('location 应是对象：{ country, location, postal_code }');
  for (const k of Object.keys(location)) if (!['country', 'location', 'postal_code'].includes(k)) throw new ListingError(`location 有未知字段 ${k}`);
  if (location.country !== undefined && !/^[A-Z]{2}$/.test(location.country)) throw new ListingError('location.country 应是两位国家代码，如 CN、US');
  if (location.location !== undefined) str(location.location, 'location.location', { max: 45 });
  if (location.postal_code !== undefined) str(location.postal_code, 'location.postal_code', { max: 20 });
  if (a.best_offer !== undefined && typeof a.best_offer !== 'boolean') throw new ListingError('best_offer 应是 true / false');
  return {
    title, categoryId: String(a.category_id), conditionId, conditionDescription: a.condition_description === undefined ? null : str(a.condition_description, 'condition_description', { max: 1000 }),
    description, images, aspects, variations, price, quantity, sku, bestOffer: a.best_offer === true,
    policies: { fulfillment: policies.fulfillment_policy_id ?? null, return: policies.return_policy_id ?? null, payment: policies.payment_policy_id ?? null },
    location: { country: location.country ?? null, location: location.location?.trim() ?? null, postalCode: location.postal_code?.trim() ?? null },
  };
}

/** 没传的政策 / 发货地用店里已有 listing 的；还缺就报错 */
export function applyDefaults(listing, defaults) {
  const d = defaults?.defaults ?? {};
  const policies = {
    fulfillment: listing.policies.fulfillment ?? d.fulfillment_policy_id ?? null,
    return: listing.policies.return ?? d.return_policy_id ?? null,
    payment: listing.policies.payment ?? d.payment_policy_id ?? null,
  };
  for (const [k, v] of Object.entries(policies)) if (!v) throw new ListingError(`没有${{ fulfillment: '运费', return: '退货', payment: '付款' }[k]}政策：用 ebay_listing_defaults 看店里的政策，在 policies 里指定`);
  const known = (kind, id) => (defaults?.policies?.[kind] ?? []).some((p) => p.id === id);
  if (defaults?.policies) {
    if (!known('fulfillment', policies.fulfillment)) throw new ListingError(`运费政策 ${policies.fulfillment} 不是这家店的（用 ebay_listing_defaults 查）`);
    if (!known('return', policies.return)) throw new ListingError(`退货政策 ${policies.return} 不是这家店的`);
    if (!known('payment', policies.payment)) throw new ListingError(`付款政策 ${policies.payment} 不是这家店的`);
  }
  // 传了 location 就整组用传的（不和默认地址的城市 / 邮编混在一起）；没传才用店里已有商品的
  const given = Object.values(listing.location).some((v) => v);
  const location = given ? listing.location : { country: d.country ?? null, location: d.location ?? null, postalCode: d.postal_code ?? null };
  if (!location.country || !(location.location || location.postalCode)) {
    throw new ListingError(given ? 'location 要同时写 country 和 location（或 postal_code）' : '没有发货地：在 location 里写 country 和 location（或 postal_code）');
  }
  return { ...listing, policies, location };
}

export const nameValues = (list) => list.map((a) => tag('NameValueList', text('Name', a.name) + a.values.map((v) => text('Value', v)).join(''))).join('');

/** 拼 <Item>（pictures：图片引用 → eBay 图片地址） */
export function buildItemXml(listing, { pictures, uuid }) {
  const url = (img) => {
    const u = pictures.get(img.ref);
    if (!u) throw new Error(`图片还没上传：${img.ref}`);
    return u;
  };
  const parts = [
    text('Title', listing.title),
    tag('Description', cdata(listing.description)),
    tag('PrimaryCategory', text('CategoryID', listing.categoryId)),
    text('ConditionID', listing.conditionId),
    listing.conditionDescription ? text('ConditionDescription', listing.conditionDescription) : '',
    text('Country', listing.location.country),
    listing.location.location ? text('Location', listing.location.location) : '',
    listing.location.postalCode ? text('PostalCode', listing.location.postalCode) : '',
    text('Currency', 'USD'), text('Site', 'US'), text('ListingType', 'FixedPriceItem'), text('ListingDuration', 'GTC'),
    tag('PictureDetails', listing.images.map((img) => text('PictureURL', url(img))).join('')),
    listing.aspects.length ? tag('ItemSpecifics', nameValues(listing.aspects)) : '',
    tag('SellerProfiles',
      tag('SellerShippingProfile', text('ShippingProfileID', listing.policies.fulfillment))
      + tag('SellerReturnProfile', text('ReturnProfileID', listing.policies.return))
      + tag('SellerPaymentProfile', text('PaymentProfileID', listing.policies.payment))),
  ];
  if (listing.variations) {
    const v = listing.variations;
    const valuesOf = (n) => [...new Set(v.items.map((it) => it.values[n]))];
    const set = tag('VariationSpecificsSet', nameValues(v.specifics.map((n) => ({ name: n, values: valuesOf(n) }))));
    const vars = v.items.map((it) => tag('Variation',
      (it.sku ? text('SKU', it.sku) : '') + text('StartPrice', it.price.toFixed(2)) + text('Quantity', it.quantity)
      + tag('VariationSpecifics', nameValues(v.specifics.map((n) => ({ name: n, values: [it.values[n]] })))))).join('');
    let pics = '';
    if (v.pictureBy) {
      pics = tag('Pictures', text('VariationSpecificName', v.pictureBy) + valuesOf(v.pictureBy).map((value) => {
        const urls = [...new Set(v.items.filter((it) => it.values[v.pictureBy] === value && it.image).map((it) => url(it.image)))];
        return tag('VariationSpecificPictureSet', text('VariationSpecificValue', value) + urls.map((u) => text('PictureURL', u)).join(''));
      }).join(''));
    }
    parts.push(tag('Variations', set + vars + pics));
  } else {
    parts.push(text('StartPrice', listing.price.toFixed(2)), text('Quantity', listing.quantity));
    if (listing.sku) parts.push(text('SKU', listing.sku));
    if (listing.bestOffer) parts.push(tag('BestOfferDetails', text('BestOfferEnabled', 'true')));
  }
  parts.push(text('UUID', uuid));
  return tag('Item', parts.join(''));
}

/** 给人看的摘要（预检结果里让用户核对） */
export function listingSummary(listing, defaults) {
  const policyName = (kind, id) => (defaults?.policies?.[kind] ?? []).find((p) => p.id === id)?.name ?? null;
  return {
    title: listing.title,
    category_id: listing.categoryId,
    condition_id: listing.conditionId,
    images: listing.images.length,
    aspects: Object.fromEntries(listing.aspects.map((a) => [a.name, a.values.length === 1 ? a.values[0] : a.values])),
    ...(listing.variations
      ? { variations: listing.variations.items.map((it) => ({ ...it.values, sku: it.sku, price: it.price, quantity: it.quantity })), picture_by: listing.variations.pictureBy }
      : { price: listing.price, quantity: listing.quantity, sku: listing.sku, best_offer: listing.bestOffer }),
    policies: {
      fulfillment: { id: listing.policies.fulfillment, name: policyName('fulfillment', listing.policies.fulfillment) },
      return: { id: listing.policies.return, name: policyName('return', listing.policies.return) },
      payment: { id: listing.policies.payment, name: policyName('payment', listing.policies.payment) },
    },
    location: { country: listing.location.country, location: listing.location.location, postal_code: listing.location.postalCode },
    description_chars: listing.description.length,
  };
}

/** 所有要上传的图片（主图 + 规格图），去重 */
export const allImages = (listing) => {
  const map = new Map();
  for (const img of [...listing.images, ...(listing.variations?.items ?? []).map((it) => it.image).filter(Boolean)]) map.set(img.ref, img);
  return [...map.values()];
};

// ---- 图片 ----
const IMAGE_MAGIC = [
  [0, [0xff, 0xd8, 0xff]], [0, [0x89, 0x50, 0x4e, 0x47]], [0, [0x47, 0x49, 0x46, 0x38]], [0, [0x42, 0x4d]],
  [0, [0x49, 0x49, 0x2a, 0x00]], [0, [0x4d, 0x4d, 0x00, 0x2a]],
];
/** 只上传真的图片文件（看文件头），防止把别的本地文件传出去 */
export function isImageBytes(buf) {
  if (IMAGE_MAGIC.some(([off, sig]) => sig.every((b, i) => buf[off + i] === b))) return true;
  const s = buf.subarray(0, 12).toString('latin1');
  if (s.startsWith('RIFF') && s.slice(8, 12) === 'WEBP') return true;
  return s.slice(4, 8) === 'ftyp' && /^(heic|heix|mif1|msf1|avif|avis)$/.test(s.slice(8, 12));
}

/**
 * 读本地图片：先打开再通过同一个文件句柄检查类型和大小（检查的就是要上传的内容，中途被换掉也不会传别的东西）；
 * 非阻塞打开，管道 / 设备文件不会卡住；最多读 12MB + 1 字节，超了就报错；读出来的内容再验一次图片文件头。
 */
export async function readImageFile(path) {
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch {
    throw new ListingError(`找不到图片文件或打不开：${path}`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new ListingError(`不是普通文件：${path}`);
    if (st.size > LIMITS.imageBytes) throw new ListingError(`图片太大（超过 12MB）：${basename(path)}`);
    const chunks = [];
    let total = 0;
    const chunk = Buffer.alloc(1 << 20);
    for (;;) {
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > LIMITS.imageBytes) throw new ListingError(`图片太大（超过 12MB）：${basename(path)}`);
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    const data = Buffer.concat(chunks);
    if (data.length < 100) throw new ListingError(`图片文件是空的或太小：${basename(path)}`);
    if (!isImageBytes(data)) throw new ListingError(`不是图片文件（只支持 JPG / PNG / GIF / BMP / TIFF / WEBP / HEIC / AVIF）：${basename(path)}`);
    return data;
  } finally {
    await fh.close();
  }
}

/**
 * 上传到 eBay 图片服务；同一张图（按内容 / 网址）在 eBay 给的有效期内不重复上传（离过期不到 2 天就重传，保证预检后发布时图还在）。
 * upload(img, data) 返回 { url, expiresAt }。
 */
export function createImageUploader({ dir, upload, now = () => Date.now() }) {
  const file = join(dir, 'eps-images.json');
  const usable = (v) => Boolean(v?.url) && (v.exp ? v.exp - 2 * 24 * 3600_000 > now() : v.at > now() - IMAGE_CACHE_TTL_MS);
  const load = () => {
    try {
      const d = JSON.parse(readFileSync(file, 'utf8'));
      return isObj(d) ? d : {};
    } catch {
      return {};
    }
  };
  const save = (entries) => {
    try {
      const data = load();
      Object.assign(data, entries);
      for (const [k, v] of Object.entries(data)) if (!usable(v)) delete data[k];
      writeFileAtomic(file, JSON.stringify(data));
    } catch {
      // 缓存写不了不影响上传结果
    }
  };
  return async function uploadAll(images, { concurrency = 3 } = {}) {
    const cache = load();
    const out = new Map();
    const fresh = {};
    const running = new Map(); // 这一轮里内容相同的图只传一次
    const queue = [...images];
    const worker = async () => {
      for (let img = queue.shift(); img; img = queue.shift()) {
        const data = img.kind === 'file' ? await readImageFile(img.ref) : null;
        const key = data ? `sha256:${createHash('sha256').update(data).digest('hex')}` : `url:${img.ref}`;
        const hit = cache[key];
        if (usable(hit)) {
          out.set(img.ref, hit.url);
          continue;
        }
        if (!running.has(key)) {
          running.set(key, upload(img, data).then(({ url, expiresAt }) => {
            fresh[key] = { url, at: now(), exp: expiresAt ?? null };
            return url;
          }));
        }
        out.set(img.ref, await running.get(key));
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, images.length) }, worker));
    } finally {
      if (Object.keys(fresh).length) save(fresh);
    }
    return out;
  };
}


// ---- 店里已有 listing 的默认值 ----
/** GetItem 返回里取发货地和三个政策（Item 自己的 Site，不是 Seller 的） */
export function parseItemDefaults(xml) {
  const item = (pick(xml, 'Item') ?? '').replace(/<Seller>[\s\S]*?<\/Seller>/g, '');
  const prof = pick(item, 'SellerProfiles') ?? '';
  return {
    site: pickText(item, 'Site') ?? null,
    country: pickText(item, 'Country') ?? null,
    location: pickText(item, 'Location') ?? null,
    postal_code: pickText(item, 'PostalCode') ?? null,
    fulfillment_policy_id: pickText(pick(prof, 'SellerShippingProfile') ?? '', 'ShippingProfileID') ?? null,
    return_policy_id: pickText(pick(prof, 'SellerReturnProfile') ?? '', 'ReturnProfileID') ?? null,
    payment_policy_id: pickText(pick(prof, 'SellerPaymentProfile') ?? '', 'PaymentProfileID') ?? null,
    category_id: pickText(pick(item, 'PrimaryCategory') ?? '', 'CategoryID') ?? null,
  };
}

/** 几条 listing 里最常见的组合 */
export function pickDefaults(list) {
  const keyOf = (d) => JSON.stringify([d.country, d.location, d.postal_code, d.fulfillment_policy_id, d.return_policy_id, d.payment_policy_id]);
  const counts = new Map();
  for (const d of list.filter((x) => x.country && x.fulfillment_policy_id)) counts.set(keyOf(d), { d, n: (counts.get(keyOf(d))?.n ?? 0) + 1 });
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  if (!best) return null;
  const { country, location, postal_code, fulfillment_policy_id, return_policy_id, payment_policy_id } = best.d;
  return { country, location, postal_code, fulfillment_policy_id, return_policy_id, payment_policy_id, from_listings: best.n, of_listings: list.length };
}

export const activeItemIds = (xml) => [...new Set(pickAll(pick(xml, 'ActiveList') ?? '', 'ItemID').map((v) => decode(v).trim()))];

// ---- 预检记录 ----
export const ID = /^[a-f0-9]{16}$/;
/** 发出去了但不知道结果的状态 */
export const UNRESOLVED = new Set(['sending', 'unknown']);
export const newPreviewId = () => randomBytes(8).toString('hex');
export const newUuid = () => randomBytes(16).toString('hex').toUpperCase();

export function createPreviewStore({ dir, now = () => Date.now() }) {
  const root = join(dir, 'listing-previews');
  const path = (id) => join(root, `${id}.json`);
  const write = (rec) => writeFileAtomic(path(rec.id), JSON.stringify(rec));
  /** 清理 7 天前的记录；结果还不确定或只执行了一部分（sending / unknown / partial）的记录一直留着（要靠它对账） */
  const cleanup = () => {
    let files = [];
    try {
      files = readdirSync(root);
    } catch {
      return; // 目录还不存在
    }
    for (const f of files) {
      const p = join(root, f);
      try {
        const age = now() - statSync(p).mtimeMs;
        if (f.endsWith('.tmp')) {
          if (age > 24 * 3600_000) unlinkSync(p);
          continue;
        }
        if (!f.endsWith('.json') || age <= 7 * 24 * 3600_000) continue;
        const rec = JSON.parse(readFileSync(p, 'utf8'));
        if (UNRESOLVED.has(rec?.status) || rec?.status === 'partial') continue;
        unlinkSync(p);
      } catch {
        // 读不了的文件不动
      }
    }
  };
  const load = (id) => {
    if (!ID.test(String(id ?? ''))) throw new ListingError('preview_id 格式不对（用 ebay_listing_preview 返回的 preview_id）');
    try {
      return JSON.parse(readFileSync(path(id), 'utf8'));
    } catch {
      throw new ListingError(`找不到预检记录 ${id}（可能已超过 7 天被清理），请重新预检`);
    }
  };
  return {
    save(rec) {
      cleanup();
      write(rec);
      return rec;
    },
    load,
    update(id, patch) {
      const rec = { ...load(id), ...patch };
      write(rec);
      return rec;
    },
    expired: (rec) => now() - Date.parse(rec.created_at) > PREVIEW_TTL_MS,
  };
}

/** AddFixedPriceItem 重复 UUID（488）时 eBay 会在错误参数里带上已有的 ItemID */
export function duplicateItemId(errors) {
  const dup = errors.find((e) => e.code === '488');
  if (!dup) return null;
  return dup.params.find((p) => /^\d{9,15}$/.test(p)) ?? '';
}

/**
 * 发布一条预检记录。lock(id, fn) 是跨进程的「这条预检」锁；锁内重新读记录再决定，状态都在锁内更新。
 * - 已发布过：直接返回原来的 ItemID，不再调用
 * - 发送前先把状态记成 sending；没收到明确回复记成 unknown。sending / unknown 的记录可以随时用同一个 preview_id 重发
 *   （同一个 XML 和 UUID，eBay 认出重复会返回 488 和原 ItemID），不受 24 小时限制，也不要重新预检（新预检是新 UUID）
 * - 第一次发布（ready）或 eBay 明确拒绝过（failed）时，超过 24 小时要重新预检
 * - add() 明确没发出去（令牌被拒、参数错误等）时状态退回去
 */
export async function publishPreview({ previews, id, storeId, add, describe, lock, now = () => new Date().toISOString() }) {
  return lock(id, async () => {
    const rec = previews.load(id);
    if (rec.kind && rec.kind !== 'publish') throw new ListingError(rec.kind === 'ad' ? '这是广告修改记录，用 ebay_ad_change_apply 执行' : '这是修改已有 listing 的预检，用 ebay_listing_apply 执行');
    if (rec.store_id !== storeId) throw new ListingError('这条预检不是这家店的（shop 参数要和预检时一样）');
    if (rec.status === 'published') return { ok: true, item_id: rec.item_id ?? null, already_published: true, rec };
    const recovering = UNRESOLVED.has(rec.status);
    if (!recovering && previews.expired(rec)) throw new ListingError('预检已超过 24 小时，请重新预检后再发布');
    previews.update(id, { status: 'sending', attempts: (rec.attempts ?? 0) + 1, sending_at: now() });
    let r;
    try {
      r = await add(rec.item_xml);
    } catch (err) {
      if (!err?.unknownOutcome) {
        previews.update(id, { status: recovering ? 'unknown' : rec.status });
        throw err;
      }
      previews.update(id, { status: 'unknown', unknown_at: now() });
      throw new ListingError('发布请求没有收到 eBay 的明确回复，不确定是否已刊登。先到 Seller Hub → Listings 看有没有这个商品；'
        + '不要重新预检，用同一个 preview_id 再调一次 ebay_listing_publish（同一个 UUID，eBay 不会重复刊登，已刊登会返回原来的 ItemID）。');
    }
    const dup = duplicateItemId(r.errors);
    if (dup !== null) {
      previews.update(id, { status: 'published', item_id: dup || null, published_at: now() });
      return { ok: true, item_id: dup || null, already_published: true, rec };
    }
    if (r.ack !== 'Success' && r.ack !== 'Warning') {
      // 对账重发时 eBay 报错，并不能说明最早那次没刊登成功：保持 unknown，之后还能用同一个 UUID 再对账
      if (recovering) {
        previews.update(id, { status: 'unknown', last_retry_failed_at: now() });
        return { ok: false, still_unknown: true, errors: describe(r.errors), warnings: describe(r.warnings), rec };
      }
      previews.update(id, { status: 'failed', failed_at: now() });
      return { ok: false, errors: describe(r.errors), warnings: describe(r.warnings), rec };
    }
    const itemId = pickText(r.xml, 'ItemID') ?? null;
    previews.update(id, { status: 'published', item_id: itemId, published_at: now() });
    return { ok: true, item_id: itemId, xml: r.xml, warnings: describe(r.warnings), rec };
  });
}
