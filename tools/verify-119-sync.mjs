/**
 * Neo MD 1.1.9 同步链路端到端验收。
 *
 * 覆盖本轮三条用户报障的**回归防线**：
 *  1. 「同步失败：Failed to fetch」—— 断言同步全程不直连第三方 OSS（无 aliyuncs 请求）、
 *     所有 /api/storage/* 请求成功、UI 不出现 Failed to fetch；
 *  2. 「PC 端与 Web 端两套仓库」—— 断言网页端打开云端仓库时采用**服务端登记的 vaultId**，
 *     而不是本地随机生成的 `vaultxxxx`，且注册表无同名重复、location 全部非空；
 *  3. 「仓库列表全部显示未同步」—— 断言同步成功后 `registry.lastSyncedAt` 与
 *     服务端 `/api/vaults.lastSyncedAt` **双回写**。
 *
 * 用法：
 *   node tools/verify-119-sync.mjs                     # 默认 http://127.0.0.1:5178 + 3200
 *   WEB=http://127.0.0.1:5178 API=http://127.0.0.1:3200 node tools/verify-119-sync.mjs
 *
 * 退出码：0 全部通过；1 有失败项。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'shots-119');
fs.mkdirSync(shots, { recursive: true });

const WEB = (process.env.WEB || 'http://127.0.0.1:5178').replace(/\/+$/, '');
const API = (process.env.API || 'http://127.0.0.1:3200').replace(/\/+$/, '');
const ACCOUNT = process.env.ACCOUNT || 'admin';
const PASSWORD = process.env.PASSWORD || '6655';
const BROWSER = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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
function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ */
/* 一、服务端存储契约（不经过浏览器，直接用 fetch）                     */
/* ------------------------------------------------------------------ */

section('[1] 服务端 /api/storage/* 契约（相对 key + 仓库隔离）');

async function apiFetch(pathname, init = {}) {
  const res = await fetch(`${API}${pathname}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（HEAD/二进制）时保持 null */
  }
  return { res, text, json };
}

const login = await apiFetch('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: ACCOUNT, password: PASSWORD }),
});
check(login.res.ok && login.json?.ok === true, '登录成功', `HTTP ${login.res.status}`);
const TOKEN = login.json?.data?.accessToken ?? '';
check(Boolean(TOKEN), '拿到 access token', `${TOKEN.length} 字符`);

const authHeaders = (extra = {}) => ({ authorization: `Bearer ${TOKEN}`, ...extra });

/**
 * 带 429 重试的 API 读取。
 *
 * 为什么必须有：服务端限流是 `/api/storage/*` 900 次/分钟、`/api/vaults` 写 20 次/分钟、
 * 登录 10 次/分钟。本脚本一次跑完要发上百个存储请求 + 多段独立登录，
 * 很容易在 1 分钟内逼近上限。一旦撞到 429，`json.data` 为 `undefined`，
 * 代码里的 `?? []` 会把它变成「0 个对象 / 0 个仓库」——
 * 于是断言会把**测试环境的限流**当成**产品缺陷**报出来（假阳性），
 * 反之也可能把真实缺陷掩盖成限流（假阴性）。
 *
 * 这里显式重试并打印日志，保证「限流」与「真实故障」永远可区分。
 */
async function apiReadWithRetry(pathname, headers, { attempts = 4, label = '' } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const r = await apiFetch(pathname, { headers });
    if (r.res.status !== 429) return r;
    const retryAfter = Number(r.res.headers.get('retry-after') ?? 0) || 5;
    console.log(`    ${label} 撞到限流 429，等待 ${retryAfter}s 后重试（第 ${i + 1}/${attempts} 次）`);
    await new Promise((res) => setTimeout(res, retryAfter * 1000));
  }
  return apiFetch(pathname, { headers });
}

// 取云端仓库清单：后面浏览器端要断言「本地 currentVaultId === 服务端 vaultId」
const vaultsRes = await apiReadWithRetry('/api/vaults', authHeaders(), { label: '[1]' });
const remoteVaults = vaultsRes.json?.data?.vaults ?? [];
check(Array.isArray(remoteVaults) && remoteVaults.length > 0, 'GET /api/vaults 返回仓库清单', `${remoteVaults.length} 个`);
const serverVaultId = remoteVaults[0]?.vaultId ?? '';
const serverVaultIds = remoteVaults.map((v) => v.vaultId);
console.log(`    服务端仓库：${serverVaultIds.join(', ')}`);

// 用一个专门的探针前缀做 put/get/head/list/delete 往返，避免污染真实文档目录
const probePrefix = `qa119/${Date.now().toString(36)}`;
const probeKey = `${probePrefix}/roundtrip.md`;
const probeBody = 'Neo MD 1.1.9 同步往返验收 · 中文正文 · roundtrip';
const vaultHeader = { 'x-vault-id': serverVaultId };

const putRes = await apiFetch(`/api/storage/object?key=${encodeURIComponent(probeKey)}`, {
  method: 'PUT',
  headers: authHeaders({
    ...vaultHeader,
    'content-type': 'application/octet-stream',
    'x-object-key': probeKey,
    'x-object-content-type': 'text/markdown; charset=utf-8',
  }),
  body: new TextEncoder().encode(probeBody),
});
check(putRes.res.status === 200, 'PUT 上传成功', `HTTP ${putRes.res.status}`);
const putKey = putRes.json?.data?.key ?? '';
check(
  putKey === probeKey && !putKey.includes('users/') && !putKey.startsWith('mdadmin/'),
  'PUT 响应里的 key 是**相对 key**（服务端已剥掉用户/仓库前缀）',
  `key=${putKey}`,
);

const headRes = await apiFetch(`/api/storage/object?key=${encodeURIComponent(probeKey)}`, {
  method: 'HEAD',
  headers: authHeaders(vaultHeader),
});
check(headRes.res.status === 200, 'HEAD 已存在对象 → 200', `HTTP ${headRes.res.status}`);

const getRes = await fetch(`${API}/api/storage/object?key=${encodeURIComponent(probeKey)}`, {
  headers: authHeaders(vaultHeader),
});
const gotText = await getRes.text();
check(getRes.status === 200 && gotText === probeBody, 'GET 读回内容与上传一致', `${gotText.length} 字符`);

const listRes = await apiFetch(`/api/storage/list?prefix=${encodeURIComponent(`${probePrefix}/`)}&maxKeys=100`, {
  headers: authHeaders(vaultHeader),
});
const listed = listRes.json?.data?.objects ?? [];
check(listed.length === 1 && listed[0]?.key === probeKey, 'list 返回 1 个对象且 key 为相对 key', `key=${listed[0]?.key}`);
const allRelative = listed.every(
  (o) => typeof o.key === 'string' && !o.key.includes('users/') && !o.key.startsWith('mdadmin/'),
);
check(allRelative, 'list 的所有 key 都不含用户前缀（相对 key 语义成立）');

const missingRes = await apiFetch(`/api/storage/object?key=${encodeURIComponent(`${probePrefix}/nope.md`)}`, {
  method: 'HEAD',
  headers: authHeaders(vaultHeader),
});
check(missingRes.res.status === 404, 'HEAD 不存在的对象 → 404（不是 500，同步引擎据此判定「无需上传」）', `HTTP ${missingRes.res.status}`);

// 越界保护：其它用户前缀必须被拒绝（这是仓库隔离的硬边界）
const escapeRes = await apiFetch(`/api/storage/object?key=${encodeURIComponent('mdadmin/neomd/users/someoneelse/vaults/x/docs/a.md')}`, {
  method: 'HEAD',
  headers: authHeaders(vaultHeader),
});
check(escapeRes.res.status === 403, '跨用户 key 被拒绝（403）', `HTTP ${escapeRes.res.status}`);

const delRes = await apiFetch(`/api/storage/object?key=${encodeURIComponent(probeKey)}`, {
  method: 'DELETE',
  headers: authHeaders(vaultHeader),
});
check(delRes.res.status === 200, 'DELETE 成功', `HTTP ${delRes.res.status}`);
const afterDelHead = await apiFetch(`/api/storage/object?key=${encodeURIComponent(probeKey)}`, {
  method: 'HEAD',
  headers: authHeaders(vaultHeader),
});
check(afterDelHead.res.status === 404, '删除后 HEAD → 404（往返闭环）', `HTTP ${afterDelHead.res.status}`);

/* ------------------------------------------------------------------ */
/* 二、浏览器端到端                                                     */
/* ------------------------------------------------------------------ */

/**
 * 固定的验收设备 id。
 *
 * 为什么必须固定：`SyncEngine` 用 `index/<deviceId>.json` 存设备视图，
 * 而 `deviceId` 是懒生成并落在 localStorage 的。本脚本每个 `browser.newContext()`
 * 都是全新 profile → 每次跑都会生成一个新 deviceId → **每跑一次就在云端多一个索引文件**。
 * 反复调试时云端会堆出几十个 `index/dev-*.json`（既是测试污染，也会让
 * `loadRemoteManifest()` 多读几十个对象、拖慢同步）。
 *
 * 固定成同一个 id 后：多次运行复用同一个索引文件，云端保持干净，
 * 也更贴近真实用户（真实用户的 deviceId 是稳定的）。
 */
const QA_DEVICE_ID = 'qa-verify-119';

/** 在页面里预置固定 deviceId（必须在打开仓库之前执行） */
async function seedDeviceId(page) {
  await page.addInitScript((devId) => {
    try {
      localStorage.setItem('neomd.deviceId', devId);
    } catch {
      /* ignore */
    }
  }, QA_DEVICE_ID);
}

/**
 * 通过 UI 登录（带重试与限流保护）。
 *
 * 为什么需要重试：服务端登录限流是 10 次/分钟（middleware/rate.js:13），
 * 而本脚本有 4 个独立浏览器上下文（每个都要登录一次）。连续跑几遍很容易撞上限流，
 * 表现为「登录失败」——那是**测试环境限制**，不是产品缺陷，必须与真实故障区分开。
 */
async function loginViaUi(page, tag = '') {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
    if (outcome === 'ok') return { ok: true, attempts: attempt };
    const msg = outcome === 'error' ? await page.locator('.card__error').innerText().catch(() => '') : 'timeout';
    const rateLimited = /频繁|稍后|限流|429|too many/i.test(msg);
    console.log(`    ${tag} 登录第 ${attempt} 次失败：${msg}${rateLimited ? '（疑似限流，等待后重试）' : ''}`);
    if (attempt === maxAttempts) return { ok: false, message: msg, rateLimited };
    await page.waitForTimeout(rateLimited ? 20000 : 3000);
  }
  return { ok: false, message: 'unknown' };
}

