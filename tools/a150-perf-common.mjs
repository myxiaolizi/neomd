/**
 * Neo MD 1.5.0 性能与网络审计 —— 共享基础设施（由 audit-perf-common.mjs 改造）
 * =============================================================================
 * 与 1.4.0 版本的差异（只增不改语义，方便与历史数据对照）：
 *  - 输出目录 docs/AUDIT-150/raw（1.4.0 是 docs/AUDIT-140）
 *  - TARGETS 增加 `dist`：本地生产构建产物（apps/web/dist）由 `a150-perf-static.mjs`
 *    以 5180 端口托管（复刻产品 API 的 @fastify/static 配置 + 压缩），用于测「生产包」首屏
 *  - TARGETS.prod 保留但标记 `unavailable: true`（md.zhengl.vip 当前 502，不得作为性能目标）
 *  - 新增 DB 工具：直连隔离审计库 neomd_audit150b（只读 + 灌数，禁止任何生产库操作）
 *  - 新增 CDP 缓存控制：setCacheDisabled / clearBrowserCache，用于「冷/热缓存」两档
 *
 * ## 测量纪律（写进代码，防止自己造假）
 *  - **冷启动必须新开 BrowserContext**（缓存、ServiceWorker、HTTP cache 全空）。
 *    复用同一个 context 测出来的数字是热启动，不能声称冷启动。
 *  - 所有数字标注测量条件：{target, cache: cold|warm, network: origin|slow3g|..., n}
 *  - 每个指标多轮取中位数与 p95；单次测量不作结论。
 *  - 测量前后各取一次 `/api/health` 的 uptime，报告里注明 —— 若 uptime 回退说明服务
 *    中途被重启，该批次数据作废。
 *  - 长等待一律走 {@link waitResilient}（本机无头 Chrome 会 `Page crashed`）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根 = 本文件所在目录（tools/）的上一级。 */
export const ROOT = path.resolve(HERE, '..');
export const OUT_DIR = path.join(ROOT, 'docs', 'AUDIT-150');
export const RAW_DIR = path.join(OUT_DIR, 'raw');

/* ============================== 参数 ============================== */

export function parseArgs(argv) {
  const out = {
    target: 'both', // local | dist | both | prod
    only: null,
    json: null,
    timeout: 90000,
    rounds: 5,
    holdMs: 0,
    port: 5180,
  };
  for (const raw of argv) {
    const a = String(raw);
    if (a.startsWith('--target=')) out.target = a.slice(9);
    else if (a.startsWith('--only='))
      out.only = a
        .slice(7)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    else if (a.startsWith('--json=')) out.json = a.slice(7);
    else if (a.startsWith('--timeout=')) out.timeout = Number(a.slice(10)) || out.timeout;
    else if (a.startsWith('--rounds=')) out.rounds = Math.max(1, Number(a.slice(9)) || 5);
    else if (a.startsWith('--hold-ms=')) out.holdMs = Number(a.slice(10)) || 0;
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7)) || 5180;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

export const ARGS = parseArgs(process.argv.slice(2));

/**
 * 被测目标。
 *
 * `local` = vite dev（5178，按需编译，不是生产数字但能暴露开发期问题）
 * `dist`  = apps/web/dist 静态托管（5180，复刻产品 API 的静态托管语义 → 「生产包」真实首屏）
 * `prod`  = md.zhengl.vip —— **当前 502 不可用**，保留定义以便自动化脚本如实记录「不可测」
 */
export const TARGETS = {
  local: {
    id: 'local',
    label: '本地 dev (vite 5178)',
    base: 'http://127.0.0.1:5178',
    api: 'http://127.0.0.1:3200',
    isDev: true,
    appPath: '/app',
  },
  dist: {
    id: 'dist',
    label: '生产构建包 (dist@5180)',
    base: 'http://127.0.0.1:5180',
    api: 'http://127.0.0.1:3200',
    isDev: false,
    appPath: '/app',
  },
  prod: {
    id: 'prod',
    label: '生产 (md.zhengl.vip) —— 502 不可用',
    base: 'https://md.zhengl.vip',
    api: 'https://md.zhengl.vip',
    isDev: false,
    unavailable: true,
    unavailableReason: '线上 node 进程未监听 3200，站点返回 502 Bad Gateway（2026-11-02 实测）',
    appPath: '/app',
  },
};

