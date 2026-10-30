import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, htmlToSource, markdownToHtml, splitFrontmatter, joinFrontmatter } from '../vault/markdown-bridge';
import {
  buildDatetimeName,
  buildDocName,
  toNameSummary,
  DEFAULT_NAMING_TEMPLATE,
  sanitizeTitle,
  formatCompactNumber,
  normalizePath,
  uniquePath,
} from '@neomd/shared';
import { parseDoc, resolveTitle, parseYaml, stringifyYaml } from '../vault/markdown-parse';
import { buildExportHtml } from '../export/exporters';

const roundtrip = (s: string): string => htmlToMarkdown(markdownToHtml(s));

describe('markdown 往返保真', () => {
  const cases: Array<[string, string, string]> = [
    ['heading', '# 一级标题\n\n## 二级标题\n\n### 三级标题', '# 一级标题\n\n## 二级标题\n\n### 三级标题'],
    ['paragraph', '这是一个段落。\n\n第二个段落。', '这是一个段落。\n\n第二个段落。'],
    ['emphasis', '**粗体** 与 *斜体* 与 ~~删除~~', '**粗体** 与 *斜体* 与 ~~删除~~'],
    ['inline-code', '使用 `const a = 1` 声明。', '使用 `const a = 1` 声明。'],
    ['code-block', '```ts\nconst a: number = 1;\nconsole.log(a);\n```', '```ts\nconst a: number = 1;\nconsole.log(a);\n```'],
    ['ul', '- 第一项\n- 第二项\n- 第三项', '- 第一项\n- 第二项\n- 第三项'],
    ['ol', '1. 第一步\n2. 第二步', '1. 第一步\n2. 第二步'],
    ['task', '- [ ] 未完成\n- [x] 已完成', '- [ ] 未完成\n- [x] 已完成'],
    ['quote', '> 这是一段引用\n> 第二行', '> 这是一段引用\n> 第二行'],
    ['hr', '上文\n\n---\n\n下文', '上文\n\n---\n\n下文'],
    ['link', '[示例](https://example.com)', '[示例](https://example.com)'],
    ['image', '![替代文本](https://img.example.com/a.png)', '![替代文本](https://img.example.com/a.png)'],
    ['wikilink', '参见 [[项目计划]] 与 [[项目计划|计划]]', '参见 [[项目计划]] 与 [[项目计划|计划]]'],
    [
      'table',
      '| 名称 | 状态 |\n| --- | --- |\n| A | 完成 |\n| B | 进行中 |',
      '| 名称 | 状态 |\n| --- | --- |\n| A | 完成 |\n| B | 进行中 |',
    ],
    ['highlight', '这是 ==高亮== 文本', '这是 ==高亮== 文本'],
    ['underline', '这是 <u>下划线</u> 文本', '这是 <u>下划线</u> 文本'],
  ];

  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(roundtrip(input).replace(/\n+$/, '')).toBe(expected.replace(/\n+$/, ''));
    });
  }

  it('frontmatter preserved', () => {
    const src = '---\ntitle: 我的笔记\ntags: [a, b]\n---\n\n# 正文\n\n内容';
    const { frontmatter, body } = splitFrontmatter(src);
    expect(frontmatter).toContain('title: 我的笔记');
    const bodyMd = htmlToMarkdown(markdownToHtml(body));
    const rejoined = joinFrontmatter({ frontmatter, body: bodyMd });
    expect(rejoined.startsWith('---')).toBe(true);
    expect(rejoined).toContain('# 正文');
  });

  it('task list structure', () => {
    const html = markdownToHtml('- [ ] a\n- [x] b');
    expect(html).toContain('data-type="taskList"');
    expect(html).toContain('data-checked="true"');
  });

  it('wikilink data attrs', () => {
    const html = markdownToHtml('[[笔记名]]');
    expect(html).toContain('data-wikilink="笔记名"');
  });
});

