import { describe, expect, it } from 'vitest';
import type { ObsidianImportOptions } from '@neomd/shared';
import {
  convertObsidianMarkdown,
  detectObsidianSyntax,
  parseFrontmatterTags,
  shouldSkipPath,
} from '../import/obsidian';

/** 全开的默认选项，单测里按需覆盖单个开关 */
function opts(patch: Partial<ObsidianImportOptions> = {}): ObsidianImportOptions {
  return {
    targetFolder: '',
    keepTimestamps: true,
    convertSyntax: true,
    convertEmbeds: true,
    convertComments: true,
    convertCallouts: true,
    convertHighlights: true,
    normalizeTasks: true,
    normalizeHardBreaks: false,
    skipConfigDirs: true,
    onConflict: 'rename',
    ...patch,
  };
}

const run = (text: string, patch: Partial<ObsidianImportOptions> = {}) => convertObsidianMarkdown(text, opts(patch));

/* ------------------------------------------------------------------ */
/* 1. 硬换行                                                           */
/* ------------------------------------------------------------------ */
describe('1. 硬换行 normalizeHardBreaks', () => {
  it('段落内的单换行补两个空格', () => {
    const r = run('第一行\n第二行', { normalizeHardBreaks: true });
    expect(r.text).toBe('第一行  \n第二行');
    expect(r.conversions).toContain('hard-break');
  });

  it('关闭开关时原样保留', () => {
    const r = run('第一行\n第二行', { normalizeHardBreaks: false });
    expect(r.text).toBe('第一行\n第二行');
  });

  // 关键回归：绝不能给标题/列表/表格/代码块/frontmatter 补空格
  it('不给标题行补两空格', () => {
    const r = run('# 标题\n正文', { normalizeHardBreaks: true });
    expect(r.text).toBe('# 标题\n正文');
  });

  it('不给列表项补两空格', () => {
    const r = run('- 项目一\n- 项目二', { normalizeHardBreaks: true });
    expect(r.text).toBe('- 项目一\n- 项目二');
  });

  it('不给表格行补两空格', () => {
    const src = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    const r = run(src, { normalizeHardBreaks: true });
    expect(r.text).toBe(src);
  });

  it('不给代码块内部补两空格', () => {
    const src = '```ts\nconst a = 1;\nconst b = 2;\n```';
    const r = run(src, { normalizeHardBreaks: true });
    expect(r.text).toBe(src);
  });

  it('不给 frontmatter 补两空格', () => {
    const src = '---\ntitle: 标题\ntags: [a]\n---\n正文';
    const r = run(src, { normalizeHardBreaks: true });
    expect(r.text).toBe(src);
  });

  it('段落换行处（空行）不补两空格', () => {
    const r = run('段落一\n\n段落二', { normalizeHardBreaks: true });
    expect(r.text).toBe('段落一\n\n段落二');
  });

  it('已有行尾两空格时不重复追加', () => {
    const r = run('第一行  \n第二行', { normalizeHardBreaks: true });
    expect(r.text).toBe('第一行  \n第二行');
  });
});

/* ------------------------------------------------------------------ */
/* 2. Callout                                                          */
/* ------------------------------------------------------------------ */
describe('2. Callout 标注块', () => {
  it('转为引用块 + 粗体标题', () => {
    const r = run('> [!note] 这是一个提示\n> 正文内容');
    expect(r.text).toBe('> **这是一个提示**\n> 正文内容');
    expect(r.conversions).toContain('callout');
  });

  it('无标题时用类型名兜底', () => {
    const r = run('> [!warning]');
    expect(r.text).toBe('> **Warning**');
    expect(r.conversions).toContain('callout');
  });

  it('可折叠标记 - 会追加说明注释', () => {
    const r = run('> [!warning]- 折叠标题');
    expect(r.text).toContain('> **折叠标题**');
    expect(r.text).toContain('原为可折叠 callout');
  });

  it('普通引用块不被误伤', () => {
    const r = run('> 普通引用');
    expect(r.text).toBe('> 普通引用');
    expect(r.conversions).not.toContain('callout');
  });
});

