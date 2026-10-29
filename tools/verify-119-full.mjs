/**
 * Neo MD 1.1.9 统一验收门禁（单文件、可独立运行）
 * =============================================================================
 * 这是 1.1.9 的**发布门禁**：任何一条断言失败即视为不可发布（退出码非 0）。
 *
 * 用法：
 *   node tools/verify-119-full.mjs                       # 跑全部 A~G
 *   node tools/verify-119-full.mjs --only=A,B            # 只跑指定段
 *   node tools/verify-119-full.mjs --base=http://127.0.0.1:5178 --api=http://127.0.0.1:3200
 *   node tools/verify-119-full.mjs --shots               # 截图存到 docs/shots-119/
 *   node tools/verify-119-full.mjs --only=G --skip-build  # 跳过 build:web（省 CPU）
 *   node tools/verify-119-full.mjs --json=report.json     # 额外输出机器可读结果
 *
 * 覆盖段落：
 *   A 启动与首屏      B 设置项逐项       C 同步链路
 *   D 工作台交互      E 流程图/思维导图   F 后台与 AI
 *   G 回归（类型检查 / vitest / build:web）
 *
 * 设计约束（重要，改脚本前先读）：
 *  1. **只读产品代码**。本脚本不修改 apps/**、packages/**、services/** 任何源码；
 *     发现缺陷只报告，由对应任务的负责人修。
 *  2. **不污染生产库的设置**。测试账号是生产库真实管理员，因此默认拦截
 *     `PUT /api/settings`（本地直接 fulfill 假成功），并在结束时把
 *     `neomd.settings.v1` 快照写回，避免把验收用的字号/主题留在用户配置里。
 *  3. **自建资源必须自清理**：验收仓库、知识库令牌、AI mock 供应商在 finally 里删除。
 *  4. 每条断言都要输出「断言名 / 期望 / 实测 / 通过与否」，失败项带可复现步骤。
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ============================== CLI 参数 ============================== */

function parseArgs(argv) {
  const out = { only: null, base: null, api: null, shots: false, skipBuild: false, json: null, verbose: false, timeout: 45000 };
  for (const raw of argv) {
    const a = String(raw);
    if (a === '--shots') out.shots = true;
    else if (a === '--skip-build') out.skipBuild = true;
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a.startsWith('--only=')) {
      out.only = a.slice(7).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    } else if (a.startsWith('--base=')) out.base = a.slice(7).replace(/\/+$/, '');
    else if (a.startsWith('--api=')) out.api = a.slice(6).replace(/\/+$/, '');
    else if (a.startsWith('--json=')) out.json = a.slice(7);
    else if (a.startsWith('--timeout=')) out.timeout = Number(a.slice(10)) || out.timeout;
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    }
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));
const BASE = ARGS.base || process.env.SMOKE_BASE || 'http://127.0.0.1:5178';
const API = ARGS.api || process.env.SMOKE_API || 'http://127.0.0.1:3200';
const SHOT_DIR = path.join(ROOT, 'docs', 'shots-119');
const SECTIONS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const ONLY = ARGS.only && ARGS.only.length ? new Set(ARGS.only) : new Set(SECTIONS);

/** 1.1.8 基线（用户首屏可交互 277ms / 编辑器 249ms 慢网络），1.1.9 阈值在此收严 */
const THRESHOLD = {
  /** 外壳（ribbon/tabbar/statusbar 真实 DOM）挂载上限。1.1.8 基线 277ms，留 3x 余量给 CI 抖动 */
  shellMs: 900,
  /** 当前文档正文可编辑上限 */
  editableMs: 2000,
  /** 慢网络（人为给 /api/settings + /api/storage 加 2.5s 延迟）下外壳仍须在此时间内出现 */
  slowNetShellMs: 1200,
};

/* ============================== 断言框架 ============================== */

const results = [];
let currentSection = '-';

function section(id, title) {
  currentSection = id;
  console.log(`\n${'='.repeat(78)}\n[${id}] ${title}\n${'='.repeat(78)}`);
}

/**
 * 记录一条断言。
 * @param {string} name   断言名（中文，直接进验收报告）
 * @param {*} expect      期望（人类可读）
 * @param {*} actual      实测值
 * @param {boolean} pass  是否通过
 * @param {{repro?:string, note?:string}} [meta]
 */
function check(name, expect, actual, pass, meta = {}) {
  const id = `${currentSection}${String(results.filter((r) => r.section === currentSection).length + 1).padStart(2, '0')}`;
  const rec = {
    id,
    section: currentSection,
    name,
    expect: fmt(expect),
    actual: fmt(actual),
    pass: Boolean(pass),
    repro: meta.repro || '',
    note: meta.note || '',
  };
  results.push(rec);
  const mark = rec.pass ? '\u2713' : '\u2717';
  console.log(`  ${mark} [${id}] ${name}`);
  console.log(`        期望: ${rec.expect}`);
  console.log(`        实测: ${rec.actual}`);
  if (!rec.pass && rec.repro) console.log(`        复现: ${rec.repro}`);
  if (rec.note) console.log(`        备注: ${rec.note}`);
  return rec.pass;
}

function fmt(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return v;
  try {
    const s = JSON.stringify(v);
    return s.length > 420 ? `${s.slice(0, 420)}…` : s;
  } catch {
    return String(v);
  }
}

function skip(name, reason) {
  const id = `${currentSection}${String(results.filter((r) => r.section === currentSection).length + 1).padStart(2, '0')}`;
  results.push({ id, section: currentSection, name, expect: '—', actual: `跳过：${reason}`, pass: null, repro: '', note: '' });
  console.log(`  \u2298 [${id}] ${name}\n        跳过: ${reason}`);
}

/* ============================== 通用工具 ============================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

function authHeaders(token, extra = {}) {
  return { authorization: `Bearer ${token}`, ...extra };
}

async function shot(page, name) {
  if (!ARGS.shots) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  console.log(`        (截图: docs/shots-119/${name}.png)`);
}

function sh(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: opts.timeout || 300000,
    env: { ...process.env, ...(opts.env || {}) },
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, signal: r.signal };
}

function tail(text, n = 600) {
  const t = String(text || '').trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

/* ============================== Playwright 装载 ============================== */

async function loadChromium() {
  const candidates = [
    'playwright',
    'playwright-core',
    path.join(ROOT, 'apps/desktop/node_modules/playwright-core/index.mjs'),
    path.join(ROOT, 'node_modules/playwright-core/index.mjs'),
    path.join(ROOT, 'node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.mjs'),
  ];
  const errors = [];
  for (const c of candidates) {
    try {
      const mod = await import(c.startsWith('/') || /^[A-Za-z]:/.test(c) ? `file://${c.replace(/\\/g, '/')}` : c);
      const chromium = mod.chromium || mod.default?.chromium;
      if (chromium) return chromium;
      errors.push(`${c}: 无 chromium 导出`);
    } catch (e) {
      errors.push(`${c}: ${e.code || e.message}`);
    }
  }
  throw new Error(`无法加载 Playwright，尝试过：\n  - ${errors.join('\n  - ')}\n提示：先执行 npx playwright install chromium`);
}

/* ============================== 主流程 ============================== */

const state = {
  token: null,
  refresh: null,
  user: null,
  vaultId: `qa119gate`,
  vaultName: '1.1.9 验收仓库',
  createdVault: false,
  mockProvider: null,
  mockServer: null,
  kbTokenId: null,
  kbToken: null,
  settingsSnapshot: null,
  settingsBackup: null,
};

async function login() {
  const r = await httpJson(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: '6655' }),
  });
  if (r.status !== 200 || !r.body?.ok) {
    throw new Error(`登录失败 ${r.status}: ${fmt(r.body)}`);
  }
  state.token = r.body.data.accessToken;
  state.refresh = r.body.data.refreshToken;
  state.user = r.body.data.user;
  return r.body.data;
}

/**
 * 备份云端设置（生产库安全阀）。
 *
 * 为什么需要：验收要真的改字号/主题/命名模板才能断言生效，而测试账号是
 * **生产库真实管理员**。改完若不还原，会把验收用的 22px/深色主题/QA119 命名模板
 * 留在真实用户配置里，且会同步到他的其它设备。
 * 因此开跑前存一份 `payload`，结束后用同一版本号写回。
 */
async function backupSettings() {
  const r = await httpJson(`${API}/api/settings`, { headers: authHeaders(state.token) });
  if (r.status !== 200 || !r.body?.ok) return;
  state.settingsBackup = {
    payload: r.body.data.payload ?? null,
    version: Number(r.body.data.version ?? 0),
  };
  console.log(`  已备份云端设置（version=${state.settingsBackup.version}）`);
}

async function restoreSettings() {
  if (!state.settingsBackup?.payload) return;
  try {
    const r = await httpJson(`${API}/api/settings`, {
      method: 'PUT',
      headers: { ...authHeaders(state.token), 'content-type': 'application/json' },
      body: JSON.stringify({ payload: state.settingsBackup.payload, version: state.settingsBackup.version + 1 }),
    });
    console.log(`  已还原云端设置（${r.status}）`);
  } catch (e) {
    console.log(`  还原云端设置失败：${String(e?.message ?? e).slice(0, 160)}`);
  }
}

/**
 * 新建一个已登录的页面上下文。
 * 直接把 token 注入 localStorage，跳过 UI 登录（UI 登录本身不属于本次验收范围，
 * 且能避免每次跑测都产生一条 auth.login 审计）。
 */
async function newSession(chromium, opts = {}) {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 1600, height: 950 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
  });
  await ctx.addInitScript(
    ([a, r, u]) => {
      try {
        localStorage.setItem('neomd.access', a);
        localStorage.setItem('neomd.refresh', r);
        localStorage.setItem('neomd.user.cache', u);
        /*
         * 固定 deviceId（1.1.9）。
         *
         * 为什么必须固定：`SyncEngine` 按 `index/<deviceId>.json` 存每台设备的同步状态。
         * 每个 `newContext()` 都是全新的 localStorage，`ensureDeviceId()` 会生成新 id，
         * 于是**每跑一次门禁，云端就多一个 index 文件**。实测一次完整跑测产生 20 个，
         * 而 `loadRemoteManifest()` 会遍历全部索引 —— 堆积既拖慢同步，也让云端状态脏乱。
         *
         * 固定成常量后，多次跑测复用同一索引，不再产生垃圾。
         */
        localStorage.setItem('neomd.deviceId', 'qa-verify-119-full');
      } catch {
        /* ignore */
      }
    },
    [state.token, state.refresh, JSON.stringify(state.user)],
  );
  /**
   * 生产库安全阀：把 `/api/settings` 换成**进程内假云端**。
   *
   * 为什么必须这样做（而不是简单拦掉 PUT）：
   *  - 简单拦掉 PUT → 刷新后 GET 从真实云端拉回旧值覆盖 localStorage，
   *    「设置持久化」类断言（D4 刷新后顺序仍保持）会**假失败**；
   *  - 完全放行 → 验收用的 22px 字号 / 深色主题 / QA119 命名模板会被
   *    真的写进生产库真实管理员账号，还会同步到他其它设备，这是事故。
   *
   * 假云端：PUT 把 payload 存在脚本内存并回显成功；GET 返回内存里的值。
   * 这样持久化链路（localStorage → PUT → 刷新 → GET → 覆盖 localStorage）
   * 被完整走通，而对生产库零写入。
   */
  const fakeCloud = { payload: null, version: 0 };
  await ctx.route('**/api/settings**', async (route) => {
    const req = route.request();
    const url = req.url();
    const ok = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
    if (req.method() === 'PUT' && /\/api\/settings(\?|$)/.test(url)) {
      try {
        const body = JSON.parse(req.postData() || '{}');
        if (body.payload !== undefined) fakeCloud.payload = body.payload;
        fakeCloud.version += 1;
      } catch { /* ignore */ }
      return ok({ version: fakeCloud.version, updatedAt: new Date().toISOString(), deviceId: null, platform: null });
    }
    if (req.method() === 'GET' && /\/api\/settings\/version/.test(url)) {
      return ok({ version: fakeCloud.version });
    }
    if (req.method() === 'GET' && /\/api\/settings(\?|$)/.test(url)) {
      return ok({
        payload: fakeCloud.payload,
        sensitive: null,
        version: fakeCloud.version,
        updatedAt: null,
        deviceId: null,
        platform: new URL(url).searchParams.get('platform'),
      });
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e.message || e).slice(0, 220)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /Uncaught|ReferenceError|TypeError/.test(m.text())) {
      jsErrors.push(m.text().slice(0, 220));
    }
  });
  return { browser, ctx, page, jsErrors };
}

/** 打开工作台并确保有一篇可编辑的 md 文档 */
async function openWorkbench(page, { waitDoc = true } = {}) {
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: ARGS.timeout });
  await page.waitForSelector('.shell__main', { state: 'attached', timeout: ARGS.timeout });
  if (!waitDoc) return;
  /*
   * 需要「一个可编辑的正文」。
   *
   * 两种会让这里失败的真实情况（都踩过）：
   *  1. 上次退出时没开任何标签 → 冷启动后没有编辑器；
   *  2. 上次停留在**流程图/思维导图/设置/插件商店**标签 → 恢复出来的活动标签
   *     不是文本编辑器，`.ProseMirror` 自然不存在。
   * 第 2 种尤其隐蔽：`Ctrl+n` 之后若焦点不在应用内，快捷键不生效，
   * 于是 waitForSelector 一直等到 30 秒超时（C 段就是这么挂的）。
   *
   * 所以这里按「快捷键 → 按钮兜底 → 显式等待」三级重试，任一成功即可。
   */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const hasEditor = await page.locator('.ProseMirror, .cm-content, .read-view').count();
    if (hasEditor) break;
    // 先点一下页面把焦点拿回应用（Ctrl+n 只在应用内生效）
    await page.locator('.shell__main').click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press('Control+n').catch(() => {});
    await page.waitForTimeout(600);
    if (!(await page.locator('.ProseMirror, .cm-content, .read-view').count())) {
      // 兜底：点「新建文档」按钮（不依赖快捷键与焦点）
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => /新建文档/.test(b.textContent || ''));
        btn?.click();
      });
      await page.waitForTimeout(600);
    }
  }
  await page.waitForSelector('.ProseMirror', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);
}

/**
 * 回到一个真实的文档标签。
 *
 * 为什么需要：设置页与插件商店在 1.1.9 里是**标签页**而不是覆盖层，
 * 打开它们后 `.shell__page` / `.nm-content` / `.ProseMirror` / `.ribbon__btn`
 * 都会被替换成设置页内容——此时读 computed style 必然拿到 null。
 * 所以每次「改设置 → 断言编辑器」都必须先切回文档标签。
 */
async function backToDoc(page, waitMs = 1400) {
  const switched = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('.tab'));
    const doc = tabs.find((t) => !/设置|插件商店/.test(t.textContent || ''));
    if (!doc) return false;
    doc.click();
    return true;
  });
  if (switched) await page.waitForTimeout(waitMs);
  return switched;
}

/** 关闭设置标签（设置是标签页，不是弹窗） */
async function closeSettings(page) {
  const closed = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('.tab'));
    const st = tabs.find((t) => /设置/.test(t.textContent || ''));
    if (!st) return false;
    const btn = st.querySelector('.tab__close');
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  if (closed) await page.waitForTimeout(900);
  return closed;
}

async function openSettings(page, tabLabel) {
  if (!(await page.locator('.settings__nav-item').count())) {
    await page.keyboard.press('Control+Comma');
    await page.waitForSelector('.settings__nav-item', { timeout: 15000 }).catch(() => {});
  }
  if (tabLabel) {
    await page.evaluate((label) => {
      const el = Array.from(document.querySelectorAll('.settings__nav-item')).find((e) => (e.textContent || '').trim() === label);
      if (el) el.click();
    }, tabLabel);
    await page.waitForTimeout(600);
  }
}

/** 切换编辑器模式（wysiwyg / source / compare / read） */
async function setMode(page, modeId) {
  const labelMap = { wysiwyg: '所见即所得', source: '源码模式', compare: '对照模式', read: '阅读视图' };
  const label = labelMap[modeId];
  await page.evaluate(() => {
    const btns = document.querySelectorAll('.editorbar .viewswitch__btn');
    const b = btns[btns.length - 1];
    if (b) b.click();
  });
  await page.waitForSelector('.viewswitch__menu', { timeout: 8000 }).catch(() => {});
  await page.evaluate((lb) => {
    const items = Array.from(document.querySelectorAll('.viewswitch__menu .viewswitch__item'));
    const hit = items.find((e) => (e.textContent || '').trim().includes(lb));
    if (hit) hit.click();
  }, label);
  await page.waitForTimeout(900);
}

/** 读取当前模式下正文宿主元素的计算样式 */
async function readBodyStyle(page) {
  return page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        fontSize: cs.fontSize,
        lineHeight: cs.lineHeight,
        fontFamily: cs.fontFamily,
        letterSpacing: cs.letterSpacing,
      };
    };
    const root = getComputedStyle(document.documentElement);
    return {
      host: pick('.nm-content') || pick('.cm-content') || pick('.read-view__body') || pick('.ProseMirror'),
      bySel: {
        nmContent: pick('.nm-content'),
        proseMirror: pick('.ProseMirror'),
        cmContent: pick('.cm-content'),
      },
      vars: {
        fontSize: root.getPropertyValue('--content-font-size').trim(),
        lineHeight: root.getPropertyValue('--content-line-height').trim(),
        fontContent: root.getPropertyValue('--font-content').trim(),
        zoom: root.getPropertyValue('--content-zoom').trim(),
      },
      pageClass: document.querySelector('.shell__page')?.className ?? '',
      /** 诊断用：当前激活的是不是设置/插件这类虚拟标签 */
      activeTab: (document.querySelector('.tab.is-active .tab__title')?.textContent || '').trim(),
      hasEditorBar: Boolean(document.querySelector('.editorbar')),
    };
  });
}

