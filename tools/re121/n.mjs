/**
 * [N] 负向对照 —— 证明断言非恒真
 * =============================================================================
 * 为什么需要这一段（而不是 git stash 跑旧代码）：
 *  - 门禁严禁改动源码，也无法在跑测中途切换 git 工作树（dev server 服务的是当前工作树）；
 *  - 但「断言不恒真」必须可复现地被证明，否则无法排除「写成恒真断言」的嫌疑。
 *
 * 做法：用 `addStyleTag({content})` 注入等价的修复前 CSS（不写文件、不影响其它页面），
 * 然后重跑同一套判据，期望结果是**不通过**。
 * 每条负向对照的 pass 语义 = 「注入后原断言确实失败了」。
 *
 * 本轮注入的修复前样式：
 *  N1 = 1.2.0 的 content.css（line-height 1.75 / p margin 0.85em / 空段落也有 margin）
 *  N2 = 1.2.0 的 CompareView（预览栏透明 + 不跟字号行高）
 */

import {
  check,
  colorClose,
  fmt,
  isOpaque,
  newSession,
  openWorkbench,
  section,
  setMode,
  themeSeed,
  defaultSeed,
} from './common.mjs';

/** 与 a.mjs 一致的探针样本 */
const PARA_MD = ['# 行距探针', '', '第一段落，用来测量行盒与行距。', '', '第二段落，与上一段之间只隔一个空行。', '', '第三段落，再隔一个空行。', ''].join('\n');

const COMPARE_MD = ['# 分屏配色', '', '右侧预览区的一段正文，用于比对背景色与文字色。', '', '讲一个引用块。', ''].join('\n');

/** 读取排版关键指标（用于 N1 的通过/失败判据） */
async function readLayout(page) {
  return page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    if (!pm) return null;
    const cs = getComputedStyle(pm);
    const fontSize = parseFloat(cs.fontSize);
    const lineHeight = parseFloat(cs.lineHeight);
    const paras = Array.from(pm.querySelectorAll('p'));
    const nonEmpty = paras.filter((p) => (p.textContent || '').trim());
    const blanks = paras.filter((p) => !(p.textContent || '').trim());
    const gaps = [];
    for (let i = 1; i < nonEmpty.length; i += 1) {
      const a = nonEmpty[i - 1].getBoundingClientRect();
      const b = nonEmpty[i].getBoundingClientRect();
      let emptyBetween = 0;
      let n = nonEmpty[i - 1].nextElementSibling;
      while (n && n !== nonEmpty[i]) {
        if (n.tagName === 'P' && !(n.textContent || '').trim()) emptyBetween += 1;
        n = n.nextElementSibling;
      }
      gaps.push({ emptyBetween, gap: Math.round((b.top - a.bottom) * 100) / 100 });
    }
    const blank = blanks[0];
    return {
      fontSize,
      lineHeight,
      gaps,
      blankMarginTop: blank ? getComputedStyle(blank).marginTop : null,
    };
  });
}

/** A3b + A5 的判据（上限 2.2em） */
function layoutPass(m) {
  if (!m) return false;
  const g = m.gaps.find((x) => x.emptyBetween === 1);
  if (!g) return false;
  const withinGap = g.gap <= 2.2 * m.fontSize && g.gap >= 0.5 * m.fontSize;
  const noMargin = m.blankMarginTop !== null && parseFloat(m.blankMarginTop) === 0;
  return withinGap && noMargin;
}

/** 读取预览栏自身背景与字号（用于 N2 的判据） */
async function readPreview(page) {
  return page.evaluate(() => {
    const start = document.querySelector('.compare__preview');
    if (!start) return null;
    const pane = start.closest('.compare__pane');
    let cur = start;
    let own = null;
    while (cur) {
      const c = getComputedStyle(cur);
      if (c.backgroundColor && c.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        own = { bg: c.backgroundColor, from: String(cur.className).slice(0, 40) };
        break;
      }
      if (cur === pane) break;
      cur = cur.parentElement;
    }
    const cs = getComputedStyle(start);
    return { own, fontSize: cs.fontSize, lineHeight: cs.lineHeight };
  });
}

