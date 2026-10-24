import type { DocMeta, VersionEntry } from './types';

const DB_NAME = 'mdnote';
const DB_VERSION = 1;

const STORE_DOCS = 'docs';
const STORE_VERSIONS = 'versions';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_DOCS)) {
        const s = db.createObjectStore(STORE_DOCS, { keyPath: 'path' });
        s.createIndex('modified', 'modified');
        s.createIndex('created', 'created');
      }
      if (!db.objectStoreNames.contains(STORE_VERSIONS)) {
        const v = db.createObjectStore(STORE_VERSIONS, { keyPath: 'id' });
        v.createIndex('path', 'path');
        v.createIndex('pathTs', ['path', 'ts']);
        v.createIndex('syncedFlag', 'syncedFlag');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const s = tx.objectStore(store);
        let req: IDBRequest<T> | void;
        try {
          req = fn(s);
        } catch (e) {
          reject(e);
          return;
        }
        tx.oncomplete = () => resolve(req && 'result' in req ? (req.result as T) : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

/* ------------------------- 文档 ------------------------- */

export const docStore = {
  async all(): Promise<DocMeta[]> {
    const rows = await run<DocMeta[]>(STORE_DOCS, 'readonly', (s) => s.getAll() as IDBRequest<DocMeta[]>);
    return (rows ?? []).filter((d) => !d.deleted);
  },

  async allWithDeleted(): Promise<DocMeta[]> {
    const rows = await run<DocMeta[]>(STORE_DOCS, 'readonly', (s) => s.getAll() as IDBRequest<DocMeta[]>);
    return rows ?? [];
  },

  async get(path: string): Promise<DocMeta | undefined> {
    return run<DocMeta>(STORE_DOCS, 'readonly', (s) => s.get(path) as IDBRequest<DocMeta>);
  },

  async put(meta: DocMeta): Promise<void> {
    await run(STORE_DOCS, 'readwrite', (s) => s.put(meta));
  },

  async putMany(list: DocMeta[]): Promise<void> {
    if (!list.length) return;
    await run(STORE_DOCS, 'readwrite', (s) => {
      for (const m of list) s.put(m);
    });
  },

  async remove(path: string): Promise<void> {
    await run(STORE_DOCS, 'readwrite', (s) => s.delete(path));
  },

  async clear(): Promise<void> {
    await run(STORE_DOCS, 'readwrite', (s) => s.clear());
  },
};

/* ------------------------- 历史版本 ------------------------- */

export const versionStore = {
  async byPath(path: string): Promise<VersionEntry[]> {
    const rows = await run<VersionEntry[]>(STORE_VERSIONS, 'readonly', (s) =>
      s.index('path').getAll(IDBKeyRange.only(path)) as IDBRequest<VersionEntry[]>,
    );
    return (rows ?? []).sort((a, b) => b.ts - a.ts);
  },

  async get(id: string): Promise<VersionEntry | undefined> {
    return run<VersionEntry>(STORE_VERSIONS, 'readonly', (s) => s.get(id) as IDBRequest<VersionEntry>);
  },

  async all(): Promise<VersionEntry[]> {
    const rows = await run<VersionEntry[]>(STORE_VERSIONS, 'readonly', (s) => s.getAll() as IDBRequest<VersionEntry[]>);
    return rows ?? [];
  },

  async put(v: VersionEntry): Promise<void> {
    await run(STORE_VERSIONS, 'readwrite', (s) => s.put(v));
  },

  async remove(id: string): Promise<void> {
    await run(STORE_VERSIONS, 'readwrite', (s) => s.delete(id));
  },

  async removeByPath(path: string): Promise<void> {
    const list = await this.byPath(path);
    await run(STORE_VERSIONS, 'readwrite', (s) => {
      for (const v of list) s.delete(v.id);
    });
  },

  /** 尚未同步到远端的版本 */
  async unsynced(): Promise<VersionEntry[]> {
    const rows = await run<VersionEntry[]>(STORE_VERSIONS, 'readonly', (s) =>
      s.index('syncedFlag').getAll(IDBKeyRange.only(0)) as IDBRequest<VersionEntry[]>,
    );
    return rows ?? [];
  },

  /** 保留最近 keep 条，返回被清理数量 */
  async prune(path: string, keep: number): Promise<number> {
    const list = await this.byPath(path);
    if (list.length <= keep) return 0;
    const drop = list.slice(keep);
    await run(STORE_VERSIONS, 'readwrite', (s) => {
      for (const v of drop) s.delete(v.id);
    });
    return drop.length;
  },

  async count(): Promise<number> {
    return (await run<number>(STORE_VERSIONS, 'readonly', (s) => s.count())) ?? 0;
  },
};

/** 存储用量估算 */
export async function storageEstimate(): Promise<{ usage: number; quota: number }> {
  if (navigator.storage?.estimate) {
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  }
  return { usage: 0, quota: 0 };
}