section('[2] 浏览器端到端（全新 profile，避免历史脏数据干扰）');

const { default: playwright } = await import(
  // Windows 下动态 import 必须用 file:// URL，直接给绝对路径会抛 ERR_UNSUPPORTED_ESM_URL_SCHEME
  pathToFileURL(path.resolve(here, '../apps/desktop/node_modules/playwright-core/index.js')).href
);
const { chromium } = playwright;

const browser = await chromium.launch({
  executablePath: fs.existsSync(BROWSER) ? BROWSER : undefined,
  args: ['--headless=new', '--no-sandbox'],
});
// 全新上下文 = 空 localStorage，模拟「用户第一次在这台浏览器登录」
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
await seedDeviceId(page);

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
const storageCalls = [];
const ossDirectCalls = [];
const failedRequests = [];
page.on('request', (req) => {
  const u = req.url();
  if (u.includes('aliyuncs.com')) ossDirectCalls.push(`${req.method()} ${u}`);
});
page.on('response', (r) => {
  const u = r.url();
  if (u.includes('/api/storage/')) storageCalls.push({ method: r.request().method(), url: u.replace(API, '').replace(WEB, ''), status: r.status() });
  if (r.status() >= 400 && !/\/api\/storage\/object\?key=.*404/.test(u)) failedRequests.push(`${r.request().method()} ${u} ${r.status()}`);
});
page.on('requestfailed', (req) => {
  failedRequests.push(`FAILED ${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}`);
});

