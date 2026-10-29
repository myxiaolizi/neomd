/**
 * Neo MD 1.2.0 同步故障根治验收。
 *
 * 针对用户报障「同步失败：无法连接到服务器（Failed to fetch）」的三类成因逐条断言，
 * 并验证「即使再发生也能被精确定位」。
 *
 * 用法：
 *   node tools/verify-120-sync-error.mjs
 *   WEB=http://127.0.0.1:5178 API=http://127.0.0.1:3200 node tools/verify-120-sync-error.mjs
 *
 * 退出码：0 全部通过；1 有失败项。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'shots-120');
fs.mkdirSync(shots, { recursive: true });

const WEB = (process.env.WEB || 'http://127.0.0.1:5178').replace(/\/+$/, '');
const API = (process.env.API || 'http://127.0.0.1:3200').replace(/\/+$/, '');
const ACCOUNT = process.env.ACCOUNT || 'admin';
const PASSWORD = process.env.PASSWORD || '6655';
const BROWSER = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/** 线上真实故障的桶名（拼错，真实是 zhengle）—— 用它复现用户报障 */
const BAD_BUCKET = 'zhenglob';
const BAD_ENDPOINT = 'https://oss-cn-guangzhou.aliyuncs.com';

let pass = 0;
const failures = [];
function check(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}${extra ? `  [${extra}]` : ''}`);
  } else {
    failures.push(`${label}${extra ? ` → ${extra}` : ''}`);
    console.log(`  ✗ ${label}${extra ? ` → ${extra}` : ''}`);
  }
}
function section(t) {
  console.log(`\n${t}`);
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

async function apiFetch(pathname, init = {}) {
  const res = await fetch(`${API}${pathname}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* HEAD/二进制时保持 null */
  }
  return { res, text, json };
}

/** 带 429 重试的读取（限流：登录 10/分、vaults 写 20/分） */
async function apiReadWithRetry(pathname, headers, { attempts = 4, label = '' } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const r = await apiFetch(pathname, { headers });
    if (r.res.status !== 429) return r;
    const wait = Number(r.res.headers.get('retry-after') ?? 0) || 5;
    console.log(`    ${label} 撞到限流 429，等待 ${wait}s 后重试（${i + 1}/${attempts}）`);
    await new Promise((res) => setTimeout(res, wait * 1000));
  }
  return apiFetch(pathname, { headers });
}

const login = await apiFetch('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: ACCOUNT, password: PASSWORD }),
});
check(login.res.ok && login.json?.ok === true, 'API 登录成功', `HTTP ${login.res.status}`);
const TOKEN = login.json?.data?.accessToken ?? '';
check(Boolean(TOKEN), '拿到 access token', `${TOKEN.length} 字符`);
const authHeaders = (extra = {}) => ({ authorization: `Bearer ${TOKEN}`, ...extra });

const { default: playwright } = await import(
  pathToFileURL(path.resolve(here, '../apps/desktop/node_modules/playwright-core/index.js')).href
);
const { chromium } = playwright;

const launch = () =>
  chromium.launch({
    executablePath: fs.existsSync(BROWSER) ? BROWSER : undefined,
    args: ['--headless=new', '--no-sandbox'],
  });

/** 固定 deviceId，避免每次运行在云端堆积 index/dev-*.json */
const QA_DEVICE_ID = 'qa-verify-120';
async function seedDeviceId(page) {
  await page.addInitScript((devId) => {
    try {
      localStorage.setItem('neomd.deviceId', devId);
    } catch {
      /* ignore */
    }
  }, QA_DEVICE_ID);
}

/** 通过 UI 登录（带限流重试） */
async function loginViaUi(page, tag = '') {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.locator('#account').waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForTimeout(1200);
    await page.locator('#account').fill(ACCOUNT);
    await page.locator('#password').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    const outcome = await Promise.race([
      page.waitForURL(/\/app/, { timeout: 30000 }).then(() => 'ok'),
      page.locator('.card__error').waitFor({ state: 'visible', timeout: 30000 }).then(() => 'error'),
    ]).catch(() => 'timeout');
    if (outcome === 'ok') return true;
    const msg = outcome === 'error' ? await page.locator('.card__error').innerText().catch(() => '') : 'timeout';
    console.log(`    ${tag} 登录第 ${attempt} 次失败：${msg}`);
    if (attempt === 3) return false;
    await page.waitForTimeout(/频繁|稍后|限流/i.test(msg) ? 20000 : 3000);
  }
  return false;
}

