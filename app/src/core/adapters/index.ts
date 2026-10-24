import { FsaAdapter } from './fsa';
import { OpfsAdapter } from './opfs';
import { TauriAdapter, isTauriRuntime } from './tauri';
import type { VaultAdapter } from './types';

const HANDLE_DB = 'mdnote-handles';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'vault';
const TAURI_ROOT_KEY = 'mdnote:tauri-root';

async function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openHandleDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openHandleDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get(HANDLE_KEY);
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function clearHandle(): Promise<void> {
  try {
    const db = await openHandleDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).delete(HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* ignore */
  }
}

export type VaultMode = 'tauri' | 'fsa' | 'opfs';

/** 当前环境支持的最佳存储方式 */
export function bestMode(): VaultMode {
  if (isTauriRuntime()) return 'tauri';
  if (typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function') {
    return 'fsa';
  }
  return 'opfs';
}

export interface OpenedVault {
  adapter: VaultAdapter;
  mode: VaultMode;
}

/**
 * 打开仓库：优先恢复上次绑定。
 * 首次启动不主动弹出系统对话框，交由欢迎页的按钮触发，
 * 避免应用界面还没出现就先跳出一个选择框。
 *
 * @param force 强制弹出选择器（切换仓库、或用户主动点击时使用）
 */
export async function openVault(force = false): Promise<OpenedVault | null> {
  // 1. Tauri 原生
  if (isTauriRuntime()) {
    const saved = localStorage.getItem(TAURI_ROOT_KEY);
    if (saved) {
      const name = saved.split(/[\\/]/).filter(Boolean).pop() ?? '仓库';
      return { adapter: new TauriAdapter(saved, name, saved), mode: 'tauri' };
    }
    if (!force) return null;
    const picked = await TauriAdapter.pick();
    if (!picked) return null;
    localStorage.setItem(TAURI_ROOT_KEY, picked.root);
    return { adapter: picked, mode: 'tauri' };
  }

  // 2. File System Access
  const canFsa = typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
  if (canFsa) {
    if (!force) {
      const handle = await loadHandle();
      if (handle) {
        const restored = await FsaAdapter.restore(handle);
        if (restored) return { adapter: restored, mode: 'fsa' };
      }
      return null;
    }
    const picked = await FsaAdapter.pick();
    if (picked) {
      await saveHandle(picked.handle);
      return { adapter: picked, mode: 'fsa' };
    }
    return null;
  }

  // 3. OPFS 兜底（无需授权，始终可用）
  return { adapter: new OpfsAdapter(), mode: 'opfs' };
}

/** 解绑当前仓库 */
export async function unbindVault(): Promise<void> {
  localStorage.removeItem(TAURI_ROOT_KEY);
  await clearHandle();
}