export async function sectionN(chromium) {
  section('N', '负向对照（注入修复前样式 -> 原断言必须失败，证明断言非恒真）');

  /* ---------- N1：A 段判据（段间净空白 + 空段落 margin） ---------- */
  {
    const { browser, page } = await newSession(chromium, { seedSettings: defaultSeed() });
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
      await page.keyboard.insertText(PARA_MD);
      await page.waitForTimeout(800);

      const before = await readLayout(page);
      const passBefore = layoutPass(before);

      // 注入 1.2.0 的 content.css 等价样式
      await page.addStyleTag({
        content: `
          .nm-content { line-height: 1.75 !important; }
          .nm-content p { margin: 0.85em 0 !important; }
          .nm-content p:empty,
          .nm-content p.nm-blank,
          .nm-content p:has(> br.ProseMirror-trailingBreak:only-child) { margin: 0.85em 0 !important; }
        `,
      });
      await page.waitForTimeout(700);
      const after = await readLayout(page);
      const passAfter = layoutPass(after);

      const gapOf = (m) => m?.gaps.find((x) => x.emptyBetween === 1)?.gap ?? 'n/a';
      check(
        'N1 注入修复前段落样式后，A3b/A5 判据必须由通过转为失败',
        '注入前判据通过、注入后判据失败（证明 A3b/A5 真的在测缺陷，不是恒真）',
        `注入前 gap=${gapOf(before)}px margin=${before?.blankMarginTop}（pass=${passBefore}）-> ` +
          `注入后 gap=${gapOf(after)}px margin=${after?.blankMarginTop}（pass=${passAfter}）`,
        passBefore && !passAfter,
        {
          repro: 'node tools/verify-121.mjs --only=N --negative-control',
          note: '注入的 CSS 只作用于本页，不写文件；等价于 1.2.0 的 content.css',
        },
      );
    } finally {
      await browser.close();
    }
  }

  /* ---------- N2：B 段判据（预览栏自身背景 + 字号跟随） ---------- */
  {
    const { browser, page } = await newSession(chromium, { seedSettings: themeSeed({ preset: 'daylight' }) });
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
      await page.waitForTimeout(800);
      const mainFontSize = await page.evaluate(() => {
        const el = document.querySelector('.ProseMirror');
        return el ? getComputedStyle(el).fontSize : null;
      });
      await setMode(page, 'compare');
      await page.waitForTimeout(700);

      const passOf = (p) =>
        Boolean(p && p.own && isOpaque(p.own.bg) && colorClose(p.own.bg, 'rgb(255, 255, 255)') && p.fontSize === mainFontSize);

      const before = await readPreview(page);
      const passBefore = passOf(before);

      // 注入 1.2.0 的 CompareView 形态：预览栏透明 + 不跟随字号行高
      await page.addStyleTag({
        content: `
          .compare__preview, .compare__body--preview { background: transparent !important; color: inherit !important; }
          .compare__preview { --content-font-size: 16px !important; --content-line-height: 1.75 !important; }
        `,
      });
      await page.waitForTimeout(600);
      const after = await readPreview(page);
      const passAfter = passOf(after);

      check(
        'N2 注入「预览栏透明且不跟字号」后，B 判据必须由通过转为失败',
        '注入前判据通过、注入后判据失败（证明 B1/B3 真的在测缺陷）',
        `注入前 声明者=${fmt(before?.own)} fontSize=${before?.fontSize}/${mainFontSize}（pass=${passBefore}）-> ` +
          `注入后 声明者=${fmt(after?.own)} fontSize=${after?.fontSize}（pass=${passAfter}）`,
        passBefore && !passAfter,
        { repro: 'node tools/verify-121.mjs --only=N --negative-control' },
      );
      await setMode(page, 'wysiwyg');
    } finally {
      await browser.close();
    }
  }
}
