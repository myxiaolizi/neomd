/**
 * markdown 静态解析：提取 frontmatter、标题、链接、标签、脚注、任务。
 * 供索引、反向链接、大纲、属性列表等复用，避免重复扫描全文。
 */

export interface Frontmatter {
  raw: string;
  data: Record<string, unknown>;
  /** frontmatter 结束的字符偏移 */
  endOffset: number;
}

export interface ParsedHeading {
  level: number;
  text: string;
  offset: number;
  slug: string;
}

export interface ParsedLink {
  /** wikilink 目标名，或 markdown 链接的 URL */
  target: string;
  kind: 'wikilink' | 'markdown' | 'embed';
  anchor: string;
  alias: string;
  offset: number;
}

export interface ParsedDoc {
  frontmatter: Frontmatter | null;
  headings: ParsedHeading[];
  links: ParsedLink[];
  tags: string[];
  footnotes: Array<{ label: string; text: string; offset: number }>;
  tasks: Array<{ text: string; done: boolean; offset: number }>;
  /** 正文字符数（不含 frontmatter） */
  chars: number;
  words: number;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/** 极简 YAML 解析：支持标量、列表、行内数组、简单嵌套对象 */
export function parseYaml(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = src.split(/\r?\n/);
  let i = 0;
  const parseBlock = (indent: number): Record<string, unknown> => {
    const obj: Record<string, unknown> = {};
    while (i < lines.length) {
      const line = lines[i]!;
      if (!line.trim() || line.trim().startsWith('#')) {
        i += 1;
        continue;
      }
      const m = /^(\s*)([^:]+):(.*)$/.exec(line);
      if (!m) {
        i += 1;
        continue;
      }
      const lineIndent = m[1]!.length;
      if (lineIndent < indent) return obj;
      if (lineIndent > indent) {
        i += 1;
        continue;
      }
      const key = m[2]!.trim();
      const rest = m[3]!.trim();
      i += 1;
      if (rest === '') {
        // 可能是列表或嵌套对象
        const next = lines[i];
        if (next && /^\s*-\s+/.test(next)) {
          const arr: unknown[] = [];
          while (i < lines.length && /^\s*-\s+/.test(lines[i]!)) {
            const item = lines[i]!.replace(/^\s*-\s+/, '');
            const colon = /^([^:]+):(.*)$/.exec(item);
            if (colon && item.includes(':')) {
              const childObj: Record<string, unknown> = {};
              childObj[colon[1]!.trim()] = scalar(colon[2]!.trim());
              i += 1;
              while (i < lines.length && /^\s{2,}[^-\s]/.test(lines[i]!) && !/^\s*-\s+/.test(lines[i]!)) {
                const sub = /^\s+([^:]+):(.*)$/.exec(lines[i]!);
                if (sub) childObj[sub[1]!.trim()] = scalar(sub[2]!.trim());
                i += 1;
              }
              arr.push(childObj);
            } else {
              arr.push(scalar(item.trim()));
              i += 1;
            }
          }
          obj[key] = arr;
        } else if (next && /^\s{2,}\S/.test(next)) {
          i += 1;
          obj[key] = parseBlock(indent + 2);
        } else {
          obj[key] = null;
        }
      } else {
        obj[key] = scalar(rest);
      }
    }
    return obj;
  };
  const result = parseBlock(0);
  for (const [k, v] of Object.entries(result)) out[k] = v;
  return out;
}

function scalar(v: string): unknown {
  if (v === '') return '';
  if (v === 'null' || v === '~') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  if (/^\[.*\]$/.test(v)) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => scalar(s.trim()));
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/** 把属性对象序列化回 YAML（用于写 frontmatter） */
export function stringifyYaml(data: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) {
      lines.push(`${k}:`);
    } else if (Array.isArray(v)) {
      if (v.length === 0) lines.push(`${k}: []`);
      else if (v.every((x) => typeof x !== 'object')) lines.push(`${k}: [${v.map((x) => fmtScalar(x)).join(', ')}]`);
      else {
        lines.push(`${k}:`);
        for (const item of v) {
          if (item && typeof item === 'object') {
            const entries = Object.entries(item as Record<string, unknown>);
            entries.forEach(([ik, iv], idx) => {
              lines.push(`${idx === 0 ? '  - ' : '    '}${ik}: ${fmtScalar(iv)}`);
            });
          } else {
            lines.push(`  - ${fmtScalar(item)}`);
          }
        }
      }
    } else if (typeof v === 'object') {
      lines.push(`${k}:`);
      for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) {
        lines.push(`  ${ik}: ${fmtScalar(iv)}`);
      }
    } else {
      lines.push(`${k}: ${fmtScalar(v)}`);
    }
  }
  return lines.join('\n');
}

function fmtScalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') {
    if (v === '' || /^[\s:#\-[\]{}&*!|>'"%@`]/.test(v) || /[:#\n]/.test(v)) {
      return JSON.stringify(v);
    }
    return v;
  }
  return String(v);
}

function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

export function parseDoc(markdown: string): ParsedDoc {
  let body = markdown;
  let frontmatter: Frontmatter | null = null;
  const fm = FRONTMATTER_RE.exec(markdown);
  if (fm) {
    const raw = fm[1] ?? '';
    frontmatter = { raw, data: parseYaml(raw), endOffset: fm[0].length };
    body = markdown.slice(fm[0].length);
  }
  const baseOffset = frontmatter ? frontmatter.endOffset : 0;

  const headings: ParsedHeading[] = [];
  const links: ParsedLink[] = [];
  const tags = new Set<string>();
  const footnotes: ParsedDoc['footnotes'] = [];
  const tasks: ParsedDoc['tasks'] = [];

  let offset = 0;
  let inFence = false;
  let fenceMarker = '';
  for (const rawLine of body.split(/\r?\n/)) {
    const lineStart = offset;
    offset += rawLine.length + 1;
    const line = rawLine;

    const fence = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1]!;
      } else if (line.trim().startsWith(fenceMarker)) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const text = h[2] ?? '';
      headings.push({ level: h[1]!.length, text, offset: baseOffset + lineStart, slug: slugify(text) });
    }

    // wikilink / embed
    const wikiRe = /(!?)\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = wikiRe.exec(line))) {
      links.push({
        target: (m[2] ?? '').trim(),
        kind: m[1] === '!' ? 'embed' : 'wikilink',
        anchor: (m[3] ?? '').trim(),
        alias: (m[4] ?? '').trim(),
        offset: baseOffset + lineStart + m.index,
      });
    }

    // markdown 链接
    const mdRe = /(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    while ((m = mdRe.exec(line))) {
      const url = m[2] ?? '';
      if (!url.startsWith('#')) {
        links.push({ target: url, kind: 'markdown', anchor: '', alias: m[1] ?? '', offset: baseOffset + lineStart + m.index });
      }
    }

    // 标签：跳过行内代码
    const stripped = line.replace(/`[^`]*`/g, '');
    const tagRe = /(^|[\s(（,，])#([\p{L}\p{N}_\-/]{1,64})/gu;
    while ((m = tagRe.exec(stripped))) {
      const t = m[2]!;
      if (/^\d+$/.test(t)) continue;
      tags.add(t);
    }

    const fn = /^\[\^([^\]]+)\]:\s*(.*)$/.exec(line);
    if (fn) footnotes.push({ label: fn[1]!, text: fn[2] ?? '', offset: baseOffset + lineStart });

    const task = /^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    if (task) tasks.push({ text: task[2] ?? '', done: task[1]!.toLowerCase() === 'x', offset: baseOffset + lineStart });
  }

  // frontmatter 中的标签与标题也参与
  if (frontmatter) {
    const fmTags = frontmatter.data.tags;
    if (Array.isArray(fmTags)) fmTags.forEach((t) => typeof t === 'string' && tags.add(t.replace(/^#/, '')));
    else if (typeof fmTags === 'string') fmTags.split(/[,\s]+/).filter(Boolean).forEach((t) => tags.add(t.replace(/^#/, '')));
  }

  const text = body;
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
  const latinWords = (text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ').match(/[A-Za-z0-9_'’-]+/g) ?? []).length;

  return {
    frontmatter,
    headings,
    links,
    tags: [...tags],
    footnotes,
    tasks,
    chars: text.length,
    words: cjk + latinWords,
  };
}

/** 从 frontmatter 读取标题，回退到首个 H1，再回退到文件名 */
export function resolveTitle(markdown: string, fallback: string): string {
  const fm = FRONTMATTER_RE.exec(markdown);
  if (fm) {
    const data = parseYaml(fm[1] ?? '');
    if (typeof data.title === 'string' && data.title.trim()) return data.title.trim();
  }
  const h1 = /^\s{0,3}#\s+(.+)$/m.exec(markdown);
  if (h1) return h1[1]!.replace(/\s*#+\s*$/, '').trim();
  return fallback;
}
