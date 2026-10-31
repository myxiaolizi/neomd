
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
 * 板块 4：网络速度（TTFB / API TOP10 / 弱网模拟 / 并发）
 * =============================================================================
 * 三个维度：
 *  ① **静态资源与 API 的 TTFB / 下载耗时**（本地 vs 生产）
 *  ② **弱网模拟**（CDP Network.emulateNetworkConditions）：Slow 3G / Fast 3G / 高延迟
 *     —— 看「首屏与关键操作是否还能用」，用**可用性 + 耗时**双重判据
 *  ③ **并发 20 请求**：观察响应时间退化
 *
 * ## 限流注意（重要）
 * 登录限流 10 次/分钟、`/api/vaults` 写 20 次/分钟。
 * 并发测试**只用只读 GET**，且控制在 20 个以内；登录**只做一次**并复用 token。
 * 若看到 429，说明撞限流了，该轮数据标记为 invalid（不是性能结论）。
 *
 * ## 弱网参数取值依据
 *  Chrome DevTools 预设（官方值）：
 *   Slow 3G:   down 500kbps / up 500kbps / latency 400ms
 *   Fast 3G:   down 1.6Mbps / up 750kbps / latency 150ms
 *   自定义高延迟: down 10Mbps / up 10Mbps / latency 600ms（模拟跨洲链路）
 *
 * 用法：
 *   node tools/audit-perf-04-network.mjs --target=both
 *   node tools/audit-perf-04-network.mjs --only=api,weak
 */

import {
  ARGS,
  head,
  sub,
  pickTargets,
  loadChromium,
  login,
  health,
  openPage,
  injectAuth,
  installVitalsCollector,
  readVitals,
  timedFetch,
  stats,
  fmtStats,
  table,
  saveRaw,
  sleep,
  round,
} from './audit-perf-common.mjs';

/** 需要测的 API 列表（全部只读 GET） */
const API_PROBES = [
  { name: 'headers/auth (轻)', path: '/api/health', auth: false },
  { name: 'settings 读取', path: '/api/settings?platform=desktop', auth: true },
  { name: 'settings 版本轮询', path: '/api/settings/version', auth: true },
  { name: 'vaults 列表', path: '/api/vaults', auth: true },
  { name: 'storage 根列举', path: '/api/storage/list?prefix=&maxKeys=50', auth: true },
  { name: 'storage docs 列举', path: '/api/storage/list?prefix=docs%2F&maxKeys=1000', auth: true },
  { name: 'plugins 市场(分页)', path: '/api/plugins/market?page=1&pageSize=20', auth: true },
  { name: 'plugins 我的', path: '/api/plugins/my', auth: true },
  { name: 'admin status', path: '/api/admin/status', auth: true },
  { name: 'admin users', path: '/api/admin/users?page=1&pageSize=20', auth: true },
  { name: 'admin vaults', path: '/api/admin/vaults', auth: true },
  { name: 'admin releases', path: '/api/admin/releases', auth: true },
  { name: 'admin dashboard', path: '/api/admin/dashboard', auth: true },
  { name: 'admin audit', path: '/api/admin/audit?page=1&pageSize=20', auth: true },
  { name: 'admin plugins', path: '/api/admin/plugins?page=1&pageSize=20', auth: true },
  { name: 'download list', path: '/api/download/list', auth: false },
];

/** 弱网预设（Chrome DevTools 官方值 + 自定义高延迟） */
const NETWORK_PROFILES = [
  { id: 'slow3g', label: 'Slow 3G', downloadThroughput: (500 * 1024) / 8, uploadThroughput: (500 * 1024) / 8, latency: 400 },
  { id: 'fast3g', label: 'Fast 3G', downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 150 },
  { id: 'highlat', label: '高延迟 600ms/10Mbps', downloadThroughput: (10 * 1024 * 1024) / 8, uploadThroughput: (10 * 1024 * 1024) / 8, latency: 600 },
];

/* ============================== ① API 耗时 ============================== */

async function measureApis(target, auth) {
  sub(`${target.label} API 耗时（每个 3 次取中位）`);
  const rows = [];
  for (const p of API_PROBES) {
    const runs = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await timedFetch(`${target.api}${p.path}`, {
        headers: p.auth ? { authorization: `Bearer ${auth.accessToken}` } : {},
      });
      runs.push(r);
      await sleep(120);
    }
    const ok = runs.filter((r) => r.ok);
    const rateLimited = runs.some((r) => r.status === 429);
    rows.push({
      name: p.name,
      path: p.path.slice(0, 46),
      status: runs[0]?.status,
      rateLimited,
      ttfb: stats(ok.map((r) => r.ttfbMs)),
      total: stats(ok.map((r) => r.totalMs)),
      serverDur: ok[0]?.serverDurMs ?? null,
      bytes: ok[0]?.bytes ?? 0,
      encoding: ok[0]?.contentEncoding || '',
    });
  }
  /* 按 total 中位数倒序 = TOP 慢接口 */
  rows.sort((a, b) => (b.total.med ?? 0) - (a.total.med ?? 0));
  console.log(
    table(
      rows.map((r) => ({
        接口: r.name,
        '状态': r.status,
        'TTFB中位': r.ttfb.med,
        '总耗时中位': r.total.med,
        'p95': r.total.p95,
        体积KB: round((r.bytes || 0) / 1024),
        压缩: r.encoding || '(none)',
      })),
    ),
  );
  return rows;
}