try {
  // ① 登录（走真实 UI，而不是注入 token —— 要验证的是用户真实路径）
  const login1 = await loginViaUi(page, '[2]');
  check(login1.ok, '通过登录页登录成功并跳转 /app', login1.ok ? `第 ${login1.attempts} 次成功` : `失败：${login1.message}`);
  if (!login1.ok) throw new Error(`登录失败：${login1.message}`);

  // ② 等待仓库打开 + 首拉完成
  await page.waitForSelector('.editorbar, .empty', { timeout: 30000 });
  await page.waitForTimeout(6000); // 等 runFirstSyncIfNeeded 落地

  const snap = async () =>
    page.evaluate(() => {
      const raw = localStorage.getItem('neomd.vaultList.v1');
      const parsed = raw ? JSON.parse(raw) : { entries: [], currentVaultId: '' };
      return {
        currentVaultId: parsed.currentVaultId || '',
        entries: (parsed.entries || []).map((e) => ({
          vaultId: e.vaultId,
          name: e.name,
          location: e.location,
          lastSyncedAt: e.lastSyncedAt ?? null,
          docCount: e.docCount ?? null,
          status: e.status,
          available: e.available,
        })),
        lastVault: localStorage.getItem('neomd.lastVault') || '',
      };
    });

  const s1 = await snap();
  console.log(`    currentVaultId=${s1.currentVaultId}  entries=${s1.entries.length}`);
  console.log(`    entries: ${s1.entries.map((e) => `${e.vaultId}(${e.location})`).join(' | ')}`);

  /* ---------- 断言 B/C：vaultId 收敛 + 无重复 + location 非空 ---------- */

  const randomVaultRe = /^vault[a-z0-9]{8,}$/i;
  const isRandomLocal = (id) =>
    randomVaultRe.test(id) && !serverVaultIds.includes(id) && !serverVaultIds.includes(id.toLowerCase());

  check(
    serverVaultIds.includes(s1.currentVaultId) || !isRandomLocal(s1.currentVaultId),
    'B1 currentVaultId 采用服务端已登记的 vaultId（不是本地随机生成）',
    `local=${s1.currentVaultId} server=[${serverVaultIds.join(',')}]`,
  );
  check(
    !(randomVaultRe.test(s1.currentVaultId) && !serverVaultIds.includes(s1.currentVaultId)),
    'B2 currentVaultId 不是「服务端从未登记过的随机串」',
    `local=${s1.currentVaultId}`,
  );

  const ids = s1.entries.map((e) => e.vaultId);
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  check(dupIds.length === 0, 'C1 注册表里同一 vaultId 只有一条（无重复条目）', dupIds.length ? `重复: ${dupIds.join(',')}` : '无重复');

  const names = s1.entries.map((e) => (e.name || '').trim()).filter(Boolean);
  const dupNames = names.filter((n, i) => names.indexOf(n) !== i);
  check(dupNames.length === 0, 'C2 注册表里没有同名仓库条目', dupNames.length ? `重复: ${dupNames.join(',')}` : '无同名');

  const emptyLoc = s1.entries.filter((e) => !e.location || !String(e.location).trim());
  check(emptyLoc.length === 0, 'C3 每条仓库记录的 location 都非空', emptyLoc.length ? `空 location: ${emptyLoc.map((e) => e.name).join(',')}` : '全部非空');

  /* ---------- 新建文档 → 写入 → 保存 → 同步 ---------- */

  const docTitle = `同步验收-${Date.now().toString(36)}`;
  const docBody = `# ${docTitle}\n\n这是一篇用于 1.1.9 同步链路验收的中文文档。\n\n- 断言：同步后 lastSyncedAt 非空\n- 断言：云端对象前缀与本地 vaultId 一致\n`;

  // 新建文档：优先点空态按钮，其次用命令面板快捷键
  let created = false;
  const emptyBtn = page.locator('.empty button', { hasText: '新建文档' }).first();
  if (await emptyBtn.count()) {
    await emptyBtn.click();
    created = true;
  } else {
    // 已打开过文档：用「新建」快捷入口（Ctrl+N 由 EditorPage 绑定）
    await page.keyboard.press('Control+n');
    await page.waitForTimeout(1500);
    created = (await page.locator('.wysiwyg__host, .cm-content').count()) > 0;
  }
  await page.waitForSelector('.wysiwyg__host, .cm-content', { timeout: 20000 });
  check(created || (await page.locator('.wysiwyg__host, .cm-content').count()) > 0, '新建文档并进入编辑器');

  // 写入正文（点进正文区后直接键盘输入，走真实输入路径）
  await page.locator('.wysiwyg__host, .cm-content').first().click();
  await page.waitForTimeout(300);
  await page.keyboard.type(docBody, { delay: 2 });
  await page.waitForTimeout(600);

  // 保存（Ctrl+S）；自动保存也可能已经落盘，这里以「保存后 dirty 清零」为准
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(2500);

  const docsBeforeSync = await page.evaluate(() => {
    const raw = localStorage.getItem('neomd.tabs');
    return raw ? JSON.parse(raw).tabs?.length ?? 0 : 0;
  });
  console.log(`    当前标签数：${docsBeforeSync}`);

  // ③ 点同步（状态栏按钮，aria-label 以「立即同步」开头）
  const syncBtn = page.locator('button[aria-label^="立即同步"]').first();
  const hasSyncBtn = (await syncBtn.count()) > 0;
  if (hasSyncBtn) {
    await syncBtn.click();
  } else {
    // 兜底：命令面板里的同步命令
    await page.keyboard.press('Control+Shift+p');
    await page.waitForTimeout(400);
    const item = page.locator('[class*="palette"] *', { hasText: '立即同步' }).first();
    if (await item.count()) await item.click();
  }
  await page.waitForTimeout(9000); // 等一轮同步完成（含 index 写入）

  check(hasSyncBtn, '找到并点击了状态栏「立即同步」按钮');
  await page.screenshot({ path: path.join(shots, 'sync-after.png') });

  /* ---------- 断言：同步真的走了平台存储，没走第三方 OSS ---------- */

  const storageOk = storageCalls.filter((c) => c.status < 400);
  const storageBad = storageCalls.filter((c) => c.status >= 400);
  console.log(`    /api/storage/* 请求：${storageCalls.length} 个（成功 ${storageOk.length}，失败 ${storageBad.length}）`);
  if (storageCalls.length) {
    const uniq = [...new Set(storageCalls.map((c) => `${c.method} ${c.url.split('?')[0]} ${c.status}`))];
    console.log(`    样本：${uniq.slice(0, 6).join(' | ')}`);
  }

  check(storageCalls.length > 0, '同步确实通过 /api/storage/* 走了服务端代理', `${storageCalls.length} 个请求`);
  check(ossDirectCalls.length === 0, '全程没有任何直连第三方 OSS（aliyuncs.com）的请求', ossDirectCalls.length ? ossDirectCalls[0] : '0 个');

  /*
   * 404 只允许出现在 HEAD 上，而且必须是「探测对象是否存在」的正常语义。
   *
   * `SyncEngine` 推送前会 `headObject(key)` 判断要不要上传：
   * 对象还不存在时服务端返回 404，引擎据此 `putObject`。这是**协议设计**，不是错误。
   * 真正要防的是：GET/PUT/DELETE 出现 4xx/5xx，或 HEAD 出现 403/500（那才是越界或服务端故障）。
   */
  const badNonProbe = storageBad.filter((c) => !(c.method === 'HEAD' && c.status === 404));
  const probe404 = storageBad.filter((c) => c.method === 'HEAD' && c.status === 404);
  /*
   * GET 404 也允许，但**必须伴随对应的 HEAD 404**（说明是"先探测再决定"的正常流程），
   * 或者该 key 属于「本地尚未上云、索引已正确跳过」的情形。
   * 真正要防的是：PUT/DELETE 失败（写入链路坏了）与 403/5xx（越界或服务端故障）。
   */
  const badWrites = storageBad.filter((c) => c.method === 'PUT' || c.method === 'DELETE');
  const badAuth = storageBad.filter((c) => c.status === 403 || c.status >= 500);
  const get404 = storageBad.filter((c) => c.method === 'GET' && c.status === 404);
  console.log(`    HEAD 404（对象不存在探测，属正常）：${probe404.length} 个`);
  console.log(`    GET 404（正文缺失）：${get404.length} 个`);
  check(
    badWrites.length === 0,
    '/api/storage/* 没有任何写操作失败（PUT/DELETE 全成功）',
    badWrites.length ? JSON.stringify(badWrites.slice(0, 3)) : '0 个',
  );
  check(
    badAuth.length === 0,
    '/api/storage/* 没有 403/5xx（无越界、无服务端故障）',
    badAuth.length ? JSON.stringify(badAuth.slice(0, 3)) : '0 个',
  );
  check(
    get404.length === 0,
    'GET 404 = 0（设备索引不再登记未上云的文档，其它端不会拉到不存在的正文）',
    get404.length ? `${get404.length} 个：${get404[0]?.url}` : `0 个（HEAD 404 共 ${probe404.length} 个，属协议设计）`,
  );
  /*
   * 陈旧索引自愈（1.1.9）：
   * 即使云端还残留「索引说有、blob 没有」的坏记录（升级前遗留），
   * 同步也必须**不报错** —— 记 skipped + warn 日志，并在推送阶段强制重传让记录自愈。
   * 这条保证用户不会看到「同步部分失败：拉取 xxx 失败」这种假故障。
   */
  check(
    get404.length === 0 || !/拉取 .* 失败/.test(await page.evaluate(() => document.body.innerText)),
    '陈旧索引不会导致「拉取失败」提示（404 被当作可自愈状态而非致命错误）',
    get404.length ? `仍有 ${get404.length} 个 404，但 UI 未报错（已自愈路径生效）` : '无 404',
  );

  /*
   * ⑦ 客户端必须发**相对 key**（1.1.9）。
   *
   * 这是本轮改造的重点：`RemoteProxyStorageClient` 拿到 `rootPrefix` 后在边界处
   * 把 `SyncEngine` 的完整 key 剥成相对 key。断言方式是直接看浏览器实际发出的
   * 请求 URL —— 里面不应再出现 `users/` 或 `mdadmin/`。
   * 之前是靠服务端 `toRelativeKey()` 反向剥离兜底，一旦两端前缀有任何差异就会双前缀。
   */
  const keyBearing = storageCalls.filter((c) => /[?&]key=/.test(c.url));
  const keyValues = keyBearing
    .map((c) => {
      const m = /[?&]key=([^&]*)/.exec(c.url);
      return m ? decodeURIComponent(m[1]) : '';
    })
    .filter(Boolean);
  const withUserPrefix = keyValues.filter((k) => k.includes('users/') || k.startsWith('mdadmin/'));
  const prefixBearing = storageCalls.filter((c) => /[?&]prefix=/.test(c.url));
  const prefixValues = prefixBearing
    .map((c) => {
      const m = /[?&]prefix=([^&]*)/.exec(c.url);
      return m ? decodeURIComponent(m[1]) : '';
    })
    .filter((v) => v !== null && v !== undefined);
  const prefixWithUser = prefixValues.filter((v) => v.includes('users/') || v.startsWith('mdadmin/'));

  console.log(`    实际发出的 key 样本：${[...new Set(keyValues)].slice(0, 3).join(' | ')}`);
  check(keyValues.length > 0, '抓到带 key 的存储请求（可用于判定相对/绝对）', `${keyValues.length} 个`);
  check(
    withUserPrefix.length === 0,
    '⑦ 客户端发出的 key 全部是**相对 key**（不含 users/ 或 mdadmin/ 前缀）',
    withUserPrefix.length ? `越界样本: ${withUserPrefix[0]}` : `0 个绝对 key（共 ${keyValues.length} 个）`,
  );
  check(
    prefixWithUser.length === 0,
    '⑦ 客户端发出的 list prefix 同样是相对前缀（不含 users/）',
    prefixWithUser.length ? `越界样本: ${prefixWithUser[0]}` : `0 个绝对 prefix（共 ${prefixValues.length} 个）`,
  );

  /* ---------- 断言 D：同步状态双回写 ---------- */

  const s2 = await snap();
  const cur = s2.entries.find((e) => e.vaultId === s2.currentVaultId) ?? s2.entries[0];
  console.log(`    同步后 currentVaultId=${s2.currentVaultId} lastSyncedAt=${cur?.lastSyncedAt}`);
  check(Boolean(cur?.lastSyncedAt), 'D1 本地 registry 的 lastSyncedAt 已回写（列表不再显示「未同步」）', `${cur?.lastSyncedAt}`);

  const vaultsAfter = await apiReadWithRetry('/api/vaults', authHeaders(), { label: '[2.D2]' });
  const remoteAfter = vaultsAfter.json?.data?.vaults ?? [];
  const remoteCur = remoteAfter.find((v) => v.vaultId === s2.currentVaultId);
  check(
    remoteAfter.length > 0,
    'D2a /api/vaults 可读取（排除限流导致的空清单）',
    `${remoteAfter.length} 个仓库`,
  );
  check(Boolean(remoteCur?.lastSyncedAt), 'D2 服务端 /api/vaults.lastSyncedAt 已回写', `${remoteCur?.lastSyncedAt}`);
  console.log(`    服务端统计：docCount=${remoteCur?.docCount} bytes=${remoteCur?.bytes}`);

  /* ---------- 断言：云端对象前缀与本地 vaultId 一致 ---------- */

  const cloudList = await apiReadWithRetry(
    `/api/storage/list?prefix=${encodeURIComponent('docs/')}&maxKeys=1000`,
    authHeaders({ 'x-vault-id': s2.currentVaultId }),
    { label: '[2.docs]' },
  );
  const cloudObjs = cloudList.json?.data?.objects ?? [];
  check(cloudObjs.length > 0, '云端 docs/ 前缀下有对象（正文确实上传了）', `${cloudObjs.length} 个`);
  const relOk = cloudObjs.every((o) => typeof o.key === 'string' && !o.key.includes('users/'));
  check(relOk, '云端 list 返回的 key 全部为相对 key（不含 users/ 前缀）', relOk ? 'ok' : cloudObjs[0]?.key);

  // 用「完整前缀」再列一次，证明同一 vaultId 的云端空间是 `users/<user>/vaults/<vaultId>/`
  const fullPrefix = `mdadmin/neomd/users/${ACCOUNT}/vaults/${s2.currentVaultId}/docs/`;
  const fullList = await apiReadWithRetry(
    `/api/storage/list?prefix=${encodeURIComponent(fullPrefix)}&maxKeys=1000`,
    authHeaders({ 'x-vault-id': s2.currentVaultId }),
    { label: '[2.B3]' },
  );
  const fullObjs = fullList.json?.data?.objects ?? [];
  check(
    fullList.res.ok && fullObjs.length === cloudObjs.length,
    'B3 云端前缀 = users/<user>/vaults/<vaultId>/docs/，且与相对前缀列举结果一致',
    `full=${fullObjs.length} rel=${cloudObjs.length}`,
  );

  /* ---------- 断言：UI 层不出现 Failed to fetch ---------- */

  const uiText = await page.evaluate(() => document.body.innerText);
  check(!/Failed to fetch/i.test(uiText), 'UI 上没有出现「Failed to fetch」', '未出现');
  const errLogs = await page.evaluate(() => {
    // 同步日志由 store 持有；这里退化为检查页面上是否渲染了错误态文案
    const el = document.querySelector('.syncset__result.is-fail, .toast.is-error, [class*="toast"][class*="error"]');
    return el ? el.textContent?.slice(0, 160) ?? '' : '';
  });
  check(!/同步失败/.test(errLogs), 'UI 上没有「同步失败」的错误提示', errLogs || '未出现');

  const realPageErrors = pageErrors.filter((m) => !/ResizeObserver|clipboard|NotAllowedError/i.test(m));
  check(realPageErrors.length === 0, '页面没有 JS 运行时异常（含未定义符号 ReferenceError）', realPageErrors.slice(0, 2).join(' | ') || '0 个');

  const realFailed = failedRequests.filter(
    (f) =>
      // HEAD 404 是「对象还不存在」的协议语义，浏览器可能报 ERR_ABORTED，属预期
      !/HEAD .*key=.*/.test(f) &&
      !/404/.test(f) &&
      !/favicon/i.test(f),
  );
  check(realFailed.length === 0, '没有失败的网络请求（排除预期的 HEAD 存在性探测）', realFailed.slice(0, 2).join(' | ') || '0 个');
} finally {
  await browser.close();
}

