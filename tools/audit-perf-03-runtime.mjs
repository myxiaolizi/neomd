/**
 * 板块 3：运行时性能（长会话 / 大文档 / 多标签 / 内存泄漏）
 * =============================================================================
 * 四个测量项，全部用 CDP 采集真实指标：
 *  ① **长会话**：连续输入 1000 字 + 插入 50 个块 + 滚到底 → FPS / 长任务 / 堆增长
 *  ② **大文档**：1 万字 + 100 标题 → 打开耗时 / 滚动 FPS / 搜索耗时
 *  ③ **多标签**：开 20 个标签 → 内存占用 / 切换耗时
 *  ④ **内存泄漏**：连续开关文档/面板 20 次 → 对比 JSHeapUsedSize
 *
 * ## FPS 怎么测才可信
 * 用 `requestAnimationFrame` 采样帧间隔，统计「帧间隔 > 20ms」的比例。
 * 不用 `Performance.getMetrics` 的 TaskDuration 反推 —— 那只给总耗时，不反映卡顿分布。
 * 测量期间必须**真的滚动/输入**，静态页面的 FPS 恒为 60 没有意义。
 *
 * ## 内存泄漏怎么判定
 * `JSHeapUsedSize` 单次读数会被 GC 时机影响。正确做法：
 *   1. 每步之前强制 GC（`--js-flags=--expose-gc` + `window.gc()`）
 *   2. 记录基线 → N 次循环 → 再强制 GC → 再记录
 *   3. **增长 > 30% 且绝对值 > 5MB** 才判为疑似泄漏（阈值写死，不事后调整）
 *
 * 用法：
 *   node tools/audit-perf-03-runtime.mjs                  # 全部四项
 *   node tools/audit-perf-03-runtime.mjs --only=leak      # 只测内存泄漏
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
  getMetrics,
  waitResilient,
  stats,
  fmtStats,
  table,
  saveRaw,
  sleep,
  round,
} from './audit-perf-common.mjs';

/* ============================== 工具 ============================== */

/** 强制 GC（依赖 --js-flags=--expose-gc） */
async function forceGC(page) {
  await page.evaluate(() => {
    if (typeof window.gc === 'function') {
      window.gc();
      window.gc();
    }
  });
  await sleep(400);
}

/** 读取堆大小（MB） */
async function heapMB(cdp) {
  const m = await getMetrics(cdp);
  return {
    usedMB: round((m.JSHeapUsedSize || 0) / 1024 / 1024, 2),
    totalMB: round((m.JSHeapTotalSize || 0) / 1024 / 1024, 2),
    nodes: m.Nodes || 0,
    documents: m.Documents || 0,
    listeners: m.JSEventListeners || 0,
  };
}

/**
 * 采一段 FPS。
 *
 * 实现：在页面里用 rAF 采样 durationMs，统计：
 *  - avgFps：总帧数 / 时长
 *  - p95FrameMs / maxFrameMs：帧间隔分位
 *  - jankPct：帧间隔 > 20ms 的比例（20ms ≈ 掉一帧）
 */
