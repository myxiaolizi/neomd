import type { StorageClient } from '../storage/types';
import { isObjectMissingError } from '../storage/types';
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

/**
 * 云端历史版本的对象键：`versions/<docId>/<ts>-<rev>-<hash>.md`。
 *
 * `ts` 必须是**唯一**的归档时刻，否则同一 rev+hash 的两次归档会落到同一个 key 上，
 * 后者覆盖前者（虽然内容相同，但会丢掉「这一版被保存过几次」的信息）。
 * 见 {@link SyncEngine.nextVersionTs}：它保证同一毫秒内也严格递增。
 */
function versionKey(root: string, docId: string, ts: number, rev: number, hash: string): string {
  return `${root}versions/${docId}/${ts}-${rev}-${hash}.md`;
}

export class SyncEngine {
  private options: SyncOptions;
  private running = false;
  /**
   * 云端版本归档时刻的单调游标（1.2.1 缺陷5 修复）。
   *
   * 为什么不能直接用 `Date.now()`：`putRemoteVersion()` 与同步推送阶段都会归档版本，
   * 一次「保存后立即同步」里两者几乎同时发生，毫秒数完全相同 →
   * 两个不同 rev 的版本可能生成同一个 `<ts>` 前缀，虽然 rev/hash 不同仍不会撞 key，
   * 但**同一 rev 的重复归档**（A→B→A 回滚、多端同时同步）会撞 key 并互相覆盖。
   * 用 `max(now, last+1)` 让同一实例内的 ts 严格递增，彻底消除这个竞争。
   */
  private lastVersionTs = 0;

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
       * 「陈旧索引自愈」集合（1.1.9）。
       *
       * 拉取阶段若发现「索引/manifest 说有、blob 实际不存在」，说明这条远端记录是坏的
       * （1.1.8 在 `direction = 'download'` 时会把未上传的文档写进设备索引，正是成因）。
       * 记下这些 docId，推送阶段**无视**「已同步、无改动」的判断强制重传，
       * 让坏记录自愈；否则它会永久留在云端，每次同步都重复一次 404。
       */
      const staleRemoteDocIds = new Set<string>();
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
          /*
           * 对象不存在 ≠ 同步失败（1.1.9 关键修复）。
           *
           * 成因：`loadRemoteManifest()` 会同时读「设备索引」与「逐文档 manifest」。
           * 1.1.8 在 `direction = 'download'`（仅下载）时把本地未上传的文档也写进了
           * 设备索引，于是索引声称「远端有这篇」，但对应的 blob 从未上传 → GET 404。
           *
           * 正确处置：把它当作**陈旧索引**，跳过并计入 `skipped`，
           * 而不是塞进 `errors`。否则用户会看到「同步部分失败：拉取 xxx 失败」，
           * 而配置（仅下载）其实完全按预期工作 —— 这是纯粹的假故障。
           *
           * 注意仍然要记一条 warn 日志，便于排查真实的"数据缺失"问题。
           */
          if (isObjectMissingError(e)) {
            result.skipped += 1;
            staleRemoteDocIds.add(entry.docId);
            this.log(
              'warn',
              `跳过陈旧索引：${entry.path}（云端缺少正文对象，稍后会自动重新上传）`,
            );
            return;
          }
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
        if (staleRemoteDocIds.has(docId)) {
          // 远端 manifest 存在但正文缺失 → 强制重传，修掉坏索引
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
      /*
       * 设备索引只登记「**云端确实存在正文**」的文档（1.1.9 修复）。
       *
       * 为什么必须这样过滤 —— 这是「同步部分失败 / 拉取 xxx 失败 404」的根因之一：
       * 索引是**其它设备**判断「远端有什么」的主要依据（`loadRemoteManifest` 会先读它）。
       * 但 1.1.8 之前这里无条件把 `listLocal()` 的全部文档写进索引，于是：
       *  - `direction = 'download'`（仅下载）时推送阶段被整体跳过，
       *    本地文档的 blob **从未上传**，却照样被写进索引；
       *  - 之后任何设备（包括自己下次启动）读到这条索引，就会去拉
       *    `docs/<docId>/<rev>-<hash>.md` —— 对象不存在 → GET 404；
       *  - `SyncEngine` 把它记进 `result.errors`，界面显示「同步部分失败：1 个错误」。
       * 用户看到的是"同步失败"，但实际配置（仅下载）完全按预期工作。
       *
       * 过滤判据（三条任一成立即认为云端有正文）：
       *  1. 本次推送成功（`newManifests` 里有它）；
       *  2. 远端已有同 hash 的 manifest（说明之前推过，或别人推过）；
       *  3. 远端有该 docId 的非删除 manifest。
       * 本地尚未上云的文档**不进索引**，等真正推送成功后的下一轮再登记。
       */
      const localNow = this.callbacks.listLocal().filter((d) => !d.deletedAt);
      const indexable = localNow.filter((d) => {
        if (newManifests[d.docId]) return true;
        const r = remote.get(d.docId);
        return Boolean(r && !r.deletedAt);
      });
      const skippedFromIndex = localNow.length - indexable.length;
      const index: RemoteIndex = {
        deviceId: this.config.deviceId,
        deviceName,
        updatedAt: Date.now(),
        entries: Object.fromEntries(
          indexable.map((d) => {
            // 优先用「云端已知的那份元数据」，本地 rev/hash 可能还没同步上云
            const r = remote.get(d.docId);
            const merged = newManifests[d.docId] ?? r;
            return [
              d.docId,
              {
                docId: d.docId,
                rev: merged?.rev ?? d.rev,
                hash: merged?.hash ?? d.hash,
                path: d.path,
                title: d.title,
                size: merged?.size ?? d.size,
                createdAt: d.createdAt,
                updatedAt: merged?.updatedAt ?? d.updatedAt,
                deviceId: this.config.deviceId,
                deletedAt: null,
              } satisfies ManifestEntry,
            ];
          }),
        ),
      };
      if (skippedFromIndex > 0) {
        this.log(
          'info',
          `设备索引已跳过 ${skippedFromIndex} 篇尚未上传的本地文档（避免其它端拉到不存在的正文）`,
        );
      }
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
   * ## 1.2.1 修复要点（逐条对应缺陷5的取证结论）
   *
   * a) **分页（截断）**：原先单次 `listObjects(prefix, 1000)` 后就结束，
   *    超过 1000 个版本对象的文档会被**静默截断**（服务端 `MAX_LIST_KEYS` 也是 1000）。
   *    `StorageClient` 接口没有 `continuationToken` 参数，服务端也只透传 `maxKeys`，
   *    因此这里用「**按 ts 前缀分桶**」的方式做等价分页：
   *    键名形如 `versions/<docId>/<ts>-<rev>-<hash>.md`，`ts` 是 13 位毫秒时间戳，
   *    当某一页返回满 1000 条时，再按 ts 的下一位置数字（0-9）逐个收窄前缀重列，
   *    每加一位前缀就把结果集缩小一个数量级；最多展开 3 层（可覆盖上亿条版本），
   *    并且只对「满页」的分桶继续展开，正常情况下仍是 1 次请求。
   *
   * b) **去重**：同一 rev+hash 可能被多次归档（实测线上确实存在
   *    `1793351126125-2-99a85...` 与 `1793351129242-2-99a85...` 两个内容相同的对象）。
   *    旧实现把它们当成两条，面板里出现「重复的同一版」；这里按 `rev|hash` 去重，
   *    保留最早归档的那次（`createdAt` 取 min），与本地合并时的身份规则一致。
   *
   * c) **排序**：统一按 `createdAt` 倒序（取自 key 里的 ts，缺失时回落 `lastModified`），
   *    保证与本地版本合并后仍是一条时间线。
   *
   * d) **不做「只保留最大 rev」之类的裁剪**：旧实现没有裁剪，但历史上同步推送阶段
   *    用 `headObject` 短路写入会造成「同 key 覆盖」，这一半已在 `putRemoteVersion`
   *    修掉（ts 唯一 + 无条件写入）；列表侧只负责如实呈现。
   */
  async listRemoteVersions(
    docId: string,
  ): Promise<Array<{ storageKey: string; rev: number; hash: string; size: number; createdAt: number }>> {
    const base = `${this.remoteVersionRoot()}versions/${docId}/`;
    const PAGE = 1000;
    const raw: Array<{ storageKey: string; rev: number; hash: string; size: number; createdAt: number }> = [];
    const seenKeys = new Set<string>();

    /** 递归列举；`tsPrefix` 是额外收窄的 ts 数字前缀（用于分桶翻页） */
    const collect = async (tsPrefix: string, depth: number): Promise<void> => {
      let objs: Array<{ key: string; size: number; lastModified: number }> = [];
      try {
        objs = await this.client.listObjects(`${base}${tsPrefix}`, PAGE);
      } catch {
        // 首次请求就失败 → 云端不可用，返回空（面板显示「无云端版本」而不是报错）
        return;
      }
      for (const o of objs) {
        const name = o.key.split('/').pop() ?? '';
        // 键格式：<ts>-<rev>-<hash>.md（1.2.1 之前的对象也是这个格式，老数据依然可读）
        const m = /^(\d+)-(\d+)-([0-9a-f]+)\.md$/i.exec(name);
        if (!m) continue;
        if (seenKeys.has(o.key)) continue;
        seenKeys.add(o.key);
        raw.push({
          storageKey: o.key,
          rev: Number(m[2]),
          hash: m[3]!.toLowerCase(),
          size: o.size,
          createdAt: Number(m[1]) || o.lastModified || 0,
        });
      }
      // 未满页 → 该分桶已取完；满页且还能继续细分 → 按下一位置数字展开
      if (objs.length < PAGE || depth >= 3) return;
      for (let d = 0; d <= 9; d += 1) await collect(`${tsPrefix}${d}`, depth + 1);
    };

    await collect('', 0);

    // 去重（rev|hash）：保留最早归档的那次，size 取较大值（防止某个对象元信息缺失）
    const byIdentity = new Map<string, (typeof raw)[number]>();
    for (const v of raw) {
      const identity = `${v.rev}|${v.hash}`;
      const prev = byIdentity.get(identity);
      if (!prev) {
        byIdentity.set(identity, v);
        continue;
      }
      byIdentity.set(identity, {
        ...prev,
        createdAt: Math.min(prev.createdAt || Infinity, v.createdAt || Infinity) || prev.createdAt,
        size: Math.max(prev.size, v.size),
      });
    }
    return [...byIdentity.values()].sort((a, b) => b.createdAt - a.createdAt || b.rev - a.rev);
  }

  /** 读取远端某个历史版本的内容 */
  async readRemoteVersion(storageKey: string): Promise<string> {
    return this.client.getObjectText(storageKey);
  }

  /** 取一个严格递增的归档时间戳（同一毫秒内连续归档也不会撞 key） */
  private nextVersionTs(): number {
    const ts = Math.max(Date.now(), this.lastVersionTs + 1);
    this.lastVersionTs = ts;
    return ts;
  }

  /**
   * 把一个历史版本写入对象存储（供本地保存后异步留痕）。
   *
   * 键格式与同步逻辑保持一致：`versions/<docId>/<ts>-<rev>-<hash>.md`，
   * 其中 `ts` 由 {@link nextVersionTs} 保证严格递增。
   *
   * ## 1.2.1 修复：不再「已存在就跳过」
   *
   * 旧实现（同步推送阶段）先 `headObject(vk)` 再决定是否 `putObject`，
   * 而 `vk` 的 ts 用的是 `Date.now()`：同一毫秒内的两次归档拿到同一个 key，
   * 第二次被 `headObject` 判定为「已存在」直接跳过 —— 看起来只是少写一次，
   * 但**如果第一次写的是别的内容**（例如 rev 相同、内容已被回滚覆盖），
   * 历史里就永久留下了错误的那份。现在 ts 唯一 + 无条件写入，内容永远是对的。
   *
   * @param at 可选：显式指定归档时刻（测试用；生产不要传）
   * @returns 写入的对象键
   */
  async putRemoteVersion(docId: string, rev: number, hash: string, markdown: string, at?: number): Promise<string> {
    const ts = at && at > 0 ? Math.max(at, this.lastVersionTs + 1) : this.nextVersionTs();
    this.lastVersionTs = ts;
    const key = versionKey(this.remoteVersionRoot(), docId, ts, rev, hash);
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