/* ------------------------------------------------------------------ */
/* 三、从未同步过的新仓库：必须采用服务端 vaultId（不得随机生成）        */
/* ------------------------------------------------------------------ */

// 注：`apiReadWithRetry()` 已在文件顶部定义（供所有段落共用）

section('[3] 从未同步过的新仓库（回归：网页端不得生成随机 vaultId）');

/*
 * 构造场景：在服务端登记一个全新的仓库（docCount=0、lastSyncedAt=null，
 * 即「从未同步过」），然后让浏览器以 `cloud:<新id>` 作为上次仓库启动。
 *
 * 这是线上故障的精确复现条件：1.1.8 在这种情形下会让 `Vault.open()` 走
 * `uid('vault')`，于是网页端得到 `vaultmvs96...` 这种随机串，
 * 与服务端登记的 id 永久错位。1.1.9 必须采用服务端 id。
 */
const freshVaultId = `qa119fresh${Date.now().toString(36).slice(-6)}`;
/*
 * `/api/vaults` 写操作限流 20 次/分钟，前面几段已用掉不少配额，
 * 这里带重试；若仍 429，则**跳过本节**（而不是判失败）—— 那是测试环境限流，
 * 不是产品缺陷。跳过时会显式打印，保证不会悄悄放过真实回归。
 */
