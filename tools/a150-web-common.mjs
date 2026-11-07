/**
 * AUDIT-150 网页端审计 —— 共享基础设施
 * =============================================================================
 * 复用 tools/re140/common.mjs 与 tools/audit-perf-common.mjs 已验证的：
 *   1. `loadChromium()` 多路径回退（本机 `import 'playwright-core'` 直接报
 *      `Cannot find package`，必须走 .pnpm 下的绝对路径）；
 *   2. `--disable-gpu` 启动参数（本机无头 Chrome 默认参数约 30s 崩）；
 *   3. 登录 429 限流退避（10 次/分钟）。
 *
 * 本文件只补 AUDIT-150 特有的：
 *   - 场景记录（场景 | 能否完成 | 缺陷 | 严重级 | 复现 | 建议）；
 *   - 截图归档到 docs/AUDIT-150/shots/；
 *   - 缺陷台账（findings）与 JSON 落盘；
 *   - **控制台/页面错误全量采集**（「静默失败」的判定依据）。
 *
 * ## 纪律
 * 产品源码一律只读。本脚本只写 docs/AUDIT-150/ 与 tools/a150-web-*。
 * 被测库为隔离库 neomd_audit150b（services/api/.env.local 指定），生产库 neomd 未被触碰。
 *
 * ## 与 re140 的关键差异（为什么不能直接复用 settingsMode='fake'）
 *
 * re140 的审计跑在生产库上，靠「拦截 /api/settings」保护 admin 账号。
 * AUDIT-150 跑在**隔离库**上，本任务要求「改完是否生效、刷新后是否保持」——
 * 这必须走**真实**的 PUT/GET 往返，拦截成假的就测不出「设置是否落库」。
 * 因此本文件默认 `settingsMode='real'`，由 services/api/.env.local 的 DB_NAME
 * 保证隔离；并把「是否有非隔离库写请求」作为自证输出。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

export const OUT_DIR = path.join(ROOT, 'docs', 'AUDIT-150');
export const SHOT_DIR = path.join(OUT_DIR, 'shots');
export const RAW_DIR = path.join(OUT_DIR, 'raw');

export const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:5178';
export const API = process.env.SMOKE_API || 'http://127.0.0.1:3200';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================== Chromium ============================== */

/**
 * 多路径回退装载 Playwright。
 *
 * 为什么要写死 .pnpm 路径：本仓库根 `node_modules` 下**没有** playwright /
 * playwright-core 的顶层链接（它们是 apps/desktop 的依赖），
 * `import 'playwright-core'` 会抛 ERR_MODULE_NOT_FOUND。
 */
export async function loadChromium() {
  const candidates = [
    path.join(ROOT, 'node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.mjs'),
    path.join(ROOT, 'node_modules/playwright-core/index.mjs'),
    path.join(ROOT, 'apps/desktop/node_modules/playwright-core/index.mjs'),
    'playwright-core',
    'playwright',
  ];
  const errors = [];
  for (const c of candidates) {
    try {
      const spec = /^[A-Za-z]:/.test(c) || c.startsWith('/') ? `file://${c.replace(/\\/g, '/')}` : c;
      const mod = await import(spec);
      const chromium = mod.chromium || mod.default?.chromium;
      if (chromium) return chromium;
      errors.push(`${c}: 无 chromium 导出`);
    } catch (e) {
      errors.push(`${c}: ${e.code || e.message}`);
    }
  }
  throw new Error(`无法加载 Playwright，尝试过：\n  - ${errors.join('\n  - ')}`);
}

/** `--disable-gpu` 是硬要求：本机无头 Chrome 用默认参数约 30s 崩。 */
export const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

export const DESKTOP_VIEWPORT = { width: 1600, height: 950 };
export const MOBILE_VIEWPORT = { width: 375, height: 667 };

/* ============================== 口令 ============================== */

/**
 * 审计口令只从环境变量读，**绝不硬编码进仓库**（re140 的教训：
 * 生产管理员密码曾以明文散落在数十个文件里，已定级 P0）。
 */
export function auditPass() {
  const v = (process.env.AUDIT_PASS || '').trim();
  if (!v) {
    throw new Error(
      '缺少审计口令：请设置环境变量 AUDIT_PASS。\n' +
        "  例：$env:AUDIT_PASS='<密码>'; node tools/a150-web-xxx.mjs",
    );
  }
  return v;
}

