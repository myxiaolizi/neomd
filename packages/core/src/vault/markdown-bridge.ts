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
  const sep = split.body.startsWith('\n') ? '' : '\n\n';
  return `${split.frontmatter}\n${sep}${split.body}`.replace(/\n{3,}$/, '\n');
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

export interface RenderOptions {
  interactiveLinks?: boolean;
  externalTarget?: '_blank' | '';
}

export function markdownToHtml(source: string, options: RenderOptions = {}): string {
  const { body } = splitFrontmatter(source);
  const { text, blocks } = extractTaskLists(body);
  let html = md.render(preHighlight(preWikilinks(text)));

  // 回填任务列表（占位令牌通常被 markdown-it 包进一个空段落）
  html = html.replace(/<p>\s*NEOMDTASKPLACEHOLDERX(\d+)XEND\s*<\/p>/g, (_m, idx: string) => blocks[Number(idx)] ?? '');
  html = html.replace(/NEOMDTASKPLACEHOLDERX(\d+)XEND/g, (_m, idx: string) => blocks[Number(idx)] ?? '');

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
  for (const c of node.children) out += c.kind === 'text' ? c.text : inlineNode(c);
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

export function htmlToMarkdown(html: string): string {
  const nodes = parseHtml(html);
  const parts: string[] = [];
  for (const n of nodes) {
    if (n.kind === 'text') {
      const t = n.text.trim();
      if (t) parts.push(t);
      continue;
    }
    const s = blockNode(n);
    if (s) parts.push(s);
  }
  return parts
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

export function htmlToSource(html: string, originalSource: string): string {
  const { frontmatter } = splitFrontmatter(originalSource);
  const body = htmlToMarkdown(html);
  return joinFrontmatter({ frontmatter, body });
}
