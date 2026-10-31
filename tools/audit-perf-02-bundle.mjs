/**
 * 板块 2：包体分析（gzip/brotli 真实传输量 + 未使用代码占比）
 * =============================================================================
 * 三个测量维度，缺一不可：
 *  ① **磁盘体积**：dist/assets 下的原始文件大小（这是「开发看到的数字」）
 *  ② **真实传输量**：HTTP 响应头的 content-encoding + content-length
 *     （gzip/brotli 后实际要下载的字节数 —— 这才是用户付流量和时间的地方）
 *  ③ **未使用代码占比**：CDP `Profiler.startPreciseCoverage` 采 JS 字节覆盖
 *     （体积大但用得多的 chunk 不该砍；体积大且用得少的才是优化目标）
 *
 * 关键区分：
 *  - 磁盘 543.8KB 的 codemirror，若 gzip 后只传 160KB，那「首屏多 543KB」的说法就是错的；
 *  - 若它覆盖率只有 8%，那即使传输量不大，解析/编译成本也白付了。
 *
 * 用法：
 *   node tools/audit-perf-02-bundle.mjs                  # 本地 dist + 生产
 *   node tools/audit-perf-02-bundle.mjs --target=local   # 只测本地
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ARGS,
  ROOT,
  TARGETS,
  head,
  sub,
  pickTargets,
  loadChromium,
  login,
  health,
  openPage,
  injectAuth,
  table,
  saveRaw,
  round,
  sleep,
} from './audit-perf-common.mjs';

const DIST_DIR = path.join(ROOT, 'apps', 'web', 'dist', 'assets');

/* ============================== ① 磁盘体积 ============================== */

function scanDist() {
  if (!fs.existsSync(DIST_DIR)) return { ok: false, reason: `dist 目录不存在：${DIST_DIR}` };
  const files = fs
    .readdirSync(DIST_DIR)
    .map((name) => {
      const p = path.join(DIST_DIR, name);
      const st = fs.statSync(p);
      return { name, bytes: st.size, ext: path.extname(name) };
    })
    .sort((a, b) => b.bytes - a.bytes);
  const js = files.filter((f) => f.ext === '.js');
  const css = files.filter((f) => f.ext === '.css');
  return {
    ok: true,
    dir: DIST_DIR,
    total: files.reduce((s, f) => s + f.bytes, 0),
    jsTotal: js.reduce((s, f) => s + f.bytes, 0),
    cssTotal: css.reduce((s, f) => s + f.bytes, 0),
    fileCount: files.length,
    files,
    top: files.slice(0, 20),
  };
}

/* ============================== ② 真实传输量 ============================== */

/**
 * 通过 Playwright 加载页面并记录**每个资源的响应头**，得到 gzip/brotli 后的传输量。
 *
 * 为什么要走浏览器而不是直接 HTTP 请求：
 *  浏览器会自动带 `Accept-Encoding: gzip, deflate, br`，服务端才会返回压缩版本。
 *  用 node fetch 手动加也行，但浏览器的 header 组合最接近真实用户。
 */
async function measureTransfer(chromium, target, auth) {
  const { browser, ctx, page } = await openPage(chromium);
  const records = [];
  try {
    await injectAuth(ctx, auth);

    page.on('response', async (res) => {
      try {
        const req = res.request();
        const type = req.resourceType();
        if (!['script', 'stylesheet', 'document', 'font', 'fetch', 'xhr'].includes(type)) return;
        const headers = await res.allHeaders().catch(() => ({}));
        const url = res.url();
        const size = await res.request().sizes().catch(() => null);
        records.push({
          url,
          name: url.split('/').pop().split('?')[0].slice(0, 60),
          type,
          status: res.status(),
          encoding: headers['content-encoding'] || '(none)',
          headersLength: Number(headers['content-length'] || 0),
          // Playwright 的 sizes() 给的是「网络实际传输字节」，比 content-length 更准（含 header）
          wireBytes: size?.responseBodySize ?? null,
          headerBytes: size?.responseHeadersSize ?? null,
          decodedBytes: size?.responseBodySize != null ? null : null,
          cacheControl: headers['cache-control'] || '',
          server: headers['server'] || '',
        });
      } catch {
        /* ignore */
      }
    });

    await page.goto(`${target.base}/app`, { waitUntil: 'load', timeout: ARGS.timeout });
    await page.waitForSelector('.shell__main', { timeout: 30000 }).catch(() => {});
    await sleep(2500);

    // 从 Resource Timing 拿解码后体积（transferSize=线上传输，decodedBodySize=解码后）
    const rt = await page.evaluate(() =>
      performance.getEntriesByType('resource').map((r) => ({
        name: r.name.split('/').pop().split('?')[0],
        type: r.initiatorType,
        transferSize: r.transferSize,
        encodedBodySize: r.encodedBodySize,
        decodedBodySize: r.decodedBodySize,
        duration: Math.round(r.duration),
      })),
    );

    return { ok: true, records, rt, target: target.id };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200), records, rt: [] };
  } finally {
    await browser.close().catch(() => {});
  }
}

