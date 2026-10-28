/**
 * 知识库 ↔ 仓库 桥接层。
 *
 * 为什么放在 core 而不是 stores：
 * `SettingsPage` 与 `AiPanel` 都要用知识库，若各自 new 一个 `KnowledgeBase`，
 * 同一份仓库会被切片两次（内存翻倍、改设置后两边统计不一致）。
 * 但本任务不允许改 `stores/**`，因此在 core 里提供一个**进程内单例**，
 * 两个组件通过 `sharedKnowledgeBase()` 拿到同一个实例。
 */
import type { DocMeta, KnowledgeSettings } from '@neomd/shared';
import { parseDoc } from '../vault/markdown-parse';
import type { ChunkSourceDoc } from './chunker';
import { normalizeKnowledgeSettings } from './defaults';
import { KnowledgeBase } from './knowledge-base';

/**
 * 只依赖仓库的两个方法，因此浏览器适配器 / 桌面原生适配器都能直接用，
 * 也方便单测里传假对象。
 */
export interface VaultLike {
  listAll(): DocMeta[];
  read(docId: string): Promise<string>;
}

/** 单次加载的文档数上限（防止超大仓库阻塞 UI） */
export const MAX_INDEXED_DOCS = 5000;

export interface LoadProgress {
  done: number;
  total: number;
  currentPath: string;
}

export interface LoadOptions {
  /** 进度回调（用于设置页展示「正在索引 x/y」） */
  onProgress?: (p: LoadProgress) => void;
  /** 最多加载多少篇，默认 MAX_INDEXED_DOCS */
  limit?: number;
}

/**
 * 从仓库读取全部文档内容，组装成切片源。
 * 逐篇读取并容错：单篇读取失败（文件被外部删除等）直接跳过，不中断整体。
 */
export async function loadSourceDocs(vault: VaultLike, options: LoadOptions = {}): Promise<ChunkSourceDoc[]> {
  const metas = vault.listAll().filter((meta) => meta && !meta.deletedAt);
  const limit = Math.max(1, Math.min(MAX_INDEXED_DOCS, Number(options.limit) || MAX_INDEXED_DOCS));
  const targets = metas.slice(0, limit);
  const out: ChunkSourceDoc[] = [];

  for (let i = 0; i < targets.length; i++) {
    const meta = targets[i]!;
    options.onProgress?.({ done: i, total: targets.length, currentPath: meta.path });
    let content: string;
    try {
      content = await vault.read(meta.docId);
    } catch {
      continue;
    }
    if (!content || !content.trim()) continue;
    // tags 只从 frontmatter / 正文 #tag 里取；解析失败时给空数组，不影响切片
    let tags: string[] = [];
    try {
      tags = parseDoc(content).tags ?? [];
    } catch {
      tags = [];
    }
    out.push({
      docId: meta.docId,
      title: meta.title || meta.path,
      path: meta.path,
      content,
      tags,
      updatedAt: Number(meta.updatedAt) || Date.now(),
    });
  }

  options.onProgress?.({ done: targets.length, total: targets.length, currentPath: '' });
  return out;
}

/* ------------------------------------------------------------------ */
/* 进程内单例                                                          */
/* ------------------------------------------------------------------ */

let sharedBase: KnowledgeBase | null = null;

/**
 * 取共享的 KnowledgeBase 实例。
 * 传入 settings 时会同步到实例（影响切片的字段变化才会触发重建）。
 */
export function sharedKnowledgeBase(settings?: KnowledgeSettings): KnowledgeBase {
  const normalized = normalizeKnowledgeSettings(settings);
  if (!sharedBase) {
    sharedBase = new KnowledgeBase(normalized);
  } else if (settings) {
    sharedBase.updateSettings(normalized);
  }
  return sharedBase;
}

/** 重置单例（切换仓库 / 测试用） */
export function resetSharedKnowledgeBase(): void {
  sharedBase = null;
}

/**
 * 一次性完成「读仓库 → 建索引」，返回共享实例。
 * 编辑器侧调用它保证索引与当前仓库一致；设置页调用它拿统计。
 */
export async function indexVaultIntoShared(
  vault: VaultLike,
  settings: KnowledgeSettings,
  options: LoadOptions = {},
): Promise<KnowledgeBase> {
  const base = sharedKnowledgeBase(settings);
  const docs = await loadSourceDocs(vault, options);
  base.rebuild(docs);
  return base;
}

export default { loadSourceDocs, sharedKnowledgeBase, resetSharedKnowledgeBase, indexVaultIntoShared };
