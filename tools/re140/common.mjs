/**
 * Neo MD 1.4 门禁 —— 共享基础设施
 * =============================================================================
 * 本目录是 `tools/verify-140.mjs` 的实现拆分：
 *   common.mjs  参数 / 阈值 / 断言框 / 登录 / 会话 / store / 云 API / 清理
 *   a.mjs       A 插件（需求1/6/17）
 *   b.mjs       B 后台（需求2/3/4/5）
 *   c.mjs       C 布局（需求7/8）
 *   d.mjs       D 设置与主题（需求11~16）
 *   e.mjs       E 数据（需求9/10）
 *   n.mjs       N 负向对照（证明断言非恒真）
 *   g.mjs       G 回归（含 1.3.1 门禁 verify-121 必须仍全绿）
 *
 * 工程范式沿用 tools/verify-121.mjs（1.3.1 门禁），并针对本版新增两条硬要求：
 *
 *  1. **必须 `--disable-gpu`**：本机无头 Chrome 用默认参数约 30s 崩（连空白页都崩），
 *     故所有 launch 都带 `--disable-gpu`。长等待（≥30s）一律走 {@link waitResilient}
 *     分段轮询 + 断线重连，避免「Chrome 崩了 → 断言假失败」。
 *  2. **绝不为了全绿放宽断言**：阈值都写在 THRESHOLD 里并注明依据；
 *     负向对照（N 段）负责证明断言不是恒真的。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');

/* ============================== CLI 参数 ============================== */