export function pickTargets() {
  const T = TARGETS;
  switch (ARGS.target) {
    case 'both':
      return [T.local, T.dist];
    case 'all':
      return [T.local, T.dist, T.prod];
    case 'prod':
      return [T.prod];
    case 'local':
      return [T.local];
    case 'dist':
      return [T.dist];
    default:
      return [T.local, T.dist];
  }
}

/* ============================== 统计工具 ============================== */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const round = (n, d = 1) => {
  const f = 10 ** d;
  return Math.round(Number(n) * f) / f;
};

/**
 * 中位数 / 均值 / p95（最近秩法）。
 *
 * 性能数字必须给中位数而不是单次值：单次测量受 JIT、GC、系统负载影响极大。
 */
export function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, min: null, med: null, mean: null, p95: null, max: null };
  const med = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const p95 = v[Math.min(v.length - 1, Math.floor(v.length * 0.95))];
  return {
    n: v.length,
    min: round(v[0]),
    med: round(med),
    mean: round(mean),
    p95: round(p95),
    max: round(v[v.length - 1]),
  };
}

export function fmtStats(s, unit = 'ms') {
  if (!s || s.n === 0) return '无数据';
  return `中位 ${s.med}${unit}（min ${s.min} / p95 ${s.p95} / max ${s.max}, n=${s.n}）`;
}

export function table(rows, headers) {
  const cols = headers ?? Object.keys(rows[0] ?? {});
  if (!rows.length) return '(空)';
  const widths = cols.map((c) => Math.max(String(c).length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (cells) => `| ${cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join(' | ')} |`;
  const sep = `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`;
  return [line(cols), sep, ...rows.map((r) => line(cols.map((c) => r[c])))].join('\n');
}

/* ============================== Playwright ============================== */

/**
 * 多路径回退装载 Playwright。
 *
 * 本机**没有** playwright 顶层依赖（任务书已声明），只有 playwright-core；
 * 因此显式把它排在前面，并保留 pnpm store 的确切版本路径作为兜底。
 */
export async function loadChromium() {
  const candidates = [
    path.join(ROOT, 'node_modules/playwright-core/index.mjs'),
    path.join(ROOT, 'node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.mjs'),
    path.join(ROOT, 'apps/desktop/node_modules/playwright-core/index.mjs'),
  ];
  const errors = [];
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) {
        errors.push(`${c}: 文件不存在`);
        continue;
      }
      const mod = await import(pathToFileURL(c).href);
      const chromium = mod.chromium || mod.default?.chromium;
      if (chromium) return chromium;
      errors.push(`${c}: 无 chromium 导出`);
    } catch (e) {
      errors.push(`${c}: ${e.code || e.message}`);
    }
  }
  throw new Error(`无法加载 Playwright，尝试过：\n  - ${errors.join('\n  - ')}`);
}

/**
 * Chromium 启动参数。
 *
 * `--disable-gpu` 是硬要求：本机无头 Chrome 用默认参数约 30s 崩（连空白页都崩）。
 * `--js-flags=--expose-gc` 便于内存泄漏测量时强制 GC。
 */
export const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--js-flags=--expose-gc',
];

/** 统一的 viewport（性能数字对窗口尺寸敏感，必须固定） */
export const VIEWPORT = { width: 1600, height: 950 };

/* ============================== 凭据 ============================== */

export function auditPass() {
  const v = (process.env.AUDIT_PASS || process.env.SMOKE_PASS || '').trim();
  if (!v) {
    throw new Error('缺少审计凭据：请设置环境变量 AUDIT_PASS。例：$env:AUDIT_PASS=\'***\'; node tools/a150-perf-xx.mjs');
  }
  return v;
}

/** 登录拿 token（429 退避重试：限流 10 次/分钟）。 */
export async function login(apiBase) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(`${apiBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: process.env.AUDIT_USER || 'admin', password: auditPass() }),
    });
    const body = await res.json().catch(() => null);
    if (res.status === 200 && body?.ok) return body.data;
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') ?? 0) * 1000 || (attempt + 1) * 12_000;
      console.log(`  登录 429，等 ${Math.round(wait / 1000)}s 重试`);
      await sleep(wait);
      continue;
    }
    throw new Error(`登录失败 ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  }
  throw new Error('登录连续 429');
}

/** 服务健康快照（含 uptime，用于归因「数据是否受重启影响」） */
export async function health(apiBase) {
  try {
    const res = await fetch(`${apiBase}/api/health`, { signal: AbortSignal.timeout(15000) });
    const body = await res.json();
    return {
      ok: res.status === 200 && body?.ok === true,
      status: res.status,
      uptime: body?.uptime ?? null,
      version: body?.version ?? null,
      env: body?.env ?? null,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 120) };
  }
}

