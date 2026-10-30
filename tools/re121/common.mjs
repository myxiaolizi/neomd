/**
 * Neo MD 1.2.1 门禁 —— 共享基础设施
 * =============================================================================
 * 本目录是 `tools/verify-121.mjs` 的实现拆分：
 *   common.mjs   参数 / 阈值 / 断言框 / 登录 / 会话 / 仓库与云对象工具 / 清理
 *   a.mjs        A 行距正常
 *   b.mjs        B 分屏右侧配色
 *   c.mjs        C 设置字体不被自动恢复
 *   d.mjs        D 保存后空换行不丢
 *   e.mjs        E 历史版本多版本可用
 *   f.mjs        F 设置项无重复
 *   n.mjs        N 负向对照（证明断言非恒真）
 *   g.mjs        G 回归门禁
 *
 * 设计约束：
 *  1. 只读产品代码，不改 apps/**、packages/**、services/**。
 *  2. 不污染生产数据：设置类全程走浏览器内「假云端」拦截；文档类只用 QA121- 前缀的
 *     临时文档，finally 里删文档 + 删云端 versions/docs 对象 + 删固定 deviceId 的 index。
 *  3. 每条断言输出「断言名 / 期望 / 实测 / 通过与否」，失败项附复现步骤。
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
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
    timeout: 45000,
    withRegression: false,
    negativeControl: false,
    keep: false,
    fontHoldMs: 95_000,
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
    else if (a.startsWith('--font-hold-ms=')) out.fontHoldMs = Number(a.slice(15)) || out.fontHoldMs;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

export const ARGS = parseArgs(process.argv.slice(2));
export const BASE = ARGS.base || process.env.SMOKE_BASE || 'http://127.0.0.1:5178';
export const API = ARGS.api || process.env.SMOKE_API || 'http://127.0.0.1:3200';
export const SHOT_DIR = path.join(ROOT, 'docs', 'shots-121');

/** 默认只跑 A~F（六项缺陷）。N/G 需要显式开关，避免默认耗时过长。 */
export const DEFAULT_SECTIONS = ['A', 'B', 'C', 'D', 'E', 'F'];
export const ALL_SECTIONS = ['A', 'B', 'C', 'D', 'E', 'F', 'N', 'G', 'P'];
export const ONLY = ARGS.only && ARGS.only.length ? new Set(ARGS.only) : new Set(DEFAULT_SECTIONS);

/* ============================== 阈值与依据 ============================== */

/**
 * ## A 段：两类「相邻非空段落」必须分开断言
 *
 * 关键事实（fix-editor 复核、我也用 tsx 直接验证过）：
 * `markdownToHtml('A\n\n\nB')` 在 1.2.0 就只产出 `<p>A</p><p>B</p>` ——
 * markdown-it 本身丢弃连续空行，**不会**凭空产生空段落。
 * 所以「空行变成空段落」只发生在两种真实路径：
 *   ① 用户在所见即所得里按回车敲出的空段落；
 *   ② 1.2.1 的 bridge 为 N≥2 个空行专门生成的 `.nm-blank` 载体。
 *
 * | 断言 | 形态 | 修复前 | 修复后 | 阈值 |
 * |------|------|--------|--------|------|
 * | A3a | 相邻非空段落，中间**无**空段落 | 21.59px = 1.35em（PASS） | 15.19px = 0.949em | [0.5, 2.0]em |
 * | A3b | 两段之间夹 1 个显式空行 | 55.18px = 3.449em（**FAIL**） | 31.19px = 1.949em | [0.5, 2.2]em |
 *
 * A3b 上限取 2.2em 而非卡死 2.0em：修复后实测 1.949em 距 2.0 只剩 0.05em，
 * 字体回退/渲染差异会造成假失败；相对修复前 3.449em 仍有 1.25em 区分度，不会失去检出能力。
 *
 * | 项 | 修复前 | 修复后 | 阈值 |
 * |----|--------|--------|------|
 * | 行高比 lineHeight/fontSize | 1.75 | 1.6 | [1.4, 1.85] |
 * | 分屏预览背景 | 链上全透明，靠祖先透出 | rgb(255,255,255) / rgb(20,23,28) | 不透明且 ≈ --content-bg ±2/通道 |
 */