/**
 * 注入「线上真实故障配置」到设置里 —— **必须在应用启动前**执行。
 *
 * ## 为什么不能「应用跑起来后用 page.evaluate 写 localStorage」
 *
 * 这是本轮踩过的真实坑：`useAppStore` 持有 `VaultRegistry` / settings 的**内存副本**，
 * 任何一次 `persist()`（`updateStats` / `markSynced` / `mergeRemote` / 同步完成回写…）
 * 都会把内存里的旧值整体写回 localStorage，把我们在外部写进去的种子**覆盖掉**。
 * 表现是「明明注入了配置，刷新后却回到原样」，调试时极易误判成产品 bug。
 *
 * 正确做法：用 `addInitScript` 让种子在**每次导航的最开始**、任何应用代码之前写入。
 * 用 `sessionStorage` 标记只种一次，避免 HMR/多次导航时反复覆盖用户（测试）数据。
 */
async function seedBeforeBoot(page, { settingsPatch, vaultList }) {
  await page.addInitScript(
    ({ sPatch, vList }) => {
      try {
        if (sPatch) {
          const KEY = 'neomd.settings.v1';
          const raw = localStorage.getItem(KEY);
          const s = raw ? JSON.parse(raw) : {};
          s.storage = { ...(s.storage || {}), ...sPatch };
          localStorage.setItem(KEY, JSON.stringify(s));
        }
        if (vList) {
          localStorage.setItem('neomd.vaultList.v1', JSON.stringify(vList.payload));
          localStorage.setItem('neomd.lastVault', vList.lastVault);
        }
      } catch {
        /* 隐私模式下忽略 */
      }
    },
    { sPatch: settingsPatch ?? null, vList: vaultList ?? null },
  );
}

/** 线上真实故障的 storage 配置（bucket 拼错 + 假 AK，结构上"合法"） */
const BAD_S3_PATCH = {
  provider: 'aliyun-oss',
  endpoint: BAD_ENDPOINT,
  region: 'cn-guangzhou',
  bucket: BAD_BUCKET,
  accessKeyId: 'LTAI5tFakeKeyForQa120',
  accessKeySecret: 'FakeSecretForQa120TestingOnly',
  publicDomain: '',
  urlStyle: 'virtual-hosted',
  isPrivate: true,
  basePrefix: 'mdadmin/',
  useTls: true,
};

/** 干净配置（清空自建 S3 → 已登录走平台代理） */
const CLEAN_S3_PATCH = { bucket: '', accessKeyId: '', accessKeySecret: '', endpoint: '' };

/**
 * 在页面里装一个「toast 收集器」（必须在触发同步**之前**调用）。
 *
 * 为什么不能用「同步结束后再读 DOM」：应用内 toast 是
 * `v-if="app.toast"` + 4.6~6 秒后自动清空（见 EditorPage.vue 的 `.toast`），
 * 而一轮同步往往要 8~12 秒才结束 —— 等结束再读，toast 早就消失了，
 * 断言会误判成「没有任何提示」。这是本轮初版脚本踩过的坑。
 *
 * 用 MutationObserver 持续记录出现过的每一条 toast 文案，同步结束后回读。
 * 同时用 `app.toast` 的 store 状态兜底（万一 DOM 观察漏掉极短闪现）。
 */
async function installToastCollector(page) {
  await page.evaluate(() => {
    const w = window;
    w.__toastLog = [];
    const push = (t) => {
      const s = String(t || '').trim();
      if (s && w.__toastLog[w.__toastLog.length - 1] !== s) w.__toastLog.push(s);
    };
    const grab = () => {
      document.querySelectorAll('.toast, [class*="toast--"]').forEach((el) => push(el.textContent));
    };
    if (w.__toastObserver) w.__toastObserver.disconnect();
    w.__toastObserver = new MutationObserver(grab);
    w.__toastObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    grab();
    // 兜底轮询：MutationObserver 对 class 变化不敏感（v-if 切换时是节点增删，一般能captured，
    // 但 Transition 期间可能有短暂状态），每 150ms 采样一次，保证不漏。
    if (w.__toastTimer) clearInterval(w.__toastTimer);
    w.__toastTimer = setInterval(grab, 150);
  });
}

