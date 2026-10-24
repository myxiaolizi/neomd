/** 键值存储：优先 localStorage，容量不足时回落到 IndexedDB */

const DB_NAME = 'mdnote-kv';
const STORE = 'kv';
const LS_PREFIX = 'mdnote:';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDel(key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export const kv = {
  async get<T>(key: string, fallback: T): Promise<T> {
    const full = LS_PREFIX + key;
    try {
      const raw = localStorage.getItem(full);
      if (raw !== null) return JSON.parse(raw) as T;
    } catch {
      /* ignore */
    }
    try {
      const v = await idbGet<T>(full);
      if (v !== undefined) return v;
    } catch {
      /* ignore */
    }
    return fallback;
  },

  async set(key: string, value: unknown): Promise<void> {
    const full = LS_PREFIX + key;
    try {
      localStorage.setItem(full, JSON.stringify(value));
      // 同步成功则清理 IDB 副本
      idbDel(full).catch(() => undefined);
      return;
    } catch {
      /* 超限或不可用，落 IDB */
    }
    await idbSet(full, value);
  },

  async remove(key: string): Promise<void> {
    const full = LS_PREFIX + key;
    try { localStorage.removeItem(full); } catch { /* ignore */ }
    await idbDel(full).catch(() => undefined);
  },

  /** 同步读（仅 localStorage，用于首屏快速渲染） */
  getSync<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(LS_PREFIX + key);
      if (raw !== null) return JSON.parse(raw) as T;
    } catch {
      /* ignore */
    }
    return fallback;
  },
};