export const THRESHOLD = {
  ratioMin: 1.4,
  ratioMax: 1.85,
  gapAdjacentMinEm: 0.5,
  gapAdjacentMaxEm: 2.0,
  gapBlankLineMinEm: 0.5,
  gapBlankLineMaxEm: 2.2,
  /** 分屏配色通道容差（任务书：±2/通道） */
  colorTolerance: 2,
  /** E 段最少历史版本条数 */
  minVersions: 5,
  /** E 段最少「内容互不相同」的版本数（lead 加严要求） */
  minDistinctVersions: 3,
  /** F 段：字号 / 行高 / 字体 各应恰好 1 个控件 */
  uniqueFontControls: ['font-family', 'font-size', 'line-height'],
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
  console.log(`        (截图: docs/shots-121/${name}.png)`);
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

export function parseColor(input) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/i.exec(String(input || ''));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
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

/** 把 CSS 变量值（#rrggbb / #rgb / rgb()）换算成 rgb() 字符串 */export function cssVarToRgb(value) {
  const v = String(value || '').trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  }
  const short = /^#([0-9a-f]{3})$/i.exec(v);
  if (short) {
    const [r, g, b] = short[1].split('').map((c) => parseInt(c + c, 16));
    return `rgb(${r}, ${g}, ${b})`;
  }
  if (/^rgba?\(/i.test(v)) return v;
  return null;
}

/**
 * 统计一段 Markdown 的空行结构（**绝不规范化后再比较**）。
 *
 * 三类空行分别对应三条已知丢失路径，缺一都测不出来：
 *  1. 段落间连续空行（blankRun）
 *  2. 文末换行（trailingNewlines）—— 被 `.trim()` 吃掉时变 0，
 *     git 里表现为 `\ No newline at end of file`
 *  3. 代码块内空行（codeBlockBlank）—— 按**行数**统计，
 *     用 `/\n\s*\n/g` 数「块数」会把「2 个空行被压成 1 个」漏检
 */
export function blankStats(s) {
  const str = String(s ?? '');
  const lines = str.split('\n');
  return {
    trailingNewlines: (str.match(/\n+$/)?.[0]?.length ?? 0),
    endsWithNewline: str.endsWith('\n'),
    lineCount: lines.length,
    maxBlankRun: (() => {
      let best = 0;
      let cur = 0;
      for (const l of lines) {
        if (l.trim() === '') cur += 1;
        else {
          best = Math.max(best, cur);
          cur = 0;
        }
      }
      return best;
    })(),
    codeBlockBlank: (() => {
      const m = /```[^\n]*\n([\s\S]*?)```/.exec(str);
      if (!m) return null;
      const body = m[1].replace(/\n$/, '');
      return body.split('\n').filter((l) => l.trim() === '').length;
    })(),
    repr: JSON.stringify(str.length > 300 ? `${str.slice(0, 300)}...` : str),
  };
}

/* ============================== Playwright 装载 ============================== */

/**
 * 多路径回退装载 Playwright（沿用 tools/verify-119-full.mjs:179-201 的做法）。
 * 仓库里 playwright 可能只装在某个 workspace（apps/desktop）或 pnpm store，
 * 从 tools/ 下直接 import 解析不到，因此逐个候选尝试。
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

/* ============================== 主状态 ============================== */

export const state = {
  token: null,
  refresh: null,
  user: null,
  /** 固定 deviceId：避免每跑一次在云端多一个 index/<deviceId>.json */
  deviceId: 'qa-verify-121',
  /** 本次创建的临时文档（finally 清理） */
  createdDocs: [],
  /** 生产设置快照（只读，用于输出对照） */
  prodSettings: null,
  prodVaults: null,
  /** 本脚本自身的写请求流水（零污染自证；不受并行任务干扰） */
  selfWrites: [],
};

/**
 * 记录本脚本自身发出的写请求。
 *
 * 为什么需要：并行修复组会自建/自删临时仓库，「仓库总数变化」不能归因于本脚本。
 * 要证明「本脚本没污染」只能断言本脚本自己没发过那类请求。
 * 注意：Playwright 拦截的请求（假云端）不经过 httpJson，因此不会被计入。
 */
export function noteSelfWrite(method, url) {
  const m = String(method).toUpperCase();
  if (m === 'GET' || m === 'HEAD') return;
  state.selfWrites.push({ method: m, url: String(url) });
}

/** 登录（限流 10 次/分钟 → 429 退避重试，优先用服务端 retry-after） */
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
    state.prodSettings = { version: Number(s.body.data.version ?? 0) };
  }
  const v = await httpJson(`${API}/api/vaults`, { headers: authHeaders(state.token) });
  if (v.status === 200 && v.body?.ok) {
    const list = v.body.data?.vaults ?? v.body.data ?? [];
    const items = Array.isArray(list) ? list : [];
    state.prodVaults = { count: items.length, ids: items.map((x) => x.vaultId).filter(Boolean) };
  }
}