export function parseArgs(argv) {
  const out = {
    only: null,
    base: null,
    api: null,
    shots: false,
    json: null,
    verbose: false,
    timeout: 60000,
    withRegression: false,
    negativeControl: false,
    keep: false,
    /** 长等待总时长（毫秒）；默认 40s，可用 --hold-ms 覆盖以便快速冒烟 */
    holdMs: 40_000,
  };
  for (const raw of argv) {
    const a = String(raw);
    if (a === '--shots') out.shots = true;
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--with-regression') out.withRegression = true;
    else if (a === '--negative-control' || a === '--with-negative') out.negativeControl = true;
    else if (a === '--keep') out.keep = true;
    else if (a.startsWith('--only=')) {
      out.only = a
        .slice(7)
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    } else if (a.startsWith('--base=')) out.base = a.slice(7).replace(/\/+$/, '');
    else if (a.startsWith('--api=')) out.api = a.slice(6).replace(/\/+$/, '');
    else if (a.startsWith('--json=')) out.json = a.slice(7);
    else if (a.startsWith('--timeout=')) out.timeout = Number(a.slice(10)) || out.timeout;
    else if (a.startsWith('--hold-ms=')) out.holdMs = Number(a.slice(10)) || out.holdMs;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

export const ARGS = parseArgs(process.argv.slice(2));
export const BASE = ARGS.base || process.env.SMOKE_BASE || 'http://127.0.0.1:5178';
export const API = ARGS.api || process.env.SMOKE_API || 'http://127.0.0.1:3200';
export const SHOT_DIR = path.join(ROOT, 'docs', 'shots-140');

export const DEFAULT_SECTIONS = ['A', 'B', 'C', 'D', 'E'];
export const ALL_SECTIONS = ['A', 'B', 'C', 'D', 'E', 'N', 'G', 'P'];
export const ONLY = ARGS.only && ARGS.only.length ? new Set(ARGS.only) : new Set(DEFAULT_SECTIONS);

/* ============================== 阈值与依据 ============================== */

/**
 * 所有阈值都注明「依据」，改动前先看依据是否仍成立。
 *
 * | 项 | 依据 | 阈值 |
 * |----|------|------|
 * | 分屏拖动偏差 | 需求7 明确要求「鼠标与分隔条偏差 < 3px」 | < 3px |
 * | 右侧栏上限 | 需求8 明确「最多 3 个」 | === 3 |
 * | 分割线对比度 | 需求11「对比度 ≥ 1.2:1」 | >= 1.2 |
 * | 设置项无效数 | 需求14「确保都有效果」 | === 0 |
 * | 插件市场每页 | 需求3「每页 20 个」 | === 20 |
 * | 内置插件数 | packages/shared/src/plugins.ts 现有清单 | 26 款（动态读取） |
 * | 浏览器内验证内置插件 | 任务书「独立验证至少 10 款」 | >= 10 |
 */
export const THRESHOLD = {
  /** 分屏拖动：鼠标位置与分隔条实际位置的偏差上限（px） */
  splitDeviationPx: 3,
  /** 分屏拖动测试位置（百分比） */
  splitProbes: [30, 50, 70],
  /** 右侧栏同时打开上限 */
  rightStackMax: 3,
  /** 分割线相对背景的最低对比度 */
  borderContrastMin: 1.2,
  /** 颜色通道容忍（主题作用域/颜色细化比对） */
  colorTolerance: 3,
  /** 插件市场每页条数 */
  pluginPageSize: 20,
  /** 浏览器内独立验证的内置插件数量下限 */
  builtinPluginBrowserMin: 10,
  /** 设置项审计：零无效项 */
  settingsAuditInvalidMax: 0,
  /** admin 仓库数量合理上限（含真实仓库，测试残留不应推高） */
  vaultCountMax: 8,
};

/* ============================== 断言框架 ============================== */

export const results = [];
let currentSection = '-';

export function section(id, title) {
  currentSection = id;
  console.log(`\n${'='.repeat(78)}\n[${id}] ${title}\n${'='.repeat(78)}`);
}

export function check(name, expect, actual, pass, meta = {}) {
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

export function fmt(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return v;
  try {
    const s = JSON.stringify(v);
    return s.length > 460 ? `${s.slice(0, 460)}...` : s;
  } catch {
    return String(v);
  }
}

export function skip(name, reason) {
  const id = `${currentSection}${String(results.filter((r) => r.section === currentSection).length + 1).padStart(2, '0')}`;
  results.push({ id, section: currentSection, name, expect: '-', actual: `跳过：${reason}`, pass: null, repro: '', note: '' });
  console.log(`  \u2298 [${id}] ${name}\n        跳过: ${reason}`);
}

/* ============================== 通用工具 ============================== */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const round2 = (n) => Math.round(Number(n) * 100) / 100;
export const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * 长等待的「分段可恢复」实现。
 *
 * 为什么不能一次 `waitForTimeout(40000)`：本机无头 Chrome 会崩（即使加了
 * --disable-gpu），一旦崩掉后续 evaluate 全抛 target closed，断言就假失败。
 * 这里分段（默认 2s/段）轮询，每段尝试一次轻量探活；连续多次失败就明确报
 * 「浏览器实例失联」，把它和环境故障区分开。
 */
export async function waitResilient(page, totalMs, opts = {}) {
  const step = opts.step || 2000;
  const onTick = opts.onTick;
  const deadline = Date.now() + totalMs;
  let alive = 0;
  let dead = 0;
  while (Date.now() < deadline) {
    await sleep(Math.min(step, Math.max(0, deadline - Date.now())));
    try {
      await page.evaluate(() => 1);
      alive += 1;
      dead = 0;
      if (onTick) await onTick();
    } catch {
      dead += 1;
      if (dead >= 5) {
        throw new Error(`浏览器实例在等待期失联（连续 ${dead} 次探活失败），非断言失败，请检查无头 Chrome 是否崩溃`);
      }
    }
  }
  return { alive, dead };
}

export async function httpJson(url, init = {}) {
  try {
    noteSelfWrite(init.method || 'GET', url);
  } catch {
    /* ignore */
  }
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

export function authHeaders(token, extra = {}) {
  return { authorization: `Bearer ${token}`, ...extra };
}

export async function shot(page, name) {
  if (!ARGS.shots) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  console.log(`        (截图: docs/shots-140/${name}.png)`);
}

export function sh(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: opts.timeout || 600000,
    env: { ...process.env, ...(opts.env || {}) },
    maxBuffer: 32 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, signal: r.signal };
}

export function tail(text, n = 700) {
  const t = String(text || '').trim();
  return t.length > n ? `...${t.slice(-n)}` : t;
}

/* ------------------------------ 颜色工具 ------------------------------ */

export function parseColor(input) {
  const s = String(input || '').trim();
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/i.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  return null;
}

export function colorClose(a, b, tol = THRESHOLD.colorTolerance) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return false;
  return Math.abs(ca[0] - cb[0]) <= tol && Math.abs(ca[1] - cb[1]) <= tol && Math.abs(ca[2] - cb[2]) <= tol;
}

export function isOpaque(color) {
  const c = parseColor(color);
  return Boolean(c && c[3] >= 0.99);
}

/** 相对亮度（WCAG） */
export function luminance(rgb) {
  const [r, g, b] = rgb.slice(0, 3).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * 两色的对比度比值（WCAG 定义，>=1）。
 * 需求11 要求分割线与背景的对比度 >= 1.2，用这个函数算。
 */
export function contrastRatio(c1, c2) {
  const a = parseColor(c1);
  const b = parseColor(c2);
  if (!a || !b) return null;
  const l1 = luminance(a);
  const l2 = luminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return round2((hi + 0.05) / (lo + 0.05));
}

/* ============================== Playwright 装载 ============================== */

/**
 * 多路径回退装载 Playwright（沿用 verify-119-full / verify-121 的做法）。
 */
export async function loadChromium() {
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

/**
 * Chromium 启动参数。
 *
 * `--disable-gpu` 是本版硬要求：本机无头 Chrome 用默认参数约 30s 崩溃
 * （连空白页都崩），加了这个参数才稳定。
 */
export const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

/* ============================== 主状态 ============================== */

export const state = {
  token: null,
  refresh: null,
  user: null,
  /** 固定 deviceId：避免每跑一次在云端多一个 index/<deviceId>.json */
  deviceId: 'qa-verify-140',
  createdDocs: [],
  createdPlugins: [],
  prodSettings: null,
  prodVaults: null,
  /** 本脚本自身的写请求流水（零污染自证） */
  selfWrites: [],
  /** 浏览器内是否发生过 API 写入（用于区分「本脚本改动」与「并行任务改动」） */
  apiWrites: [],
};

export function noteSelfWrite(method, url) {
  const m = String(method).toUpperCase();
  if (m === 'GET' || m === 'HEAD') return;
  state.selfWrites.push({ method: m, url: String(url) });
}

export async function login() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const r = await httpJson(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'admin', password: '6655' }),
    });
    if (r.status === 200 && r.body?.ok) {
      state.token = r.body.data.accessToken;
      state.refresh = r.body.data.refreshToken;
      state.user = r.body.data.user;
      return r.body.data;
    }
    if (r.status === 429) {
      const wait = Number(r.headers.get('retry-after') ?? 0) * 1000 || (attempt + 1) * 12_000;
      console.log(`  登录被限流（429），${Math.round(wait / 1000)}s 后重试...`);
      await sleep(wait);
      continue;
    }
    throw new Error(`登录失败 ${r.status}: ${fmt(r.body)}`);
  }
  throw new Error('登录连续被限流（429），请稍后重试');
}

