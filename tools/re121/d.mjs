/**
 * [D] 保存后空换行不丢
 * =============================================================================
 * 缺陷4：Markdown 源文件里连续空行在「打开->保存」或 源码<->所见即所得 往返后被压缩/删除。
 *
 * 样本设计刻意覆盖 fix-editor 定位到的三条真实丢失路径，缺一都测不出来：
 *  1. **文末换行被 .trim() 吃掉** —— 文末放 3 个换行，若被 trim，
 *     trailingNewlines 变 0，D4 立刻失败（git 里表现为 `\ No newline at end of file`）；
 *  2. **代码块内空行被压** —— 代码块里放 **2 个**空行（a\n\n\nb），若被压成 1 个
 *     （a\n\nb），codeBlockBlank 会从 2 变 1 而失败。放 1 个是测不出来的。
 *  3. **段落间连续空行** —— 段落间放 2 个空行（N=2 -> 1 个 nm-blank 空段落）。
 *
 * 全部按**字节级**比对，绝不规范化后再比较。
 */

import {
  blankStats,
  check,
  createTempDoc,
  fmt,
  newSession,
  openWorkbench,
  readTabContent,
  readVaultRaw,
  saveAndSettle,
  section,
  setMode,
  shot,
  STORE_EXPR,
  typeMarkdownInSource,
  defaultSeed,
} from './common.mjs';

/**
 * 目标 Markdown：段落间 2 空行 + 文末 3 空行 + 代码块内 2 空行。
 * 代码块内必须是 2 个空行（见文件头说明第 2 条）。
 */
const BLANK_MD = [
  '第一段正文。',
  '',
  '',
  '第二段正文（前面 2 个空行）。',
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

export async function sectionD(chromium) {
  section('D', '保存后空换行不丢（段落间 2 空行 + 文末 3 空行 + 代码块内 2 空行，字节级比对）');

  const { browser, page, jsErrors } = await newSession(chromium, { seedSettings: defaultSeed() });
  try {
    await openWorkbench(page);
    const doc = await createTempDoc(page, { title: `QA121-D-${Date.now()}`, content: '' });
    if (!doc.docId) {
      check('D0 创建临时文档', '能新建临时文档', 'createDoc 未返回 docId', false, {
        repro: 'node tools/verify-121.mjs --only=D',
      });
      return;
    }
    await page.waitForTimeout(700);

    // ---- D1：源码模式写入是否原样进入文档模型 ----
    await setMode(page, 'source');
    await typeMarkdownInSource(page, BLANK_MD);
    const typed = await readTabContent(page);
    check(
      'D1 源码模式写入的 Markdown 原样进入文档模型',
      '编辑器内容 === 写入内容（字节级）',
      `写入 ${BLANK_MD.length}B / 实测 ${(typed ?? '').length}B${typed === BLANK_MD ? '（一致）' : `（不一致：${blankStats(typed).repr}）`}`,
      typed === BLANK_MD,
      { repro: '切源码模式 -> 全选删除 -> 逐字输入含空行的 Markdown -> 读 activeTab.content' },
    );

    // ---- D2：源码 -> 所见即所得 -> 源码（走 markdown-bridge 往返） ----
    await setMode(page, 'wysiwyg');
    const blocks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.ProseMirror > *')).map((e) => ({
        tag: e.tagName,
        empty: !(e.textContent || '').trim(),
      })),
    );
    await setMode(page, 'source');
    const afterRoundtrip = await readTabContent(page);
    check(
      'D2 源码 <-> 所见即所得 往返后空行不丢',
      '往返后内容仍与写入完全一致（字节级）',
      `${afterRoundtrip === BLANK_MD ? '一致' : `不一致：${blankStats(afterRoundtrip).repr}`}；WYSIWYG 块结构=${fmt(blocks)}`,
      afterRoundtrip === BLANK_MD,
      {
        repro: '源码模式写入 -> 切所见即所得 -> 再切回源码 -> 读 activeTab.content',
        note: '空行在 WYSIWYG 里必须表现为空段落（blocks 里 empty=true），否则数据不可逆',
      },
    );

    // ---- D3：保存后仓库文件内容（落盘字节） ----
    await saveAndSettle(page, 2600);
    const savedRaw = await readVaultRaw(page, doc.docId);
    const savedStats = blankStats(savedRaw);
    check(
      'D3 保存后仓库文件内容与写入完全一致（不丢空行、不规范化）',
      'vault.read(docId) === 写入内容（字节级）',
      `${savedRaw === BLANK_MD ? '一致' : `不一致：${savedStats.repr}`}`,
      savedRaw === BLANK_MD,
      { repro: '写入后 Ctrl+S（store.saveActiveTab）-> 读 vault.read(docId)' },
    );

    // ---- D4：三类空行数量精确保持（分别对应三条已知丢失路径） ----
    check(
      'D4 空行数量精确保持（段落间 2 / 文末 3 / 代码块内 2）',
      '段落间最大连续空行 = 2；文末换行数 = 3（>0 才证明未被 trim 吃掉）；代码块内空行 = 2（>1 才证明未被压缩）',
      `段落间=${savedStats.maxBlankRun} 文末换行=${savedStats.trailingNewlines} 代码块内=${savedStats.codeBlockBlank}（写入基线：2 / 3 / 2）`,
      savedStats.maxBlankRun === 2 && savedStats.trailingNewlines === 3 && savedStats.codeBlockBlank === 2,
      {
        repro: '同 D3，用 blankStats 精确统计各类空行数量',
        note: '三类空行分别对应：段落间隙 / 文末换行被 trim / 代码块内空行被压',
      },
    );

    // ---- D5：重新打开文档（重开链路） ----
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.shell__main', { timeout: 30000 });
    await page.waitForTimeout(2600);
    const reopened = await page.evaluate(
      async ({ expr, id }) => {
        // eslint-disable-next-line no-eval
        const s = eval(expr);
        await s.openDoc(id);
        await new Promise((r) => setTimeout(r, 1600));
        return { raw: await s.vault.read(id), tab: s.activeTab?.content ?? null };
      },
      { expr: STORE_EXPR, id: doc.docId },
    );
    check(
      'D5 重新打开文档后空行仍不丢（重开链路）',
      '刷新页面并重开文档后，仓库内容与标签内容都与写入一致',
      `vault=${reopened.raw === BLANK_MD ? '一致' : blankStats(reopened.raw).repr} / tab=${reopened.tab === BLANK_MD ? '一致' : blankStats(reopened.tab).repr}`,
      reopened.raw === BLANK_MD && reopened.tab === BLANK_MD,
      { repro: '保存后 page.reload() -> openDoc(docId) -> 读 vault.read 与 activeTab.content' },
    );

    await shot(page, 'D5-reopened');
    check(
      'D6 空行往返过程无 JS 运行时错误',
      '0 条 pageerror',
      jsErrors.length ? jsErrors.slice(0, 3) : '0 条',
      jsErrors.length === 0,
    );
  } finally {
    await browser.close();
  }
}
