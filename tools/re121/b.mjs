/**
 * [B] 分屏右侧配色
 * =============================================================================
 * 缺陷3：左右分屏时右侧（预览）配色与主编辑器不一致。
 *
 * 断言口径（重要）：
 *   `.compare__preview` 在修复前 computed backgroundColor 是 rgba(0,0,0,0)（完全透明），
 *   实际底色由祖先 `.shell__main`（background: var(--bg-elevated)）透出。
 *   浅色主题下 --bg-elevated 与 --content-bg 恰好都是 #ffffff，看不出问题；
 *   深色/护眼主题下两者不同，立刻变成"两栏两种底色"。
 *
 *   因此不能只比"有效背景"（那会因祖先相同而恒真），必须断言
 *   **预览栏自己在这条链上声明了不透明背景**，且 ≈ --content-bg。
 *   按任务书"（或实际选择器）"的要求，取 .compare__preview -> .compare__pane 之间
 *   第一个不透明背景，允许修复把颜色声明在 .compare__body--preview 上。
 */

import {
  check,
  colorClose,
  cssVarToRgb,
  fmt,
  isOpaque,
  newSession,
  openWorkbench,
  section,
  setMode,
  shot,
  themeSeed,
  THRESHOLD,
} from './common.mjs';

const COMPARE_MD = [
  '# 分屏配色',
  '',
  '右侧预览区的一段正文，用于比对背景色与文字色。',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
  '> 引用块应与正文同底色系。',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
].join('\n');

/** 采集「主编辑器 vs 分屏右侧预览」的配色与排版（在对照模式下调用） */
async function measureCompare(page) {
  return page.evaluate(() => {
    const effBg = (el) => {
      let cur = el;
      while (cur && cur !== document.documentElement) {
        const c = getComputedStyle(cur);
        if (c.backgroundColor && c.backgroundColor !== 'rgba(0, 0, 0, 0)') {
          return { bg: c.backgroundColor, from: String(cur.className).slice(0, 48) };
        }
        cur = cur.parentElement;
      }
      return { bg: 'none', from: null };
    };
    /*
     * 预览栏「自身声明」的背景：
     * 从 .compare__preview 向上走到所在的 .compare__pane 为止，
     * 取第一个不透明背景。一路都透明 -> 说明颜色是祖先 .shell__main 透出来的，
     * 那正是缺陷3 的形态。
     */
    const previewOwnBg = () => {
      const start = document.querySelector('.compare__preview');
      if (!start) return null;
      const pane = start.closest('.compare__pane');
      const chain = [];
      let cur = start;
      while (cur) {
        const c = getComputedStyle(cur);
        chain.push({ cls: String(cur.className).slice(0, 48), bg: c.backgroundColor });
        if (c.backgroundColor && c.backgroundColor !== 'rgba(0, 0, 0, 0)') {
          return { bg: c.backgroundColor, from: String(cur.className).slice(0, 48), chain };
        }
        if (cur === pane) break;
        cur = cur.parentElement;
      }
      return { bg: null, from: null, chain };
    };
    const root = getComputedStyle(document.documentElement);
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const c = getComputedStyle(el);
      return {
        sel,
        cls: String(el.className).slice(0, 60),
        color: c.color,
        bg: c.backgroundColor,
        fontSize: c.fontSize,
        lineHeight: c.lineHeight,
        eff: effBg(el),
      };
    };
    return {
      theme: document.documentElement.dataset.theme,
      preset: document.documentElement.dataset.themePreset,
      vars: {
        contentBg: root.getPropertyValue('--content-bg').trim(),
        contentFg: root.getPropertyValue('--content-fg').trim(),
        bgElevated: root.getPropertyValue('--bg-elevated').trim(),
      },
      preview: pick('.compare__preview'),
      previewOwnBg: previewOwnBg(),
      mainEditor: pick('.ProseMirror'),
      mainPaper: pick('.shell__page'),
      shellMain: pick('.shell__main'),
      hasCompare: Boolean(document.querySelector('.compare')),
    };
  });
}

/** 在所见即所得模式下的主编辑器基线 */
async function measureMain(page) {
  return page.evaluate(() => {
    const effBg = (el) => {
      let cur = el;
      while (cur && cur !== document.documentElement) {
        const c = getComputedStyle(cur);
        if (c.backgroundColor && c.backgroundColor !== 'rgba(0, 0, 0, 0)') {
          return { bg: c.backgroundColor, from: String(cur.className).slice(0, 48) };
        }
        cur = cur.parentElement;
      }
      return { bg: 'none', from: null };
    };
    const el = document.querySelector('.ProseMirror');
    if (!el) return { missing: true };
    const c = getComputedStyle(el);
    return {
      color: c.color,
      fontSize: c.fontSize,
      lineHeight: c.lineHeight,
      eff: effBg(el),
    };
  });
}

