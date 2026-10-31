
/**
 * 审计脚本统一凭据入口（禁止硬编码生产密码）。
 *
 * 由 tools/audit-scrub-credentials.mjs 注入。原因见该脚本注释：
 * 生产管理员密码曾以明文出现在公开仓库的数十个文件里，属 P0 安全问题；
 * 审计脚本不得再复制这个错误。
 *
 * 本地跑法：
 *   PowerShell:  $env:AUDIT_PASS='<密码>'; node tools/audit-xxx.mjs
 *   bash:        AUDIT_PASS='<密码>' node tools/audit-xxx.mjs
 * 或放进 tools/.env（已在 .gitignore 中）后：
 *   node --env-file=tools/.env tools/audit-xxx.mjs
 */
function requireAuditPass() {
  const v = (process.env.AUDIT_PASS || process.env.SMOKE_PASS || '').trim();
  if (!v) {
    throw new Error(
      '缺少审计凭据：请设置环境变量 AUDIT_PASS（或 SMOKE_PASS）。\n' +
        '  例：$env:AUDIT_PASS=\'***\'; node tools/audit-xxx.mjs\n' +
        '  或：node --env-file=tools/.env tools/audit-xxx.mjs',
    );
  }
  return v;
}
/**
 * Neo MD 1.4.0 性能审计 —— 共享基础设施
 * =============================================================================
 * 本目录是性能审计的测量脚本集合（**只读审计，不改任何产品源码**）：
 *   common.mjs      参数 / Playwright 装载 / CDP 采集 / 统计工具 / 服务健康快照
 *   01-load.mjs     加载性能（本地 vs 生产，冷启动 FCP/LCP/分阶段）
 *   02-bundle.mjs   包体（gzip/brotli 真实传输量 + Coverage 未使用代码）
 *   03-runtime.mjs  运行时（长会话 / 大文档 / 多标签 / 内存泄漏）
 *   04-network.mjs  网络（TTFB / API TOP10 / 弱网 / 并发）
 *   05-backend.mjs  后端（服务端耗时 / N+1 / EXPLAIN / 静态资源来源）
 *
 * ## 测量纪律（写进代码，防止自己造假）
 *  - **冷启动必须新开 BrowserContext**（缓存、ServiceWorker、HTTP cache 全空）。
 *    复用同一个 context 测出来的数字是热启动，不能声称冷启动。
 *  - 所有数字标注测量条件：{target: local|prod, cache: cold|warm, network: origin|slow3g|...}
 *  - 测量前后各取一次 `/api/health` 的 uptime，报告里注明 —— 若 uptime 回退说明服务
 *    中途被重启，该批次数据作废（1.4.0 期间本地 API 多次崩过）。
 *  - 长等待一律走 {@link waitResilient}（本机无头 Chrome 会 `Page crashed`）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * 仓库根 = 本文件所在目录（tools/）的上一级。
 *
 * 注意：HERE 形如 `<repo>/tools`，因此只 `..` 一次。
 * （之前写成 `..`/`..` 会落到 `<repo>/..`，导致 node_modules 全找不到。）
 */
export const ROOT = path.resolve(HERE, '..');
export const OUT_DIR = path.join(ROOT, 'docs', 'AUDIT-140');
export const RAW_DIR = path.join(OUT_DIR, 'raw');

/* ============================== 参数 ============================== */

export function parseArgs(argv) {
  const out = {
    target: 'both', // local | prod | both
    only: null,
    json: null,
    timeout: 90000,
    rounds: 3,
    holdMs: 0,
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
    else if (a.startsWith('--rounds=')) out.rounds = Math.max(1, Number(a.slice(9)) || 3);
    else if (a.startsWith('--hold-ms=')) out.holdMs = Number(a.slice(10)) || 0;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

export const ARGS = parseArgs(process.argv.slice(2));

/** 被测目标。本地与生产都用同一套指标，便于横向对比。 */
export const TARGETS = {
  local: {
    id: 'local',
    label: '本地 dev (vite 5178)',
    base: 'http://127.0.0.1:5178',
    api: 'http://127.0.0.1:3200',
    /** vite dev 不压缩、按需编译，与生产不可直接比"包体"，但首屏耗时可比 */
    isDev: true,
  },
  prod: {
    id: 'prod',
    label: '生产 (md.zhengl.vip)',
    base: 'https://md.zhengl.vip',
    api: 'https://md.zhengl.vip',
    isDev: false,
  },
};

export function pickTargets() {
  if (ARGS.target === 'both') return [TARGETS.local, TARGETS.prod];
  const t = TARGETS[ARGS.target];
  return t ? [t] : [TARGETS.local, TARGETS.prod];
}

/* ============================== 统计工具 ============================== */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const round = (n, d = 1) => {
  const f = 10 ** d;
  return Math.round(Number(n) * f) / f;
};

/**
 * 中位数 / 均值 / p95。
 *
 * 性能数字必须给中位数而不是单次值：单次测量受 JIT、GC、系统负载影响极大，
 * 尤其是 200ms 量级的首屏，单次波动可以到 ±40%。
 */
export function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, min: null, med: null, mean: null, p95: null, max: null };
  const med = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const p95 = v[Math.min(v.length - 1, Math.floor(v.length * 0.95))];
  return { n: v.length, min: round(v[0]), med: round(med), mean: round(mean), p95: round(p95), max: round(v[v.length - 1]) };
}

