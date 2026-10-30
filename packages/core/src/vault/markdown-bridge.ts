/**
 * Markdown 双向转换：源文本 ⇄ 富文本 HTML。
 *
 * 设计取舍：
 * - 不依赖第三方 ROM，自己控制 `md -> html -> md` 往返，保证表格、任务列表、
 *   frontmatter、代码块语言、嵌套列表的保真。
 * - frontmatter 原样保留，转换时剥离，写回时拼回。
 * - 渲染时关闭原始 HTML（`html:false`）避免注入；任务列表与 Wikilink
 *   通过占位令牌 + 渲染后回填实现，不依赖原始 HTML 透传。
 */

import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: false, breaks: false, typographer: false });

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/;

export interface SplitDoc {
  frontmatter: string;
  body: string;
}

export function splitFrontmatter(source: string): SplitDoc {
  const m = FRONTMATTER_RE.exec(source);
  if (!m) return { frontmatter: '', body: source };
  return { frontmatter: m[0].replace(/\r?\n$/, ''), body: source.slice(m[0].length) };
}

export function joinFrontmatter(split: SplitDoc): string {
  if (!split.frontmatter) return split.body;
  /*
   * 1.2.1 缺陷4：frontmatter 与正文之间固定只隔**一个空行**（两个换行）。
   *
   * 改前这里按 `split.body.startsWith('\n')` 猜分隔符，正文以空行开头时
   * 会退化成 `'\n'` 甚至更少，于是「frontmatter 后面那个空行」在保存后
   * 时有时无。现在统一成固定值：正文自身的首部空行由 htmlToSource 负责
   * 收敛（见下方），这里不再猜测，避免两处各改一半。
   */
  return `${split.frontmatter}\n\n${split.body.replace(/^\n+/, '')}`.replace(/\n{3,}$/, '\n');
}

export function withFrontmatter(source: string, frontmatter: string): string {
  const { body } = splitFrontmatter(source);
  return joinFrontmatter({ frontmatter, body });
}

/* ------------------------------------------------------------------ */
/* Markdown -> HTML                                                    */
/* ------------------------------------------------------------------ */

