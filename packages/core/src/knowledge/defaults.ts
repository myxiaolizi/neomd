/**
 * 知识库默认设置与归一化。
 *
 * 为什么需要归一化：`Settings.knowledge` 是 1.1.0 新增字段，
 * 老用户的 localStorage / 云端 payload 里没有这一块，直接读会出现 `undefined`
 * 导致切片引擎抛错。这里提供一份「永远合法」的默认值，并在读写时夹紧到合法区间，
 * 保证 UI 滑块与引擎行为一致（用户填 9999 也能被安全收敛）。
 */
import type { KnowledgeGranularity, KnowledgeSearchMode, KnowledgeSettings } from '@neomd/shared';

/** 五种切片颗粒度（UI 下拉与引擎共用同一份定义，避免两处漂移） */
export const KNOWLEDGE_GRANULARITIES: Array<{
  id: KnowledgeGranularity;
  label: string;
  desc: string;
  /** 适用场景提示，展示在设置页的说明里 */
  scenario: string;
}> = [
  {
    id: 'doc',
    label: '整篇文档',
    desc: '每篇文档作为 1 个切片',
    scenario: '适合「总结这篇笔记」「这些文档讲了什么」这类整篇级问答',
  },
  {
    id: 'heading',
    label: '按标题',
    desc: '按 H1-H6 标题切分，每片是一个章节',
    scenario: '适合结构清晰的长文，检索精度与上下文兼顾',
  },
  {
    id: 'paragraph',
    label: '按段落',
    desc: '按空行切分，过短的相邻段落会自动合并',
    scenario: '默认推荐，适合绝大多数笔记仓库',
  },
  {
    id: 'sentence',
    label: '按句子',
    desc: '按 。！？；和换行切分',
    scenario: '适合需要精确定位的问答，切片最细、召回最密',
  },
  {
    id: 'block',
    label: '固定长度窗口',
    desc: '按字符数滑动窗口切分，支持重叠',
    scenario: '适合没有标题结构的长文、剪藏、转录稿',
  },
];

/** 检索模式定义（含说明，UI 直接渲染） */
export const KNOWLEDGE_SEARCH_MODES: Array<{
  id: KnowledgeSearchMode;
  label: string;
  desc: string;
}> = [
  {
    id: 'keyword',
    label: '关键词（BM25）',
    desc: '按词频与逆文档频率打分，速度快、结果可解释，适合精确名词查询',
  },
  {
    id: 'hybrid',
    label: '混合（推荐）',
    desc: '关键词得分 × 0.6 + 标题/位置权重 × 0.4，兼顾精确与语义',
  },
  {
    id: 'vector',
    label: '向量（本地降级）',
    desc: '字符 n-gram 向量 + 余弦相似度，无需联网与模型，适合近义改写查询',
  },
];

/** 各字段的合法区间，归一化与 UI 滑块共用 */
export const KNOWLEDGE_LIMITS = {
  chunkSize: { min: 200, max: 4000, step: 100 },
  chunkOverlap: { min: 0, max: 500, step: 20 },
  topK: { min: 1, max: 30, step: 1 },
  minScore: { min: 0, max: 1, step: 0.05 },
  maxDocChars: { min: 1000, max: 2_000_000, step: 1000 },
  maxContextChunks: { min: 1, max: 20, step: 1 },
} as const;

/** 默认值：段落粒度 + 混合检索，开箱即用 */
export const DEFAULT_KNOWLEDGE_SETTINGS: KnowledgeSettings = {
  enabled: false,
  granularity: 'paragraph',
  chunkSize: 800,
  chunkOverlap: 120,
  topK: 8,
  minScore: 0.15,
  searchMode: 'hybrid',
  keepMarkdown: true,
  includeFrontmatter: false,
  excludeFolders: [],
  excludeTags: [],
  maxDocChars: 200_000,
  autoIndex: true,
  maxContextChunks: 6,
};

/** 把数值夹紧到区间内，非法值回退到默认 */
function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 归一化字符串数组：去空、去重、去首尾空白 */
function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = String(item ?? '').trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out.slice(0, 100);
}

function isGranularity(value: unknown): value is KnowledgeGranularity {
  return KNOWLEDGE_GRANULARITIES.some((g) => g.id === value);
}

function isSearchMode(value: unknown): value is KnowledgeSearchMode {
  return KNOWLEDGE_SEARCH_MODES.some((m) => m.id === value);
}

/**
 * 把任意来源（本地旧数据 / 云端 payload / 表单输入）的知识库设置归一化为合法对象。
 * 永不抛错：任何非法字段都回退到默认值。
 */
export function normalizeKnowledgeSettings(
  input?: Partial<KnowledgeSettings> | null,
): KnowledgeSettings {
  const src = input ?? {};
  const L = KNOWLEDGE_LIMITS;
  const d = DEFAULT_KNOWLEDGE_SETTINGS;
  const chunkSize = clampNum(src.chunkSize, L.chunkSize.min, L.chunkSize.max, d.chunkSize);
  return {
    enabled: src.enabled === undefined ? d.enabled : Boolean(src.enabled),
    granularity: isGranularity(src.granularity) ? src.granularity : d.granularity,
    chunkSize,
    // 重叠必须小于切片长度，否则滑动窗口会退化成「原地踏步」
    chunkOverlap: Math.min(
      chunkSize - 1,
      clampNum(src.chunkOverlap, L.chunkOverlap.min, L.chunkOverlap.max, d.chunkOverlap),
    ),
    topK: Math.round(clampNum(src.topK, L.topK.min, L.topK.max, d.topK)),
    minScore: clampNum(src.minScore, L.minScore.min, L.minScore.max, d.minScore),
    searchMode: isSearchMode(src.searchMode) ? src.searchMode : d.searchMode,
    keepMarkdown: src.keepMarkdown === undefined ? d.keepMarkdown : Boolean(src.keepMarkdown),
    includeFrontmatter:
      src.includeFrontmatter === undefined ? d.includeFrontmatter : Boolean(src.includeFrontmatter),
    excludeFolders: normalizeList(src.excludeFolders),
    excludeTags: normalizeList(src.excludeTags),
    maxDocChars: Math.round(
      clampNum(src.maxDocChars, L.maxDocChars.min, L.maxDocChars.max, d.maxDocChars),
    ),
    autoIndex: src.autoIndex === undefined ? d.autoIndex : Boolean(src.autoIndex),
    maxContextChunks: Math.round(
      clampNum(src.maxContextChunks, L.maxContextChunks.min, L.maxContextChunks.max, d.maxContextChunks),
    ),
  };
}

/** 两份设置是否等价（用于判断「改了设置要不要重建索引」） */
export function knowledgeSettingsEqual(a: KnowledgeSettings, b: KnowledgeSettings): boolean {
  return (
    a.enabled === b.enabled &&
    a.granularity === b.granularity &&
    a.chunkSize === b.chunkSize &&
    a.chunkOverlap === b.chunkOverlap &&
    a.topK === b.topK &&
    a.minScore === b.minScore &&
    a.searchMode === b.searchMode &&
    a.keepMarkdown === b.keepMarkdown &&
    a.includeFrontmatter === b.includeFrontmatter &&
    a.maxDocChars === b.maxDocChars &&
    a.autoIndex === b.autoIndex &&
    a.maxContextChunks === b.maxContextChunks &&
    a.excludeFolders.join('|') === b.excludeFolders.join('|') &&
    a.excludeTags.join('|') === b.excludeTags.join('|')
  );
}