export const AUDIT_USER = process.env.AUDIT_USER || 'admin';

/* ============================== HTTP ============================== */

export async function httpJson(url, init = {}, timeout = 20000) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 500);
    }
    return { status: res.status, ok: res.ok, body, headers: Object.fromEntries(res.headers), ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, ok: false, body: null, error: String(e?.message ?? e).slice(0, 200), ms: Date.now() - t0 };
  }
}

export const authHeaders = (token, extra = {}) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
  ...extra,
});

/** 登录（带 429 退避）。返回 { accessToken, refreshToken, user }。 */
export async function apiLogin(account = AUDIT_USER, password = auditPass()) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const r = await httpJson(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account, password }),
    });
    if (r.status === 200 && r.body?.ok) return r.body.data;
    if (r.status === 429) {
      const wait = Number(r.headers?.['retry-after'] ?? 0) * 1000 || (attempt + 1) * 12_000;
      console.log(`  登录被限流（429），${Math.round(wait / 1000)}s 后重试…`);
      await sleep(wait);
      continue;
    }
    throw new Error(`登录失败 ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  throw new Error('登录连续被限流（429）');
}

/** 健康快照：uptime 用于归因「API 中途是否重启过」（重启会让本批数据作废）。 */
export async function health() {
  const r = await httpJson(`${API}/api/health`, {}, 10000);
  return {
    ok: r.status === 200 && r.body?.ok === true,
    status: r.status,
    uptime: r.body?.uptime ?? null,
    version: r.body?.version ?? null,
    env: r.body?.env ?? null,
    db: r.body?.db ?? null,
  };
}

/* ============================== 会话 ============================== */

/**
 * 新建浏览器会话。
 *
 * @param {object} opts
 * @param {object} opts.tokens      { accessToken, refreshToken, user }；省略则匿名
 * @param {object} opts.viewport    默认桌面 1600x950
 * @param {boolean} opts.collectErrors 是否采集 console error / pageerror / 失败请求
 */
export async function newSession(chromium, opts = {}) {
  const browser = await chromium.launch({ args: LAUNCH_ARGS });
  const ctx = await browser.newContext({
    viewport: opts.viewport || DESKTOP_VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });

  const logs = { consoleErrors: [], consoleWarnings: [], pageErrors: [], failedRequests: [], apiCalls: [] };

  if (opts.tokens) {
    const { accessToken, refreshToken, user } = opts.tokens;
    await ctx.addInitScript(
      ([a, r, u]) => {
        try {
          localStorage.setItem('neomd.access', a);
          if (r) localStorage.setItem('neomd.refresh', r);
          if (u) localStorage.setItem('neomd.user.cache', u);
          localStorage.setItem('neomd.deviceId', 'qa-audit-150');
        } catch {
          /* ignore */
        }
      },
      [accessToken, refreshToken ?? '', user ? JSON.stringify(user) : ''],
    );
  }

  const page = await ctx.newPage();

  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error') logs.consoleErrors.push(m.text().slice(0, 300));
    else if (t === 'warning') logs.consoleWarnings.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => logs.pageErrors.push(String(e?.message ?? e).slice(0, 300)));
  page.on('requestfailed', (r) => {
    const f = r.failure();
    logs.failedRequests.push({
      url: r.url().replace(BASE, ''),
      method: r.method(),
      error: f ? `${f.errorText}` : 'unknown',
    });
  });
  page.on('response', (r) => {
    const u = r.url();
    if (/\/api\//.test(u)) {
      logs.apiCalls.push({ method: r.request().method(), url: u.replace(BASE, '').replace(API, ''), status: r.status() });
    }
  });
  // 原生 dialog（alert/confirm）自动接受并记录，避免脚本卡死
  page.on('dialog', (d) => {
    logs.pageErrors.push(`[dialog:${d.type()}] ${d.message().slice(0, 120)}`);
    d.accept().catch(() => {});
  });

  return { browser, ctx, page, logs };
}

/* ============================== 截图 ============================== */

export async function shot(page, name, { fullPage = false } = {}) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${name}.png`);
  try {
    await page.screenshot({ path: file, fullPage });
  } catch (e) {
    console.log(`      (截图失败 ${name}: ${String(e?.message ?? e).slice(0, 80)})`);
    return null;
  }
  console.log(`      (截图: docs/AUDIT-150/shots/${name}.png)`);
  return `docs/AUDIT-150/shots/${name}.png`;
}

