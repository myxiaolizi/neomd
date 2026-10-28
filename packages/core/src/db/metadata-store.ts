import type { DocMeta, VersionRecord } from '@neomd/shared';
import type { DbFileRow, DbLinkRow, DbPropRow, DbTagRow, IndexStats } from './types';
import { parseDoc } from '../vault/markdown-parse';

/**
 * 元数据库：基于 sql.js（WASM SQLite），三端行为一致且无需原生编译。
 * 持久化策略：追加写 oplog.jsonl + 定期导出 index.sqlite 快照。
 * 启动时优先加载快照，再回放 oplog 中更新的部分。
 */

export interface SqlDatabase {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  doc_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  hash TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  synced_rev INTEGER,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_files_updated ON files(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(deleted_at);

CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  origin TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  synced INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_versions_doc ON versions(doc_id, created_at DESC);

CREATE TABLE IF NOT EXISTS links (
  src_doc_id TEXT NOT NULL,
  dst_name TEXT NOT NULL,
  dst_doc_id TEXT,
  anchor TEXT NOT NULL DEFAULT '',
  alias TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'wikilink'
);
CREATE INDEX IF NOT EXISTS idx_links_src ON links(src_doc_id);
CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst_name);

CREATE TABLE IF NOT EXISTS tags (
  doc_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (doc_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

CREATE TABLE IF NOT EXISTS props (
  doc_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'text',
  PRIMARY KEY (doc_id, key)
);
CREATE INDEX IF NOT EXISTS idx_props_key ON props(key);

CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  doc_id TEXT,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '默认',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function jsonSafe(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export class MetadataStore {
  private db: SqlDatabase;
  private dirty = 0;
  private readonly dirtyThreshold = 200;
  private closed = false;

  constructor(db: SqlDatabase) {
    this.db = db;
    this.db.run(SCHEMA);
  }

  /* ---------------- 文件 ---------------- */

  upsertFile(meta: DocMeta): void {
    const title = meta.title;
    this.db.run(
      `INSERT INTO files (doc_id, path, title, rev, hash, size, created_at, updated_at, synced_rev, deleted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(doc_id) DO UPDATE SET
         path=excluded.path, title=excluded.title, rev=excluded.rev, hash=excluded.hash,
         size=excluded.size, updated_at=excluded.updated_at, synced_rev=excluded.synced_rev,
         deleted_at=excluded.deleted_at`,
      [
        meta.docId,
        meta.path,
        title,
        meta.rev,
        meta.hash,
        meta.size,
        meta.createdAt,
        meta.updatedAt,
        meta.syncedRev,
        meta.deletedAt,
      ],
    );
    this.touch();
  }

  /** 路径变化但 docId 不变（重命名/移动） */
  updatePath(docId: string, path: string, title: string): void {
    this.db.run('UPDATE files SET path=?, title=?, updated_at=? WHERE doc_id=?', [path, title, Date.now(), docId]);
    this.touch();
  }

  markDeleted(docId: string, deletedAt = Date.now()): void {
    this.db.run('UPDATE files SET deleted_at=?, updated_at=? WHERE doc_id=?', [deletedAt, deletedAt, docId]);
    this.touch();
  }

  getFile(docId: string): DbFileRow | null {
    const res = this.db.exec('SELECT * FROM files WHERE doc_id=?', [docId]);
    const row = res[0]?.values[0];
    if (!row) return null;
    return this.rowToFile(row, res[0]!.columns);
  }

  getFileByPath(path: string): DbFileRow | null {
    const res = this.db.exec('SELECT * FROM files WHERE path=?', [path]);
    const row = res[0]?.values[0];
    if (!row) return null;
    return this.rowToFile(row, res[0]!.columns);
  }

  listFiles(includeDeleted = false): DbFileRow[] {
    const res = this.db.exec(
      `SELECT * FROM files ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'} ORDER BY path`,
    );
    if (!res[0]) return [];
    return res[0].values.map((r) => this.rowToFile(r, res[0]!.columns));
  }

  countFiles(): number {
    const res = this.db.exec('SELECT COUNT(*) FROM files WHERE deleted_at IS NULL');
    const v = res[0]?.values[0]?.[0];
    return typeof v === 'number' ? v : 0;
  }

  private rowToFile(row: unknown[], columns: string[]): DbFileRow {
    const get = (name: string): unknown => row[columns.indexOf(name)];
    return {
      doc_id: String(get('doc_id') ?? ''),
      path: String(get('path') ?? ''),
      title: String(get('title') ?? ''),
      rev: Number(get('rev') ?? 1),
      hash: String(get('hash') ?? ''),
      size: Number(get('size') ?? 0),
      created_at: Number(get('created_at') ?? 0),
      updated_at: Number(get('updated_at') ?? 0),
      synced_rev: get('synced_rev') === null || get('synced_rev') === undefined ? null : Number(get('synced_rev')),
      deleted_at: get('deleted_at') === null || get('deleted_at') === undefined ? null : Number(get('deleted_at')),
    };
  }

  /* ---------------- 索引内容 ---------------- */

  /** 重新解析并写入单篇文档的标题/链接/标签/属性 */
  indexContent(docId: string, markdown: string): void {
    const parsed = parseDoc(markdown);
    this.db.run('DELETE FROM links WHERE src_doc_id=?', [docId]);
    this.db.run('DELETE FROM tags WHERE doc_id=?', [docId]);
    this.db.run('DELETE FROM props WHERE doc_id=?', [docId]);

    for (const link of parsed.links) {
      if (link.kind === 'markdown') {
        if (link.target.startsWith('http') || link.target.startsWith('mailto:')) continue;
      }
      this.db.run('INSERT INTO links (src_doc_id, dst_name, dst_doc_id, anchor, alias, kind) VALUES (?,?,?,?,?,?)', [
        docId,
        link.target,
        null,
        link.anchor,
        link.alias,
        link.kind,
      ]);
    }
    for (const tag of parsed.tags) {
      this.db.run('INSERT OR REPLACE INTO tags (doc_id, tag, count) VALUES (?,?,?)', [docId, tag, 1]);
    }
    if (parsed.frontmatter) {
      for (const [key, value] of Object.entries(parsed.frontmatter.data)) {
        if (key === 'title' || key === 'tags') continue;
        this.db.run('INSERT OR REPLACE INTO props (doc_id, key, value, kind) VALUES (?,?,?,?)', [
          docId,
          key,
          jsonSafe(value),
          Array.isArray(value) ? 'list' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text',
        ]);
      }
    }
    this.touch();
  }

  /** 用当前文件表回填 dst_doc_id（重命名后也需重跑） */
  resolveLinks(): void {
    this.db.run(
      `UPDATE links SET dst_doc_id = (
         SELECT f.doc_id FROM files f
         WHERE f.deleted_at IS NULL AND (
           f.path = links.dst_name || '.md' OR
           f.title = links.dst_name OR
           f.path LIKE '%' || links.dst_name || '.md'
         ) LIMIT 1
       )`,
    );
    this.touch();
  }

  backlinks(docId: string): DbFileRow[] {
    const res = this.db.exec(
      `SELECT DISTINCT f.* FROM links l JOIN files f ON f.doc_id = l.src_doc_id
       WHERE l.dst_doc_id = ? AND f.deleted_at IS NULL ORDER BY f.updated_at DESC`,
      [docId],
    );
    if (!res[0]) return [];
    return res[0].values.map((r) => this.rowToFile(r, res[0]!.columns));
  }

  /** 提及了标题但未建立有效链接的文档 */
  unlinkedMentions(docId: string, title: string): DbFileRow[] {
    const linked = new Set(this.backlinks(docId).map((f) => f.doc_id));
    const res = this.db.exec(
      `SELECT DISTINCT f.* FROM links l JOIN files f ON f.doc_id = l.src_doc_id
       WHERE l.dst_name = ? AND f.deleted_at IS NULL AND l.src_doc_id <> ?`,
      [title, docId],
    );
    if (!res[0]) return [];
    return res[0].values
      .map((r) => this.rowToFile(r, res[0]!.columns))
      .filter((f) => !linked.has(f.doc_id));
  }

  outgoing(docId: string): DbLinkRow[] {
    const res = this.db.exec('SELECT * FROM links WHERE src_doc_id=?', [docId]);
    if (!res[0]) return [];
    const cols = res[0].columns;
    return res[0].values.map((r) => {
      const get = (n: string): unknown => r[cols.indexOf(n)];
      return {
        src_doc_id: String(get('src_doc_id') ?? ''),
        dst_name: String(get('dst_name') ?? ''),
        dst_doc_id: get('dst_doc_id') === null || get('dst_doc_id') === undefined ? null : String(get('dst_doc_id')),
        anchor: String(get('anchor') ?? ''),
        alias: String(get('alias') ?? ''),
        kind: String(get('kind') ?? 'wikilink'),
      };
    });
  }

  allLinks(): DbLinkRow[] {
    const res = this.db.exec('SELECT * FROM links');
    if (!res[0]) return [];
    const cols = res[0].columns;
    return res[0].values.map((r) => {
      const get = (n: string): unknown => r[cols.indexOf(n)];
      return {
        src_doc_id: String(get('src_doc_id') ?? ''),
        dst_name: String(get('dst_name') ?? ''),
        dst_doc_id: get('dst_doc_id') === null || get('dst_doc_id') === undefined ? null : String(get('dst_doc_id')),
        anchor: String(get('anchor') ?? ''),
        alias: String(get('alias') ?? ''),
        kind: String(get('kind') ?? 'wikilink'),
      };
    });
  }

  tags(): Array<{ tag: string; count: number; docs: number }> {
    const res = this.db.exec(
      'SELECT tag, SUM(count) AS count, COUNT(DISTINCT doc_id) AS docs FROM tags GROUP BY tag ORDER BY docs DESC, tag',
    );
    if (!res[0]) return [];
    return res[0].values.map((r) => ({ tag: String(r[0]), count: Number(r[1]), docs: Number(r[2]) }));
  }

  docsByTag(tag: string): DbFileRow[] {
    const res = this.db.exec(
      'SELECT f.* FROM tags t JOIN files f ON f.doc_id = t.doc_id WHERE t.tag=? AND f.deleted_at IS NULL ORDER BY f.updated_at DESC',
      [tag],
    );
    if (!res[0]) return [];
    return res[0].values.map((r) => this.rowToFile(r, res[0]!.columns));
  }

  properties(): Array<{ key: string; kind: string; docs: number; values: string[] }> {
    const res = this.db.exec('SELECT key, kind, COUNT(DISTINCT doc_id) AS docs FROM props GROUP BY key ORDER BY docs DESC');
    if (!res[0]) return [];
    return res[0].values.map((r) => {
      const key = String(r[0]);
      const vals = this.db.exec('SELECT DISTINCT value FROM props WHERE key=? LIMIT 30', [key]);
      return {
        key,
        kind: String(r[1]),
        docs: Number(r[2]),
        values: (vals[0]?.values ?? []).map((v) => String(v[0])),
      };
    });
  }

  propsOf(docId: string): DbPropRow[] {
    const res = this.db.exec('SELECT * FROM props WHERE doc_id=?', [docId]);
    if (!res[0]) return [];
    return res[0].values.map((r) => ({ doc_id: String(r[0]), key: String(r[1]), value: String(r[2]), kind: String(r[3]) }));
  }

  setProp(docId: string, key: string, value: string, kind = 'text'): void {
    this.db.run('INSERT OR REPLACE INTO props (doc_id, key, value, kind) VALUES (?,?,?,?)', [docId, key, value, kind]);
    this.touch();
  }

  /* ---------------- 版本 ---------------- */

  addVersion(v: VersionRecord): void {
    this.db.run(
      `INSERT OR REPLACE INTO versions (id, doc_id, rev, hash, size, created_at, origin, storage_key, synced, label)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [v.id, v.docId, v.rev, v.hash, v.size, v.createdAt, v.origin, v.storageKey, v.synced ? 1 : 0, v.label],
    );
    this.touch();
  }

  versions(docId: string, limit = 200): VersionRecord[] {
    const res = this.db.exec('SELECT * FROM versions WHERE doc_id=? ORDER BY created_at DESC LIMIT ?', [docId, limit]);
    if (!res[0]) return [];
    const cols = res[0].columns;
    return res[0].values.map((r) => {
      const get = (n: string): unknown => r[cols.indexOf(n)];
      return {
        id: String(get('id')),
        docId: String(get('doc_id')),
        rev: Number(get('rev')),
        hash: String(get('hash')),
        size: Number(get('size')),
        createdAt: Number(get('created_at')),
        origin: String(get('origin')),
        storageKey: String(get('storage_key')),
        synced: Number(get('synced')) === 1,
        label: String(get('label') ?? ''),
      };
    });
  }

  pruneVersions(docId: string, keep: number, olderThanDays: number): string[] {
    const cutoff = Date.now() - olderThanDays * 86_400_000;
    const all = this.versions(docId, 5000);
    const keepSet = new Set(all.slice(0, keep).map((v) => v.id));
    const removed: string[] = [];
    for (const v of all) {
      if (!keepSet.has(v.id) && v.createdAt < cutoff) removed.push(v.storageKey);
    }
    for (const v of all) {
      if (removed.includes(v.storageKey)) this.db.run('DELETE FROM versions WHERE id=?', [v.id]);
    }
    if (removed.length) this.touch();
    return removed;
  }

  /* ---------------- 书签 ---------------- */

  addBookmark(path: string, title: string, docId: string | null, groupName = '默认'): string {
    const id = newId('bm');
    this.db.run('INSERT INTO bookmarks (id, doc_id, path, title, group_name, created_at) VALUES (?,?,?,?,?,?)', [
      id,
      docId,
      path,
      title,
      groupName,
      Date.now(),
    ]);
    this.touch();
    return id;
  }

  bookmarks(): Array<{ id: string; docId: string | null; path: string; title: string; groupName: string; createdAt: number }> {
    const res = this.db.exec('SELECT * FROM bookmarks ORDER BY created_at DESC');
    if (!res[0]) return [];
    const cols = res[0].columns;
    return res[0].values.map((r) => {
      const get = (n: string): unknown => r[cols.indexOf(n)];
      return {
        id: String(get('id')),
        docId: get('doc_id') === null ? null : String(get('doc_id')),
        path: String(get('path')),
        title: String(get('title')),
        groupName: String(get('group_name')),
        createdAt: Number(get('created_at')),
      };
    });
  }

  removeBookmark(id: string): void {
    this.db.run('DELETE FROM bookmarks WHERE id=?', [id]);
    this.touch();
  }

  /* ---------------- 维护 ---------------- */

  setMeta(key: string, value: string): void {
    this.db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)', [key, value]);
    this.touch();
  }

  getMeta(key: string): string | null {
    const res = this.db.exec('SELECT value FROM meta WHERE key=?', [key]);
    return (res[0]?.values[0]?.[0] as string | undefined) ?? null;
  }

  rebaseOnRename(oldPath: string, newPath: string, docId: string, newTitle: string): void {
    this.updatePath(docId, newPath, newTitle);
    this.resolveLinks();
  }

  stats(): IndexStats {
    const res = this.db.exec(
      `SELECT (SELECT COUNT(*) FROM files WHERE deleted_at IS NULL),
              (SELECT COALESCE(SUM(size),0) FROM files WHERE deleted_at IS NULL),
              (SELECT COUNT(DISTINCT tag) FROM tags),
              (SELECT COUNT(*) FROM links)`,
    );
    const row = res[0]?.values[0] ?? [0, 0, 0, 0];
    return {
      files: Number(row[0] ?? 0),
      bytes: Number(row[1] ?? 0),
      tags: Number(row[2] ?? 0),
      links: Number(row[3] ?? 0),
      lastIndexedAt: Number(this.getMeta('lastIndexedAt') ?? 0),
    };
  }

  exportSnapshot(): Uint8Array {
    this.setMeta('lastSnapshotAt', String(Date.now()));
    return this.db.export();
  }

  private touch(): void {
    this.dirty += 1;
  }

  get isDirty(): boolean {
    return this.dirty >= this.dirtyThreshold;
  }

  resetDirty(): void {
    this.dirty = 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      /* 已关闭 */
    }
  }
}