/**
 * 1.2.1 缺陷4：文件保存后空换行丢失。
 *
 * 三条链路各自都曾经丢数据，必须逐条钉住：
 * ① markdownToHtml 把连续空行当块分隔符丢掉（markdown-it 默认行为）；
 * ② htmlToMarkdown 用 `if (s) parts.push(s)` 丢空段落、用 `.trim()` 吃文末换行；
 * ③ htmlToMarkdown 对整串 markdown 跑全局 `\n{3,}` 折叠，把代码块内空行一起吃了。
 *
 * 断言口径统一为**逐字节相等**（含文末换行），因为这是用户打开文件再保存后
 * 期望看到的结果；用 `.replace(/\n+$/,'')` 之类放宽会让缺陷①③重新溜过去。
 */
describe('空行保真（1.2.1 缺陷4）', () => {
  /** 源文本 → HTML → 源文本，必须逐字节相等 */
  const roundtripSource = (s: string): string => htmlToSource(markdownToHtml(s), s);

  const cases: Array<[string, string]> = [
    ['单空行（标准段落分隔，不得增删）', '第一段\n\n第二段\n'],
    ['段间 2 个空行', '第一段\n\n\n第二段\n'],
    ['段间 3 个空行', '第一段\n\n\n\n第二段\n'],
    ['段间 5 个空行', '第一段\n\n\n\n\n\n第二段\n'],
    ['文末 1 个空行（文件以换行结尾）', '正文\n\n'],
    ['文末 3 个空行', '正文\n\n\n\n'],
    ['文末无换行（手写单行文件）', '正文'],
    ['代码块内 3 个空行（逐字保留）', '```js\nconst a = 1;\n\n\n\nconst b = 2;\n```\n'],
    ['代码块内空行 + 段间空行', '上文\n\n\n```\nx\n\n\ny\n```\n\n\n下文\n'],
    ['硬换行（行尾两空格）', '第一行  \n第二行\n'],
    ['frontmatter + 段间空行', '---\ntitle: T\n---\n\n正文\n\n\n后文\n'],
    ['标题 + 列表 + 空行', '# 标题\n\n- a\n- b\n\n\n段落\n'],
    ['空行紧邻代码块围栏', '正文\n\n\n```\ncode\n```\n'],
  ];

  for (const [name, src] of cases) {
    it(name, () => {
      expect(roundtripSource(src)).toBe(src);
    });
  }

  it('连续 N 个空行渲染成 N-1 个空段落（可逆载体）', () => {
    // N=1 是标准段落分隔，不产生空段落；N≥2 才需要额外载体
    expect((markdownToHtml('A\n\nB\n').match(/<p class="nm-blank"><\/p>/g) ?? []).length).toBe(0);
    expect((markdownToHtml('A\n\n\nB\n').match(/<p class="nm-blank"><\/p>/g) ?? []).length).toBe(1);
    expect((markdownToHtml('A\n\n\n\nB\n').match(/<p class="nm-blank"><\/p>/g) ?? []).length).toBe(2);
    expect((markdownToHtml('A\n\n\n\n\n\nB\n').match(/<p class="nm-blank"><\/p>/g) ?? []).length).toBe(4);
  });

  it('代码块内部不生成空段落（否则会往代码里插节点）', () => {
    expect(markdownToHtml('```\na\n\n\nb\n```\n')).not.toContain('nm-blank');
  });

  it('所见即所得里按回车产生的空段落回写成空行', () => {
    // TipTap 的 Paragraph schema 没有 class 属性，空段落可能带 class 也可能不带，
    // 两种形态都必须被认成「一个空行」
    expect(htmlToMarkdown('<p>A</p><p class="nm-blank"></p><p>B</p>')).toBe('A\n\n\nB\n');
    expect(htmlToMarkdown('<p>A</p><p></p><p>B</p>')).toBe('A\n\n\nB\n');
    expect(htmlToMarkdown('<p>A</p><p class="nm-blank"></p><p class="nm-blank"></p><p>B</p>')).toBe('A\n\n\n\nB\n');
  });

  it('代码块内容逐字保留，不做任何空白规整', () => {
    const src = '```\na\n\n\nb\n```\n';
    expect(htmlToMarkdown(markdownToHtml(src))).toBe(src);
    // 行尾空格在代码块里是内容，不能被剪
    expect(htmlToMarkdown(markdownToHtml('```\nx  \ny\n```\n'))).toBe('```\nx  \ny\n```\n');
  });

  it('硬换行不会因 <br> 后的字面换行被升级成段落分隔', () => {
    // markdown-it 渲染 `<br>\n`，那个 \n 是源码缩进不是内容
    expect(markdownToHtml('A  \nB')).toContain('<br>');
    expect(htmlToMarkdown(markdownToHtml('A  \nB\n'))).toBe('A  \nB\n');
  });

  it('图片段落不会被误判成空行', () => {
    const src = '![alt](https://example.com/a.png)\n';
    expect(htmlToMarkdown(markdownToHtml(src))).toBe(src);
  });
});