/* ============================== 计时 / HTTP ============================== */

export async function timedFetch(url, init = {}, { timeout = 30000 } = {}) {
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 160), totalMs: round(performance.now() - t0) };
  }
  const tHeaders = performance.now();
  const buf = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
  const tEnd = performance.now();
  const serverTiming = res.headers.get('server-timing') || '';
  const durs = [...serverTiming.matchAll(/dur=([\d.]+)/g)].map((m) => Number(m[1])).filter(Number.isFinite);
  return {
    ok: res.ok,
    status: res.status,
    ttfbMs: round(tHeaders - t0),
    bodyMs: round(tEnd - tHeaders),
    totalMs: round(tEnd - t0),
    bytes: buf.byteLength,
    contentEncoding: res.headers.get('content-encoding') || '',
    contentLength: res.headers.get('content-length') || '',
    serverTiming,
    serverDurMs: durs.length ? round(Math.max(...durs)) : null,
    cacheControl: res.headers.get('cache-control') || '',
    etag: res.headers.get('etag') || '',
    vary: res.headers.get('vary') || '',
    age: res.headers.get('age') || '',
    server: res.headers.get('server') || '',
    headers: Object.fromEntries(res.headers.entries()),
  };
}

/* ============================== CDP ============================== */

/** 建立浏览器 + 新 context + 新 page + CDP 会话。 */
export async function openPage(chromium, opts = {}) {
  const browser = opts.browser || (await chromium.launch({ args: LAUNCH_ARGS }));
  const ctxOptions = {
    viewport: opts.viewport || VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    ...(opts.storageState ? { storageState: opts.storageState } : {}),
  };
  const ctx = await browser.newContext(ctxOptions);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable').catch(() => {});
  await cdp.send('Network.enable').catch(() => {});
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e.message || e).slice(0, 200)));
  return { browser, ctx, page, cdp, jsErrors };
}

/**
 * 冷/热缓存开关。
 *
 * `Network.setCacheDisabled(true)` = 浏览器 HTTP 缓存失效（但不是「新 context」，
 * 内存缓存/ServiceWorker 仍在）。真正冷启动必须 **新开 BrowserContext**，见 openPage。
 */
export async function setCacheDisabled(cdp, disabled) {
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: Boolean(disabled) }).catch(() => {});
}

/** 注入登录态（localStorage token），避免 UI 登录产生 argon2 CPU 开销干扰测量 */
export async function injectAuth(ctx, auth, deviceId = 'audit-perf-150') {
  await ctx.addInitScript(
    ([a, r, u, dev]) => {
      try {
        localStorage.setItem('neomd.access', a);
        localStorage.setItem('neomd.refresh', r);
        localStorage.setItem('neomd.user.cache', u);
        localStorage.setItem('neomd.deviceId', dev);
      } catch {
        /* ignore */
      }
    },
    [auth.accessToken, auth.refreshToken, JSON.stringify(auth.user), deviceId],
  );
}

/** 读 CDP Performance 指标（键值对） */
export async function getMetrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const out = {};
  for (const m of metrics) out[m.name] = m.value;
  return out;
}

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
      if (dead >= 5) throw new Error(`浏览器实例等待期失联（连续 ${dead} 次探活失败），非测量结论`);
    }
  }
  return { alive, dead };
}

/**
 * 采集 Web Vitals（FCP / LCP / CLS / TTFB）+ 长任务 + **INP 代理指标**。
 *
 * 实现方式：**在页面加载前**通过 addInitScript 注入 PerformanceObserver。
 * 1.5.0 增补项：
 *  - event timing（`event` 类型）→ INP 代理（首屏交互延迟的最长事件）
 *  - 资源级 TTFB 分布
 */
export async function installVitalsCollector(ctx) {
  await ctx.addInitScript(() => {
    if (window.__vitalsInstalled) return;
    window.__vitalsInstalled = true;
    window.__vitals = { lcp: 0, lcpEl: '', cls: 0, longTasks: [], shifts: 0, events: [] };
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__vitals.lcp = Math.round(e.startTime);
          window.__vitals.lcpEl = e.element
            ? `${e.element.tagName}.${String(e.element.className).slice(0, 40)}`
            : e.url || '';
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {
      /* ignore */
    }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (!e.hadRecentInput) window.__vitals.cls += e.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      /* ignore */
    }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__vitals.longTasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      /* ignore */
    }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__vitals.events.push({
            name: e.name,
            start: Math.round(e.startTime),
            dur: Math.round(e.duration),
            processing: Math.round(e.processingEnd - e.processingStart),
            delay: Math.round(e.processingStart - e.startTime),
          });
        }
      }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
    } catch {
      /* ignore */
    }
  });
}