/* ============================== 场景 ============================== */

export const scenarios = [];
export const findings = [];

/**
 * 开始一个场景。
 *
 * status 语义（不用 pass/fail：「能用但难用」在本产品是核心结论）：
 *  - 'ok'      按预期完成
 *  - 'partial' 能完成但有明显缺陷/绕路
 *  - 'fail'    完不成
 *  - 'skip'    前置条件不满足（必须写清原因，不许静默略过）
 */
export function beginScenario(id, title, goal) {
  const started = Date.now();
  const rec = {
    id,
    title,
    goal,
    steps: [],
    status: 'ok',
    notes: [],
    defectIds: [],
    startedAt: new Date().toISOString(),
    durationMs: 0,
  };
  scenarios.push(rec);
  console.log(`\n${'='.repeat(78)}\n[${id}] ${title}\n  目标：${goal}\n${'='.repeat(78)}`);
  return {
    step(action, expect, actual, ok, note = '') {
      const s = { action, expect: String(expect), actual: String(actual), ok: Boolean(ok), note };
      rec.steps.push(s);
      console.log(`  ${ok ? '✓' : '✗'} ${action}`);
      console.log(`      期望: ${s.expect}`);
      console.log(`      实测: ${s.actual}`);
      if (note) console.log(`      备注: ${note}`);
      if (!ok && rec.status === 'ok') rec.status = 'partial';
      return Boolean(ok);
    },
    observe(text) {
      rec.notes.push(text);
      console.log(`      ⊘ 观察: ${text}`);
    },
    fail(reason) {
      rec.status = 'fail';
      rec.notes.push(`失败：${reason}`);
      console.log(`      ✗ 场景失败：${reason}`);
    },
    skip(reason) {
      rec.status = 'skip';
      rec.notes.push(`跳过：${reason}`);
      console.log(`      ⊘ 跳过：${reason}`);
    },
    /** 登记一条缺陷（严重级 P0/P1/P2），并关联网到本场景 */
    defect(f) {
      const id2 = f.id || `D${String(findings.length + 1).padStart(2, '0')}`;
      const full = { id: id2, scenario: id, ...f, id: id2, foundAt: new Date().toISOString() };
      findings.push(full);
      rec.defectIds.push(id2);
      console.log(`      ⚠ 缺陷 [${id2}/${f.severity}] ${f.title}`);
      return full;
    },
    end() {
      rec.durationMs = Date.now() - started;
      console.log(`  -> ${rec.id} 结论：${rec.status}（${(rec.durationMs / 1000).toFixed(1)}s，${rec.steps.length} 步）`);
      return rec;
    },
  };
}

export function writeScenarioJson(filename, extra = {}) {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const file = path.join(RAW_DIR, filename);
  fs.writeFileSync(
    file,
    JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, api: API, scenarios, findings, ...extra }, null, 2),
    'utf8',
  );
  console.log(`\n原始数据已写：docs/AUDIT-150/raw/${filename}`);
  return file;
}

export function scenarioSummary() {
  const by = { ok: 0, partial: 0, fail: 0, skip: 0 };
  for (const s of scenarios) by[s.status] += 1;
  console.log(`\n${'='.repeat(78)}\n场景汇总\n${'='.repeat(78)}`);
  for (const s of scenarios) {
    console.log(`  ${s.id.padEnd(5)} ${s.status.padEnd(8)} ${(s.durationMs / 1000).toFixed(1).padStart(6)}s  ${s.title}`);
    for (const n of s.notes) console.log(`         · ${n}`);
    for (const d of s.defectIds) {
      const f = findings.find((x) => x.id === d);
      if (f) console.log(`         ⚠ [${f.id}/${f.severity}] ${f.title}`);
    }
  }
  const sev = { P0: 0, P1: 0, P2: 0 };
  for (const f of findings) sev[f.severity] = (sev[f.severity] ?? 0) + 1;
  console.log(
    `\n  完整可用 ${by.ok} / 有缺陷 ${by.partial} / 不可用 ${by.fail} / 跳过 ${by.skip}（共 ${scenarios.length}）`,
  );
  console.log(`  缺陷：P0 ${sev.P0} / P1 ${sev.P1} / P2 ${sev.P2}`);
  return { ...by, total: scenarios.length, severity: sev };
}

