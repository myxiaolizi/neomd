import type { DocMeta, SyncSettings, SyncState, VersionEntry } from './types';
import { S3Client, S3Error } from './s3';
import { docStore, versionStore } from './db';
import type { VaultAdapter } from './adapters/types';
import { sha1, sanitizePathSegment, utf8ToBytes } from '../lib/util';

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface SyncHooks {
  onState?: (s: SyncState) => void;
  /** 远端拉取导致本地文档变化 */
  onDocChanged?: (path: string) => void;
}

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflicts: number;
  versionsPushed: number;
  versionsPulled: number;
  errors: string[];
  durationMs: number;
}

function joinKey(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

/** 版本文件在 S3 上的键 */
function versionKey(prefix: string, v: { id: string; path: string }): string {
  const safe = v.path
    .split('/')
    .map((s) => sanitizePathSegment(s.replace(/\.md$/i, '')))
    .join('/');
  return joinKey(prefix, 'versions', safe, `${v.id}.json`);
}

function docKey(prefix: string, path: string): string {
  return joinKey(prefix, 'notes', path);
}

function errMsg(e: unknown): string {
  if (e instanceof S3Error) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * 同步引擎：本地 ⇄ S3 双向同步。
 *
 * 目录约定
 *   <prefix>/notes/<相对路径>.md          笔记正文（与本地仓库同构）
 *   <prefix>/versions/<相对路径>/<id>.json 历史版本
 *   <prefix>/manifest.json                 仓库清单，便于快速比对
 */
export class SyncEngine {
  private client: S3Client | null = null;
  private running = false;
  private lastError = '';
  private lastSyncAt = 0;

  constructor(
    private settings: SyncSettings,
    private readonly hooks: SyncHooks = {},
  ) {
    this.rebuild();
  }

  private rebuild(): void {
    if (this.isConfigured()) {
      try {
        this.client = new S3Client(this.settings);
      } catch {
        this.client = null;
      }
    } else {
      this.client = null;
    }
  }

  updateSettings(s: SyncSettings): void {
    this.settings = s;
    this.rebuild();
  }

  isConfigured(): boolean {
    const s = this.settings;
    return !!(s.endpoint && s.bucket && s.accessKeyId && s.secretAccessKey);
  }

  get isRunning(): boolean {
    return this.running;
  }

  get error(): string {
    return this.lastError;
  }

  get syncedAt(): number {
    return this.lastSyncAt;
  }

  private emit(status: SyncState['status'], message: string): void {
    this.hooks.onState?.({
      status,
      message,
      lastSyncAt: this.lastSyncAt || undefined,
    });
  }

  /** 连接测试 */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    if (!this.isConfigured()) {
      return { ok: false, message: '请先填写 Endpoint、Bucket 与访问密钥' };
    }
    try {
      const client = new S3Client(this.settings);
      await client.test();
      return { ok: true, message: '连接成功，存储桶可访问' };
    } catch (e) {
      return { ok: false, message: errMsg(e) };
    }
  }

  /** 执行一次完整同步 */
  async sync(vault: VaultAdapter, opts: { force?: boolean } = {}): Promise<SyncResult> {
    const started = Date.now();
    const result: SyncResult = {
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      versionsPushed: 0,
      versionsPulled: 0,
      errors: [],
      durationMs: 0,
    };

    if (!opts.force && !this.settings.enabled) {
      this.emit('off', '同步未启用');
      return result;
    }
    if (this.running) {
      return result;
    }
    if (!this.isConfigured()) {
      this.lastError = 'S3 配置不完整';
      this.emit('error', this.lastError);
      result.errors.push(this.lastError);
      return result;
    }

    this.running = true;
    this.emit('syncing', '正在同步…');

    try {
      const client = new S3Client(this.settings);
      const prefix = this.settings.prefix.trim();

      // ---------- 1. 拉取远端清单 ----------
      const remoteDocs = await client.listAll(joinKey(prefix, 'notes') + '/');
      const remoteMap = new Map<string, { etag: string; size: number; lastModified: number }>();
      const notesPrefix = joinKey(prefix, 'notes') + '/';
      for (const obj of remoteDocs) {
        if (!obj.key.startsWith(notesPrefix)) continue;
        const rel = obj.key.slice(notesPrefix.length);
        if (!rel.toLowerCase().endsWith('.md')) continue;
        remoteMap.set(rel, { etag: obj.etag, size: obj.size, lastModified: obj.lastModified });
      }

      // ---------- 2. 本地清单 ----------
      const localAll = await docStore.allWithDeleted();
      const localDocs = localAll.filter((d) => !d.deleted);
      const tombstones = localAll.filter((d) => d.deleted);
      const localMap = new Map(localDocs.map((d) => [d.path, d]));

      // ---------- 3. 双向比对 ----------
      // 本地新增/修改 → 上传
      for (const doc of localDocs) {
        try {
          const remote = remoteMap.get(doc.path);
          const localChanged = !doc.syncedHash || doc.syncedHash !== doc.hash;

          if (!remote) {
            // 远端没有 → 上传
            const content = await vault.read(doc.path);
            const etag = await client.putText(docKey(prefix, doc.path), content);
            await docStore.put({
              ...doc,
              etag,
              syncedHash: doc.hash,
              syncedAt: Date.now(),
            });
            result.uploaded++;
            continue;
          }

          const remoteChanged = remote.etag !== (doc.etag ?? '');

          if (!localChanged && !remoteChanged) {
            // 两边都没变
            continue;
          }

          if (localChanged && !remoteChanged) {
            // 仅本地变化 → 上传
            const content = await vault.read(doc.path);
            const etag = await client.putText(docKey(prefix, doc.path), content);
            await docStore.put({
              ...doc,
              etag,
              syncedHash: doc.hash,
              syncedAt: Date.now(),
            });
            result.uploaded++;
            continue;
          }

          if (!localChanged && remoteChanged) {
            // 仅远端变化 → 下载
            const ok = await this.pullDoc(client, vault, prefix, doc.path, remote.etag, remote.lastModified);
            if (ok) result.downloaded++;
            continue;
          }

          // 双端都变 → 冲突处理
          const resolved = await this.resolveConflict(
            client, vault, prefix, doc, remote.etag, remote.lastModified,
          );
          if (resolved) result.conflicts++;
        } catch (e) {
          result.errors.push(`${doc.path}：${errMsg(e)}`);
        }
      }

      // 远端新增 → 下载
      for (const [rel, remote] of remoteMap) {
        if (localMap.has(rel)) continue;
        // 本地墓碑表明此文件已被删除，不再拉回
        if (tombstones.some((t) => t.path === rel)) continue;
        try {
          const ok = await this.pullDoc(client, vault, prefix, rel, remote.etag, remote.lastModified);
          if (ok) result.downloaded++;
        } catch (e) {
          result.errors.push(`${rel}：${errMsg(e)}`);
        }
      }

      // 本地删除 → 传播到远端
      for (const t of tombstones) {
        try {
          await client.remove(docKey(prefix, t.path));
          await docStore.remove(t.path);
          result.deleted++;
        } catch (e) {
          result.errors.push(`删除 ${t.path}：${errMsg(e)}`);
        }
      }

      // ---------- 4. 历史版本 ----------
      if (this.settings.syncVersions) {
        const v = await this.syncVersions(client, prefix);
        result.versionsPushed = v.pushed;
        result.versionsPulled = v.pulled;
        result.errors.push(...v.errors);
      }

      // ---------- 5. 清单 ----------
      await this.writeManifest(client, prefix, localDocs).catch(() => undefined);

      this.lastError = '';
      this.lastSyncAt = Date.now();
      result.durationMs = this.lastSyncAt - started;

      const summary = [
        result.uploaded ? `上传 ${result.uploaded}` : '',
        result.downloaded ? `下载 ${result.downloaded}` : '',
        result.conflicts ? `冲突 ${result.conflicts}` : '',
        result.deleted ? `删除 ${result.deleted}` : '',
      ]
        .filter(Boolean)
        .join(' · ');

      this.emit('ok', summary || '已是最新');
      return result;
    } catch (e) {
      this.lastError = errMsg(e);
      this.emit('error', this.lastError);
      result.errors.push(this.lastError);
      return result;
    } finally {
      this.running = false;
      result.durationMs = Date.now() - started;
    }
  }

  /** 拉取单个文档到本地 */
  private async pullDoc(
    client: S3Client,
    vault: VaultAdapter,
    prefix: string,
    path: string,
    etag: string,
    lastModified: number,
  ): Promise<boolean> {
    const text = await client.getText(docKey(prefix, path));
    if (text === null) return false;

    const hash = await sha1(text);
    const existing = await docStore.get(path);

    // 覆盖前留存旧内容
    if (existing && existing.hash !== hash) {
      const oldText = await vault.read(path).catch(() => null);
      if (oldText !== null && oldText !== text) {
        await versionStore.put({
          id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          path,
          ts: Date.now(),
          hash: existing.hash,
          size: enc.encode(oldText).length,
          reason: 'sync',
          content: oldText,
          synced: false,
          syncedFlag: 0,
        });
        await versionStore.prune(path, this.settings.syncVersions ? 200 : 80);
      }
    }

    // 确保目录存在
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (dir) await vault.ensureDir(dir);

    await vault.write(path, text);

    const bytes = utf8ToBytes(text);
    const meta: DocMeta = {
      path,
      title: (path.split('/').pop() ?? path).replace(/\.md$/i, ''),
      hash,
      size: bytes.length,
      chars: text.length,
      created: existing?.created ?? (lastModified || Date.now()),
      modified: lastModified || Date.now(),
      excerpt: text.slice(0, 120),
      etag,
      syncedHash: hash,
      syncedAt: Date.now(),
    };
    await docStore.put(meta);
    this.hooks.onDocChanged?.(path);
    return true;
  }

  /**
   * 冲突处理：两端都改过。
   * 策略：把远端版本另存为「-冲突-时间戳」副本，本地版本保持并上传，绝不静默丢数据。
   */
  private async resolveConflict(
    client: S3Client,
    vault: VaultAdapter,
    prefix: string,
    doc: DocMeta,
    remoteEtag: string,
    remoteModified: number,
  ): Promise<boolean> {
    const remoteText = await client.getText(docKey(prefix, doc.path));
    if (remoteText === null) return false;

    const base = doc.path.replace(/\.md$/i, '');
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp =
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `${pad(d.getHours())}${pad(d.getMinutes())}`;

    let conflictPath = `${base}-冲突-${stamp}.md`;
    let n = 1;
    while (await vault.exists(conflictPath)) {
      conflictPath = `${base}-冲突-${stamp}-${n}.md`;
      n++;
    }

    await vault.write(conflictPath, remoteText);
    const cHash = await sha1(remoteText);
    const cBytes = utf8ToBytes(remoteText);

    await docStore.put({
      path: conflictPath,
      title: (conflictPath.split('/').pop() ?? conflictPath).replace(/\.md$/i, ''),
      hash: cHash,
      size: cBytes.length,
      chars: remoteText.length,
      created: remoteModified || Date.now(),
      modified: remoteModified || Date.now(),
      excerpt: remoteText.slice(0, 120),
    });

    // 本地版本继续上传，成为新的远端状态
    const localText = await vault.read(doc.path);
    const etag = await client.putText(docKey(prefix, doc.path), localText);
    await docStore.put({
      ...doc,
      etag,
      syncedHash: doc.hash,
      syncedAt: Date.now(),
    });

    this.hooks.onDocChanged?.(conflictPath);
    return true;
  }

  /** 历史版本双向同步 */
  private async syncVersions(
    client: S3Client,
    prefix: string,
  ): Promise<{ pushed: number; pulled: number; errors: string[] }> {
    let pushed = 0;
    let pulled = 0;
    const errors: string[] = [];

    // 推送本地未同步版本
    const pending = await versionStore.unsynced();
    for (const v of pending) {
      try {
        const payload = JSON.stringify({
          id: v.id,
          path: v.path,
          ts: v.ts,
          hash: v.hash,
          size: v.size,
          reason: v.reason,
          content: v.content,
        });
        await client.putText(versionKey(prefix, v), payload, 'application/json');
        await versionStore.put({ ...v, synced: true, syncedFlag: 1 });
        pushed++;
      } catch (e) {
        errors.push(`版本 ${v.id}：${errMsg(e)}`);
      }
    }

    // 拉取远端版本
    try {
      const remote = await client.listAll(joinKey(prefix, 'versions') + '/');
      const local = new Set((await versionStore.all()).map((v) => v.id));

      for (const obj of remote) {
        if (!obj.key.endsWith('.json')) continue;
        const m = /\/([^/]+)\.json$/.exec(obj.key);
        if (!m) continue;
        const id = m[1];
        if (local.has(id)) continue;

        const text = await client.getText(obj.key);
        if (!text) continue;
        try {
          const parsed = JSON.parse(text) as {
            id?: string; path?: string; ts?: number; hash?: string;
            size?: number; reason?: VersionEntry['reason']; content?: string;
          };
          if (!parsed.path || typeof parsed.content !== 'string') continue;
          await versionStore.put({
            id: parsed.id ?? id,
            path: parsed.path,
            ts: parsed.ts ?? Date.now(),
            hash: parsed.hash ?? '',
            size: parsed.size ?? parsed.content.length,
            reason: parsed.reason ?? 'sync',
            content: parsed.content,
            synced: true,
            syncedFlag: 1,
          });
          pulled++;
        } catch {
          /* 跳过损坏条目 */
        }
      }
    } catch (e) {
      errors.push(`拉取版本：${errMsg(e)}`);
    }

    return { pushed, pulled, errors };
  }

  /** 写入仓库清单 */
  private async writeManifest(client: S3Client, prefix: string, docs: DocMeta[]): Promise<void> {
    const manifest = {
      app: 'mdnote',
      version: 1,
      updatedAt: Date.now(),
      count: docs.length,
      docs: docs.map((d) => ({
        path: d.path,
        hash: d.hash,
        modified: d.modified,
        size: d.size,
      })),
    };
    await client.putText(
      joinKey(prefix, 'manifest.json'),
      JSON.stringify(manifest),
      'application/json',
    );
  }
}

export { enc, dec };
