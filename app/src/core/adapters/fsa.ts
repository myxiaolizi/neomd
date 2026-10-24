import { isNotePath, isReserved, normalizePath, type FileEntry, type VaultAdapter } from './types';

async function walk(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: FileEntry[],
): Promise<void> {
  for await (const [name, handle] of (dir as unknown as {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }).entries()) {
    if (isReserved(name)) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      await walk(handle as FileSystemDirectoryHandle, rel, out);
    } else if (isNotePath(name)) {
      try {
        const file = await (handle as FileSystemFileHandle).getFile();
        out.push({ path: rel, size: file.size, mtime: file.lastModified });
      } catch {
        /* 文件可能在列举过程中被删除 */
      }
    }
  }
}

/**
 * File System Access 适配器：直接读写用户选定的真实文件夹。
 * 句柄持久化在 IndexedDB，重启后请求一次写权限即可复用。
 */
export class FsaAdapter implements VaultAdapter {
  readonly kind = 'fsa' as const;

  constructor(
    private readonly rootHandle: FileSystemDirectoryHandle,
    readonly name: string,
    readonly location: string,
  ) {}

  /** 弹出目录选择器 */
  static async pick(): Promise<FsaAdapter | null> {
    const picker = (window as unknown as {
      showDirectoryPicker?: (o?: { mode?: string; id?: string }) => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker;
    if (!picker) return null;
    try {
      const handle = await picker({ mode: 'readwrite', id: 'mdnote-vault' });
      return new FsaAdapter(handle, handle.name, `本地文件夹 · ${handle.name}`);
    } catch {
      return null;
    }
  }

  /** 从已保存的句柄恢复，必要时请求权限 */
  static async restore(handle: FileSystemDirectoryHandle): Promise<FsaAdapter | null> {
    type Perm = {
      queryPermission?: (d: { mode: string }) => Promise<PermissionState>;
      requestPermission?: (d: { mode: string }) => Promise<PermissionState>;
    };
    const p = handle as unknown as Perm;
    try {
      let state = (await p.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
      if (state !== 'granted') {
        state = (await p.requestPermission?.({ mode: 'readwrite' })) ?? 'denied';
      }
      if (state !== 'granted') return null;
    } catch {
      return null;
    }
    return new FsaAdapter(handle, handle.name, `本地文件夹 · ${handle.name}`);
  }

  get handle(): FileSystemDirectoryHandle {
    return this.rootHandle;
  }

  private async dirOf(dir: string, create = false): Promise<FileSystemDirectoryHandle> {
    let handle = this.rootHandle;
    for (const seg of dir.split('/').filter(Boolean)) {
      handle = await handle.getDirectoryHandle(seg, { create });
    }
    return handle;
  }

  private async fileOf(path: string, create = false): Promise<FileSystemFileHandle> {
    const segs = normalizePath(path).split('/').filter(Boolean);
    const fileName = segs.pop();
    if (!fileName) throw new Error('路径无效');
    const dir = await this.dirOf(segs.join('/'), create);
    return dir.getFileHandle(fileName, { create });
  }

  async list(): Promise<FileEntry[]> {
    const out: FileEntry[] = [];
    await walk(this.rootHandle, '', out);
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  async read(path: string): Promise<string> {
    const fh = await this.fileOf(path);
    return (await fh.getFile()).text();
  }

  async write(path: string, content: string): Promise<void> {
    const fh = await this.fileOf(path, true);
    const writable = await fh.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async remove(path: string): Promise<void> {
    const segs = normalizePath(path).split('/').filter(Boolean);
    const fileName = segs.pop();
    if (!fileName) return;
    const dir = await this.dirOf(segs.join('/'));
    await dir.removeEntry(fileName, { recursive: true });
  }

  async move(from: string, to: string): Promise<void> {
    const content = await this.read(from);
    await this.write(to, content);
    await this.remove(from);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.fileOf(path);
      return true;
    } catch {
      return false;
    }
  }

  async ensureDir(dir: string): Promise<void> {
    if (!dir) return;
    await this.dirOf(dir, true);
  }
}
