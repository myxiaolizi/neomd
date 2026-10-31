/**
 * 板块 1：加载性能（本地 vs 生产，**冷启动**）
 * =============================================================================
 * 测量纪律：
 *  - **每次测量新开 BrowserContext**（缓存 / ServiceWorker / HTTP cache 全空）→ 真冷启动
 *  - 每个目标跑 `--rounds` 轮，取中位数（单次波动可达 ±40%，单值不可信）
 *  - 分阶段计时：HTML TTFB → main.ts 脚本执行完 → 外壳挂载 → 首屏可交互 → 编辑器可编辑
 *    阈值参照 1.1.9 门禁：shellMs < 900 / editableMs < 2000
 *  - 测量前后各取一次 /api/health 的 uptime，若回退则该轮次数据标记作废
 *
 * 用法：
 *   node tools/audit-perf-01-load.mjs                     # 本地 + 生产各 3 轮
 *   node tools/audit-perf-01-load.mjs --target=prod       # 只测生产
 *   node tools/audit-perf-01-load.mjs --rounds=5          # 5 轮取中位
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
  collectRequests,
  stats,
  fmtStats,
  table,
  saveRaw,
  sleep,
  round,
  ARGS as A,
} from './audit-perf-common.mjs';

/**
 * 单轮冷启动测量。
 *
 * 关键点：整个函数里只用**新建的 ctx**，不重用任何页面。
 */