async function sampleFps(page, durationMs, { duringAction } = {}) {
  await page.evaluate(() => {
    window.__fps = { frames: [], start: 0, end: 0 };
    window.__fpsStop = false;
    const rec = (t) => {
      if (!window.__fps.start) window.__fps.start = t;
      window.__fps.frames.push(t);
      window.__fps.end = t;
      if (!window.__fpsStop) requestAnimationFrame(rec);
    };
    requestAnimationFrame(rec);
  });

  // 在采样期间持续执行动作（滚动），否则静态页面 FPS 没有参考价值
  if (duringAction) await duringAction(durationMs);
  else await waitResilient(page, durationMs, { step: 500 });

  const raw = await page.evaluate(() => {
    window.__fpsStop = true;
    const f = window.__fps.frames;
    const spans = [];
    for (let i = 1; i < f.length; i += 1) spans.push(f[i] - f[i - 1]);
    const dur = window.__fps.end - window.__fps.start;
    return { count: f.length, durMs: Math.round(dur), spans: spans.map((x) => Math.round(x * 10) / 10) };
  });

  const spans = raw.spans.slice().sort((a, b) => a - b);
  const p = (q) => (spans.length ? spans[Math.min(spans.length - 1, Math.floor(spans.length * q))] : null);
  const jank = spans.filter((x) => x > 20).length;
  return {
    fps: raw.durMs > 0 ? round((raw.count / raw.durMs) * 1000) : null,
    frames: raw.count,
    durMs: raw.durMs,
    p50FrameMs: p(0.5),
    p95FrameMs: p(0.95),
    maxFrameMs: spans.length ? spans[spans.length - 1] : null,
    jankFrames: jank,
    jankPct: spans.length ? round((jank / spans.length) * 100) : 0,
  };
}

/** 造大文档内容（1 万字 + 100 标题） */
function bigDocMarkdown(chars = 10000, headings = 100) {
  const perSection = Math.max(1, Math.floor(chars / headings));
  const lines = [];
  for (let i = 1; i <= headings; i += 1) {
    lines.push(`## 第 ${i} 节 · 标题样本 ${i}`);
    lines.push('');
    // 每节正文：凑够 perSection 字
    let sec = '';
    const sentence = `这是第 ${i} 节的一段正文，用于测量大文档的渲染与滚动性能，内容重复以填充体积。`;
    while (sec.length < perSection) sec += sentence;
    lines.push(sec.slice(0, perSection));
    lines.push('');
  }
  return lines.join('\n');
}

/** 通过 store 建文档并写入内容（避免逐字输入太慢） */
async function createDocWith(page, title, content) {
  return page.evaluate(
    async ({ t, c }) => {
      const app = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia?._s?.get?.('app');
      if (!app) return { ok: false, reason: 'no app store' };
      await app.createDoc({ title: t, content: c });
      await new Promise((r) => setTimeout(r, 1800));
      return { ok: true, docId: app.activeTab?.docId ?? null, path: app.activeTab?.path ?? null, contentLen: (app.activeTab?.content ?? '').length };
    },
    { t: title, c: content },
  );
}

/** 记录本次测量期间服务是否稳定 */
async function guard(target) {
  const h = await health(target.api);
  if (!h.ok) throw new Error(`服务不可用（${h.error || h.status}），本轮数据作废`);
  return h;
}

/* ============================== ① 长会话 ============================== */

