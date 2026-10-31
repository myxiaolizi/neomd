/**
 * 补充测量：弱网「能看不能用」的用户体验细节
 * =============================================================================
 * 为什么需要单独测这个小脚本：
 *  §4.4 只证明了「编辑器打不开」，但没回答用户最关心的三个问题：
 *   1. 点了「新建文档」后，**多久**才有任何视觉反馈？
 *   2. 从点击到编辑器真正可用，**总共**多长？
 *   3. 期间界面上**有没有**任何 loading 提示（还是完全静默）？
 *
 * 这三条是「用户痛点」的实际形态，比「editable=-1」这个数字更能推动修复。
 *
 * 用法：node tools/audit-perf-06-weak-ux.mjs
 */

import {
  TARGETS,
  head,
  sub,
  loadChromium,
  login,
  health,
  openPage,
  injectAuth,
  installVitalsCollector,
  saveRaw,
  sleep,
  round,
} from './audit-perf-common.mjs';

const PROFILE = { id: 'slow3g', label: 'Slow 3G', latency: 400, downloadThroughput: (500 * 1024) / 8, uploadThroughput: (500 * 1024) / 8 };

/**
 * 在 Node 侧周期性采样（不依赖页面内变量存活）。
 *
 * 为什么改用 Node 侧：
 * 场景 1 需要跨越 `page.goto()`（导航会清空页面内所有 JS 状态），
 * 页面内 `window.__ux` 会被重置。Node 侧采样天然不受导航影响，
 * 且每次 evaluate 失败（导航中）可以容忍。
 */
function startPollingNode(page, intervalMs = 500) {
  const samples = [];
  const t0 = Date.now();
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      const s = await page.evaluate(() => {
        const txt = document.body?.innerText || '';
        return {
          pm: document.querySelectorAll('.ProseMirror').length,
          cm: document.querySelectorAll('.cm-content').length,
          tabs: document.querySelectorAll('.tab').length,
          shell: document.querySelectorAll('.shell__main').length,
          loadingText: /加载中|正在加载|请稍候|Loading|准备中|初始化/.test(txt),
          spinner: document.querySelector('.nm-spinner, [class*="spinner"], [class*="loading"], [class*="skeleton"], .docboot') !== null,
          bodyHead: txt.replace(/\s+/g, ' ').trim().slice(0, 120),
        };
      });
      samples.push({ t: Date.now() - t0, ...s });
    } catch {
      samples.push({ t: Date.now() - t0, nav: true });
    }
  }, intervalMs);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      const firstEditor = samples.find((x) => x.pm > 0 || x.cm > 0);
      const firstLoading = samples.find((x) => x.loadingText || x.spinner);
      return {
        samples,
        totalSamples: samples.length,
        firstEditorAt: firstEditor ? firstEditor.t : null,
        firstLoadingHintAt: firstLoading ? firstLoading.t : null,
        loadingHintEverAppeared: Boolean(firstLoading),
        lastSampleAt: samples.length ? samples[samples.length - 1].t : null,
      };
    },
  };
}

async function stopPolling(page) {
  return page
    .evaluate(() => {
      if (!window.__ux) return { samples: [], totalSamples: 0, firstEditorAt: null, firstLoadingHintAt: null, loadingHintEverAppeared: false, lastSampleAt: null, note: 'no-poll-data' };
      window.__ux.stop = true;
      const s = window.__ux.samples;
      /* 找关键时刻 */
      const firstEditor = s.find((x) => x.pm > 0 || x.cm > 0);
      const firstLoading = s.find((x) => x.loadingText || x.spinner);
      return {
        samples: s,
        totalSamples: s.length,
        firstEditorAt: firstEditor ? firstEditor.t : null,
        firstLoadingHintAt: firstLoading ? firstLoading.t : null,
        loadingHintEverAppeared: Boolean(firstLoading),
        lastSampleAt: s.length ? s[s.length - 1].t : null,
      };
    })
    .catch((e) => ({ samples: [], totalSamples: 0, firstEditorAt: null, firstLoadingHintAt: null, loadingHintEverAppeared: false, lastSampleAt: null, note: String(e?.message ?? e).slice(0, 80) }));
}