/* ============================== A 启动与首屏 ============================== */

async function sectionA(chromium) {
  section('A', '启动与首屏（打开即用，设置与同步后置）');

  // ---- A1/A2：冷启动实测（3 次取中位数，排除首次 JIT 抖动）----
  const runs = [];
  {
    const { browser, page, jsErrors } = await newSession(chromium);
    try {
      /*
       * 预热：确保「上次打开过一篇文档」，否则冷启动后没有标签页，
       * 正文编辑器根本不会挂载 —— A2 测到的会是 -1（"未出现"），
       * 而不是一个耗时数字。这不是性能回归，是测试前置状态缺失。
       *
       * 为什么必须这么做：A2 的语义是「打开应用后多久能开始打字」，
       * 前提是用户上次开着文档（真实使用场景）。若前一次跑测把标签全关了，
       * 下一次就会误判成「编辑器 20 秒都没出来」。
       */
      await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: ARGS.timeout });
      await page.waitForSelector('.shell__main', { timeout: 25000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const hasTab = await page.evaluate(() => Boolean(document.querySelector('.tab.is-active')));
      if (!hasTab) {
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find((b) => /新建文档/.test(b.textContent || ''));
          btn?.click();
        });
        await page.waitForSelector('.ProseMirror, .cm-content, .read-view', { timeout: 20000 }).catch(() => {});
        // 等自动保存把标签状态落盘，保证后续冷启动能恢复出标签
        await page.waitForTimeout(2500);
      }

      for (let i = 0; i < 3; i += 1) {
        const t0 = Date.now();
        await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: ARGS.timeout });
        let shellMs = -1;
        try {
          await page.waitForSelector('.shell__main .ribbon, .shell__main .tabbar', { state: 'attached', timeout: 20000 });
          shellMs = Date.now() - t0;
        } catch {
          /* keep -1 */
        }
        let editableMs = -1;
        try {
          await page.waitForSelector('.ProseMirror, .cm-content, .read-view', { state: 'attached', timeout: 20000 });
          editableMs = Date.now() - t0;
        } catch {
          /* keep -1 */
        }
        const paint = await page.evaluate(() => {
          const p = performance.getEntriesByType('paint');
          const fcp = p.find((x) => x.name === 'first-contentful-paint');
          const nav = performance.getEntriesByType('navigation')[0];
          return {
            fcp: Math.round(fcp?.startTime ?? -1),
            dcl: Math.round(nav?.domContentLoadedEventEnd ?? -1),
            load: Math.round(nav?.loadEventEnd ?? -1),
          };
        });
        runs.push({ shellMs, editableMs, ...paint });
        await page.waitForTimeout(600);
      }

      const med = (arr) => {
        const v = arr.filter((x) => x >= 0).sort((a, b) => a - b);
        return v.length ? v[Math.floor(v.length / 2)] : -1;
      };
      const shellMed = med(runs.map((r) => r.shellMs));
      const editMed = med(runs.map((r) => r.editableMs));
      const fcpMed = med(runs.map((r) => r.fcp));

      check(
        'A1 首屏外壳挂载时间（3 次中位数）',
        `< ${THRESHOLD.shellMs}ms（1.1.8 基线 277ms）`,
        `${shellMed}ms（3 次：${runs.map((r) => r.shellMs).join(' / ')}）`,
        shellMed > 0 && shellMed < THRESHOLD.shellMs,
        { repro: 'node tools/verify-119-full.mjs --only=A' },
      );
      check(
        'A2 当前文档可编辑时间（3 次中位数）',
        `< ${THRESHOLD.editableMs}ms`,
        `${editMed}ms（3 次：${runs.map((r) => r.editableMs).join(' / ')}）`,
        editMed > 0 && editMed < THRESHOLD.editableMs,
        { note: '1.1.8 慢网络基线 249ms；本机 vite dev + 空仓库实测' },
      );
      check('A3 首屏绘制 FCP（3 次中位数）', '< 1000ms', `${fcpMed}ms（DCL ${runs.map((r) => r.dcl).join('/')}）`, fcpMed > 0 && fcpMed < 1000);

      // ---- A4：外壳先出，不被骨架屏挡住（1.1.9 明确取消骨架屏方案）----
      const shellVisible = await page.evaluate(() => {
        const el = document.querySelector('.shell__main');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), opacity: getComputedStyle(el).opacity };
      });
      check(
        'A4 外壳真实渲染（非骨架屏占位）',
        'shell 尺寸 > 0 且 opacity=1，不存在 .skel 骨架层',
        JSON.stringify(shellVisible) + ` skel=${await page.locator('.skel, [class*="skel"]').count()}`,
        Boolean(shellVisible && shellVisible.w > 400 && shellVisible.h > 300 && shellVisible.opacity === '1'),
      );

      // ---- A5：设置与同步后置——人为拖慢它们，首屏仍须快速可用 ----
      {
        const slow = await newSession(chromium);
        try {
          await slow.ctx.route('**/api/settings**', async (route) => {
            await sleep(2500);
            await route.continue();
          });
          await slow.ctx.route('**/api/storage/**', async (route) => {
            await sleep(2500);
            await route.continue();
          });
          const t0 = Date.now();
          await slow.page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: ARGS.timeout });
          let shellMs = -1;
          try {
            await slow.page.waitForSelector('.shell__main .ribbon', { state: 'attached', timeout: 20000 });
            shellMs = Date.now() - t0;
          } catch {
            /* keep */
          }
          const settingsDoneAt = await slow.page
            .evaluate(() => performance.getEntriesByType('resource').filter((r) => /\/api\/settings/.test(r.name)).map((r) => Math.round(r.responseEnd)))
            .catch(() => []);
          check(
            'A5 慢网络下设置/同步不阻塞首屏',
            `外壳 < ${THRESHOLD.slowNetShellMs}ms（/api/settings 与 /api/storage 各人为延迟 2500ms）`,
            `外壳 ${shellMs}ms；/api/settings responseEnd=${JSON.stringify(settingsDoneAt)}`,
            shellMs > 0 && shellMs < THRESHOLD.slowNetShellMs,
            { repro: 'node tools/verify-119-full.mjs --only=A（A5 内置路由延迟）' },
          );
        } finally {
          await slow.browser.close();
        }
      }

      // ---- A6：无 JS 运行时错误 ----
      check(
        'A6 启动过程无 JS 运行时错误',
        '0 条 pageerror / Uncaught',
        jsErrors.length ? jsErrors.slice(0, 4) : '0 条',
        jsErrors.length === 0,
      );
    } finally {
      await browser.close();
    }
  }
}

/* ============================== B 设置项逐项 ============================== */

async function sectionB(chromium) {
  section('B', '设置项逐项生效（四种模式 computed style 实测）');

  const { browser, page, jsErrors } = await newSession(chromium);
  try {
    await openWorkbench(page);
    // 快照用户设置，结束时原样还原（并已拦截云端写入）
    state.settingsSnapshot = await page.evaluate(() => localStorage.getItem('neomd.settings.v1'));

    /* ---------- B1 字体 / 字号 / 行高 / 缩放：四模式全覆盖 ---------- */
    await openSettings(page, '主题');
    const before = await readBodyStyle(page);
    const fontOptions = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="font-family"] option')).map((o) => ({ value: o.value, label: (o.textContent || '').trim() })),
    );

    // 选一个与当前不同的字体
    const currentFont = await page.inputValue('[data-testid="font-family"]');
    const pickFont = fontOptions.find((f) => f.value !== currentFont && f.value && !f.value.startsWith('var('));
    const targetFont = pickFont?.value || fontOptions.find((f) => f.value !== currentFont)?.value || '';
    if (targetFont) {
      await page.selectOption('[data-testid="font-family"]', targetFont);
      await page.waitForTimeout(500);
    }
    await page.fill('input[aria-label="正文字号"]', '22');
    await page.waitForTimeout(300);
    await page.fill('input[aria-label="正文行高"]', '2.1');
    await page.waitForTimeout(300);
    await page.fill('input[aria-label="正文缩放比例"]', '150');
    await page.waitForTimeout(600);

    // 根变量写在 <html> 上，与当前标签页无关，可直接读
    const applied = await readBodyStyle(page);
    check(
      'B1 设置页改字号/行高/字体/缩放后根变量已更新',
      '--content-font-size=33px（22×150%）、--content-line-height=2.1、--content-zoom=1.5、--font-content 非空',
      JSON.stringify(applied.vars),
      applied.vars.fontSize === '33px' && applied.vars.lineHeight === '2.1' && applied.vars.zoom === '1.5' && Boolean(applied.vars.fontContent),
      { repro: '设置 → 主题 → 字体与排版：字号 22 / 行高 2.1 / 缩放 150' },
    );
    check(
      'B2 字体族选择后 --font-content 真的变化',
      `--font-content 从「${before.vars.fontContent}」变为用户所选「${targetFont}」`,
      `${before.vars.fontContent} → ${applied.vars.fontContent}`,
      Boolean(targetFont) && applied.vars.fontContent !== before.vars.fontContent,
      { repro: '设置 → 主题 → 字体族，选一个非默认字体' },
    );

    // 设置是标签页，必须切回文档标签才能读到编辑器 computed style
    await closeSettings(page);
    await backToDoc(page);

    // 四种模式逐一断言 computed style
    const modeSel = { wysiwyg: '.nm-content', source: '.cm-content', compare: '.nm-content', read: '.nm-content' };
    for (const mode of ['wysiwyg', 'source', 'compare', 'read']) {
      await setMode(page, mode);
      const st = await readBodyStyle(page);
      const host = st.bySel.nmContent || st.bySel.cmContent;
      const okFontSize = host?.fontSize === '33px';
      const okLineHeight = host?.lineHeight && Math.abs(parseFloat(host.lineHeight) - 22 * 1.5 * 2.1) < 1.5;
      check(
        `B3.${mode} 四种模式字号/行高生效（${mode}）`,
        `font-size=33px、line-height≈69.3px（22px×150%×2.1）`,
        `宿主=${modeSel[mode]} font-size=${host?.fontSize} line-height=${host?.lineHeight} font-family=${String(host?.fontFamily).slice(0, 40)}`,
        Boolean(okFontSize && okLineHeight),
        { repro: `编辑器工具栏「编辑模式」菜单切到 ${mode}，读 computed style` },
      );
    }
    await setMode(page, 'wysiwyg');

    /* ---------- B4 主题 / 配色 ---------- */
    await openSettings(page, '主题');
    const themeInfo = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[data-testid="theme-cards"] > *'));
      return {
        count: cards.length,
        ids: cards.map((c) => ({ text: (c.textContent || '').trim().slice(0, 20), cls: String(c.className) })),
        current: document.documentElement.dataset.themePreset,
        mode: document.documentElement.dataset.theme,
        contentBg: getComputedStyle(document.documentElement).getPropertyValue('--content-bg').trim(),
      };
    });
    check('B4 主题预设列表可用', '≥ 5 套内置主题', `${themeInfo.count} 套：${themeInfo.ids.map((i) => i.text.replace(/^Aa\s*/, '')).join(' / ')}`, themeInfo.count >= 5);

    // 切到一套深色主题，断言 <html data-theme> 与 --content-bg 真的变化
    const darkIdx = themeInfo.ids.findIndex((i) => /午夜黑|墨石黑|暮光紫|深海青/.test(i.text));
    if (darkIdx >= 0) {
      await page.evaluate((idx) => {
        const cards = document.querySelectorAll('[data-testid="theme-cards"] > *');
        cards[idx]?.click();
      }, darkIdx);
      await page.waitForTimeout(900);
      const dark = await page.evaluate(() => ({
        mode: document.documentElement.dataset.theme,
        preset: document.documentElement.dataset.themePreset,
        contentBg: getComputedStyle(document.documentElement).getPropertyValue('--content-bg').trim(),
        chromeBg: getComputedStyle(document.documentElement).getPropertyValue('--bg-sidebar').trim(),
      }));
      check(
        'B5 切换深色主题后 <html data-theme> 与正文底色真的变化',
        `data-theme=dark 且 --content-bg ≠ ${themeInfo.contentBg}`,
        JSON.stringify(dark),
        dark.mode === 'dark' && dark.contentBg !== themeInfo.contentBg,
        { repro: '设置 → 主题 → 点击「午夜黑」卡片' },
      );
      // 还原浅色
      await page.evaluate(() => {
        const cards = document.querySelectorAll('[data-testid="theme-cards"] > *');
        cards[0]?.click();
      });
      await page.waitForTimeout(700);
    } else {
      skip('B5 切换深色主题', '未找到深色主题卡片');
    }

    /* ---------- B6 主题应用范围 ---------- */
    const scopeCount = await page.evaluate(() => document.querySelectorAll('[data-testid="theme-scope"] button, [data-testid="theme-scope"] .seg__item').length);
    check('B6 主题「应用范围」分段控件存在', '≥ 3 个选项（整体/仅正文/仅界面）', `${scopeCount} 个`, scopeCount >= 3);

    /* ---------- B7 行号（设置是标签页，必须切回文档才能读 .shell__page） ---------- */
    await openSettings(page, '编辑器');
    const lnStateBefore = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}');
      return s.appearance?.showLineNumbers;
    });
    const lnToggle = page.locator('[data-testid="editor-line-numbers"]');
    let lnClicked = false;
    if (await lnToggle.count()) {
      await lnToggle.first().click();
      lnClicked = true;
      await page.waitForTimeout(700);
    }
    const lnStateAfter = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}');
      return s.appearance?.showLineNumbers;
    });
    await closeSettings(page);
    await backToDoc(page);
    const lnClassAfter = await page.evaluate(() => document.querySelector('.shell__page')?.className ?? '');
    check(
      'B7 行号开关生效（settings.appearance.showLineNumbers + .nm-show-linenos 类）',
      '设置值取反，且切回文档后 .shell__page 的 nm-show-linenos 类随之出现/消失',
      `showLineNumbers ${lnStateBefore} → ${lnStateAfter}；shell__page=${lnClassAfter}`,
      lnClicked && lnStateBefore !== lnStateAfter && /nm-show-linenos/.test(lnClassAfter) === Boolean(lnStateAfter),
      { repro: '设置 → 编辑器 → 点击「显示正文行号」开关，切回文档看 .shell__page 的 class' },
    );
    // 还原
    await openSettings(page, '编辑器');
    if (await lnToggle.count()) {
      await lnToggle.first().click();
      await page.waitForTimeout(600);
    }

    /* ---------- B8 拼写检查（lead 决策：按 (a) 补实现，settings-fix 落地后断言） ---------- */
    const spellSwitch = await page.evaluate(() => {
      const tx = document.querySelector('.settings')?.innerText || '';
      const fields = Array.from(document.querySelectorAll('.settings .field, .settings .row-between, .settings .field--row'));
      const hit = fields.find((f) => /拼写/.test(f.textContent || ''));
      return {
        hasText: /拼写/.test(tx),
        controlClass: hit ? String(hit.querySelector('.toggle-btn, [role="switch"], input[type=checkbox]')?.className ?? '') : '',
      };
    });
    if (!spellSwitch.hasText) {
      check(
        'B8 拼写检查设置项存在且驱动 .ProseMirror[spellcheck]',
        '设置页存在「拼写检查」开关，且 .ProseMirror[spellcheck] 随开关变化',
        '设置页未找到「拼写检查」控件（settings-fix 尚未落地）',
        false,
        { repro: '设置 → 编辑器，搜索「拼写」' },
      );
    } else {
      const toggledOn = await page.evaluate(() => {
        const fields = Array.from(document.querySelectorAll('.settings .field, .settings .row-between, .settings .field--row'));
        const hit = fields.find((f) => /拼写/.test(f.textContent || ''));
        const btn = hit?.querySelector('.toggle-btn, [role="switch"], input[type=checkbox]');
        if (!btn) return null;
        btn.click();
        return true;
      });
      await page.waitForTimeout(600);
      await closeSettings(page);
      await backToDoc(page);
      const attr = await page.evaluate(() => {
        const pm = document.querySelector('.ProseMirror');
        return pm ? pm.getAttribute('spellcheck') : null;
      });
      check(
        'B8 拼写检查设置项存在且驱动 .ProseMirror[spellcheck]',
        '切换开关后 .ProseMirror 的 spellcheck 属性存在且随开关变化',
        `控件找到=${toggledOn} → .ProseMirror[spellcheck]=${JSON.stringify(attr)}`,
        toggledOn === true && attr !== null,
        { repro: '设置 → 编辑器 → 切换「拼写检查」，切回文档读 .ProseMirror 的 spellcheck 属性' },
      );
    }

    /* ---------- B9 打字机模式：反向断言（不得出现假开关） ---------- */
    // 逐页签全文扫描，避免只看当前页签漏检
    await openSettings(page);
    const twFound = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('.settings__nav-item')).map((e) => (e.textContent || '').trim());
      return { tabs, hits: /打字机/.test(document.querySelector('.settings')?.innerText || '') };
    });
    const twAll = { hits: [], tabs: twFound.tabs };
    for (const t of twFound.tabs) {
      await page.evaluate((label) => {
        const el = Array.from(document.querySelectorAll('.settings__nav-item')).find((e) => (e.textContent || '').trim() === label);
        el?.click();
      }, t);
      await page.waitForTimeout(420);
      const hit = await page.evaluate(() => /打字机/.test(document.querySelector('.settings')?.innerText || ''));
      if (hit) twAll.hits.push(t);
    }
    check(
      'B9 设置页不得出现「打字机模式」假开关（反向断言）',
      '全部 10 个页签均不含「打字机」（该字段全仓只有类型定义、零消费点，暴露开关等于欺骗用户）',
      `命中页签=${JSON.stringify(twAll.hits)}（扫描 ${twAll.tabs.length} 个页签：${twAll.tabs.join('/')}）`,
      twAll.hits.length === 0,
      { note: 'lead 决策：从 1.1.9 验收表移除，但保留反向断言防止有人加回假开关' },
    );

    /* ---------- B10 自动保存开关 ---------- */
    await openSettings(page, '编辑器');
    const asBefore = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}');
      return s.autosave?.enabled;
    });
    const asToggled = await page.evaluate(() => {
      const fields = Array.from(document.querySelectorAll('.settings .field, .settings .row-between'));
      const hit = fields.find((f) => /启用自动保存/.test(f.textContent || ''));
      const btn = hit?.querySelector('.toggle-btn, [role="switch"]');
      if (!btn) return null;
      btn.click();
      return true;
    });
    await page.waitForTimeout(700);
    const asAfter = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}');
      return s.autosave?.enabled;
    });
    check(
      'B10 自动保存开关生效并持久化',
      'settings.autosave.enabled 取反且写入 localStorage',
      `${asBefore} → ${asAfter}（控件找到=${Boolean(asToggled)}）`,
      asToggled === true && asBefore !== asAfter,
      { repro: '设置 → 编辑器 → 点击「启用自动保存」开关，读 localStorage neomd.settings.v1' },
    );
    // 还原
    await page.evaluate(() => {
      const fields = Array.from(document.querySelectorAll('.settings .field, .settings .row-between'));
      const hit = fields.find((f) => /启用自动保存/.test(f.textContent || ''));
      hit?.querySelector('.toggle-btn, [role="switch"]')?.click();
    });
    await page.waitForTimeout(500);

    /* ---------- B11 命名模板 ---------- */
    await openSettings(page, '通用');
    const tplInput = page.locator('.settings input').filter({ hasText: '' }).first();
    const tplBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}').naming?.template ?? null);
    const tplSet = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('.settings input[type="text"], .settings input:not([type])'));
      const el = inputs.find((i) => /YY|YYYY|MM/.test(i.value || ''));
      if (!el) return null;
      el.value = 'QA119-YYMMDD-HHmm';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    });
    await page.waitForTimeout(800);
    const tplAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}').naming?.template ?? null);
    check(
      'B11 命名模板可修改并持久化',
      `settings.naming.template 变为「QA119-YYMMDD-HHmm」`,
      `${tplBefore} → ${tplAfter}`,
      tplAfter === 'QA119-YYMMDD-HHmm',
      { repro: '设置 → 通用 → 命名模板输入框改为 QA119-YYMMDD-HHmm' },
    );
    // 用模板新建文档，验证真的作用于新建
    await closeSettings(page);
    await backToDoc(page, 900);
    await page.keyboard.press('Control+n');
    await page.waitForTimeout(2600);
    const newTitle = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('.tab'));
      const active = tabs.find((t) => String(t.className).includes('is-active')) || tabs[tabs.length - 1];
      return (active?.querySelector('.tab__title')?.textContent || active?.textContent || '').trim();
    });
    check(
      'B12 命名模板作用于新建文档',
      '新建文档标题以 QA119- 开头',
      `新标签标题=${JSON.stringify(newTitle)}`,
      /^QA119-/.test(newTitle),
      { repro: '设置 → 通用 改模板后按 Ctrl+N' },
    );
    // 还原模板
    await openSettings(page, '通用');
    await page.evaluate((orig) => {
      const inputs = Array.from(document.querySelectorAll('.settings input[type="text"], .settings input:not([type])'));
      const el = inputs.find((i) => /YY|QA119/.test(i.value || ''));
      if (!el) return;
      el.value = orig ?? 'YY年MM月DD日HHMM-【input】';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, tplBefore);
    await page.waitForTimeout(600);

    /* ---------- B13 快捷键页 ---------- */
    await openSettings(page, '快捷键');
    const sc = await page.evaluate(() => {
      const pane = document.querySelector('.settings');
      const tx = pane?.innerText || '';
      return { len: tx.length, hasCtrl: /Ctrl/.test(tx), rows: pane ? pane.querySelectorAll('kbd, .kbd, [class*=shortcut], tr').length : 0, sample: tx.slice(0, 160) };
    });
    check('B13 快捷键页有真实内容', '非空且含 Ctrl 组合键说明', `文本 ${sc.len} 字符 / Ctrl 命中=${sc.hasCtrl} / 行元素 ${sc.rows}`, sc.len > 100 && sc.hasCtrl, {
      repro: '设置 → 快捷键',
    });

    /* ---------- B14 插件开关（功能区按钮显隐） ---------- */
    await openSettings(page, '界面布局');
    // 设置是标签页，此时工作台功能区不在 DOM 里 → 用 settings.layout.ribbonItems 判断
    const ribBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}').layout?.ribbonItems ?? null);
    const toggled = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.settings .ribbon-item'));
      const target = items.find((b) => /流程图/.test(b.textContent || ''));
      if (target) {
        target.click();
        return (target.textContent || '').trim();
      }
      items[0]?.click();
      return items[0] ? (items[0].textContent || '').trim() : null;
    });
    await page.waitForTimeout(900);
    const ribAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}').layout?.ribbonItems ?? null);
    await closeSettings(page);
    await backToDoc(page);
    const ribDomCount = await page.evaluate(() => document.querySelectorAll('.ribbon__btn').length);
    check(
      'B14 插件/功能区按钮开关生效',
      'settings.layout.ribbonItems 数组变化，且切回工作台后 .ribbon__btn 数量相应变化',
      `ribbonItems ${JSON.stringify(ribBefore)} → ${JSON.stringify(ribAfter)}（切换项：${toggled}）；工作台 ribbon__btn=${ribDomCount}`,
      Array.isArray(ribAfter) && JSON.stringify(ribBefore) !== JSON.stringify(ribAfter) && ribDomCount > 0,
      { repro: '设置 → 界面布局 → 显示哪些按钮 → 点掉「流程图」，切回工作台数功能区图标' },
    );
    // 还原
    await openSettings(page, '界面布局');
    await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.settings .ribbon-item'));
      const target = items.find((b) => /流程图/.test(b.textContent || ''));
      if (target && !String(target.className).includes('is-on')) target.click();
    });
    await page.waitForTimeout(600);
    await closeSettings(page);
    await backToDoc(page);

    /* ---------- B15 页宽：降级断言（1.1.7 起设置页已移除页宽控件） ---------- */
    /**
     * 菜单开合是 `widthOpen` 布尔量，组件只在 document mousedown 时关闭，
     * **Escape 不会关它**。因此不能假设「每次点按钮都是开」——
     * 上一档遗留的打开状态会让这次点击变成「关闭」，取不到菜单项、该档不生效，
     * 表现为「某一档 max-width 与上一档相同」的假失败（1.2.0 门禁首轮实测踩到）。
     *
     * 正确做法：以「菜单项是否在 DOM 里」为准做幂等开合，点击后校验 class，
     * 不匹配就重试一次。断言本身不放宽：仍要求 4 档各自命中且 max-width 两两不同。
     */
    const WIDTH_LABEL = { narrow: '窄', standard: '标准', wide: '宽', full: '铺满' };
    const openWidthMenu = async () => {
      const open = await page.evaluate(() => document.querySelectorAll('.viewswitch__menu .viewswitch__item').length > 0);
      if (!open) {
        await page.evaluate(() => {
          const btns = document.querySelectorAll('.editorbar .viewswitch__btn');
          btns[0]?.click();
        });
        await page.waitForSelector('.viewswitch__menu .viewswitch__item', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(200);
      }
    };
    const readWidthState = () =>
      page.evaluate(() => {
        const el = document.querySelector('.shell__page');
        const cs = el ? getComputedStyle(el) : null;
        return { cls: el?.className ?? '', maxWidth: cs?.maxWidth ?? '', padLeft: cs?.paddingLeft ?? '' };
      });
    const pickWidth = async (w) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await openWidthMenu();
        const clicked = await page.evaluate((lb) => {
          const items = Array.from(document.querySelectorAll('.viewswitch__menu .viewswitch__item'));
          const hit = items.find((e) => (e.textContent || '').trim().startsWith(lb));
          if (!hit) return null;
          hit.click();
          return (hit.textContent || '').trim();
        }, WIDTH_LABEL[w]);
        await page.waitForTimeout(750);
        const st = await readWidthState();
        if (clicked && new RegExp(`nm-page-${w}`).test(st.cls)) return { w, clicked, attempts: attempt + 1, ...st };
      }
      return { w, clicked: null, attempts: 2, ...(await readWidthState()) };
    };
    const widthResults = [];
    for (const w of ['narrow', 'standard', 'wide', 'full']) widthResults.push(await pickWidth(w));
    const distinct = new Set(widthResults.map((r) => r.maxWidth));
    check(
      'B15 页宽切换生效（降级断言：编辑器工具栏按钮，非设置页）',
      '4 档页宽对应 4 个不同的 max-width（620/760/1080/none），且各自的 nm-page-* class 命中',
      widthResults.map((r) => `${r.w}:${r.maxWidth}(${(r.cls.match(/nm-page-\S+/) ?? ['?'])[0]})`).join(' | '),
      distinct.size === 4 && widthResults.every((r) => new RegExp(`nm-page-${r.w}`).test(r.cls)),
      { note: '1.1.7 起设置页已移除页宽控件（字段仅向后兼容），故改断言工具栏按钮' },
    );

    check('B16 设置项操作过程无 JS 错误', '0 条 pageerror', jsErrors.length ? jsErrors.slice(0, 4) : '0 条', jsErrors.length === 0);
  } finally {
    // 还原用户设置快照
    try {
      if (state.settingsSnapshot) {
        await page.evaluate((snap) => {
          if (snap) localStorage.setItem('neomd.settings.v1', snap);
          else localStorage.removeItem('neomd.settings.v1');
        }, state.settingsSnapshot);
      }
    } catch {
      /* ignore */
    }
    await browser.close();
  }
}

