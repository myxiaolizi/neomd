import type { ObsidianImportOptions } from '@neomd/shared';

/**
 * Obsidian → Neo MD 的 Markdown 语法转换引擎。
 *
 * 这里全部是纯函数，不碰文件系统、不依赖运行时，便于单元测试。
 *
 * 设计要点（踩过的坑）：
 * 1. **绝不能对代码块、frontmatter、表格、标题、列表行做行内替换**，
 *    否则 `==`、`%%`、`![[` 这类字符在代码示例里会被破坏。
 *    因此所有转换先做一次「行区域分类」，只有 `normal` 区域才参与转换。
 * 2. **硬换行必须用逐行状态机**，判据是「当前行与下一行都属于同一段落」。
 *    只要任一侧是块级起始（标题/列表/表格/引用/围栏/分隔线/HTML 块/缩进代码），
 *    就不补两空格——补了会让标题变正文、列表项错位。
 */

/* ------------------------------------------------------------------ */
/* 行区域分类                                                          */
/* ------------------------------------------------------------------ */

/** 行所处的区域：frontmatter / 代码围栏 / 普通正文 */
type LineRegion = 'frontmatter' | 'fence' | 'normal';

interface LineInfo {
  /** 原始行文本（不含换行符） */
  text: string;
  region: LineRegion;
  /** 该行是否为围栏标记行本身（``` / ~~~ 的开闭行） */
  isFenceMarker: boolean;
}

/** 围栏正则：最多 3 个前导空格，``` 或 ~~~ 至少 3 个 */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/**
 * 把文本切成行并标注区域。
 * frontmatter 只在文件首行是 `---` 时才成立（避免把正文里的分隔线误判）。
 */
function classifyLines(text: string): LineInfo[] {
  const raw = text.split(/\r?\n/);
  const out: LineInfo[] = [];
  let inFrontmatter = false;
  let fenceMarker: string | null = null;

  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i] ?? '';

    // frontmatter 起始：必须是第 0 行且形如 ---
    if (i === 0 && /^---\s*$/.test(line.trim())) {
      inFrontmatter = true;
      out.push({ text: line, region: 'frontmatter', isFenceMarker: false });
      continue;
    }
    if (inFrontmatter) {
      if (/^(---|\.\.\.)\s*$/.test(line.trim())) inFrontmatter = false;
      out.push({ text: line, region: 'frontmatter', isFenceMarker: false });
      continue;
    }

    // 代码围栏
    if (fenceMarker === null) {
      const open = FENCE_OPEN.exec(line);
      if (open) {
        fenceMarker = open[1]!;
        out.push({ text: line, region: 'fence', isFenceMarker: true });
        continue;
      }
      out.push({ text: line, region: 'normal', isFenceMarker: false });
      continue;
    }

    // 已在围栏内部：找同类型且不短于开启标记的闭合行
    const close = FENCE_CLOSE.exec(line);
    if (close && close[1]!.startsWith(fenceMarker[0]!) && close[1]!.length >= fenceMarker.length) {
      out.push({ text: line, region: 'fence', isFenceMarker: true });
      fenceMarker = null;
      continue;
    }
    out.push({ text: line, region: 'fence', isFenceMarker: false });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 通用判断                                                            */
/* ------------------------------------------------------------------ */

