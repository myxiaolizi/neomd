/**
 * Markdown 渲染：禁用原始 HTML，避免分享页与发布页被注入脚本。
 */
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({
  html: false, // 关键：禁止裸 HTML
  xhtmlOut: false,
  breaks: false,
  langPrefix: 'language-',
  linkify: true,
  typographer: true,
  quotes: '“”‘’',
});

const defaultLinkOpen =
  md.renderer.rules.link_open ||
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

// 外链统一新窗口打开，并加安全属性
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const href = token.attrGet('href') || '';
  if (/^https?:\/\//i.test(href)) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer nofollow');
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/** HTML 转义 */
export function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Markdown → HTML 片段 */
export function renderHtml(markdown) {
  return md.render(String(markdown ?? ''));
}

/** 行内渲染（标题、摘要等场景） */
export function renderInline(markdown) {
  return md.renderInline(String(markdown ?? ''));
}

/** 去掉 frontmatter，返回正文 */
export function stripFrontmatter(source) {
  const text = String(source ?? '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

/** Markdown → 纯文本摘要 */
export function plainText(markdown, limit = 300) {
  const text = stripFrontmatter(markdown)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a, b) => b || a)
    .replace(/^[>#\-*+|\s]+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const max = Math.max(0, Number(limit) || 0);
  if (max > 0 && text.length > max) return `${text.slice(0, max)}…`;
  return text;
}

/** Markdown 渲染出的标题数量（供统计用） */
export function countHeadings(markdown) {
  const matches = String(markdown ?? '').match(/^#{1,6}\s+/gm);
  return matches ? matches.length : 0;
}

export default { renderHtml, renderInline, plainText, stripFrontmatter, escapeHtml, countHeadings, md };
