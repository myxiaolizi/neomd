/**
 * 知识库检索引擎。
 *
 * 三种模式（全部零依赖、纯本地计算）：
 * - `keyword`：中文二元分词 + 英文词，BM25 打分（k1=1.2, b=0.75）；
 * - `hybrid`：关键词得分 × 0.6 + 标题/位置权重 × 0.4；
 * - `vector`：字符 n-gram 向量 + 余弦相似度。
 *
 * 关于 `vector`：这里是**可替换的降级方案**——不引入任何第三方 embedding 模型，
 * 用 2/3 字符 n-gram 频次向量近似语义。若将来接入真实向量模型，
 * 只要实现 `Embedder` 接口并通过 `search()` 的第四参数传入，无需改动其余逻辑。
 */
import type { KnowledgeChunk, KnowledgeHit, KnowledgeSettings } from '@neomd/shared';
import { chunkVault, type ChunkSourceDoc } from './chunker';

/** 知识库索引：由 chunkVault 产出，可整体重建或增量修补 */
export interface KnowledgeIndex {
  chunks: KnowledgeChunk[];
  builtAt: number;
  docCount: number;
}

/** 可插拔向量编码器（默认不启用，留作将来接入真实 embedding 模型） */
export interface Embedder {
  embed(text: string): number[];
}

/* ------------------------------ BM25 参数 ------------------------------ */

const K1 = 1.2;
const B = 0.75;
/** BM25 原始分归一化半值：raw=2.5 时得分 0.5，便于 minScore 当百分比理解 */
const RAW_HALF = 2.5;

/** 中文（含扩展 A 区）判定 */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
/** 英文/数字词 */
const LATIN_WORD_RE = /[a-z0-9_]+/g;
/** 连续中文串 */
const CJK_RUN_RE = /[\u4e00-\u9fff\u3400-\u4dbf]+/g;

/** 是否包含中日韩字符 */
export function hasCjk(text: string): boolean {
  return CJK_RE.test(String(text ?? ''));
}

/**
 * 轻量分词：中文取二元组（bigram），英文/数字取整词。
 * 之所以不用单字：单字噪声过大（「的」「了」），反而拉低检索质量。
 * 之所以不用第三方分词器：本项目约束「不引入新依赖」。
 */
