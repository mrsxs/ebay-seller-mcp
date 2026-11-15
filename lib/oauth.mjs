// eBay 开放平台凭证：开发者密钥（App ID / Cert ID / RuName）和每家店的授权（refresh_token）。
// 都放在本机一个 600 权限的 JSON 文件里（默认 ~/.config/ebay-seller-mcp/api-keys.json，可用 EBAY_API_KEYS 指定）：
//   { "app_id": "...", "cert_id": "...", "dev_id": "...", "ru_name": "...",
//     "shops": { "<紫鸟店铺 ID>": { "refresh_token": "...", "refresh_token_expires_at": "...", "scopes": [...], "ebay_user_id": "..." } } }
// 店铺授权用 `ebay-seller-mcp auth --store-id <紫鸟店铺 ID>` 在紫鸟店铺浏览器里完成。令牌不写日志、不出现在报错里。
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { withLock } from './browser-lock.mjs';
import { writeFileAtomic } from './fsutil.mjs';

export class AuthError extends Error {}

export const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
export const AUTHORIZE_URL = 'https://auth.ebay.com/oauth2/authorize';
const S = 'https://api.ebay.com/oauth/api_scope';
/** 查询用（只读） */
export const READ_SCOPES = [S, `${S}/sell.fulfillment.readonly`, `${S}/sell.analytics.readonly`, `${S}/sell.inventory.readonly`, `${S}/sell.marketing.readonly`,
  `${S}/sell.account.readonly`, `${S}/sell.finances`, `${S}/commerce.identity.readonly`, `${S}/sell.stores.readonly`];
/** 刊登用：库存 / 刊登的写权限 */
export const LISTING_SCOPES = [`${S}/sell.inventory`];
/** 广告：效果报表（eBay 要求写权限才能生成报表）和广告管理 */
export const MARKETING_SCOPES = [`${S}/sell.marketing`];
export const ALL_SCOPES = [...READ_SCOPES, ...LISTING_SCOPES, ...MARKETING_SCOPES];

export const defaultKeysFile = (env = process.env) => env.EBAY_API_KEYS || join(homedir(), '.config', 'ebay-seller-mcp', 'api-keys.json');

const authHint = (storeId) => `npx -y ebay-seller-mcp@latest auth --store-id ${storeId ?? '<紫鸟店铺 ID>'}`;

