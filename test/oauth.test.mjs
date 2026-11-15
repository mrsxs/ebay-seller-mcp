import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { AuthError, createTokenProvider, LISTING_SCOPES, loadKeys, READ_SCOPES, updateKeys } from '../lib/oauth.mjs';

const STORE = '12345678901234';
const keysFile = (data) => {
  const f = join(mkdtempSync(join(tmpdir(), 'ebay-oauth-')), 'api-keys.json');
  if (data) writeFileSync(f, JSON.stringify(data), { mode: 0o600 });
  return f;
};
const KEYS = (grant = {}) => ({ app_id: 'app', cert_id: 'cert-secret', ru_name: 'ru', shops: { [STORE]: { refresh_token: 'refresh-secret', scopes: READ_SCOPES, ...grant } } });
const tokenFetch = (responses) => {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, body: String(opts.body) });
    const r = responses.shift() ?? { status: 200, json: { access_token: `at-${calls.length}`, expires_in: 7200 } };
    return { ok: r.status < 400, status: r.status, json: async () => r.json };
  };
  fn.calls = calls;
  return fn;
};

test('loadKeys explains what is missing', () => {
  assert.throws(() => loadKeys(keysFile()), (e) => e instanceof AuthError && /还没有配置 eBay 开发者密钥/.test(e.message));
  assert.throws(() => loadKeys(keysFile({ app_id: 'a' })), /缺少 cert_id/);
  const f = keysFile();
  writeFileSync(f, '{not json');
  assert.throws(() => loadKeys(f), /不是合法 JSON/);
});

test('userToken refreshes once, caches, and never leaks secrets in errors', async () => {
  const fetchImpl = tokenFetch([]);
  let t = 0;
  const p = createTokenProvider({ file: keysFile(KEYS()), fetchImpl, now: () => t });
  const [a, b] = await Promise.all([p.userToken(STORE), p.userToken(STORE)]);
  assert.equal(a, 'at-1');
  assert.equal(b, 'at-1');
  assert.equal(fetchImpl.calls.length, 1, 'concurrent callers share one refresh');
  assert.match(fetchImpl.calls[0].body, /grant_type=refresh_token/);
  assert.equal(await p.userToken(STORE), 'at-1');
  t += 7200_000;
  assert.equal(await p.userToken(STORE), 'at-2', 'refreshes when the access token expires');
  p.forget(STORE);
  assert.equal(await p.userToken(STORE), 'at-3');
});

test('userToken: missing grant, missing listing scope, expired or revoked grant', async () => {
  const p = (keys, responses = []) => createTokenProvider({ file: keysFile(keys), fetchImpl: tokenFetch(responses) });
  await assert.rejects(p({ app_id: 'a', cert_id: 'c' }).userToken(STORE), (e) => e instanceof AuthError && e.message.includes(`auth --store-id ${STORE}`));
  await assert.rejects(p(KEYS()).userToken(STORE, { needScopes: LISTING_SCOPES }), /没有刊登权限/);
  assert.equal(await p(KEYS({ scopes: [...READ_SCOPES, ...LISTING_SCOPES] })).userToken(STORE, { needScopes: LISTING_SCOPES }), 'at-1');
  await assert.rejects(p(KEYS({ refresh_token_expires_at: '2000-01-01T00:00:00Z' })).userToken(STORE), /已过期/);
  const revoked = p(KEYS(), [{ status: 400, json: { error: 'invalid_grant', error_description: 'refresh-secret is bad' } }]);
  await assert.rejects(revoked.userToken(STORE), (e) => /已失效或被撤销/.test(e.message) && !e.message.includes('secret'));
  const badClient = p(KEYS(), [{ status: 401, json: { error: 'invalid_client' } }]);
  await assert.rejects(badClient.userToken(STORE), /开发者密钥无效/);
});

test('appToken uses client credentials and is cached', async () => {
  const fetchImpl = tokenFetch([]);
  const p = createTokenProvider({ file: keysFile(KEYS()), fetchImpl });
  assert.equal(await p.appToken(), 'at-1');
  assert.equal(await p.appToken(), 'at-1');
  assert.match(fetchImpl.calls[0].body, /grant_type=client_credentials/);
  assert.equal(fetchImpl.calls.length, 1);
});

test('updateKeys merges into the latest file and keeps it private, also when two run at once', async () => {
  const f = keysFile(KEYS());
  // 同一个文件的两种写法（带 ../）也要排队
  const alias = join(dirname(f), '..', basename(dirname(f)), basename(f));
  await Promise.all([['other', f], ['third', alias]].map(([name, path]) => updateKeys(path, (k) => {
    k.shops[name] = { refresh_token: `r-${name}` };
    return k;
  })));
  const d = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(d.cert_id, 'cert-secret');
  assert.equal(d.shops[STORE].refresh_token, 'refresh-secret');
  assert.equal(d.shops.other.refresh_token, 'r-other');
  assert.equal(d.shops.third.refresh_token, 'r-third', 'concurrent updates do not overwrite each other');
  if (process.platform !== 'win32') assert.equal(statSync(f).mode & 0o777, 0o600);
});