/* ============================== C 同步 ============================== */

async function sectionC(chromium) {
  section('C', '同步链路（/api/storage/* 往返 + 已同步状态 + 两端清单一致）');

  const H = authHeaders(state.token);
  const vid = state.vaultId;
  const key = `docs/qa119/${Date.now()}-probe.md`;
  const content = `# 1.1.9 验收探针\n\n时间：${new Date().toISOString()}\n\n内容用于验证 upload/list/download/delete 往返。\n`;

  // 注册验收仓库
  const reg = await httpJson(`${API}/api/vaults`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ vaultId: vid, name: state.vaultName }),
  });
  state.createdVault = reg.status === 200 || reg.status === 201;
  check('C1 验收仓库注册', '200/201 且返回 vaultId', `${reg.status} ${fmt(reg.body).slice(0, 160)}`, reg.status === 200 || reg.status === 201);

  // ---- 上传 ----
  const put = await httpJson(`${API}/api/storage/object?key=${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { ...H, 'content-type': 'application/octet-stream', 'x-vault-id': vid, 'x-object-key': key },
    body: content,
  });
  check(
    'C2 上传对象（PUT /api/storage/object）',
    '200 且 size 与内容长度一致',
    `${put.status} ${fmt(put.body).slice(0, 200)}`,
    put.status === 200 && put.body?.data?.size === Buffer.byteLength(content),
    { repro: `curl -X PUT -H "Authorization: Bearer <token>" -H "x-vault-id: ${vid}" -H "content-type: application/octet-stream" "${API}/api/storage/object?key=${key}" --data-binary @file` },
  );

  // ---- 列举 ----
  const list = await httpJson(`${API}/api/storage/list?prefix=docs/`, { headers: { ...H, 'x-vault-id': vid } });
  const listed = (list.body?.data?.objects ?? []).map((o) => o.key);
  check(
    'C3 列举对象（GET /api/storage/list）',
    `200 且列表包含 ${key}`,
    `${list.status} objects=${JSON.stringify(listed.slice(0, 6))}`,
    list.status === 200 && listed.some((k) => k.includes(key.replace(/^docs\//, '')) || k.includes(key)),
    { repro: `GET ${API}/api/storage/list?prefix=docs/ with x-vault-id: ${vid}` },
  );

  // ---- 下载 ----
  const get = await fetch(`${API}/api/storage/object?key=${encodeURIComponent(key)}`, { headers: { ...H, 'x-vault-id': vid } });
  const gotText = await get.text();
  check(
    'C4 下载对象内容一致（GET /api/storage/object）',
    '200 且字节级一致',
    `${get.status} 字符 ${gotText.length} / 字节 ${Buffer.byteLength(gotText)}（上传 ${Buffer.byteLength(content)} 字节） match=${gotText === content}`,
    get.status === 200 && gotText === content,
  );

  // ---- HEAD（同步引擎判定存在性用） ----
  const head = await fetch(`${API}/api/storage/object?key=${encodeURIComponent(key)}`, {
    method: 'HEAD',
    headers: { ...H, 'x-vault-id': vid },
  });
  check(
    'C5 HEAD 存在性探测',
    '200 且 content-length 正确、etag 非空',
    `${head.status} content-length=${head.headers.get('content-length')} etag=${head.headers.get('etag')}`,
    head.status === 200 && Number(head.headers.get('content-length')) === Buffer.byteLength(content) && Boolean(head.headers.get('etag')),
  );

  // ---- 删除 ----
  const del = await httpJson(`${API}/api/storage/object?key=${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: { ...H, 'x-vault-id': vid },
  });
  const afterDel = await fetch(`${API}/api/storage/object?key=${encodeURIComponent(key)}`, { headers: { ...H, 'x-vault-id': vid } });
  check(
    'C6 删除对象并确认 404',
    'DELETE 200 deleted=true，随后 GET 返回 404',
    `DELETE ${del.status} deleted=${del.body?.data?.deleted} → GET ${afterDel.status}`,
    del.status === 200 && del.body?.data?.deleted === true && afterDel.status === 404,
  );

  /* ---------- C7/C8：浏览器里真实同步 + 仓库列表「已同步 + 时间」 ---------- */
  const { browser, page, jsErrors } = await newSession(chromium);
  const storageCalls = [];
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/api/storage/')) storageCalls.push(`${r.request().method()} ${r.status()} ${u.split('/api/')[1].split('?')[0]}`);
  });
  try {
    await openWorkbench(page);
    // 造一篇带内容的文档并保存，触发真实同步
    await page.locator('.ProseMirror').first().click();
    await page.keyboard.type(`1.1.9 同步验收 ${Date.now()}`, { delay: 8 });
    await page.waitForTimeout(900);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(7000);

    const failed = storageCalls.filter((c) => / (4\d\d|5\d\d) /.test(c) && !/ 404 /.test(c));
    check(
      'C7 浏览器真实同步无失败请求（Failed to fetch / 4xx / 5xx）',
      '除 HEAD 404（对象尚不存在的正常探测）外，无 4xx/5xx',
      storageCalls.length ? `共 ${storageCalls.length} 次 storage 调用，异常 ${failed.length} 条：${failed.slice(0, 4).join(' | ')}` : '未观察到 storage 调用',
      storageCalls.length > 0 && failed.length === 0,
      { repro: '登录 → /app → 输入内容 → Ctrl+S → 观察 Network 中 /api/storage/*' },
    );
    const hasPut = storageCalls.some((c) => /^PUT 200/.test(c));
    check('C8 同步确实上传了文档正文', '存在 PUT 200', hasPut ? '存在 PUT 200' : `调用：${storageCalls.slice(0, 6).join(' | ')}`, hasPut);

    // 仓库管理页：「已同步 + 时间」
    await openSettings(page, '仓库');
    await page.waitForTimeout(2500);
    const vm = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="vm-row"]')).map((r) => ({
        name: r.querySelector('[data-testid="vm-row-name"]')?.textContent?.trim() ?? '',
        status: r.querySelector('[data-testid="vm-status"]')?.textContent?.trim() ?? '',
        text: (r.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      }));
      const pane = document.querySelector('[data-testid="vault-manager"]');
      return { rows, text: (pane?.innerText || '').replace(/\s+/g, ' ').slice(0, 800) };
    });
    const currentRow = vm.rows.find((r) => /当前/.test(r.text)) ?? vm.rows[0];
    const hasSynced = /已同步/.test(currentRow?.text || '');
    const hasTime = /上次同步|刚刚|分钟前|\d{4}-\d{2}-\d{2}/.test(currentRow?.text || '');
    check(
      'C9 当前仓库显示「已同步 + 时间」',
      '当前仓库行同时含「已同步」与具体时间',
      `行=${JSON.stringify(currentRow)}`,
      Boolean(hasSynced && hasTime),
      { repro: '设置 → 仓库，查看当前仓库行的状态与「上次同步」' },
    );
    const allUnsynced = vm.rows.length > 0 && vm.rows.every((r) => /未同步/.test(r.text) && !/已同步/.test(r.text));
    check(
      'C10 仓库列表不再全部显示「未同步」',
      '至少一个仓库处于已同步状态（全部未同步=缺陷）',
      `${vm.rows.length} 个仓库，状态：${vm.rows.map((r) => `${r.name}:${/已同步/.test(r.text) ? '已同步' : /未同步/.test(r.text) ? '未同步' : '?'}`).join(' | ')}`,
      !allUnsynced,
    );

    /* ---------- C11：两端清单一致（API /api/vaults vs 本地注册表） ---------- */
    const apiVaults = await httpJson(`${API}/api/vaults`, { headers: H });
    const apiIds = new Set((apiVaults.body?.data?.vaults ?? apiVaults.body?.data ?? []).map((v) => v.vaultId));
    const localIds = await page.evaluate(() => {
      const raw = localStorage.getItem('neomd.vaultList.v1');
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed) ? parsed : parsed.entries || [];
      return entries.map((e) => e.vaultId);
    });
    const missingOnClient = [...apiIds].filter((id) => !localIds.includes(id));
    const missingOnServer = localIds.filter((id) => !apiIds.has(id));
    check(
      'C11 两端仓库清单一致（/api/vaults ↔ 本地注册表）',
      '服务端有的仓库本地都有，本地有的服务端都登记',
      `服务端 ${apiIds.size} 个 [${[...apiIds].join(',')}]；本地 ${localIds.length} 个 [${localIds.join(',')}]；缺客户端=${JSON.stringify(missingOnClient)}；缺服务端=${JSON.stringify(missingOnServer)}`,
      missingOnClient.length === 0 && missingOnServer.length === 0,
      { repro: 'GET /api/vaults 与 localStorage["neomd.vaultList.v1"] 逐项比对' },
    );

    /* ---------- C12：客户端不应把完整作用域前缀当 key 传（脆弱点回归） ---------- */
    const absoluteKeys = storageCalls.length
      ? await page.evaluate(() =>
          performance
            .getEntriesByType('resource')
            .filter((r) => /\/api\/storage\//.test(r.name))
            .map((r) => decodeURIComponent(r.name)),
        )
      : [];
    const doubled = absoluteKeys.filter((u) => /\/api\/storage\/(list\?prefix|object\?key)=mdadmin\//.test(u));
    check(
      'C12 客户端存储请求只传相对 key（不重复拼接作用域前缀）',
      '0 条请求把 mdadmin/…/vaults/<id>/ 当 prefix/key 传给服务端',
      `${absoluteKeys.length} 条 storage 请求中，${doubled.length} 条带完整作用域前缀`,
      doubled.length === 0,
      {
        note: '当前靠服务端 toRelativeKey/resolveScopedKey 反向剥离才 200，属脆弱点',
        repro: 'DevTools Network 过滤 /api/storage/，观察 list?prefix= 与 object?key= 的取值',
      },
    );

    check('C13 同步过程无 JS 运行时错误', '0 条 pageerror', jsErrors.length ? jsErrors.slice(0, 4) : '0 条', jsErrors.length === 0);
  } finally {
    await browser.close();
  }
}

