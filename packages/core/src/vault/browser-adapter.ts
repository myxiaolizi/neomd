import type { VaultAdapter, VaultFileEntry } from './adapter';

/** 在 data/ 目录上做路径归一化，并拒绝越权访问 */
function norm(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  if (p.split('/').some((s) => s === '..')) throw new Error(`非法路径: ${path}`);
  return p;
}

function splitParent(path: string): { parent: string; name: string } {
  const p = norm(path);
  const i = p.lastIndexOf('/');
  return i < 0 ? { parent: '', name: p } : { parent: p.slice(0, i), name: p.slice(i + 1) };
}

async function dirHandle(root: FileSystemDirectoryHandle, parts: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
  let h = root;
  for (const part of parts) {
    h = await h.getDirectoryHandle(part, { create });
  }
  return h;
}

/**
 * 基于 File System Access API（Chromium）的浏览器仓库。
 * 用户授权一个真实目录后，仓库就是本机明文文件夹；
 * 未授权时退化为 IndexedDB 私有仓库（`kind` 仍标记 browser-idb）。
 */
export class BrowserVaultAdapter implements VaultAdapter {
  readonly kind = 'browser-idb' as const;
  location = '';
  private root: FileSystemDirectoryHandle | null = null;
  private idb: IDBDatabase | null = null;

  constructor(private readonly dbName = 'neomd-vault') {}

  async open(location: string): Promise<void> {
    this.location = location || 'Neo MD';
    if (location && location.startsWith('handle:')) {
      this.root = await this.restoreHandle(location.slice(7));
    }
    if (!this.root) {
      this.idb = await this.openIdb();
    }
  }

