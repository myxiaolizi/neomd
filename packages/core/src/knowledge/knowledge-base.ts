/**
 * 知识库服务：把「切片 + 检索」封装成有状态的对象，供 UI 与 AI 面板直接使用。
 *
 * 生命周期约定：
 * - `rebuild(docs)` 全量重建；
 * - `upsertDoc(doc)` 增量更新单篇（`autoIndex=false` 时只标脏，等下次 search/rebuild 重建）；
 * - `updateSettings(next)` 只在「影响切片」的字段变化时重建，纯检索参数（topK/minScore/
 *   searchMode）变更不重建索引，避免用户拖滑块时反复全量切片。
 */
import type { KnowledgeChunk, KnowledgeHit, KnowledgeSettings } from '@neomd/shared';
import { chunkDocument, isDocExcluded, type ChunkSourceDoc } from './chunker';
import { buildIndex, search as searchIndex, type KnowledgeIndex } from './search';

/** 知识库运行统计（设置页「实时统计」直接展示） */
export interface KnowledgeStats {
  docCount: number;
  chunkCount: number;
  builtAt: number;
  avgChunkChars: number;
}

/**
 * 判断「是否需要重建索引」的签名：
 * 只有真正影响切片结果的字段进签名；topK / minScore / searchMode 属于检索期参数。
 */
function chunkingSignature(settings: KnowledgeSettings): string {
  return [
    settings.granularity,
    settings.chunkSize,
    settings.chunkOverlap,
    settings.keepMarkdown ? '1' : '0',
    settings.includeFrontmatter ? '1' : '0',
    settings.maxDocChars,
    [...settings.excludeFolders].sort().join(','),
    [...settings.excludeTags].sort().join(','),
  ].join('|');
}

/** 空索引（未构建时的占位） */
function emptyIndex(): KnowledgeIndex {
  return { chunks: [], builtAt: 0, docCount: 0 };
}

export class KnowledgeBase {
  private settings: KnowledgeSettings;
  private docs = new Map<string, ChunkSourceDoc>();
  private index: KnowledgeIndex = emptyIndex();
  /** 是否需要全量重建（设置变更或 autoIndex=false 下写入文档时置位） */
  private dirty = true;

  constructor(settings: KnowledgeSettings) {
    this.settings = settings;
  }

  /** 当前生效设置（只读副本，避免外部直接改到内部状态） */
  get currentSettings(): KnowledgeSettings {
    return { ...this.settings };
  }

  /** 更新设置：影响切片的字段变化时标脏，等待下次检索重建 */
  updateSettings(next: KnowledgeSettings): void {
    const changed = chunkingSignature(this.settings) !== chunkingSignature(next);
    const enabledChanged = this.settings.enabled !== next.enabled;
    this.settings = next;
    // 重新启用知识库时也要重建，否则关闭期间新增的文档不会进索引
    if (changed || (enabledChanged && next.enabled)) this.dirty = true;
  }

  /** 增量更新单篇（autoIndex 用） */
  upsertDoc(doc: ChunkSourceDoc): void {
    if (!doc || !doc.docId) return;
    this.docs.set(doc.docId, doc);
    if (!this.settings.autoIndex) {
      // 关闭自动索引时只记录文档，等用户手动重建
      this.dirty = true;
      return;
    }
    if (!this.index.chunks.length && this.docs.size > 1) {
      // 冷启动阶段（还没建过索引）直接全量重建更划算，避免逐篇 O(n²)
      this.rebuild([...this.docs.values()]);
      return;
    }
    const others = this.index.chunks.filter((chunk) => chunk.docId !== doc.docId);
    const fresh = isDocExcluded(doc, this.settings) ? [] : chunkDocument(doc, this.settings);
    const chunks = [...others, ...fresh];
    this.index = {
      chunks,
      builtAt: Date.now(),
      docCount: new Set(chunks.map((chunk) => chunk.docId)).size,
    };
    this.dirty = false;
  }

  /** 移除单篇 */
  removeDoc(docId: string): void {
    const id = String(docId ?? '');
    if (!id) return;
    this.docs.delete(id);
    this.index = {
      ...this.index,
      chunks: this.index.chunks.filter((chunk) => chunk.docId !== id),
      builtAt: Date.now(),
    };
    this.index.docCount = new Set(this.index.chunks.map((chunk) => chunk.docId)).size;
  }

  /** 全量重建 */
  rebuild(docs: ChunkSourceDoc[]): KnowledgeIndex {
    this.docs = new Map();
    for (const doc of docs ?? []) {
      if (doc && doc.docId) this.docs.set(doc.docId, doc);
    }
    this.index = buildIndex([...this.docs.values()], this.settings);
    this.dirty = false;
    return this.index;
  }

  /** 检索（脏索引会先自动重建，保证结果与最新文档一致） */
  search(query: string): KnowledgeHit[] {
    if (!this.settings.enabled) return [];
    this.ensureFresh();
    return searchIndex(this.index, query, this.settings);
  }

  /** 需要时就地重建（settings 变更 / autoIndex=false 期间的写入） */
  private ensureFresh(): void {
    if (!this.dirty) return;
    if (this.docs.size === 0) {
      this.index = emptyIndex();
      this.dirty = false;
      return;
    }
    this.index = buildIndex([...this.docs.values()], this.settings);
    this.dirty = false;
  }

  /**
   * 统计信息。
   * 注意：为了让设置页的「实时统计」在改完颗粒度后立刻反映新切片数，
   * 这里在脏状态下会触发一次重建（getter 带轻量副作用，但换来更直观的交互）。
   */
  get stats(): KnowledgeStats {
    this.ensureFresh();
    const chunks: KnowledgeChunk[] = this.index.chunks;
    const totalChars = chunks.reduce((sum, chunk) => sum + String(chunk.text ?? '').length, 0);
    return {
      docCount: this.index.docCount,
      chunkCount: chunks.length,
      builtAt: this.index.builtAt,
      avgChunkChars: chunks.length > 0 ? Math.round(totalChars / chunks.length) : 0,
    };
  }

  /** 当前索引快照（调试与测试用） */
  get snapshot(): KnowledgeIndex {
    this.ensureFresh();
    return this.index;
  }
}

export default { KnowledgeBase };