async function testLongSession(chromium, target, auth) {
  sub('① 长时间编辑会话（输入 1000 字 + 插 50 块 + 滚到底）');
  const { browser, page, cdp } = await openPage(chromium);
  try {
    await injectAuth(await browser.newContext().then((c) => c), auth).catch(() => {});
    await page.goto(`${target.base}/app`, { waitUntil: 'load', timeout: ARGS.timeout });
    await page.waitForSelector('.shell__main', { timeout: 30000 });

    // 建一个空白文档作为画布
    const doc = await createDocWith(page, `AUDIT-PERF-LONG-${Date.now()}`, '');
    if (!doc.ok) return { ok: false, error: doc.reason };
    await page.waitForSelector('.ProseMirror', { timeout: 20000 });

    await forceGC(page);
    const before = await heapMB(cdp);

    /* ---- 输入 1000 字：模拟真实键入（insertText 比逐键快但对 IME 更真实）---- */
    const tTyping = Date.now();
    const fpsTyping = await sampleFps(page, 6000, {
      duringAction: async (dur) => {
        const chunk = '连续输入性能测量样本文字'.repeat(8); // 约 88 字
        const rounds = Math.ceil(1000 / 88);
        const perRoundSleep = Math.max(200, Math.floor(dur / rounds));
        for (let i = 0; i < rounds; i += 1) {
          await page
            .evaluate((s) => {
              const pm = document.querySelector('.ProseMirror');
              if (!pm) return;
              pm.focus();
              const sel = window.getSelection();
              const r = document.createRange();
              r.selectNodeContents(pm);
              r.collapse(false);
              sel.removeAllRanges();
              sel.addRange(r);
              document.execCommand('insertText', false, s);
            }, chunk)
            .catch(() => {});
          await sleep(perRoundSleep / 6);
        }
      },
    });
    const typingMs = Date.now() - tTyping;
    const afterTyping = await heapMB(cdp);
    const lenAfterTyping = await page.evaluate(() => (document.querySelector('.ProseMirror')?.innerText || '').length);

    /* ---- 插入 50 个块（模拟 50 次回车 + 内容）---- */
    const tBlocks = Date.now();
    const fpsBlocks = await sampleFps(page, 5000, {
      duringAction: async () => {
        for (let i = 0; i < 50; i += 1) {
          await page.evaluate((n) => {
            const pm = document.querySelector('.ProseMirror');
            if (!pm) return;
            pm.focus();
            const sel = window.getSelection();
            const r = document.createRange();
            r.selectNodeContents(pm);
            r.collapse(false);
            sel.removeAllRanges();
            sel.addRange(r);
            document.execCommand('insertText', false, `\n\n块 ${n}：插入的第 ${n} 个段落块，用于测试多块渲染。`);
          }, i).catch(() => {});
          await sleep(60);
        }
      },
    });
    const blocksMs = Date.now() - tBlocks;
    const afterBlocks = await heapMB(cdp);

    /* ---- 滚到底（连续滚动 4 秒）---- */
    const fpsScroll = await sampleFps(page, 4000, {
      duringAction: async (dur) => {
        const steps = 40;
        for (let i = 0; i < steps; i += 1) {
          await page
            .evaluate((ratio) => {
              const el = document.querySelector('.shell__doc') || document.querySelector('.shell__content');
              if (!el) return;
              el.scrollTop = (el.scrollHeight - el.clientHeight) * ratio;
            }, i / steps)
            .catch(() => {});
          await sleep(dur / steps);
        }
      },
    });
    const afterScroll = await heapMB(cdp);
    await forceGC(page);
    const afterGC = await heapMB(cdp);

    const growthMB = round(afterGC.usedMB - before.usedMB, 2);
    return {
      ok: true,
      doc,
      phases: {
        typingMs: round(typingMs),
        blocksMs: round(blocksMs),
        textCharsAfterTyping: lenAfterTyping,
      },
      fps: { typing: fpsTyping, blocks: fpsBlocks, scroll: fpsScroll },
      heap: { before, afterTyping, afterBlocks, afterScroll, afterGC, growthMB },
      longTasks: await page.evaluate(() => (window.__vitals?.longTasks || []).length),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/* ============================== ② 大文档 ============================== */

async function testBigDoc(chromium, target, auth) {
  sub('② 大文档（1 万字 + 100 标题）');
  const { browser, page, cdp } = await openPage(chromium);
  try {
    await page.goto(`${target.base}/app`, { waitUntil: 'load', timeout: ARGS.timeout });
    await page.waitForSelector('.shell__main', { timeout: 30000 });

    const md = bigDocMarkdown(10000, 100);
    const tCreate = Date.now();
    const doc = await createDocWith(page, `AUDIT-PERF-BIG-${Date.now()}`, md);
    const createMs = Date.now() - tCreate;
    if (!doc.ok) return { ok: false, error: doc.reason };

    // 等编辑器渲染完（大文档渲染慢，给足时间）
    const tRender = Date.now();
    await page.waitForSelector('.ProseMirror', { timeout: 30000 });
    const renderMs = Date.now() - tRender;

    await forceGC(page);
    const heap = await heapMB(cdp);

    /* 打开耗时 = 从点击到可编辑 */
    const tOpen = Date.now();
    await page.evaluate((id) => {
      const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
      return app.openDoc(id);
    }, doc.docId);
    await page.waitForSelector('.ProseMirror', { timeout: 20000 });
    // 等渲染稳定（一帧后再多等 300ms）
    await sleep(300);
    const reopenMs = Date.now() - tOpen;

    /* 滚动 FPS */
    const fpsScroll = await sampleFps(page, 5000, {
      duringAction: async (dur) => {
        const steps = 50;
        for (let i = 0; i < steps; i += 1) {
          await page
            .evaluate((ratio) => {
              const el = document.querySelector('.shell__doc') || document.querySelector('.shell__content');
              if (!el) return;
              el.scrollTop = (el.scrollHeight - el.clientHeight) * ratio;
            }, (i % 25) / 25)
            .catch(() => {});
          await sleep(dur / steps);
        }
      },
    });

    /* 搜索耗时：走 store 的 search */
    const searchTimes = [];
    for (const q of ['正文', '第 50 节', '性能']) {
      const t = Date.now();
      const hits = await page.evaluate((kw) => {
        const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
        try {
          return (app.search?.(kw, { limit: 60 }) ?? []).length;
        } catch {
          return -1;
        }
      }, q);
      searchTimes.push({ q, ms: Date.now() - t, hits });
      await sleep(200);
    }

    /* 大纲（100 标题）渲染 */
    const outline = await page.evaluate(() => {
      const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
      const st = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings');
      st.updateLayout({ rightPanelOpen: true, rightPanelSections: ['outline'] });
      return true;
    });
    await sleep(1500);
    const outlineInfo = await page.evaluate(() => {
      const pane = document.querySelector('.rightstack__pane');
      return { textLen: (pane?.textContent || '').length, itemCount: pane?.querySelectorAll('li, [class*="item"]').length ?? 0 };
    });

    return {
      ok: true,
      contentLen: md.length,
      headings: 100,
      phases: { createMs: round(createMs), renderMs: round(renderMs), reopenMs: round(reopenMs) },
      fpsScroll,
      searchTimes,
      outline: outlineInfo,
      heap,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/* ============================== ③ 多标签 ============================== */

async function testManyTabs(chromium, target, auth) {
  sub('③ 多标签（开 20 个）');
  const { browser, page, cdp } = await openPage(chromium);
  try {
    await page.goto(`${target.base}/app`, { waitUntil: 'load', timeout: ARGS.timeout });
    await page.waitForSelector('.shell__main', { timeout: 30000 });
    await forceGC(page);
    const before = await heapMB(cdp);

    const openTimes = [];
    for (let i = 1; i <= 20; i += 1) {
      const t = Date.now();
      const r = await createDocWith(page, `AUDIT-PERF-TAB-${i}-${Date.now()}`, `标签 ${i} 的内容样本\n\n用于多标签内存测量。`);
      openTimes.push(Date.now() - t);
      if (i % 5 === 0) {
        await forceGC(page);
        console.log(`    已开 ${i} 个标签，堆 ${(await heapMB(cdp)).usedMB}MB`);
      }
    }
    await forceGC(page);
    const after = await heapMB(cdp);
    const tabCount = await page.evaluate(() => {
      const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
      return app.tabs?.length ?? 0;
    });

    /* 切换耗时：在 20 个标签间来回切 */
    const switchTimes = [];
    for (let i = 0; i < 10; i += 1) {
      const t = Date.now();
      await page.evaluate((idx) => {
        const els = Array.from(document.querySelectorAll('.tab'));
        els[idx % els.length]?.click();
      }, i);
      await page.waitForTimeout(120);
      switchTimes.push(Date.now() - t);
    }

    return {
      ok: true,
      tabCount,
      openTimes,
      switchTimes,
      heap: { before, after, growthMB: round(after.usedMB - before.usedMB, 2), perTabMB: round((after.usedMB - before.usedMB) / 20, 2) },
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/* ============================== ④ 内存泄漏 ============================== */

async function testLeak(chromium, target, auth) {
  sub('④ 内存泄漏（连续开关文档/面板 20 次）');
  const { browser, page, cdp } = await openPage(chromium);
  try {
    await page.goto(`${target.base}/app`, { waitUntil: 'load', timeout: ARGS.timeout });
    await page.waitForSelector('.shell__main', { timeout: 30000 });

    // 先建 3 个文档做「开关」的对象
    const docs = [];
    for (let i = 0; i < 3; i += 1) {
      const d = await createDocWith(page, `AUDIT-PERF-LEAK-${i}-${Date.now()}`, `泄漏测试文档 ${i}\n\n`.repeat(50));
      if (d.ok) docs.push(d);
    }
    if (!docs.length) return { ok: false, error: '无法创建测试文档' };

    await forceGC(page);
    const baseline = await heapMB(cdp);
    console.log(`    基线堆：${baseline.usedMB}MB / ${baseline.nodes} nodes / ${baseline.listeners} listeners`);

    const samples = [];
    for (let round2 = 1; round2 <= 20; round2 += 1) {
      // 切到别的文档再切回（模拟开关文档）
      await page
        .evaluate(async (id) => {
          const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
          await app.openDoc(id);
        }, docs[round2 % docs.length].docId)
        .catch(() => {});
      await sleep(220);

      // 开关右侧栏面板（模拟开关面板）
      await page
        .evaluate((on) => {
          const st = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings');
          st.updateLayout({ rightPanelOpen: on, rightPanelSections: on ? ['outline'] : [] });
        }, round2 % 2 === 0)
        .catch(() => {});
      await sleep(220);

      if (round2 % 5 === 0) {
        await forceGC(page);
        const m = await heapMB(cdp);
        samples.push({ round: round2, ...m });
        console.log(`    第 ${round2} 次：${m.usedMB}MB / ${m.nodes} nodes / ${m.listeners} listeners`);
      }
    }

    await forceGC(page);
    await sleep(1000);
    await forceGC(page);
    const final = await heapMB(cdp);

    const growthMB = round(final.usedMB - baseline.usedMB, 2);
    const growthPct = baseline.usedMB ? round((growthMB / baseline.usedMB) * 100) : 0;
    const nodeGrowth = final.nodes - baseline.nodes;
    const listenerGrowth = final.listeners - baseline.listeners;

    /*
     * 泄漏判定阈值（写死，不事后调整）：
     *   堆增长 > 30% 且绝对值 > 5MB  → 疑似泄漏
     *   或者 nodes 增长 > 50%          → DOM 泄漏
     *   或者 listeners 增长 > 200      → 事件监听器泄漏
     */
    const leakSuspected = (growthPct > 30 && growthMB > 5) || (baseline.nodes ? nodeGrowth / baseline.nodes > 0.5 : false) || listenerGrowth > 200;

    return {
      ok: true,
      rounds: 20,
      baseline,
      final,
      growthMB,
      growthPct,
      nodeGrowth,
      listenerGrowth,
      samples,
      leakSuspected,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/* ============================== 主流程 ============================== */

async function main() {
  head('板块 3：运行时性能（长会话 / 大文档 / 多标签 / 内存泄漏）');
  const targets = pickTargets();
  const chromium = await loadChromium();
  const out = {};
  const only = ARGS.only;

  for (const target of targets) {
    const h = await guard(target);
    console.log(`\n== ${target.label} ==`);
    console.log(`  uptime=${h.uptime}s version=${h.version}`);
    const auth = await login(target.api);

    const runner = {
      long: () => testLongSession(chromium, target, auth),
      big: () => testBigDoc(chromium, target, auth),
      tabs: () => testManyTabs(chromium, target, auth),
      leak: () => testLeak(chromium, target, auth),
    };

    const result = {};
    for (const [key, fn] of Object.entries(runner)) {
      if (only && !only.includes(key)) continue;
      try {
        const r = await fn();
        result[key] = r;
        if (!r.ok) console.log(`  ✗ ${key} 失败：${r.error}`);
      } catch (e) {
        result[key] = { ok: false, error: String(e?.message ?? e).slice(0, 250) };
        console.log(`  ✗ ${key} 异常：${String(e?.message ?? e).slice(0, 160)}`);
      }
      await sleep(1200);
    }
    out[target.id] = { health: h, result };

    /* ---- 汇总打印 ---- */
    if (result.long?.ok) {
      const L = result.long;
      console.log(`\n  ① 长会话：输入 ${L.phases.textCharsAfterTyping} 字耗时 ${L.phases.typingMs}ms；插 50 块 ${L.phases.blocksMs}ms`);
      console.log(`     输入 FPS ${L.fps.typing.fps}（p95 帧 ${L.fps.typing.p95FrameMs}ms，卡顿 ${L.fps.typing.jankPct}%）`);
      console.log(`     插块 FPS ${L.fps.blocks.fps}（p95 帧 ${L.fps.blocks.p95FrameMs}ms，卡顿 ${L.fps.blocks.jankPct}%）`);
      console.log(`     滚动 FPS ${L.fps.scroll.fps}（p95 帧 ${L.fps.scroll.p95FrameMs}ms，卡顿 ${L.fps.scroll.jankPct}%）`);
      console.log(`     堆增长 ${L.heap.growthMB}MB（强制 GC 后）`);
    }
    if (result.big?.ok) {
      const B = result.big;
      console.log(`\n  ② 大文档：建 ${B.phases.createMs}ms / 首次渲染 ${B.phases.renderMs}ms / 重开 ${B.phases.reopenMs}ms`);
      console.log(`     滚动 FPS ${B.fpsScroll.fps}（p95 帧 ${B.fpsScroll.p95FrameMs}ms，卡顿 ${B.fpsScroll.jankPct}%）`);
      console.log(`     搜索：${B.searchTimes.map((s) => `${s.q}=${s.ms}ms(${s.hits} 命中)`).join(' / ')}`);
      console.log(`     大纲渲染 ${B.outline.textLen} 字符 / ${B.outline.itemCount} 项；堆 ${B.heap.usedMB}MB`);
    }
    if (result.tabs?.ok) {
      const T = result.tabs;
      console.log(`\n  ③ 多标签：${T.tabCount} 个标签，堆 ${T.heap.before.usedMB}→${T.heap.after.usedMB}MB（增长 ${T.heap.growthMB}MB，每标签 ${T.heap.perTabMB}MB）`);
      console.log(`     开标签耗时 ${fmtStats(stats(T.openTimes))}`);
      console.log(`     切标签耗时 ${fmtStats(stats(T.switchTimes))}`);
    }
    if (result.leak?.ok) {
      const K = result.leak;
      console.log(`\n  ④ 内存泄漏：20 轮后 堆 ${K.baseline.usedMB}→${K.final.usedMB}MB（${K.growthMB >= 0 ? '+' : ''}${K.growthMB}MB，${K.growthPct}%）`);
      console.log(`     nodes ${K.baseline.nodes}→${K.final.nodes}（${K.nodeGrowth >= 0 ? '+' : ''}${K.nodeGrowth}）`);
      console.log(`     listeners ${K.baseline.listeners}→${K.final.listeners}（${K.listenerGrowth >= 0 ? '+' : ''}${K.listenerGrowth}）`);
      console.log(`     判定：${K.leakSuspected ? '⚠️ 疑似泄漏' : '✅ 未见明显泄漏'}`);
    }
  }

  saveRaw('03-runtime', out);
  return out;
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n测量异常终止：', e);
    process.exit(2);
  });