/* ------------------------------------------------------------------ */
/* 3. 注释                                                             */
/* ------------------------------------------------------------------ */
describe('3. 注释 %%…%%', () => {
  it('行内注释转 HTML 注释', () => {
    const r = run('前 %%这是注释%% 后');
    expect(r.text).toBe('前 <!-- 这是注释 --> 后');
    expect(r.conversions).toContain('comment');
  });

  it('跨行块注释转 HTML 注释', () => {
    const r = run('%%\n多行\n注释\n%%');
    expect(r.text).toContain('<!--');
    expect(r.text).toContain('多行');
    expect(r.text).not.toContain('%%');
    expect(r.conversions).toContain('comment');
  });

  it('代码块内的 %% 不被转换', () => {
    const src = '```\na %% b %% c\n```';
    const r = run(src);
    expect(r.text).toBe(src);
    expect(r.conversions).not.toContain('comment');
  });
});

/* ------------------------------------------------------------------ */
/* 4. 高亮                                                             */
/* ------------------------------------------------------------------ */
describe('4. 高亮 ==…==', () => {
  it('转为 mark 标签', () => {
    const r = run('这是 ==重点内容== 结束');
    expect(r.text).toBe('这是 <mark>重点内容</mark> 结束');
    expect(r.conversions).toContain('highlight');
  });

  it('不误伤 === 等号串', () => {
    const r = run('a === b');
    expect(r.text).toBe('a === b');
    expect(r.conversions).not.toContain('highlight');
  });

  it('代码块内的高亮标记不被转换', () => {
    const src = '```\n==不是高亮==\n```';
    const r = run(src);
    expect(r.text).toBe(src);
    expect(r.conversions).not.toContain('highlight');
  });
});

/* ------------------------------------------------------------------ */
/* 5/6. 嵌入与块引用                                                   */
/* ------------------------------------------------------------------ */
describe('5. 嵌入 ![[…]]', () => {
  it('图片嵌入转标准 Markdown 图片', () => {
    const r = run('![[image.png]]');
    expect(r.text).toBe('![](image.png)');
    expect(r.conversions).toContain('embed-image');
  });

  it('带尺寸的图片保留尺寸说明注释', () => {
    const r = run('![[image.png|300]]');
    expect(r.text).toBe('![](image.png)<!-- 原始尺寸: 300 -->');
    expect(r.conversions).toContain('embed-image');
  });

  it('笔记嵌入降级为 wikilink 并留注释', () => {
    const r = run('![[note.md]]');
    expect(r.text).toContain('[[note]]');
    expect(r.text).toContain('原为嵌入笔记');
    expect(r.conversions).toContain('embed-note');
  });

  it('嵌入笔记带标题锚点保留锚点', () => {
    const r = run('![[note#标题]]');
    expect(r.text).toContain('[[note#标题]]');
    expect(r.conversions).toContain('embed-note');
  });
});

describe('6. 块引用 ![[note#^blockid]]', () => {
  it('转为普通 wikilink', () => {
    const r = run('![[note#^blockid]]');
    expect(r.text).toBe('[[note#^blockid]]');
    expect(r.conversions).toContain('block-ref');
  });
});

/* ------------------------------------------------------------------ */
/* 7. 块 ID                                                            */
/* ------------------------------------------------------------------ */
describe('7. 块 ID ^blockid', () => {
  it('行尾块 ID 被移除', () => {
    const r = run('这是一个段落 ^myblockid');
    expect(r.text).toBe('这是一个段落');
    expect(r.conversions).toContain('block-id');
  });

  it('普通数学尖号不被误删', () => {
    const r = run('计算 a ^ 2');
    expect(r.text).toBe('计算 a ^ 2');
    expect(r.conversions).not.toContain('block-id');
  });
});

/* ------------------------------------------------------------------ */
/* 8. 任务列表                                                         */
/* ------------------------------------------------------------------ */
describe('8. 任务列表', () => {
  it('进行中 [/] 降级为未勾选并留痕', () => {
    const r = run('- [/] 进行中任务');
    expect(r.text).toBe('- [ ] 进行中任务<!-- in-progress -->');
    expect(r.conversions).toContain('task-in-progress');
  });

  it('已完成 [x] 保持标准 GFM', () => {
    const r = run('- [x] 已完成');
    expect(r.text).toBe('- [x] 已完成');
  });

  it('未完成 [ ] 保持原样', () => {
    const r = run('- [ ] 未完成');
    expect(r.text).toBe('- [ ] 未完成');
  });

  it('大写 [X] 统一为小写', () => {
    const r = run('- [X] 完成了');
    expect(r.text).toBe('- [x] 完成了');
  });
});