/* ============================== ③ 未使用代码（Coverage） ============================== */

/**
 * 用 CDP `Profiler.startPreciseCoverage` 采 JS 字节覆盖。
 *
 * 原理：开启后 V8 会记录每个函数是否被执行过。加载完成（且用户完成一次典型操作）后
 * 调 `takePreciseCoverage`，得到每个脚本的 totalBytes / usedBytes。
 * 「未使用占比」= 1 - used/total —— 这是「首屏加载了但根本没跑」的代码比例。
 *
 * 注意：必须 `detailed: true` 才能按脚本聚合并拿到源码长度；
 * 且测量期间**不要**触发懒加载以外的额外交互，否则覆盖率会被抬高（显得"用得更多"）。
 */
async function measureCoverage(chromium, target, auth) {
  const { browser, ctx, page, cdp } = await openPage(chromium);
  try {
    await injectAuth(ctx, auth);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });

    await page.goto(`${target.base}/app`, { waitUntil: 'load', timeout: ARGS.timeout });
    await page.waitForSelector('.shell__main', { timeout: 30000 }).catch(() => {});
    await sleep(3000);

    /* 记录「未交互」状态下的覆盖率（这是首屏真实用到的代码） */
    const baseline = await cdp.send('Profiler.takePreciseCoverage');

    /* 再模拟一次典型操作：打开一篇文档（让编辑器代码真正跑起来），对比增量 */
    const interacted = await page
      .evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => /新建文档/.test(b.textContent || ''));
        if (!btn) return false;
        btn.click();
        return true;
      })
      .catch(() => false);
    await sleep(3000);
    const afterEdit = await cdp.send('Profiler.takePreciseCoverage');
    await cdp.send('Profiler.stopPreciseCoverage').catch(() => {});

    const scripts = await page.evaluate(() => {
      // 把 script URL 列表拿到（覆盖率结果里只有 scriptId，需要映射）
      return performance
        .getEntriesByType('resource')
        .filter((r) => r.initiatorType === 'script')
        .map((r) => r.name);
    });

    return { ok: true, baseline, afterEdit, scripts, interacted, target: target.id };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** 把 Coverage 结果按 URL 聚合 */