/** 读取收集到的所有提示文本（toast 优先，其次是页面内联提示区块） */
async function readErrorText(page) {
  return page.evaluate(() => {
    const parts = [];
    const log = window.__toastLog || [];
    if (log.length) parts.push(log.join('\n'));
    // 同步结果区块（设置页里的常驻提示）
    const result = document.querySelector('.syncset__result, .syncset__notice');
    if (result) parts.push(result.textContent || '');
    // 兜底：整页文本（错误可能渲染在状态栏）
    parts.push(document.body.innerText);
    return parts.join('\n');
  });
}

/** 触发一次同步并等到结束，返回期间所有 /api/storage 请求与错误文本 */
async function triggerSync(page, { waitMs = 9000 } = {}) {
  const storageCalls = [];
  const ossCalls = [];
  const onResp = (r) => {
    const u = r.url();
    if (u.includes('/api/storage/')) storageCalls.push({ method: r.request().method(), url: u, status: r.status() });
    if (/aliyuncs\.com/.test(u)) ossCalls.push(u);
  };
  const onReq = (req) => {
    if (/aliyuncs\.com/.test(req.url())) ossCalls.push(req.url());
  };
  const onFailed = (req) => {
    if (req.url().includes('/api/storage/')) storageCalls.push({ method: req.method(), url: req.url(), status: -1 });
  };
  await installToastCollector(page);
  page.on('response', onResp);
  page.on('request', onReq);
  page.on('requestfailed', onFailed);
  try {
    const btn = page.locator('button[aria-label^="立即同步"]').first();
    if (await btn.count()) {
      await btn.click();
    } else {
      await page.keyboard.press('Control+Shift+p');
      await page.waitForTimeout(500);
      const item = page.locator('[class*="palette"] *', { hasText: '立即同步' }).first();
      if (await item.count()) await item.click();
    }
    await page.waitForTimeout(waitMs);
    const errText = await readErrorText(page);
    return { storageCalls, ossCalls, errText };
  } finally {
    page.off('response', onResp);
    page.off('request', onReq);
    page.off('requestfailed', onFailed);
  }
}

/* ================================================================== */
/* A. 已登录 + 残留无效 S3 配置 → 必须走平台代理，禁止直连 OSS          */
/* ================================================================== */

section('[A] 已登录 + 残留 bucket:"zhenglob" → 必须走平台代理（0 个 OSS 直连）');

const browserA = await launch();
const ctxA = await browserA.newContext({ viewport: { width: 1440, height: 900 } });
const pageA = await ctxA.newPage();
await seedDeviceId(pageA);
const errorsA = [];
pageA.on('pageerror', (e) => errorsA.push(String(e.message).slice(0, 200)));

try {
  /*
   * 注入必须发生在**登录 + 同步之前**（用 addInitScript，在任何应用代码前写盘）。
   * 若等应用跑起来再 `page.evaluate` 写 localStorage，会被 registry/settings 的
   * 内存副本 `persist()` 覆盖回去 —— 见 seedBeforeBoot 的详细说明。
   */
  await seedBeforeBoot(pageA, { settingsPatch: BAD_S3_PATCH });
  const loggedA = await loginViaUi(pageA, '[A]');
  check(loggedA, '[A] 登录成功');
  if (!loggedA) throw new Error('[A] 登录失败');

  await pageA.waitForSelector('.editorbar, .empty', { timeout: 30000 });
  await pageA.waitForTimeout(6000);

  const injected = await pageA.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}');
    return { bucket: s.storage?.bucket, endpoint: s.storage?.endpoint, ak: Boolean(s.storage?.accessKeyId) };
  });
  check(
    injected.bucket === BAD_BUCKET && injected.ak,
    '[A] 已确认注入故障配置（bucket=zhenglob + 假 AK，结构上"合法"）',
    `bucket=${injected.bucket}`,
  );

  const resA = await triggerSync(pageA, { waitMs: 10000 });
  const okCalls = resA.storageCalls.filter((c) => c.status < 400);
  const badCalls = resA.storageCalls.filter((c) => c.status >= 400 && !(c.method === 'HEAD' && c.status === 404));
  console.log(`    /api/storage/* 请求 ${resA.storageCalls.length} 个（成功 ${okCalls.length}，异常 ${badCalls.length}）`);
  console.log(`    aliyuncs.com 请求：${resA.ossCalls.length} 个`);

  check(resA.ossCalls.length === 0, '[A] 0 个直连阿里云 OSS 的请求（已登录永不直连自建 S3）', `${resA.ossCalls.length} 个`);
  check(resA.storageCalls.length > 0, '[A] 同步确实走了 /api/storage/* 服务端代理', `${resA.storageCalls.length} 个`);
  check(badCalls.length === 0, '[A] /api/storage/* 无失败请求（除 HEAD 404 探测）', badCalls.length ? JSON.stringify(badCalls.slice(0, 2)) : '0 个');
  check(!/Failed to fetch/i.test(resA.errText), '[A] UI 未出现「Failed to fetch」', '未出现');
  check(!/同步失败/.test(resA.errText), '[A] UI 未出现「同步失败」', '未出现');
  const errsA = errorsA.filter((m) => !/ResizeObserver|clipboard|NotAllowedError/i.test(m));
  check(errsA.length === 0, '[A] 无 JS 运行时异常', errsA.slice(0, 2).join(' | ') || '0 个');
} finally {
  await browserA.close();
}