/* ------------------------------------------------------------------ */
/* 9. Wikilink                                                         */
/* ------------------------------------------------------------------ */
describe('9. Wikilink 保持原样', () => {
  it('带别名的 wikilink 不变', () => {
    const r = run('[[note|别名]]');
    expect(r.text).toBe('[[note|别名]]');
  });

  it('带标题锚点的 wikilink 不变', () => {
    const r = run('[[note#标题]]');
    expect(r.text).toBe('[[note#标题]]');
  });
});

/* ------------------------------------------------------------------ */
/* 10. 数学                                                            */
/* ------------------------------------------------------------------ */
describe('10. 数学公式保持原样', () => {
  it('行内数学不变', () => {
    const r = run('公式 $a^2 + b^2 = c^2$ 成立');
    expect(r.text).toBe('公式 $a^2 + b^2 = c^2$ 成立');
  });

  it('块级数学不变', () => {
    const src = '$$\nE = mc^2\n$$';
    const r = run(src);
    expect(r.text).toBe(src);
  });
});

/* ------------------------------------------------------------------ */
/* 11. Dataview                                                        */
/* ------------------------------------------------------------------ */
describe('11. Dataview / query 查询块', () => {
  it('dataview 围栏转 text 并加说明注释', () => {
    const src = '```dataview\nTABLE file.mtime FROM ""\n```';
    const r = run(src);
    expect(r.text).toContain('Obsidian 查询语法');
    expect(r.text).toContain('```');
    expect(r.text).toContain('TABLE file.mtime');
    expect(r.text).not.toContain('```dataview');
    expect(r.conversions).toContain('dataview');
  });

  it('query 围栏同样处理', () => {
    const src = '```query\npath:notes\n```';
    const r = run(src);
    expect(r.text).toContain('Obsidian 查询语法');
    expect(r.text).not.toContain('```query');
    expect(r.conversions).toContain('dataview');
  });
});

/* ------------------------------------------------------------------ */
/* 12. Mermaid                                                         */
/* ------------------------------------------------------------------ */
describe('12. Mermaid 保持原样', () => {
  it('mermaid 围栏不被改写', () => {
    const src = '```mermaid\ngraph TD\nA --> B\n```';
    const r = run(src);
    expect(r.text).toBe(src);
    expect(r.conversions).not.toContain('dataview');
  });
});

