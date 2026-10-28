/**
 * 知识库切片引擎。
 *
 * 设计要点：
 * 1. **五种颗粒度**（doc / heading / paragraph / sentence / block）各自实现为独立的
 *    span 生成函数，都只产出 `{ start, end }` 字符区间；正文统一由 `text.slice()`
 *    取出，因此切片内容与原文永远严格对齐，`start`/`end` 可直接用于「跳回原文定位」。
 * 2. `start`/`end` 始终是**原始 content** 的坐标：剥离 frontmatter 时会维护一个
 *    `offset`，不破坏定位能力。
 * 3. `chunkVault` 负责跨文档职责（排除目录/标签、单文档字符上限），
 *    单文档切分不关心这些策略，便于单测与复用。
 */
import type { KnowledgeChunk, KnowledgeSettings } from '@neomd/shared';

/** 切片来源文档：由仓库条目 + 正文内容组装，引擎不依赖 Vault 具体实现 */
export interface ChunkSourceDoc {
  docId: string;
  title: string;
  path: string;
  content: string;
  tags: string[];
  updatedAt: number;
}

/** 切片区间（相对「切分文本」，最终会被 offset 还原成原文坐标） */
interface Span {
  start: number;
  end: number;
  /** 所属标题（heading 粒度必填，其他粒度可为空） */
  heading?: string;
  /** 标题层级 1-6 */
  level?: number;
}

/** 段落合并阈值：相邻段落合计不足该长度时继续合并，避免出现大量碎片切片 */
const PARAGRAPH_MERGE_MIN = 100;

/** 匹配 YAML frontmatter（`---` 包裹的头部），带或不带结尾换行都能命中 */
const FRONTMATTER_RE = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n)?/;

/** 数字夹紧 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * 准备切分文本：按 maxDocChars 截断，并按 includeFrontmatter 决定是否剥离元数据头。
 * @returns `{ text, offset }`，offset 为切分文本在原文中的起始偏移
 */
function prepareText(content: string, settings: KnowledgeSettings): { text: string; offset: number } {
  const raw = String(content ?? '');
  const maxChars = Math.round(clamp(Number(settings.maxDocChars) || 200_000, 100, 2_000_000));
  // 只截断尾部，保证头部坐标不变 → offset 机制依然成立
  const capped = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
  if (settings.includeFrontmatter) return { text: capped, offset: 0 };
  const match = FRONTMATTER_RE.exec(capped);
  if (!match) return { text: capped, offset: 0 };
  return { text: capped.slice(match[0].length), offset: match[0].length };
}

/**
 * Markdown → 纯文本（`keepMarkdown=false` 时使用）。
 * 目标不是完美解析，而是去掉标记符号让检索与注入更省 token。
 */