async function summarizeCoverage(coverage, cdpPageMap) {
  const byUrl = new Map();
  for (const s of coverage.result || []) {
    const url = s.url || '(inline)';
    if (!url.startsWith('http')) continue;
    let total = 0;
    let used = 0;
    for (const fn of s.functions || []) {
      for (const r of fn.ranges || []) {
        const len = r.endOffset - r.startOffset;
        total += len;
        if (r.count > 0) used += len;
      }
    }
    const cur = byUrl.get(url) || { url, total: 0, used: 0, functions: 0 };
    cur.total += total;
    cur.used += used;
    cur.functions += (s.functions || []).length;
    byUrl.set(url, cur);
  }
  return [...byUrl.values()]
    .map((x) => ({
      ...x,
      name: x.url.split('/').pop().split('?')[0].slice(0, 46),
      usedKB: round(x.used / 1024),
      totalKB: round(x.total / 1024),
      unusedKB: round((x.total - x.used) / 1024),
      unusedPct: x.total ? round(((x.total - x.used) / x.total) * 100) : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

/* ============================== 主流程 ============================== */

async function main() {
  head('板块 2：包体分析（磁盘体积 / 真实传输量 / 未使用代码占比）');
  const out = {};

  /* ---------- ① 磁盘 ---------- */
  sub('① dist 磁盘体积（本地构建产物）');
  const dist = scanDist();
  out.dist = dist;
  if (dist.ok) {
    console.log(`目录：${dist.dir}`);
    console.log(`文件数 ${dist.fileCount}；总计 ${round(dist.total / 1024)}KB（JS ${round(dist.jsTotal / 1024)}KB / CSS ${round(dist.cssTotal / 1024)}KB）`);
    console.log(
      table(
        dist.top.slice(0, 15).map((f) => ({
          文件: f.name,
          类型: f.ext.replace('.', ''),
          KB: round(f.bytes / 1024),
        })),
      ),
    );
  } else {
    console.log(`跳过：${dist.reason}`);
  }

  const targets = pickTargets();
  const chromium = await loadChromium();

  for (const target of targets) {
    const h = await health(target.api);
    if (!h.ok) {
      console.log(`\n== ${target.label} ==\n  跳过：服务不可用（${h.error || h.status}）`);
      out[target.id] = { skipped: true, health: h };
      continue;
    }
    console.log(`\n== ${target.label} ==`);
    console.log(`  uptime=${h.uptime}s version=${h.version}`);
    const auth = await login(target.api);

    /* ---------- ② 真实传输量 ---------- */
    sub(`${target.label} 真实传输量（含 content-encoding）`);
    const tr = await measureTransfer(chromium, target, auth);
    out[`${target.id}_transfer`] = tr;
    if (tr.ok) {
      const jsCss = tr.records.filter((r) => r.type === 'script' || r.type === 'stylesheet');
      const withEncoding = jsCss.filter((r) => r.encoding && r.encoding !== '(none)');
      const encKinds = [...new Set(jsCss.map((r) => r.encoding))];
      console.log(`脚本/样式资源 ${jsCss.length} 个；带压缩 ${withEncoding.length} 个；编码类型=${JSON.stringify(encKinds)}`);

      /* 用 Resource Timing 的 encodedBodySize（= 线上传输字节，不含头） */
      const rtJsCss = tr.rt.filter((r) => /\.(js|css)$/.test(r.name) || r.type === 'script' || r.type === 'link');
      const sumEncoded = rtJsCss.reduce((s, r) => s + (r.encodedBodySize || 0), 0);
      const sumDecoded = rtJsCss.reduce((s, r) => s + (r.decodedBodySize || 0), 0);
      const ratio = sumDecoded ? round((sumEncoded / sumDecoded) * 100) : null;
      console.log(
        `JS/CSS 合计：解码后 ${round(sumDecoded / 1024)}KB → **线上传输 ${round(sumEncoded / 1024)}KB**（压缩比 ${ratio}%）`,
      );

      const top = rtJsCss
        .map((r) => ({
          资源: r.name.slice(0, 46),
          解码KB: round((r.decodedBodySize || 0) / 1024),
          传输KB: round((r.encodedBodySize || 0) / 1024),
          压缩率: r.decodedBodySize ? `${round((1 - r.encodedBodySize / r.decodedBodySize) * 100)}%` : '-',
          耗时ms: r.duration,
        }))
        .sort((a, b) => b.解码KB - a.解码KB)
        .slice(0, 12);
      console.log(table(top));

      /* HTML 本身是否压缩 */
      const doc = tr.records.find((r) => r.type === 'document');
      if (doc) console.log(`HTML：encoding=${doc.encoding} content-length=${doc.headersLength}B cache-control=${doc.cacheControl.slice(0, 40)}`);
    } else {
      console.log(`  失败：${tr.error}`);
    }

    /* ---------- ③ Coverage ---------- */
    sub(`${target.label} 未使用代码占比（CDP Profiler Coverage）`);
    const cov = await measureCoverage(chromium, target, auth);
    out[`${target.id}_coverage`] = cov;
    if (cov.ok) {
      const base = await summarizeCoverage(cov.baseline);
      const edit = await summarizeCoverage(cov.afterEdit);
      const baseTotal = base.reduce((s, x) => s + x.totalKB, 0);
      const baseUnused = base.reduce((s, x) => s + x.unusedKB, 0);
      const editTotal = edit.reduce((s, x) => s + x.totalKB, 0);
      const editUnused = edit.reduce((s, x) => s + x.unusedKB, 0);

      console.log(
        `首屏（无交互）：合计 ${round(baseTotal)}KB，未使用 ${round(baseUnused)}KB = **${baseTotal ? round((baseUnused / baseTotal) * 100) : 0}%**`,
      );
      console.log(
        `打开文档后：合计 ${round(editTotal)}KB，未使用 ${round(editUnused)}KB = **${editTotal ? round((editUnused / editTotal) * 100) : 0}%**`,
      );
      console.log(`（打开文档动作=${cov.interacted}）`);

      console.log(`\n首屏未使用代码 TOP 10（按总量排序）：`);
      console.log(
        table(
          base.slice(0, 10).map((x) => ({
            脚本: x.name,
            总KB: x.totalKB,
            已用KB: x.usedKB,
            未用KB: x.unusedKB,
            未用占比: `${x.unusedPct}%`,
          })),
        ),
      );

      out[`${target.id}_coverageSummary`] = {
        baseline: { totalKB: round(baseTotal), unusedKB: round(baseUnused), unusedPct: baseTotal ? round((baseUnused / baseTotal) * 100) : 0 },
        afterEdit: { totalKB: round(editTotal), unusedKB: round(editUnused), unusedPct: editTotal ? round((editUnused / editTotal) * 100) : 0 },
        top: base.slice(0, 20),
      };
    } else {
      console.log(`  失败：${cov.error}`);
    }
  }

  saveRaw('02-bundle', out);
  return out;
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n测量异常终止：', e);
    process.exit(2);
  });