async function main() {
  head('补充：弱网「能看不能用」的用户体验细节（Slow 3G）');
  const t = TARGETS.prod;
  const h = await health(t.api);
  console.log(`生产：ok=${h.ok} uptime=${h.uptime}s version=${h.version}`);
  if (!h.ok) {
    console.error('生产不可用，无法测量');
    process.exit(2);
  }
  const auth = await login(t.api);
  const chromium = await loadChromium();

  const result = { profile: PROFILE, healthBefore: h.uptime };

  /* ---------- 场景 1：冷启动 → 外壳出现（量化首屏等待） ---------- */
  sub('场景 1：冷启动到外壳可交互');
  {
    const { browser, ctx, page, cdp } = await openPage(chromium);
    try {
      await injectAuth(ctx, auth);
      await installVitalsCollector(ctx);
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: PROFILE.latency,
        downloadThroughput: PROFILE.downloadThroughput,
        uploadThroughput: PROFILE.uploadThroughput,
      });
      const poller = startPollingNode(page, 500);
      const t0 = Date.now();
      await page.goto(`${t.base}/app`, { waitUntil: 'domcontentloaded', timeout: 150000 });
      await page.waitForSelector('.shell__main', { state: 'attached', timeout: 120000 });
      const shellAt = Date.now() - t0;
      /* 再等 8s 观察是否有 loading 反馈 */
      await page.waitForTimeout(8000);
      const poll = poller.stop();
      result.scenario1 = {
        shellAtMs: shellAt,
        ...poll,
        samples: poll.samples.slice(0, 40),
      };
      console.log(`  外壳挂载：${shellAt}ms`);
      console.log(`  加载提示是否出现过：${poll.loadingHintEverAppeared}（首次出现 ${poll.firstLoadingHintAt ?? '从未'}ms）`);
      console.log(`  界面前 3 个采样：`);
      for (const s of poll.samples.slice(0, 3)) console.log(`    ${String(s.t).padStart(6)}ms pm=${s.pm} tabs=${s.tabs} loading=${s.loadingText} spinner=${s.spinner} "${s.bodyHead.slice(0, 60)}"`);
    } finally {
      await browser.close().catch(() => {});
    }
  }

  /* ---------- 场景 2：点「新建文档」→ 编辑器可用（量化核心痛点） ---------- */
  sub('场景 2：点「新建文档」到编辑器可编辑');
  {
    const { browser, ctx, page, cdp } = await openPage(chromium);
    try {
      await injectAuth(ctx, auth);
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: PROFILE.latency,
        downloadThroughput: PROFILE.downloadThroughput,
        uploadThroughput: PROFILE.uploadThroughput,
      });
      await page.goto(`${t.base}/app`, { waitUntil: 'domcontentloaded', timeout: 150000 });
      await page.waitForSelector('.shell__main', { state: 'attached', timeout: 120000 });
      /* 等界面彻底稳定再点，确保测的是「点击后」的增量 */
      await page.waitForTimeout(3000);

      const poller2 = startPollingNode(page, 500);
      const tClick = Date.now();
      const clicked = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(
          (b) => /新建文档/.test(b.textContent || '') || /新建文档/.test(b.getAttribute('title') || ''),
        );
        if (!btn) return { ok: false };
        btn.click();
        return { ok: true, title: btn.getAttribute('title') || '', text: (btn.textContent || '').trim() };
      });

      /* 最多观察 60 秒，看什么时候编辑器出现 */
      let editorAt = null;
      for (let i = 0; i < 120; i += 1) {
        const has = await page.evaluate(() => document.querySelectorAll('.ProseMirror, .cm-content').length > 0).catch(() => false);
        if (has) {
          editorAt = Date.now() - tClick;
          break;
        }
        await sleep(500);
      }
      /* 再等 3s 让 polling 采到最终状态 */
      await sleep(3000);
      const poll = poller2.stop();

      result.scenario2 = {
        clicked,
        editorAppearedAtMs: editorAt,
        ...poll,
        samples: poll.samples.slice(0, 60),
      };
      console.log(`  点击按钮：${clicked.ok ? '成功（' + (clicked.title || clicked.text) + '）' : '未找到按钮'}`);
      console.log(`  编辑器出现：${editorAt === null ? '60 秒内未出现 ❌' : editorAt + 'ms'}`);
      console.log(`  加载提示是否出现过：${poll.loadingHintEverAppeared}（首次 ${poll.firstLoadingHintAt ?? '从未'}ms）`);
      console.log(`  过程采样（每 4 个取 1）：`);
      const s = poll.samples.filter((_, i) => i % 4 === 0);
      for (const x of s) {
        console.log(`    ${String(x.t).padStart(6)}ms pm=${x.pm} tabs=${x.tabs} loading=${x.loadingText} spinner=${x.spinner}`);
      }
    } finally {
      await browser.close().catch(() => {});
    }
  }

  const h2 = await health(t.api);
  result.healthAfter = h2.uptime;
  result.healthStable = h2.uptime >= h.uptime;
  console.log(`\nuptime：${h.uptime}s → ${h2.uptime}s（${result.healthStable ? '稳定' : '⚠️ 回退'}）`);

  saveRaw('06-weak-ux', result);
  process.exit(0);
}

main().catch((e) => {
  console.error('测量异常：', e);
  process.exit(2);
});