export function stripMarkdown(markdown: string): string {
  return String(markdown ?? '')
    // 代码块：去掉围栏行，保留代码内容
    .replace(/```[^\n]*\n/g, '')
    .replace(/```/g, '')
    // 标题符号
    .replace(/^#{1,6}[ \t]+/gm, '')
    // 图片 / 链接：保留可读文字
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 强调、行内代码、删除线、高亮标记
    .replace(/[*_~`]{1,3}/g, '')
    .replace(/==/g, '')
    // 引用与列表符号
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/^[ \t]*\d+\.[ \t]+/gm, '')
    // 表格分隔符
    .replace(/\|/g, ' ')
    // 压缩多余空行
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ */
/* 各颗粒度的区间生成                                                  */
/* ------------------------------------------------------------------ */

/** doc：整篇一个区间 */
function docSpans(text: string): Span[] {
  if (!text.trim()) return [];
  return [{ start: 0, end: text.length }];
}

/**
 * heading：按 `^#{1,6} ` 切分。
 * 第一个标题之前若存在正文，单独作为「前言」切片（level 记 1，便于 UI 统一展示）。
 */
function headingSpans(text: string): Span[] {
  const re = /^(#{1,6})[ \t]+(.+?)[ \t]*$/gm;
  const heads: Array<{ index: number; heading: string; level: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    heads.push({ index: match.index, heading: match[2]!.trim(), level: match[1]!.length });
  }
  if (heads.length === 0) {
    return text.trim() ? [{ start: 0, end: text.length }] : [];
  }

  const spans: Span[] = [];
  const first = heads[0]!;
  if (text.slice(0, first.index).trim()) {
    spans.push({ start: 0, end: first.index, heading: '前言', level: 1 });
  }
  for (let i = 0; i < heads.length; i++) {
    const cur = heads[i]!;
    const next = heads[i + 1];
    spans.push({
      start: cur.index,
      end: next ? next.index : text.length,
      heading: cur.heading,
      level: cur.level,
    });
  }
  return spans.filter((span) => text.slice(span.start, span.end).trim() !== '');
}

/**
 * paragraph：按空行（一个及以上空行）切分，相邻过短段落自动合并。
 * 合并后区间仍然连续，中间的空行会一起被包含进来，因此原文定位不丢字符。
 */
function paragraphSpans(text: string): Span[] {
  const separator = /\n[ \t]*\n+/g;
  const raw: Span[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = separator.exec(text)) !== null) {
    raw.push({ start: cursor, end: match.index });
    cursor = match.index + match[0].length;
  }
  raw.push({ start: cursor, end: text.length });

  const parts = raw.filter((span) => text.slice(span.start, span.end).trim() !== '');
  const merged: Span[] = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (last && text.slice(last.start, last.end).trim().length < PARAGRAPH_MERGE_MIN) {
      last.end = part.end;
    } else {
      merged.push({ ...part });
    }
  }
  return merged;
}

/** sentence：按中文句末标点与换行切分，纯空白句直接丢弃 */
function sentenceSpans(text: string): Span[] {
  const stops = new Set(['。', '！', '？', '；', '.', '!', '?', ';', '\n']);
  const spans: Span[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (stops.has(text[i]!)) {
      spans.push({ start, end: i + 1 });
      start = i + 1;
    }
  }
  if (start < text.length) spans.push({ start, end: text.length });
  return spans.filter((span) => text.slice(span.start, span.end).trim() !== '');
}

/**
 * block：固定长度滑动窗口 + 重叠。
 * 严格按窗口切分（不做边界回退），保证片数与区间可预测，便于单测与调参。
 */
function blockSpans(text: string, chunkSizeInput: number, overlapInput: number): Span[] {
  const length = text.length;
  if (length === 0) return [];
  const chunkSize = Math.round(clamp(chunkSizeInput, 50, 8000));
  // 重叠必须小于窗口长度，否则窗口无法前进
  const overlap = Math.round(clamp(overlapInput, 0, Math.max(0, chunkSize - 1)));
  const step = Math.max(1, chunkSize - overlap);
  const spans: Span[] = [];
  for (let start = 0; start < length; start += step) {
    const end = Math.min(start + chunkSize, length);
    spans.push({ start, end });
    if (end >= length) break;
  }
  return spans;
}

/** 按设置选择切片策略 */
function spansFor(text: string, settings: KnowledgeSettings): Span[] {
  switch (settings.granularity) {
    case 'doc':
      return docSpans(text);
    case 'heading':
      return headingSpans(text);
    case 'sentence':
      return sentenceSpans(text);
    case 'block':
      return blockSpans(text, settings.chunkSize, settings.chunkOverlap);
    case 'paragraph':
    default:
      return paragraphSpans(text);
  }
}

/* ------------------------------------------------------------------ */
/* 对外 API                                                            */
/* ------------------------------------------------------------------ */

/** 按设置颗粒度切分单篇文档 */
export function chunkDocument(doc: ChunkSourceDoc, settings: KnowledgeSettings): KnowledgeChunk[] {
  const { text, offset } = prepareText(doc.content, settings);
  if (!text.trim()) return [];

  const spans = spansFor(text, settings);
  const tags = Array.isArray(doc.tags) ? [...doc.tags] : [];
  const chunks: KnowledgeChunk[] = [];

  for (const span of spans) {
    const raw = text.slice(span.start, span.end);
    if (!raw.trim()) continue;
    const body = settings.keepMarkdown ? raw : stripMarkdown(raw);
    if (!body.trim()) continue;
    const index = chunks.length;
    chunks.push({
      id: `${doc.docId}#${index}`,
      docId: doc.docId,
      title: doc.title,
      path: doc.path,
      start: offset + span.start,
      end: offset + span.end,
      ...(span.heading ? { heading: span.heading } : {}),
      ...(span.level !== undefined ? { level: span.level } : {}),
      text: body,
      tags,
      updatedAt: doc.updatedAt,
    });
  }
  return chunks;
}

/** 统一路径写法：Posix 分隔符、去掉开头的 ./ 与 /、去掉结尾 / */
export function normalizeDocPath(input: string): string {
  return String(input ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.?\/*/, '')
    .replace(/\/+$/, '');
}

/** 统一标签写法：小写、去掉前导 # */
function normalizeTag(input: string): string {
  return String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^#+/, '');
}

/** 文档是否被排除规则命中（排除目录按路径前缀匹配，排除标签按命中任一即排除） */
export function isDocExcluded(doc: ChunkSourceDoc, settings: KnowledgeSettings): boolean {
  const path = normalizeDocPath(doc.path);
  for (const folder of settings.excludeFolders ?? []) {
    const target = normalizeDocPath(folder);
    if (!target) continue;
    if (path === target || path.startsWith(`${target}/`)) return true;
  }
  const tags = new Set((doc.tags ?? []).map(normalizeTag).filter(Boolean));
  for (const tag of settings.excludeTags ?? []) {
    const target = normalizeTag(tag);
    if (target && tags.has(target)) return true;
  }
  return false;
}

/** 批量切分：应用排除目录/标签过滤与单文档字符上限（截断在 chunkDocument 内完成） */
export function chunkVault(docs: ChunkSourceDoc[], settings: KnowledgeSettings): KnowledgeChunk[] {
  const out: KnowledgeChunk[] = [];
  for (const doc of docs ?? []) {
    if (!doc || !doc.docId) continue;
    if (isDocExcluded(doc, settings)) continue;
    out.push(...chunkDocument(doc, settings));
  }
  return out;
}

export default { chunkDocument, chunkVault, isDocExcluded, normalizeDocPath, stripMarkdown };