/** 读密钥文件；文件不存在 / 缺字段时给出怎么配置 */
export function loadKeys(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') throw new AuthError(`还没有配置 eBay 开发者密钥：在 ${file} 里写 app_id、cert_id、ru_name（600 权限），再用「${authHint()}」授权店铺`);
    throw new AuthError(`eBay 密钥文件 ${file} 读不了或不是合法 JSON`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AuthError(`eBay 密钥文件 ${file} 应是 JSON 对象`);
  for (const k of ['app_id', 'cert_id']) if (typeof data[k] !== 'string' || !data[k].trim()) throw new AuthError(`eBay 密钥文件 ${file} 缺少 ${k}`);
  return data;
}

/** 写回密钥文件：跨进程加锁，锁内读最新内容再合并（两家店同时授权不会互相覆盖），原子替换，保持 600 */
export function updateKeys(file, mutate) {
  return withLock(dirname(file), async () => {
    const current = existsSync(file) ? loadKeys(file) : {};
    const next = mutate(structuredClone(current)) ?? current;
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
    // 一个目录一把锁（withLock 会把目录换成真实路径再算端口）：同一个文件的不同写法（../、软链接目录、macOS 上的大小写）都落到同一把锁
  }, { key: 'keys-file', what: 'eBay 密钥文件', waitMs: 15_000, owner: `ebay-seller-mcp auth ${process.pid}` });
}

const basicAuth = (keys) => `Basic ${Buffer.from(`${keys.app_id.trim()}:${keys.cert_id.trim()}`).toString('base64')}`;

/** 调令牌接口；出错时只给分类后的说明（不带令牌） */
export async function requestToken(keys, params, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  let res;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { Authorization: basicAuth(keys), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new AuthError('连不上 eBay 授权接口（网络问题），稍后再试');
  }
  const json = await res.json().catch(() => ({}));
  if (res.ok && json.access_token) return json;
  const code = String(json.error ?? '');
  if (code === 'invalid_client') throw new AuthError('eBay 开发者密钥无效（app_id / cert_id 不对，或密钥集被停用、不合规）：到 developer.ebay.com 的 Application Keys 检查');
  if (code === 'invalid_grant') throw Object.assign(new AuthError('店铺授权已失效或被撤销'), { grant: true });
  if (code === 'invalid_scope') throw Object.assign(new AuthError('店铺授权里没有这项权限'), { scope: true });
  throw new AuthError(`eBay 授权接口出错（HTTP ${res.status}${code ? ` ${code}` : ''}）`);
}

/**
 * 访问令牌提供者：按店换用户令牌（refresh_token → 2 小时的 access_token），应用令牌给类目等公共接口用。
 * 同一家店同时只换一次；快过期（1 分钟内）就换新的。
 */
export function createTokenProvider({ file = defaultKeysFile(), fetchImpl = fetch, now = () => Date.now() } = {}) {
  const cache = new Map();
  const inflight = new Map();
  const fresh = (hit) => hit && hit.expiresAt - 60_000 > now();

  async function once(key, load) {
    if (fresh(cache.get(key))) return cache.get(key);
    if (inflight.has(key)) return inflight.get(key);
    const p = load().then((v) => {
      cache.set(key, v);
      return v;
    });
    inflight.set(key, p);
    try {
      return await p;
    } finally {
      inflight.delete(key);
    }
  }

  /** 这家店的授权信息（不含令牌值以外的东西也会用到：scopes、eBay 用户名） */
  function shopGrant(storeId) {
    const keys = loadKeys(file);
    const grant = keys.shops?.[storeId];
    if (!grant?.refresh_token) throw new AuthError(`这家店（紫鸟店铺 ${storeId}）还没有授权 eBay 接口：在终端运行「${authHint(storeId)}」，在紫鸟店铺浏览器里点同意`);
    const exp = Date.parse(grant.refresh_token_expires_at ?? '');
    if (Number.isFinite(exp) && exp <= now()) throw new AuthError(`这家店的 eBay 授权已过期：运行「${authHint(storeId)}」重新授权`);
    return { keys, grant };
  }

  async function userToken(storeId, { needScopes = [] } = {}) {
    const { keys, grant } = shopGrant(storeId);
    const scopes = Array.isArray(grant.scopes) && grant.scopes.length ? grant.scopes : READ_SCOPES;
    const missing = needScopes.filter((s) => !scopes.includes(s));
    if (missing.length) throw new AuthError(`这家店的 eBay 授权里没有刊登权限：运行「${authHint(storeId)}」重新授权（会多申请刊登权限）`);
    const v = await once(`user|${storeId}|${grant.refresh_token.slice(-12)}`, async () => {
      try {
        const t = await requestToken(keys, { grant_type: 'refresh_token', refresh_token: grant.refresh_token, scope: scopes.join(' ') }, { fetchImpl });
        return { token: t.access_token, expiresAt: now() + Number(t.expires_in || 7200) * 1000 };
      } catch (err) {
        if (err.grant) throw new AuthError(`这家店的 eBay 授权已失效或被撤销：运行「${authHint(storeId)}」重新授权`);
        throw err;
      }
    });
    return v.token;
  }

  async function appToken() {
    const keys = loadKeys(file);
    const v = await once(`app|${keys.app_id}`, async () => {
      const t = await requestToken(keys, { grant_type: 'client_credentials', scope: S }, { fetchImpl });
      return { token: t.access_token, expiresAt: now() + Number(t.expires_in || 7200) * 1000 };
    });
    return v.token;
  }

  return {
    userToken,
    appToken,
    grantInfo: (storeId) => {
      const { grant } = shopGrant(storeId);
      return { ebay_user_id: grant.ebay_user_id ?? null, scopes: grant.scopes ?? READ_SCOPES, expires_at: grant.refresh_token_expires_at ?? null };
    },
    /** 令牌被 eBay 拒绝（401）后丢掉缓存，下次重新换 */
    forget: (storeId) => {
      for (const k of cache.keys()) if (k.startsWith(`user|${storeId}|`)) cache.delete(k);
    },
  };
}
