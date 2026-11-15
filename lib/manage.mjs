// 已有 listing：列表、详情（Trading API GetMyeBaySelling / GetItem）。
// 只请求在售 / 未售出两个列表，显式排除已售列表（里面有买家信息）。
import { decode, pick, pickAll, pickText } from './ebay-api.mjs';

export const LIST_STATUS = { active: 'ActiveList', unsold: 'UnsoldList' };
const OFF = ['SoldList', 'DeletedFromSoldList', 'DeletedFromUnsoldList', 'ScheduledList', 'BidList', 'SellingSummary']
  .map((n) => `<${n}><Include>false</Include></${n}>`).join('');

/** GetMyeBaySelling 请求体：只要一个列表，其余（尤其已售列表）都不要 */
export function sellingRequest({ status = 'active', page = 1, pageSize = 50, sort } = {}) {
  const name = LIST_STATUS[status];
  if (!name) throw new Error(`未知列表：${status}`);
  const other = Object.values(LIST_STATUS).filter((n) => n !== name).map((n) => `<${n}><Include>false</Include></${n}>`).join('');
  return `<${name}><Include>true</Include>${sort ? `<Sort>${sort}</Sort>` : ''}<Pagination><EntriesPerPage>${pageSize}</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></${name}>${other}${OFF}`;
}

const num = (v) => {
  const n = Number(v);
  return v === undefined || v === '' || !Number.isFinite(n) ? null : n;
};
/** 金额标签上的币种：<CurrentPrice currencyID="USD"> */
const currencyOf = (xml, name) => String(xml ?? '').match(new RegExp(`<${name}\\s[^>]*currencyID="([A-Z]{3})"`))?.[1] ?? null;
const nameValues = (xml) => pickAll(xml ?? '', 'NameValueList').map((b) => ({ name: pickText(b, 'Name') ?? '', values: pickAll(b, 'Value').map((v) => decode(v).trim()) }));

function variationRows(xml) {
  return pickAll(pick(xml, 'Variations') ?? '', 'Variation').map((v) => {
    const total = num(pickText(v, 'Quantity'));
    const sold = num(pickText(pick(v, 'SellingStatus') ?? '', 'QuantitySold')) ?? 0;
    return {
      sku: pickText(v, 'SKU') ?? null,
      values: Object.fromEntries(nameValues(pick(v, 'VariationSpecifics')).map((nv) => [nv.name, nv.values[0] ?? ''])),
      price: num(pickText(v, 'StartPrice')),
      quantity_available: total === null ? null : Math.max(0, total - sold),
      quantity_sold: sold,
    };
  });
}

/** 在售 / 未售出列表 */
export function parseSellingList(xml, status = 'active') {
  const block = pick(xml, LIST_STATUS[status]) ?? '';
  const items = pickAll(pick(block, 'ItemArray') ?? '', 'Item').map((it) => {
    const variations = variationRows(it);
    const id = pickText(it, 'ItemID');
    const qtyTotal = num(pickText(it, 'Quantity'));
    const available = num(pickText(it, 'QuantityAvailable'));
    const prices = variations.map((v) => v.price).filter((p) => p !== null);
    return {
      item_id: id,
      title: pickText(it, 'Title') ?? '',
      sku: pickText(it, 'SKU') ?? null,
      price: num(pickText(pick(it, 'SellingStatus') ?? '', 'CurrentPrice')) ?? num(pickText(it, 'StartPrice')),
      currency: currencyOf(it, 'CurrentPrice') ?? currencyOf(it, 'StartPrice'),
      price_max: prices.length ? Math.max(...prices) : null,
      quantity_available: available ?? (variations.length ? variations.reduce((s, v) => s + (v.quantity_available ?? 0), 0) : qtyTotal),
      quantity_sold: variations.length ? variations.reduce((s, v) => s + v.quantity_sold, 0) : num(pickText(pick(it, 'SellingStatus') ?? '', 'QuantitySold')),
      watchers: num(pickText(it, 'WatchCount')),
      variations: variations.length,
      time_left: pickText(it, 'TimeLeft') ?? null,
      end_time: pickText(pick(it, 'ListingDetails') ?? '', 'EndTime') ?? null,
      url: id ? `https://www.ebay.com/itm/${id}` : null,
    };
  });
  const pr = pick(block, 'PaginationResult') ?? '';
  return { total: num(pickText(pr, 'TotalNumberOfEntries')) ?? items.length, pages: num(pickText(pr, 'TotalNumberOfPages')) ?? 1, items };
}