/**
 * 新建一个已登录的页面上下文。
 *
 * `settingsMode` 决定 `/api/settings` 的拦截行为（生产库安全阀）：
 *  - 'fake'  有状态假云端：PUT 存内存回显成功，GET 返回内存值。走通
 *            「localStorage → PUT → 刷新 → GET → 覆盖 localStorage」完整链路，
 *            对生产库零写入（1.1.9 门禁的成熟做法）。
 *  - 'stale' 云端恒为旧值、PUT 恒 409（模拟推送失败/版本冲突）。
 *            用于 C 段复现「本地改了字体、推送没成功，下一次 pull 把旧值盖回来」。
 *  - 'off'   不拦截（只读场景；任何设置写入都会真的落到生产库，慎用）。
 */
export async function newSession(chromium, opts = {}) {
  const settingsMode = opts.settingsMode || 'fake';
  const cloud = opts.cloud || { payload: null, version: 0 };
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
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

  if (settingsMode !== 'off') {
    await ctx.route('**/api/settings**', async (route) => {
      const req = route.request();
      const url = req.url();
      const ok = (data) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
      if (req.method() === 'PUT') {
        if (settingsMode === 'stale') {
          return route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({
              ok: false,
              error: { code: 'SETTINGS_VERSION_CONFLICT', message: '设置已在其它设备更新' },
            }),
          });
        }
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
      if (settingsMode === 'stale') {
        return ok({
          payload: opts.stalePayload ?? null,
          sensitive: null,
          version: Math.max(1, cloud.version),
          updatedAt: null,
          deviceId: null,
          platform: new URL(url).searchParams.get('platform'),
        });
      }
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
  // 恢复历史版本会弹 window.confirm，自动确认，避免脚本卡在对话框上
  page.on('dialog', (d) => d.accept().catch(() => {}));
  return { browser, ctx, page, jsErrors, cloud };
}

/* ============================== 页面操作 ============================== */

/**
 * 探测「页面为什么没挂载起来」并给出可读诊断。
 *
 * 为什么要这层：开发期多个修复组会并发保存源码，Vite 在「文件正被写入」的瞬间
 * 可能返回 500（实测：`/src/stores/settings.ts` 瞬时 500），表现是整页白屏 +
 * `<vite-error-overlay>`，此时所有 selector 都找不到。
 * 如果不区分这种情况，门禁会把「环境瞬时故障」误报成「断言失败」，
 * 结论就不可信了。这里把它变成明确的错误信息 + 可重试判断。
 */
async function diagnoseBlank(page) {
  return page
    .evaluate(() => {
      const overlay = document.querySelector('vite-error-overlay');
      const appHtml = document.querySelector('#app')?.innerHTML ?? '';
      return {
        hasOverlay: Boolean(overlay),
        overlayText: overlay ? String(overlay.shadowRoot?.textContent || overlay.textContent || '').slice(0, 400) : '',
        appEmpty: appHtml.trim().length === 0,
        bodyText: (document.body.innerText || '').slice(0, 200),
      };
    })
    .catch(() => ({ hasOverlay: false, overlayText: '', appEmpty: true, bodyText: '' }));
}

/** 打开工作台并确保有一篇可编辑的 md 文档 */
export async function openWorkbench(page, { waitDoc = true } = {}) {
  /*
   * 外壳挂载重试 3 次。
   *
   * 每次失败都先诊断：如果是 Vite 500 / 错误遮罩（源码正在被并发编辑），
   * 等 3s 后重载再试；如果是超时但没有错误遮罩，同样重载再试一次。
   * 三次都失败才抛错，并把诊断信息带出来 —— 这样「环境坏了」和「断言失败」
   * 在日志里是两件明显不同的事。
   */
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
      const d = await diagnoseBlank(page);
      if (d.hasOverlay) {
        console.log(`  [重试 ${attempt + 1}/3] Vite 错误遮罩：${d.overlayText.split('\n').slice(0, 3).join(' | ')}`);
      } else {
        console.log(`  [重试 ${attempt + 1}/3] .shell__main 未挂载（#app 空=${d.appEmpty}）`);
      }
      await sleep(3000);
    }
  }
  if (lastErr) {
    const d = await diagnoseBlank(page);
    const hint = d.hasOverlay
      ? `Vite 报错（很可能是源码正在被并发编辑，稍后重试）：${d.overlayText.split('\n').slice(0, 6).join(' | ')}`
      : `页面未挂载：#app 为空=${d.appEmpty}，body 文本=${JSON.stringify(d.bodyText)}`;
    throw new Error(`打开工作台失败（已重试 3 次）。${hint}\n原始错误：${lastErr.message}`);
  }
  if (!waitDoc) return;
  /*
   * 需要「一个可编辑的正文」。两种会让这里失败的真实情况：
   *  1. 上次退出时没开任何标签 → 冷启动后没有编辑器；
   *  2. 上次停留在流程图/设置/插件商店标签 → 恢复出来的活动标签不是文本编辑器。
   * 因此按「快捷键 → 按钮兜底 → 显式等待」三级重试（1.1.9 门禁踩过这个坑）。
   */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await page.locator('.ProseMirror, .cm-content, .read-view').count()) break;
    await page.locator('.shell__main').click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press('Control+n').catch(() => {});
    await page.waitForTimeout(600);
    if (!(await page.locator('.ProseMirror, .cm-content, .read-view').count())) {
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
 * 为什么需要：设置页与插件商店在 1.2.x 里是**标签页**而不是覆盖层，
 * 打开它们后 `.nm-content` / `.ProseMirror` 都会被替换成设置页内容，
 * 此时读 computed style 必然拿到 null。
 */
export async function backToDoc(page, waitMs = 1200) {
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

/** 打开设置标签，并可选切到指定页签 */
export async function openSettings(page, tabLabel) {
  if (!(await page.locator('.settings__nav-item').count())) {
    await page.keyboard.press('Control+Comma');
    await page.waitForSelector('.settings__nav-item', { timeout: 15000 }).catch(() => {});
  }
  if (tabLabel) {
    await page.evaluate((label) => {
      const el = Array.from(document.querySelectorAll('.settings__nav-item')).find(
        (e) => (e.textContent || '').trim() === label,
      );
      el?.click();
    }, tabLabel);
    await page.waitForTimeout(600);
  }
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
    const hit = items.find((e) => (e.textContent || '').trim().includes(lb));
    hit?.click();
  }, label);
  await page.waitForTimeout(900);
}

