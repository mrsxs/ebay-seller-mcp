// 定位紫鸟店铺浏览器的调试端口，并维护专用工作标签页：Seller Hub Research（Terapeak 接口）、eBay 搜索页（前台搜索）。
// 工作标签页用 window.name + sessionStorage 标记认领（eBay 自己有时也写 window.name），不会接管用户自己打开的 eBay 页面。
import { connectCdp, httpJson } from './cdp.mjs';
import { listCandidatePorts } from './ports.mjs';
import { getStoreTargetId, openStore } from './ziniao.mjs';

const READY_TIMEOUT_MS = 60_000;
// 窗口最小化 / 在后台时检查页的脚本跑得慢，实测要 25 秒以上；通过一次后 eBay 会记住这个浏览器
const CHALLENGE_WAIT_MS = 45_000;
// eBay 的浏览器检查页（Pardon Our Interruption），正常几秒内自动放行；验证码页要人来做，看到就停
export const CHALLENGE_PAGE = /^https:\/\/www\.ebay\.com\/splashui\/(challenge|captcha)/;
const CAPTCHA_PAGE = /^https:\/\/www\.ebay\.com\/splashui\/captcha/;
const CHALLENGE_TITLE = /Pardon Our Interruption|Security Measure/i;
const EBAY_URL = /^https:\/\/(www|signin)\.ebay\.com\//;
// 没登录时跳到这里
export const LOGIN_PAGE = /^https:\/\/signin\.ebay\.com\//;

export const EBAY_SITE = {
  home: 'https://www.ebay.com/sh/research?marketplace=EBAY-US',
  urlPrefix: 'https://www.ebay.com/sh/research',
  readyHost: 'www.ebay.com',
  // 后台 / 最小化的标签页可能一直停在 interactive（load 事件被延后），文档解析完就够发请求了
  readyExpr: "document.readyState !== 'loading' && location.pathname.startsWith('/sh/research')",
  // 停在登录页 / 浏览器检查页的标签页也复用，不每次新开
  tabName: 'ebay-seller-mcp:research',
  name: 'eBay Seller Hub',
};

// 前台搜索用另一个工作标签页：真实打开搜索页（页面内 fetch 搜索页会被 eBay 转到浏览器检查页，真实打开时检查页会自动放行）
export const SEARCH_SITE = {
  home: 'https://www.ebay.com/sch/i.html?_nkw=',
  urlPrefix: 'https://www.ebay.com/sch/',
  readyHost: 'www.ebay.com',
  // eBay 会把有的关键词直接转到类目页 /b/…，也算打开完成（由调用方决定怎么处理）
  // 商品卡片出现就算好（后台标签页可能一直停在 interactive）；没有卡片的页面（无结果、类目页）等到 complete
  readyExpr: "/^\\/(sch|b)\\//.test(location.pathname) && ((document.readyState !== 'loading' && !!document.querySelector('ul.srp-results > li[data-listingid]')) || document.readyState === 'complete')",
  tabName: 'ebay-seller-mcp:search',
  name: 'eBay 搜索页',
};

export const LOGIN_EXPIRED = 'eBay 未登录或登录已失效：请在紫鸟店铺浏览器里登录这家店的 eBay 卖家账号后重试';
export const CHALLENGE_STUCK = '触发了 eBay 安全验证（浏览器检查页一直没放行）：请在紫鸟店铺浏览器里打开 eBay 页面，等它通过或完成验证后再试，不要反复重试';
export const CAPTCHA_SHOWN = '触发了 eBay 安全验证（要求输入验证码）：请在紫鸟店铺浏览器里打开 eBay 页面手动完成验证后再试，不要反复重试';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 页面层面的阻断（未登录、检查页卡住、验证码）：是用户要处理的情况，不是程序故障 */
export class PageBlockedError extends Error {}