export async function snapshotProd() {
  const s = await httpJson(`${API}/api/settings?platform=desktop`, { headers: authHeaders(state.token) });
  if (s.status === 200 && s.body?.ok) {
    state.prodSettings = { version: Number(s.body.data.version ?? 0), payload: s.body.data.payload ?? null };
  }
  const v = await httpJson(`${API}/api/vaults`, { headers: authHeaders(state.token) });
  if (v.status === 200 && v.body?.ok) {
    const list = v.body.data?.vaults ?? v.body.data ?? [];
    const items = Array.isArray(list) ? list : [];
    state.prodVaults = { count: items.length, ids: items.map((x) => x.vaultId).filter(Boolean) };
  }
}

/* ============================== 浏览器会话 ============================== */

/**
 * 新建一个已登录页面上下文。
 *
 * `settingsMode` 决定 `/api/settings` 的拦截行为（生产库安全阀）：
 *  - 'fake'  有状态假云端：PUT 存内存回显成功，GET 返回内存值。
 *            对生产库零写入，但走通「localStorage → PUT → GET → 覆盖」链路。
 *  - 'seed'  以 seedSettings 为云端初值（用于主题/作用域这类需要云端一致性的实测）。
 *  - 'real'  放行到真实 API（只在**只读**场景或明确需要真实往返时用）。
 */