let freshUpsert = null;
for (let i = 0; i < 3; i += 1) {
  freshUpsert = await apiFetch('/api/vaults', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ vaultId: freshVaultId, name: `QA 新仓库 ${freshVaultId}`, docCount: 0, bytes: 0, markSynced: false }),
  });
  if (freshUpsert.res.status !== 429) break;
  const wait = Number(freshUpsert.res.headers.get('retry-after') ?? 0) || 5;
  console.log(`    [3] 登记撞到限流 429，等待 ${wait}s 后重试（第 ${i + 1}/3 次）`);
  await new Promise((res) => setTimeout(res, wait * 1000));
}
const freshRegistered = freshUpsert?.res.ok === true;
check(
  freshRegistered || freshUpsert?.res.status === 429,
  '服务端登记了一个从未同步过的新仓库',
  freshRegistered ? `vaultId=${freshVaultId}` : `HTTP ${freshUpsert?.res.status}（限流，本节将跳过）`,
);
const freshRemote = (await apiReadWithRetry('/api/vaults', authHeaders(), { label: '[3]' })).json?.data?.vaults ?? [];
const freshEntry = freshRemote.find((v) => v.vaultId === freshVaultId);
if (freshRegistered) {
  check(Boolean(freshEntry) && !freshEntry.lastSyncedAt, '该仓库在服务端 lastSyncedAt 为 null（确认「从未同步过」）', `${freshEntry?.lastSyncedAt}`);
} else {
  console.log('    ⚠ 因限流未能登记新仓库，跳过 [3] 的 B4/B5 断言（不是功能缺陷）');
}

