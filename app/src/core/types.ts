/** 全局领域模型 */

export type Platform = 'tauri' | 'fsa' | 'opfs';

/** 文档元数据，与仓库内的 .md 文件一一对应 */
export interface DocMeta {
  /** 仓库内相对路径，唯一键 */
  path: string;
  /** 不含扩展名的文件名 */
  title: string;
  /** 内容 SHA-1 */
  hash: string;
  /** 上次成功同步时的内容哈希 */
  syncedHash?: string;
  /** 远端对象 ETag */
  etag?: string;
  /** 最后同步时间 */
  syncedAt?: number;
  size: number;
  chars: number;
  created: number;
  modified: number;
  /** 摘要，用于列表预览 */
  excerpt?: string;
  /** 已删除标记（墓碑，用于传播删除） */
  deleted?: boolean;
}

export type VersionReason = 'auto' | 'manual' | 'sync' | 'pre-restore' | 'create';

/** 历史版本 */
export interface VersionEntry {
  id: string;
  path: string;
  ts: number;
  hash: string;
  size: number;
  reason: VersionReason;
  content: string;
  synced: boolean;
  /** 0/1 数值标记，供 IndexedDB 索引 */
  syncedFlag: 0 | 1;
}

export interface SyncSettings {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  forcePathStyle: boolean;
  syncVersions: boolean;
  autoInterval: number;
  concurrency: number;
}

export interface AiSettings {
  enabled: boolean;
  endpoint: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
}

export type NamingMode = 'ai' | 'datetime';

export interface EditorSettings {
  fontSize: number;
  lineHeight: number;
  maxWidth: number;
  fontFamily: string;
  spellcheck: boolean;
  autoPair: boolean;
  showLineNumbers: boolean;
  typewriter: boolean;
}

export interface AppSettings {
  theme: 'light' | 'dark' | 'auto';
  accent: string;
  namingMode: NamingMode;
  versionLimit: number;
  versionIntervalSec: number;
  editor: EditorSettings;
  ai: AiSettings;
  sync: SyncSettings;
  keymap: Record<string, string>;
  sidebarCollapsed: boolean;
  lastDocPath?: string;
  restoreLast: boolean;
  autoImportExternal: boolean;
  locale: string;
}

export interface SyncState {
  status: 'idle' | 'syncing' | 'ok' | 'error' | 'off';
  message: string;
  lastSyncAt?: number;
  progress?: { done: number; total: number };
}

export interface ToastMsg {
  id: number;
  kind: 'info' | 'ok' | 'err';
  text: string;
}