export async function newSession(chromium, opts = {}) {
  const settingsMode = opts.settingsMode || 'fake';
  const cloud = opts.cloud || { payload: opts.seedSettings ? { global: opts.seedSettings } : null, version: 1 };
  const browser = await chromium.launch({ args: LAUNCH_ARGS });
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 1600, height: 950 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
  });
  await ctx.addInitScript(
    ([a, r, u, dev, seed]) => {
      try {
        localStorage.setItem('neomd.access', a);
        localStorage.setItem('neomd.refresh', r);
        localStorage.setItem('neomd.user.cache', u);
        localStorage.setItem('neomd.deviceId', dev);
        if (seed) localStorage.setItem('neomd.settings.v1', seed);
      } catch {
        /* ignore */
      }
    },
    [
      state.token,
      state.refresh,
      JSON.stringify(state.user),
      state.deviceId,
      opts.seedSettings ? JSON.stringify(opts.seedSettings) : '',
    ],
  );

  if (settingsMode !== 'real') {
    await ctx.route('**/api/settings**', async (route) => {
      const req = route.request();
      const url = req.url();
      const ok = (data) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
      if (req.method() === 'PUT') {
        try {
          const body = JSON.parse(req.postData() || '{}');
          if (body.payload !== undefined) cloud.payload = body.payload;
        } catch {
          /* ignore */
        }
        cloud.version += 1;
        return ok({ version: cloud.version, updatedAt: new Date().toISOString(), deviceId: null, platform: null });
      }
      if (/\/api\/settings\/version/.test(url)) return ok({ version: cloud.version });
      return ok({
        payload: cloud.payload,
        sensitive: null,
        version: cloud.version,
        updatedAt: null,
        deviceId: null,
        platform: new URL(url).searchParams.get('platform'),
      });
    });
  }

  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e.message || e).slice(0, 220)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /Uncaught|ReferenceError|TypeError/.test(m.text())) {
      jsErrors.push(m.text().slice(0, 220));
    }
  });
  page.on('dialog', (d) => d.accept().catch(() => {}));
  return { browser, ctx, page, jsErrors, cloud };
}

/* ============================== 页面操作 ============================== */

/** 打开工作台并确保有一篇可编辑的 md 文档（含 Vite 500/白屏诊断与重试） */
export async function openWorkbench(page, { waitDoc = true } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: ARGS.timeout }).catch((e) => {
      lastErr = e;
    });
    try {
      await page.waitForSelector('.shell__main', { state: 'attached', timeout: attempt === 0 ? ARGS.timeout : 20000 });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      const d = await page
        .evaluate(() => {
          const overlay = document.querySelector('vite-error-overlay');
          return {
            hasOverlay: Boolean(overlay),
            text: overlay ? String(overlay.shadowRoot?.textContent || '').slice(0, 200) : '',
          };
        })
        .catch(() => ({ hasOverlay: false, text: '' }));
      console.log(`  [重试 ${attempt + 1}/3] .shell__main 未挂载${d.hasOverlay ? `；Vite 报错：${d.text.slice(0, 120)}` : ''}`);
      await sleep(3000);
    }
  }
  if (lastErr) throw new Error(`打开工作台失败（已重试 3 次）：${lastErr.message}`);
  if (!waitDoc) return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await page.locator('.ProseMirror, .cm-content, .read-view').count()) break;
    await page.locator('.shell__main').click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press('Control+n').catch(() => {});
    await sleep(700);
    if (!(await page.locator('.ProseMirror, .cm-content, .read-view').count())) {
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => /新建文档/.test(b.textContent || ''));
        btn?.click();
      });
      await sleep(700);
    }
  }
  await page.waitForSelector('.ProseMirror', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
}

/** 回到一个真实的文档标签（设置页/插件商店在 1.4 里仍是标签页） */
export async function backToDoc(page, waitMs = 1200) {
  const switched = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('.tab'));
    const doc = tabs.find((t) => !/设置|插件商店|后台/.test(t.textContent || ''));
    if (!doc) return false;
    doc.click();
    return true;
  });
  if (switched) await page.waitForTimeout(waitMs);
  return switched;
}

/** 打开设置标签，并可选切到指定页签 */
export async function openSettings(page, tabLabel) {
  if (!(await page.locator('.settings__nav-item').count())) {
    await page.keyboard.press('Control+Comma');
    await page.waitForSelector('.settings__nav-item', { timeout: 15000 }).catch(() => {});
  }
  if (tabLabel) await clickSettingsTab(page, tabLabel);
}

/* ============================== 设置草稿 / 保存（需求16） ============================== */

/**
 * 1.4 的设置是**草稿模式**（需求16）：改动只进草稿，必须点保存才落 store。
 *
 * 这改变了所有「改设置 → 断言生效」类断言的路径：
 * 改完必须调用 {@link saveSettings}，否则断言测的是一个根本没提交的草稿，
 * 会大面积假失败（1.3.1 的门禁 C 段就是这么失败的）。
 *
 * 选择器（T4 已落地，优于按文案找）：
 *   底部保存栏 data-testid="settings-save-bar"
 *   保存按钮   data-testid="settings-save"
 *   取消按钮   data-testid="settings-cancel"
 *   恢复默认   data-testid="settings-reset-default"
 *   实时预览   data-testid="live-preview-toggle"
 */