/* ============================== store 访问 ============================== */

/**
 * pinia app store 的浏览器内表达式。
 *
 * 为什么走 store 而不是 UI 点击：门禁要断言的是**数据与渲染结果**，
 * 保存/读数/建文档走 store 最稳、最快，也不受工具栏按钮位置变化影响；
 * 而「用户路径」相关的断言（设置字体、切模式、历史面板）仍走真实 UI。
 */
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

export async function saveAndSettle(page, waitMs = 2600) {
  await page.evaluate((expr) => {
    // eslint-disable-next-line no-eval
    const s = eval(expr);
    return s.saveActiveTab();
  }, STORE_EXPR);
  await page.waitForTimeout(waitMs);
}

/** 新建临时文档（标题带 QA121- 前缀，便于事后检索与清理） */
export async function createTempDoc(page, { title, content = '' }) {
  const info = await page.evaluate(
    async ({ expr, t, c }) => {
      // eslint-disable-next-line no-eval
      const s = eval(expr);
      await s.createDoc({ title: t, content: c });
      await new Promise((r) => setTimeout(r, 1200));
      return { docId: s.activeTab?.docId ?? null, path: s.activeTab?.path ?? null, vaultId: s.vault?.vaultId ?? null };
    },
    { expr: STORE_EXPR, t: title, c: content },
  );
  if (info.docId) state.createdDocs.push(info);
  return info;
}