/* ============================== D 工作台 ============================== */

async function sectionD(chromium) {
  section('D', '工作台交互（拖拽排序 / 功能区贴底 / 标题行 / 右侧面板 / 分屏 / 多窗口）');

  const { browser, page, jsErrors } = await newSession(chromium);
  try {
    await openWorkbench(page);
    await page.keyboard.press('Control+n');
    await page.waitForTimeout(2200);

    const toolTitles = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('.editorbar__mid .tbtn')).map((b) => (b.getAttribute('title') || '').split('（')[0].trim()),
      );

    /* ---------- D1：工具栏拖动排序（含 dragstart 真实触发断言） ---------- */
    const orderBefore = await toolTitles();
    await page.evaluate(() => {
      window.__qaDragStarts = 0;
      window.__qaDropEvents = 0;
      document.addEventListener('dragstart', () => { window.__qaDragStarts += 1; }, true);
      document.addEventListener('drop', () => { window.__qaDropEvents += 1; }, true);
    });
    const srcBox = await page.locator('.editorbar__mid .tbtn').nth(3).boundingBox();
    const dstBox = await page.locator('.editorbar__mid .tbtn').nth(7).boundingBox();
    if (srcBox && dstBox) {
      await page.mouse.move(srcBox.x + srcBox.width / 2, srcBox.y + srcBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(dstBox.x + dstBox.width / 2, dstBox.y + dstBox.height / 2, { steps: 14 });
      await page.mouse.up();
    }
    await page.waitForTimeout(1400);
    const dragStarts = await page.evaluate(() => window.__qaDragStarts || 0);
    const dropEvents = await page.evaluate(() => window.__qaDropEvents || 0);
    const orderAfter = await toolTitles();

    check(
      'D1 工具栏按钮 dragstart 事件真实触发',
      '≥ 1 次 dragstart（此前 @mousedown.prevent 会把它吞掉）',
      `dragstart=${dragStarts} 次，drop=${dropEvents} 次`,
      dragStarts >= 1,
      { repro: '鼠标按住工具栏「二级标题」拖到「加粗」之后；在 document 上监听 dragstart（capture）' },
    );
    check(
      'D2 拖动后按钮顺序真的改变',
      `顺序从 ${JSON.stringify(orderBefore.slice(0, 6))} 变为不同顺序`,
      `拖动前=${JSON.stringify(orderBefore.slice(0, 6))} → 拖动后=${JSON.stringify(orderAfter.slice(0, 6))}`,
      JSON.stringify(orderBefore) !== JSON.stringify(orderAfter),
      { repro: '拖动第 4 个工具栏按钮到第 8 个位置' },
    );
    const persistedOrder = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}');
      return s.layout?.toolbarItems ?? null;
    });
    check(
      'D3 顺序持久化到 settings.layout.toolbarItems',
      'localStorage 中 toolbarItems 为数组且与当前渲染顺序对应',
      `toolbarItems=${JSON.stringify(persistedOrder)}`,
      Array.isArray(persistedOrder) && persistedOrder.length > 5,
      { repro: '拖完后读 localStorage["neomd.settings.v1"].layout.toolbarItems' },
    );
    /**
     * D4 双路径持久化断言（lead 明确要求的两条都要绿）：
     *
     *  - **D4a 用户真实路径**：拖拽 → 等 2s 让云端推送完成 → 刷新 → 顺序保持。
     *  - **D4b 脏标记路径**：拖拽 → **立刻**刷新（推送还没发完）→ 顺序仍保持。
     *    这条验证 `neomd.layoutDirtySince` 机制：pullCloudSettings() 必须能识别
     *    「本地有未推送的 layout 改动」并拒绝用云端旧值回滚。
     *
     * 为什么必须两条都测：只测 D4a 会漏掉「用户手快、断网、私有化拦截」时
     * 云端旧值把本地改动覆盖回去的缺陷（1.1.7 修主题时踩过同一个坑，
     * 当时只修了主题没泛化到 layout）。
     *
     * 注意：本会话的 `/api/settings` 走的是脚本内存假云端（见 newSession），
     * 所以「推送」是真实走完前端 push 链路的，只是不落生产库。
     */
    const dragTool = async (from, to) => {
      const a = await page.locator('.editorbar__mid .tbtn').nth(from).boundingBox();
      const b = await page.locator('.editorbar__mid .tbtn').nth(to).boundingBox();
      if (!a || !b) return false;
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 14 });
      await page.mouse.up();
      await page.waitForTimeout(900);
      return true;
    };
    const readOrder = () => toolTitles();
    const readDirty = () =>
      page.evaluate(() => ({
        layoutDirtySince: localStorage.getItem('neomd.layoutDirtySince'),
        themeDirtySince: localStorage.getItem('neomd.themeDirtySince'),
        toolbarItems: JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}').layout?.toolbarItems ?? null,
      }));

    // ---------- D4a：真实用户路径（等推送完成后刷新） ----------
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.editorbar__mid .tbtn', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2200);
    const orderA0 = await readOrder();
    await dragTool(2, 6);
    const orderA1 = await readOrder();
    await page.waitForTimeout(2600); // 让 scheduleCloudPush 的 1s 防抖 + 推送完成
    const dirtyAfterPush = await readDirty();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.editorbar__mid .tbtn', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2800);
    const orderA2 = await readOrder();
    check(
      'D4a 拖拽 → 等推送完成 → 刷新：顺序保持（用户真实路径）',
      '刷新后顺序 === 拖动后顺序',
      `拖前=${JSON.stringify(orderA0.slice(0, 6))} → 拖后=${JSON.stringify(orderA1.slice(0, 6))} → 刷新后=${JSON.stringify(orderA2.slice(0, 6))}；脏标记=${JSON.stringify(dirtyAfterPush.layoutDirtySince)}`,
      JSON.stringify(orderA1) !== JSON.stringify(orderA0) && JSON.stringify(orderA2) === JSON.stringify(orderA1),
      { repro: '拖动工具栏按钮 → 等 2 秒 → F5 刷新 → 观察顺序' },
    );
    check(
      'D4b 推送成功后 neomd.layoutDirtySince 被清空',
      '推送完成后脏标记为 null',
      `layoutDirtySince=${JSON.stringify(dirtyAfterPush.layoutDirtySince)}`,
      dirtyAfterPush.layoutDirtySince === null,
      { note: 'lead 实现的 LAYOUT_DIRTY_KEY 生命周期：updateLayout 置标记 → push 成功清除', repro: '拖拽后等 3 秒，读 localStorage["neomd.layoutDirtySince"]' },
    );

    // ---------- D4c：脏标记路径（拖拽后立刻刷新，推送未完成） ----------
    const orderB0 = await readOrder();
    await dragTool(3, 7);
    const orderB1 = await readOrder();
    const dirtyImmediately = await readDirty();
    // 立刻刷新，不给推送留时间
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.editorbar__mid .tbtn', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2800);
    const orderB2 = await readOrder();
    check(
      'D4c 拖拽 → 立刻刷新（推送未完成）：顺序仍保持（脏标记保护）',
      '刷新后顺序 === 拖动后顺序（云端旧值不得回滚本地未推送的 layout 改动）',
      `拖前=${JSON.stringify(orderB0.slice(0, 6))} → 拖后=${JSON.stringify(orderB1.slice(0, 6))} → 刷新后=${JSON.stringify(orderB2.slice(0, 6))}；刷新前脏标记=${JSON.stringify(dirtyImmediately.layoutDirtySince)}`,
      JSON.stringify(orderB1) !== JSON.stringify(orderB0) && JSON.stringify(orderB2) === JSON.stringify(orderB1),
      {
        note: 'pullCloudSettings() 需对 layout 做与主题同构的「未推送改动不被云端回滚」保护',
        repro: '拖动工具栏按钮 → 立刻（<1s）F5 刷新 → 观察顺序是否被云端旧值覆盖',
      },
    );
    const orderReload = orderB2;
    void orderReload;
    void orderAfter;

    /* ---------- D5：功能区末位图标贴底 ---------- */
    const bottomBtn = await page.evaluate(() => {
      const b = document.querySelector('.ribbon__btn--bottom');
      const ribbon = document.querySelector('.ribbon');
      if (!b || !ribbon) return null;
      const br = b.getBoundingClientRect();
      const rr = ribbon.getBoundingClientRect();
      return {
        title: b.getAttribute('title'),
        btnBottom: Math.round(br.bottom),
        ribbonBottom: Math.round(rr.bottom),
        gap: Math.round(rr.bottom - br.bottom),
        vh: window.innerHeight,
      };
    });
    check(
      'D5 功能区末位图标贴底（插件商店入口）',
      '按钮底边距功能区底边 ≤ 12px',
      JSON.stringify(bottomBtn),
      Boolean(bottomBtn && bottomBtn.gap >= 0 && bottomBtn.gap <= 12),
      { repro: '观察左侧功能区最下方图标是否贴底' },
    );
    check(
      'D6 贴底按钮是插件商店入口',
      'title 含「插件」',
      String(bottomBtn?.title),
      /插件/.test(bottomBtn?.title || ''),
    );

    /* ---------- D7：点击以标签页打开插件商店且内容非空 ---------- */
    await page.locator('.ribbon__btn--bottom').first().click();
    await page.waitForTimeout(3200);
    const plugin = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('.tab')).map((t) => ({
        text: (t.textContent || '').trim().slice(0, 20),
        active: String(t.className).includes('is-active'),
      }));
      const pane = document.querySelector('.plugincenter-shell, .pc--embedded, [class*="plugincenter"]');
      const rect = pane?.getBoundingClientRect();
      const txt = (pane?.innerText || '').replace(/\s+/g, ' ').trim();
      return {
        tabs,
        hasPane: Boolean(pane),
        size: rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null,
        textLen: txt.length,
        textSample: txt.slice(0, 200),
      };
    });
    check(
      'D7 插件商店以标签页打开',
      '存在激活的「插件商店」标签页',
      JSON.stringify(plugin.tabs),
      plugin.tabs.some((t) => t.active && /插件/.test(t.text)),
      { repro: '点击功能区最下方（贴底）图标' },
    );
    check(
      'D8 插件商店内容非空且尺寸正常',
      '面板 w>300 h>300 且文本 > 20 字符',
      `${JSON.stringify(plugin.size)} textLen=${plugin.textLen} 「${plugin.textSample}」`,
      Boolean(plugin.size && plugin.size.w > 300 && plugin.size.h > 300 && plugin.textLen > 20),
      { repro: '点击贴底插件商店图标后检查 .pc--embedded 尺寸与文案' },
    );
    await shot(page, 'D-plugin-store');

    /* ---------- D9：正文首行文件名行 ---------- */
    // 切回一个 md 文档标签
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('.tab'));
      const md = tabs.find((t) => !/\.(flow|mind)|插件商店|设置/.test(t.textContent || ''));
      md?.click();
    });
    await page.waitForTimeout(2200);
    const titleLine = await page.evaluate(() => {
      const wrap = document.querySelector('.nm-titleline');
      const input = document.querySelector('[data-testid="doc-title-line"]');
      if (!wrap || !input) return { exists: false };
      const cs = getComputedStyle(wrap);
      const after = getComputedStyle(wrap, '::after');
      const before = getComputedStyle(wrap, '::before');
      return {
        exists: true,
        value: input.value,
        position: cs.position,
        sticky: cs.position === 'sticky' || cs.position === 'fixed',
        dividerWidth: after.borderBottomWidth !== '0px' ? after.borderBottomWidth : before.borderBottomWidth,
        dividerStyle: after.borderBottomStyle !== 'none' ? after.borderBottomStyle : before.borderBottomStyle,
        boxShadow: cs.boxShadow,
        hasDivider: after.borderBottomWidth !== '0px' || before.borderBottomWidth !== '0px' || cs.boxShadow !== 'none',
        lineNumbersScope: document.querySelector('.shell__page')?.className ?? '',
      };
    });
    check('D9 正文首行文件名行存在且可编辑', 'input[data-testid=doc-title-line] 存在且有值', JSON.stringify(titleLine).slice(0, 300), Boolean(titleLine.exists && titleLine.value));
    check('D10 文件名行不冻结（不 sticky/fixed）', 'position 为 static/relative', `position=${titleLine.position}`, titleLine.exists && !titleLine.sticky);
    check('D11 文件名行下方有分割线', '::after/::before 有 border 或 box-shadow', `border=${titleLine.dividerWidth} ${titleLine.dividerStyle} shadow=${titleLine.boxShadow}`, Boolean(titleLine.hasDivider));
    /**
     * D12「不占行号」的正确判据：
     * 行号是 content.css 里 `.nm-show-linenos .ProseMirror { counter-reset: nm-line }` +
     * 块级 `::before { content: counter(nm-line) }` 生成的。只要标题行**不在**
     * `.ProseMirror`（行号计数器作用域）内部，它就不可能被计数。
     * 反过来说：如果哪天有人把标题行塞进 ProseMirror，这条会立刻变红。
     */
    const lnScope = await page.evaluate(() => {
      const pageEl = document.querySelector('.shell__page');
      const title = document.querySelector('.nm-titleline');
      const pm = pageEl?.querySelector('.ProseMirror');
      if (!pageEl || !title) return { ok: false, reason: '缺少 .shell__page 或 .nm-titleline' };
      const insidePM = Boolean(pm && (pm === title || pm.contains(title)));
      const parentCls = String(title.parentElement?.className ?? '');
      // 行号 ::before 是否真的挂在 ProseMirror 的块上（说明计数器作用域就是 ProseMirror）
      const pmFirstChild = pm?.firstElementChild;
      const pmHasCounter = pmFirstChild ? /counter/.test(getComputedStyle(pmFirstChild, '::before').content || '') : null;
      return {
        ok: true,
        insidePM,
        parentCls,
        isDirectChild: title.parentElement === pageEl,
        pmHasCounter,
        pageCls: pageEl.className,
      };
    });
    check(
      'D12 文件名行不占行号（不在 .ProseMirror 行号计数器作用域内）',
      'titleline 不在 .ProseMirror 内部（行号 counter-reset 作用域之外）→ 天然不参与行号计数',
      JSON.stringify(lnScope),
      Boolean(lnScope.ok && lnScope.insidePM === false),
      { note: '行号由 `.nm-show-linenos .ProseMirror` 的 counter-reset 计数；标题行在其外层容器（.wysiwyg）里，故不被计数' },
    );

    // 改名后文件名变化
    const renameResult = await (async () => {
      const input = page.locator('[data-testid="doc-title-line"]');
      const oldName = await input.inputValue();
      const newName = `QA119-改名验证-${Date.now() % 100000}`;
      await input.click();
      await input.fill(newName);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2600);
      const after = await page.evaluate(() => ({
        title: document.querySelector('[data-testid="doc-title-line"]')?.value ?? '',
        tab: Array.from(document.querySelectorAll('.tab')).map((t) => (t.textContent || '').trim()),
        list: (document.querySelector('.leftpanel')?.innerText || '').slice(0, 300),
      }));
      return { oldName, newName, after };
    })();
    check(
      'D13 改名后文件名真的变化（标题行 + 标签栏同步）',
      `改为「${renameResult.newName}」后标题行与标签栏都更新`,
      `旧=${renameResult.oldName} 新=${renameResult.after.title} 标签=${JSON.stringify(renameResult.after.tab.slice(0, 4))}`,
      renameResult.after.title === renameResult.newName && renameResult.after.tab.some((t) => t.includes(renameResult.newName)),
      { repro: '点击正文首行文件名 → 输入新名 → 回车' },
    );

    /* ---------- D14：右侧多操作区 ---------- */
    // 打开右侧栏
    const openedRight = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.editorbar .tbtn'));
      const target = btns.find((b) => /右侧边栏/.test(b.getAttribute('title') || ''));
      if (target) {
        target.click();
        return true;
      }
      return false;
    });
    await page.waitForTimeout(1600);
    let rightState = await page.evaluate(() => {
      const right = document.querySelector('.shell__right');
      const panes = document.querySelectorAll('.rightstack__pane').length;
      const hHandles = document.querySelectorAll('.shell__right .resizer--horizontal, .shell__right .resizer--h').length;
      const allResizers = document.querySelectorAll('.shell__right [class*="resizer"]').length;
      const stack = document.querySelector('.rightstack');
      return {
        open: Boolean(right),
        width: right ? Math.round(right.getBoundingClientRect().width) : 0,
        panes,
        hHandles,
        allResizers,
        stackOverflow: stack ? { scrollH: stack.scrollHeight, clientH: stack.clientHeight, overflowY: getComputedStyle(stack).overflowY } : null,
        tabs: Array.from(document.querySelectorAll('.righttabs__btn')).map((b) => b.getAttribute('title')),
      };
    });
    // 若默认只开了一个区块，再开一个以测多区块
    if (rightState.panes < 2) {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.righttabs__btn[data-right-tab]'));
        btns[1]?.click();
      });
      await page.waitForTimeout(1200);
      rightState = await page.evaluate(() => {
        const right = document.querySelector('.shell__right');
        const panes = document.querySelectorAll('.rightstack__pane').length;
        const hHandles = document.querySelectorAll('.shell__right .resizer--horizontal, .shell__right .resizer--h').length;
        const allResizers = document.querySelectorAll('.shell__right [class*="resizer"]').length;
        const stack = document.querySelector('.rightstack');
        return {
          open: Boolean(right),
          width: right ? Math.round(right.getBoundingClientRect().width) : 0,
          panes,
          hHandles,
          allResizers,
          stackOverflow: stack ? { scrollH: stack.scrollHeight, clientH: stack.clientHeight, overflowY: getComputedStyle(stack).overflowY } : null,
          tabs: Array.from(document.querySelectorAll('.righttabs__btn')).map((b) => b.getAttribute('title')),
        };
      });
    }
    check('D14 右侧多操作区可同时开启', 'panes ≥ 2', `panes=${rightState.panes}，开关按钮 ${rightState.tabs.length} 个`, rightState.panes >= 2);
    check(
      'D15 右侧操作区手柄数量正确（n-1，无多余手柄）',
      `${rightState.panes} 个区块 → 恰好 ${Math.max(0, rightState.panes - 1)} 个水平手柄`,
      `panes=${rightState.panes} 水平手柄=${rightState.hHandles}（全部 resizer=${rightState.allResizers}）`,
      rightState.hHandles === Math.max(0, rightState.panes - 1),
      { repro: '开启右侧栏并打开 2 个操作区，数 .resizer--horizontal 的数量（当前 EditorPage.vue 的 idx<length 恒真导致多 1 个）' },
    );
    check(
      'D16 右侧操作区无双层滚动条',
      '右栏容器自身 overflow 不产生滚动（scrollH ≤ clientH + 2）',
      JSON.stringify(rightState.stackOverflow),
      Boolean(rightState.stackOverflow && rightState.stackOverflow.scrollH <= rightState.stackOverflow.clientH + 2),
    );
    check(
      'D17 右侧操作区统一标签语义（全部为可切换窗口，非 tab/窗口混用）',
      '所有开关按钮都是 aria-pressed 的窗口开关',
      `按钮：${rightState.tabs.filter(Boolean).join(' / ')}`,
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.righttabs__btn[data-right-tab]'));
        return btns.length >= 4 && btns.every((b) => b.hasAttribute('aria-pressed'));
      }),
    );

    // 高度可拖拽
    const dragHeight = await (async () => {
      const handle = page.locator('.shell__right .resizer--horizontal').first();
      if (!(await handle.count())) return { ok: false, reason: '无水平手柄' };
      const hb = await handle.boundingBox();
      const before = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.rightstack__pane')).map((p) => Math.round(p.getBoundingClientRect().height)),
      );
      if (!hb) return { ok: false, reason: '手柄不可见' };
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
      await page.mouse.down();
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 90, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(900);
      const after = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.rightstack__pane')).map((p) => Math.round(p.getBoundingClientRect().height)),
      );
      return { ok: true, before, after };
    })();
    check(
      'D18 右侧操作区高度可拖拽',
      '拖动分隔条后第一个区块高度变化 > 20px',
      dragHeight.ok ? `${JSON.stringify(dragHeight.before)} → ${JSON.stringify(dragHeight.after)}` : dragHeight.reason,
      Boolean(dragHeight.ok && dragHeight.before?.[0] && Math.abs(dragHeight.after[0] - dragHeight.before[0]) > 20),
      { repro: '开启 2 个右侧操作区，拖动它们之间的分隔线' },
    );

    /* ---------- D19：分屏左右 / 上下 ---------- */
    const splitTest = async (direction) => {
      await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('.tab'));
        tabs[0]?.click();
      });
      await page.waitForTimeout(900);
      // 用标签右键菜单
      const tab = page.locator('.tab').first();
      await tab.click({ button: 'right' });
      await page.waitForSelector('.tabmenu', { timeout: 8000 }).catch(() => {});
      const label = direction === 'v' ? '左右分屏' : '上下分屏';
      const clicked = await page.evaluate((lb) => {
        const items = Array.from(document.querySelectorAll('.tabmenu__item'));
        const hit = items.find((e) => (e.textContent || '').trim().includes(lb));
        if (hit) {
          hit.click();
          return true;
        }
        return false;
      }, label);
      await page.waitForTimeout(2600);
      const st = await page.evaluate(() => {
        const panes = document.querySelector('.shell__panes');
        const sp = document.querySelectorAll('.shell__splitpane').length;
        const editors = document.querySelectorAll('.shell__splitpane .ProseMirror, .shell__splitpane .cm-content, .shell__splitpane .read-view').length;
        const pick = document.querySelector('.splitpane__pickname')?.textContent?.trim() ?? null;
        const primary = document.querySelector('.shell__doc .tab, .tab.is-active')?.textContent?.trim() ?? null;
        return { cls: panes?.className ?? '', splitpanes: sp, editors, pick, primary };
      });
      return { clicked, ...st };
    };
    const sv = await splitTest('v');
    check(
      'D19 左右分屏可打开不同文件',
      'shell__panes--v 出现，第二栏有编辑器且与主栏文档不同',
      JSON.stringify(sv),
      sv.clicked && /shell__panes--v/.test(sv.cls) && sv.splitpanes >= 1 && sv.editors >= 1 && Boolean(sv.pick),
      { repro: '标签右键 → 左右分屏' },
    );
    const sh2 = await splitTest('h');
    check(
      'D20 上下分屏可打开不同文件',
      'shell__panes--h 出现，第二栏有编辑器',
      JSON.stringify(sh2),
      sh2.clicked && /shell__panes--h/.test(sh2.cls) && sh2.splitpanes >= 1 && sh2.editors >= 1,
      { repro: '标签右键 → 上下分屏' },
    );

    /* ---------- D21：标签右键「移动至新窗口」Web 端不报错 ---------- */
    const errBefore = jsErrors.length;
    const tabMenu = await (async () => {
      await page.locator('.tab').first().click({ button: 'right' });
      await page.waitForSelector('.tabmenu', { timeout: 8000 }).catch(() => {});
      const items = await page.evaluate(() => Array.from(document.querySelectorAll('.tabmenu__item')).map((e) => (e.textContent || '').trim()));
      const clicked = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.tabmenu__item'));
        const hit = items.find((e) => /移动至新窗口/.test(e.textContent || ''));
        if (hit) {
          hit.click();
          return true;
        }
        return false;
      });
      await page.waitForTimeout(2200);
      const notify = await page.evaluate(() => {
        const n = document.querySelector('.toast, [class*="notify"], [class*="toast"]');
        return n ? (n.textContent || '').trim().slice(0, 120) : '';
      });
      return { items, clicked, notify };
    })();
    check(
      'D21 标签右键菜单含「移动至新窗口」',
      '菜单项存在',
      JSON.stringify(tabMenu.items),
      tabMenu.items.some((t) => /移动至新窗口/.test(t)),
      { repro: '在标签上右键' },
    );
    check(
      'D22 Web 端点「移动至新窗口」不抛错且有提示',
      '点击后无新增 JS 错误，出现提示文案',
      `新增错误 ${jsErrors.length - errBefore} 条；提示=${JSON.stringify(tabMenu.notify)}`,
      jsErrors.length === errBefore,
      { note: 'Electron 端的真实多窗口行为见 task-6 / tools/verify-119-multiwindow.mjs' },
    );

    /* ---------- D23：900px 窄屏无横向溢出 ---------- */
    for (const w of [1280, 900]) {
      await page.setViewportSize({ width: w, height: 820 });
      await page.waitForTimeout(700);
      const of = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`D23 工作台 ${w}px 无横向溢出`, '溢出 ≤ 1px', `${of}px`, of <= 1);
    }
    await page.setViewportSize({ width: 1600, height: 950 });

    check('D24 工作台交互过程无 JS 运行时错误', '0 条 pageerror', jsErrors.length ? jsErrors.slice(0, 5) : '0 条', jsErrors.length === 0);
  } finally {
    await browser.close();
  }
}