export function tokenizeForKnowledge(text: string): string[] {
  const lower = String(text ?? '').toLowerCase();
  const out: string[] = [];
  for (const word of lower.match(LATIN_WORD_RE) ?? []) {
    if (word.length >= 2) out.push(word);
  }
  for (const run of lower.match(CJK_RUN_RE) ?? []) {
    if (run.length === 1) {
      out.push(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

/* --------------------------- 索引统计（缓存） --------------------------- */

interface IndexStats {
  n: number;
  avgLen: number;
  /** 每个切片的分词长度 */
  lens: number[];
  /** 每个切片的词频表 */
  termFreqs: Array<Map<string, number>>;
  /** 词 → 包含该词的切片数 */
  docFreq: Map<string, number>;
  /** 每个切片的字符 n-gram 向量（vector 模式用） */
  vectors: Array<Map<string, number>>;
  /** 每个切片的向量模长 */
  norms: number[];
}

/**
 * 统计缓存：以 index 对象为 key。
 * index 被重建时会生成新对象，旧缓存随之被 GC，不需要手动失效。
 */
const STATS_CACHE = new WeakMap<KnowledgeIndex, IndexStats>();

/** 字符 n-gram 频次向量（n=2,3），作为无模型环境下的语义近似 */
function ngramVector(text: string): { vector: Map<string, number>; norm: number } {
  const clean = String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const vector = new Map<string, number>();
  for (const n of [2, 3]) {
    for (let i = 0; i + n <= clean.length; i++) {
      const gram = clean.slice(i, i + n);
      if (!gram.trim()) continue;
      vector.set(gram, (vector.get(gram) ?? 0) + 1);
    }
  }
  let sum = 0;
  for (const value of vector.values()) sum += value * value;
  return { vector, norm: Math.sqrt(sum) };
}

/** 计算（或取缓存）索引统计 */
function statsFor(index: KnowledgeIndex): IndexStats {
  const cached = STATS_CACHE.get(index);
  if (cached) return cached;

  const termFreqs: Array<Map<string, number>> = [];
  const lens: number[] = [];
  const docFreq = new Map<string, number>();
  const vectors: Array<Map<string, number>> = [];
  const norms: number[] = [];
  let total = 0;

  for (const chunk of index.chunks) {
    // 标题与章节名参与打分：用户查「部署」时，标题含「部署」的切片应更靠前
    const tokens = tokenizeForKnowledge(`${chunk.title}\n${chunk.heading ?? ''}\n${chunk.text}`);
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    termFreqs.push(tf);
    lens.push(tokens.length);
    total += tokens.length;
    for (const token of tf.keys()) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);

    const { vector, norm } = ngramVector(`${chunk.title}\n${chunk.text}`);
    vectors.push(vector);
    norms.push(norm);
  }

  const stats: IndexStats = {
    n: index.chunks.length,
    avgLen: index.chunks.length > 0 ? total / index.chunks.length : 0,
    lens,
    termFreqs,
    docFreq,
    vectors,
    norms,
  };
  STATS_CACHE.set(index, stats);
  return stats;
}

/* ------------------------------ 打分细节 ------------------------------ */

/** BM25 原始分 + 命中词 */
function bm25Score(
  queryTokens: string[],
  position: number,
  stats: IndexStats,
): { raw: number; hits: string[] } {
  const tf = stats.termFreqs[position];
  if (!tf) return { raw: 0, hits: [] };
  const dl = stats.lens[position] ?? 0;
  const avgLen = stats.avgLen || 1;
  const hits: string[] = [];
  let raw = 0;
  for (const token of queryTokens) {
    const freq = tf.get(token) ?? 0;
    if (freq === 0) continue;
    hits.push(token);
    const df = stats.docFreq.get(token) ?? 0;
    const idf = Math.log(1 + (stats.n - df + 0.5) / (df + 0.5));
    const denom = freq + K1 * (1 - B + (B * dl) / avgLen);
    if (denom > 0) raw += idf * ((freq * (K1 + 1)) / denom);
  }
  return { raw, hits };
}

/** BM25 原始分 → 0-1（单调递增，阈值语义稳定） */
function normalizeBm25(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw / (raw + RAW_HALF);
}

/** 标题/位置加权：命中标题权重最高，正文越靠前权重越高 */
function lexicalBoost(chunk: KnowledgeChunk, queryTokens: string[], query: string): number {
  const title = String(chunk.title ?? '').toLowerCase();
  const heading = String(chunk.heading ?? '').toLowerCase();
  const body = String(chunk.text ?? '').toLowerCase();
  const q = query.toLowerCase().trim();

  if (q && title.includes(q)) return 1;
  if (queryTokens.some((t) => heading.includes(t))) return 0.9;
  if (queryTokens.some((t) => title.includes(t))) return 0.85;
  if (q && body.includes(q)) {
    const pos = body.indexOf(q);
    const ratio = pos / Math.max(1, body.length);
    return 0.5 + 0.4 * (1 - Math.min(1, ratio));
  }
  return 0.3;
}

/** 余弦相似度（向量模长为 0 时返回 0） */
function cosine(
  queryVector: Map<string, number>,
  queryNorm: number,
  chunkVector: Map<string, number>,
  chunkNorm: number,
): number {
  if (queryNorm === 0 || chunkNorm === 0) return 0;
  let dot = 0;
  // 遍历较短的一侧以减少查表次数
  const [small, large] =
    queryVector.size <= chunkVector.size
      ? [queryVector, chunkVector]
      : [chunkVector, queryVector];
  for (const [gram, value] of small) {
    const other = large.get(gram);
    if (other) dot += value * other;
  }
  return dot / (queryNorm * chunkNorm);
}

/** 计算命中关键词（用于前端高亮）：优先整词，其次 CJK 长词与英文词，最后退回二元组 */
function matchedTerms(chunk: KnowledgeChunk, query: string, queryTokens: string[]): string[] {
  const text = `${chunk.title}\n${chunk.heading ?? ''}\n${chunk.text}`.toLowerCase();
  const out: string[] = [];
  const q = query.toLowerCase().trim();
  if (q && text.includes(q)) out.push(query.trim());
  for (const run of q.match(CJK_RUN_RE) ?? []) {
    if (run.length >= 2 && text.includes(run) && !out.includes(run)) out.push(run);
  }
  for (const word of q.match(LATIN_WORD_RE) ?? []) {
    if (word.length >= 2 && text.includes(word) && !out.includes(word)) out.push(word);
  }
  if (out.length === 0) {
    for (const token of queryTokens) {
      if (text.includes(token) && !out.includes(token)) out.push(token);
    }
  }
  return out.slice(0, 8);
}

/* ------------------------------ 对外 API ------------------------------ */

/** 构建索引（全量） */
export function buildIndex(docs: ChunkSourceDoc[], settings: KnowledgeSettings): KnowledgeIndex {
  const chunks = chunkVault(docs ?? [], settings);
  return {
    chunks,
    builtAt: Date.now(),
    docCount: new Set(chunks.map((chunk) => chunk.docId)).size,
  };
}

/**
 * 检索。
 * @param embedder 可选向量编码器；`searchMode=vector` 且未提供时走字符 n-gram 降级
 */
export function search(
  index: KnowledgeIndex,
  query: string,
  settings: KnowledgeSettings,
  options: { embedder?: Embedder } = {},
): KnowledgeHit[] {
  // 关闭知识库后，检索一律返回空（API 与 UI 保持一致）
  if (!settings.enabled) return [];
  const q = String(query ?? '').trim();
  if (!q || !index.chunks.length) return [];

  const stats = statsFor(index);
  const queryTokens = [...new Set(tokenizeForKnowledge(q))];
  if (queryTokens.length === 0) return [];

  const useVector = settings.searchMode === 'vector';
  const embedder = options.embedder;

  // 向量模式所需的查询向量（有 embedder 时走 embedder，否则 n-gram 降级）
  let queryVector: Map<string, number> | null = null;
  let queryNorm = 0;
  let queryEmbedding: number[] | null = null;
  /** 单次检索内的 embedding 缓存：同一批切片不重复编码 */
  const embeddingCache = new Map<string, number[]>();
  if (useVector) {
    if (embedder) {
      queryEmbedding = embedder.embed(q);
    } else {
      const built = ngramVector(q);
      queryVector = built.vector;
      queryNorm = built.norm;
    }
  }

  const scored: Array<{ chunk: KnowledgeChunk; score: number }> = [];

  for (let i = 0; i < index.chunks.length; i++) {
    const chunk = index.chunks[i]!;
    let score = 0;

    if (useVector) {
      if (embedder && queryEmbedding) {
        // 接入了真实向量模型：按切片 id 缓存编码结果，避免同一次检索重复调用
        let chunkEmbedding = embeddingCache.get(chunk.id);
        if (!chunkEmbedding) {
          chunkEmbedding = embedder.embed(chunk.text);
          embeddingCache.set(chunk.id, chunkEmbedding);
        }
        score = dotProductSimilarity(queryEmbedding, chunkEmbedding);
      } else if (queryVector) {
        score = cosine(queryVector, queryNorm, stats.vectors[i] ?? new Map(), stats.norms[i] ?? 0);
      }
    } else {
      const { raw } = bm25Score(queryTokens, i, stats);
      const keywordScore = normalizeBm25(raw);
      if (keywordScore <= 0) continue;
      if (settings.searchMode === 'hybrid') {
        score = keywordScore * 0.6 + lexicalBoost(chunk, queryTokens, q) * 0.4;
      } else {
        score = keywordScore;
      }
    }

    if (score > 0 && score >= settings.minScore) {
      scored.push({ chunk, score });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // 同分时近期修改的优先，其次按路径稳定排序，保证结果可复现
    if (b.chunk.updatedAt !== a.chunk.updatedAt) return b.chunk.updatedAt - a.chunk.updatedAt;
    return a.chunk.path.localeCompare(b.chunk.path);
  });

  const topK = Math.round(Math.min(30, Math.max(1, Number(settings.topK) || 8)));
  return scored.slice(0, topK).map((item) => ({
    ...item.chunk,
    score: Math.round(item.score * 10000) / 10000,
    matched: matchedTerms(item.chunk, q, queryTokens),
  }));
}

/** 归一化向量点积（两个向量都已归一化时等价于余弦） */
function dotProductSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    dot += va * vb;
    na += va * va;
    nb += vb * vb;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 注入 AI 的上下文默认字符预算（约 1.5k tokens，够 5-8 个片段） */
export const DEFAULT_CONTEXT_CHAR_BUDGET = 6000;

/**
 * 把检索结果拼成给 LLM 的上下文。
 *
 * 输出格式：
 * ```
 * 【片段 1】《文档标题》 / 章节名
 * <正文>
 * ---
 * ```
 * 受 `maxContextChunks` 与总字符预算双重约束：预算耗尽时截断当前片段并停止追加。
 */
export function buildContext(
  hits: KnowledgeHit[],
  settings: KnowledgeSettings,
  options: { charBudget?: number } = {},
): string {
  if (!Array.isArray(hits) || hits.length === 0) return '';
  const budget = Math.round(
    Math.min(200_000, Math.max(200, Number(options.charBudget) || DEFAULT_CONTEXT_CHAR_BUDGET)),
  );
  const limit = Math.round(Math.min(50, Math.max(1, Number(settings.maxContextChunks) || 6)));

  const blocks: string[] = [];
  let used = 0;
  let index = 0;

  for (const hit of hits) {
    if (index >= limit) break;
    const title = String(hit.title ?? '未命名');
    const header = `【片段 ${index + 1}】《${title}》${hit.heading ? ` / ${hit.heading}` : ''}`;
    const body = String(hit.text ?? '').trim();
    if (!body) continue;

    const block = `${header}\n${body}\n---`;
    if (used + block.length + 2 <= budget) {
      blocks.push(block);
      used += block.length + 2;
      index += 1;
      continue;
    }

    // 预算装不下完整片段：截断后收尾，避免把半个句子塞进上下文
    const remain = budget - used - header.length - 8;
    if (remain >= 120) {
      blocks.push(`${header}\n${body.slice(0, remain)}…\n---`);
      index += 1;
    }
    break;
  }

  return blocks.join('\n\n');
}

export default { buildIndex, search, buildContext, tokenizeForKnowledge, hasCjk };
