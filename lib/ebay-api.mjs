// eBay 开放平台调用：REST（Account / Taxonomy / Metadata）和 Trading API（XML，刊登用）。
// 只把 eBay 返回的错误分类后给出；令牌不出现在任何报错里。
export class ApiError extends Error {}
/** 令牌被 eBay 拒绝：调用方丢掉缓存的令牌 */
export class TokenRejectedError extends ApiError {}

export const API_BASE = 'https://api.ebay.com';
export const TRADING_URL = 'https://api.ebay.com/ws/api.dll';
export const TRADING_LEVEL = '1349';
export const SITE_US = '0';

// ---- XML ----
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
export const tag = (name, inner) => `<${name}>${inner}</${name}>`;
export const text = (name, value) => tag(name, esc(value));
/** CDATA 里不能出现 ]]>，拆开 */
export const cdata = (s) => `<![CDATA[${String(s).replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;

export function decode(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
/** 取所有 <name>…</name>（含带属性的写法）的内容 */
export const pickAll = (xml, name) => [...String(xml ?? '').matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);
export const pick = (xml, name) => pickAll(xml, name)[0];
export const pickText = (xml, name) => {
  const v = pick(xml, name);
  return v === undefined ? undefined : decode(v).trim();
};

/** Trading API 的 <Errors>：severity Error / Warning */
export function parseErrors(xml) {
  return pickAll(xml, 'Errors').map((b) => ({
    severity: pickText(b, 'SeverityCode') ?? 'Error',
    code: pickText(b, 'ErrorCode') ?? '',
    message: pickText(b, 'LongMessage') || pickText(b, 'ShortMessage') || '',
    params: pickAll(b, 'Value').map((v) => decode(v).trim()),
  }));
}

/** <Fees>：只留不为 0 的费用；ListingFee 是 eBay 算好的合计 */
export function parseFees(xml) {
  const block = pick(xml, 'Fees') ?? '';
  const fees = [...block.matchAll(/<Fee>\s*<Name>([^<]*)<\/Name>\s*<Fee currencyID="([A-Z]{3})">(-?[\d.]+)<\/Fee>/g)]
    .map((m) => ({ name: decode(m[1]), currency: m[2], amount: Number(m[3]) }));
  const total = fees.find((f) => f.name === 'ListingFee');
  const items = fees.filter((f) => f.name !== 'ListingFee' && f.amount !== 0);
  return { total: total ? total.amount : Math.round(items.reduce((s, f) => s + f.amount, 0) * 100) / 100, currency: total?.currency ?? items[0]?.currency ?? 'USD', items };
}

const AUTH_CODES = new Set(['931', '932', '16110', '21916984', '21917053', '17470']);
const LIMIT_CODES = new Set(['518', '21919144']);

/** Trading API 调用。body 是请求里面的 XML（不含外层） */
export async function tradingCall({ token, call, body = '', fetchImpl = fetch, timeoutMs = 60_000 }) {
  const xml = `<?xml version="1.0" encoding="utf-8"?><${call}Request xmlns="urn:ebay:apis:eBLBaseComponents">${body}</${call}Request>`;
  const headers = { 'X-EBAY-API-CALL-NAME': call, 'X-EBAY-API-SITEID': SITE_US, 'X-EBAY-API-COMPATIBILITY-LEVEL': TRADING_LEVEL, 'X-EBAY-API-IAF-TOKEN': token,
    'Content-Type': 'text/xml;charset=utf-8' };
  let res;
  try {
    res = await fetchImpl(TRADING_URL, { method: 'POST', headers, body: xml, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw Object.assign(new ApiError(`调用 eBay 接口 ${call} 没有返回（网络问题或超时）`), { unknownOutcome: true, cause: err });
  }
  let out;
  try {
    out = await res.text();
  } catch (err) {
    // 响应头到了、正文断了：请求可能已经生效
    throw Object.assign(new ApiError(`调用 eBay 接口 ${call} 没有收到完整回复（网络问题或超时）`), { unknownOutcome: true, cause: err });
  }
  if (res.status === 401) throw new TokenRejectedError('eBay 拒绝了店铺授权令牌');
  if (res.status >= 500) throw Object.assign(new ApiError(`eBay 接口 ${call} 出错（HTTP ${res.status}），稍后再试`), { unknownOutcome: true });
  if (res.status !== 200) throw new ApiError(`eBay 接口 ${call} 出错（HTTP ${res.status}）`);
  const ack = pickText(out, 'Ack');
  if (!ack) throw Object.assign(new ApiError(`eBay 接口 ${call} 返回的内容看不懂`), { unknownOutcome: true });
  const all = parseErrors(out);
  const errors = all.filter((e) => e.severity !== 'Warning');
  const warnings = all.filter((e) => e.severity === 'Warning');
  if (ack === 'Failure' || ack === 'PartialFailure') {
    if (errors.some((e) => AUTH_CODES.has(e.code))) throw new TokenRejectedError('eBay 拒绝了店铺授权令牌');
    if (errors.some((e) => LIMIT_CODES.has(e.code))) throw new ApiError('eBay 接口调用次数到上限了，明天再试');
  }
  return { ack, errors, warnings, xml: out };
}

/** REST 调用，返回 JSON；4xx 给出 eBay 的错误说明（截短） */
export async function restCall({ token, path, method = 'GET', body, fetchImpl = fetch, timeoutMs = 30_000 }) {
  let res;
  try {
    res = await fetchImpl(`${API_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Accept-Language': 'en-US', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ApiError('连不上 eBay 接口（网络问题或超时），稍后再试');
  }
  const json = await res.json().catch(() => null);
  if (res.status === 401) throw new TokenRejectedError('eBay 拒绝了授权令牌');
  if (res.status === 429) throw new ApiError('eBay 接口调用太频繁，稍后再试');
  if (res.status === 204) return {};
  if (!res.ok) {
    const msg = json?.errors?.map((e) => e.longMessage || e.message).filter(Boolean).join('；') || '';
    throw Object.assign(new ApiError(`eBay 接口出错（HTTP ${res.status}）${msg ? `：${msg.slice(0, 300)}` : ''}`),
      { status: res.status, codes: (json?.errors ?? []).map((e) => e.errorId).filter((x) => x !== undefined) });
  }
  return json ?? {};
}

