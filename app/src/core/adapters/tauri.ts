import { isNotePath, isReserved, normalizePath, type FileEntry, type VaultAdapter } from './types';

interface Invoke {
  (cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

function invokeFn(): Invoke | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } };
  return w.__TAURI_INTERNALS__?.invoke ?? null;
}

export function isTauriRuntime(): boolean {
  return invokeFn() !== null;
}

/**
 * Tauri 适配器：通过 Rust 侧命令直接访问真实文件系统。
 * 相比浏览器方案，可访问任意路径、无授权弹窗、可注册为系统默认 .md 打开方式。
 */
export class TauriAdapter implements VaultAdapter {
  readonly kind = 'tauri' as const;

  constructor(
    readonly root: string,
    readonly name: string,
    readonly location: string,
  ) {}

  private async call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const fn = invokeFn();
    if (!fn) throw new Error('Tauri 运行时不可用');
    return (await fn(cmd, args)) as T;
  }

  static async pick(): Promise<TauriAdapter | null> {
    const fn = invokeFn();
    if (!fn) return null;
    const picked = (await fn('pick_folder')) as string | null;
    if (!picked) return null;
    const name = picked.split(/[\\/]/).filter(Boolean).pop() ?? '仓库';
    return new TauriAdapter(picked, name, picked);
  }

  async list(): Promise<FileEntry[]> {
    const raw = await this.call<FileEntry[]>('vault_list', { root: this.root });
    return raw
      .filter((f) => isNotePath(f.path) && !f.path.split('/').some(isReserved))
      .sort((a, b) => b.mtime - a.mtime);
  }

  async read(path: string): Promise<string> {
    return this.call<string>('vault_read', { root: this.root, path: normalizePath(path) });
  }

  async write(path: string, content: string): Promise<void> {
    await this.call('vault_write', { root: this.root, path: normalizePath(path), content });
  }

  async remove(path: string): Promise<void> {
    await this.call('vault_remove', { root: this.root, path: normalizePath(path) });
  }

  async move(from: string, to: string): Promise<void> {
    await this.call('vault_move', {
      root: this.root,
      from: normalizePath(from),
      to: normalizePath(to),
    });
  }

  async exists(path: string): Promise<boolean> {
    return this.call<boolean>('vault_exists', { root: this.root, path: normalizePath(path) });
  }

  async ensureDir(dir: string): Promise<void> {
    if (!dir) return;
    await this.call('vault_ensure_dir', { root: this.root, dir: normalizePath(dir) });
  }
}
