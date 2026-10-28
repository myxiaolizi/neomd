/**
 * 导出：Markdown → HTML / DOCX / PDF(打印样式)
 * PDF 在桌面端由 Electron printToPDF 生成，网页端由服务端 Puppeteer 生成；
 * 此处负责生成排版一致的 HTML 与打印用样式。
 */

import { markdownToHtml, splitFrontmatter } from '../vault/markdown-bridge';

export interface ExportOptions {
  title: string;
  /** 主题：跟随导出目标 */
  theme?: 'light' | 'dark';
  /** 是否包含目录 */
  toc?: boolean;
  /** 自定义 CSS 追加 */
  extraCss?: string;
  /** 页宽：用于 PDF 打印 */
  pageWidth?: 'narrow' | 'standard' | 'wide';
}

const BASE_CSS = `
:root{--accent:#1677FF;--fg:#1a1d21;--muted:#5c6370;--border:#e3e6ea;--code-bg:#f5f7fa;--bg:#fff}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg)}
body{font-family:-apple-system,"Segoe UI Variable","Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
 font-size:16px;line-height:1.75;-webkit-font-smoothing:antialiased}
.neomd-export{max-width:820px;margin:0 auto;padding:56px 40px 96px}
.neomd-export h1,.neomd-export h2,.neomd-export h3,.neomd-export h4,.neomd-export h5,.neomd-export h6{
 line-height:1.35;margin:1.6em 0 .6em;font-weight:600;scroll-margin-top:24px}
.neomd-export h1{font-size:2em;border-bottom:1px solid var(--border);padding-bottom:.3em}
.neomd-export h2{font-size:1.5em;border-bottom:1px solid var(--border);padding-bottom:.25em}
.neomd-export h3{font-size:1.25em}
.neomd-export p{margin:.85em 0}
.neomd-export a{color:var(--accent);text-decoration:none}
.neomd-export a:hover{text-decoration:underline}
.neomd-export ul,.neomd-export ol{padding-left:1.6em;margin:.8em 0}
.neomd-export li{margin:.3em 0}
.neomd-export blockquote{margin:1em 0;padding:.6em 1em;border-left:3px solid var(--accent);
 background:rgba(22,119,255,.05);color:var(--muted);border-radius:0 6px 6px 0}
.neomd-export code{background:var(--code-bg);padding:.15em .4em;border-radius:4px;font-size:.9em;
 font-family:"Cascadia Code",Consolas,Menlo,monospace}
.neomd-export pre{background:var(--code-bg);padding:16px 18px;border-radius:8px;overflow-x:auto;
 border:1px solid var(--border);font-size:.88em;line-height:1.6}
.neomd-export pre code{background:none;padding:0}
.neomd-export table{border-collapse:collapse;width:100%;margin:1.2em 0;font-size:.94em}
.neomd-export th,.neomd-export td{border:1px solid var(--border);padding:8px 12px;text-align:left}
.neomd-export th{background:var(--code-bg);font-weight:600}
.neomd-export img{max-width:100%;height:auto;border-radius:6px}
.neomd-export hr{border:none;border-top:1px solid var(--border);margin:2em 0}
.neomd-export mark{background:rgba(255,196,0,.32);padding:.05em .2em;border-radius:3px}
.neomd-export input[type=checkbox]{margin-right:.5em;accent-color:var(--accent)}
.neomd-export .toc{background:var(--code-bg);border:1px solid var(--border);border-radius:8px;padding:14px 20px;margin:0 0 2em}
.neomd-export .toc-title{font-weight:600;margin-bottom:.5em}
.neomd-export .toc ul{list-style:none;padding-left:0;margin:0}
.neomd-export .toc li{margin:.2em 0}
.neomd-export .toc li.l2{padding-left:1.1em}
.neomd-export .toc li.l3{padding-left:2.2em}
@media print{
  @page{margin:18mm 16mm}
  .neomd-export{max-width:none;padding:0}
  .neomd-export h1,.neomd-export h2,.neomd-export h3{break-after:avoid}
  .neomd-export pre,.neomd-export table,.neomd-export blockquote{break-inside:avoid}
  .neomd-export a{color:inherit;text-decoration:underline}
}
`;

export function buildExportHtml(source: string, options: ExportOptions): string {
  const { body } = splitFrontmatter(source);
  const contentHtml = markdownToHtml(body, { externalTarget: '_blank', interactiveLinks: true });
  const toc = options.toc ? buildToc(contentHtml) : '';
  const accent = options.theme === 'dark' ? '#1677FF' : '#1677FF';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>${BASE_CSS.replace('--accent:#1677FF', `--accent:${accent}`)}${options.extraCss ?? ''}</style>
</head>
<body>
<main class="neomd-export">
${toc}
${contentHtml}
</main>
</body>
</html>`;
}

function buildToc(html: string): string {
  const re = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/g;
  const items: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const level = Number(m[1]);
    const text = m[2]!.replace(/<[^>]+>/g, '').trim();
    if (!text) continue;
    const anchor = slug(text);
    items.push(`<li class="l${level}"><a href="#${anchor}">${text}</a></li>`);
  }
  if (!items.length) return '';
  return `<nav class="toc"><div class="toc-title">目录</div><ul>${items.join('')}</ul></nav>`;
}

function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface DocxSection {
  heading: string;
  level: number;
  body: string;
}

/** 供 docx 生成器使用：把 markdown 拆成可在 DOCX 中排版的段落块 */
export function splitForDocx(source: string): Array<
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string; runs?: Array<{ text: string; bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean; link?: string }> }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'code'; language: string; text: string }
  | { type: 'quote'; text: string }
  | { type: 'table'; rows: string[][] }
  | { type: 'hr' }
> {
  const { body } = splitFrontmatter(source);
  const lines = body.split('\n');
  const out: ReturnType<typeof splitForDocx> = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      const lang = fence[1] ?? '';
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i]!)) {
        buf.push(lines[i]!);
        i += 1;
      }
      i += 1;
      out.push({ type: 'code', language: lang, text: buf.join('\n') });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ type: 'heading', level: h[1]!.length, text: h[2]!.trim() });
      i += 1;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push({ type: 'hr' });
      i += 1;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
        const cells = lines[i]!
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i += 1;
      }
      out.push({ type: 'table', rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        buf.push(lines[i]!.replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push({ type: 'quote', text: buf.join('\n') });
      continue;
    }
    const ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ol || ul) {
      const ordered = Boolean(ol);
      const items: string[] = [];
      while (i < lines.length) {
        const m1 = /^\s*(\d+)[.)]\s+(.*)$/.exec(lines[i]!);
        const m2 = /^\s*[-*+]\s+(.*)$/.exec(lines[i]!);
        if (ordered && m1) items.push(m1[2]!);
        else if (!ordered && m2) items.push(m2[1]!);
        else break;
        i += 1;
      }
      out.push({ type: 'list', ordered, items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]!) &&
      !/^```/.test(lines[i]!) &&
      !/^(#{1,6})\s+/.test(lines[i]!) &&
      !/^\s*>/.test(lines[i]!) &&
      !/^\s*\|.*\|\s*$/.test(lines[i]!) &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i += 1;
    }
    if (para.length) out.push({ type: 'paragraph', text: para.join(' ') });
  }
  return out;
}

/** 从 markdown 提取纯文本（用于分享页 SEO、搜索摘要） */
export function markdownToPlainText(source: string, limit = 300): string {
  const { body } = splitFrontmatter(source);
  const text = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a, b) => b || a)
    .replace(/^[>#\-*+]+\s?/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