export function fmtStats(s, unit = 'ms') {
  if (!s || s.n === 0) return '无数据';
  return `中位 ${s.med}${unit}（min ${s.min} / p95 ${s.p95} / max ${s.max}, n=${s.n}）`;
}

export function table(rows, headers) {
  const cols = headers ?? Object.keys(rows[0] ?? {});
  const widths = cols.map((c) => Math.max(String(c).length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (cells) => `| ${cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join(' | ')} |`;
  const sep = `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`;
  return [line(cols), sep, ...rows.map((r) => line(cols.map((c) => r[c])))].join('\n');
}

/* ============================== Playwright ============================== */

/**
 * 多路径回退装载 Playwright（沿用 re140/common.mjs，已验证可用）。
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
  throw new Error(`无法加载 Playwright，尝试过：\n  - ${errors.join('\n  - ')}`);
}

/**
 * Chromium 启动参数。
 *
 * `--disable-gpu` 是硬要求：本机无头 Chrome 用默认参数约 30s 崩（连空白页都崩）。
 * 额外加上 `--js-flags=--expose-gc` 便于内存泄漏测量时强制 GC。
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

/**
 * 登录拿 token（用于 API 测量与页面注入）。
 * 429 退避重试：限流 10 次/分钟。
 */
export async function login(apiBase) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(`${apiBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: process.env.AUDIT_USER || "admin", password: requireAuditPass() }),
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
    return { ok: res.status === 200 && body?.ok === true, status: res.status, uptime: body?.uptime ?? null, version: body?.version ?? null, env: body?.env ?? null };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 120) };
  }
}

/* ============================== 服务器计时（服务端处理耗时） ============================== */

/**
 * 用 `Server-Timing` 响应头 + fetch 分层计时测「服务端处理耗时」。
 *
 * 为什么不用 `node --cpu-prof`：那要重启 API 进程（禁止操作），
 * 且会污染正在跑的其它组的测量。用响应头 + 客户端分段计时能得到
 * 「TTFB 内有多少是服务端处理」的近似值，足以定位慢接口。
 */
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
  /**
   * 解析 Server-Timing 里的 dur（毫秒）。
   * 形如 `db;dur=12.3, total;dur=45.6` —— 取所有 dur 的最大值作为服务端总处理时间下界。
   */
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
    server: res.headers.get('server') || '',
  };
}

/* ============================== CDP 采集 ============================== */

/**
 * 建立 CDP 会话并打开一个页面。
 *
 * @param {object} chromium
 * @param {{blockScripts?:boolean, bypassCSP?:boolean}} opts
 */
export async function openPage(chromium, opts = {}) {
  const browser = await chromium.launch({ args: LAUNCH_ARGS });
  const ctxOptions = {
    viewport: opts.viewport || VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    // 冷启动的关键：不要复用任何持久化状态
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

/** 注入登录态（localStorage token），避免 UI 登录产生 argon2 CPU 开销干扰测量 */
export async function injectAuth(ctx, auth, deviceId = 'audit-perf-140') {
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

/**
 * 长等待的「分段可恢复」实现（复用 re140 的思路）。
 * 本机无头 Chrome 会 Page crashed，一次性 waitForTimeout(60s) 一旦崩掉就无法归因。
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
      if (dead >= 5) throw new Error(`浏览器实例等待期失联（连续 ${dead} 次探活失败），非测量结论`);
    }
  }
  return { alive, dead };
}

/**
 * 采集 Web Vitals（FCP / LCP / CLS / TTFB）+ 长任务。
 *
 * 实现方式：**在页面加载前**通过 addInitScript 注入 PerformanceObserver，
 * 把观测结果累积到 window.__vitals，加载后读出来。
 * 注意：LCP 在页面「首次交互」后停止更新，因此必须在交互前读取。
 */
export async function installVitalsCollector(ctx) {
  await ctx.addInitScript(() => {
    if (window.__vitalsInstalled) return;
    window.__vitalsInstalled = true;
    window.__vitals = { lcp: 0, lcpEl: '', cls: 0, longTasks: [], shifts: 0 };
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__vitals.lcp = Math.round(e.startTime);
          window.__vitals.lcpEl = e.element ? `${e.element.tagName}.${String(e.element.className).slice(0, 40)}` : (e.url || '');
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
    };
  });
}

/** 采集某次加载的全部网络请求（用于瀑布图与包体分析） */
export function collectRequests(page) {
  const reqs = [];
  page.on('response', async (res) => {
    try {
      const req = res.request();
      const type = req.resourceType();
      const url = res.url();
      const headers = await res.allHeaders().catch(() => ({}));
      reqs.push({
        url,
        type,
        status: res.status(),
        fromCache: res.fromServiceWorker() || false,
        encoding: headers['content-encoding'] || '',
        contentLength: Number(headers['content-length'] || 0),
        cacheControl: headers['cache-control'] || '',
      });
    } catch {
      /* ignore */
    }
  });
  return reqs;
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
  console.log(`  原始数据 → docs/AUDIT-140/raw/${name}.json`);
  return p;
}

export function head(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

export function sub(title) {
  console.log(`\n--- ${title} ---`);
}
