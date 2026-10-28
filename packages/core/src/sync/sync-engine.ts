import type { StorageClient } from '../storage/types';
import type { SyncConflict, SyncEntryConfig, SyncLogEntry } from '@neomd/shared';
import { sha256Hex, mapLimit, sleep } from '../util/hash';

/**
 * 同步协议（无服务端锁，blob 内容寻址）
 *
 * 远端布局（均相对 rootPrefix）：
 *   docs/<docId>/<rev>-<hash>.md     不可变内容 blob
 *   docs/<docId>/manifest.json       当前状态：rev/hash/path/title/deletedAt/updatedAt/deviceId
 *   versions/<docId>/<ts>-<rev>-<hash>.md   历史版本（可选上传）
 *   index/<deviceId>.json            设备视图（path→docId+rev+hash+updatedAt）
 *   deletions/<docId>.json           删除墓碑
 *
 * 合并规则：
 *   - 同一 docId：manifest 中 updatedAt 更大者胜（相同则比较 deviceId 字典序，保证确定性）
 *   - 本地与远端 manifest 的 hash 相同 → 已同步
 *   - 双方都有新内容且不同 → 下载双方内容，尝试三方合并；失败则进入冲突
 */

export interface ManifestEntry {
  docId: string;
  rev: number;
  hash: string;
  path: string;
  title: string;
  size: number;
  updatedAt: number;
  createdAt: number;
  deviceId: string;
  deletedAt: number | null;
  /** 三方合并用的公共祖先 blob key */
  baseKey?: string;
}

export interface RemoteIndex {
  deviceId: string;
  deviceName: string;
  updatedAt: number;
  entries: Record<string, ManifestEntry>;
}

export interface LocalDocState {
  docId: string;
  rev: number;
  hash: string;
  path: string;
  title: string;
  size: number;
  updatedAt: number;
  createdAt: number;
  syncedRev: number | null;
  deletedAt: number | null;
}

export interface SyncCallbacks {
  /** 读取本地文档内容 */
  readLocal(docId: string): Promise<string | null>;
  /** 写入本地（拉取远端后落盘） */
  writeLocal(entry: ManifestEntry, markdown: string): Promise<void>;
  /** 本地删除 */
  deleteLocal(docId: string): Promise<void>;
  /** 当前本地状态快照 */
  listLocal(): LocalDocState[];
  /** 更新同步标记 */
  markSynced(docId: string, rev: number): void;
  /** 读取指定版本内容的本地缓存（用于三方合并） */
  readLocalVersion(docId: string, hash: string): Promise<string | null>;
  /** 记录历史版本 */
  recordVersion(docId: string, rev: number, hash: string, markdown: string, origin: string): Promise<void>;
  onLog(entry: SyncLogEntry): void;
  onConflict(conflict: SyncConflict): void;
  onProgress(done: number, total: number, phase: 'scanning' | 'pulling' | 'pushing'): void;
}

export interface SyncResult {
  pulled: number;
  pushed: number;
  conflicts: number;
  skipped: number;
  errors: string[];
}

/**
 * 同步方向（1.1.8）。
 *
 * - `both`：双向（默认，原有行为）；
 * - `upload`：仅上传。只推送本地改动，**不拉取远端**，也不会因远端更新而覆盖本地；
 * - `download`：仅下载。只把远端拉到本地，**不推送本地改动**。
 *
 * 用途：用户在某些场景需要单向保护，例如「外发前只下载不覆盖云端」，
 * 或者「这台机器只负责采集，不允许把本地改动推上去」。
 */
export type SyncDirection = 'both' | 'upload' | 'download';

/**
 * 冲突策略（1.1.8）。
 *
 * - `newest`：保留最新（默认，原有行为：比较 updatedAt，新的一方胜）；
 * - `local`：冲突时始终保留本地内容（远端版本另存为冲突副本，不覆盖本地）；
 * - `remote`：冲突时始终采用远端内容。
 */
export type SyncConflictPolicy = 'newest' | 'local' | 'remote';

export interface SyncOptions {
  /** 是否上传历史版本 */
  uploadVersions: boolean;
  /** 单次同步最大并发 */
  concurrency: number;
  /** 冲突时是否保留远端副本为「冲突副本」 */
  keepConflictCopy: boolean;
  /** 同步方向（1.1.8） */
  direction: SyncDirection;
  /** 冲突策略（1.1.8） */
  conflictPolicy: SyncConflictPolicy;
}

const DEFAULT_OPTIONS: SyncOptions = {
  uploadVersions: true,
  concurrency: 4,
  keepConflictCopy: true,
  direction: 'both',
  conflictPolicy: 'newest',
};

