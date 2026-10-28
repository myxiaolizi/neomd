/**
 * 导出样式：与客户端导出 HTML/PDF 使用同一套排版 CSS（.neomd-export）。
 * 发布页把 Markdown 渲染进这套模板，保证网页分享与导出效果一致。
 */
import { escapeHtml, renderHtml, stripFrontmatter } from './markdown.js';

/** 与 packages/core 导出模块保持一致的正文样式 */
export const EXPORT_CSS = `
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
.neomd-export .neomd-meta{margin-top:3em;padding-top:1em;border-top:1px solid var(--border);
 font-size:.82em;color:var(--muted)}
.neomd-export .neomd-meta a{color:var(--muted);text-decoration:underline}
@media print{
  @page{margin:18mm 16mm}
  .neomd-export{max-width:none;padding:0}
  .neomd-export h1,.neomd-export h2,.neomd-export h3{break-after:avoid}
  .neomd-export pre,.neomd-export table,.neomd-export blockquote{break-inside:avoid}
  .neomd-export a{color:inherit;text-decoration:underline}
}
@media (max-width:640px){
  .neomd-export{padding:32px 18px 64px}
}
`;

/**  slug 化标题，用于目录锚点 */
export function slugify(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/** 由渲染后的 HTML 生成目录 */
export function buildToc(bodyHtml) {
  const re = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/g;
  const items = [];
  let match;
  while ((match = re.exec(bodyHtml))) {
    const level = Number(match[1]);
    const text = match[2].replace(/<[^>]+>/g, '').trim();
    if (!text) continue;
    items.push(`<li class="l${level}"><a href="#${slugify(text)}">${escapeHtml(text)}</a></li>`);
  }
  if (items.length === 0) return '';
  return `<nav class="toc"><div class="toc-title">目录</div><ul>${items.join('')}</ul></nav>`;
}

/**
 * 生成完整的独立 HTML 文档。
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.markdown] 原始 Markdown
 * @param {string} [options.bodyHtml] 已渲染的正文 HTML（优先）
 * @param {boolean} [options.toc] 是否输出目录
 * @param {string} [options.extraCss]
 * @param {string} [options.footerHtml] 页脚（作者、来源等）
 */
export function buildStandaloneHtml(options) {
  const title = String(options.title ?? 'Neo MD 文档');
  const bodyHtml =
    options.bodyHtml ?? renderHtml(stripFrontmatter(options.markdown ?? ''));
  const toc = options.toc ? buildToc(bodyHtml) : '';
  const extraCss = options.extraCss ? `\n${options.extraCss}` : '';
  const footer = options.footerHtml ? `\n<footer class="neomd-meta">${options.footerHtml}</footer>` : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Neo MD">
<title>${escapeHtml(title)}</title>
<style>${EXPORT_CSS}${extraCss}</style>
</head>
<body>
<main class="neomd-export">
${toc}
${bodyHtml}${footer}
</main>
</body>
</html>`;
}

export default { EXPORT_CSS, buildStandaloneHtml, buildToc, slugify };