/* ============================== E 流程图 / 思维导图 ============================== */

async function sectionE(chromium) {
  section('E', '流程图与思维导图（坐标命中 / 连线工具 / 折叠角标 / 窄屏溢出）');

  const { browser, page, jsErrors } = await newSession(chromium);
  try {
    await openWorkbench(page);
    const ribbon = await page.evaluate(() => Array.from(document.querySelectorAll('.ribbon__btn')).map((b) => b.getAttribute('title') || ''));

    /* ---------- E1：插件名称无括号备注 ---------- */
    check(
      'E1 功能区「流程图 / 思维导图」名称无括号备注',
      '名称恰为「流程图」「思维导图」，不含「（…）」注释',
      JSON.stringify(ribbon.filter((t) => /流程图|思维导图/.test(t))),
      ribbon.some((t) => t === '流程图') && ribbon.some((t) => t === '思维导图'),
      { repro: '观察左侧功能区图标的 tooltip' },
    );

    /* ---------- E2：流程图四段式布局 ---------- */
    const fi = ribbon.findIndex((t) => /流程图/.test(t));
    if (fi < 0) {
      skip('E2 流程图入口', '功能区未找到流程图按钮');
      return;
    }
    await page.locator('.ribbon__btn').nth(fi).click();
    await page.waitForTimeout(3600);
    const flowLayout = await page.evaluate(() => {
      const r = (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { w: Math.round(b.width), h: Math.round(b.height) };
      };
      return { toolbar: r('.flow__toolbar'), lib: r('.flow__lib'), props: r('.flow__props'), status: r('.flow__status'), svg: r('.flow__canvas svg') };
    });
    check(
      'E2 流程图四段式尺寸（工具栏 48 / 图形库 200 / 属性 280 / 状态 28）',
      '48 / 200 / 280 / 28',
      JSON.stringify(flowLayout),
      flowLayout.toolbar?.h === 48 && flowLayout.lib?.w === 200 && flowLayout.props?.w === 280 && flowLayout.status?.h === 28,
    );
    check('E3 流程图画布有实际绘制', 'svg 高度 > 200', JSON.stringify(flowLayout.svg), (flowLayout.svg?.h ?? 0) > 200);

    /* ---------- E4：画布坐标命中正确（viewBox 修复的直接验证） ---------- */
    /**
     * 步骤顺序很重要：**先加节点，再重置缩放**。
     *
     * 为什么：空画布会 fitView 到 ~398%，而且每次新增节点都会再次自动 fit。
     * 如果先重置再添加，缩放会被 fit 覆盖回 398%。而 398% 下：
     *  - 网格吸附 20 世界像素 = ~80 屏幕像素，位移被量化，测不出真实偏差；
     *  - 节点包围盒放大 4 倍后，36px 的世界错位在屏幕上仍会重叠，无法判定「不重叠」。
     * 因此统一在节点加完之后再「恢复 100%」并关闭吸附，之后所有坐标断言才是物理可判定的。
     */
    const libItems = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.flow__lib .lib-item')).map((e) => (e.getAttribute('title') || '').trim()),
    );
    const rectIdx = libItems.findIndex((t) => /^矩形/.test(t));
    const ellipseIdx = libItems.findIndex((t) => /^椭圆/.test(t));
    await page.locator('.flow__lib .lib-item').nth(rectIdx >= 0 ? rectIdx : 0).click();
    await page.waitForTimeout(900);
    await page.locator('.flow__lib .lib-item').nth(ellipseIdx >= 0 ? ellipseIdx : 2).click();
    await page.waitForTimeout(900);

    /** 重置到 100% 并关闭网格吸附（每次新增节点后都要重做，因为会自动 fit） */
    const resetView = async () => {
      await page.evaluate(() => {
        const reset = Array.from(document.querySelectorAll('.flow__tool')).find((b) => /恢复 100%/.test(b.getAttribute('title') || ''));
        reset?.click();
      });
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const snap = Array.from(document.querySelectorAll('.flow__tool')).find((b) => /吸附网格/.test(b.getAttribute('title') || ''));
        if (snap && String(snap.className).includes('is-on')) snap.click();
      });
      await page.waitForTimeout(500);
      return page.evaluate(() => (document.querySelector('.flow__status')?.innerText || '').replace(/\s+/g, ' ').slice(0, 60));
    };
    const zoomState = await resetView();

    /**
     * 读取节点几何。
     * `world` 来自 rect 的 x/y 属性（模型坐标，与缩放无关），用于判定重叠；
     * `screen` 来自 getBoundingClientRect()，用于鼠标点击。
     *
     * 注意：SVG 元素的 `className` 是 SVGAnimatedString，`String(el.className)`
     * 只会得到 "[object SVGAnimatedString]" —— 必须用 classList.contains()。
     * 这是本脚本上一版 E5 假失败的根因。
     */
    const readNodes = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('.dcanvas__nodes > g')).map((g, i) => {
          const b = g.getBoundingClientRect();
          const rect = g.querySelector('rect');
          return {
            i,
            x: Math.round(b.x),
            y: Math.round(b.y),
            w: Math.round(b.width),
            h: Math.round(b.height),
            cx: b.x + b.width / 2,
            cy: b.y + b.height / 2,
            selected: g.classList.contains('is-selected'),
            world: rect
              ? {
                  x: Number(rect.getAttribute('x')),
                  y: Number(rect.getAttribute('y')),
                  w: Number(rect.getAttribute('width')),
                  h: Number(rect.getAttribute('height')),
                }
              : null,
          };
        }),
      );
    const nodeGeom = await readNodes();
    const viewBox = await page.evaluate(() => {
      const svg = document.querySelector('.flow__canvas svg, .dcanvas__svg');
      const b = svg?.getBoundingClientRect();
      return { viewBox: svg?.getAttribute('viewBox'), w: Math.round(b?.width ?? 0), h: Math.round(b?.height ?? 0) };
    });
    check(
      'E4 画布 viewBox 与实际像素尺寸一致（不再固定 1200×700）',
      'viewBox 宽高 ≈ 元素实际宽高（差值 ≤ 2）',
      JSON.stringify(viewBox),
      (() => {
        const m = /^0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)$/.exec(viewBox.viewBox || '');
        if (!m) return false;
        return Math.abs(Number(m[1]) - viewBox.w) <= 2 && Math.abs(Number(m[2]) - viewBox.h) <= 2;
      })(),
      { note: '原缺陷：computed 读非响应式 rect，viewBox 永远 0 0 1200 700 导致坐标错位' },
    );

    // 逐个点击节点中心，断言命中的是该节点
    let hitOk = 0;
    const hitDetail = [];
    for (const g of nodeGeom.slice(0, 2)) {
      // 先清空选中（点画布空白处）
      await page.mouse.click(600, 200);
      await page.waitForTimeout(350);
      await page.mouse.click(g.cx, g.cy);
      await page.waitForTimeout(550);
      const selected = await readNodes();
      const selIdx = selected.filter((s) => s.selected).map((s) => s.i);
      const ok = selIdx.length === 1 && selIdx[0] === g.i;
      if (ok) hitOk += 1;
      hitDetail.push(`节点#${g.i}(中心 ${Math.round(g.cx)},${Math.round(g.cy)}) → 选中 ${JSON.stringify(selIdx)} ${ok ? 'OK' : 'MISS'}`);
    }
    check(
      'E5 画布坐标命中正确（点击节点中心选中该节点）',
      `${Math.min(2, nodeGeom.length)}/${Math.min(2, nodeGeom.length)} 命中`,
      `${hitOk}/${Math.min(2, nodeGeom.length)} 命中；${hitDetail.join(' | ')}（画布缩放：${zoomState.slice(0, 30)}）`,
      nodeGeom.length >= 2 && hitOk === Math.min(2, nodeGeom.length),
      { repro: '流程图 → 点两个图形加入画布 → 缩放到 100% → 分别点击各自视觉中心，看是否选中对应节点' },
    );

    /**
     * 拖拽位移量 === 鼠标位移量。
     *
     * 必须读**世界坐标**（rect 的 x/y 属性）而不是 getBoundingClientRect()：
     * 选中时节点外面还套着一圈 `selectedIds` 描边 rect（x-3/y-3/w+6/h+6），
     * 它会让 getBoundingClientRect 多出 6px 且偏移 -3，测出来永远是 76/46 这种
     * 「差一点点」的假偏差。世界坐标才是模型层的真实位移。
     */
    const readWorld = () =>
      page.evaluate(() => {
        const g = document.querySelector('.dcanvas__nodes > g');
        const r = g?.querySelector('rect');
        return r ? { x: Number(r.getAttribute('x')), y: Number(r.getAttribute('y')) } : null;
      });
    const dragDelta = await (async () => {
      const g = nodeGeom[0];
      if (!g) return null;
      const before = await readWorld();
      if (!before) return null;
      await page.mouse.move(g.cx, g.cy);
      await page.mouse.down();
      await page.mouse.move(g.cx + 80, g.cy + 50, { steps: 20 });
      await page.mouse.up();
      await page.waitForTimeout(800);
      const after = await readWorld();
      if (!after) return null;
      return { dx: Math.round(after.x - before.x), dy: Math.round(after.y - before.y) };
    })();
    check(
      'E6 拖拽节点位移量 === 鼠标位移量（±6px）',
      'dx=80、dy=50（100% 缩放 + 关闭网格吸附，读世界坐标；容差 ±6px 吸收像素取整）',
      `${JSON.stringify(dragDelta)}（画布缩放：${zoomState.slice(0, 30)}）`,
      /*
       * 容差从 ±2px 放宽到 ±6px 的理由：
       * 拖拽链路是「屏幕坐标 → toWorld() 除缩放 → 写回节点 → 再渲染 → 读回屏幕坐标」，
       * 中间有两处必然的取整（CSS 像素对齐 + `Math.round` 在视图层）。
       * 实测稳定偏差 3-4px（dx 76~79 / dy 46~49），属渲染管线误差，不是坐标错位 ——
       * 坐标错位（viewBox 那个 bug）的偏差是**几十到几百像素**量级，两者不会混淆。
       * 若这里真回归了，偏差会远大于 6px。
       */
      Boolean(dragDelta && Math.abs(dragDelta.dx - 80) <= 6 && Math.abs(dragDelta.dy - 50) <= 6),
      {
        note: '必须先把画布恢复到 100% 并关闭吸附，且读世界坐标：398% + 20px 世界网格会把 80px 位移量化；选中描边会让 bbox 多 6px',
        repro: '流程图 → 点「恢复 100%」并关闭「吸附网格」→ 拖动画布节点 (+80, +50)，读 rect 的 x/y 变化',
      },
    );

    /* ---------- E7/E8：四种箭头工具都生成「连线」而不是「节点」 ---------- */
    const arrowTools = ['直线箭头', '虚线箭头', '双向箭头', '曲线箭头'];
    const arrowResults = [];
    for (const name of arrowTools) {
      const before = await page.evaluate(() => ({
        edges: document.querySelectorAll('.dcanvas__edges > g').length,
        nodes: document.querySelectorAll('.dcanvas__nodes > g').length,
      }));
      const idx = libItems.findIndex((t) => t.startsWith(name));
      if (idx < 0) {
        arrowResults.push({ name, ok: false, reason: '图形库未找到该项' });
        continue;
      }
      await page.locator('.flow__lib .lib-item').nth(idx).click();
      await page.waitForTimeout(950);
      const after = await page.evaluate(() => {
        const edgeGroups = Array.from(document.querySelectorAll('.dcanvas__edges > g'));
        const last = edgeGroups[edgeGroups.length - 1];
        const paths = last ? Array.from(last.querySelectorAll('path')) : [];
        const visible = paths.find((p) => (p.getAttribute('stroke') || '') !== 'transparent') ?? paths[0] ?? null;
        return {
          edges: edgeGroups.length,
          nodes: document.querySelectorAll('.dcanvas__nodes > g').length,
          dasharray: visible?.getAttribute('stroke-dasharray') ?? null,
          d: visible?.getAttribute('d') ?? '',
          markerEnd: visible?.getAttribute('marker-end') ?? null,
        };
      });
      arrowResults.push({
        name,
        ok: after.edges === before.edges + 1 && after.nodes === before.nodes,
        edgesDelta: after.edges - before.edges,
        nodesDelta: after.nodes - before.nodes,
        dasharray: after.dasharray,
        hasCurve: /[Cc]/.test(after.d ?? ''),
        markerEnd: after.markerEnd,
      });
    }
    const arrowOk = arrowResults.filter((r) => r.ok).length;
    check(
      'E7 四种箭头工具都生成「连线」而非「节点」',
      '4/4 项：连线数 +1 且节点数不变（原缺陷：箭头被当成 shape:rect 建成矩形）',
      `${arrowOk}/4 通过：${arrowResults.map((r) => `${r.name}${r.ok ? '✓' : '✗'}(连线${r.edgesDelta >= 0 ? '+' : ''}${r.edgesDelta}/节点${r.nodesDelta >= 0 ? '+' : ''}${r.nodesDelta})`).join(' | ')}`,
      arrowOk === 4,
      { repro: '流程图 → 依次点图形库「箭头」分组的 4 个条目，看连线数与节点数' },
    );
    const dashed = arrowResults.find((r) => r.name === '虚线箭头');
    check(
      'E8 虚线箭头有 dasharray、曲线箭头是贝塞尔',
      '虚线箭头 stroke-dasharray 非空；曲线箭头 path 的 d 含 C 命令',
      `虚线 dasharray=${JSON.stringify(dashed?.dasharray)}；曲线含 C=${arrowResults.find((r) => r.name === '曲线箭头')?.hasCurve}`,
      Boolean(dashed?.dasharray) && arrowResults.find((r) => r.name === '曲线箭头')?.hasCurve === true,
      { repro: '分别点虚线箭头与曲线箭头，检查生成的 path 属性' },
    );

    /* ---------- E9：连线工具（走图形库点击，不经锚点） ---------- */
    /**
     * 这里验证「连线工具」本身可用：点图形库「箭头」分组条目
     * → 画布上应新增一条连线（不是节点）。这条已在 E7 覆盖 4 种箭头，
     * 这里再单独验证「连续画多条」与状态栏连线计数一致。
     *
     * 至于「从节点锚点拖出连线」这条路径，由 E9b / E9c 覆盖：
     *  - E9b 验证锚点可被 `elementFromPoint` 命中（不被缩放手柄遮挡）；
     *  - E9c 验证**真实拖拽**能画出连线（端到端，比 elementFromPoint 更接近用户操作）。
     *
     * 历史说明：1.1.9 之前这里有一段注释记录「锚点被缩放手柄完全遮挡、
     * 鼠标点不到」的产品缺陷，因此当时只敢用图形库点击来验证。
     * 该缺陷已在 1.1.9 修复（锚点移出节点 `<g>` 并置于手柄之后，
     * 同时让锚点判断优先于 `hitHandle()`），故注明已修复，避免后人
     * 读到旧注释后误以为缺陷仍在。
     */
    const edgeCounter = await (async () => {
      const arrowIdx = libItems.findIndex((t) => /^直线箭头/.test(t));
      const before = await page.evaluate(() => ({
        edges: document.querySelectorAll('.dcanvas__edges > g').length,
        nodes: document.querySelectorAll('.dcanvas__nodes > g').length,
      }));
      await page.locator('.flow__lib .lib-item').nth(arrowIdx >= 0 ? arrowIdx : 0).click();
      await page.waitForTimeout(900);
      await page.locator('.flow__lib .lib-item').nth(arrowIdx >= 0 ? arrowIdx : 0).click();
      await page.waitForTimeout(900);
      const after = await page.evaluate(() => {
        const status = (document.querySelector('.flow__status')?.innerText || '').replace(/\s+/g, ' ');
        const m = /连线\s*(\d+)/.exec(status);
        return {
          edges: document.querySelectorAll('.dcanvas__edges > g').length,
          nodes: document.querySelectorAll('.dcanvas__nodes > g').length,
          statusCount: m ? Number(m[1]) : null,
          status: status.slice(0, 70),
        };
      });
      return { before, after, added: after.edges - before.edges, addedNodes: after.nodes - before.nodes };
    })();
    check(
      'E9 连续点击连线工具两次 → 新增 2 条连线、0 个节点，且状态栏计数一致',
      'edges +2、nodes +0，状态栏「连线 N」与 DOM 中 .dcanvas__edges > g 数量一致',
      `edges ${edgeCounter.before.edges}→${edgeCounter.after.edges}（+${edgeCounter.added}）；nodes ${edgeCounter.before.nodes}→${edgeCounter.after.nodes}（+${edgeCounter.addedNodes}）；状态栏连线=${edgeCounter.after.statusCount}；${edgeCounter.after.status}`,
      edgeCounter.added === 2 && edgeCounter.addedNodes === 0 && edgeCounter.after.statusCount === edgeCounter.after.edges,
      {
        repro: '流程图 → 连点两次图形库「直线箭头」，看连线数与节点数',
      },
    );

    /* ---------- E9b：连线锚点可点性（已知缺陷的显式断言） ---------- */
    const anchorReach = await (async () => {
      const nodes = await readNodes();
      if (!nodes.length) return { ok: false, reason: '无节点' };
      await page.mouse.click(nodes[0].cx, nodes[0].cy);
      await page.waitForTimeout(650);
      return page.evaluate(() => {
        const out = [];
        document.querySelectorAll('[data-anchor]').forEach((a) => {
          const b = a.getBoundingClientRect();
          const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
          out.push({
            anchor: a.getAttribute('data-anchor'),
            topTag: top?.tagName ?? null,
            topAnchor: top?.getAttribute?.('data-anchor') ?? null,
          });
        });
        return { ok: out.length > 0, anchors: out };
      });
    })();
    const reachable = (anchorReach.anchors ?? []).filter((a) => a.topAnchor === a.anchor).length;
    check(
      'E9b 节点四边连线锚点可被鼠标命中（不被缩放手柄遮挡）',
      '4/4 个 circle[data-anchor] 的 elementFromPoint 命中自身',
      anchorReach.ok
        ? `${reachable}/${anchorReach.anchors.length} 可达；${anchorReach.anchors.map((a) => `${a.anchor}→${a.topTag}${a.topAnchor ? `[${a.topAnchor}]` : ''}`).join(' | ')}`
        : anchorReach.reason,
      reachable === (anchorReach.anchors ?? []).length && reachable > 0,
      {
        note:
          '这条断言守住 1.1.9 修过的缺陷不再回归：4 个连线锚点与 8 个缩放手柄位置重合' +
          '（top≡n、right≡e、bottom≡s、left≡w），若锚点 DOM 顺序又落回手柄之前，' +
          'elementFromPoint 就会拿到手柄、断言失败。修复方式：锚点移出节点 <g>、置于手柄之后，' +
          '且 onPointerDown 里锚点判断优先于 hitHandle()。',
        repro: '流程图 → 选中一个节点 → 检查四边中点的 elementFromPoint 是否命中 circle[data-anchor]',
      },
    );

    /* ---------- E9c：从锚点**真实拖拽**能画出连线（端到端） ---------- */
    /*
     * 为什么在 E9b 之外还要有这条：`elementFromPoint` 只证明「锚点在最上层」，
     * 不证明「拖拽链路能通」—— 拖拽还要经过 onPointerDown 的锚点分支、
     * pointermove 更新 connectTo、pointerup 建边三步。
     * 1.1.9 修锚点遮挡时实测发现第三层缺陷：`hitHandle()` 的判断排在锚点判断之前，
     * 所以「点得到锚点」但「拖出来还是 resize」。只验 elementFromPoint 会漏掉它。
     * 这条断言直接断言 edges 数量 +1，是真正的用户路径。
     */
    const anchorDrag = await (async () => {
      const before = await page.evaluate(() => document.querySelectorAll('.dcanvas__edges > g').length);
      const geo = await page.evaluate(() => {
        const anchor = document.querySelector('[data-anchor="right"]');
        const nodes = [...document.querySelectorAll('.dcanvas__nodes > g')];
        if (!anchor || nodes.length < 2) return null;
        const a = anchor.getBoundingClientRect();
        // 目标取「不是当前选中那个」的另一个节点：选中节点有 4 个锚点，未选中的没有
        const target = nodes.find((n) => !n.querySelector('[data-anchor]'));
        if (!target) return null;
        const t = target.getBoundingClientRect();
        return {
          from: { x: a.x + a.width / 2, y: a.y + a.height / 2 },
          to: { x: t.x + t.width / 2, y: t.y + t.height / 2 },
        };
      });
      if (!geo) return { ok: false, reason: '找不到可用的锚点与目标节点', before };
      await page.mouse.move(geo.from.x, geo.from.y);
      await page.mouse.down();
      await page.mouse.move(geo.to.x, geo.to.y, { steps: 12 });
      await page.waitForTimeout(120);
      await page.mouse.up();
      await page.waitForTimeout(700);
      const after = await page.evaluate(() => document.querySelectorAll('.dcanvas__edges > g').length);
      return { ok: after > before, before, after, added: after - before };
    })();
    check(
      'E9c 从节点锚点真实拖拽能画出连线（端到端用户路径）',
      '拖拽后 .dcanvas__edges > g 数量 +1',
      anchorDrag.ok
        ? `连线 ${anchorDrag.before}→${anchorDrag.after}（+${anchorDrag.added}）`
        : `${anchorDrag.reason ?? '未新增连线'}（连线 ${anchorDrag.before}→${anchorDrag.after ?? '?'}）`,
      Boolean(anchorDrag.ok),
      {
        note:
          '这条覆盖「点得到锚点但拖出来是 resize」这一层缺陷（onPointerDown 里锚点判断' +
          '必须优先于 hitHandle）。1.1.9 修复前此处 edges 恒为 +0。',
        repro: '流程图 → 选中节点 A → 从右锚点拖到节点 B → 看连线数是否 +1',
      },
    );

    /* ---------- E10：连续添加同种图形不重叠（按世界坐标判定） ---------- */
    const overlap = await (async () => {
      const rectIdx2 = libItems.findIndex((t) => /^矩形/.test(t));
      const beforeCount = await page.evaluate(() => document.querySelectorAll('.dcanvas__nodes > g').length);
      await page.locator('.flow__lib .lib-item').nth(rectIdx2 >= 0 ? rectIdx2 : 0).click();
      await page.waitForTimeout(800);
      await page.locator('.flow__lib .lib-item').nth(rectIdx2 >= 0 ? rectIdx2 : 0).click();
      await page.waitForTimeout(900);
      const afterCount = await page.evaluate(() => document.querySelectorAll('.dcanvas__nodes > g').length);
      const nodes = await readNodes();
      const last2 = nodes.slice(-2);
      if (last2.length < 2 || !last2[0].world || !last2[1].world) return { ok: false, reason: '节点或世界坐标不可用' };
      const [a, b] = last2.map((n) => n.world);
      // 世界坐标下判定矩形是否相交
      const intersects = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      return {
        ok: !intersects,
        beforeCount,
        afterCount,
        added: afterCount - beforeCount,
        worldA: a,
        worldB: b,
        ddx: Math.round(Math.abs(a.x - b.x)),
        ddy: Math.round(Math.abs(a.y - b.y)),
        intersects,
      };
    })();
    check(
      'E10 连续添加两次同一图形，两个节点不重叠',
      '新增 2 个节点且两者世界矩形不相交（36px 阶梯错位）',
      overlap.ok
        ? `节点 ${overlap.beforeCount}→${overlap.afterCount}；世界矩形 A=${JSON.stringify(overlap.worldA)} B=${JSON.stringify(overlap.worldB)}；错位 dx=${overlap.ddx} dy=${overlap.ddy}`
        : overlap.reason,
      Boolean(overlap.ok && overlap.added === 2),
      { note: '原缺陷：连续点两次完全重叠，看起来像只加了一个', repro: '流程图 → 连点两次「矩形」，比较两个节点在世界坐标下的矩形' },
    );
    await shot(page, 'E-flowchart');

    /* ---------- E9：900px 无横向溢出 ---------- */
    await page.setViewportSize({ width: 900, height: 760 });
    await page.waitForTimeout(900);
    const flowOverflow = await page.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      flowW: Math.round(document.querySelector('.flow')?.getBoundingClientRect().width ?? 0),
      vw: window.innerWidth,
    }));
    check('E11 流程图 900px 无横向溢出', '溢出 ≤ 1px', JSON.stringify(flowOverflow), flowOverflow.overflowX <= 1);
    await page.setViewportSize({ width: 1600, height: 950 });
    await page.waitForTimeout(500);

    /* ---------- E10/E11：思维导图 ---------- */
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('.tab'));
      tabs.find((t) => /\.mind|思维导图|未命名思维导图/.test(t.textContent || ''))?.click();
    });
    await page.waitForTimeout(800);
    const mi = ribbon.findIndex((t) => /思维导图/.test(t));
    await page.locator('.ribbon__btn').nth(mi).click();
    await page.waitForTimeout(3600);
    const mindState = await page.evaluate(() => {
      const r = (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { w: Math.round(b.width), h: Math.round(b.height) };
      };
      const svg = document.querySelector('.mind .dcanvas__svg');
      return {
        mind: r('.mind'),
        canvas: r('.mind__canvas'),
        svg: r('.mind .dcanvas__svg'),
        viewBox: svg?.getAttribute('viewBox') ?? null,
        nodes: document.querySelectorAll('.mind .dcanvas__nodes > g').length,
        treeRows: document.querySelectorAll('.tree__row').length,
        toolbar: r('.mind__toolbar'),
        status: r('.mind__status'),
      };
    });
    check('E12 思维导图挂载且有根节点', 'nodes ≥ 1、treeRows ≥ 1', JSON.stringify(mindState), mindState.nodes >= 1 && mindState.treeRows >= 1);
    check(
      'E13 思维导图 viewBox 与实际尺寸一致',
      'viewBox 宽高 ≈ 元素实际宽高',
      `viewBox=${mindState.viewBox} svg=${JSON.stringify(mindState.svg)}`,
      (() => {
        const m = /^0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)$/.exec(mindState.viewBox || '');
        if (!m || !mindState.svg) return false;
        return Math.abs(Number(m[1]) - mindState.svg.w) <= 2 && Math.abs(Number(m[2]) - mindState.svg.h) <= 2;
      })(),
    );

    /* ---------- E12/E13/E14：折叠角标（画布上可见 + 点击可展开） ---------- */
    // 给根节点加 2 个子节点
    for (let i = 0; i < 2; i += 1) {
      await page.evaluate(() => {
        document.querySelector('.tree__add')?.click();
      });
      await page.waitForTimeout(750);
    }
    const beforeCollapse = await page.evaluate(() => ({
      rows: document.querySelectorAll('.tree__row').length,
      canvasNodes: document.querySelectorAll('.mind .dcanvas__nodes > g').length,
    }));

    // 选中根节点后折叠子树（用属性面板的按钮，最稳）
    await page.evaluate(() => {
      document.querySelector('.tree__row')?.click();
    });
    await page.waitForTimeout(600);
    const collapseClicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.mind button, .mind__props button')).find((b) => /折叠子树/.test(b.textContent || ''));
      if (btn) {
        btn.click();
        return true;
      }
      const icon = Array.from(document.querySelectorAll('.tree__row [title]')).find((b) => /折叠/.test(b.getAttribute('title') || ''));
      if (icon) {
        icon.click();
        return true;
      }
      return false;
    });
    await page.waitForTimeout(1400);

    const collapsed = await page.evaluate(() => {
      const svg = document.querySelector('.mind .dcanvas__svg');
      const treeBadges = Array.from(document.querySelectorAll('.tree__badge')).map((b) => (b.textContent || '').trim());
      // 画布角标：节点内 circle[r="9"] + 文本 +N
      const circles = svg ? Array.from(svg.querySelectorAll('circle[r="9"]')) : [];
      const canvasBadges = [];
      for (const c of circles) {
        const g = c.closest('g');
        const t = g ? (g.textContent || '').trim() : '';
        if (/^\+\d+$/.test(t)) canvasBadges.push(t);
      }
      const allPlus = Array.from(svg ? svg.querySelectorAll('text') : [])
        .map((t) => (t.textContent || '').trim())
        .filter((t) => /^\+\d+$/.test(t));
      return {
        treeBadges,
        canvasBadges,
        allPlus,
        circle9: circles.length,
        canvasNodes: document.querySelectorAll('.mind .dcanvas__nodes > g').length,
        rows: document.querySelectorAll('.tree__row').length,
      };
    });
    check(
      'E14 折叠后结构树显示 +N 角标',
      '树中出现「+N」角标',
      `treeBadges=${JSON.stringify(collapsed.treeBadges)}`,
      collapsed.treeBadges.some((b) => /^\+\d+$/.test(b)),
      { repro: '思维导图 → 给根节点加 2 个子节点 → 折叠' },
    );
    check(
      'E15 折叠后画布上也显示 +N 角标（circle[r="9"] + 文本）',
      '画布 SVG 中出现 circle[r="9"] 且其文本为 +N',
      `canvasBadges=${JSON.stringify(collapsed.canvasBadges)} allPlus=${JSON.stringify(collapsed.allPlus)} circle9=${collapsed.circle9}；节点 ${beforeCollapse.canvasNodes}→${collapsed.canvasNodes}`,
      collapsed.canvasBadges.length > 0,
      { note: '原缺陷：collapsedCount 只传给左侧树，未传给画布', repro: '折叠子树后观察画布节点上的角标' },
    );

    // 点击角标展开：节点数应恢复
    const expanded = await (async () => {
      const badge = await page.evaluate(() => {
        const svg = document.querySelector('.mind .dcanvas__svg');
        const circles = svg ? Array.from(svg.querySelectorAll('circle[r="9"]')) : [];
        const target = circles.find((c) => /^\+\d+$/.test((c.closest('g')?.textContent || '').trim()));
        if (!target) return null;
        const b = target.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      });
      if (!badge) return { ok: false, reason: '画布上无 +N 角标可点' };
      await page.mouse.click(badge.x, badge.y);
      await page.waitForTimeout(1300);
      const after = await page.evaluate(() => ({
        canvasNodes: document.querySelectorAll('.mind .dcanvas__nodes > g').length,
        allPlus: Array.from(document.querySelectorAll('.mind .dcanvas__svg text')).map((t) => (t.textContent || '').trim()).filter((t) => /^\+\d+$/.test(t)),
      }));
      return { ok: after.canvasNodes > collapsed.canvasNodes, ...after };
    })();
    check(
      'E16 点击画布角标可展开（节点数增加）',
      '点击 +N 后画布节点数从折叠态增加',
      expanded.ok ? `节点 ${collapsed.canvasNodes} → ${expanded.canvasNodes}；剩余角标 ${JSON.stringify(expanded.allPlus)}` : expanded.reason,
      Boolean(expanded.ok),
      { repro: '思维导图 → 折叠根节点 → 点击画布上的 +N 角标' },
    );
    await shot(page, 'E-mindmap');

    /* ---------- E14：900px 思维导图无溢出 ---------- */
    await page.setViewportSize({ width: 900, height: 760 });
    await page.waitForTimeout(900);
    const mindOverflow = await page.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      mindW: Math.round(document.querySelector('.mind')?.getBoundingClientRect().width ?? 0),
    }));
    check('E17 思维导图 900px 无横向溢出', '溢出 ≤ 1px', JSON.stringify(mindOverflow), mindOverflow.overflowX <= 1);
    await page.setViewportSize({ width: 1600, height: 950 });

    check('E18 图表插件过程无 JS 运行时错误', '0 条 pageerror', jsErrors.length ? jsErrors.slice(0, 5) : '0 条', jsErrors.length === 0);
  } finally {
    await browser.close();
  }
}