const TASK_RE = /^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$/;
const TASK_TOKEN = (i: number): string => `NEOMDTASKPLACEHOLDERX${i}XEND`;
const HL_OPEN = 'NEOMDHIGHLIGHTPLACEHOLDEROPENXEND';
const HL_CLOSE = 'NEOMDHIGHLIGHTPLACEHOLDERCLOSEXEND';
const WIKI_SCHEME = 'neomd://wiki/';

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 把 [[目标#锚点|别名]] 转成 markdown 链接（自定义 scheme），渲染后再补齐 data 属性 */
function preWikilinks(body: string): string {
  return body.replace(/(!?)\[\[([^\]|#\n]+)(?:#([^\]|\n]+))?(?:\|([^\]\n]+))?\]\]/g, (_all, bang, target, anchor, alias) => {
    const t = String(target).trim();
    const a = anchor ? String(anchor).trim() : '';
    const text = (alias ? String(alias) : a ? `${t}#${a}` : t)
      .replace(/[[\]]/g, '')
      .trim();
    const href = `${WIKI_SCHEME}${encodeURIComponent(t)}${a ? `#${encodeURIComponent(a)}` : ''}${bang === '!' ? '?embed=1' : ''}`;
    return `[${text}](${href})`;
  });
}

/** 把 ==高亮== 转成占位令牌，渲染后在 HTML 文本层替换为 <mark> */
function preHighlight(body: string): string {
  return body.replace(/(^|[^=])==(?![=\s])([^=\n]+?)==(?![\s=])/g, (_m, lead, text) => `${lead}${HL_OPEN}${text}${HL_CLOSE}`);
}

/** 抽出任务列表块，用占位令牌替换，渲染后回填完整结构 */
function extractTaskLists(body: string): { text: string; blocks: string[] } {
  const lines = body.split('\n');
  const blocks: string[] = [];
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = TASK_RE.exec(lines[i]!);
    if (!m) {
      out.push(lines[i]!);
      i += 1;
      continue;
    }
    const baseIndent = m[1]!.length;
    const items: string[] = [];
    while (i < lines.length) {
      const cur = TASK_RE.exec(lines[i]!);
      if (!cur || cur[1]!.length !== baseIndent) break;
      const checked = cur[3]!.toLowerCase() === 'x';
      const text = cur[4] ?? '';
      items.push(
        `<li data-type="taskItem" data-checked="${checked}"><label><input type="checkbox"${
          checked ? ' checked="checked"' : ''
        }><span></span></label><div><p>${md.renderInline(preInline(text))}</p></div></li>`,
      );
      i += 1;
    }
    const idx = blocks.length;
    blocks.push(`<ul data-type="taskList">${items.join('')}</ul>`);
    out.push(TASK_TOKEN(idx));
  }
  return { text: out.join('\n'), blocks };
}

function preInline(text: string): string {
  return preHighlight(preWikilinks(text));
}

/* ------------------------------------------------------------------ */
/* 空行保真（1.2.1 缺陷4）                                             */
/* ------------------------------------------------------------------ */

/**
 * 围栏代码块起始/结束标记。空行规整**必须**能识别它，
 * 否则代码块里的空行会被当成「正文空白」压缩掉（那是数据损坏，不是排版）。
 */
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/** 连续空行的占位令牌（与任务列表同一套「先占位、渲染后回填」手法） */
const BLANK_TOKEN = (n: number): string => `NEOMDBLANKPLACEHOLDERX${n}XEND`;

/**
 * 把「2 个及以上连续空行」标记成占位令牌，供渲染后回填成空段落。
 *
 * 为什么非做不可：markdown-it 会把连续空行当作块分隔符**直接丢弃**，
 * `A\n\n\nB` 与 `A\n\nB` 渲染结果完全相同 —— 空行信息在进 HTML 的那一刻就没了，
 * 之后无论怎么往返都无从还原。这正是「保存后空换行丢失」的根因。
 *
 * 为什么用「占位令牌 + 独立段落」而不是直接拼 HTML：
 * 本文件整条链路都走 markdown-it 渲染（`html:false`，不信任原始 HTML），
 * 令牌行会被渲染成 `<p>TOKEN</p>`，随后整体替换成 (n-1) 个空段落，
 * 既不需要打开 HTML 透传，也不会被 wikilink / 高亮预处理干扰。
 *
 * 数量关系（务必记住，往返两个方向共用）：
 *   原文 N 个连续空行 ⇄ 渲染出 N-1 个空段落。
 *   N=1 是标准段落分隔，不产生空段落（否则每两段之间都会多一行）。
 */
function markBlankRuns(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fenceHit = FENCE_RE.exec(line);
    if (fenceHit) {
      const ch = fenceHit[1]![0]!;
      if (!fence) fence = ch;
      else if (ch === fence) fence = null;
      out.push(line);
      i += 1;
      continue;
    }
    if (fence) {
      // 代码块内部逐字保留，连空行统计都不做
      out.push(line);
      i += 1;
      continue;
    }
    if (/^[ \t]*$/.test(line)) {
      let j = i;
      while (j < lines.length && /^[ \t]*$/.test(lines[j]!)) j += 1;
      const run = j - i;
      if (run >= 2) {
        // 令牌行前后各留一个空行，保证它自成一个段落，不会和相邻正文粘连
        out.push('', BLANK_TOKEN(run), '');
      } else {
        out.push('');
      }
      i = j;
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out.join('\n');
}

export interface RenderOptions {
  interactiveLinks?: boolean;
  externalTarget?: '_blank' | '';
}

export function markdownToHtml(source: string, options: RenderOptions = {}): string {
  const { body } = splitFrontmatter(source);
  const { text, blocks } = extractTaskLists(markBlankRuns(body));
  let html = md.render(preHighlight(preWikilinks(text)));

  // 回填任务列表（占位令牌通常被 markdown-it 包进一个空段落）
  html = html.replace(/<p>\s*NEOMDTASKPLACEHOLDERX(\d+)XEND\s*<\/p>/g, (_m, idx: string) => blocks[Number(idx)] ?? '');
  html = html.replace(/NEOMDTASKPLACEHOLDERX(\d+)XEND/g, (_m, idx: string) => blocks[Number(idx)] ?? '');

  /*
   * 回填空行（1.2.1 缺陷4）：N 个连续空行 → N-1 个空段落。
   *
   * 为什么是 N-1：N=1 就是标准的「段落分隔」，markdown-it 已经用两个相邻块表达了；
   * 只有 N≥2 才是「用户额外要的空行」，多出来的 (N-1) 个空行才需要真实载体。
   * 空段落同时也是所见即所得里「用户按回车敲出来的空行」的天然表示，
   * 因此 htmlToMarkdown 只要把空段落再换算回空行，两个方向的语义就对齐了。
   */
  html = html.replace(/<p>\s*NEOMDBLANKPLACEHOLDERX(\d+)XEND\s*<\/p>\n?/g, (_m, n: string) =>
    '<p class="nm-blank"></p>\n'.repeat(Math.max(1, Number(n) - 1)),
  );
  html = html.replace(/NEOMDBLANKPLACEHOLDERX(\d+)XEND/g, '');

  // 高亮
  html = html.split(HL_OPEN).join('@@NM_HL_O@@').split(HL_CLOSE).join('@@NM_HL_C@@');
  html = html.replace(/@@NM_HL_O@@([\s\S]*?)@@NM_HL_C@@/g, (_m, inner) => `<mark>${inner}</mark>`);

  // 补齐 wikilink 的 data 属性
  html = html.replace(/<a href="neomd:\/\/wiki\/([^"#?]*)(#[^"?]*)?(\?embed=1)?">/g, (_m, enc, hash, embed) => {
    const target = safeDecode(enc);
    const anchor = hash ? safeDecode(hash.slice(1)) : '';
    return `<a href="neomd://wiki/${enc}${hash ?? ''}${embed ?? ''}" data-wikilink="${escapeAttr(target)}"${
      anchor ? ` data-anchor="${escapeAttr(anchor)}"` : ''
    }${embed ? ' data-embed="1"' : ''}>`;
  });

  if (options.interactiveLinks === false) html = html.replace(/<a /g, '<a data-static="1" ');
  if (options.externalTarget === '_blank') {
    html = html.replace(/<a href="(https?):/g, '<a target="_blank" rel="noopener noreferrer" href="$1:');
  }
  return html;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function renderBody(source: string): string {
  return markdownToHtml(source, { externalTarget: '_blank', interactiveLinks: true });
}

/* ------------------------------------------------------------------ */
/* HTML -> Markdown                                                    */
/* ------------------------------------------------------------------ */

interface ElNode {
  kind: 'el';
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}
interface TextNode {
  kind: 'text';
  text: string;
}
type HtmlNode = ElNode | TextNode;

function parseHtml(html: string): HtmlNode[] {
  const root: ElNode = { kind: 'el', tag: '#root', attrs: {}, children: [] };
  const stack: ElNode[] = [root];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*?)?)\/?>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const [raw, tagName, attrStr, text] = m;
    if (text !== undefined) {
      const decoded = decodeEntities(text);
      if (decoded) stack[stack.length - 1]!.children.push({ kind: 'text', text: decoded });
      continue;
    }
    if (!tagName) continue;
    const tag = tagName.toLowerCase();
    if (raw.startsWith('</')) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i]!.tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const node: ElNode = { kind: 'el', tag, attrs: parseAttrs(attrStr ?? ''), children: [] };
    stack[stack.length - 1]!.children.push(node);
    const selfClose = /\/>$/.test(raw) || /^(br|hr|img|input|meta|link|col)$/.test(tag);
    if (!selfClose) stack.push(node);
  }
  return root.children;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (!m[1]) continue;
    out[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function inlineOf(node: ElNode): string {
  let out = '';
  /** 上一个子节点是不是 <br>（决定要不要吃掉紧跟其后的字面换行） */
  let afterBr = false;
  for (const c of node.children) {
    if (c.kind === 'text') {
      /*
       * markdown-it 渲染硬换行时输出的是 `<br>\n`：`<br>` 之后那个换行只是
       * HTML 源码里的排版缩进，**不是内容**。`inlineNode('br')` 已经把硬换行
       * 表达成 `'  \n'`（Markdown 的行尾两空格语法），若这里再把这个字面换行
       * 拼进去，`第一行  \n第二行` 往返一次就会变成 `第一行  \n\n第二行`
       * —— 硬换行被静默升级成段落分隔。所以紧跟 <br> 的第一个换行要丢掉。
       */
      const text = afterBr && c.text.startsWith('\n') ? c.text.slice(1) : c.text;
      out += text;
      afterBr = false;
      continue;
    }
    out += inlineNode(c);
    afterBr = c.tag === 'br';
  }
  return out;
}

function wikiFromHref(href: string): { target: string; anchor: string; embed: boolean } | null {
  if (!href.startsWith(WIKI_SCHEME)) return null;
  const rest = href.slice(WIKI_SCHEME.length);
  const [pathPart, queryPart] = rest.split('?');
  const [encTarget, encAnchor] = (pathPart ?? '').split('#');
  return {
    target: safeDecode(encTarget ?? ''),
    anchor: safeDecode(encAnchor ?? ''),
    embed: (queryPart ?? '').includes('embed=1'),
  };
}

function inlineNode(node: ElNode): string {
  switch (node.tag) {
    case 'strong':
    case 'b':
      return wrap(inlineOf(node), '**');
    case 'em':
    case 'i':
      return wrap(inlineOf(node), '*');
    case 'del':
    case 's':
      return wrap(inlineOf(node), '~~');
    case 'u':
      return `<u>${inlineOf(node)}</u>`;
    case 'mark':
      return `==${inlineOf(node)}==`;
    case 'code':
      return `\`${inlineOf(node)}\``;
    case 'br':
      return '  \n';
    case 'a': {
      const text = inlineOf(node);
      const href = node.attrs.href ?? '';
      const wiki = wikiFromHref(href);
      if (wiki) {
        const plain = wiki.anchor ? `${wiki.target}#${wiki.anchor}` : wiki.target;
        const alias = text && text !== plain && text !== wiki.target ? `|${text}` : '';
        return `${wiki.embed ? '!' : ''}[[${wiki.target}${wiki.anchor ? `#${wiki.anchor}` : ''}${alias}]]`;
      }
      return text === href ? `<${href}>` : `[${text}](${href})`;
    }
    case 'img': {
      const src = node.attrs.src ?? '';
      const alt = node.attrs.alt ?? '';
      const title = node.attrs.title;
      return `![${alt}](${src}${title ? ` "${title}"` : ''})`;
    }
    case 'input':
      return '';
    case 'span':
    case 'label':
      return inlineOf(node);
    default: {
      const hasBlock = node.children.some((c) => c.kind === 'el' && isBlockTag(c.tag));
      return hasBlock ? blocksOf(node) : inlineOf(node);
    }
  }
}

function wrap(text: string, mark: string): string {
  const t = text.trim();
  if (!t) return text;
  const start = text.indexOf(t);
  return `${text.slice(0, start)}${mark}${t}${mark}${text.slice(start + t.length)}`;
}

function isBlockTag(tag: string): boolean {
  return /^(p|div|h[1-6]|ul|ol|li|blockquote|pre|table|section|article|hr|figure|details|summary)$/.test(tag);
}

function blocksOf(parent: ElNode): string {
  const parts: string[] = [];
  for (const c of parent.children) {
    if (c.kind === 'text') {
      const t = c.text.trim();
      if (t) parts.push(t);
      continue;
    }
    const s = blockNode(c);
    if (s) parts.push(s);
  }
  return parts.join('\n\n');
}

function collectText(node: ElNode): string {
  let out = '';
  for (const c of node.children) out += c.kind === 'text' ? c.text : collectText(c);
  return out;
}

function findDescendant(node: ElNode, tag: string): ElNode | null {
  for (const c of node.children) {
    if (c.kind !== 'el') continue;
    if (c.tag === tag) return c;
    const deeper = findDescendant(c, tag);
    if (deeper) return deeper;
  }
  return null;
}

function listItemMarkdown(node: ElNode, indent: number, ordered: boolean, index: number): string {
  const pad = '  '.repeat(indent);
  const nested: ElNode[] = [];
  const chunks: string[] = [];

  const walk = (n: ElNode): void => {
    for (const c of n.children) {
      if (c.kind === 'text') {
        chunks.push(c.text);
        continue;
      }
      if (c.tag === 'ul' || c.tag === 'ol') {
        nested.push(c);
        continue;
      }
      if (c.tag === 'input') continue;
      if (c.tag === 'p' || c.tag === 'div' || c.tag === 'label' || c.tag === 'span') {
        walk(c);
        continue;
      }
      chunks.push(inlineNode(c));
    }
  };
  walk(node);

  const isTask = node.attrs['data-type'] === 'taskItem' || Boolean(findDescendant(node, 'input'));
  let marker = ordered ? `${index}. ` : '- ';
  const body = chunks.join('').replace(/\s+/g, ' ').trim();
  if (isTask) {
    marker = node.attrs['data-checked'] === 'true' ? '- [x] ' : '- [ ] ';
  }

  let result = `${pad}${marker}${body}`;
  for (const n of nested) result += `\n${blockNode(n, indent + 1)}`;
  return result;
}

function tableMarkdown(node: ElNode): string {
  const rows: ElNode[] = [];
  const collect = (n: ElNode): void => {
    for (const c of n.children) {
      if (c.kind !== 'el') continue;
      if (c.tag === 'tr') rows.push(c);
      else collect(c);
    }
  };
  collect(node);
  if (!rows.length) return '';
  const cellText = (row: ElNode): string[] => {
    const cells: string[] = [];
    for (const c of row.children) {
      if (c.kind !== 'el') continue;
      if (c.tag === 'td' || c.tag === 'th') cells.push(inlineOf(c).replace(/\n/g, ' ').trim());
    }
    return cells;
  };
  const head = cellText(rows[0]!);
  if (!head.length) return '';
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (let i = 1; i < rows.length; i += 1) {
    const cells = cellText(rows[i]!);
    lines.push(`| ${head.map((_, idx) => cells[idx] ?? '').join(' | ')} |`);
  }
  return lines.join('\n');
}

function blockNode(node: ElNode, indent = 0): string {
  switch (node.tag) {
    case 'h1':
      return `# ${inlineOf(node).trim()}`.trimEnd() === '#' ? '#' : `# ${inlineOf(node).trim()}`;
    case 'h2':
      return `## ${inlineOf(node).trim()}`.trimEnd() === '##' ? '##' : `## ${inlineOf(node).trim()}`;
    case 'h3':
      return `### ${inlineOf(node).trim()}`.trimEnd() === '###' ? '###' : `### ${inlineOf(node).trim()}`;
    case 'h4':
      return `#### ${inlineOf(node).trim()}`.trimEnd() === '####' ? '####' : `#### ${inlineOf(node).trim()}`;
    case 'h5':
      return `##### ${inlineOf(node).trim()}`.trimEnd() === '#####' ? '#####' : `##### ${inlineOf(node).trim()}`;
    case 'h6':
      return `###### ${inlineOf(node).trim()}`.trimEnd() === '######' ? '######' : `###### ${inlineOf(node).trim()}`;
    case 'p': {
      const text = inlineOf(node);
      return text.trim() ? text.replace(/^\n+|\n+$/g, '') : '';
    }
    case 'blockquote': {
      const inner = blocksOf(node);
      if (!inner) return '';
      return inner
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
    }
    case 'pre': {
      const codeEl = node.children.find((c) => c.kind === 'el' && c.tag === 'code') as ElNode | undefined;
      const raw = codeEl ? collectText(codeEl) : collectText(node);
      const cls = codeEl?.attrs.class ?? node.attrs.class ?? '';
      const langMatch = /language-([\w+#-]+)/.exec(cls);
      const lang = langMatch ? langMatch[1] : '';
      const fence = raw.includes('```') ? '````' : '```';
      return `${fence}${lang}\n${raw.replace(/\n$/, '')}\n${fence}`;
    }
    case 'ul':
    case 'ol': {
      const ordered = node.tag === 'ol';
      const items: string[] = [];
      let i = 0;
      for (const c of node.children) {
        if (c.kind !== 'el' || c.tag !== 'li') continue;
        i += 1;
        items.push(listItemMarkdown(c, indent, ordered, i));
      }
      return items.join('\n');
    }
    case 'li':
      return listItemMarkdown(node, indent, false, 1);
    case 'hr':
      return '---';
    case 'table':
      return tableMarkdown(node);
    case 'img': {
      const src = node.attrs.src ?? '';
      return `![${node.attrs.alt ?? ''}](${src})`;
    }
    case 'div':
    case 'section':
    case 'article':
    case 'figure':
    case 'details':
      return blocksOf(node);
    case 'input':
      return '';
    default: {
      const hasBlock = node.children.some((c) => c.kind === 'el' && isBlockTag(c.tag));
      return hasBlock ? blocksOf(node) : inlineOf(node).trim();
    }
  }
}

/**
 * 该顶层节点是否是一个「空段落」= 用户显式要的一个空行。
 *
 * 只认真正空白的段落：含有图片 / 行内代码 / 强调等任何非 br 子节点的段落
 * 都不算空行（否则 `<p><img></p>` 会被误判成空行，图片就丢了）。
 */
function isBlankBlock(node: ElNode): boolean {
  if (node.tag !== 'p') return false;
  for (const c of node.children) {
    if (c.kind === 'text') {
      if (c.text.replace(/[\s\u200b]/g, '')) return false;
      continue;
    }
    if (c.tag !== 'br') return false;
  }
  return true;
}

/**
 * 只在「围栏代码块之外」折叠多余的空白行。
 *
 * 两件事必须同时成立：
 * 1. 代码块是**逐字内容**，任何空白压缩都是数据损坏。1.2.1 缺陷4 的第三层就是
 *    这个问题 —— `a\n\n\nb` 保存后变成 `a\n\nb`，根因是改前对整串 markdown 跑了
 *    一次全局 `\n{3,}` 折叠，把代码块内部的空行一起吃了；
 * 2. **不能碰行尾空格**。`inlineNode('br')` 用的是 `'  \n'`（两个空格 + 换行），
 *    这是 Markdown 的硬换行语法；改前那条全局 `/[ \t]+$/gm` 会把它剪成普通换行，
 *    硬换行因此在每次保存后静默降级。行尾空白在这里一律原样保留。
 *
 * 折叠本身只处理「非代码块里 3 个及以上连续换行」这种由块拼接产生的冗余，
 * 用户真正想要的空行已由空段落显式表达（见 htmlToMarkdown 的 parts 拼接），
 * 不会再被这里吃掉。
 */
function tidyOutsideFences(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  let sawFence = false;
  for (const line of lines) {
    const m = FENCE_RE.exec(line);
    if (m) {
      const ch = m[1]![0]!;
      if (!fence) {
        fence = ch;
        sawFence = true;
      } else if (ch === fence) {
        fence = null;
      }
      out.push(line);
      continue;
    }
    out.push(line);
  }
  const joined = out.join('\n');
  // 含代码块时不做折叠：折叠会跨过围栏边界，仍然可能误伤代码内容
  return sawFence ? joined : joined.replace(/\n{3,}/g, '\n\n');
}

export function htmlToMarkdown(html: string): string {
  const nodes = parseHtml(html);
  /** 顶层块序列；'' 表示一个空段落（= 一个显式空行） */
  const parts: string[] = [];
  for (const n of nodes) {
    if (n.kind === 'text') {
      const t = n.text.trim();
      if (t) parts.push(t);
      continue;
    }
    // 空段落必须保留成空行 —— 这是「保存后空换行丢失」的主因之一：
    // 改前 `if (s) parts.push(s)` 把空段落整体丢弃，用户在所见即所得里
    // 按回车敲出来的空行、以及 markdownToHtml 为连续空行生成的占位，
    // 都在回写这一步被吃掉。
    if (isBlankBlock(n)) {
      parts.push('');
      continue;
    }
    const s = blockNode(n);
    if (s) parts.push(tidyOutsideFences(s));
  }

  /*
   * 逐块拼接：相邻非空块之间固定 1 个空行（'\n\n'），每个空段落再多 1 个换行。
   *
   * 与 markdownToHtml 的数量关系互为逆运算：
   *   N 个连续空行 ⇄ (N-1) 个空段落 ⇄ 分隔符 '\n'.repeat(2 + (N-1)) = N+1 个换行。
   * 校验：N=1 → 2 个换行（`A\n\nB`）✓；N=2 → 3 个换行（`A\n\n\nB`）✓。
   */
  let out = '';
  let pending = 0;
  let started = false;
  for (const part of parts) {
    if (part === '') {
      pending += 1;
      continue;
    }
    if (!started) {
      // 开头的空段落丢弃：markdown 没有「文件以空行开头」的语义
      out = part;
      started = true;
      pending = 0;
      continue;
    }
    out += '\n'.repeat(2 + pending) + part;
    pending = 0;
  }
  if (!started) return '';
  // 文末：至少 1 个换行（文件应以换行结尾），每个尾部空段落再多 1 个。
  // 改前这里用 `.trim()` 收尾，把文末换行整个吃掉，于是每次保存 git 都报
  // `\ No newline at end of file` —— 也是「保存后文件变了」的一个来源。
  out += '\n'.repeat(1 + pending);
  return out;
}

export function htmlToSource(html: string, originalSource: string): string {
  const { frontmatter, body: originalBody } = splitFrontmatter(originalSource);
  let body = htmlToMarkdown(html);

  /*
   * 文末换行以**原文件惯例**为准（1.2.1）。
   *
   * htmlToMarkdown 只能保证「至少 1 个换行」，但原文件可能是 0 个（手写的单行文件）
   * 或 N 个（尾部留白）。若不一并对齐，同一次「打开 → 保存」就会改写文件末尾，
   * 让用户在 git 里看到一条莫名其妙的 diff。这里取两者的较大者：
   * - 正文自身带尾部空段落（用户新敲的空行）→ 用正文推导值，不能丢；
   * - 正文没有尾部空行 → 完全沿用原文件的换行个数。
   */
  const contentTail = (/\n*$/.exec(body)?.[0] ?? '').length;
  const originalTail = (/\n*$/.exec(originalBody)?.[0] ?? '').length;
  const tail = contentTail > 1 ? contentTail : originalTail;
  body = body.replace(/\n+$/, '') + '\n'.repeat(tail);
  return joinFrontmatter({ frontmatter, body });
}
