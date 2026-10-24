import { isNotePath, isReserved, normalizePath, type FileEntry, type VaultAdapter } from './types';

/** 遍历 OPFS 目录树 */
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
      const file = await (handle as FileSystemFileHandle).getFile();
      out.push({ path: rel, size: file.size, mtime: file.lastModified });
    }
  }
}

/**
 * OPFS 适配器：浏览器私有文件系统。
 * 安卓与所有 Chromium 环境可用，数据随站点存储，无需授权弹窗。
 */
export class OpfsAdapter implements VaultAdapter {
  readonly kind = 'opfs' as const;
  readonly location = '浏览器应用存储（OPFS）';
  readonly name = '本地笔记';

  private rootPromise: Promise<FileSystemDirectoryHandle> | null = null;

  private root(): Promise<FileSystemDirectoryHandle> {
    if (!this.rootPromise) {
      this.rootPromise = navigator.storage
        .getDirectory()
        .then((d) => d.getDirectoryHandle('mdnote-vault', { create: true }));
    }
    return this.rootPromise;
  }

  private async dirOf(dir: string, create = false): Promise<FileSystemDirectoryHandle> {
    let handle = await this.root();
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
    await walk(await this.root(), '', out);
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