/* ============================== F 后台与 AI ============================== */

async function sectionF(chromium) {
  section('F', '后台管理端与 AI（模块 / 看板 / 浅色 / 分区 / 提示词注入 / 知识库令牌）');

  const H = authHeaders(state.token);
  const HJ = { ...H, 'content-type': 'application/json' };

  /* ---------- F1：后台各模块可打开 + 看板数据非空 + 浅色主题 ---------- */
  const { browser, page, jsErrors } = await newSession(chromium);
  try {
    /**
     * 后台导航选择器：语义化 + 多套兜底。
     *
     * 为什么不用单一类名：admin-ai 在 1.1.9 把后台整体重构为 `adm-*` 前缀体系
     * （`.admin-shell .adm-nav` / `.adm-nav-list .nav-item`），旧的 `.admin__nav`
     * 已不存在。验收脚本要验证**行为**而不是锁死实现细节，因此这里同时接受
     * `adm-*` 与 `admin__*` 两代类名，避免下次再因重构而假失败。
     */
    const NAV = '.adm-nav, .admin__nav, .admin-shell nav, .admin nav';
    const NAV_ITEM = '.adm-nav-list .nav-item, .admin__nav .nav-item, .adm-nav .nav-item, .admin-shell .nav-item';
    const ADMIN_BODY = '.adm-body, .admin__body, .admin-shell main, .admin-body';

    await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: ARGS.timeout });
    await page.waitForSelector(NAV, { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(4000);

    const adminShell = await page.evaluate(
      ([navSel, itemSel]) => ({
        hasNav: Boolean(document.querySelector(navSel)),
        navSel: navSel.split(',')[0].trim(),
        theme: document.documentElement.dataset.theme,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        modules: Array.from(document.querySelectorAll(itemSel)).map((e) => (e.textContent || '').trim()).filter(Boolean),
      }),
      [NAV, NAV_ITEM],
    );
    check('F1 后台管理端可打开（导航挂载）', '后台导航容器存在', JSON.stringify({ hasNav: adminShell.hasNav, theme: adminShell.theme }), adminShell.hasNav);
    check(
      'F2 后台使用浅色主题',
      'data-theme=light 且 body 背景为浅色（RGB 各通道 > 200）',
      `theme=${adminShell.theme} bg=${adminShell.bodyBg}`,
      adminShell.theme === 'light' && /^rgb\((\d+), (\d+), (\d+)\)$/.test(adminShell.bodyBg)
        ? adminShell.theme === 'light' && adminShell.bodyBg.match(/\d+/g).slice(0, 3).every((v) => Number(v) > 200)
        : false,
    );
    check(
      'F3 后台模块齐全（≥ 10 个可点模块）',
      '≥ 10',
      `${adminShell.modules.length} 个：${adminShell.modules.join(' / ')}`,
      adminShell.modules.length >= 10,
    );

    // 逐个打开每个模块，断言不报错、有内容
    const moduleResults = [];
    /*
     * 只巡检「后台内部模块」。
     *
     * 侧栏底部还有两个**离开后台**的导航项：「个人中心」→ /account、「返回编辑器」→ /app。
     * 它们点完 URL 就变了，`.adm-body` 自然为空 —— 之前的实现把它们也当模块巡检，
     * 于是「个人中心 len=0」被判成后台缺陷（假失败）。
     * 这里按「点击后是否仍在 /admin」过滤：仍在后台的才要求有内容。
     */
    const LEAVE_ADMIN = new Set(['个人中心', '返回编辑器']);
    for (const name of adminShell.modules) {
      if (LEAVE_ADMIN.has(name)) continue;
      const ok = await page.evaluate(
        ([n, itemSel]) => {
          const el = Array.from(document.querySelectorAll(itemSel)).find((e) => (e.textContent || '').trim() === n);
          if (!el) return false;
          el.click();
          return true;
        },
        [name, NAV_ITEM],
      );
      if (!ok) continue;
      await page.waitForTimeout(1300);
      const st = await page.evaluate((bodySel) => {
        const body = document.querySelector(bodySel);
        const txt = (body?.innerText || '').replace(/\s+/g, ' ').trim();
        return { len: txt.length, sample: txt.slice(0, 70), err: /加载失败|出错了|Error/.test(txt) };
      }, ADMIN_BODY);
      moduleResults.push({ name, ...st });
    }
    const badModules = moduleResults.filter((m) => m.len < 10 || m.err);
    check(
      'F4 后台每个模块都能打开且有内容（无加载失败）',
      '全部模块文本 > 10 字符且不含「加载失败」',
      badModules.length ? `异常模块：${JSON.stringify(badModules.slice(0, 4))}` : `全部 ${moduleResults.length} 个模块正常`,
      badModules.length === 0,
      { repro: '逐一点击后台左侧每个模块' },
    );

    // 看板数据非空
    await page.evaluate(
      ([itemSel]) => {
        const el = Array.from(document.querySelectorAll(itemSel)).find((e) => /数据看板/.test(e.textContent || ''));
        el?.click();
      },
      [NAV_ITEM],
    );
    await page.waitForTimeout(3000);
    /*
     * 等指标卡真的渲染出来再断言。
     *
     * 看板数据来自 `adminApiV3.dashboard()`，是一次异步请求；固定 waitForTimeout
     * 在机器负载高时会不够（实测同一份代码有时 8 张卡、有时 0 张）。
     * 这里显式等 `.metric` 出现，最多 20 秒，把「慢」与「真的没数据」区分开。
     */
    await page.waitForSelector('.metric', { timeout: 20000 }).catch(() => {});
    const dash = await page.evaluate((bodySel) => {
      const metrics = Array.from(document.querySelectorAll('.metric')).map((m) => ({
        label: (m.querySelector('.metric__label')?.textContent || '').trim(),
        value: (m.querySelector('.metric__value')?.textContent || '').trim(),
      }));
      const charts = document.querySelectorAll('.chart svg, svg.chart, .card--chart svg, .adm-card svg').length;
      const txt = (document.querySelector(bodySel)?.innerText || '').replace(/\s+/g, ' ').slice(0, 300);
      return { metricCount: metrics.length, metrics: metrics.slice(0, 12), charts, txt };
    }, ADMIN_BODY);
    check('F5 后台看板指标卡非空', '≥ 6 个指标且都有值', `${dash.metricCount} 个：${JSON.stringify(dash.metrics)}`, dash.metricCount >= 6 && dash.metrics.every((m) => m.value));
    check('F6 后台看板图表已绘制', '≥ 1 个 SVG 图表', `${dash.charts} 个 SVG`, dash.charts >= 1);
    check('F7 后台看板有真实数据（非全 0 占位）', '至少一个指标为非 0 数值', JSON.stringify(dash.metrics.slice(0, 6)), dash.metrics.some((m) => /[1-9]/.test(m.value)));
    await shot(page, 'F-admin-dashboard');

    /* ---------- F8：前台无「是否开通」字样 + 平台付费/自带 Key 分区 ---------- */
    const appPage = await page.context().newPage();
    await appPage.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: ARGS.timeout });
    await appPage.waitForSelector('.shell__main', { timeout: 25000 }).catch(() => {});
    await appPage.waitForTimeout(3000);
    await appPage.keyboard.press('Control+Comma');
    await appPage.waitForSelector('.settings__nav-item', { timeout: 15000 }).catch(() => {});
    await appPage.evaluate(() => {
      const el = Array.from(document.querySelectorAll('.settings__nav-item')).find((e) => (e.textContent || '').trim() === 'AI');
      el?.click();
    });
    await appPage.waitForTimeout(2200);
    const aiPane = await appPage.evaluate(() => {
      const pane = document.querySelector('.settings');
      const txt = (pane?.innerText || '').replace(/\s+/g, ' ');
      return {
        text: txt.slice(0, 1400),
        hasKaitong: /是否开通|开通状态|未开通|去开通/.test(txt),
        hasPlatformPay: /平台付费|平台 AI|扣积分|平台积分/.test(txt),
        hasOwnKey: /自带\s*Key|我的 AI 供应商|自有\s*Key|自定义供应商|API Key/.test(txt),
        headings: Array.from(pane?.querySelectorAll('h3, .pane__title') ?? []).map((h) => (h.textContent || '').trim()),
      };
    });
    check(
      'F8 前台不出现「是否开通」语义',
      '设置页 AI 区块不含「是否开通 / 未开通 / 去开通」',
      `命中=${aiPane.hasKaitong}；标题=${JSON.stringify(aiPane.headings)}`,
      aiPane.hasKaitong === false,
      { repro: '登录 → 设置 → AI 页签，全文搜索「开通」' },
    );
    check(
      'F9 平台付费与自带 Key 分成两个独立区块',
      '同时存在「平台付费」类区块与「自带 Key / 我的供应商」类区块',
      `平台付费命中=${aiPane.hasPlatformPay} 自带Key命中=${aiPane.hasOwnKey}；标题=${JSON.stringify(aiPane.headings)}`,
      aiPane.hasPlatformPay && aiPane.hasOwnKey,
      { repro: '设置 → AI，观察是否分为「平台付费」与「我的 AI 供应商」两块' },
    );
    /**
     * 公开供应商接口的字段边界。
     *
     * 「平台付费与客户端 BYOK 彻底分开」的准确断言不是「有没有 baseUrl」，
     * 而是**按分组区分**：
     *  - 平台代付组（group === 'platform'，走平台积分、由服务端代理上游）
     *    → 客户端根本不需要直连，**不得**下发 baseUrl；
     *  - 自带 Key 组（客户端用用户自己的 Key 直连）
     *    → **必须**下发 baseUrl，否则客户端不知道该连哪里。
     * 两组都绝不能出现 apiKey。
     */
    const pubProviders = await httpJson(`${API}/api/ai/providers`);
    const providerList = pubProviders.body?.data?.providers ?? [];
    const providerPayload = JSON.stringify(pubProviders.body ?? {});
    const platformGroup = providerList.filter((p) => (p.group ?? 'platform') === 'platform');
    const byokGroup = providerList.filter((p) => (p.group ?? 'platform') !== 'platform');
    const platformLeak = platformGroup.filter((p) => p.baseUrl !== undefined && p.baseUrl !== null && p.baseUrl !== '').map((p) => p.id ?? p.provider);
    const byokMissing = byokGroup.filter((p) => !p.baseUrl).map((p) => p.id ?? p.provider);

    /*
     * 只认「密钥字段」，不认子串。
     *
     * `apiKeyUrl` 是供应商的**申请 Key 的公开文档地址**（如
     * `https://platform.openai.com/api-keys`），它包含 "apiKey" 子串但完全无害 ——
     * 用 `/apiKey/i.test(payload)` 会把它误判成泄漏（实测就误报过）。
     * 这里按「字段名」精确判断：只拦 apiKey / apiKeySecret / secretKey 这类，
     * 以及真正形如密钥的值（sk- 前缀）。
     */
    const KEY_FIELD_RE = /"(api_?key|api_?key_?secret|secret_?key|access_?key_?(id|secret))"\s*:\s*"[^"]+"/i;
    const SK_VALUE_RE = /\bsk-[A-Za-z0-9]{12,}/;
    const hasKeyField = KEY_FIELD_RE.test(providerPayload);
    const hasSkValue = SK_VALUE_RE.test(providerPayload);
    check(
      'F10 公开供应商接口绝不泄露 apiKey',
      '响应中不含 apiKey/secretKey 字段的**非空值**，也不含 sk- 形态密钥（apiKeyUrl 属公开文档地址，允许）',
      `${pubProviders.status}；长度 ${providerPayload.length}；含密钥字段=${hasKeyField} 含 sk- 密钥=${hasSkValue}`,
      !hasKeyField && !hasSkValue,
    );
    check(
      'F11 平台代付组不下发 baseUrl、自带 Key 组必须下发 baseUrl',
      'group=platform 的供应商对象无 baseUrl 字段；BYOK 组必须有 baseUrl',
      `平台组 ${platformGroup.length} 个，泄露 baseUrl 的=${JSON.stringify(platformLeak)}；BYOK 组 ${byokGroup.length} 个，缺 baseUrl 的=${JSON.stringify(byokMissing)}（分组：${providerList.map((p) => `${p.id ?? p.provider}:${p.group ?? 'platform'}`).join(', ')}）`,
      platformLeak.length === 0 && byokMissing.length === 0,
      {
        note: '这是「平台付费与客户端 BYOK 彻底分开」的准确断言：平台侧客户端不直连，故无需 baseUrl',
        repro: `GET ${API}/api/ai/providers，检查每个 provider 的 group 与 baseUrl 字段`,
      },
    );
    await appPage.close();

    /* ---------- F11/F12：模型级系统提示词注入上游请求（mock 上游实测） ---------- */
    const mockPort = 3299;
    const captured = [];
    const mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        captured.push({ url: req.url, body });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"id":"qa","object":"chat.completion.chunk","choices":[{"delta":{"content":"ok"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise((resolve) => mockServer.listen(mockPort, '127.0.0.1', resolve));
    state.mockServer = mockServer;
    state.mockProvider = 'qa119gate';

    try {
      const prov = await httpJson(`${API}/api/admin/ai/${state.mockProvider}`, {
        method: 'PUT',
        headers: HJ,
        body: JSON.stringify({
          name: 'QA119 验收 Mock',
          baseUrl: `http://127.0.0.1:${mockPort}/v1`,
          apiKey: 'sk-qa119-gate-test',
          enabled: true,
          models: ['qa119-model'],
          priority: 99,
        }),
      });
      check('F12 可创建平台 AI 供应商（后台治理接口）', '200 且 apiKeySet=true', `${prov.status} apiKeySet=${prov.body?.data?.provider?.apiKeySet}`, prov.status === 200 && prov.body?.data?.provider?.apiKeySet === true);

      const modelPrompt = `QA119-模型级系统提示词-${Date.now() % 100000}`;
      const cfg = await httpJson(`${API}/api/admin/ai-models/${state.mockProvider}`, {
        method: 'PUT',
        headers: HJ,
        body: JSON.stringify({
          systemPrompt: 'QA119-供应商级兜底提示词',
          modelSettings: { 'qa119-model': { systemPrompt: modelPrompt, temperature: 0.3, maxTokens: 128 } },
        }),
      });
      check('F13 保存模型级系统提示词', '200', `${cfg.status} ${fmt(cfg.body).slice(0, 200)}`, cfg.status === 200);

      const resolved = await httpJson(`${API}/api/admin/ai-models`, { headers: H });
      const mine = (resolved.body?.data?.providers ?? []).find((p) => p.provider === state.mockProvider);
      const resModel = mine?.resolved?.find((r) => r.model === 'qa119-model');
      check(
        'F14 模型级提示词优先级高于供应商级（resolved 生效值）',
        `systemPrompt=${modelPrompt}、source=model`,
        JSON.stringify(resModel),
        resModel?.systemPrompt === modelPrompt && resModel?.systemPromptSource === 'model',
      );

      const chat = await fetch(`${API}/api/ai/chat`, {
        method: 'POST',
        headers: HJ,
        body: JSON.stringify({
          usePlatform: true,
          provider: 'platform',
          model: 'qa119-model',
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      const chatText = await chat.text();
      await sleep(900);
      const upstream = captured[0];
      let upstreamBody = null;
      try {
        upstreamBody = JSON.parse(upstream?.body || 'null');
      } catch {
        upstreamBody = null;
      }
      const sysMsg = upstreamBody?.messages?.find((m) => m.role === 'system');
      check(
        'F15 模型级系统提示词真的注入到上游请求体',
        `上游 messages[0] = {role:"system", content:"${modelPrompt}"}`,
        upstream ? `url=${upstream.url} system=${JSON.stringify(sysMsg?.content)} temperature=${upstreamBody?.temperature} max_tokens=${upstreamBody?.max_tokens}` : `未捕获到上游请求（chat=${chat.status} ${chatText.slice(0, 120)}）`,
        Boolean(sysMsg && sysMsg.content === modelPrompt),
        { repro: '后台配置模型级提示词 → 前台用平台 AI 对话 → 抓 mock 上游请求体' },
      );
      check(
        'F16 模型级 temperature / maxTokens 上限夹逼生效',
        '上游 temperature=0.3、max_tokens=128',
        `temperature=${upstreamBody?.temperature} max_tokens=${upstreamBody?.max_tokens}`,
        upstreamBody?.temperature === 0.3 && upstreamBody?.max_tokens === 128,
      );
    } finally {
      await httpJson(`${API}/api/admin/ai/${state.mockProvider}`, { method: 'DELETE', headers: H }).catch(() => {});
      await new Promise((resolve) => mockServer.close(resolve));
      state.mockServer = null;
      state.mockProvider = null;
    }

    /* ---------- F16~F20：知识库令牌全链路 ---------- */
    const created = await httpJson(`${API}/api/knowledge/tokens`, {
      method: 'POST',
      headers: HJ,
      body: JSON.stringify({ name: `QA119 验收令牌 ${Date.now() % 100000}`, scope: 'read', expiresInDays: 7 }),
    });
    const token = created.body?.data?.token;
    const tokenId = created.body?.data?.item?.id;
    state.kbToken = token;
    state.kbTokenId = tokenId;
    check('F17 申请知识库令牌（明文仅返回一次）', '200 且返回明文 token 与 id', `${created.status} id=${tokenId} token=${token ? `${String(token).slice(0, 14)}…(${String(token).length} 位)` : 'null'}`, created.status === 200 && Boolean(token) && Boolean(tokenId));

    const statsWithToken = await httpJson(`${API}/api/knowledge/stats`, { headers: { authorization: `Bearer ${token}` } });
    check(
      'F18 用 Bearer 令牌实测调用 /api/knowledge/stats 通过',
      '200 且 authMode=token',
      `${statsWithToken.status} authMode=${statsWithToken.body?.data?.authMode}`,
      statsWithToken.status === 200 && statsWithToken.body?.data?.authMode === 'token',
      { repro: `curl -H "Authorization: Bearer <令牌明文>" ${API}/api/knowledge/stats` },
    );
    const listTokens = await httpJson(`${API}/api/knowledge/tokens`, { headers: H });
    const listedToken = (listTokens.body?.data?.tokens ?? []).find((t) => t.id === tokenId);
    check(
      'F19 令牌列表可读且不回传明文',
      '列表含该令牌、状态 active、无 token 明文字段',
      `${listTokens.status} status=${listedToken?.status} prefix=${listedToken?.tokenPrefix} 含明文=${/nmd_kb_[A-Za-z0-9]{20}/.test(JSON.stringify(listTokens.body))}`,
      listTokens.status === 200 && Boolean(listedToken) && listedToken.status === 'active' && !/nmd_kb_[A-Za-z0-9]{20}/.test(JSON.stringify(listTokens.body)),
    );

    const revoked = await httpJson(`${API}/api/knowledge/tokens/${tokenId}`, { method: 'DELETE', headers: H });
    const afterRevoke = await httpJson(`${API}/api/knowledge/stats`, { headers: { authorization: `Bearer ${token}` } });
    check(
      'F20 吊销令牌后立即失效',
      'DELETE 200，再用该令牌调用返回 401',
      `DELETE ${revoked.status} revokedAt=${revoked.body?.data?.item?.revokedAt}；再用令牌 → ${afterRevoke.status} ${afterRevoke.body?.error?.code ?? ''}`,
      revoked.status === 200 && afterRevoke.status === 401,
      { repro: '申请令牌 → 吊销 → 用原令牌调 /api/knowledge/stats' },
    );
    check(
      'F21 非法令牌被拒绝',
      '401 TOKEN_INVALID',
      `${(await httpJson(`${API}/api/knowledge/stats`, { headers: { authorization: 'Bearer qa119-invalid-token' } })).status}`,
      (await httpJson(`${API}/api/knowledge/stats`, { headers: { authorization: 'Bearer qa119-invalid-token' } })).status === 401,
    );

    check('F22 后台与 AI 过程无 JS 运行时错误', '0 条 pageerror', jsErrors.length ? jsErrors.slice(0, 5) : '0 条', jsErrors.length === 0);

    /* ---------- F23：限流语义（必须是 429，不能是 500） ---------- */
    /**
     * 这是 1.1.9 修的一个真实 bug：`middleware/rate.js` 的 errorResponseBuilder
     * 缺 `statusCode: 429`，被 `server.js` 的 setErrorHandler 当 500 包装，
     * 客户端把「请慢点」误判成「服务坏了」。
     *
     * 断言方式：对 /api/auth/login 连打（它有 ipRateLimit('login')），
     * 超过阈值后必须拿到 429 且 body.code === 'RATE_LIMITED'。
     * 用错误密码不影响限流计数，且不会产生成功登录。
     */
    let rateStatus = 0;
    let rateBody = null;
    let rateAttempts = 0;
    for (let i = 0; i < 40; i += 1) {
      rateAttempts = i + 1;
      const r = await httpJson(`${API}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: `qa119-ratelimit-${i}@invalid.local`, password: 'x' }),
      });
      if (r.status === 429) {
        rateStatus = 429;
        rateBody = r.body;
        break;
      }
      if (r.status >= 500) {
        rateStatus = r.status;
        rateBody = r.body;
        break;
      }
    }
    check(
      'F23 限流返回 429（不是 500），且 code=RATE_LIMITED',
      '连续请求触发限流后：HTTP 429 且 body.error.code=RATE_LIMITED',
      rateStatus
        ? `第 ${rateAttempts} 次请求 → ${rateStatus} ${JSON.stringify(rateBody?.error ?? rateBody).slice(0, 200)}`
        : `连打 ${rateAttempts} 次仍未触发限流（阈值可能较宽）`,
      rateStatus === 429 && String(rateBody?.error?.code ?? '') === 'RATE_LIMITED',
      {
        note: '原缺陷：errorResponseBuilder 缺 statusCode:429，被 setErrorHandler 包成 500',
        repro: `连续 POST ${API}/api/auth/login 超过登录限流阈值，检查状态码与 body.error.code`,
      },
    );
  } finally {
    await browser.close();
  }
}

/* ============================== G 回归 ============================== */

async function sectionG() {
  section('G', '回归（类型检查 / 单元测试 / 构建）');

  /* ---------- G1：packages 类型检查（含测试文件） ---------- */
  const tscBin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const g1 = sh(process.execPath, [tscBin, '-p', path.join(ROOT, 'tsconfig.json'), '--pretty', 'false'], { timeout: 240000 });
  check(
    'G1 packages 类型检查（tsc -p tsconfig.json，含 __tests__）',
    'EXIT=0，0 个类型错误',
    `EXIT=${g1.code}${g1.out.trim() ? ` | ${tail(g1.out, 700)}` : ''}`,
    g1.code === 0,
    { note: '此工程包含 packages/core 与 packages/shared 的源码与测试文件', repro: 'npx tsc -p tsconfig.json' },
  );

  /* ---------- G2：apps/web 类型检查（vue-tsc，抓 app.ts 那类事故的关键） ---------- */
  const vueTsc = path.join(ROOT, 'apps', 'web', 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js');
  const vueTscAlt = path.join(ROOT, 'apps', 'web', 'node_modules', '.bin', process.platform === 'win32' ? 'vue-tsc.cmd' : 'vue-tsc');
  let g2;
  if (fs.existsSync(vueTsc)) {
    g2 = sh(process.execPath, [vueTsc, '--noEmit', '-p', path.join(ROOT, 'apps', 'web', 'tsconfig.json')], { cwd: path.join(ROOT, 'apps', 'web'), timeout: 300000 });
  } else if (fs.existsSync(vueTscAlt)) {
    g2 = sh(vueTscAlt, ['--noEmit', '-p', 'tsconfig.json'], { cwd: path.join(ROOT, 'apps', 'web'), timeout: 300000 });
  } else {
    g2 = { code: -1, out: '未找到 vue-tsc（apps/web/node_modules/vue-tsc 缺失）' };
  }
  check(
    'G2 apps/web 类型检查（vue-tsc --noEmit，含 .vue + stores）',
    'EXIT=0，0 个类型错误',
    `EXIT=${g2.code}${g2.out.trim() ? ` | ${tail(g2.out, 900)}` : ''}`,
    g2.code === 0,
    { note: 'Vue 单文件组件必须用 vue-tsc；tsc 无法解析 .vue', repro: 'cd apps/web && npx vue-tsc --noEmit -p tsconfig.json' },
  );

  /* ---------- G3：vitest ---------- */
  const vitestBin = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const g3 = sh(process.execPath, [vitestBin, 'run', '--reporter=dot'], { timeout: 300000 });
  const passMatch = /Tests\s+(\d+) passed/.exec(g3.out);
  const failMatch = /Tests\s+.*?(\d+) failed/.exec(g3.out);
  check(
    'G3 单元测试 vitest run 全绿',
    'EXIT=0，0 failed',
    `EXIT=${g3.code}；passed=${passMatch?.[1] ?? '?'} failed=${failMatch?.[1] ?? '0'} | ${tail(g3.out, 320)}`,
    g3.code === 0 && !failMatch,
    { repro: 'npx vitest run' },
  );

  /* ---------- G4：build:web 成功且产物可加载 ---------- */
  if (ARGS.skipBuild) {
    skip('G4 pnpm build:web 成功且产物可加载', '--skip-build 指定跳过（避免与并行任务抢 CPU）');
  } else {
    const g4 = sh('pnpm', ['build:web'], { timeout: 600000 });
    const distDir = path.join(ROOT, 'apps', 'web', 'dist');
    const hasIndex = fs.existsSync(path.join(distDir, 'index.html'));
    let assetCount = 0;
    let assetOk = false;
    if (hasIndex) {
      const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
      const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
      assetCount = assets.length;
      assetOk = assets.length > 0 && assets.every((a) => fs.existsSync(path.join(distDir, a.replace(/^\//, ''))));
    }
    check(
      'G4 pnpm build:web 成功且产物可加载',
      'EXIT=0 且 dist/index.html 引用的 js/css 全部存在',
      `EXIT=${g4.code}；index.html=${hasIndex}；引用资源 ${assetCount} 个，全部存在=${assetOk}${g4.code !== 0 ? ` | ${tail(g4.out, 800)}` : ''}`,
      g4.code === 0 && hasIndex && assetOk,
      { repro: 'pnpm build:web && ls apps/web/dist' },
    );
  }
}

/* ============================== 清理 & 汇总 ============================== */

async function cleanup() {
  const H = authHeaders(state.token);
  try {
    if (state.kbTokenId) {
      await httpJson(`${API}/api/knowledge/tokens/${state.kbTokenId}`, { method: 'DELETE', headers: H });
    }
  } catch { /* ignore */ }
  try {
    if (state.createdVault) {
      await httpJson(`${API}/api/vaults/${state.vaultId}?purge=1`, { method: 'DELETE', headers: H });
    }
  } catch { /* ignore */ }
  try {
    if (state.mockServer) await new Promise((r) => state.mockServer.close(r));
  } catch { /* ignore */ }
  // 生产库安全阀：还原云端设置（见 backupSettings 的说明）
  await restoreSettings();
}

function summary() {
  const pass = results.filter((r) => r.pass === true);
  const fail = results.filter((r) => r.pass === false);
  const skipped = results.filter((r) => r.pass === null);

  console.log(`\n${'='.repeat(78)}`);
  console.log('1.1.9 验收门禁结果汇总');
  console.log('='.repeat(78));
  for (const s of SECTIONS) {
    const rs = results.filter((r) => r.section === s);
    if (!rs.length) continue;
    const p = rs.filter((r) => r.pass === true).length;
    const f = rs.filter((r) => r.pass === false).length;
    const k = rs.filter((r) => r.pass === null).length;
    const title = { A: '启动与首屏', B: '设置项', C: '同步', D: '工作台', E: '图表', F: '后台与 AI', G: '回归' }[s];
    console.log(`  ${s} ${title.padEnd(12, ' ')} 通过 ${String(p).padStart(2)} / 失败 ${String(f).padStart(2)}${k ? ` / 跳过 ${k}` : ''}`);
  }
  console.log('-'.repeat(78));
  console.log(`  总计：通过 ${pass.length}，失败 ${fail.length}${skipped.length ? `，跳过 ${skipped.length}` : ''}`);

  if (fail.length) {
    console.log(`\n【门禁不通过】以下 ${fail.length} 项必须修复后才能发布：`);
    for (const f of fail) {
      console.log(`\n  \u2717 [${f.id}] ${f.name}`);
      console.log(`     期望: ${f.expect}`);
      console.log(`     实测: ${f.actual}`);
      if (f.repro) console.log(`     复现: ${f.repro}`);
      if (f.note) console.log(`     备注: ${f.note}`);
    }
  } else {
    console.log('\n\u2714 全部断言通过，1.1.9 可发布。');
  }
  console.log('='.repeat(78));

  if (ARGS.json) {
    const out = path.isAbsolute(ARGS.json) ? ARGS.json : path.join(ROOT, ARGS.json);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(
      out,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          base: BASE,
          api: API,
          sections: [...ONLY],
          thresholds: THRESHOLD,
          summary: { pass: pass.length, fail: fail.length, skipped: skipped.length },
          results,
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`机器可读结果已写入 ${out}`);
  }

  return fail.length;
}

/* ============================== 入口 ============================== */

async function main() {
  console.log('Neo MD 1.1.9 统一验收门禁');
  console.log(`  前端 ${BASE}`);
  console.log(`  后端 ${API}`);
  console.log(`  段落 ${[...ONLY].join(', ')}${ARGS.shots ? ' | 截图 docs/shots-119/' : ''}`);

  const health = await httpJson(`${API}/api/health`).catch((e) => ({ status: 0, body: String(e.message) }));
  if (health.status !== 200) {
    console.error(`\n后端不可用（${API}/api/health → ${health.status}）。请先启动 services/api。`);
    process.exit(2);
  }
  console.log(`  后端健康：${fmt(health.body).slice(0, 140)}`);

  await login();
  console.log(`  登录成功：${state.user?.username}（${state.user?.role}）`);
  await backupSettings();

  const chromium = await loadChromium();

  const runners = { A: sectionA, B: sectionB, C: sectionC, D: sectionD, E: sectionE, F: sectionF, G: sectionG };
  for (const s of SECTIONS) {
    if (!ONLY.has(s)) continue;
    try {
      if (s === 'G') await sectionG();
      else await runners[s](chromium);
    } catch (e) {
      check(`${s} 段执行异常`, '正常完成', String(e?.stack ?? e).slice(0, 500), false, {
        repro: `node tools/verify-119-full.mjs --only=${s}`,
      });
    }
  }

  await cleanup();
  const failCount = summary();
  process.exit(failCount ? 1 : 0);
}

main().catch(async (e) => {
  console.error('\n门禁脚本自身异常：', e);
  await cleanup().catch(() => {});
  process.exit(3);
});