async function listTargets(port, timeoutMs = 3000) {
  try {
    const list = await httpJson(`http://127.0.0.1:${port}/json/list`, { timeoutMs });
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/** 用 targetId 在候选端口里找到这个店铺对应的浏览器（并行探测） */
async function findPortByTarget(targetId) {
  const ports = await listCandidatePorts();
  const found = await Promise.all(ports.map(async (port) => ((await listTargets(port, 1500))?.some((t) => t.id === targetId) ? port : null)));
  return found.find(Boolean) || null;
}

async function locatePort(storeId, log) {
  let targetId;
  try {
    targetId = await getStoreTargetId(storeId);
  } catch {
    log('店铺浏览器未运行，正在通过紫鸟打开…');
    await openStore(storeId);
    await sleep(3000);
    targetId = await getStoreTargetId(storeId);
  }
  const port = await findPortByTarget(targetId);
  if (!port) throw new Error('找不到店铺浏览器的调试端口，请确认紫鸟店铺浏览器已打开');
  return port;
}

const TAB_KEY = 'ebay-seller-mcp:tab';
const OWNED_EXPR = (name) => `(() => { try { if (sessionStorage.getItem(${JSON.stringify(TAB_KEY)}) === ${JSON.stringify(name)}) return true; } catch {} return window.name === ${JSON.stringify(name)}; })()`;
const CLAIM_EXPR = (name) => `(() => { window.name = ${JSON.stringify(name)}; try { sessionStorage.setItem(${JSON.stringify(TAB_KEY)}, ${JSON.stringify(name)}); } catch {} return true; })()`;

const probeExpr = (site) => `({ href: location.href, title: document.title, loaded: document.readyState !== 'loading',
  ready: location.hostname.endsWith(${JSON.stringify(site.readyHost)}) && (${site.readyExpr}) })`;

/** 页面当前状态：就绪 / 登录页 / 验证码 / 浏览器检查页 / 其他 */
export function classifyPage(p) {
  const href = String(p?.href ?? '');
  if (CAPTCHA_PAGE.test(href)) return 'captcha';
  if (CHALLENGE_PAGE.test(href) || CHALLENGE_TITLE.test(String(p?.title ?? ''))) return 'challenge';
  if (LOGIN_PAGE.test(href)) return 'login';
  return p?.ready ? 'ready' : 'loading';
}

export async function waitReady(cdp, site, { now = Date.now, pause = sleep } = {}) {
  const deadline = now() + READY_TIMEOUT_MS;
  let onLogin = 0;
  let challengeSince = null;
  for (;;) {
    const p = await cdp.evaluate(probeExpr(site), 5000).catch(() => null);
    const kind = classifyPage(p);
    if (kind === 'ready') return;
    if (kind === 'captcha') throw new PageBlockedError(CAPTCHA_SHOWN);
    // 停在登录页就别等满超时了（连续两次看到登录页才算，避免跳转途中误判）
    onLogin = kind === 'login' ? onLogin + 1 : 0;
    if (onLogin >= 2) throw new PageBlockedError(LOGIN_EXPIRED);
    if (kind === 'challenge') {
      challengeSince ??= now();
      if (now() - challengeSince > CHALLENGE_WAIT_MS) throw new PageBlockedError(CHALLENGE_STUCK);
    }
    if (now() >= deadline) {
      if (challengeSince !== null) throw new PageBlockedError(CHALLENGE_STUCK);
      throw new Error(`${site.name}加载超时，请确认紫鸟店铺浏览器已登录 eBay 卖家账号，并检查店铺网络`);
    }
    await pause(800);
  }
}

/** 窗口里是否有可见的标签页；一个都没有说明紫鸟窗口最小化了（或被完全挡住，用户没在看） */
async function anyTabVisible(port) {
  // 扩展的 offscreen 页等不是用户看的标签，跳过
  const pages = ((await listTargets(port)) || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && /^(https?:|about:)/.test(t.url));
  for (const t of pages) {
    try {
      const c = await connectCdp(t.webSocketDebuggerUrl, { connectTimeoutMs: 3000 });
      try {
        if ((await c.evaluate('document.visibilityState', 3000)) === 'visible') return true;
      } finally {
        c.close();
      }
    } catch {
      // 扩展页等连不上的标签跳过
    }
  }
  return false;
}

/**
 * 新开工作标签页。用浏览器级 CDP 的 Target.createTarget({ background: true })。
 * 紫鸟里新开标签页会把最小化的窗口弹出来（2026-11-14 实测，background 也一样），
 * 所以开之前先看窗口是否在用户眼前，不在就开完立刻再最小化回去。工作标签页开好后一直复用，只有第一次会开。
 */
async function openWorkerTab(port, site) {
  const hidden = !(await anyTabVisible(port));
  let created = null;
  try {
    const { webSocketDebuggerUrl } = await httpJson(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 3000 });
    const browser = await connectCdp(webSocketDebuggerUrl);
    try {
      const { targetId } = await browser.send('Target.createTarget', { url: site.home, background: true });
      created = targetId;
      if (hidden) {
        // 窗口是异步弹出来的：等它弹出后再最小化，并确认确实缩回去了
        const win = await browser.send('Browser.getWindowForTarget', { targetId }).catch(() => null);
        for (let i = 0; win && i < 3; i++) {
          await sleep(800);
          await browser.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'minimized' } }).catch(() => {});
          await sleep(400);
          if (!(await anyTabVisible(port))) break;
        }
      }
      for (let i = 0; i < 20; i++) {
        const found = (await listTargets(port))?.find((t) => t.id === targetId);
        if (found?.webSocketDebuggerUrl) return found;
        await sleep(250);
      }
    } finally {
      browser.close();
    }
  } catch {
    // 拿不到浏览器级连接时退回旧方式（可能会把窗口弹出来）
  }
  // 已经开出来了就不能再开第二个（否则同一个地址会打开两次）
  if (created) throw new Error('新开的工作标签页没找到，请稍后再试');
  return httpJson(`http://127.0.0.1:${port}/json/new?${site.home}`, { method: 'PUT', timeoutMs: 8000 });
}

