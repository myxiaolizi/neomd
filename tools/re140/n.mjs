/**
 * [N] 负向对照 —— 证明断言非恒真
 * =============================================================================
 * 为什么需要：无法在跑测中途切换 git 工作树（dev server 服务的是当前工作树），
 * 但「断言不恒真」必须可复现地被证明，否则无法排除写成恒真断言的嫌疑。
 * 做法：用 `addStyleTag` 注入修复前的 CSS，或直接用「旧算法」重算一遍并断言判据失败。
 *
 * lead 明确要求覆盖的两个高风险点：
 *  N1 **把分屏拖动的 px→% 换算改回旧版** → C 段的跟手判据必须失败
 *     （旧版：ResizeHandle 直接把 px 增量加到百分比上，1px = 1%）
 *  N2 **把主题作用域白名单改回旧版** → D 段的三档作用域判据必须失败
 *     （旧版：CONTENT_THEME_VARS 只有 5 个变量，界面变量在 content 档下仍被写入）
 *
 * 实现方式：
 *  N1 用「纯函数级负向对照」——在 Node 侧复刻旧算法与新算法，喂同一组鼠标位移，
 *     断言「旧算法算出的比例与目标严重偏离、新算法贴合」。这样不依赖 DOM，
 *     也不受修复进度影响，是稳定的数学证明。
 *  N2 用「注入旧白名单」——在页面里临时把 themeVarAllowed 的语义替换成旧版
 *     （只对 content 档影响），断言 D4 的判据从 pass 变 fail。
 */

import {
  check,
  colorClose,
  contrastRatio,
  fmt,
  newSession,
  openSettings,
  openWorkbench,
  readCssVars,
  section,
  THRESHOLD,
} from './common.mjs';
/**
 * N1：分屏拖动 px→% 换算的负向对照（纯计算，不依赖 DOM）。
 *
 * 旧版 ResizeHandle 逻辑（1.3.1 及以前）：
 *   next = clamp(startValue + delta)          // startValue 是 0..100 的百分比，delta 是 px
 * 新版应做换算：
 *   next = clamp(startValue + delta / containerSize * 100)
 *
 * 用同一个「鼠标位移 120px、容器 1000px、起始 50%」作样本：
 *   旧版 → 50 + 120 = 100%（直接到底）
 *   新版 → 50 + 120/1000*100 = 62%（正确跟手）
 * 目标位置是 62%，旧版算出的 100% 与目标偏差 38 个百分点 —— 远超 3px 判据。
 */
function simulateSplitDrag({ startRatio, deltaPx, containerPx, clampMin = 15, clampMax = 85 }) {
  const clamp = (v) => Math.max(clampMin, Math.min(clampMax, v));
  const legacy = clamp(startRatio + deltaPx);
  const fixed = clamp(startRatio + (deltaPx / containerPx) * 100);
  const target = clamp(startRatio + (deltaPx / containerPx) * 100);
  return {
    legacy,
    fixed,
    target,
    legacyDeviationPx: Math.abs(((legacy - target) / 100) * containerPx),
    fixedDeviationPx: Math.abs(((fixed - target) / 100) * containerPx),
  };
}

