/**
 * 1.2.1 缺陷4「文件保存后空换行丢失」的复现 / 回归脚本。
 *
 * 用法：
 *   node tools/re121-blankline.mjs          # 跑当前代码，逐项对比「输入 ⇄ 往返输出」
 *   node tools/re121-blankline.mjs --json   # 只输出机器可读结果（供门禁消费）
 * 退出码：0 = 全部用例保真；1 = 存在丢行（修复前就是这个状态）。
 *
 * ## 缺陷的三层根因（本脚本逐层断言）
 *
 * ① markdownToHtml 丢空行信息
 *    markdown-it 把「连续空行」当块分隔符直接丢弃，`A\n\n\nB` 与 `A\n\nB` 渲染结果
 *    完全一致 —— 空行在进 HTML 那一刻就没了，之后怎么往返都无从还原。
 *    修法：连续 N(≥2) 个空行渲染成 (N-1) 个 `<p class="nm-blank">`，
 *    与「用户在所见即所得里按回车敲出来的空段落」用同一个载体表达。
 *
 * ② htmlToMarkdown 丢空段落 / 丢文末换行
 *    改前 `if (s) parts.push(s)` 把空段落整体丢弃；最后 `.trim()` 又把文末换行吃掉，
 *    于是每次保存 git 都报 `\ No newline at end of file`。
 *
 * ③ 代码块内空行被压缩
 *    改前对整串 markdown 跑全局 `\n{3,}` 折叠，把围栏代码块里的空行一起吃了。
 *    代码块是逐字内容，任何压缩都是数据损坏。
 *
 * ## 为什么脚本里直接 import TS 源文件
 * Node 24 自带类型剥离（type stripping），可以直接 import `.ts`。
 * 这样脚本断言的就是**仓库当前源码**，不依赖任何构建产物，改完立刻能验。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BRIDGE = pathToFileURL(path.join(ROOT, 'packages/core/src/vault/markdown-bridge.ts')).href;

const JSON_ONLY = process.argv.includes('--json');

const { markdownToHtml, htmlToMarkdown, htmlToSource } = await import(BRIDGE);

/**
 * 用例分三类：
 * - `roundtrip`：源文本 → HTML → 源文本，要求**逐字节相等**（含文末换行）；
 * - `html`：只断言渲染出的 HTML 结构（空段落数量是空行的可逆载体）；
 * - `tiptap`：模拟所见即所得里用户按回车产生的空段落，要求回写成空行。
 */
const ROUNDTRIP_CASES = [
  { name: '单空行（标准段落分隔，不得增删）', src: '第一段\n\n第二段\n' },
  { name: '段间 2 个空行', src: '第一段\n\n\n第二段\n' },
  { name: '段间 3 个空行', src: '第一段\n\n\n\n第二段\n' },
  { name: '段间 5 个空行', src: '第一段\n\n\n\n\n\n第二段\n' },
  { name: '文末 1 个空行（文件以换行结尾）', src: '正文\n\n' },
  { name: '文末 3 个空行', src: '正文\n\n\n\n' },
  { name: '文末无换行（手写单行文件）', src: '正文' },
  { name: '代码块内 3 个空行（逐字保留）', src: '```js\nconst a = 1;\n\n\n\nconst b = 2;\n```\n' },
  { name: '代码块内空行 + 段间空行', src: '上文\n\n\n```\nx\n\n\ny\n```\n\n\n下文\n' },
  { name: '硬换行（行尾两空格）', src: '第一行  \n第二行\n' },
  { name: 'frontmatter + 段间空行', src: '---\ntitle: T\n---\n\n正文\n\n\n后文\n' },
  { name: '标题 + 列表 + 空行', src: '# 标题\n\n- a\n- b\n\n\n段落\n' },
  { name: '空行紧邻代码块围栏', src: '正文\n\n\n```\ncode\n```\n' },
];

const HTML_CASES = [
  { name: '2 空行 → 1 个空段落', src: 'A\n\n\nB\n', blanks: 1 },
  { name: '3 空行 → 2 个空段落', src: 'A\n\n\n\nB\n', blanks: 2 },
  { name: '1 空行 → 0 个空段落', src: 'A\n\nB\n', blanks: 0 },
  { name: '代码块内空行不生成空段落', src: '```\na\n\n\nb\n```\n', blanks: 0 },
];

const TIPTAP_CASES = [
  { name: '回车产生 1 个空段落 → 1 个空行', html: '<p>A</p><p class="nm-blank"></p><p>B</p>', expect: 'A\n\n\nB\n' },
  { name: '回车产生 2 个空段落 → 2 个空行', html: '<p>A</p><p class="nm-blank"></p><p class="nm-blank"></p><p>B</p>', expect: 'A\n\n\n\nB\n' },
  { name: '裸空段落（无 class）也认', html: '<p>A</p><p></p><p>B</p>', expect: 'A\n\n\nB\n' },
];

const results = [];
const record = (kind, name, pass, detail) => {
  results.push({ kind, name, pass, detail });
  if (!JSON_ONLY) {
    const tag = pass ? 'PASS' : 'FAIL';
    console.log(`[${tag}] ${kind} ${name}`);
    if (!pass) console.log(`       ${JSON.stringify(detail)}`);
  }
};

if (!JSON_ONLY) {
  console.log('=== 1.2.1 缺陷4 空换行保真：往返实测 ===');
  console.log(`（markdownToHtml → htmlToSource，要求逐字节相等）\n`);
}

for (const c of ROUNDTRIP_CASES) {
  const html = markdownToHtml(c.src);
  const back = htmlToSource(html, c.src);
  record('roundtrip', c.name, back === c.src, { in: c.src, out: back, html });
}

for (const c of HTML_CASES) {
  const html = markdownToHtml(c.src);
  const blanks = (html.match(/<p class="nm-blank"><\/p>/g) ?? []).length;
  record('html', c.name, blanks === c.blanks, { expect: c.blanks, actual: blanks, html });
}

for (const c of TIPTAP_CASES) {
  const back = htmlToMarkdown(c.html);
  record('tiptap', c.name, back === c.expect, { html: c.html, expect: c.expect, out: back });
}

const failed = results.filter((r) => !r.pass);
if (JSON_ONLY) {
  console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
} else {
  console.log(`\n=== 汇总：${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length} ===`);
  if (failed.length) {
    console.log('\n失败项（这些就是「保存后空换行丢失」的具体表现）：');
    for (const f of failed) console.log(`  - [${f.kind}] ${f.name}`);
  }
}
process.exit(failed.length ? 1 : 0);