export async function sectionB(chromium) {
  section('B', '分屏右侧配色（浅色 + 深色：背景 / 文字 / 字号行高与主编辑器一致）');

  const runTheme = async (preset, label) => {
    const { browser, page } = await newSession(chromium, { seedSettings: themeSeed({ preset }) });
    try {
      await openWorkbench(page);
      await page.evaluate(() => {
        const pm = document.querySelector('.ProseMirror');
        pm.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(pm);
        sel.removeAllRanges();
        sel.addRange(range);
      });
      await page.keyboard.insertText(COMPARE_MD);
      await page.waitForTimeout(900);

      const main = await measureMain(page);
      await setMode(page, 'compare');
      await page.waitForTimeout(600);
      const cmp = await measureCompare(page);
      await shot(page, `B-${label}-compare`);
      const cn = label === 'light' ? '浅色' : '深色';

      if (!cmp.hasCompare) {
        check(`B ${cn}主题：进入对照模式`, '存在 .compare__preview', '未进入对照模式（.compare 不存在）', false, {
          repro: 'node tools/verify-121.mjs --only=B',
        });
        return;
      }

      /* B1/B5：预览栏自身声明背景 ≈ --content-bg */
      const expectBg = cssVarToRgb(cmp.vars.contentBg) || main.eff?.bg;
      const own = cmp.previewOwnBg;
      check(
        `B ${cn}主题：右侧预览栏自身声明背景 = 正文纸张色（不靠祖先透出）`,
        `预览栏（.compare__preview -> .compare__pane 之间）存在不透明背景且约等于 --content-bg（${expectBg}，+-${THRESHOLD.colorTolerance}/通道）`,
        own && own.bg
          ? `声明者=${own.from} bg=${own.bg}；--content-bg=${cmp.vars.contentBg}；--bg-elevated=${cmp.vars.bgElevated}`
          : `预览栏链上全部透明（${fmt(own?.chain)}）-> 实际底色由 .shell__main 透出（${fmt(cmp.preview.eff)}）`,
        Boolean(own && isOpaque(own.bg) && colorClose(own.bg, expectBg)),
        {
          repro: `设置主题=${preset} -> 切「对照模式」-> 读 .compare__preview 到 .compare__pane 之间第一个不透明背景`,
          note: '修复前该链完全透明；浅色主题下祖先恰好同色才看不出问题，深色/护眼主题立刻两栏两色',
        },
      );

      /* B2/B6：文字色与主编辑器一致 */
      check(
        `B ${cn}主题：右侧预览文字色 = 主编辑器文字色`,
        `preview color === .ProseMirror color（+-${THRESHOLD.colorTolerance}/通道）`,
        `preview=${cmp.preview.color} / 主编辑器=${main.color}（--content-fg=${cmp.vars.contentFg}）`,
        colorClose(cmp.preview.color, main.color ?? ''),
        { repro: '切对照模式，比对 .compare__preview 与 .ProseMirror 的 computed color' },
      );

      /* B3/B7：字号 / 行高与主编辑器一致 */
      check(
        `B ${cn}主题：右侧预览字号/行高 = 主编辑器`,
        'preview fontSize/lineHeight === .ProseMirror 的 fontSize/lineHeight',
        `preview=${cmp.preview.fontSize}/${cmp.preview.lineHeight} vs 主编辑器=${main.fontSize}/${main.lineHeight}`,
        cmp.preview.fontSize === main.fontSize && cmp.preview.lineHeight === main.lineHeight,
        {
          repro: '设置正文字号 17px / 行高 1.75 -> 切对照模式 -> 比对两栏 computed fontSize/lineHeight',
          note: '修复前 CompareView 的 fontSize/lineHeight 两个 prop 只传给了左侧源码栏，右栏完全没绑',
        },
      );

      /* B4/B8：视觉兜底 —— 两栏有效背景一致 */
      check(
        `B ${cn}主题：两栏有效背景一致（视觉兜底）`,
        'preview 有效背景 === 主编辑器有效背景（含祖先透出）',
        `preview 有效=${fmt(cmp.preview.eff)} / 主编辑器有效=${fmt(main.eff)}`,
        colorClose(cmp.preview.eff?.bg ?? '', main.eff?.bg ?? ''),
        { repro: '切对照模式，沿祖先链取第一个非透明背景比对' },
      );

      await setMode(page, 'wysiwyg');
    } finally {
      await browser.close();
    }
  };

  await runTheme('daylight', 'light');
  await runTheme('midnight', 'dark');
}