/** 读取草稿脏状态与保存栏存在性 */
export async function readSaveBar(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-testid="settings-save-bar"]');
    const save = document.querySelector('[data-testid="settings-save"]');
    const cancel = document.querySelector('[data-testid="settings-cancel"]');
    const reset = document.querySelector('[data-testid="settings-reset-default"]');
    return {
      hasBar: Boolean(bar),
      hasSave: Boolean(save),
      hasCancel: Boolean(cancel),
      hasReset: Boolean(reset),
      dirty: bar ? String(bar.className).includes('is-dirty') : false,
      saveDisabled: save ? Boolean(save.disabled) : null,
      cancelDisabled: cancel ? Boolean(cancel.disabled) : null,
      barText: (bar?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    };
  });
}

/**
 * 点「保存」把草稿提交进 store。
 * 返回是否真的点到了按钮（找不到按钮时返回 false，让断言如实失败而不是静默跳过）。
 */
export async function saveSettings(page, { waitMs = 1400 } = {}) {
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="settings-save"]');
    if (!btn) return { ok: false, reason: '未找到 [data-testid="settings-save"]' };
    if (btn.disabled) return { ok: false, reason: '保存按钮处于 disabled（草稿无改动）', disabled: true };
    btn.click();
    return { ok: true };
  });
  if (clicked.ok) await page.waitForTimeout(waitMs);
  return clicked;
}

/** 点「取消」，丢弃草稿 */
export async function cancelSettings(page, { waitMs = 1200 } = {}) {
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="settings-cancel"]');
    if (!btn) return { ok: false, reason: '未找到 [data-testid="settings-cancel"]' };
    btn.click();
    return { ok: true };
  });
  if (clicked.ok) await page.waitForTimeout(waitMs);
  return clicked;
}

/** 直接关闭设置标签（不保存、不取消），用于「改了但不保存就离开」的场景 */
export async function escapeSettings(page, { waitMs = 1200 } = {}) {
  // 优先点标签关闭按钮（真实用户路径）
  const closed = await closeSettings(page);
  if (!closed) {
    // 兜底：Ctrl+, 再按一次（部分实现用它 toggle）
    await page.keyboard.press('Control+Comma').catch(() => {});
  }
  await page.waitForTimeout(waitMs);
  return closed;
}

export async function clickSettingsTab(page, label) {
  const clicked = await page.evaluate((lbl) => {
    const el = Array.from(document.querySelectorAll('.settings__nav-item')).find((e) => (e.textContent || '').trim() === lbl);
    if (!el) return false;
    el.click();
    return true;
  }, label);
  await page.waitForTimeout(600);
  return clicked;
}

export async function settingsTabs(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.settings__nav-item')).map((e) => (e.textContent || '').trim()));
}

/** 关闭设置标签 */
export async function closeSettings(page) {
  const closed = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('.tab'));
    const st = tabs.find((t) => /设置/.test(t.textContent || ''));
    const btn = st?.querySelector('.tab__close');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await page.waitForTimeout(900);
  return closed;
}

/** 切换编辑器模式（wysiwyg / source / compare / read） */
export async function setMode(page, modeId) {
  const labelMap = { wysiwyg: '所见即所得', source: '源码模式', compare: '对照模式', read: '阅读视图' };
  const label = labelMap[modeId];
  await page.evaluate(() => {
    const btns = document.querySelectorAll('.editorbar .viewswitch__btn');
    btns[btns.length - 1]?.click();
  });
  await page.waitForSelector('.viewswitch__menu', { timeout: 8000 }).catch(() => {});
  await page.evaluate((lb) => {
    const items = Array.from(document.querySelectorAll('.viewswitch__menu .viewswitch__item'));
    items.find((e) => (e.textContent || '').trim().includes(lb))?.click();
  }, label);
  await page.waitForTimeout(900);
}

/** 打开插件中心标签 */
export async function openPluginCenter(page) {
  const opened = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.ribbon__btn, button'));
    const hit = btns.find((b) => /插件商店|插件中心/.test(`${b.getAttribute('title') || ''}${b.textContent || ''}`));
    if (!hit) return false;
    hit.click();
    return true;
  });
  await page.waitForTimeout(1800);
  return opened;
}

