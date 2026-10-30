/**
 * [A] 行距正常
 * =============================================================================
 * 断言目标：默认设置下正文字号/行高比合理、**不存在两层 line-height 叠加**、
 * 相邻段落净空白不过大、空行恰好占一个行盒、空行数据可逆、行高档位语义未破坏。
 *
 * 两类「相邻非空段落」分开断言（阈值依据见 common.mjs 的 THRESHOLD 注释）：
 *   A3a 中间无空段落  —— 修复前也通过，保留用于防「为修 A3b 把 margin 压成 0」
 *   A3b 中间夹 1 个显式空行 —— 修复前 3.449em FAIL / 修复后 1.949em PASS，是修复有效性的证据
 */

import {
  check,
  fmt,
  readTabContent,
  round2,
  section,
  setMode,
  settingsStoreEval,
  shot,
  newSession,
  openWorkbench,
  typeMarkdownInSource,
  blankStats,
  defaultSeed,
  THRESHOLD,
} from './common.mjs';

/** 三段，段落之间各隔一个空行（WYSIWYG 里表现为「段-空段落-段」） */
const PARA_MD = ['# 行距探针', '', '第一段落，用来测量行盒与行距。', '', '第二段落，与上一段之间只隔一个空行。', '', '第三段落，再隔一个空行。', ''].join('\n');

/**
 * 采集正文排版指标。
 *
 * 关键点：`gaps` 记录「相邻非空段落之间的净空白」与「中间夹了几个空段落」，
 * 这样才能把 A3a（emptyBetween=0）与 A3b（emptyBetween=1）分开断言。
 */
async function measureTypography(page) {
  return page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    if (!pm) return { missing: true };
    const cs = getComputedStyle(pm);
    const fontSize = parseFloat(cs.fontSize);
    const lineHeight = parseFloat(cs.lineHeight);
    const paras = Array.from(pm.querySelectorAll('p'));
    const nonEmpty = paras.filter((p) => (p.textContent || '').trim());
    const blanks = paras.filter((p) => !(p.textContent || '').trim());
    const rectOf = (el) => el.getBoundingClientRect();
    const gaps = [];
    for (let i = 1; i < nonEmpty.length; i += 1) {
      const a = rectOf(nonEmpty[i - 1]);
      const b = rectOf(nonEmpty[i]);
      let emptyBetween = 0;
      let n = nonEmpty[i - 1].nextElementSibling;
      while (n && n !== nonEmpty[i]) {
        if (n.tagName === 'P' && !(n.textContent || '').trim()) emptyBetween += 1;
        n = n.nextElementSibling;
      }
      gaps.push({
        from: (nonEmpty[i - 1].textContent || '').slice(0, 8),
        to: (nonEmpty[i].textContent || '').slice(0, 8),
        emptyBetween,
        gap: Math.round((b.top - a.bottom) * 100) / 100,
      });
    }
    const blankInfo = blanks.slice(0, 3).map((p) => {
      const pcs = getComputedStyle(p);
      return {
        h: Math.round(rectOf(p).height * 100) / 100,
        mt: pcs.marginTop,
        mb: pcs.marginBottom,
        lh: pcs.lineHeight,
      };
    });
    // 祖先链：用于判断「是否有第二层 line-height 在放大」
    const chain = [];
    let cur = pm;
    while (cur && cur !== document.documentElement) {
      const c = getComputedStyle(cur);
      chain.push({ cls: String(cur.className).slice(0, 40), lh: c.lineHeight, fs: c.fontSize });
      cur = cur.parentElement;
    }
    const root = getComputedStyle(document.documentElement);
    return {
      fontSize,
      lineHeight,
      ratio: Math.round((lineHeight / fontSize) * 1000) / 1000,
      varLineHeight: root.getPropertyValue('--content-line-height').trim(),
      varFontSize: root.getPropertyValue('--content-font-size').trim(),
      gaps,
      blankInfo,
      chain: chain.slice(0, 4),
      settings: (() => {
        try {
          return JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}').appearance ?? null;
        } catch {
          return null;
        }
      })(),
    };
  });
}