/* ============================== 页面工具 ============================== */

export async function waitUntil(page, fn, { timeout = 15000, interval = 250, arg = null } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await page.evaluate(fn, arg).catch(() => null);
    if (v) return v;
    await sleep(interval);
  }
  return null;
}

/**
 * 点击「按文案/标题匹配的元素」，并**报告是否真的点到**。
 *
 * 这是「死按钮」判定的基础原语：返回 { clicked, reason } —— 找不到元素时
 * 如实返回 false，绝不静默跳过（静默跳过会把「死按钮」误判成「功能正常」）。
 */
export async function clickByText(page, pattern, { selector = 'button, a, [role="button"]', nth = 0 } = {}) {
  return page.evaluate(
    ({ sel, pat, n }) => {
      const re = new RegExp(pat);
      const all = Array.from(document.querySelectorAll(sel)).filter((e) => {
        const t = `${e.getAttribute('title') || ''} ${e.textContent || ''} ${e.getAttribute('aria-label') || ''}`;
        return re.test(t);
      });
      if (!all.length) return { clicked: false, reason: `未找到匹配 ${pat} 的元素`, matches: 0 };
      const el = all[n];
      if (!el) return { clicked: false, reason: `匹配 ${all.length} 个但索引 ${n} 越界`, matches: all.length };
      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      const style = getComputedStyle(el);
      if (style.pointerEvents === 'none') return { clicked: false, reason: 'pointer-events:none', matches: all.length };
      if (!visible) return { clicked: false, reason: '元素零尺寸（不可见）', matches: all.length };
      el.click();
      return { clicked: true, matches: all.length, text: (el.textContent || '').trim().slice(0, 60) };
    },
    { sel: selector, pat: pattern, n: nth },
  );
}

/** 读取页面上的 toast/通知文案（各实现的 class 名不统一，做多选择器兜底）。 */
export async function readToasts(page) {
  return page.evaluate(() => {
    const sels = [
      '.nm-toast', '.toast', '.notification', '.nm-notification', '[class*="toast"]',
      '.el-message', '.ant-message-notice', '[data-testid*="toast"]', '.notice', '.nm-snackbar',
    ];
    const out = [];
    for (const s of sels) {
      document.querySelectorAll(s).forEach((e) => {
        const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) out.push({ sel: s, text: t.slice(0, 200) });
      });
    }
    return out;
  });
}

/** 通用「界面状态快照」，用于报告与死按钮判定。 */
export async function uiSnapshot(page) {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const text = (s) => (q(s)?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return {
      url: location.href,
      title: document.title,
      hasShell: Boolean(q('.shell__main')),
      hasProse: Boolean(q('.ProseMirror')),
      hasCm: Boolean(q('.cm-content')),
      hasReadView: Boolean(q('.read-view')),
      hasModal: Boolean(q('.nm-modal, [class*="modal"]')),
      tabs: Array.from(document.querySelectorAll('.tab')).map((t) => (t.textContent || '').trim().slice(0, 40)),
      bodyTextLen: (document.body.innerText || '').length,
      mainText: text('.shell__main'),
      activeTab: text('.tab.is-active, .tab--active'),
    };
  });
}

/* ============================== 控制台过错 ============================== */

/** 提取「UI 无感知但控制台报错」的条目（静默失败的硬证据）。 */
export function silentErrors(logs, sinceMarker = 0) {
  return {
    pageErrors: logs.pageErrors.slice(sinceMarker),
    consoleErrors: logs.consoleErrors.slice(sinceMarker),
  };
}

export function markLogs(logs) {
  return { pageErrors: logs.pageErrors.length, consoleErrors: logs.consoleErrors.length };
}

export function sinceMark(logs, mark) {
  return {
    pageErrors: logs.pageErrors.slice(mark.pageErrors),
    consoleErrors: logs.consoleErrors.slice(mark.consoleErrors),
    failedRequests: logs.failedRequests.slice(-15),
  };
}