/** 打开后台管理标签 */
export async function openAdmin(page) {
  const opened = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a'));
    const hit = btns.find((b) => /后台|管理控制台|admin/i.test(`${b.getAttribute('title') || ''}${b.textContent || ''}`));
    if (!hit) return false;
    hit.click();
    return true;
  });
  await page.waitForTimeout(2000);
  return opened;
}

/* ============================== store 访问 ============================== */

export const STORE_EXPR =
  "document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')";
export const SETTINGS_STORE_EXPR =
  "document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings')";

export async function storeEval(page, fn, arg) {
  return page.evaluate(
    ({ expr, body, value }) => {
      // eslint-disable-next-line no-eval
      const s = eval(expr);
      // eslint-disable-next-line no-new-func
      const f = new Function('s', 'arg', `return (${body})(s, arg);`);
      return f(s, value);
    },
    { expr: STORE_EXPR, body: fn.toString(), value: arg },
  );
}

export async function settingsStoreEval(page, fn, arg) {
  return page.evaluate(
    ({ expr, body, value }) => {
      // eslint-disable-next-line no-eval
      const s = eval(expr);
      // eslint-disable-next-line no-new-func
      const f = new Function('s', 'arg', `return (${body})(s, arg);`);
      return f(s, value);
    },
    { expr: SETTINGS_STORE_EXPR, body: fn.toString(), value: arg },
  );
}

export async function readTabContent(page) {
  return page.evaluate((expr) => {
    // eslint-disable-next-line no-eval
    const s = eval(expr);
    return s?.activeTab?.content ?? null;
  }, STORE_EXPR);
}

export async function readVaultRaw(page, docId) {
  return page.evaluate(
    async ({ expr, id }) => {
      // eslint-disable-next-line no-eval
      const s = eval(expr);
      return s.vault.read(id);
    },
    { expr: STORE_EXPR, id: docId },
  );
}

/** 当前生效的 CSS 变量（<html> 上的 inline + computed） */
export async function readCssVars(page, names) {
  return page.evaluate((keys) => {
    const el = document.documentElement;
    const cs = getComputedStyle(el);
    const out = {};
    for (const k of keys) {
      out[k] = {
        computed: cs.getPropertyValue(k).trim(),
        inline: el.style.getPropertyValue(k).trim(),
      };
    }
    out.__meta = {
      theme: el.dataset.theme || '',
      preset: el.dataset.themePreset || '',
      scope: el.dataset.themeScope || '',
    };
    return out;
  }, names);
}

/* ============================== 设置快照 / 还原 ============================== */

/**
 * 设置类改动前后快照并还原。
 *
 * 生产库有真实用户设置：任何改设置的断言都必须在 finally 里把
 * localStorage + 云端设置写回原值，否则会把验收值留在 admin 账号上
 * （1.3.1 期间曾因并发写入导致 admin 设置被污染）。
 */
export async function snapshotSettings(page) {
  const local = await page.evaluate(() => localStorage.getItem('neomd.settings.v1'));
  const cloud = await httpJson(`${API}/api/settings?platform=desktop`, { headers: authHeaders(state.token) });
  return {
    local,
    cloudPayload: cloud.status === 200 && cloud.body?.ok ? cloud.body.data.payload : null,
    cloudVersion: cloud.status === 200 && cloud.body?.ok ? Number(cloud.body.data.version ?? 0) : 0,
  };
}

export async function restoreSettings(page, snap) {
  if (!snap) return { local: false, cloud: null };
  let localOk = false;
  try {
    await page.evaluate((s) => {
      if (s) localStorage.setItem('neomd.settings.v1', s);
      else localStorage.removeItem('neomd.settings.v1');
    }, snap.local);
    localOk = true;
  } catch {
    /* ignore */
  }
  let cloudStatus = null;
  if (snap.cloudPayload) {
    const r = await httpJson(`${API}/api/settings`, {
      method: 'PUT',
      headers: { ...authHeaders(state.token), 'content-type': 'application/json' },
      body: JSON.stringify({ payload: snap.cloudPayload, version: snap.cloudVersion + 1 }),
    });
    if (r.status === 200) {
      await httpJson(`${API}/api/settings`, {
        method: 'PUT',
        headers: { ...authHeaders(state.token), 'content-type': 'application/json' },
        body: JSON.stringify({ payload: snap.cloudPayload, version: snap.cloudVersion + 2 }),
      });
    }
    cloudStatus = r.status;
  }
  return { local: localOk, cloud: cloudStatus };
}