  /** 请求用户授权一个真实目录 */
  async pickDirectory(): Promise<string | null> {
    const picker = (globalThis as unknown as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> })
      .showDirectoryPicker;
    if (!picker) throw new Error('当前浏览器不支持选择本地目录，请使用 Chrome / Edge，或改用桌面端。');
    const handle = await picker();
    this.root = handle;
    this.idb = null;
    this.location = `handle:${handle.name}`;
    await this.saveHandle(handle);
    return this.location;
  }

  private async saveHandle(handle: FileSystemDirectoryHandle): Promise<void> {
    const db = await this.openIdb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(handle, 'root');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private async restoreHandle(_key: string): Promise<FileSystemDirectoryHandle | null> {
    try {
      const db = await this.openIdb();
      const handle = await new Promise<FileSystemDirectoryHandle | undefined>((resolve, reject) => {
        const req = db.transaction('handles', 'readonly').objectStore('handles').get('root');
        req.onsuccess = () => resolve(req.result as FileSystemDirectoryHandle | undefined);
        req.onerror = () => reject(req.error);
      });
      if (!handle) return null;
      const perm = await (
        handle as unknown as { queryPermission(o: { mode: string }): Promise<string> }
      ).queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') return handle;
      const req = await (
        handle as unknown as { requestPermission(o: { mode: string }): Promise<string> }
      ).requestPermission({ mode: 'readwrite' });
      return req === 'granted' ? handle : null;
    } catch {
      return null;
    }
  }

  private openIdb(): Promise<IDBDatabase> {
    if (this.idb) return Promise.resolve(this.idb);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
        if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
      };
      req.onsuccess = () => {
        this.idb = req.result;
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
  }

  private idbGet<T>(store: string, key: string): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const idb = this.idb!;
      const req = idb.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  }

  private idbPut(store: string, key: string, value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const idb = this.idb!;
      const tx = idb.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private idbDelete(store: string, key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const idb = this.idb!;
      const tx = idb.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private idbKeys(store: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const idb = this.idb!;
      const req = idb.transaction(store, 'readonly').objectStore(store).getAllKeys();
      req.onsuccess = () => resolve((req.result as string[]) ?? []);
      req.onerror = () => reject(req.error);
    });
  }

  async readText(path: string): Promise<string> {
    const bytes = await this.readBinary(path);
    return new TextDecoder('utf-8').decode(bytes);
  }

  async readBinary(path: string): Promise<Uint8Array> {
    if (this.root) {
      const { parent, name } = splitParent(path);
      const dir = await dirHandle(this.root, parent ? parent.split('/') : [], false);
      const fh = await dir.getFileHandle(name);
      const file = await fh.getFile();
      return new Uint8Array(await file.arrayBuffer());
    }
    const rec = await this.idbGet<Blob | string>('files', norm(path));
    if (rec === undefined) throw new Error(`文件不存在: ${path}`);
    if (typeof rec === 'string') return new TextEncoder().encode(rec);
    return new Uint8Array(await rec.arrayBuffer());
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.writeBinary(path, new TextEncoder().encode(content));
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    if (this.root) {
      const { parent, name } = splitParent(path);
      const dir = await dirHandle(this.root, parent ? parent.split('/') : [], true);
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await (fh as unknown as { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
      await w.write(data as unknown as BufferSource);
      await w.close();
      return;
    }
    await this.idbPut('files', norm(path), new Blob([data as unknown as BlobPart]));
  }

  async remove(path: string): Promise<void> {
    if (this.root) {
      const { parent, name } = splitParent(path);
      const dir = await dirHandle(this.root, parent ? parent.split('/') : [], false);
      await dir.removeEntry(name, { recursive: true });
      return;
    }
    await this.idbDelete('files', norm(path));
  }

  async rename(from: string, to: string): Promise<void> {
    const data = await this.readBinary(from);
    await this.writeBinary(to, data);
    await this.remove(from);
  }

  async mkdirp(path: string): Promise<void> {
    if (this.root) {
      await dirHandle(this.root, norm(path).split('/').filter(Boolean), true);
    }
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null;
  }

  async stat(path: string): Promise<{ size: number; mtime: number } | null> {
    if (this.root) {
      try {
        const { parent, name } = splitParent(path);
        const dir = await dirHandle(this.root, parent ? parent.split('/') : [], false);
        const fh = await dir.getFileHandle(name);
        const file = await fh.getFile();
        return { size: file.size, mtime: file.lastModified };
      } catch {
        return null;
      }
    }
    const rec = await this.idbGet<Blob | string>('files', norm(path));
    if (rec === undefined) return null;
    return { size: typeof rec === 'string' ? rec.length : rec.size, mtime: Date.now() };
  }

  async listAll(): Promise<VaultFileEntry[]> {
    if (this.root) {
      const out: VaultFileEntry[] = [];
      const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
        for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
          const path = prefix ? `${prefix}/${name}` : name;
          if (path.startsWith('.neomd')) continue;
          if (handle.kind === 'directory') {
            await walk(handle as FileSystemDirectoryHandle, path);
          } else {
            const file = await (handle as FileSystemFileHandle).getFile();
            out.push({ path, isDirectory: false, size: file.size, mtime: file.lastModified });
          }
        }
      };
      await walk(this.root, '');
      return out;
    }
    const keys = await this.idbKeys('files');
    const out: VaultFileEntry[] = [];
    for (const key of keys) {
      if (key.startsWith('.neomd')) continue;
      const st = await this.stat(key);
      if (st) out.push({ path: key, isDirectory: false, size: st.size, mtime: st.mtime });
    }
    return out;
  }

  async listDir(path: string): Promise<VaultFileEntry[]> {
    const dir = norm(path);
    const all = await this.listAll();
    const prefix = dir ? `${dir}/` : '';
    const seen = new Set<string>();
    const out: VaultFileEntry[] = [];
    for (const e of all) {
      if (!e.path.startsWith(prefix)) continue;
      const rest = e.path.slice(prefix.length);
      const name = rest.split('/')[0]!;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({
        path: prefix + name,
        isDirectory: rest.includes('/'),
        size: rest.includes('/') ? 0 : e.size,
        mtime: e.mtime,
      });
    }
    return out;
  }

  async usage(): Promise<{ bytes: number; files: number }> {
    const all = await this.listAll();
    return { bytes: all.reduce((s, e) => s + e.size, 0), files: all.length };
  }
}