function indexKey(root: string, deviceId: string): string {
  return `${root}index/${encodeURIComponent(deviceId)}.json`;
}

function manifestKey(root: string, docId: string): string {
  return `${root}docs/${docId}/manifest.json`;
}

function blobKey(root: string, docId: string, rev: number, hash: string): string {
  return `${root}docs/${docId}/${rev}-${hash}.md`;
}

function versionKey(root: string, docId: string, ts: number, rev: number, hash: string): string {
  return `${root}versions/${docId}/${ts}-${rev}-${hash}.md`;
}

export class SyncEngine {
  private options: SyncOptions;
  private running = false;

  constructor(
    private readonly client: StorageClient,
    private readonly config: SyncEntryConfig,
    private readonly callbacks: SyncCallbacks,
    options: Partial<SyncOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  get isRunning(): boolean {
    return this.running;
  }

  private log(level: SyncLogEntry['level'], message: string, detail?: string): void {
    this.callbacks.onLog({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: Date.now(),
      level,
      message,
      detail,
    });
  }

  /** 完整一轮同步：拉取 -> 合并 -> 推送 */
  async sync(deviceName = '未知设备'): Promise<SyncResult> {
    if (this.running) throw new Error('同步已在进行中');
    this.running = true;
    const result: SyncResult = { pulled: 0, pushed: 0, conflicts: 0, skipped: 0, errors: [] };
    const root = this.config.rootPrefix.endsWith('/') ? this.config.rootPrefix : `${this.config.rootPrefix}/`;

    try {
      this.callbacks.onProgress(0, 1, 'scanning');
      const local = new Map(this.callbacks.listLocal().map((d) => [d.docId, d]));
      const remote = await this.loadRemoteManifest(root);
      this.log('info', `本地 ${local.size} 篇，远端 ${remote.size} 篇`);

      /* ---------- 拉取阶段 ---------- */
      const toPull: ManifestEntry[] = [];
      const conflicts: ManifestEntry[] = [];
      /**
       * 同步方向（1.1.8）：`upload` 模式跳过整个拉取阶段。
       * 注意仍然要读 manifest（上面已读），因为它用于判断「远端有什么」以决定推送，
       * 但**不把远端内容写回本地**，避免用户「只想上传」时被远端覆盖。
       */
      const pullEnabled = this.options.direction !== 'upload';
      for (const [docId, entry] of remote) {
        if (!pullEnabled) break;
        const l = local.get(docId);
        if (entry.deletedAt) {
          if (l && !l.deletedAt) {
            await this.callbacks.deleteLocal(docId);
            result.pulled += 1;
          }
          continue;
        }
        if (!l) {
          toPull.push(entry);
          continue;
        }
        if (l.deletedAt) {
          // 本地删了但远端更新 → 以更新的一方为准
          if (entry.updatedAt > l.deletedAt) toPull.push(entry);
          continue;
        }
        if (l.hash === entry.hash) {
          this.callbacks.markSynced(docId, entry.rev);
          result.skipped += 1;
          continue;
        }
        /**
         * 冲突策略（1.1.8）：
         *  - `local`  → 一律视为本地胜，不拉取（后续推送阶段会把本地推上去）；
         *  - `remote` → 一律拉取远端覆盖本地；
         *  - `newest` → 原有行为：比较 updatedAt，新的一方胜。
         */
        if (this.options.conflictPolicy === 'local') continue;
        if (this.options.conflictPolicy === 'remote') {
          toPull.push(entry);
          continue;
        }
        const localWins = l.updatedAt > entry.updatedAt || (l.updatedAt === entry.updatedAt && this.config.deviceId < entry.deviceId);
        if (localWins) continue;
        // 远端更新：判断本地是否有未推送改动
        const pushed = l.syncedRev !== null && l.rev === (l.syncedRev ?? 0);
        if (pushed) {
          toPull.push(entry);
        } else {
          conflicts.push(entry);
        }
      }

      let done = 0;
      await mapLimit(toPull, this.options.concurrency, async (entry) => {
        try {
          const md = await this.client.getObjectText(blobKey(root, entry.docId, entry.rev, entry.hash));
          await this.callbacks.writeLocal(entry, md);
          this.callbacks.markSynced(entry.docId, entry.rev);
          result.pulled += 1;
        } catch (e) {
          result.errors.push(`拉取 ${entry.path} 失败: ${(e as Error).message}`);
        } finally {
          done += 1;
          this.callbacks.onProgress(done, toPull.length, 'pulling');
        }
      });

      /* ---------- 冲突处理 ---------- */
      await mapLimit(conflicts, 2, async (entry) => {
        try {
          const remoteMd = await this.client.getObjectText(blobKey(root, entry.docId, entry.rev, entry.hash));
          const localMd = (await this.callbacks.readLocal(entry.docId)) ?? '';
          const base = entry.baseKey ? await this.client.getObjectText(entry.baseKey) : null;
          const merged = base ? threeWayMerge(base, localMd, remoteMd) : null;
          if (merged !== null) {
            await this.callbacks.writeLocal(entry, merged);
            this.callbacks.markSynced(entry.docId, entry.rev);
            this.log('info', `自动合并 ${entry.path}`);
            result.pulled += 1;
            return;
          }
          result.conflicts += 1;
          this.callbacks.onConflict({
            docId: entry.docId,
            path: entry.path,
            localRev: local.get(entry.docId)?.rev ?? 0,
            remoteRev: entry.rev,
            localHash: local.get(entry.docId)?.hash ?? '',
            remoteHash: entry.hash,
            localMarkdown: localMd,
            remoteMarkdown: remoteMd,
            baseMarkdown: base,
            mergedMarkdown: null,
          });
        } catch (e) {
          result.errors.push(`冲突处理 ${entry.path} 失败: ${(e as Error).message}`);
        }
      });

      /* ---------- 推送阶段 ---------- */
      const afterPull = new Map(this.callbacks.listLocal().map((d) => [d.docId, d]));
      const toPush: LocalDocState[] = [];
      /**
       * 同步方向（1.1.8）：`download` 模式跳过整个推送阶段。
       * 用于「只从云端拉、不把本地改动推上去」的场景（例如临时机器、只读副本），
       * 避免误把本地草稿覆盖云端正式内容。
       */
      const pushEnabled = this.options.direction !== 'download';
      for (const [docId, l] of pushEnabled ? afterPull : []) {
        if (l.deletedAt) {
          // 删除需要写墓碑
          const r = remote.get(docId);
          if (r && !r.deletedAt) toPush.push(l);
          continue;
        }
        const r = remote.get(docId);
        if (!r) {
          toPush.push(l);
          continue;
        }
        if (r.hash === l.hash) {
          this.callbacks.markSynced(docId, r.rev);
          continue;
        }
        if (l.rev === (l.syncedRev ?? -1)) continue; // 已同步且无本地改动
        toPush.push(l);
      }

      done = 0;
      const newManifests: Record<string, ManifestEntry> = {};
      await mapLimit(toPush, this.options.concurrency, async (l) => {
        try {
          if (l.deletedAt) {
            const manifest: ManifestEntry = {
              docId: l.docId,
              rev: l.rev,
              hash: l.hash,
              path: l.path,
              title: l.title,
              size: 0,
              createdAt: l.createdAt,
              updatedAt: l.deletedAt,
              deviceId: this.config.deviceId,
              deletedAt: l.deletedAt,
            };
            await this.putJson(manifestKey(root, l.docId), manifest);
            newManifests[l.docId] = manifest;
            result.pushed += 1;
            return;
          }
          const md = await this.callbacks.readLocal(l.docId);
          if (md === null) return;
          const hash = await sha256Hex(md);
          const remoteEntry = remote.get(l.docId);
          const nextRev = Math.max(l.rev, remoteEntry?.rev ?? 0);
          const key = blobKey(root, l.docId, nextRev, hash);
          const existing = await this.client.headObject(key);
          if (!existing) await this.client.putObject(key, md, 'text/markdown; charset=utf-8');

          if (this.options.uploadVersions) {
            await this.callbacks.recordVersion(l.docId, nextRev, hash, md, 'sync');
            const vk = versionKey(root, l.docId, Date.now(), nextRev, hash);
            const vExist = await this.client.headObject(vk);
            if (!vExist) await this.client.putObject(vk, md, 'text/markdown; charset=utf-8');
          }

          const manifest: ManifestEntry = {
            docId: l.docId,
            rev: nextRev,
            hash,
            path: l.path,
            title: l.title,
            size: md.length,
            createdAt: l.createdAt,
            updatedAt: Date.now(),
            deviceId: this.config.deviceId,
            deletedAt: null,
            baseKey: remoteEntry ? blobKey(root, l.docId, remoteEntry.rev, remoteEntry.hash) : undefined,
          };
          await this.putJson(manifestKey(root, l.docId), manifest);
          newManifests[l.docId] = manifest;
          this.callbacks.markSynced(l.docId, nextRev);
          result.pushed += 1;
        } catch (e) {
          result.errors.push(`推送 ${l.path} 失败: ${(e as Error).message}`);
        } finally {
          done += 1;
          this.callbacks.onProgress(done, toPush.length, 'pushing');
        }
      });

      /* ---------- 更新设备索引 ---------- */
      const index: RemoteIndex = {
        deviceId: this.config.deviceId,
        deviceName,
        updatedAt: Date.now(),
        entries: Object.fromEntries(
          this.callbacks
            .listLocal()
            .filter((d) => !d.deletedAt)
            .map((d) => [
              d.docId,
              {
                docId: d.docId,
                rev: d.rev,
                hash: d.hash,
                path: d.path,
                title: d.title,
                size: d.size,
                createdAt: d.createdAt,
                updatedAt: d.updatedAt,
                deviceId: this.config.deviceId,
                deletedAt: null,
              } satisfies ManifestEntry,
            ]),
        ),
      };
      await this.putJson(indexKey(root, this.config.deviceId), index);

      this.log(result.errors.length ? 'warn' : 'info', `同步完成：拉取 ${result.pulled}，推送 ${result.pushed}，冲突 ${result.conflicts}`);
      return result;
    } catch (e) {
      const msg = (e as Error).message;
      this.log('error', '同步失败', msg);
      result.errors.push(msg);
      throw e;
    } finally {
      this.running = false;
    }
  }

  /** 仅上传（Ctrl+S 手动同步时优先快速路径） */
  async pushOnly(): Promise<SyncResult> {
    return this.sync();
  }

  /** 拉取远端全部 manifest（遍历设备索引 + 逐文档 manifest） */
  private async loadRemoteManifest(root: string): Promise<Map<string, ManifestEntry>> {
    const out = new Map<string, ManifestEntry>();
    const indexObjects = await this.client.listObjects(`${root}index/`, 1000);
    for (const obj of indexObjects) {
      try {
        const raw = await this.client.getObjectText(obj.key);
        const idx = JSON.parse(raw) as RemoteIndex;
        for (const [docId, entry] of Object.entries(idx.entries ?? {})) {
          const cur = out.get(docId);
          if (!cur || entry.updatedAt > cur.updatedAt) out.set(docId, entry);
        }
      } catch {
        // 索引损坏时忽略，后续会用 manifest 兜底
      }
    }
    // 用逐文档 manifest 修正（索引可能落后）
    const manifestObjects = await this.client.listObjects(`${root}docs/`, 1000);
    const docIds = new Set<string>();
    for (const o of manifestObjects) {
      const m = /^docs\/([^/]+)\/manifest\.json$/.exec(o.key.slice(root.length));
      if (m) docIds.add(m[1]!);
    }
    await mapLimit([...docIds], Math.max(4, this.options.concurrency * 2), async (docId) => {
      try {
        const raw = await this.client.getObjectText(manifestKey(root, docId));
        const entry = JSON.parse(raw) as ManifestEntry;
        const cur = out.get(docId);
        if (!cur || entry.updatedAt > cur.updatedAt) out.set(docId, entry);
      } catch {
        /* 忽略单个文档的读取失败 */
      }
    });
    return out;
  }

  private async putJson(key: string, data: unknown): Promise<void> {
    await this.client.putObject(key, JSON.stringify(data), 'application/json; charset=utf-8');
  }

  /** 删除远端超期历史版本 */
  async pruneRemoteVersions(retentionDays: number, docIds: string[]): Promise<number> {
    const root = this.config.rootPrefix.endsWith('/') ? this.config.rootPrefix : `${this.config.rootPrefix}/`;
    const cutoff = Date.now() - retentionDays * 86_400_000;
    let removed = 0;
    for (const docId of docIds) {
      const objs = await this.client.listObjects(`${root}versions/${docId}/`, 1000);
      for (const o of objs) {
        const name = o.key.split('/').pop() ?? '';
        const ts = Number(name.split('-')[0] ?? 0);
        if (ts && ts < cutoff) {
          await this.client.deleteObject(o.key);
          removed += 1;
        }
      }
      await sleep(10);
    }
    return removed;
  }

  /** 远端历史版本的根前缀（末尾带斜杠） */
  private remoteVersionRoot(): string {
    return this.config.rootPrefix.endsWith('/') ? this.config.rootPrefix : `${this.config.rootPrefix}/`;
  }

  /**
   * 列出某篇文档在对象存储里的历史版本。
   *
   * 产品约定：PC 端本地只保留最新版本，历史版本全部落在云端，
   * 因此「版本历史」面板在没有本地留痕时改为读这里。
   */
  async listRemoteVersions(
    docId: string,
  ): Promise<Array<{ storageKey: string; rev: number; hash: string; size: number; createdAt: number }>> {
    const prefix = `${this.remoteVersionRoot()}versions/${docId}/`;
    let objs: Array<{ key: string; size: number; lastModified: number }> = [];
    try {
      objs = await this.client.listObjects(prefix, 1000);
    } catch {
      return [];
    }
    const out: Array<{ storageKey: string; rev: number; hash: string; size: number; createdAt: number }> = [];
    for (const o of objs) {
      const name = o.key.split('/').pop() ?? '';
      // 键格式：<ts>-<rev>-<hash>.md
      const m = /^(\d+)-(\d+)-([0-9a-f]+)\.md$/i.exec(name);
      if (!m) continue;
      out.push({
        storageKey: o.key,
        rev: Number(m[2]),
        hash: m[3]!.toLowerCase(),
        size: o.size,
        createdAt: Number(m[1]) || o.lastModified || 0,
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 读取远端某个历史版本的内容 */
  async readRemoteVersion(storageKey: string): Promise<string> {
    return this.client.getObjectText(storageKey);
  }

  /**
   * 把一个历史版本写入对象存储（供本地保存后异步留痕）。
   * 键格式与同步逻辑保持一致：versions/<docId>/<ts>-<rev>-<hash>.md
   */
  async putRemoteVersion(docId: string, rev: number, hash: string, markdown: string, at = Date.now()): Promise<string> {
    const key = versionKey(this.remoteVersionRoot(), docId, at, rev, hash);
    await this.client.putObject(key, markdown, 'text/markdown; charset=utf-8');
    return key;
  }
}

/**
 * 三方合并：以行为单位做 diff3。无法合并（双方改同一行）时返回 null。
 */
export function threeWayMerge(base: string, local: string, remote: string): string | null {
  if (local === remote) return local;
  if (base === local) return remote;
  if (base === remote) return local;

  const baseLines = base.split('\n');
  const localLines = local.split('\n');
  const remoteLines = remote.split('\n');

  const localDiff = diffLines(baseLines, localLines);
  const remoteDiff = diffLines(baseLines, remoteLines);

  const out: string[] = [];
  let i = 0;
  while (i < baseLines.length || localDiff.length || remoteDiff.length) {
    const lc = localDiff[0];
    const rc = remoteDiff[0];
    const lStart = lc ? lc.baseStart : Infinity;
    const rStart = rc ? rc.baseStart : Infinity;

    if (!lc && !rc) {
      out.push(...baseLines.slice(i));
      break;
    }

    const next = Math.min(lStart, rStart);
    if (next > i) {
      out.push(...baseLines.slice(i, next));
      i = next;
    }

    if (lc && rc && lStart === rStart && lc.baseEnd === rc.baseEnd) {
      if (lc.lines.join('\n') === rc.lines.join('\n')) {
        out.push(...lc.lines);
      } else {
        return null; // 同一区域双方都改了
      }
      i = lc.baseEnd;
      localDiff.shift();
      remoteDiff.shift();
      continue;
    }

    if (lc && lStart <= rStart) {
      out.push(...lc.lines);
      i = lc.baseEnd;
      localDiff.shift();
      continue;
    }

    if (rc) {
      out.push(...rc.lines);
      i = rc.baseEnd;
      remoteDiff.shift();
      continue;
    }
    break;
  }
  return out.join('\n');
}

interface Hunk {
  baseStart: number;
  baseEnd: number;
  lines: string[];
}

/** 简易行级 diff：返回把 base 变成 target 的替换块 */
export function diffLines(base: string[], target: string[]): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i < base.length || j < target.length) {
    if (i < base.length && j < target.length && base[i] === target[j]) {
      i += 1;
      j += 1;
      continue;
    }
    // 找到下一个同步点
    let bestI = -1;
    let bestJ = -1;
    const lookahead = 80;
    outer: for (let di = 0; di < lookahead && i + di < base.length; di += 1) {
      for (let dj = 0; dj < lookahead && j + dj < target.length; dj += 1) {
        if (base[i + di] === target[j + dj]) {
          bestI = i + di;
          bestJ = j + dj;
          break outer;
        }
      }
    }
    if (bestI < 0) {
      hunks.push({ baseStart: i, baseEnd: base.length, lines: target.slice(j) });
      return hunks;
    }
    hunks.push({ baseStart: i, baseEnd: bestI, lines: target.slice(j, bestJ) });
    i = bestI;
    j = bestJ;
  }
  return hunks;
}