/** 用真实键盘事件把当前文档内容整体替换成 text（走编辑器自身的输入管线） */
async function replaceAllByTyping(page, text) {
  await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    pm.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(pm);
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.keyboard.insertText(text);
  await page.waitForTimeout(900);
}

export async function sectionA(chromium) {
  section('A', '行距正常（行高比 / 两层叠加 / 段落净空白 / 空行=一行 / 空行可逆 / 档位语义）');

  /* ---------- A1~A5：默认设置下的排版 ---------- */
  {
    const { browser, page, jsErrors } = await newSession(chromium, { seedSettings: defaultSeed() });
    try {
      await openWorkbench(page);
      await replaceAllByTyping(page, PARA_MD);
      await shot(page, 'A1-wysiwyg-paragraphs');

      const m = await measureTypography(page);

      check(
        'A1 行高比 lineHeight/fontSize 在合理区间（默认设置）',
        `${THRESHOLD.ratioMin} <= ratio <= ${THRESHOLD.ratioMax}（1.1.9 默认 1.75；1.2.1 收严到 1.6）`,
        `font-size=${m.fontSize}px line-height=${m.lineHeight}px ratio=${m.ratio}（--content-line-height=${m.varLineHeight}）`,
        m.ratio >= THRESHOLD.ratioMin && m.ratio <= THRESHOLD.ratioMax,
        { repro: 'node tools/verify-121.mjs --only=A（不注入字号/行高，走 defaultSettings）' },
      );

      /*
       * A2：不是两层 line-height 叠加。
       * computed line-height 必须等于 fontSize × --content-line-height，
       * 而不是它的平方（后者是「两层 em/% 相乘」的典型症状）。
       */
      const expectPx = m.fontSize * Number(m.varLineHeight || 1);
      const doubled = m.fontSize * Number(m.varLineHeight || 1) * Number(m.varLineHeight || 1);
      const ancestorNumeric = m.chain.filter(
        (c) => c.cls && /wysiwyg|shell__page|nm-content/.test(c.cls) && c.lh !== 'normal',
      );
      check(
        'A2 行高未被两层 line-height 叠加放大',
        `computed line-height = fontSize x --content-line-height = ${round2(expectPx)}px，且不得等于平方值 ${round2(doubled)}px`,
        `computed=${m.lineHeight}px；祖先链带数值 line-height 的节点=${fmt(ancestorNumeric)}`,
        Math.abs(m.lineHeight - expectPx) <= 0.6 && Math.abs(m.lineHeight - doubled) > 0.6,
        {
          repro: 'node tools/verify-121.mjs --only=A',
          note: 'CSS 里无单位 line-height 是覆盖而非相乘；这条防止有人改成 em/% 叠乘',
        },
      );

      /* A3b：段落之间夹 1 个显式空行 —— 缺陷1 核心，修复前 3.449em 必然失败 */
      const blankGap = m.gaps.find((g) => g.emptyBetween === 1);
      check(
        'A3b 段落间夹 1 个显式空行时净空白不过大（缺陷1 核心，修复有效性证据）',
        `${THRESHOLD.gapBlankLineMinEm}em <= gap <= ${THRESHOLD.gapBlankLineMaxEm}em（${round2(THRESHOLD.gapBlankLineMaxEm * m.fontSize)}px）；修复前 55.18px = 3.449em（必然失败），修复后 31.19px = 1.949em`,
        blankGap
          ? `gap=${blankGap.gap}px = ${round2(blankGap.gap / m.fontSize)}em（中间 ${blankGap.emptyBetween} 个空段落）`
          : '未测到「隔一个空行」的段落对',
        Boolean(blankGap) &&
          blankGap.gap <= THRESHOLD.gapBlankLineMaxEm * m.fontSize &&
          blankGap.gap >= THRESHOLD.gapBlankLineMinEm * m.fontSize,
        {
          repro: 'node tools/verify-121.mjs --only=A（写入「段-空行-段」，WYSIWYG 表现为「段-空段落-段」）',
          note: '上限 2.2em 留 0.25em 余量防渲染假失败；相对修复前 3.449em 仍有 1.25em 区分度',
        },
      );

      /* A5：空行 = 恰好一个行盒，且空段落自身 margin 必须为 0 */
      const blank = m.blankInfo[0];
      check(
        'A5 空行 = 恰好一个行盒（空段落 margin 清零）',
        `空段落 height 约等于 1 个行盒（${m.lineHeight}px +-2）且 margin-top/bottom = 0px`,
        blank ? `height=${blank.h}px margin=${blank.mt}/${blank.mb} line-height=${blank.lh}` : '未测到空段落',
        Boolean(blank) &&
          Math.abs(blank.h - m.lineHeight) <= 2 &&
          parseFloat(blank.mt) === 0 &&
          parseFloat(blank.mb) === 0,
        {
          repro: 'node tools/verify-121.mjs --only=A（「段-空行-段」里的空段落）',
          note: '空段落是「一个空行」的唯一载体，不能 display:none；但 margin 必须为 0，否则与行盒叠加',
        },
      );

      /*
       * A3a：相邻非空段落（中间不留空段落）。
       * 构造方式必须用真实 Enter —— markdown 文本里的空行在 WYSIWYG 里必然
       * 变成空段落，造不出「紧邻」形态。
       */
      await replaceAllByTyping(page, '无空行段落一。');
      await page.keyboard.press('Enter');
      await page.keyboard.insertText('无空行段落二。');
      await page.keyboard.press('Enter');
      await page.keyboard.insertText('无空行段落三。');
      await page.waitForTimeout(900);
      const tight = await measureTypography(page);
      const tightGap = tight.gaps.find((g) => g.emptyBetween === 0);
      check(
        'A3a 相邻段落（中间无空段落）净空白正常',
        `${THRESHOLD.gapAdjacentMinEm}em <= gap <= ${THRESHOLD.gapAdjacentMaxEm}em（${round2(THRESHOLD.gapAdjacentMaxEm * tight.fontSize)}px）；修复前 21.59px = 1.35em`,
        tightGap
          ? `gap=${tightGap.gap}px = ${round2(tightGap.gap / tight.fontSize)}em（中间 ${tightGap.emptyBetween} 个空段落）`
          : `未测到相邻非空段落（gaps=${fmt(tight.gaps)}）`,
        Boolean(tightGap) &&
          tightGap.gap <= THRESHOLD.gapAdjacentMaxEm * tight.fontSize &&
          tightGap.gap >= THRESHOLD.gapAdjacentMinEm * tight.fontSize,
        {
          repro: 'node tools/verify-121.mjs --only=A（用 Enter 造三段相邻正文，中间不留空段落）',
          note: '这条修复前本来就通过（1.35em < 2.0em），保留用于防「为修 A3b 把段落 margin 压成 0」',
        },
      );

      /*
       * A4：空行数据可逆（浏览器侧独立验证，不落盘）。
       *
       * 与 D 段分工：A4 只验证「渲染 -> 回写」这一次内存往返（桥接层）；
       * D 段验证「保存 -> 重开」的落盘链路（持久化层）。两者独立成立才算修好。
       *
       * 样本：段落间 2 空行 + 文末 3 空行 + 代码块内 2 空行
       * （代码块内必须是 2 个空行：放 1 个时「压没压」都统计为 1，测不出缺陷）。
       */
      const roundtripMd = [
        '段落一。',
        '',
        '',
        '段落二（前面 2 个空行）。',
        '',
        '```js',
        'const a = 1;',
        '',
        '',
        'const b = 2;',
        '```',
        '',
        '',
        '',
      ].join('\n');
      await setMode(page, 'source');
      await typeMarkdownInSource(page, roundtripMd);
      const inModel = await readTabContent(page);
      await setMode(page, 'wysiwyg');
      const wysiwygInfo = await page.evaluate(() => {
        const pm = document.querySelector('.ProseMirror');
        if (!pm) return null;
        return {
          blankParas: pm.querySelectorAll(
            'p.nm-blank, p:empty, p:has(> br.ProseMirror-trailingBreak:only-child)',
          ).length,
          blocks: Array.from(pm.children).map((e) => ({ tag: e.tagName, empty: !(e.textContent || '').trim() })),
        };
      });
      await setMode(page, 'source');
      const back = await readTabContent(page);
      const s1 = blankStats(inModel);
      const s2 = blankStats(back);
      check(
        'A4 空行数据可逆（源码 -> 所见即所得 -> 源码，不落盘）',
        '往返后段落间 2 空行 / 文末 3 空行 / 代码块内 2 空行逐项一致，且整体字节级相等',
        `${back === roundtripMd ? '字节级一致' : '不一致'}; 空行统计 段间=${s1.maxBlankRun}->${s2.maxBlankRun} 文末=${s1.trailingNewlines}->${s2.trailingNewlines} 代码块内=${s1.codeBlockBlank}->${s2.codeBlockBlank}; WYSIWYG 空段落=${wysiwygInfo?.blankParas ?? '?'}`,
        inModel === roundtripMd &&
          back === roundtripMd &&
          s2.maxBlankRun === 2 &&
          s2.trailingNewlines === 3 &&
          s2.codeBlockBlank === 2,
        {
          repro: '源码模式写入 -> 切所见即所得 -> 切回源码（全程不保存）-> 比对 activeTab.content',
          note: '与 D 段分工：A4 测桥接层内存往返，D 段测落盘 + 重开链路；两者独立',
        },
      );

      check('A6 排版操作过程无 JS 运行时错误', '0 条 pageerror', jsErrors.length ? jsErrors.slice(0, 3) : '0 条', jsErrors.length === 0);
    } finally {
      await browser.close();
    }
  }

  /* ---------- A7：行高档位语义（1.2 / 1.6 / 2.0 三档都必须如实生效） ---------- */
  {
    const { browser, page } = await newSession(chromium, { seedSettings: defaultSeed() });
    try {
      await openWorkbench(page);
      await replaceAllByTyping(page, PARA_MD);

      const readings = [];
      for (const lh of [1.2, 1.6, 2.0]) {
        await settingsStoreEval(
          page,
          (s, v) => {
            s.updateAppearance({ lineHeight: v });
            return true;
          },
          lh,
        );
        await page.waitForTimeout(650);
        const st = await page.evaluate(() => {
          const pm = document.querySelector('.ProseMirror');
          const cs = getComputedStyle(pm);
          return {
            fontSize: parseFloat(cs.fontSize),
            lineHeight: parseFloat(cs.lineHeight),
            varLH: getComputedStyle(document.documentElement).getPropertyValue('--content-line-height').trim(),
          };
        });
        readings.push({ set: lh, ...st, ratio: Math.round((st.lineHeight / st.fontSize) * 1000) / 1000 });
      }
      const ok = readings.every((r) => Math.abs(r.ratio - r.set) <= 0.03);
      check(
        'A7 行高档位语义正确（1.2 / 1.6 / 2.0 各自如实生效）',
        '每一档 computed lineHeight/fontSize 约等于设定值（+-0.03），不得被默认值或其它层覆盖',
        readings.map((r) => `设${r.set}->实测${r.ratio}`).join(' / '),
        ok,
        { repro: 'node tools/verify-121.mjs --only=A（直接调 settings.updateAppearance 三档）' },
      );
    } finally {
      await browser.close();
    }
  }
}