/* ------------------------------------------------------------------ */
/* detectObsidianSyntax                                                */
/* ------------------------------------------------------------------ */
describe('detectObsidianSyntax 语法预检', () => {
  it('能识别多种 Obsidian 语法', () => {
    const text = ['> [!note] 标题', '有 ==高亮== 与 %%注释%%', '![[a.png]]', '段落 ^bid'].join('\n');
    const hits = detectObsidianSyntax(text);
    expect(hits).toContain('callout');
    expect(hits).toContain('highlight');
    expect(hits).toContain('comment');
    expect(hits).toContain('embed');
    expect(hits).toContain('block-id');
  });

  it('标准 Markdown 不会误报', () => {
    const hits = detectObsidianSyntax('# 标题\n\n普通段落文本。');
    expect(hits).not.toContain('callout');
    expect(hits).not.toContain('highlight');
    expect(hits).not.toContain('embed');
  });

  it('空文本返回空数组', () => {
    expect(detectObsidianSyntax('')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* shouldSkipPath                                                      */
/* ------------------------------------------------------------------ */
describe('shouldSkipPath 目录过滤', () => {
  it('跳过 .obsidian 配置目录', () => {
    expect(shouldSkipPath('.obsidian/app.json')).toBe(true);
    expect(shouldSkipPath('.obsidian/plugins/foo/main.js')).toBe(true);
  });

  it('跳过 .trash / .git / node_modules', () => {
    expect(shouldSkipPath('.trash/旧笔记.md')).toBe(true);
    expect(shouldSkipPath('.git/config')).toBe(true);
    expect(shouldSkipPath('a/node_modules/pkg/index.js')).toBe(true);
  });

  it('跳过系统垃圾文件', () => {
    expect(shouldSkipPath('notes/.DS_Store')).toBe(true);
    expect(shouldSkipPath('Thumbs.db')).toBe(true);
  });

  it('正常笔记不跳过', () => {
    expect(shouldSkipPath('笔记/我的笔记.md')).toBe(false);
    expect(shouldSkipPath('a/b/c.md')).toBe(false);
  });

  it('空路径跳过', () => {
    expect(shouldSkipPath('')).toBe(true);
  });

  it('名字含 obsidian 但不该跳过的保留', () => {
    expect(shouldSkipPath('obsidian 使用心得.md')).toBe(false);
  });

  // 安全：路径穿越与绝对路径必须被拒绝（否则可写出仓库外）
  it('拒绝路径穿越 ..', () => {
    expect(shouldSkipPath('../evil.md')).toBe(true);
    expect(shouldSkipPath('a/../../etc/passwd')).toBe(true);
    expect(shouldSkipPath('a/../b.md')).toBe(true);
  });

  it('拒绝绝对路径与盘符路径', () => {
    expect(shouldSkipPath('/etc/passwd')).toBe(true);
    expect(shouldSkipPath('C:\\Windows\\System32\\evil.md')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* parseFrontmatterTags                                                */
/* ------------------------------------------------------------------ */
describe('parseFrontmatterTags 标签解析', () => {
  it('解析行内数组写法', () => {
    const tags = parseFrontmatterTags('---\ntags: [读书, 技术]\n---\n正文');
    expect(tags).toEqual(['读书', '技术']);
  });

  it('解析逗号分隔串', () => {
    const tags = parseFrontmatterTags('---\ntags: 读书, 技术, 笔记\n---\n正文');
    expect(tags).toEqual(['读书', '技术', '笔记']);
  });

  it('解析块级列表写法', () => {
    const tags = parseFrontmatterTags('---\ntags:\n  - 读书\n  - 技术\n---\n正文');
    expect(tags).toEqual(['读书', '技术']);
  });

  it('解析单数 tag 字段并去掉井号', () => {
    const tags = parseFrontmatterTags('---\ntag: #笔记\n---\n正文');
    expect(tags).toEqual(['笔记']);
  });

  it('无 frontmatter 返回空数组', () => {
    expect(parseFrontmatterTags('# 标题\n正文')).toEqual([]);
  });

  it('无标签字段返回空数组', () => {
    expect(parseFrontmatterTags('---\ntitle: 标题\n---\n正文')).toEqual([]);
  });

  it('去重', () => {
    const tags = parseFrontmatterTags('---\ntags: [a, a, b]\n---\n正文');
    expect(tags).toEqual(['a', 'b']);
  });
});

/* ------------------------------------------------------------------ */
/* 组合场景                                                            */
/* ------------------------------------------------------------------ */
describe('组合场景', () => {
  it('一篇真实笔记的多语法混合转换', () => {
    const src = [
      '---',
      'tags: [读书]',
      '---',
      '> [!tip] 阅读提示',
      '这里是 ==重点== 与 %%隐藏备注%%',
      '- [/] 待办',
      '![[cover.png|400]]',
      '',
      '```dataview',
      'LIST FROM #读书',
      '```',
    ].join('\n');

    const r = run(src, { normalizeHardBreaks: true });
    expect(r.text).toContain('> **阅读提示**');
    expect(r.text).toContain('<mark>重点</mark>');
    expect(r.text).toContain('<!-- 隐藏备注 -->');
    expect(r.text).toContain('<!-- in-progress -->');
    expect(r.text).toContain('![](cover.png)<!-- 原始尺寸: 400 -->');
    expect(r.text).toContain('Obsidian 查询语法');
    // frontmatter 原样保留
    expect(r.text).toContain('tags: [读书]');
    expect(r.conversions.length).toBeGreaterThanOrEqual(5);
  });

  it('关闭 convertSyntax 时完全不动正文', () => {
    const src = '> [!note] 标题\n==高亮==\n%%注释%%';
    const r = run(src, { convertSyntax: false });
    expect(r.text).toBe(src);
    expect(r.conversions).toEqual([]);
  });
});