/** GetItem → 改商品要用到的全部信息（不含卖家 / 买家信息） */
export function parseItemDetail(xml) {
  const item = (pick(xml, 'Item') ?? '').replace(/<Seller>[\s\S]*?<\/Seller>/g, '');
  const status = pick(item, 'SellingStatus') ?? '';
  const prof = pick(item, 'SellerProfiles') ?? '';
  const vXml = pick(item, 'Variations');
  const id = pickText(item, 'ItemID');
  let variations = null;
  if (vXml) {
    const pics = pick(vXml, 'Pictures');
    variations = {
      specifics: nameValues(pick(vXml, 'VariationSpecificsSet')),
      picture_by: pics ? pickText(pics, 'VariationSpecificName') ?? null : null,
      pictures: pics ? Object.fromEntries(pickAll(pics, 'VariationSpecificPictureSet').map((s) => [pickText(s, 'VariationSpecificValue') ?? '', pickAll(s, 'PictureURL').map((u) => decode(u).trim())])) : {},
      items: variationRows(item),
    };
  }
  const total = num(pickText(item, 'Quantity'));
  const sold = num(pickText(status, 'QuantitySold')) ?? 0;
  const profile = (outer, idTag, nameTag) => {
    const b = pick(prof, outer) ?? '';
    const pid = pickText(b, idTag);
    return pid ? { id: pid, name: pickText(b, nameTag) ?? null } : null;
  };
  const description = (() => {
    const d = pick(item, 'Description');
    return d === undefined ? '' : decode(d);
  })();
  return {
    item_id: id,
    title: pickText(item, 'Title') ?? '',
    status: pickText(status, 'ListingStatus') ?? null,
    url: id ? `https://www.ebay.com/itm/${id}` : null,
    listing_type: pickText(item, 'ListingType') ?? null,
    category: { id: pickText(pick(item, 'PrimaryCategory') ?? '', 'CategoryID') ?? null, name: pickText(pick(item, 'PrimaryCategory') ?? '', 'CategoryName') ?? null },
    condition: { id: num(pickText(item, 'ConditionID')), name: pickText(item, 'ConditionDisplayName') ?? null, description: pickText(item, 'ConditionDescription') ?? null },
    currency: pickText(item, 'Currency') ?? null,
    site: pickText(item, 'Site') ?? null,
    sku: pickText(item, 'SKU') ?? null,
    price: variations ? null : num(pickText(item, 'StartPrice')),
    quantity_available: variations ? null : (total === null ? null : Math.max(0, total - sold)),
    quantity_sold: variations ? variations.items.reduce((s, v) => s + v.quantity_sold, 0) : sold,
    best_offer: pickText(pick(item, 'BestOfferDetails') ?? '', 'BestOfferEnabled') === 'true',
    images: pickAll(pick(item, 'PictureDetails') ?? '', 'PictureURL').map((u) => decode(u).trim()),
    aspects: Object.fromEntries(nameValues(pick(item, 'ItemSpecifics')).map((nv) => [nv.name, nv.values.length === 1 ? nv.values[0] : nv.values])),
    variations,
    policies: {
      fulfillment: profile('SellerShippingProfile', 'ShippingProfileID', 'ShippingProfileName'),
      return: profile('SellerReturnProfile', 'ReturnProfileID', 'ReturnProfileName'),
      payment: profile('SellerPaymentProfile', 'PaymentProfileID', 'PaymentProfileName'),
    },
    location: { country: pickText(item, 'Country') ?? null, location: pickText(item, 'Location') ?? null, postal_code: pickText(item, 'PostalCode') ?? null },
    start_time: pickText(pick(item, 'ListingDetails') ?? '', 'StartTime') ?? null,
    end_time: pickText(pick(item, 'ListingDetails') ?? '', 'EndTime') ?? null,
    relisted_item_id: pickText(pick(item, 'ListingDetails') ?? '', 'RelistedItemID') ?? null,
    description,
  };
}