/** 读出已采集的 vitals */
export async function readVitals(page) {
  return page.evaluate(() => {
    const v = window.__vitals || {};
    const nav = performance.getEntriesByType('navigation')[0];
    const paints = performance.getEntriesByType('paint');
    const fcp = paints.find((p) => p.name === 'first-contentful-paint');
    const lts = v.longTasks || [];
    const evs = v.events || [];
    const inp = evs.length ? evs.reduce((m, x) => (x.dur > m.dur ? x : m), evs[0]) : null;
    return {
      fcp: fcp ? Math.round(fcp.startTime) : null,
      lcp: v.lcp || null,
      lcpEl: v.lcpEl || '',
      cls: Math.round((v.cls || 0) * 1000) / 1000,
      ttfb: nav ? Math.round(nav.responseStart) : null,
      domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      load: nav ? Math.round(nav.loadEventEnd) : null,
      domInteractive: nav ? Math.round(nav.domInteractive) : null,
      transferSize: nav ? nav.transferSize : null,
      encodedBodySize: nav ? nav.encodedBodySize : null,
      decodedBodySize: nav ? nav.decodedBodySize : null,
      longTaskCount: lts.length,
      longTaskTotal: lts.reduce((s, x) => s + x.dur, 0),
      longTaskMax: lts.length ? Math.max(...lts.map((x) => x.dur)) : 0,
      eventCount: evs.length,
      inpProxy: inp || null,
    };
  });
}

/* ============================== 数据库（隔离审计库） ============================== */

/**
 * 隔离审计库连接信息。
 *
 * **安全边界（写死在代码里）**：本审计只允许操作 `neomd_audit150b`。
 * 任何试图把 DB_NAME 改成 neomd（生产库）的调用都会被 assertAuditDb 直接拒绝。
 */
export const AUDIT_DB = {
  host: process.env.AUDIT_DB_HOST || 'tx.zhengl.vip',
  port: Number(process.env.AUDIT_DB_PORT || 3306),
  user: process.env.AUDIT_DB_USER || 'neomd_audit150b',
  password: process.env.AUDIT_DB_PASSWORD || '37700a7853ae36fa',
  database: process.env.AUDIT_DB_NAME || 'neomd_audit150b',
};

const PRODUCTION_DBS = new Set(['neomd', 'neomd_prod', 'neomd_production', 'information_schema_stats']);

export function assertAuditDb(name = AUDIT_DB.database) {
  if (PRODUCTION_DBS.has(name)) {
    throw new Error(`拒绝操作生产库 ${name}：本审计只允许 neomd_audit150b`);
  }
  if (name !== 'neomd_audit150b') {
    throw new Error(`拒绝操作非隔离库 ${name}：本审计只允许 neomd_audit150b`);
  }
  return name;
}

/** 加载 mysql2（仓库内只有 services/api 下的副本，用绝对路径导入） */
export async function loadMysql() {
  const candidates = [
    path.join(ROOT, 'node_modules/.pnpm/mysql2@3.24.6_@types+node@22.19.1/node_modules/mysql2/promise.js'),
    path.join(ROOT, 'services/api/node_modules/mysql2/promise.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const mod = await import(pathToFileURL(c).href);
      return mod.default || mod;
    }
  }
  throw new Error('找不到 mysql2 驱动');
}

export async function dbConnect() {
  assertAuditDb();
  const mysql = await loadMysql();
  const conn = await mysql.createConnection({ ...AUDIT_DB, connectTimeout: 15000, multipleStatements: false });
  return conn;
}

/* ============================== 输出 ============================== */

export function ensureDirs() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(RAW_DIR, { recursive: true });
}

/** 落原始数据（JSON），便于复核与二次分析 */
export function saveRaw(name, data) {
  ensureDirs();
  const p = path.join(RAW_DIR, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  console.log(`  原始数据 → docs/AUDIT-150/raw/${name}.json`);
  return p;
}

export function head(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

export function sub(title) {
  console.log(`\n--- ${title} ---`);
}