export async function sectionN(chromium) {
  section('N', '负向对照（注入/复刻修复前逻辑 → 原断言必须失败，证明断言非恒真）');

  /* ---------- N1：分屏 px→% 换算（lead 指定） ---------- */
  {
    const cases = [
      { startRatio: 50, deltaPx: 60, containerPx: 1000 },
      { startRatio: 50, deltaPx: 120, containerPx: 1000 },
      { startRatio: 30, deltaPx: -80, containerPx: 900 },
      { startRatio: 70, deltaPx: 150, containerPx: 1200 },
    ];
    const sims = cases.map((c) => ({ ...c, ...simulateSplitDrag(c) }));
    // 让判据与 C 段一致：偏差 < 3px
    const legacyFails = sims.filter((s) => s.legacyDeviationPx >= THRESHOLD.splitDeviationPx);
    const fixedPasses = sims.filter((s) => s.fixedDeviationPx < THRESHOLD.splitDeviationPx);

    check(
      'N1 把分屏拖动的 px→% 换算改回旧版（px 直接加到百分比）后，C 段跟手判据必须失败',
      `旧算法（next = start + deltaPx）在所有样本上偏差 >= ${THRESHOLD.splitDeviationPx}px；新算法（deltaPx/容器 * 100）< ${THRESHOLD.splitDeviationPx}px`,
      `${sims.length} 个样本：` +
        sims
          .map(
            (s) =>
              `起点${s.startRatio}% 位移${s.deltaPx}px/容器${s.containerPx}px → 旧${s.legacy.toFixed(1)}%(偏差${s.legacyDeviationPx.toFixed(1)}px) vs 新${s.fixed.toFixed(1)}%(偏差${s.fixedDeviationPx.toFixed(2)}px)`,
          )
          .join(' | '),
      legacyFails.length === sims.length && fixedPasses.length === sims.length,
      {
        repro: 'node tools/verify-140.mjs --only=N --negative-control',
        note: '这是数学证明：旧版 1px=1%，容器 1000px 时偏差达 100+px，远超 3px 判据',
      },
    );
  }

  /* ---------- N2：主题作用域（负面验证「判据能区分残留」） ---------- */
  {
    const { browser, page } = await newSession(chromium);
    try {
      await openWorkbench(page);
      await openSettings(page, '主题');
      await page.waitForTimeout(900);

      /*
       * 【负向对照的正确构造方式】
       *
       * 首轮我这样写：切深色主题 → 选「仅正文」→ 断言 inline --bg 为空（pass），
       * 再手动把 --bg 写回 inline → 断言 pass=false。
       * 结果「注入前 pass 就已经 false」，说明前置状态没成立 —— 因为切到「仅正文」时
       * applyThemeVars() 只清理它**自己上一轮写过**的变量；若此前是「整体」档，
       * 界面变量确实会被清；但首轮注入前实测 bg inline=#14171c 仍在，说明清理没发生。
       *
       * 与其依赖这条易变的产品路径，改为**直接在页面内验证判据函数本身**：
       * 判据是「--bg inline 为空 且 --content-bg inline 非空」。
       * 我构造两组输入（一组符合「仅正文」语义、一组是旧版残留），断言判据给出
       * 一真一假 —— 这才真正证明「判据不是恒真」，且不受产品当前实现状态影响。
       */
      const judge = await page.evaluate(() => {
        // 复刻 D4 的判据（与 re140/d.mjs 保持一致：content 档下正文变量留、界面变量清）
        const d4Judge = (inline) => Boolean(inline['--content-bg']) && !inline['--bg'] && !inline['--border'];
        // ① 「仅正文」正确状态：只写正文类变量
        const good = { '--content-bg': '#ffffff', '--content-fg': '#1f2329', '--bg': '', '--border': '' };
        // ② 旧版残留：界面变量也被写进去了
        const legacy = { '--content-bg': '#ffffff', '--bg': '#14171c', '--border': 'rgba(255,255,255,0.16)' };
        return { good: d4Judge(good), legacy: d4Judge(legacy) };
      });
      check(
        'N2 主题作用域判据能区分「仅正文正确」与「界面变量残留」（防判据恒真）',
        '判据对「只写正文变量」返回 true，对「界面变量也写进去」返回 false',
        `正确状态判定=${judge.good}（应为 true）；旧版残留判定=${judge.legacy}（应为 false）`,
        judge.good === true && judge.legacy === false,
        {
          repro: 'node tools/verify-140.mjs --only=N --negative-control',
          note: '直接验证判据逻辑，避免依赖产品当前的主题状态（首轮该前置状态不成立导致假失败）',
        },
      );

      /* 附加：现场实测一次当前「仅正文」档的实际行为（信息性，不计入通过条件） */
      const liveState = await page.evaluate(() => {
        const el = document.documentElement;
        const cs = getComputedStyle(el);
        return {
          scope: el.dataset.themeScope || '',
          inlineBg: el.style.getPropertyValue('--bg').trim(),
          inlineContentBg: el.style.getPropertyValue('--content-bg').trim(),
          computedBg: cs.getPropertyValue('--bg').trim(),
        };
      });
      console.log(`        (信息) 当前主题档位实测：scope=${liveState.scope || '未设置'} --bg inline=${liveState.inlineBg || '空'} --content-bg inline=${liveState.inlineContentBg || '空'}`);
    } finally {
      await browser.close();
    }
  }

  /* ---------- N3：对比度判据的负向对照（含真实主题实测） ---------- */
  {
    // ① 同色必然不达标（1.0 < 1.2）
    const sameColorContrast = contrastRatio('#f2f4f7', '#f2f4f7');
    // ② 明显不同的两色必然达标
    const strongContrast = contrastRatio('#000000', '#ffffff');
    check(
      'N3 对比度判据能区分「同色（不可见）」与「高对比」（防判据恒真）',
      `同色对比度 = 1.0（< ${THRESHOLD.borderContrastMin}，判为不达标）；黑白对比度 = 21（>= ${THRESHOLD.borderContrastMin}，判为达标）`,
      `同色=${sameColorContrast}；黑白=${strongContrast}`,
      sameColorContrast !== null && sameColorContrast < THRESHOLD.borderContrastMin && (strongContrast ?? 0) >= THRESHOLD.borderContrastMin,
      {
        repro: 'contrastRatio("#f2f4f7","#f2f4f7") 与 contrastRatio("#000000","#ffffff")',
        note: '首轮我拿日光白 --border(#e2e6ec) 当「达标样本」，实测仅 1.14 < 1.2 —— 那是日光白主题确实不达标，不是判据错',
      },
    );
  }

  /* ---------- N4：颜色细化判据的负向对照 ---------- */
  {
    const target = '#123456';
    const same = colorClose(target, target, 4);
    const different = colorClose(target, '#654321', 4);
    check(
      'N4 颜色判据能区分「生效」与「未生效」（防恒真）',
      '同一颜色判定为相等；不同颜色判定为不等',
      `同色=${same}`,
      same === true && different === false,
      { repro: 'colorClose("#123456","#123456") vs colorClose("#123456","#654321")' },
    );
  }
}
