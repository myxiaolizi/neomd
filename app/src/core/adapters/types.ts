/** 仓库存储适配器的统一契约 */

export interface FileEntry {
  /** 仓库内相对路径，使用 / 分隔 */
  path: string;
  size: number;
  /** 修改时间（毫秒） */
  mtime: number;
}

export interface VaultAdapter {
  readonly kind: 'tauri' | 'fsa' | 'opfs';
  /** 展示给用户的位置描述 */
  readonly location: string;
  /** 仓库名称 */
  readonly name: string;

  /** 递归列出全部 .md 文件 */
  list(): Promise<FileEntry[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  ensureDir(dir: string): Promise<void>;
}

/** 是否属于笔记文件 */
export function isNotePath(p: string): boolean {
  return /\.md$/i.test(p);
}

/** 系统保留目录，不纳入笔记索引 */
const RESERVED = new Set(['.git', 'node_modules', '.obsidian', '.trash', '.mdnote']);

export function isReserved(segment: string): boolean {
  return RESERVED.has(segment);
}

/** 规范化相对路径 */
export function normalizePath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

/** 由路径推导标题 */
export function titleOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}