/** 在源码模式（CodeMirror）里整篇写入 markdown，用真实键盘事件 */
export async function typeMarkdownInSource(page, md) {
  await page.waitForSelector('.cm-content', { timeout: 15000 });
  await page.click('.cm-content');
  await page.waitForTimeout(250);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(150);
  await page.keyboard.type(md, { delay: 3 });
  await page.waitForTimeout(800);
}

/* ============================== 设置种子 ============================== */

/**
 * 默认设置种子：**只钉主题相关字段**，字号/行高/缩放一律留空。
 *
 * 为什么不能自己钉 lineHeight：A 段断言的是「开箱默认排版是否正常」，
 * 默认值由 `packages/core/src/settings/settings.ts` 的 `defaultSettings()` 决定
 * （1.1.9 是 1.75，1.2.1 收严到 1.6）。若这里强行写 1.75，会遮蔽修复效果，
 * A1 就变成「测我自己写的种子值」。mergeSettings 是浅合并，未提供的
 * appearance 字段会继承 defaultSettings()。
 */
export function defaultSeed() {
  return {
    appearance: {
      theme: 'light',
      themePresetId: 'daylight',
      accent: '#1677FF',
    },
    cloudVersion: 1,
  };
}

/**
 * 指定主题/排版的种子（B 段用）。
 * 深色主题用 midnight（--content-bg #14171c），浅色用 daylight（#ffffff）。
 */
export function themeSeed({ preset = 'daylight', fontSize = 17, lineHeight = 1.75, zoom = 100 } = {}) {
  return {
    appearance: {
      theme: preset === 'midnight' ? 'dark' : 'light',
      themePresetId: preset,
      accent: '#1677FF',
      fontFamily: 'system-ui',
      fontSize,
      lineHeight,
      zoom,
      pageWidth: 'full',
      showLineNumbers: false,
      customThemes: [],
    },
    cloudVersion: 1,
  };
}

/* ============================== 云对象（列举 / 读取 / 删除） ============================== */

export async function listObjects(vaultId, prefix) {
  const r = await httpJson(`${API}/api/storage/list?prefix=${encodeURIComponent(prefix)}`, {
    headers: authHeaders(state.token, { 'x-vault-id': vaultId }),
  });
  if (r.status !== 200 || !r.body?.ok) return { ok: false, status: r.status, objects: [] };
  return { ok: true, status: r.status, objects: r.body.data?.objects ?? [], truncated: Boolean(r.body.data?.truncated) };
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

/**
 * 自清理：临时文档 + 云端对象。
 *
 * 顺序关键：先经 store 删文档（会写一条 delete 版本），再直接删云端对象；
 * 反过来「先删对象再删文档」会被随后的同步重新写回。
 */
export async function cleanup(chromium) {
  if (ARGS.keep) {
    console.log('\n  --keep 已指定，跳过资源清理');
    return;
  }
  if (!state.createdDocs.length) return;
  console.log(`\n清理：${state.createdDocs.length} 个临时文档...`);

  try {
    const { browser, page } = await newSession(chromium, { settingsMode: 'fake' });
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
              return { ok: false, reason: String(e?.message ?? e).slice(0, 160) };
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
    console.log(`  文档删除失败（继续清理云端对象）：${String(e?.message ?? e).slice(0, 160)}`);
  }

  for (const d of state.createdDocs) {
    if (!d.vaultId || !d.docId) continue;
    for (const prefix of [`versions/${d.docId}/`, `docs/${d.docId}/`]) {
      const listed = await listObjects(d.vaultId, prefix);
      for (const o of listed.objects ?? []) {
        const ok = await deleteObject(d.vaultId, o.key);
        if (!ok) console.log(`  删除对象失败：${o.key}`);
      }
      if ((listed.objects ?? []).length) console.log(`  已清理 ${listed.objects.length} 个对象（${prefix}）`);
    }
  }

  // 删掉本脚本固定 deviceId 的云端索引（避免 index 文件堆积）
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