/** 是否为块级起始行（这类行两侧都不应补硬换行） */
function isBlockStarter(line: string): boolean {
  const t = line.trim();
  if (!t) return true; // 空行 = 段落边界
  if (/^\t/.test(line) || /^ {4,}\S/.test(line)) return true; // 缩进代码块
  if (/^#{1,6}\s/.test(t)) return true; // ATX 标题
  if (/^#{1,6}$/.test(t)) return true; // 空标题
  if (/^([-*+]|\d+[.)])\s/.test(t)) return true; // 列表项（含任务列表）
  if (/^\|/.test(t)) return true; // 表格行
  if (/^>/.test(t)) return true; // 引用块
  if (/^(`{3,}|~{3,})/.test(t)) return true; // 代码围栏
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) return true; // 分隔线
  if (/^<[a-zA-Z!/]/.test(t)) return true; // HTML 块
  if (/^\$\$\s*$/.test(t)) return true; // 数学块分隔
  return false; // 普通段落文本
}

/** 图片/音视频等可作为 `<img>` 渲染的扩展名 */
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|tiff?|mp3|mp4|webm|wav|ogg|m4a|mov)$/i;

/** 去掉 HTML 注释里非法的 `--` 序列，避免破坏注释边界 */
function safeComment(text: string): string {
  return text.replace(/--+/g, (m) => new Array(m.length).fill('-').join(' ')).replace(/</g, '‹').replace(/>/g, '›');
}

/* ------------------------------------------------------------------ */
/* 单条语法转换                                                        */
/* ------------------------------------------------------------------ */

/** 2. Callout：`> [!note] 标题` / `> [!warning]- 折叠标题` → `> **标题**` */
function convertCalloutLine(line: string): { line: string; hit: boolean } {
  const m = /^(\s{0,3}>\s*)\[!([A-Za-z][\w-]*)\]([+-]?)\s*(.*)$/.exec(line);
  if (!m) return { line, hit: false };
  const prefix = m[1]!;
  const kind = m[2]!;
  const modifier = m[3]!;
  const rawTitle = (m[4] ?? '').trim();
  // 无标题时用类型名兜底，保证转换后仍能看出原本是什么块
  const title = rawTitle || kind.charAt(0).toUpperCase() + kind.slice(1);
  const foldNote = modifier === '-' ? ' <!-- 原为可折叠 callout（默认收起） -->' : '';
  return { line: `${prefix}**${title}**${foldNote}`, hit: true };
}

/** 7. 块 ID：行尾 ` ^blockid` 移除（Obsidian 块引用锚点，Neo MD 不支持） */
function stripBlockId(line: string): { line: string; hit: boolean } {
  const m = /^([\s\S]*?)\s+\^([A-Za-z0-9-]+)\s*$/.exec(line);
  if (!m) return { line, hit: false };
  // 纯 `^` 或数学里的 ^ 不处理：要求前面有实际内容
  const head = m[1] ?? '';
  if (!head.trim()) return { line, hit: false };
  return { line: head, hit: true };
}

/** 8. 任务列表：`[/]` 进行中 → `[ ]` + 注释；`[X]` 统一小写 */
function convertTaskLine(line: string): { line: string; hit: boolean } {
  const m = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX/])\](.*)$/.exec(line);
  if (!m) return { line, hit: false };
  const prefix = m[1]!;
  const mark = m[2]!;
  const rest = m[3] ?? '';
  if (mark === '/') {
    // Obsidian 的「进行中」在 GFM 里没有对应状态，降级为未勾选并留痕
    return { line: `${prefix}[ ]${rest}<!-- in-progress -->`, hit: true };
  }
  if (mark === 'X') return { line: `${prefix}[x]${rest}`, hit: true };
  // `[ ]` 与 `[x]` 本身就是标准 GFM，无需改写
  return { line, hit: false };
}

/** 5/6. 嵌入：`![[...]]` → 图片 或 普通 wikilink */
function convertEmbedsInLine(line: string): { line: string; conversions: string[] } {
  const conversions = new Set<string>();
  const replaced = line.replace(/!\[\[([^\]]+)\]\]/g, (_all, innerRaw: string) => {
    const inner = String(innerRaw).trim();
    // 拆出 `目标|别名/尺寸`
    const pipe = inner.indexOf('|');
    const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
    const pipeValue = pipe >= 0 ? inner.slice(pipe + 1).trim() : '';
    if (!target) return _all;

    // 6. 块引用：![[note#^blockid]] → [[note#^blockid]]
    if (target.includes('#^')) {
      conversions.add('block-ref');
      return `[[${target}]]`;
    }

    // 5. 图片/音视频嵌入 → 标准 Markdown 图片
    if (MEDIA_EXT.test(target)) {
      conversions.add('embed-image');
      const sizeNote = /^\d+(x\d+)?$/.test(pipeValue) ? `<!-- 原始尺寸: ${pipeValue} -->` : '';
      return `![](${target})${sizeNote}`;
    }

    // 5. 笔记嵌入 → 普通 wikilink（Neo MD 不内联渲染子文档正文）
    conversions.add('embed-note');
    const anchor = target.includes('#') ? target : target.replace(/\.md$/i, '');
    return `[[${anchor}]]<!-- 原为嵌入笔记: ${target} -->
`;
  });
  return { line: replaced.replace(/\n$/, ''), conversions: [...conversions] };
}

/** 4. 高亮：`==文本==` → `<mark>文本</mark>`（不含等号本身，避免误伤 ===） */
function convertHighlightsInLine(line: string): { line: string; hit: boolean } {
  let hit = false;
  // [^=\n] 保证不跨越 `===`（如分隔线或代码中的等号串）
  const replaced = line.replace(/==([^=\n]+?)==/g, (_all, inner: string) => {
    hit = true;
    return `<mark>${inner}</mark>`;
  });
  return { line: replaced, hit };
}

/**
 * 3. 注释：`%%…%%` → `<!-- … -->`
 * 支持行内成对与跨行块注释，需要外部传入块状态。
 */
function convertCommentsInLine(line: string, state: { inBlock: boolean }): { line: string; hit: boolean } {
  let hit = false;

  // 处于块注释中：寻找闭合的 %%
  if (state.inBlock) {
    const close = line.indexOf('%%');
    if (close === -1) {
      hit = true;
      return { line: `<!-- ${safeComment(line)} -->`, hit };
    }
    state.inBlock = false;
    hit = true;
    const before = line.slice(0, close);
    const after = line.slice(close + 2);
    const tail = after.trim() ? convertCommentsInLine(after, state) : { line: '', hit: false };
    return { line: `<!-- ${safeComment(before)} -->${tail.line}`, hit };
  }

  if (!line.includes('%%')) return { line, hit: false };

  let result = '';
  let rest = line;
  while (rest.length) {
    const start = rest.indexOf('%%');
    if (start === -1) {
      result += rest;
      break;
    }
    result += rest.slice(0, start);
    const after = rest.slice(start + 2);
    const end = after.indexOf('%%');
    if (end === -1) {
      // 没有闭合 → 开启块注释，剩余部分整体转注释
      state.inBlock = true;
      hit = true;
      result += `<!-- ${safeComment(after)}`;
      return { line: result, hit };
    }
    hit = true;
    result += `<!-- ${safeComment(after.slice(0, end))} -->`;
    rest = after.slice(end + 2);
  }
  return { line: result, hit };
}

/** 11. Dataview / query 查询块 → 普通 text 代码块 + 说明注释 */
const QUERY_FENCE = /^ {0,3}(`{3,}|~{3,})\s*(dataview|dataviewjs|query)\s*$/i;

/**
 * 1. 硬换行逐行状态机。
 *
 * 判据分两层，缺一不可：
 * - **区域层**：先重新分类，`frontmatter` 与 `fence`（代码块）内一律不处理。
 *   只靠内容正则判断是不够的——YAML 的 `title: 标题` 和代码里的 `const a = 1;`
 *   都长得像普通段落文本，会给它们加上两空格并破坏语法。
 * - **行层**：当前行与下一行必须同属一个段落（都不是块级起始），
 *   否则会出现标题被拉进正文、列表项错位的问题。
 */
function normalizeHardBreaks(lines: string[]): string[] {
  const infos = classifyLines(lines.join('\n'));
  const out: string[] = [];

  for (let i = 0; i < infos.length; i += 1) {
    const cur = infos[i]!;
    const next = infos[i + 1];

    // frontmatter / 代码围栏内部：原样输出，绝不加两空格
    if (cur.region !== 'normal') {
      out.push(cur.text);
      continue;
    }
    // 段落末尾（文件结尾或下一行属于其它区域）
    if (!next || next.region !== 'normal') {
      out.push(cur.text);
      continue;
    }
    // 任一侧是块级起始 → 不构成段内换行
    if (isBlockStarter(cur.text) || isBlockStarter(next.text)) {
      out.push(cur.text);
      continue;
    }
    // 已显式硬换行（行尾反斜杠 或 行尾 2+ 空格）→ 不重复追加
    if (/\\$/.test(cur.text) || / {2,}$/.test(cur.text)) {
      out.push(cur.text);
      continue;
    }
    out.push(`${cur.text}  `);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 对外 API                                                            */
/* ------------------------------------------------------------------ */

/**
 * 检测一段文本是否含 Obsidian 专有语法。
 * 返回命中的语法标识列表（供导入界面做「发现 N 处需要转换」的预检提示）。
 */
export function detectObsidianSyntax(text: string): string[] {
  const hits = new Set<string>();
  if (!text) return [];

  const lines = classifyLines(text);
  let inComment = false;

  for (let i = 0; i < lines.length; i += 1) {
    const info = lines[i]!;
    if (info.region !== 'normal') {
      if (info.isFenceMarker && QUERY_FENCE.test(info.text)) hits.add('dataview');
      continue;
    }
    const line = info.text;

    if (/^\s{0,3}>\s*\[![A-Za-z][\w-]*\][+-]?/.test(line)) hits.add('callout');
    if (line.includes('%%')) hits.add('comment');
    if (/==[^=\n]+?==/.test(line)) hits.add('highlight');
    if (/!\[\[[^\]]*#\^/.test(line)) hits.add('block-ref');
    else if (/!\[\[/.test(line)) hits.add('embed');
    if (/\s\^[A-Za-z0-9-]+\s*$/.test(line)) hits.add('block-id');
    if (/^\s*(?:[-*+]|\d+[.)])\s+\[\/\]/.test(line)) hits.add('task-in-progress');
    if (/\[\[[^\]]+\]\]/.test(line)) hits.add('wikilink');
    // 块注释跨行的持续标记
    if (inComment && line.includes('%%')) inComment = false;
    else if (line.split('%%').length % 2 === 0) inComment = true;

    // 段内单换行（后一行是普通段落文本）说明存在 Obsidian 软换行语义
    const nextInfo = lines[i + 1];
    if (nextInfo && nextInfo.region === 'normal' && nextInfo.text.trim()) {
      if (!isBlockStarter(line) && !isBlockStarter(nextInfo.text)) hits.add('hard-break');
    }
  }
  return [...hits];
}

/**
 * 把 Obsidian Markdown 转换为 Neo MD 可正确渲染的 Markdown。
 *
 * `opts` 中各 `convertXxx` 开关独立生效；`normalizeHardBreaks` 默认应在 UI 中开启。
 */
export function convertObsidianMarkdown(
  text: string,
  opts: ObsidianImportOptions,
): { text: string; conversions: string[] } {
  if (!text) return { text, conversions: [] };

  const classified = classifyLines(text);
  const applied = new Set<string>();
  const commentState = { inBlock: false };
  const out: string[] = [];

  for (const info of classified) {
    // ---- 围栏标记行：只处理 dataview/query，其余原样 ----
    if (info.region === 'fence') {
      if (info.isFenceMarker && opts.convertSyntax) {
        const m = QUERY_FENCE.exec(info.text);
        if (m) {
          applied.add('dataview');
          const fence = m[1]!;
          out.push('<!-- Obsidian 查询语法（dataview / query），Neo MD 不执行 -->');
          out.push(fence);
          continue;
        }
      }
      out.push(info.text);
      continue;
    }

    // ---- frontmatter：完全保持原样 ----
    if (info.region === 'frontmatter') {
      out.push(info.text);
      continue;
    }

    // ---- 普通正文行 ----
    let line = info.text;

    // 2. Callout
    if (opts.convertSyntax && opts.convertCallouts) {
      const r = convertCalloutLine(line);
      if (r.hit) {
        line = r.line;
        applied.add('callout');
      }
    }

    // 7. 块 ID（放在行内替换之前，避免注释/高亮改动尾部的 ^id）
    if (opts.convertSyntax) {
      const r = stripBlockId(line);
      if (r.hit) {
        line = r.line;
        applied.add('block-id');
      }
    }

    // 8. 任务列表
    if (opts.convertSyntax && opts.normalizeTasks) {
      const r = convertTaskLine(line);
      if (r.hit) {
        line = r.line;
        applied.add('task-in-progress');
      }
    }

    // 5/6. 嵌入与块引用
    if (opts.convertSyntax && opts.convertEmbeds) {
      const r = convertEmbedsInLine(line);
      if (r.conversions.length) {
        line = r.line;
        for (const c of r.conversions) applied.add(c);
      }
    }

    // 3. 注释（在嵌入之后，避免 `%%![[x]]%%` 的内容被先当嵌入处理）
    if (opts.convertSyntax && opts.convertComments) {
      const r = convertCommentsInLine(line, commentState);
      if (r.hit) {
        line = r.line;
        applied.add('comment');
      }
    }

    // 4. 高亮
    if (opts.convertSyntax && opts.convertHighlights) {
      const r = convertHighlightsInLine(line);
      if (r.hit) {
        line = r.line;
        applied.add('highlight');
      }
    }

    out.push(line);
  }

  // 1. 硬换行：必须放在最后，基于已完成语法转换的行做状态机
  let finalLines = out;
  if (opts.normalizeHardBreaks) {
    const before = out.join('\n');
    finalLines = normalizeHardBreaks(out);
    if (finalLines.join('\n') !== before) applied.add('hard-break');
  }

  return { text: finalLines.join('\n'), conversions: [...applied] };
}

/** 始终跳过的目录段（Obsidian 配置、回收站、版本库、依赖） */
const SKIP_SEGMENTS = new Set([
  '.obsidian',
  '.trash',
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.smart-env',
  '.stfolder',
  '.stversions',
  '__pycache__',
]);

/** 始终跳过的垃圾文件名 */
const SKIP_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.gitignore', '.gitattributes']);

/**
 * 判断路径是否属于应跳过的配置目录 / 垃圾文件。
 * 传入的是相对 Obsidian 仓库根的 POSIX 路径，例如 `.obsidian/app.json`。
 *
 * 同时兜住两类**非法路径**（安全相关）：
 * - 含 `..` 段：会造成仓库外的路径穿越写入；
 * - 绝对路径（`/x`、`C:\x`、`\\server\x`）：导入只接受相对路径。
 */
export function shouldSkipPath(relPath: string): boolean {
  if (!relPath) return true;
  const raw = relPath.replace(/\\/g, '/').trim();
  if (!raw) return true;

  // 拒绝绝对路径与盘符路径
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return true;

  const segments = raw.replace(/^\.\//, '').split('/').filter(Boolean);
  if (!segments.length) return true;

  // 拒绝路径穿越
  if (segments.some((s) => s === '..')) return true;

  // 目录段命中即跳过
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (SKIP_SEGMENTS.has(segments[i]!.toLowerCase())) return true;
  }
  const fileName = segments[segments.length - 1]!;
  if (SKIP_SEGMENTS.has(fileName.toLowerCase())) return true;
  if (SKIP_FILES.has(fileName.toLowerCase())) return true;
  return false;
}

/**
 * 从 frontmatter 解析标签。
 * 兼容 Obsidian 常见的几种写法：
 * - `tags: [a, b]`
 * - `tags: a, b, c`
 * - `tags:\n  - a\n  - b`
 * - `tag: a`
 */
export function parseFrontmatterTags(text: string): string[] {
  if (!text) return [];
  const normalized = text.replace(/^\uFEFF/, '');
  if (!/^---\r?\n/.test(normalized)) return [];

  const lines = normalized.split(/\r?\n/);
  // 找 frontmatter 结束位置
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (/^(---|\.\.\.)\s*$/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  if (end === -1) return [];

  const body = lines.slice(1, end);
  const tags: string[] = [];

  const pushTag = (raw: string): void => {
    let t = raw.trim();
    if (!t) return;
    // 去掉 YAML 引号与行内注释
    t = t.replace(/^['"]|['"]$/g, '').trim();
    t = t.replace(/\s+#.*$/, '').trim();
    // Obsidian 允许写 #tag，Neo MD 存纯标签
    t = t.replace(/^#+/, '').trim();
    if (!t) return;
    if (!tags.includes(t)) tags.push(t);
  };

  for (let i = 0; i < body.length; i += 1) {
    const line = body[i] ?? '';
    const m = /^(tags?)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;

    const inline = (m[2] ?? '').trim();

    // 写法一：行内数组 [a, b]
    if (inline.startsWith('[')) {
      const inner = inline.replace(/^\[/, '').replace(/\]\s*$/, '');
      for (const part of inner.split(',')) pushTag(part);
      continue;
    }

    // 写法二：有值的逗号/空格串
    if (inline) {
      const parts = inline.includes(',') ? inline.split(',') : inline.split(/\s+/);
      for (const part of parts) pushTag(part);
      continue;
    }

    // 写法三：块级列表（后续以 - 开头的缩进行）
    for (let j = i + 1; j < body.length; j += 1) {
      const item = body[j] ?? '';
      const itemMatch = /^\s*-\s+(.*)$/.exec(item);
      if (!itemMatch) break;
      pushTag(itemMatch[1] ?? '');
      i = j;
    }
  }

  return tags;
}