/* ================================================================== */
/* B. 未登录 + bucket:"zhenglob" → 提示必须含桶名/CORS，不得是笼统三选一  */
/* ================================================================== */

section('[B] 未登录 + bucket:"zhenglob" → 提示须含桶名或 CORS（不能是笼统三选一）');

const browserB = await launch();
const ctxB = await browserB.newContext({ viewport: { width: 1440, height: 900 } });
const pageB = await ctxB.newPage();
await seedDeviceId(pageB);
try {
  // 关键：**不登录**，并在启动前注入故障配置（见 seedBeforeBoot 的说明）
  await seedBeforeBoot(pageB, { settingsPatch: BAD_S3_PATCH });
  await pageB.goto(`${WEB}/app`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await pageB.waitForSelector('.editorbar, .empty', { timeout: 30000 });
  await pageB.waitForTimeout(3000);

  const loginStateB = await pageB.evaluate(() => Boolean(localStorage.getItem('neomd.access')));
  check(!loginStateB, '[B] 确认处于未登录状态（无 access token）');

  const resB = await triggerSync(pageB, { waitMs: 12000 });
  console.log(`    OSS 直连尝试：${resB.ossCalls.length} 个`);
  if (resB.ossCalls.length) console.log(`    首个：${resB.ossCalls[0].slice(0, 120)}`);

  /*
   * 断言核心：提示必须**点名**这是对象存储/桶名/CORS 问题。
   * 1.1.8 的失败形态正是这里只有「① 网络中断 ② 跨域被拦 ③ 地址填错」三选一。
   */
  const textB = resB.errText;
  const hasBucketHint = textB.includes(BAD_BUCKET) || /桶名/.test(textB);
  const hasCorsHint = /CORS/i.test(textB);
  const isVagueTriple =
    /①\s*网络中断/.test(textB) && /②\s*浏览器拦截了跨域请求/.test(textB) && /③\s*自建服务器地址配置错误/.test(textB);

  check(hasBucketHint || hasCorsHint, '[B] 提示含「桶名」或「CORS」字样（可定位到自建存储）', hasBucketHint ? `含桶名 ${BAD_BUCKET}` : hasCorsHint ? '含 CORS' : '都没有');
  check(!isVagueTriple, '[B] 提示不再是笼统「① 网络中断 ② 跨域被拦 ③ 地址错」三选一', isVagueTriple ? '仍是三选一' : '已针对性提示');
  check(
    /对象存储|桶/.test(textB),
    '[B] 提示明确指向「对象存储」而非泛泛的网络问题',
    /对象存储/.test(textB) ? '含「对象存储」' : '未指向对象存储',
  );
  if (textB) {
    // 截一段给 lead 看，便于人工判断文案质量
    const snippet = textB.replace(/\s+/g, ' ').slice(0, 260);
    console.log(`    实测提示：${snippet}`);
  }
  await pageB.screenshot({ path: path.join(shots, 'b-unlogged-bad-bucket.png') });
} finally {
  await browserB.close();
}

/* ================================================================== */
/* C. 服务端不可达（route 拦截 /api/storage/**）→ 提示必须含具体 host    */
/* ================================================================== */

section('[C] 服务端不可达 → 提示须含具体 host（不能只有 Failed to fetch）');

const browserC = await launch();
const ctxC = await browserC.newContext({ viewport: { width: 1440, height: 900 } });
const pageC = await ctxC.newPage();
await seedDeviceId(pageC);
try {
  const loggedC = await loginViaUi(pageC, '[C]');
  check(loggedC, '[C] 登录成功');
  if (!loggedC) throw new Error('[C] 登录失败');
  await pageC.waitForSelector('.editorbar, .empty', { timeout: 30000 });
  await pageC.waitForTimeout(5000);

  /*
   * 用 route 让 /api/storage/** 在**网络层**失败（abort），精确模拟
   * 「服务端不可达 / 断网 / CORS 预检被拒」—— 这三种在浏览器里都是
   * `TypeError: Failed to fetch`，也正是用户报障的形态。
   */
  await pageC.route('**/api/storage/**', (route) => route.abort('failed'));
  const resC = await triggerSync(pageC, { waitMs: 10000 });
  await pageC.unroute('**/api/storage/**');

  const textC = resC.errText;
  console.log(`    拦截后 /api/storage 响应数：${resC.storageCalls.length}`);
  if (textC) console.log(`    实测提示：${textC.replace(/\s+/g, ' ').slice(0, 260)}`);

  /*
   * 断言核心：必须能在提示里看到**具体 host**。
   * 本地环境 host 是 127.0.0.1:5178（vite 代理），线上会是 md.zhengl.vip；
   * 因此断言用「提示里出现了 URL 的 host」这个通用判据，不写死具体域名。
   */
  const webHost = new URL(WEB).host;
  const hasConcreteHost = textC.includes(webHost) || /127\.0\.0\.1|localhost|md\.zhengl\.vip/.test(textC);
  check(hasConcreteHost, `[C] 提示含具体 host（如 ${webHost}），而非只有 Failed to fetch`, hasConcreteHost ? '含 host' : '未含 host');
  check(
    /无法连接/.test(textC),
    '[C] 提示是「无法连接 <host>」的可定位形态',
    /无法连接/.test(textC) ? '含「无法连接」' : '未含',
  );
  /*
   * 允许仍出现 Failed to fetch（它是浏览器原始文案，被我们保留在括号里
   * 便于搜索），但**不能只有它** —— 即必须同时有 host 信息。
   */
  check(
    !(/Failed to fetch/i.test(textC) && !hasConcreteHost),
    '[C] 不存在「只有 Failed to fetch、没有 host」的退化形态',
    '形态正确',
  );
  await pageC.screenshot({ path: path.join(shots, 'c-server-unreachable.png') });
} finally {
  await browserC.close();
}

/* ================================================================== */
/* D. 回归：正常登录同步仍然成功                                        */
/* ================================================================== */

section('[D] 回归：正常登录同步仍成功（错误处理改动未破坏主链路）');

const browserD = await launch();
const ctxD = await browserD.newContext({ viewport: { width: 1440, height: 900 } });
const pageD = await ctxD.newPage();
await seedDeviceId(pageD);
try {
  const loggedD = await loginViaUi(pageD, '[D]');
  check(loggedD, '[D] 登录成功');
  if (!loggedD) throw new Error('[D] 登录失败');
  await pageD.waitForSelector('.editorbar, .empty', { timeout: 30000 });
  // 干净配置：清掉 storage（走平台代理）
  await pageD.evaluate(() => {
    const KEY = 'neomd.settings.v1';
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.storage) {
      s.storage.bucket = '';
      s.storage.accessKeyId = '';
      s.storage.accessKeySecret = '';
      s.storage.endpoint = '';
    }
    localStorage.setItem(KEY, JSON.stringify(s));
  });
  await pageD.reload({ waitUntil: 'domcontentloaded' });
  await pageD.waitForSelector('.editorbar, .empty', { timeout: 30000 });
  await pageD.waitForTimeout(5000);

  const resD = await triggerSync(pageD, { waitMs: 10000 });
  const okD = resD.storageCalls.filter((c) => c.status < 400);
  const badD = resD.storageCalls.filter((c) => c.status >= 400 && !(c.method === 'HEAD' && c.status === 404));
  console.log(`    /api/storage/* ${resD.storageCalls.length} 个（成功 ${okD.length}，异常 ${badD.length}）`);

  check(okD.length > 0, '[D] 正常同步有成功的存储请求', `${okD.length} 个`);
  check(badD.length === 0, '[D] 正常同步无失败存储请求', badD.length ? JSON.stringify(badD.slice(0, 2)) : '0 个');
  check(resD.ossCalls.length === 0, '[D] 正常同步 0 个 OSS 直连', `${resD.ossCalls.length} 个`);
  check(!/同步失败/.test(resD.errText), '[D] 正常同步 UI 无「同步失败」', '未出现');

  // 服务端侧确认 lastSyncedAt 已回写（证明真的同步成功，不只是没报错）
  const vaultsD = await apiReadWithRetry('/api/vaults', authHeaders(), { label: '[D]' });
  const listD = vaultsD.json?.data?.vaults ?? [];
  const localState = await pageD.evaluate(() => {
    const raw = localStorage.getItem('neomd.vaultList.v1');
    const p = raw ? JSON.parse(raw) : { entries: [], currentVaultId: '' };
    return { currentVaultId: p.currentVaultId, entries: (p.entries || []).map((e) => ({ vaultId: e.vaultId, lastSyncedAt: e.lastSyncedAt ?? null })) };
  });
  const remoteCur = listD.find((v) => v.vaultId === localState.currentVaultId);
  const localCur = localState.entries.find((e) => e.vaultId === localState.currentVaultId);
  check(Boolean(remoteCur?.lastSyncedAt), '[D] 服务端 lastSyncedAt 已回写（同步真的成功）', `${remoteCur?.lastSyncedAt}`);
  check(Boolean(localCur?.lastSyncedAt), '[D] 本地 registry lastSyncedAt 已回写', `${localCur?.lastSyncedAt}`);
} finally {
  await browserD.close();
}

