import type { VaultAdapter, VaultFileEntry } from './adapter';

function norm(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  if (p.split('/').some((s) => s === '..')) throw new Error(`非法路径: ${path}`);
  return p;
}

/**
 * 桌面端与 Android 端仓库：使用原生桥读写真实文件夹。
 * 桌面端可指向任意本机目录；Android 端指向应用专属文档目录。
 */
export class NativeVaultAdapter implements VaultAdapter {
  readonly kind: 'desktop-fs' | 'android-fs';
  location = '';
  private rootAbs = '';

  constructor(
    private readonly bridge: import('../platform').NativeBridge,
    kind: 'desktop-fs' | 'android-fs',
  ) {
    this.kind = kind;
  }

  async open(location: string): Promise<void> {
    this.location = location;
    this.rootAbs = location.replace(/[\\/]+$/, '');
    await this.ensureRoot();
  }

  private abs(path: string): string {
    const rel = norm(path);
    const sep = this.rootAbs.includes('\\') ? '\\' : '/';
    return `${this.rootAbs}${sep}${rel.split('/').join(sep)}`;
  }

  private async ensureRoot(): Promise<void> {
    await this.bridge.fs.mkdirp(this.rootAbs);
    const metaDir = this.abs('.neomd');
    if (!(await this.bridge.fs.exists(metaDir))) await this.bridge.fs.mkdirp(metaDir);
  }

  async readText(path: string): Promise<string> {
    return this.bridge.fs.readText(this.abs(path));
  }

  async readBinary(path: string): Promise<Uint8Array> {
    return this.bridge.fs.readBinary(this.abs(path));
  }

  async writeText(path: string, content: string): Promise<void> {
    const target = this.abs(path);
    await this.bridge.fs.mkdirp(this.parentOf(target));
    await this.bridge.fs.writeText(target, content);
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const target = this.abs(path);
    await this.bridge.fs.mkdirp(this.parentOf(target));
    await this.bridge.fs.writeBinary(target, data);
  }

  private parentOf(absPath: string): string {
    const sep = absPath.includes('\\') ? '\\' : '/';
    const i = absPath.lastIndexOf(sep);
    return i <= 0 ? absPath : absPath.slice(0, i);
  }

  async remove(path: string): Promise<void> {
    await this.bridge.fs.remove(this.abs(path));
  }

  async rename(from: string, to: string): Promise<void> {
    const target = this.abs(to);
    await this.bridge.fs.mkdirp(this.parentOf(target));
    await this.bridge.fs.rename(this.abs(from), target);
  }

  async mkdirp(path: string): Promise<void> {
    await this.bridge.fs.mkdirp(this.abs(path));
  }

  async exists(path: string): Promise<boolean> {
    return this.bridge.fs.exists(this.abs(path));
  }

  async stat(path: string): Promise<{ size: number; mtime: number } | null> {
    return this.bridge.fs.stat(this.abs(path));
  }

  async listAll(): Promise<VaultFileEntry[]> {
    const out: VaultFileEntry[] = [];
    const walk = async (rel: string): Promise<void> => {
      const entries = await this.bridge.fs.list(rel ? this.abs(rel) : this.rootAbs);
      for (const e of entries) {
        const path = rel ? `${rel}/${e.name}` : e.name;
        if (path.startsWith('.neomd')) continue;
        if (e.isDirectory) {
          await walk(path);
        } else {
          out.push({ path, isDirectory: false, size: e.size, mtime: e.mtime });
        }
      }
    };
    await walk('');
    return out;
  }

  async listDir(path: string): Promise<VaultFileEntry[]> {
    const rel = norm(path);
    const entries = await this.bridge.fs.list(rel ? this.abs(rel) : this.rootAbs);
    return entries
      .filter((e) => !(rel === '' && e.name === '.neomd'))
      .map((e) => ({
        path: rel ? `${rel}/${e.name}` : e.name,
        isDirectory: e.isDirectory,
        size: e.isDirectory ? 0 : e.size,
        mtime: e.mtime,
      }));
  }

  async usage(): Promise<{ bytes: number; files: number }> {
    const all = await this.listAll();
    return { bytes: all.reduce((s, e) => s + e.size, 0), files: all.length };
  }
}