// ---- 图片：Media API（Trading 的 UploadSiteHostedPictures 已于 2026-09-30 停用）----
export const MEDIA_BASE = 'https://apim.ebay.com/commerce/media/v1_beta';
const MIME = [[[0xff, 0xd8, 0xff], 'image/jpeg'], [[0x89, 0x50, 0x4e, 0x47], 'image/png'], [[0x47, 0x49, 0x46, 0x38], 'image/gif'], [[0x42, 0x4d], 'image/bmp'],
  [[0x49, 0x49, 0x2a, 0x00], 'image/tiff'], [[0x4d, 0x4d, 0x00, 0x2a], 'image/tiff']];
export function imageMime(buf) {
  for (const [sig, type] of MIME) if (sig.every((b, i) => buf[i] === b)) return type;
  const s = buf.subarray(0, 12).toString('latin1');
  if (s.startsWith('RIFF') && s.slice(8, 12) === 'WEBP') return 'image/webp';
  if (s.slice(4, 8) === 'ftyp') return /^avi[fs]$/.test(s.slice(8, 12)) ? 'image/avif' : 'image/heic';
  return 'application/octet-stream';
}

/** 上传一张图到 eBay 图片服务：本地文件（data）走 create_image_from_file，网址走 create_image_from_url。返回 { url, expiresAt } */
export async function uploadImage({ token, ref, data, filename = 'image.jpg', fetchImpl = fetch, timeoutMs = 120_000 }) {
  let res;
  try {
    if (data) {
      const form = new FormData();
      form.append('image', new Blob([data], { type: imageMime(data) }), filename.replace(/[^\w.-]/g, '_') || 'image.jpg');
      res = await fetchImpl(`${MEDIA_BASE}/image/create_image_from_file`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(timeoutMs) });
    } else {
      res = await fetchImpl(`${MEDIA_BASE}/image/create_image_from_url`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ imageUrl: ref }), signal: AbortSignal.timeout(timeoutMs),
      });
    }
  } catch {
    throw new ApiError('上传图片时连不上 eBay（网络问题或超时），稍后再试');
  }
  const json = await res.json().catch(() => null);
  if (res.status === 401) throw new TokenRejectedError('eBay 拒绝了店铺授权令牌');
  if (!res.ok || !json?.imageUrl) {
    const msg = json?.errors?.map((e) => e.longMessage || e.message).filter(Boolean).join('；') || '';
    throw new ApiError(`图片上传失败（HTTP ${res.status}）${msg ? `：${msg.slice(0, 300)}` : ''}`);
  }
  return { url: json.imageUrl, expiresAt: Date.parse(json.expirationDate ?? '') || null };
}

/** 错误 / 警告给人看：[代码] 说明 */
export const describe = (list) => list.map((e) => `[${e.code}] ${e.message}`.slice(0, 500));