/**
 * 会话：缓存「店铺 -> 端口 -> 工作标签页」。
 * 标签页被关闭或浏览器重启时自动重建。site 决定用哪个页面当工作标签页。
 */
export function createBrowserSession(site) {
  let state = null; // { storeId, port, targetId, cdp }
  let justOpened = false; // 最近一次 connect 是否新开了标签页（新开时已经打开了 opts.home）

  const isAlive = async (s) => {
    if (!s?.cdp?.isOpen()) return false;
    const targets = await listTargets(s.port);
    // 标签页还在且还在 eBay（用户可能把它导航到别的网站）
    return Boolean(targets?.some((t) => t.id === s.targetId && EBAY_URL.test(t.url)));
  };

  /**
   * 工作标签页可能被带到了别的 eBay 页面（首页、商品页）：加载完了又不是工作页，就跳回 home（或工作地址）。
   * 停在检查页 / 登录页 / 还在加载时按 waitReady 的规则处理。就绪后补一次认领标记（跨源登录回来时 sessionStorage 是另一份）。
   * 返回是否跳转过（跳到了 home 时调用方不用再跳）。
   */
  async function ensureOnSite(cdp, home) {
    const p = await cdp.evaluate(probeExpr(site), 5000).catch(() => null);
    let navigated = false;
    if (classifyPage(p) === 'loading' && p?.loaded) {
      await navigateAndWait(cdp, home || site.home, site);
      navigated = Boolean(home);
    } else {
      await waitReady(cdp, site);
    }
    await cdp.evaluate(CLAIM_EXPR(site.tabName), 5000).catch(() => {});
    return navigated;
  }

  /** 在候选标签页里找 window.name 是自己的那个 */
  async function findOwned(targets) {
    for (const t of targets.filter((x) => x.type === 'page' && x.webSocketDebuggerUrl && EBAY_URL.test(x.url))) {
      try {
        const c = await connectCdp(t.webSocketDebuggerUrl, { connectTimeoutMs: 3000 });
        try {
          if ((await c.evaluate(OWNED_EXPR(site.tabName), 3000)) === true) return t;
        } finally {
          c.close();
        }
      } catch {
        // 连不上的标签跳过
      }
    }
    return null;
  }

  /** opts.home：需要新开工作标签页时直接打开这个地址（比如要搜索的页面），省一次跳转 */
  async function connect(storeId, log = () => {}, opts = {}) {
    justOpened = false;
    if (state?.storeId === storeId && (await isAlive(state))) {
      // 复用时也看一眼页面状态：停在检查页 / 登录页时按规则等或报错；被带到别的 eBay 页面时跳回工作地址
      justOpened = await ensureOnSite(state.cdp, opts.home);
      return state.cdp;
    }
    state?.cdp?.close();
    state = null;

    log('正在定位紫鸟店铺浏览器…');
    const port = await locatePort(storeId, log);
    const reusable = await findOwned((await listTargets(port)) || []);
    const target = reusable || (await openWorkerTab(port, opts.home ? { ...site, home: opts.home } : site));
    const cdp = await connectCdp(target.webSocketDebuggerUrl);
    let navigated = false;
    try {
      // 认领：window.name 在同站跳转时保留；sessionStorage 按标签页 + 站点保存，eBay 不会动它
      await cdp.evaluate(CLAIM_EXPR(site.tabName), 5000);
      await cdp.send('Network.enable');
      log(`等待${site.name}就绪…`);
      if (reusable) navigated = await ensureOnSite(cdp, opts.home);
      else {
        await waitReady(cdp, site);
        // 新开的标签页最初的文档可能被替换（跳转、检查页），就绪后再认领一次
        await cdp.evaluate(CLAIM_EXPR(site.tabName), 5000).catch(() => {});
      }
    } catch (err) {
      cdp.close();
      throw err;
    }
    state = { storeId, port, targetId: target.id, cdp };
    justOpened = !reusable || navigated;
    return cdp;
  }

  return {
    connect,
    reset: () => {
      state?.cdp?.close();
      state = null;
    },
    info: () => (state ? { storeId: state.storeId, port: state.port, targetId: state.targetId, justOpened } : null),
  };
}

/** 在工作标签页里打开一个地址并等它就绪（浏览器检查页会自动放行；卡住或要登录时抛错） */
export async function navigateAndWait(cdp, url, site) {
  await cdp.evaluate('window.__ebmOldDoc = true', 5000);
  const nav = await cdp.send('Page.navigate', { url });
  if (nav?.errorText) throw new Error(`${site.name}打开失败（${nav.errorText}），请检查店铺网络`);
  const deadline = Date.now() + 20_000;
  // 等旧页面换掉，再按站点规则等就绪
  while (Date.now() < deadline) {
    const fresh = await cdp.evaluate('!window.__ebmOldDoc', 5000).catch(() => false);
    if (fresh) return waitReady(cdp, site);
    await sleep(300);
  }
  throw new Error(`${site.name}打开超时，请检查店铺网络`);
}
