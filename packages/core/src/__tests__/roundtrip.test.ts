import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, markdownToHtml, splitFrontmatter, joinFrontmatter } from '../vault/markdown-bridge';
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