/**
 * 导出链路与编辑器正文必须同排版（1.2.1 缺陷4 配套）。
 *
 * 为什么这条必须测：`markdownToHtml` 现在会为连续空行产出 `<p class="nm-blank">`，
 * 而导出（HTML/PDF）用的是自己的一份 BASE_CSS，不是 `content.css`。
 * 若 BASE_CSS 里没有对应规则，导出的空行就会按普通段落渲染（margin .6em + 一个行盒），
 * 比编辑器里松一截 —— 典型的「修了编辑器、坏了导出」。
 */
describe('导出排版与编辑器一致（1.2.1）', () => {
  it('BASE_CSS 含空段落规则，且用默认行高 1.6em 而非旧值 1.75em', () => {
    const html = buildExportHtml('A\n\n\nB\n', { title: 'T' });
    // 空段落规则必须存在，且 margin 归零 + min-height 与默认行高一致
    expect(html).toMatch(/\.neomd-export p\.nm-blank\{margin:0;min-height:1\.6em\}/);
    // 段落间距与正文一致（0.6em），不能残留旧值 .85em
    expect(html).toMatch(/\.neomd-export p\{margin:\.6em 0\}/);
    expect(html).not.toMatch(/\.neomd-export p\{margin:\.85em 0\}/);
    // 正文行高与编辑器默认值一致
    expect(html).toMatch(/font-size:16px;line-height:1\.6/);
  });

  it('导出的 HTML 保留空行载体（空段落节点不被丢掉）', () => {
    const html = buildExportHtml('A\n\n\nB\n', { title: 'T' });
    expect(html).toContain('class="nm-blank"');
    // 2 个连续空行 → 1 个空段落，与编辑器侧数量关系一致
    expect((html.match(/<p class="nm-blank"><\/p>/g) ?? []).length).toBe(1);
  });
});

describe('解析器', () => {
  it('提取标题/链接/标签/任务', () => {
    const doc = parseDoc(
      '---\ntitle: T\ntags: [x/y]\n---\n\n# 标题一\n\n见 [[目标]] 与 #标签/子 #另一个\n\n- [ ] 待办\n\n> 引用\n',
    );
    expect(doc.headings[0]?.text).toBe('标题一');
    expect(doc.links.some((l) => l.target === '目标')).toBe(true);
    expect(doc.tags).toContain('标签/子');
    expect(doc.tags).toContain('x/y');
    expect(doc.tasks).toHaveLength(1);
    expect(doc.tasks[0]?.done).toBe(false);
  });

  it('fenced code ignored', () => {
    const doc = parseDoc('```\n# 不是标题\n#不是标签\n```\n\n#真标签');
    expect(doc.headings).toHaveLength(0);
    expect(doc.tags).toContain('真标签');
    expect(doc.tags).not.toContain('不是标签');
  });

  it('标题解析优先级', () => {
    expect(resolveTitle('---\ntitle: FM\n---\n# H1', 'fallback')).toBe('FM');
    expect(resolveTitle('# H1', 'fallback')).toBe('H1');
    expect(resolveTitle('正文', 'fallback')).toBe('fallback');
  });

  it('YAML roundtrip', () => {
    const data = { title: '标题', tags: ['a', 'b'], count: 3, ok: true };
    const back = parseYaml(stringifyYaml(data));
    expect(back.title).toBe('标题');
    expect(back.tags).toEqual(['a', 'b']);
    expect(back.count).toBe(3);
    expect(back.ok).toBe(true);
  });
});