/* ============================== ② 登录耗时（argon2） ============================== */

async function measureLogin(target) {
  sub(`${target.label} 登录耗时（argon2 CPU 密集，单独测 3 次）`);
  const runs = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await timedFetch(`${target.api}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: process.env.AUDIT_USER || "admin", password: requireAuditPass() }),
    });
    runs.push(r);
    /* 登录限流 10 次/分钟：3 次安全，但拉开间隔更稳 */
    await sleep(1500);
  }
  const ok = runs.filter((r) => r.ok);
  const rateLimited = runs.filter((r) => r.status === 429).length;
  const s = stats(ok.map((r) => r.totalMs));
  console.log(`  TTFB ${fmtStats(stats(ok.map((r) => r.ttfbMs)))}`);
  console.log(`  总耗时 ${fmtStats(s)}；429 次数=${rateLimited}`);
  return { runs: runs.map((r) => ({ status: r.status, totalMs: r.totalMs, ttfbMs: r.ttfbMs })), total: s, rateLimited };
}

/* ============================== ③ 弱网模拟 ============================== */

/**
 * 弱网下测首屏 + 关键操作。
 *
 * 判据（双重）：
 *  - **可用性**：外壳挂载成功 + 编辑器可打开（不超时）
 *  - **耗时**：记录实际耗时，供对比
 * 只要「可用」就算通过；耗时数字用于说明「弱网下体验下降到什么程度」。
 */
async function measureWeakNetwork(chromium, target, auth) {
  const results = [];
  for (const profile of NETWORK_PROFILES) {
    sub(`${target.label} 弱网模拟：${profile.label}（down ${round(profile.downloadThroughput / 1024)}KB/s, latency ${profile.latency}ms）`);
    const { browser, ctx, page, cdp } = await openPage(chromium);
    try {
      await injectAuth(ctx, auth);
      /*
       * 必须装 vitals collector，否则 LCP 恒为 null ——
       * 首轮弱网测量就踩了这个坑（LCP=null 不是「没有 LCP」，是没装观测器）。
       */
      await installVitalsCollector(ctx);
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: profile.latency,
        downloadThroughput: profile.downloadThroughput,
        uploadThroughput: profile.uploadThroughput,
      });

      const t0 = Date.now();
      let shellMs = -1;
      let editableMs = -1;
      let fcp = null;
      let lcp = null;
      let navOk = false;
      let editableVia = '';
      try {
        await page.goto(`${target.base}/app`, { waitUntil: 'domcontentloaded', timeout: 150000 });
        navOk = true;
      } catch {
        /* 导航超时也算数据 */
      }
      if (navOk) {
        try {
          const t = Date.now();
          await page.waitForSelector('.shell__main', { state: 'attached', timeout: 120000 });
          shellMs = Date.now() - t;
        } catch {
          /* keep -1 */
        }
        /*
         * 关键操作：新建文档 → 编辑器可编辑。
         *
         * 弱网下超时要放宽（120s）：Slow 3G 下加载 599.8KB 就要 10s+，
         * 若沿用 90s 容易因为「Chrome 自己慢」而非「产品不可用」被判失败。
         * 同时记录 editableVia 标明是自动恢复还是新建。
         */
        try {
          const t = Date.now();
          const exists = await page.locator('.ProseMirror, .cm-content').count();
          if (exists === 0) {
            await page
              .evaluate(() => {
                const btn = Array.from(document.querySelectorAll('button')).find((b) => /新建文档/.test(b.textContent || ''));
                btn?.click();
              })
              .catch(() => {});
            editableVia = 'new-doc';
          } else {
            editableVia = 'auto-restored';
          }
          await page.waitForSelector('.ProseMirror, .cm-content', { state: 'attached', timeout: 120000 });
          editableMs = Date.now() - t;
        } catch {
          /* keep -1 */
        }
        /* 等 LCP 稳定一小段，再读 vitals */
        await sleep(1500);
        const v = await readVitals(page).catch(() => ({}));
        fcp = v.fcp ?? null;
        lcp = v.lcp ?? null;
      }

      const totalMs = Date.now() - t0;
      /*
       * 「可用」的判据要区分两件事：
       *  - 外壳挂载成功（能看见界面）
       *  - 编辑器可编辑（能开始工作）
       * 弱网下「可编辑」慢是可以接受的，但「完全不可用」才是问题。
       * 因此 usable 判据 = 外壳挂载成功；editable 单独记录。
       */
      const usable = navOk && shellMs > 0;
      results.push({
        profile: profile.id,
        label: profile.label,
        latency: profile.latency,
        downKBs: round(profile.downloadThroughput / 1024),
        navOk,
        shellMs,
        editableMs,
        editableVia,
        fcp,
        lcp,
        totalMs,
        usable,
      });
      console.log(
        `  导航=${navOk} 外壳=${shellMs}ms 可编辑=${editableMs}ms(${editableVia || '-'}) FCP=${fcp}ms LCP=${lcp}ms → **界面${usable ? '可用' : '不可用'}**`,
      );
    } finally {
      await browser.close().catch(() => {});
    }
  }
  return results;
}

/* ============================== ④ 并发 ============================== */

/**
 * 并发 20 个只读请求，观察退化。
 *
 * 对比「串行单发」与「并发 20」的同一接口耗时：
 *  若并发耗时 >> 串行耗时 × 1，说明存在队列/连接池瓶颈。
 * 选 `/api/health`（最轻、无限流风险）与 `/api/vaults` 各来一轮。
 */
async function measureConcurrency(target, auth) {
  sub(`${target.label} 并发 20 请求（只读，观察退化）`);
  const out = [];
  for (const probe of [
    { name: 'health（无鉴权）', path: '/api/health', auth: false },
    { name: 'vaults（有鉴权）', path: '/api/vaults', auth: true },
  ]) {
    // 基线：串行 3 次
    const serial = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await timedFetch(`${target.api}${probe.path}`, {
        headers: probe.auth ? { authorization: `Bearer ${auth.accessToken}` } : {},
      });
      serial.push(r.totalMs);
      await sleep(120);
    }

    // 并发 20
    const t0 = Date.now();
    const tasks = Array.from({ length: 20 }, () =>
      timedFetch(`${target.api}${probe.path}`, {
        headers: probe.auth ? { authorization: `Bearer ${auth.accessToken}` } : {},
      }),
    );
    const res = await Promise.all(tasks);
    const wallMs = Date.now() - t0;
    const ok = res.filter((r) => r.ok);
    const rl = res.filter((r) => r.status === 429).length;
    const lat = stats(ok.map((r) => r.totalMs));
    const serialMed = stats(serial).med;
    const degradation = serialMed ? round(lat.med / serialMed, 2) : null;

    out.push({ probe: probe.name, serialMedianMs: serialMed, concurrent: lat, wallMs, rateLimited: rl, okCount: ok.length, degradationX: degradation });
    console.log(
      `  ${probe.name}：串行中位 ${serialMed}ms → 并发20 中位 ${lat.med}ms（p95 ${lat.p95}ms，max ${lat.max}ms），墙钟 ${wallMs}ms，429=${rl}，退化 **${degradation}x**`,
    );
    await sleep(1200);
  }
  return out;
}

/* ============================== 主流程 ============================== */

async function main() {
  head('板块 4：网络速度（API TTFB/TOP10 慢接口 / 登录 / 弱网 / 并发）');
  const targets = pickTargets();
  const chromium = await loadChromium();
  const out = {};
  const only = ARGS.only;

  for (const target of targets) {
    const h = await health(target.api);
    console.log(`\n== ${target.label} ==`);
    console.log(`  uptime=${h.uptime}s version=${h.version} ok=${h.ok}`);
    if (!h.ok) {
      console.log(`  跳过：服务不可用`);
      out[target.id] = { skipped: true, health: h };
      continue;
    }
    const auth = await login(target.api);
    const before = await health(target.api);

    const result = {};
    if (!only || only.includes('api')) result.apis = await measureApis(target, auth);
    if (!only || only.includes('login')) result.login = await measureLogin(target);
    if (!only || only.includes('concurrency')) result.concurrency = await measureConcurrency(target, auth);
    if (!only || only.includes('weak')) result.weak = await measureWeakNetwork(chromium, target, auth);

    const after = await health(target.api);
    result.healthGuard = { before: before.uptime, after: after.uptime, stable: after.uptime >= before.uptime };
    console.log(`\n  uptime 稳定性：${result.healthGuard.before}s → ${result.healthGuard.after}s（${result.healthGuard.stable ? '稳定' : '⚠️ 回退，数据可疑'}）`);
    out[target.id] = { health: h, result };
    await sleep(1000);
  }

  saveRaw('04-network', out);
  return out;
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n测量异常终止：', e);
    process.exit(2);
  });
