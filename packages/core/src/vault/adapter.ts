/**
 * 仓库文件系统适配器。
 * 桌面端 = 真实文件夹（明文 .md），Android = 应用文档目录，网页端 = IndexedDB。
 * 所有路径为仓库内相对 POSIX 路径，元数据目录固定为 `.neomd/`。
 */
export interface VaultFileEntry {
  path: string;
  isDirectory: boolean;
  size: number;
  mtime: number;
}

export interface VaultAdapter {
  readonly kind: 'desktop-fs' | 'android-fs' | 'browser-idb';
  /** 打开/初始化仓库根 */
  open(location: string): Promise<void>;
  /** 仓库根的可读位置（桌面端是绝对路径，网页端是逻辑名） */
  readonly location: string;
  readText(path: string): Promise<string>;
  readBinary(path: string): Promise<Uint8Array>;
  writeText(path: string, content: string): Promise<void>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ size: number; mtime: number } | null>;
  /** 递归列出所有文件（排除 `.neomd/`），用于建索引 */
  listAll(): Promise<VaultFileEntry[]>;
  listDir(path: string): Promise<VaultFileEntry[]>;
  /** 仓库总占用字节 */
  usage(): Promise<{ bytes: number; files: number }>;
}

export const META_DIR = '.neomd';