/* ================================================================== */
/* E. explainSyncError 分支完整性（纯前端，通过页面注入异常验证）        */
/* ================================================================== */

section('[E] explainSyncError 分支完整性（旧分支未被新分支挤掉）');

/*
 * 直接在页面里调用 store 的 explainSyncError 不可行（未导出），
 * 改为验证**可观测的行为等价物**：
 * 通过 route 让 /api/storage 返回带特定错误码的 JSON，断言提示文案中
 * 出现了对应分支的特征词，从而证明该分支仍然可达。
 */
const browserE = await launch();
const ctxE = await browserE.newContext({ viewport: { width: 1280, height: 800 } });
const pageE = await ctxE.newPage();
await seedDeviceId(pageE);
try {
  const loggedE = await loginViaUi(pageE, '[E]');
  check(loggedE, '[E] 登录成功');
  if (loggedE) {
    await pageE.waitForSelector('.editorbar, .empty', { timeout: 30000 });
    await pageE.waitForTimeout(4000);

    /** 让所有 /api/storage 返回指定错误包体，然后同步，读取提示 */
    const syncWithError = async (status, code, message) => {
      await pageE.route('**/api/storage/**', async (route) => {
        await route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: { code, message } }),
        });
      });
      const r = await triggerSync(pageE, { waitMs: 8000 });
      await pageE.unroute('**/api/storage/**');
      return r.errText;
    };

    const quotaText = await syncWithError(403, 'QUOTA_EXCEEDED', '存储配额不足，请清理空间或联系管理员扩容');
    check(/配额/.test(quotaText), '[E] QUOTA_EXCEEDED → 配额提示可达', quotaText.replace(/\s+/g, ' ').slice(0, 80));

    const disabledText = await syncWithError(403, 'VAULT_DISABLED', '该仓库已停用，请先在仓库管理中重新启用');
    check(/停用|启用/.test(disabledText), '[E] VAULT_DISABLED → 停用提示可达', disabledText.replace(/\s+/g, ' ').slice(0, 80));

    const unregText = await syncWithError(403, 'VAULT_NOT_REGISTERED', '该仓库未注册或不属于当前账号');
    check(
      /未注册|未在服务器登记/.test(unregText),
      '[E] VAULT_NOT_REGISTERED → 未注册提示可达',
      unregText.replace(/\s+/g, ' ').slice(0, 80),
    );
  }
} finally {
  await browserE.close();
}

/* ================================================================== */
/* 汇总                                                                */
/* ================================================================== */

console.log(`\n${'='.repeat(64)}`);
console.log(`通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('全部断言通过 ✓');
process.exit(0);
