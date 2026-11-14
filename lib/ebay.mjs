// 在 eBay Seller Hub「Research」工作标签页里发请求（带这家店的登录态和紫鸟代理 IP），分辨登录失效 / 安全验证。
import { CHALLENGE_STUCK, LOGIN_EXPIRED } from './browser.mjs';
import { requestInPage } from './page-request.mjs';

export class EbayError extends Error {}

export const GRAPHQL_URL = 'https://www.ebay.com/sh/research/graphql';

const VERIFY = '触发了 eBay 安全验证（浏览器检查 / 验证码 / 请求太频繁）：请在紫鸟店铺浏览器里打开 eBay 页面，等它通过或完成验证后再试，不要反复重试';
const REDIRECTED = '触发了 eBay 安全验证或登录已失效（请求被转到了验证 / 登录页）：请在紫鸟店铺浏览器里打开 eBay 看看要登录还是要验证，处理后再试，不要反复重试';
export { CHALLENGE_STUCK, LOGIN_EXPIRED, VERIFY };

const CHALLENGE_TEXT = /splashui\/(challenge|captcha)|Pardon Our Interruption|captcha|Access Denied/i;
const LOGIN_TEXT = /signin\.ebay\.com|<title>[^<]*Sign in/i;

/** 非 JSON 的返回：验证页 / 登录页 / 其他 */
export function explainPage(r, fallback) {
  const head = `${r?.url ?? ''} ${String(r?.text ?? '').slice(0, 4000)}`;
  if (CHALLENGE_TEXT.test(head)) return VERIFY;
  if (LOGIN_TEXT.test(head)) return LOGIN_EXPIRED;
  return fallback;
}

/** 请求层面的失败（跳转、限流、拒绝）统一在这里分辨 */
export function checkResponse(r, what) {
  if (!r || r.error) throw new Error(`${what}请求失败：${r?.error || '无返回'}`);
  if (r.redirected) throw new EbayError(REDIRECTED);
  if (r.status === 429) throw new EbayError(VERIFY);
  if (r.status === 401) throw new EbayError(LOGIN_EXPIRED);
  if (r.status === 403) throw new EbayError(explainPage(r, VERIFY));
}

const AUTH_ERROR = /unauthori[sz]ed|unauthenticated|not logged|authenticat|sign ?in|session/i;
const BLOCK_ERROR = /captcha|rate.?limit|too many|throttl|blocked|forbidden|denied/i;

/** GraphQL errors 分类；对外只给分类后的说明，不原样输出服务端消息（可能带内部 ID / 地址） */
export function classifyGraphqlErrors(errors) {
  const text = errors.map((e) => `${e?.message ?? ''} ${e?.extensions?.code ?? ''} ${e?.extensions?.classification ?? ''}`).join(' ');
  if (AUTH_ERROR.test(text)) return LOGIN_EXPIRED;
  if (BLOCK_ERROR.test(text)) return VERIFY;
  const code = errors.map((e) => e?.extensions?.code ?? e?.extensions?.classification).find((c) => typeof c === 'string' && /^[A-Z0-9_]{2,40}$/.test(c));
  return `Terapeak 查询失败（GraphQL 错误${code ? ` ${code}` : ''}）：参数可能不被支持，或 eBay 接口改版了`;
}

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/**
 * GraphQL 部分失败：哪些 errors 会影响我们用到的数据。
 * 带 path 的错误：path 落在 consumes 列出的分支下（如 ['soldSearchResults','listingMetrics','nextPageAvailable']）就算影响；
 * 只落在内部诊断字段 diagnostic 上的忽略。没有 path 的错误分不清影响范围，保守地算影响。
 */
export function errorsAffect(errors, consumes) {
  return errors.some((e) => {
    const path = Array.isArray(e?.path) ? e.path.map(String) : null;
    if (!path?.length) return true;
    if (path.includes('diagnostic')) return false;
    return consumes.some((c) => {
      const parts = c.split('.');
      return parts.every((p, i) => path[i] === p);
    });
  });
}

/**
 * 返回 graphql(query, variables, extra, { require, consumes }) → data。
 * require：必须有的分支（如 'terapeakResearch.summary'），没有就当接口异常抛出（不会被当成空结果缓存）。
 * consumes：会用到的分支（前缀）；errors 里有落在这些分支下的错误，就当这次查询失败（部分失败不当成功缓存）。
 */
export function createTerapeakApi(cdp, request = requestInPage) {
  return async function graphql(query, variables, extra = {}, { require: required, consumes = [] } = {}) {
    const r = await request(cdp, {
      url: GRAPHQL_URL, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables, ...extra }),
    });
    checkResponse(r, 'Terapeak ');
    let json;
    try {
      json = JSON.parse(r.text);
    } catch {
      throw new EbayError(explainPage(r, `Terapeak 返回的不是 JSON（HTTP ${r.status}）`));
    }
    const errors = Array.isArray(json?.errors) ? json.errors : [];
    // 有 errors 就先分类：登录 / 验证优先失败，哪怕同时带了部分数据
    if (errors.length) {
      const kind = classifyGraphqlErrors(errors);
      const missing = required && get(json?.data, required) == null;
      if (kind === LOGIN_EXPIRED || kind === VERIFY || !json?.data || missing || errorsAffect(errors, consumes)) throw new EbayError(kind);
    }
    if (!json?.data) throw new EbayError(`Terapeak 查询失败（HTTP ${r.status}）`);
    if (required && get(json.data, required) == null) throw new EbayError('Terapeak 返回的数据不完整（缺少结果），可能是 eBay 接口改版了，请稍后再试');
    return json.data;
  };
}
