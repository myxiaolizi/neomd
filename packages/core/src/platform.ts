export type RuntimePlatform = 'desktop' | 'android' | 'web';

export interface RuntimeInfo {
  platform: RuntimePlatform;
  /** 桌面端或安卓端才有 */
  native: boolean;
  version: string;
  /** 桌面端注入的桥 */
  bridge?: NativeBridge;
}

/**
 * 原生桥：由 Electron preload / Capacitor 插件实现。
 * 网页端为 undefined，业务层据此选择浏览器实现。
 */
export interface NativeBridge {
  fs: {
    readText(path: string): Promise<string>;
    readBinary(path: string): Promise<Uint8Array>;
    writeText(path: string, content: string): Promise<void>;
    writeBinary(path: string, data: Uint8Array): Promise<void>;
    mkdirp(path: string): Promise<void>;
    remove(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    list(path: string): Promise<Array<{ name: string; isDirectory: boolean; size: number; mtime: number }>>;
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<{ size: number; mtime: number } | null>;
  };
  dialog?: {
    pickDirectory(): Promise<string | null>;
    pickFile(filters?: string[]): Promise<string | null>;
    saveFile(defaultName: string): Promise<string | null>;
  };
  paths?: {
    documents(): Promise<string>;
    userData(): Promise<string>;
    vaultDefault(): Promise<string>;
  };
  secrets?: {
    encrypt(plain: string): Promise<string>;
    decrypt(cipher: string): Promise<string>;
  };
  shell?: {
    openExternal(url: string): Promise<void>;
    showItemInFolder(path: string): Promise<void>;
  };
  /** 桌面端自定义标题栏：窗口最大化 / 最小化 / 关闭 */
  win?: {
    isMaximized(): Promise<boolean>;
    toggleMaximize(): Promise<boolean>;
    minimize(): Promise<void>;
    close(): Promise<void>;
    onStateChange?(cb: (state: { maximized: boolean }) => void): void;
  };
  app?: {
    version(): Promise<string>;
    onOpenFile(cb: (path: string) => void): void;
  };
  recorder?: {
    isAvailable(): boolean;
  };
}

let cached: RuntimeInfo | null = null;

export function detectRuntime(): RuntimeInfo {
  if (cached) return cached;
  const g = globalThis as unknown as {
    NeoMD?: { env?: RuntimePlatform; version?: string; bridge?: NativeBridge };
    Capacitor?: { getPlatform?: () => string };
  };
  const injected = g.NeoMD;
  let platform: RuntimePlatform = 'web';
  if (injected?.env) {
    platform = injected.env;
  } else if (g.Capacitor?.getPlatform?.() === 'android') {
    platform = 'android';
  }
  cached = {
    platform,
    native: platform !== 'web',
    version: injected?.version ?? '1.0.0',
    bridge: injected?.bridge,
  };
  return cached;
}

export function getBridge(): NativeBridge | undefined {
  return detectRuntime().bridge;
}

export function isDesktop(): boolean {
  return detectRuntime().platform === 'desktop';
}

export function isAndroid(): boolean {
  return detectRuntime().platform === 'android';
}

export function isWeb(): boolean {
  return detectRuntime().platform === 'web';
}

/** 是否为触控优先设备（平板/手机），用于布局决策 */
export function isTouchFirst(): boolean {
  const info = detectRuntime();
  if (info.platform === 'android') return true;
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
}