describe('命名规则', () => {
  it('datetime prefix', () => {
    const now = new Date(2026, 9, 23, 14, 5, 0);
    const name = buildDatetimeName('会议记录', { template: 'YY年MM月DD日HHMM-【input】', fallback: '无标题' }, now);
    expect(name).toBe('26年10月23日1405-【会议记录】.md');
  });

  it('brace template also works', () => {
    const now = new Date(2026, 0, 2, 3, 4, 5);
    const name = buildDatetimeName('A', { template: '{YYYY}{MM}{DD}-{HH}{mm}-{input}', fallback: 'x' }, now);
    expect(name).toBe('20260102-0304-A.md');
  });

  it('empty input keeps bare timestamp name (1.0.2 新语义)', () => {
    const now = new Date(2026, 0, 2, 3, 4, 0);
    // 1.0.2 起：input 为空时占位符直接替换为空串，得到纯时间戳名（末尾保留模板里的 `-`），
    // 不再回退成「无标题」。AI 缩写留到首次保存时补。
    const name = buildDatetimeName('   ', { template: 'YYMMDD日HHMM-{input}', fallback: '无标题' }, now);
    expect(name).toBe('260102日0304-.md');
  });

  it('模板被清空时恢复默认模板（而非变成无标题）', () => {
    const now = new Date(2026, 0, 2, 3, 4, 0);
    const name = buildDatetimeName('', { template: '   ', fallback: '无标题' }, now);
    expect(name).toBe('260102日0304-.md');
  });

  it('默认模板 YYMMDD日HHMM- 生成符合 1.0.2 规格', () => {
    const now = new Date(2026, 9, 26, 21, 30, 0);
    const name = buildDatetimeName('', { template: DEFAULT_NAMING_TEMPLATE, fallback: '无标题' }, now);
    expect(name).toBe('261026日2130-.md');
  });

  it('AI 缩写：4-10 字，不足 4 字返回空，超长截断到 10 字', () => {
    // 7 个字在 4-10 区间内，应原样保留
    expect(toNameSummary('知识库搭建指南')).toBe('知识库搭建指南');
    // 不足 4 字（含纯标点/空）→ 返回空，宁可不加也不塞半截词
    expect(toNameSummary('短')).toBe('');
    expect(toNameSummary('')).toBe('');
    // 超过 10 字 → 截断
    const long = toNameSummary('这是一个非常长的笔记标题需要截断处理');
    expect(Array.from(long).length).toBe(10);
    // 标点与 Markdown 标记被清除
    expect(toNameSummary('**Vue3** 组件，设计')).toBe('Vue3组件设计');
  });

  it('带 AI 缩写的完整文件名', () => {
    const now = new Date(2026, 9, 26, 21, 30, 0);
    const name = buildDocName('知识库搭建指南', { template: DEFAULT_NAMING_TEMPLATE, fallback: '无标题' }, now);
    expect(name).toBe('261026日2130-知识库搭建指南.md');
  });

  it('AI 不可用（缩写为空）时文件名保持纯时间戳', () => {
    const now = new Date(2026, 9, 26, 21, 30, 0);
    const name = buildDocName('', { template: DEFAULT_NAMING_TEMPLATE, fallback: '无标题' }, now);
    expect(name).toBe('261026日2130-.md');
  });

  it('sanitize', () => {
    expect(sanitizeTitle('a/b:c*d?e"f<g>h|i')).toBe('a b c d e f g h i');
  });

  it('unique path', () => {
    const taken = new Set(['a.md', 'a (2).md']);
    expect(uniquePath('a.md', taken)).toBe('a (3).md');
  });

  it('normalize path', () => {
    expect(normalizePath('.\\a\\b//c.md')).toBe('a/b/c.md');
  });
});

describe('数字格式', () => {
  it('万单位', () => {
    expect(formatCompactNumber(9999)).toBe('9999');
    expect(formatCompactNumber(12345)).toBe('1.2万');
    expect(formatCompactNumber(156789)).toBe('15.7万');
    expect(formatCompactNumber(10001)).toBe('1.0万');
  });
});
