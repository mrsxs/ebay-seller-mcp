// 店铺授权（OAuth 授权码流程）：在这家店的紫鸟店铺浏览器里新开标签页打开 eBay 授权页，
// 店主点「同意」后 eBay 跳到默认的授权结果页，地址里带 code；读到后换成 refresh_token（约 18 个月）存进密钥文件。
// 全程在店铺浏览器里完成（这家店平时的 IP 和环境），不在别的浏览器里登录卖家账号。
import { randomBytes } from 'node:crypto';
import { listTargets, locatePort } from './browser.mjs';
import { connectCdp, httpJson } from './cdp.mjs';
import { pickText, tradingCall } from './ebay-api.mjs';
import { ALL_SCOPES, AUTHORIZE_URL, AuthError, loadKeys, requestToken, updateKeys } from './oauth.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function authorizeUrl(keys, state, scopes = ALL_SCOPES) {
  if (!keys.ru_name) throw new AuthError('密钥文件里缺少 ru_name（developer.ebay.com → User Tokens → 你的 eBay 登录设置里的 RuName，要开启 OAuth）');
  return `${AUTHORIZE_URL}?${new URLSearchParams({ client_id: keys.app_id.trim(), redirect_uri: keys.ru_name.trim(), response_type: 'code', scope: scopes.join(' '), state })}`;
}

/** 看授权标签页当前地址：拿到 code / 用户拒绝 / 还在进行 */
export function readRedirect(href, state) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return { status: 'pending' };
  }
  if (!/(^|\.)ebay\.com$/.test(u.hostname)) return { status: 'pending' };
  const code = u.searchParams.get('code');
  if (code) {
    if (u.searchParams.get('state') !== state) return { status: 'error', reason: '授权回跳的 state 对不上，已放弃（请重新运行授权）' };
    return { status: 'ok', code };
  }
  if (u.searchParams.get('isAuthSuccessful') === 'false' || u.searchParams.get('error')) return { status: 'declined' };
  return { status: 'pending' };
}

export async function authorizeStore({ storeId, file, log = () => {}, timeoutMs = 10 * 60_000, fetchImpl = fetch }) {
  const keys = loadKeys(file);
  const state = randomBytes(16).toString('hex');
  const url = authorizeUrl(keys, state);
  log('正在定位紫鸟店铺浏览器…');
  const port = await locatePort(storeId, log);
  const { webSocketDebuggerUrl } = await httpJson(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 3000 });
  const browser = await connectCdp(webSocketDebuggerUrl);
  let tab;
  try {
    ({ targetId: tab } = await browser.send('Target.createTarget', { url, background: false }));
    await browser.send('Target.activateTarget', { targetId: tab }).catch(() => {});
  } finally {
    browser.close();
  }
  log('已在紫鸟店铺浏览器里打开 eBay 授权页：请在那个窗口登录这家店的卖家账号（已登录就跳过）并点「Agree / 同意」。最多等 10 分钟…');
  let code = null;
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const t = (await listTargets(port))?.find((x) => x.id === tab);
      if (!t) throw new AuthError('授权标签页被关掉了，没有完成授权');
      const r = readRedirect(t.url, state);
      if (r.status === 'ok') {
        code = r.code;
        break;
      }
      if (r.status === 'declined') throw new AuthError('在授权页上点了拒绝，没有授权');
      if (r.status === 'error') throw new AuthError(r.reason);
      await sleep(1000);
    }
  } finally {
    // 地址里带着一次性的 code，关掉这个标签页
    await fetch(`http://127.0.0.1:${port}/json/close/${tab}`).catch(() => {});
  }
  if (!code) throw new AuthError('10 分钟内没有完成授权，请重新运行');
  const t = await requestToken(keys, { grant_type: 'authorization_code', code, redirect_uri: keys.ru_name.trim() }, { fetchImpl });
  if (!t.refresh_token) throw new AuthError('eBay 没有返回 refresh_token，请重新授权');
  const user = await tradingCall({ token: t.access_token, call: 'GetUser', fetchImpl });
  const ebayUserId = pickText(user.xml, 'UserID') ?? null;
  const grant = {
    refresh_token: t.refresh_token,
    // eBay 的 refresh_token 约 18 个月有效；没返回有效期时按 18 个月记
    refresh_token_expires_at: new Date(Date.now() + Number(t.refresh_token_expires_in || 47_304_000) * 1000).toISOString(),
    scopes: ALL_SCOPES,
    ebay_user_id: ebayUserId,
    authorized_at: new Date().toISOString(),
  };
  await updateKeys(file, (k) => {
    k.shops = k.shops && typeof k.shops === 'object' ? k.shops : {};
    k.shops[storeId] = grant;
    return k;
  });
  return { ebay_user_id: ebayUserId, expires_at: grant.refresh_token_expires_at, scopes: grant.scopes };
}