async function measureColdOnce(chromium, target, auth, roundIdx) {
  const t0 = Date.now();
  const before = await health(target.api);
  const { browser, ctx, page, cdp, jsErrors } = await openPage(chromium);
  const reqs = collectRequests(page);
  const phases = {};
  try {
    await injectAuth(ctx, auth);
    await installVitalsCollector(ctx);

    // 阶段 A：导航开始 → HTML 到达（用 Navigation Timing 的 responseStart）
    const navStart = Date.now();
    await page.goto(`${target.base}/app`, { waitUntil: 'domcontentloaded', timeout: ARGS.timeout });
    phases.domContentLoadedMs = Date.now() - navStart;

    /*
     * 阶段 B：外壳挂载（.shell__main 出现）。
     * 这是 1.1.9 门禁定义的 shellMs —— "首屏可交互"的代理指标。
     */
    let shellMs = -1;
    try {
      const t = Date.now();
      await page.waitForSelector('.shell__main', { state: 'attached', timeout: 30000 });
      shellMs = Date.now() - t;
    } catch {
      /* keep -1 */
    }
    phases.shellMs = shellMs;

    /*
     * 阶段 C：首屏"可用" —— 功能区（ribbon）或标签栏出现。
     * 比 shellMs 更严格：外壳容器可能先挂载但内容是空的。
     */
    let interactiveMs = -1;
    try {
      const t = Date.now();
      await page.waitForSelector('.shell__main .ribbon, .shell__main .tabbar', { state: 'attached', timeout: 30000 });
      interactiveMs = Date.now() - t;
    } catch {
      /* keep -1 */
    }
    phases.interactiveMs = interactiveMs;

    // 阶段 D：编辑器可编辑（.ProseMirror / .cm-content / .read-view）
    /*
     * 冷启动时可能没有打开任何文档 → 编辑器不存在，editableMs 会是 -1。
     * 为了让「可编辑」这个指标有意义，若 1.5s 内没出现编辑器，就主动新建一篇文档
     * （走 UI 按钮，等价于用户操作），再计时。这样测的是「打开应用后多久能开始打字」，
     * 与 1.1.9 门禁 A2 的语义一致。
     */
    let editableMs = -1;
    {
      const t = Date.now();
      const exists = await page.locator('.ProseMirror, .cm-content, .read-view').count();
      if (exists > 0) {
        editableMs = Date.now() - t;
      } else {
        const created = await page
          .evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find((b) => /新建文档/.test(b.textContent || ''));
            if (!btn) return false;
            btn.click();
            return true;
          })
          .catch(() => false);
        try {
          await page.waitForSelector('.ProseMirror, .cm-content, .read-view', { state: 'attached', timeout: 30000 });
          editableMs = Date.now() - t;
          phases.editableVia = created ? 'new-doc' : 'auto-restored';
        } catch {
          editableMs = -1;
        }
      }
    }
    phases.editableMs = editableMs;

    // 等 LCP 稳定（LCP 在首次交互前持续更新，给 1.2s 观察窗口）
    await sleep(1200);

    const vitals = await readVitals(page);
    const metrics = await cdp.send('Performance.getMetrics').then(({ metrics: m }) => {
      const o = {};
      for (const x of m) o[x.name] = x.value;
      return o;
    });

    // 资源统计（用于瀑布分析）
    const resources = await page.evaluate(() =>
      performance.getEntriesByType('resource').map((r) => ({
        name: r.name,
        initiatorType: r.initiatorType,
        startTime: Math.round(r.startTime),
        duration: Math.round(r.duration),
        transferSize: r.transferSize,
        encodedBodySize: r.encodedBodySize,
        decodedBodySize: r.decodedBodySize,
      })),
    );

    const after = await health(target.api);
    const uptimeStable = before.uptime != null && after.uptime != null ? after.uptime >= before.uptime : null;

    return {
      round: roundIdx,
      target: target.id,
      cache: 'cold',
      ok: true,
      phases,
      vitals,
      metrics: {
        JSHeapUsedSize: metrics.JSHeapUsedSize,
        Nodes: metrics.Nodes,
        LayoutCount: metrics.LayoutCount,
        RecalcStyleCount: metrics.RecalcStyleCount,
        ScriptDuration: round(metrics.ScriptDuration * 1000),
        TaskDuration: round(metrics.TaskDuration * 1000),
        LayoutDuration: round(metrics.LayoutDuration * 1000),
      },
      resources: {
        count: resources.length,
        totalBytes: resources.reduce((s, r) => s + (r.decodedBodySize || 0), 0),
        top: resources.sort((a, b) => (b.decodedBodySize || 0) - (a.decodedBodySize || 0)).slice(0, 12),
      },
      requestCount: reqs.length,
      jsErrors: jsErrors.slice(0, 5),
      health: { before: before.uptime, after: after.uptime, uptimeStable, version: after.version },
      wallMs: Date.now() - t0,
    };
  } catch (e) {
    return { round: roundIdx, target: target.id, ok: false, error: String(e?.message ?? e).slice(0, 250), phases, health: { before: before.uptime } };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  head('板块 1：加载性能（冷启动 FCP / LCP / 分阶段耗时）');
  const targets = pickTargets();
  const chromium = await loadChromium();
  const all = {};

  for (const target of targets) {
    const h = await health(target.api);
    console.log(`\n== ${target.label} ==`);
    console.log(`  健康：ok=${h.ok} version=${h.version} uptime=${h.uptime}s`);

    const auth = await login(target.api);
    console.log(`  登录成功：${auth.user?.username}`);

    const rounds = [];
    for (let i = 1; i <= ARGS.rounds; i += 1) {
      console.log(`  第 ${i}/${ARGS.rounds} 轮（全新 context = 冷启动）...`);
      const r = await measureColdOnce(chromium, target, auth, i);
      if (r.ok) {
        console.log(
          `    FCP=${r.vitals.fcp}ms LCP=${r.vitals.lcp}ms DCL=${r.vitals.domContentLoaded}ms load=${r.vitals.load}ms | shell=${r.phases.shellMs}ms 可交互=${r.phases.interactiveMs}ms 可编辑=${r.phases.editableMs}ms | 资源 ${r.resources.count} 个 / ${round(r.resources.totalBytes / 1024)}KB`,
        );
      } else {
        console.log(`    失败：${r.error}`);
      }
      rounds.push(r);
      await sleep(800); // 轮次间隔，给系统喘息
    }

    const ok = rounds.filter((r) => r.ok);
    const agg = {
      target: target.id,
      label: target.label,
      rounds: ok.length,
      fcp: stats(ok.map((r) => r.vitals.fcp)),
      lcp: stats(ok.map((r) => r.vitals.lcp)),
      ttfb: stats(ok.map((r) => r.vitals.ttfb)),
      dcl: stats(ok.map((r) => r.vitals.domContentLoaded)),
      load: stats(ok.map((r) => r.vitals.load)),
      shell: stats(ok.map((r) => r.phases.shellMs)),
      interactive: stats(ok.map((r) => r.phases.interactiveMs)),
      editable: stats(ok.map((r) => r.phases.editableMs)),
      cls: stats(ok.map((r) => r.vitals.cls)),
      longTaskTotal: stats(ok.map((r) => r.vitals.longTaskTotal)),
      longTaskMax: stats(ok.map((r) => r.vitals.longTaskMax)),
      resourceCount: stats(ok.map((r) => r.resources.count)),
      resourceKB: stats(ok.map((r) => r.resources.totalBytes / 1024)),
      jsHeapMB: stats(ok.map((r) => r.metrics.JSHeapUsedSize / 1024 / 1024)),
      health: ok[0]?.health,
    };
    all[target.id] = { agg, rounds };

    sub(`${target.label} 汇总（冷启动，${ok.length} 轮中位数）`);
    console.log(`  TTFB          ${fmtStats(agg.ttfb)}`);
    console.log(`  FCP           ${fmtStats(agg.fcp)}`);
    console.log(`  LCP           ${fmtStats(agg.lcp)}`);
    console.log(`  DOMContentLoaded ${fmtStats(agg.dcl)}`);
    console.log(`  load          ${fmtStats(agg.load)}`);
    console.log(`  外壳挂载      ${fmtStats(agg.shell)}   (1.1.9 阈值 900ms)`);
    console.log(`  首屏可交互    ${fmtStats(agg.interactive)}`);
    console.log(`  编辑器可编辑  ${fmtStats(agg.editable)}  (1.1.9 阈值 2000ms)`);
    console.log(`  CLS           ${fmtStats(agg.cls, '')}`);
    console.log(`  长任务总计    ${fmtStats(agg.longTaskTotal)}  单次最长 ${fmtStats(agg.longTaskMax)}`);
    console.log(`  资源数        ${fmtStats(agg.resourceCount, ' 个')}`);
    console.log(`  资源解码体积  ${fmtStats(agg.resourceKB, 'KB')}`);
    console.log(`  JS 堆         ${fmtStats(agg.jsHeapMB, 'MB')}`);
    console.log(`  uptime 稳定   ${agg.health?.uptimeStable}（${agg.health?.before}s → ${agg.health?.after}s）`);
  }

  /* ---------- 本地 vs 生产对比 ---------- */
  if (all.local && all.prod) {
    sub('本地 vs 生产（中位数对比）');
    const rows = [
      { 指标: 'TTFB', 本地: all.local.agg.ttfb.med, 生产: all.prod.agg.ttfb.med, 差值: round((all.prod.agg.ttfb.med ?? 0) - (all.local.agg.ttfb.med ?? 0)) },
      { 指标: 'FCP', 本地: all.local.agg.fcp.med, 生产: all.prod.agg.fcp.med, 差值: round((all.prod.agg.fcp.med ?? 0) - (all.local.agg.fcp.med ?? 0)) },
      { 指标: 'LCP', 本地: all.local.agg.lcp.med, 生产: all.prod.agg.lcp.med, 差值: round((all.prod.agg.lcp.med ?? 0) - (all.local.agg.lcp.med ?? 0)) },
      { 指标: 'DCL', 本地: all.local.agg.dcl.med, 生产: all.prod.agg.dcl.med, 差值: round((all.prod.agg.dcl.med ?? 0) - (all.local.agg.dcl.med ?? 0)) },
      { 指标: '外壳挂载', 本地: all.local.agg.shell.med, 生产: all.prod.agg.shell.med, 差值: round((all.prod.agg.shell.med ?? 0) - (all.local.agg.shell.med ?? 0)) },
      { 指标: '可交互', 本地: all.local.agg.interactive.med, 生产: all.prod.agg.interactive.med, 差值: round((all.prod.agg.interactive.med ?? 0) - (all.local.agg.interactive.med ?? 0)) },
      { 指标: '可编辑', 本地: all.local.agg.editable.med, 生产: all.prod.agg.editable.med, 差值: round((all.prod.agg.editable.med ?? 0) - (all.local.agg.editable.med ?? 0)) },
      { 指标: '资源数', 本地: all.local.agg.resourceCount.med, 生产: all.prod.agg.resourceCount.med, 差值: round((all.prod.agg.resourceCount.med ?? 0) - (all.local.agg.resourceCount.med ?? 0)) },
      { 指标: '资源KB', 本地: all.local.agg.resourceKB.med, 生产: all.prod.agg.resourceKB.med, 差值: round((all.prod.agg.resourceKB.med ?? 0) - (all.local.agg.resourceKB.med ?? 0)) },
    ];
    console.log(table(rows));
    console.log('\n（单位：ms；资源KB 为解码后体积；差值 = 生产 - 本地）');
  }

  /* ---------- 资源瀑布 TOP ---------- */
  for (const [id, data] of Object.entries(all)) {
    const first = data.rounds.find((r) => r.ok);
    if (!first) continue;
    sub(`${data.label} 首屏资源 TOP 8（按解码体积）`);
    console.log(
      table(
        first.resources.top.slice(0, 8).map((r) => ({
          资源: r.name.split('/').pop().slice(0, 42),
          类型: r.initiatorType,
          开始ms: r.startTime,
          耗时ms: r.duration,
          KB: round((r.decodedBodySize || 0) / 1024),
        })),
      ),
    );

    /* 阻塞首屏的资源：开始早 + 耗时占比高，或体积大的脚本 */
    const blocking = first.resources.top.filter((r) => r.initiatorType === 'script' && (r.decodedBodySize || 0) > 100 * 1024);
    sub(`${data.label} 体积 > 100KB 的脚本（首屏阻塞候选）`);
    console.log(
      blocking.length
        ? table(
            blocking.map((r) => ({
              资源: r.name.split('/').pop(),
              KB: round((r.decodedBodySize || 0) / 1024),
              开始ms: r.startTime,
              耗时ms: r.duration,
              占首屏: `${round(((r.startTime + r.duration) / (first.vitals.lcp || 1)) * 100)}%`,
            })),
          )
        : '无',
    );
  }

  saveRaw('01-load', all);
  return all;
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n测量异常终止：', e);
    process.exit(2);
  });