/* ============================== 云对象与后台 API ============================== */

export async function listObjects(vaultId, prefix) {
  const r = await httpJson(`${API}/api/storage/list?prefix=${encodeURIComponent(prefix)}`, {
    headers: authHeaders(state.token, { 'x-vault-id': vaultId }),
  });
  if (r.status !== 200 || !r.body?.ok) return { ok: false, status: r.status, objects: [] };
  return { ok: true, status: r.status, objects: r.body.data?.objects ?? [] };
}

export async function getObjectText(vaultId, key) {
  const res = await fetch(`${API}/api/storage/object?key=${encodeURIComponent(key)}`, {
    headers: authHeaders(state.token, { 'x-vault-id': vaultId }),
  });
  if (!res.ok) return null;
  return res.text();
}

export async function deleteObject(vaultId, key) {
  const r = await httpJson(`${API}/api/storage/object?key=${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: authHeaders(state.token, { 'x-vault-id': vaultId }),
  });
  return r.status === 200;
}

/* ============================== 清理 ============================== */

export async function cleanup(chromium) {
  if (ARGS.keep) {
    console.log('\n  --keep 已指定，跳过资源清理');
    return;
  }
  if (!state.createdDocs.length) return;
  console.log(`\n清理：${state.createdDocs.length} 个临时文档...`);
  try {
    const { browser, page } = await newSession(chromium, {});
    try {
      await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: ARGS.timeout });
      await page.waitForSelector('.shell__main', { timeout: 30000 });
      await page.waitForTimeout(2200);
      for (const d of state.createdDocs) {
        const r = await page.evaluate(
          async ({ expr, id }) => {
            // eslint-disable-next-line no-eval
            const s = eval(expr);
            try {
              await s.deleteDoc(id);
              return { ok: true };
            } catch (e) {
              return { ok: false, reason: String(e?.message ?? e).slice(0, 140) };
            }
          },
          { expr: STORE_EXPR, id: d.docId },
        );
        console.log(`  删除文档 ${d.path ?? d.docId}: ${r.ok ? 'ok' : r.reason}`);
      }
      await page.waitForTimeout(2500);
    } finally {
      await browser.close();
    }
  } catch (e) {
    console.log(`  文档删除失败（继续清理云端对象）：${String(e?.message ?? e).slice(0, 140)}`);
  }

  for (const d of state.createdDocs) {
    if (!d.vaultId || !d.docId) continue;
    for (const prefix of [`versions/${d.docId}/`, `docs/${d.docId}/`]) {
      const listed = await listObjects(d.vaultId, prefix);
      for (const o of listed.objects ?? []) await deleteObject(d.vaultId, o.key);
      if ((listed.objects ?? []).length) console.log(`  已清理 ${listed.objects.length} 个对象（${prefix}）`);
    }
  }
  for (const d of state.createdDocs) {
    if (!d.vaultId) continue;
    await deleteObject(d.vaultId, `index/${state.deviceId}.json`).catch(() => {});
  }
}

/* ============================== 汇总 ============================== */

export function summary() {
  const passed = results.filter((r) => r.pass === true).length;
  const failed = results.filter((r) => r.pass === false).length;
  const skipped = results.filter((r) => r.pass === null).length;
  console.log(`\n${'='.repeat(78)}\n汇总\n${'='.repeat(78)}`);
  for (const sec of ALL_SECTIONS) {
    const rs = results.filter((r) => r.section === sec);
    if (!rs.length) continue;
    const p = rs.filter((r) => r.pass === true).length;
    const f = rs.filter((r) => r.pass === false).length;
    const s = rs.filter((r) => r.pass === null).length;
    console.log(`  [${sec}] 通过 ${p} / 失败 ${f} / 跳过 ${s}`);
  }
  console.log(`\n  合计：通过 ${passed} / 失败 ${failed} / 跳过 ${skipped}`);
  if (failed) {
    console.log('\n  失败项：');
    for (const r of results.filter((x) => x.pass === false)) {
      console.log(`   \u2717 [${r.id}] ${r.name}`);
      console.log(`      期望: ${r.expect}`);
      console.log(`      实测: ${r.actual}`);
      if (r.repro) console.log(`      复现: ${r.repro}`);
    }
  }
  return { passed, failed, skipped };
}