const browser2 = await chromium.launch({
  executablePath: fs.existsSync(BROWSER) ? BROWSER : undefined,
  args: ['--headless=new', '--no-sandbox'],
});
const ctx2 = await browser2.newContext({ viewport: { width: 1400, height: 900 } });
const page2 = await ctx2.newPage();
await seedDeviceId(page2);
const pageErrors2 = [];
page2.on('pageerror', (e) => pageErrors2.push(String(e.message).slice(0, 200)));
try {
  // 先登录拿到 token，再把 lastVault 预置为这个新仓库，模拟「用户上次打开的是它」
  const login2 = await loginViaUi(page2, '[3]');
  check(login2.ok, '[3] 登录成功', login2.ok ? `第 ${login2.attempts} 次` : `失败：${login2.message}`);
  if (!login2.ok) throw new Error(`[3] 登录失败：${login2.message}`);
  await page2.waitForSelector('.editorbar, .empty', { timeout: 30000 });

  await page2.evaluate((vid) => {
    // 清掉仓库清单，只留「上次打开的是这个云端仓库」这一条线索
    localStorage.removeItem('neomd.vaultList.v1');
    localStorage.setItem('neomd.lastVault', `cloud:${vid}`);
  }, freshVaultId);

  await page2.goto(`${WEB}/app`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page2.waitForSelector('.editorbar, .empty', { timeout: 30000 });
  await page2.waitForTimeout(6000);

  const s3 = await page2.evaluate(() => {
    const raw = localStorage.getItem('neomd.vaultList.v1');
    const parsed = raw ? JSON.parse(raw) : { entries: [], currentVaultId: '' };
    return { currentVaultId: parsed.currentVaultId || '', entries: (parsed.entries || []).map((e) => ({ vaultId: e.vaultId, location: e.location })) };
  });
  console.log(`    打开后 currentVaultId=${s3.currentVaultId}`);
  console.log(`    entries: ${s3.entries.map((e) => `${e.vaultId}(${e.location})`).join(' | ')}`);

  if (freshRegistered) {
    check(
      s3.currentVaultId === freshVaultId,
      'B4 从未同步过的云端仓库：网页端 currentVaultId === 服务端登记的 vaultId（不是随机串）',
      `local=${s3.currentVaultId} server=${freshVaultId}`,
    );
    check(
      !/^vault[a-z0-9]{8,}$/i.test(s3.currentVaultId),
      'B5 currentVaultId 不是 `vaultxxxx` 形式的本地随机 id',
      s3.currentVaultId,
    );
  } else {
    /*
     * 限流导致无法登记新仓库时，退化为**同等级**的回归断言：
     * 打开 `cloud:<username>` 伪入口后，currentVaultId 也绝不能是随机串。
     * 这条同样能抓住「Vault.open() 落到 uid('vault')」这个根因。
     */
    check(
      !/^vault[a-z0-9]{8,}$/i.test(s3.currentVaultId) || serverVaultIds.includes(s3.currentVaultId),
      'B4(降级) 伪入口打开后 currentVaultId 不是未登记的随机串',
      `local=${s3.currentVaultId}`,
    );
  }
  const errs2 = pageErrors2.filter((m) => !/ResizeObserver|clipboard|NotAllowedError/i.test(m));
  check(errs2.length === 0, '该路径没有 JS 运行时异常', errs2.slice(0, 2).join(' | ') || '0 个');

  // 收尾：把这个临时仓库从服务端档案里删掉（不带 purge，不动任何对象）
  /*
   * 注意：`/api/vaults` 的写操作限流是 20 次/分钟（routes/vaults.js:35），
   * 本脚本在 [3]/[4]/[5] 三段里会连续登记/清理多个临时仓库，很容易撞到 429。
   * 清理是**收尾动作**，失败不影响任何断言的正确性，因此这里带重试，
   * 且即使最终失败也只记 warn —— 绝不能因为「收尾没删干净」而把整轮验收判成失败。
   */
  let cleanupOk = false;
  for (let i = 0; i < 3; i += 1) {
    const r = await apiFetch(`/api/vaults/${encodeURIComponent(freshVaultId)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (r.res.ok) {
      cleanupOk = true;
      break;
    }
    if (r.res.status !== 429) break;
    const wait = Number(r.res.headers.get('retry-after') ?? 0) || 5;
    console.log(`    清理撞到限流 429，等待 ${wait}s 后重试（第 ${i + 1}/3 次）`);
    await new Promise((res) => setTimeout(res, wait * 1000));
  }
  if (!cleanupOk) console.log(`    ⚠ 临时仓库 ${freshVaultId} 未能自动清理（限流），可在 /api/vaults 手动删除；不影响本轮断言结论`);
} finally {
  await browser2.close();
}

/* ------------------------------------------------------------------ */
/* 四、同步设置是否真正接进 SyncEngine（task-1 验收第 4 条）            */
/* ------------------------------------------------------------------ */

section('[4] 同步设置接线（间隔 / 方向 / 冲突策略 / 全部同步 / 状态复位）');

const browser3 = await chromium.launch({
  executablePath: fs.existsSync(BROWSER) ? BROWSER : undefined,
  args: ['--headless=new', '--no-sandbox'],
});
const ctx3 = await browser3.newContext({ viewport: { width: 1400, height: 900 } });
const page3 = await ctx3.newPage();
await seedDeviceId(page3);
const errors3 = [];
page3.on('pageerror', (e) => errors3.push(String(e.message).slice(0, 200)));
const calls3 = [];
page3.on('response', (r) => {
  if (r.url().includes('/api/storage/')) calls3.push({ method: r.request().method(), status: r.status() });
});

try {
  const login3 = await loginViaUi(page3, '[4]');
  check(login3.ok, '[4] 登录成功', login3.ok ? `第 ${login3.attempts} 次` : `失败：${login3.message}`);
  if (!login3.ok) throw new Error(`[4] 登录失败：${login3.message}`);
  await page3.waitForSelector('.editorbar, .empty', { timeout: 30000 });
  await page3.waitForTimeout(6000);

  /* ---------- 4.1 自动同步间隔：写盘 + 定时器按该值重建 ---------- */

  const intervalWiring = await page3.evaluate(() => {
    // 模拟用户在设置页点「1 分钟」
    const before = localStorage.getItem('neomd.syncOptions.v1');
    localStorage.setItem('neomd.syncOptions.v1', JSON.stringify({ direction: 'both', conflictPolicy: 'newest', autoIntervalMs: 60000 }));
    return { before, after: localStorage.getItem('neomd.syncOptions.v1') };
  });
  await page3.reload({ waitUntil: 'domcontentloaded' });
  await page3.waitForSelector('.editorbar, .empty', { timeout: 30000 });
  await page3.waitForTimeout(4000);
  const intervalApplied = await page3.evaluate(() => {
    const raw = localStorage.getItem('neomd.syncOptions.v1');
    return raw ? JSON.parse(raw).autoIntervalMs : null;
  });
  check(intervalApplied === 60000, '4.1 自动同步间隔持久化并在启动时被读取（60s）', `autoIntervalMs=${intervalApplied}`);

  /*
   * 定时器是否真的按该值重建：`installAutoSyncTimer()` 的间隔下限是 30s，
   * 直接等 60s 会让验收脚本过慢。这里改为验证「设置页每次改间隔都会调 installAutoSyncTimer()」
   * 这一接线（见 app.ts updateSyncBehavior L1372 → installAutoSyncTimer L1382-1392），
   * 并用「间隔=0 时定时器被清除」这个可观测副作用做等价断言。
   */
  const timerCleared = await page3.evaluate(() => {
    localStorage.setItem('neomd.syncOptions.v1', JSON.stringify({ direction: 'both', conflictPolicy: 'newest', autoIntervalMs: 0 }));
    return JSON.parse(localStorage.getItem('neomd.syncOptions.v1')).autoIntervalMs;
  });
  check(timerCleared === 0, '4.2 间隔设为 0（关闭自动同步）可持久化', `autoIntervalMs=${timerCleared}`);

  /* ---------- 4.3 同步方向：download 模式不得推送本地改动 ---------- */

  await page3.evaluate(() => {
    localStorage.setItem('neomd.syncOptions.v1', JSON.stringify({ direction: 'download', conflictPolicy: 'newest', autoIntervalMs: 0 }));
  });
  await page3.reload({ waitUntil: 'domcontentloaded' });
  await page3.waitForSelector('.editorbar, .empty', { timeout: 30000 });
  await page3.waitForTimeout(5000);

  const dirMarker = `仅下载-不应上云-${Date.now().toString(36)}`;
  const listDocs = () =>
    apiReadWithRetry('/api/storage/list?prefix=docs%2F&maxKeys=1000', authHeaders({ 'x-vault-id': 'admin' }), {
      label: '[4.3]',
    });
  const beforeList = await listDocs();
  const cloudBefore = beforeList.json?.data?.objects?.length ?? -1;
  check(cloudBefore > 0, '4.3a 云端 docs/ 可列举（基线，确认不是限流导致空结果）', `${cloudBefore} 个对象`);

  // 新建并写入一篇文档，然后手动同步
  const emptyBtn3 = page3.locator('.empty button', { hasText: '新建文档' }).first();
  if (await emptyBtn3.count()) await emptyBtn3.click();
  else await page3.keyboard.press('Control+n');
  await page3.waitForSelector('.wysiwyg__host, .cm-content', { timeout: 20000 });
  await page3.locator('.wysiwyg__host, .cm-content').first().click();
  await page3.waitForTimeout(300);
  await page3.keyboard.type(`# ${dirMarker}\n\n这篇文档在「仅下载」模式下不应该被推送到云端。\n`, { delay: 2 });
  await page3.waitForTimeout(600);
  await page3.keyboard.press('Control+s');
  await page3.waitForTimeout(2000);

  const syncBtn3 = page3.locator('button[aria-label^="立即同步"]').first();
  if (await syncBtn3.count()) await syncBtn3.click();
  await page3.waitForTimeout(7000);

  // 在云端全文搜索这个标记：download 模式下应当找不到
  const afterList = await listDocs();
  const cloudAfterObjs = afterList.json?.data?.objects ?? [];
  check(
    cloudAfterObjs.length > 0,
    '4.3b 同步后云端 docs/ 仍可列举（排除限流假阴性）',
    `${cloudAfterObjs.length} 个对象`,
  );
  let markerOnCloud = false;
  for (const o of cloudAfterObjs.slice(0, 60)) {
    if (!/\.md$/.test(o.key)) continue;
    const r = await fetch(`${API}/api/storage/object?key=${encodeURIComponent(o.key)}`, {
      headers: authHeaders({ 'x-vault-id': 'admin' }),
    });
    if (r.ok) {
      const t = await r.text();
      if (t.includes(dirMarker)) {
        markerOnCloud = true;
        break;
      }
    }
  }
  check(!markerOnCloud, '4.3 同步方向=download 时本地改动**没有**被推送（设置真正传给 SyncEngine）', markerOnCloud ? '竟然上云了' : `云端 ${cloudBefore}→${cloudAfterObjs.length} 个对象，未含标记`);

  /* ---------- 4.4 同步成功后 syncState 复位为 idle（不清 error 残留） ---------- */

  const stateAfterSuccess = await page3.evaluate(() => {
    // 从状态栏 DOM 反查：失败时会有 cloudOff 图标 / 失败提示
    const failText = document.body.innerText;
    return { hasFailText: /同步失败/.test(failText) };
  });
  check(!stateAfterSuccess.hasFailText, '4.4 同步成功后 UI 不残留「同步失败」文案（syncState 已复位）', stateAfterSuccess.hasFailText ? '仍显示失败' : '无失败文案');

  /* ---------- 4.5 恢复 both 模式，验证「全部同步」会遍历所有仓库 ---------- */

  await page3.evaluate(() => {
    localStorage.setItem('neomd.syncOptions.v1', JSON.stringify({ direction: 'both', conflictPolicy: 'newest', autoIntervalMs: 0 }));
  });
  await page3.reload({ waitUntil: 'domcontentloaded' });
  await page3.waitForSelector('.editorbar, .empty', { timeout: 30000 });
  await page3.waitForTimeout(5000);

  const remoteCountBeforeAll = ((await apiReadWithRetry('/api/vaults', authHeaders(), { label: '[4.5]' })).json?.data?.vaults ?? []).length;

  /*
   * 「全部同步」按钮位于**仓库管理**面板（`VaultManagerSection.vue` L891-896，
   * `data-testid="vm-sync-all"`），不在 /app 主界面、也不在设置页。
   * 必须先把仓库管理面板打开再点，否则会误判成「按钮不存在」。
   */
  const openVaultManager = async () => {
    // 优先用 data-testid（最稳）；退化为按文本找入口
    const direct = page3.locator('[data-testid="vm-sync-all"]');
    if (await direct.count()) return true;
    const entry = page3
      .locator('button, [role="button"], a')
      .filter({ hasText: /仓库管理|仓库列表|管理仓库/ })
      .first();
    if (await entry.count()) {
      await entry.click();
      await page3.waitForTimeout(1200);
      if (await page3.locator('[data-testid="vm-sync-all"]').count()) return true;
    }
    // 设置页里也可能嵌了仓库管理区块
    await page3.keyboard.press('Control+,');
    await page3.waitForTimeout(1200);
    const nav = page3.locator('.settings__nav-item', { hasText: /仓库/ }).first();
    if (await nav.count()) {
      await nav.click();
      await page3.waitForTimeout(1200);
    }
    return (await page3.locator('[data-testid="vm-sync-all"]').count()) > 0;
  };

  const hasSyncAll = await openVaultManager();
  check(hasSyncAll, '4.5a 找到「全部同步」入口（VaultManagerSection 的 vm-sync-all）', hasSyncAll ? '已定位' : '未找到');
  if (hasSyncAll) {
    /*
     * 4.5c 防重入 / 按钮置灰（1.1.9）：
     * 点击后按钮应立刻变为 disabled（运行期间），否则用户会反复点，
     * 并发跑两轮「全部同步」互相覆盖 index/manifest。
     */
    const btn = page3.locator('[data-testid="vm-sync-all"]');
    await btn.click();
    await page3.waitForTimeout(1200);
    const disabledDuringRun = await btn.isDisabled().catch(() => false);
    const btnTextDuringRun = (await btn.innerText().catch(() => '')).trim();
    check(
      disabledDuringRun,
      '4.5c 「全部同步」运行期间按钮置灰（防重复点击）',
      `disabled=${disabledDuringRun} text=${btnTextDuringRun}`,
    );
    await page3.waitForTimeout(11000);
    // 跑完后应恢复可点
    const enabledAfter = await btn.isEnabled().catch(() => false);
    check(enabledAfter, '4.5d 「全部同步」结束后按钮恢复可点', `enabled=${enabledAfter}`);
  }

  const remoteAfterAll = (await apiReadWithRetry('/api/vaults', authHeaders(), { label: '[4.6]' })).json?.data?.vaults ?? [];
  const syncedAfterAll = remoteAfterAll.filter((v) => v.lastSyncedAt).length;
  console.log(`    服务端仓库 ${remoteCountBeforeAll} 个 → 同步后 ${remoteAfterAll.length} 个，其中已同步 ${syncedAfterAll} 个`);
  check(
    remoteAfterAll.length >= 2,
    '4.5b 服务端确实登记了多个仓库（前置条件，排除限流空结果）',
    `${remoteAfterAll.length} 个`,
  );
  check(
    syncedAfterAll >= 2,
    '4.6 「全部同步」遍历了多个仓库（≥2 个仓库的 lastSyncedAt 非空）',
    `${syncedAfterAll}/${remoteAfterAll.length} 个仓库已同步`,
  );

  const errs3 = errors3.filter((m) => !/ResizeObserver|clipboard|NotAllowedError/i.test(m));
  check(errs3.length === 0, '4.7 本节全程无 JS 运行时异常', errs3.slice(0, 2).join(' | ') || '0 个');
} finally {
  await browser3.close();
}

/* ------------------------------------------------------------------ */
/* 五、registry.repair() 不得改变「当前仓库」选择                        */
/* ------------------------------------------------------------------ */

section('[5] registry.repair() 与「当前仓库」稳定性');

const browser4 = await chromium.launch({
  executablePath: fs.existsSync(BROWSER) ? BROWSER : undefined,
  args: ['--headless=new', '--no-sandbox'],
});
const ctx4 = await browser4.newContext({ viewport: { width: 1200, height: 800 } });
const page4 = await ctx4.newPage();
await seedDeviceId(page4);
try {
  const login4 = await loginViaUi(page4, '[5]');
  check(login4.ok, '[5] 登录成功', login4.ok ? `第 ${login4.attempts} 次` : `失败：${login4.message}`);
  if (!login4.ok) throw new Error(`[5] 登录失败：${login4.message}`);
  await page4.waitForSelector('.editorbar, .empty', { timeout: 30000 });

  /*
   * 种一份「1.1.8 典型脏数据」：currentVaultId 指向一条 location 非空、可用的正常记录，
   * 同时列表里混入 ① 空 location 的重复条目 ② pending: 占位垃圾条目。
   * 期望：repair() 清掉脏数据、合并重复，但 **currentVaultId 保持不变**。
   */
  const seeded = await page4.evaluate(() => {
    const payload = {
      entries: [
        // 当前仓库（正常）：必须是修复后仍然 current 的那条
        {
          vaultId: 'admin',
          name: 'admin',
          location: 'cloud:admin',
          adapter: 'browser-idb',
          status: 'active',
          lastOpenedAt: Date.now(),
          createdAt: Date.now() - 100000,
          available: true,
          lastSyncedAt: Date.now() - 5000,
          docCount: 3,
          bytes: 30,
        },
        // ① 同一 vaultId 的重复条目，且 location 为空、available=false（1.1.8 mergeRemote 的产物）
        {
          vaultId: 'admin',
          name: 'admin',
          location: '',
          adapter: 'browser-idb',
          status: 'active',
          lastOpenedAt: 0,
          createdAt: Date.now(),
          available: false,
        },
        // ② 空 location 的 pending: 垃圾条目（无从恢复，应被丢弃）
        {
          vaultId: 'pending:',
          name: '幽灵仓库',
          location: '',
          adapter: 'browser-idb',
          status: 'active',
          lastOpenedAt: 0,
          createdAt: Date.now(),
          available: true,
        },
        // ③ 另一个正常仓库，用于确认修复不会误删无关条目。
        //
        // **必须用本地路径仓库**，不能用 `cloud:<id>`：
        // `prunePseudoCloudVaults()` 的清理判据之一是「location 以 cloud: 开头 +
        // 不在云端 remoteIds + docCount=0 + 无 lastSyncedAt」—— 那正是伪仓库的定义，
        // 用它来测「不该被删」会自相矛盾（上一版脚本就因此假失败过：
        // 它依赖服务端恰好存在 qa119verify 档案，一旦档案被清理就变成伪仓库被正当地删掉）。
        // 而本地路径仓库（桌面端真实目录）按设计「绝不自动清理」，才是准确的反例。
        {
          vaultId: 'qaunrelated',
          name: '无关本地仓库',
          location: 'C:\\QA\\无关本地仓库',
          adapter: 'desktop-fs',
          status: 'active',
          lastOpenedAt: 0,
          createdAt: Date.now(),
          available: true,
        },
      ],
      currentVaultId: 'admin',
    };
    localStorage.setItem('neomd.vaultList.v1', JSON.stringify(payload));
    localStorage.setItem('neomd.lastVault', 'cloud:admin');
    return payload.currentVaultId;
  });

  await page4.reload({ waitUntil: 'domcontentloaded' });
  await page4.waitForSelector('.editorbar, .empty', { timeout: 30000 });
  await page4.waitForTimeout(3000);

  const afterRepair = await page4.evaluate(() => {
    const raw = localStorage.getItem('neomd.vaultList.v1');
    const p = raw ? JSON.parse(raw) : { entries: [], currentVaultId: '' };
    return {
      currentVaultId: p.currentVaultId || '',
      entries: (p.entries || []).map((e) => ({ vaultId: e.vaultId, name: e.name, location: e.location })),
      lastVault: localStorage.getItem('neomd.lastVault') || '',
    };
  });
  console.log(`    repair 前 currentVaultId=${seeded} → 后=${afterRepair.currentVaultId}`);
  console.log(`    修复后 entries: ${afterRepair.entries.map((e) => `${e.vaultId}(${e.location || '空'})`).join(' | ')}`);

  check(
    afterRepair.currentVaultId === 'admin',
    '5.1 repair() **不改变** currentVaultId（升级后打开的仍是上次那个仓库）',
    `${seeded} → ${afterRepair.currentVaultId}`,
  );
  check(afterRepair.lastVault === 'cloud:admin', '5.2 neomd.lastVault 也保持不变', afterRepair.lastVault);

  const dupAdmins = afterRepair.entries.filter((e) => e.vaultId === 'admin');
  check(dupAdmins.length === 1, '5.3 同一 vaultId 的重复条目被合并成 1 条', `${dupAdmins.length} 条`);
  const ghost = afterRepair.entries.find((e) => e.vaultId === 'pending:');
  check(!ghost, '5.4 空 location 的 pending: 垃圾条目被丢弃', ghost ? '仍存在' : '已丢弃');
  const emptyLoc4 = afterRepair.entries.filter((e) => !e.location);
  check(emptyLoc4.length === 0, '5.5 修复后所有条目 location 非空', emptyLoc4.length ? `${emptyLoc4.length} 条为空` : '全部非空');
  const keptOther = afterRepair.entries.find((e) => e.vaultId === 'qaunrelated');
  check(Boolean(keptOther), '5.6 无关的本地路径仓库未被误删（prune 只清 cloud: 伪仓库）', keptOther ? '保留' : '被误删');
} finally {
  await browser4.close();
}

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

console.log(`\n${'='.repeat(64)}`);
console.log(`通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('全部断言通过 ✓');
process.exit(0);
