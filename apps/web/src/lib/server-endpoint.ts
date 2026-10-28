/**
 * 服务端地址解析 + 数据私有化判定。
 *
 * 产品约定（1.0.2）：
 * - 默认连接官方服务端 `https://md.zhengl.vip`；
 * - 桌面端允许用户改为**自建服务端**（`settings.server.mode === 'custom'`）；
 * - **应用商店（插件市场）永远走官方服务**，不支持私有化部署，因此
 *   `resolveMarketBase()` 不受 `server` 配置影响；
 * - `settings.server.privacyMode === true` 时编辑器完全不连服务器，
 *   只有插件市场（官方公共服务）仍然可用。
 *
 * 为什么这里直接读 localStorage 而不是读 Pinia store：
 * `api/client.ts` 的 `api()` 入口需要同步判定，而 store 又反向依赖 client，
 * 直接读落盘快照可以避免循环依赖，也保证"刷新页面后配置立即生效"。
 * 配置一旦变化，`persist()` 会重写 `neomd.settings.v1`，下方按原始字符串缓存自动失效。
 */
import { detectRuntime, SETTINGS_KEY } from '@neomd/core';
import type { ServerSettings } from '@neomd/shared';
import { SITE_URL } from '@/env';

/** 官方服务端根地址（应用商店、官方账号体系都指向这里） */
export const OFFICIAL_SERVER_BASE = SITE_URL;

/** 服务端配置兜底默认值（桌面端首次启动即官方服务） */
export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  mode: 'official',
  customBaseUrl: '',
  privacyMode: false,
};

/**
 * 规范化用户填写的自建地址。
 *
 * - 去首尾空白、去末尾斜杠；
 * - 只接受 http:// 与 https://；
 * - 顺手去掉误填的末尾 `/api`（用户常把接口前缀一起粘进来）；
 * - 非法时返回空串，调用方据此判定"未配置"。
 */
export function normalizeServerBase(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (!url.hostname) return '';
    // 服务端根地址不带查询串与哈希
    let path = url.pathname.replace(/\/+$/, '');
    if (/\/api$/i.test(path)) path = path.slice(0, -4);
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return '';
  }
}

/** 自建地址是否合法可用 */
export function isValidServerBase(raw: unknown): boolean {
  return Boolean(normalizeServerBase(raw));
}

interface ServerCache {
  raw: string | null;
  value: ServerSettings;
}

const cache: ServerCache = { raw: null, value: DEFAULT_SERVER_SETTINGS };

/**
 * 读取落盘的服务端配置（带兜底与缓存）。
 * 任何解析异常都退回默认值，绝不让配置读失败拖垮整页。
 */
export function readServerSettings(): ServerSettings {
  if (typeof localStorage === 'undefined') return DEFAULT_SERVER_SETTINGS;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SETTINGS_KEY);
  } catch {
    return DEFAULT_SERVER_SETTINGS;
  }
  if (cache.raw === raw) return cache.value;

  let value = DEFAULT_SERVER_SETTINGS;
  try {
    const parsed = raw ? (JSON.parse(raw) as { server?: Partial<ServerSettings> } | null) : null;
    const saved = parsed?.server;
    if (saved && typeof saved === 'object') {
      value = {
        mode: saved.mode === 'custom' ? 'custom' : 'official',
        customBaseUrl: typeof saved.customBaseUrl === 'string' ? saved.customBaseUrl : '',
        privacyMode: saved.privacyMode === true,
      };
    }
  } catch {
    value = DEFAULT_SERVER_SETTINGS;
  }
  cache.raw = raw;
  cache.value = value;
  return value;
}

/** 是否为"远程网页端"（浏览器里通过 http/https 访问，且不是桌面壳里的伪装） */
function isRemoteWeb(): boolean {
  if (typeof window === 'undefined') return false;
  const proto = window.location.protocol;
  const host = window.location.hostname;
  return (
    (proto === 'http:' || proto === 'https:') &&
    host !== 'neomd' &&
    !window.location.origin.startsWith('capacitor://') &&
    !(host === 'localhost' && Boolean((window as unknown as { Capacitor?: unknown }).Capacitor))
  );
}

/** 桌面端生效的自建地址（未配置或非法时返回空串） */
export function resolveCustomServerBase(): string {
  if (detectRuntime().platform !== 'desktop') return '';
  const server = readServerSettings();
  if (server.mode !== 'custom') return '';
  return normalizeServerBase(server.customBaseUrl);
}

/**
 * 解析业务 API 基地址。
 *
 * - 网页端：返回空串，走同源相对路径 `/api/...`（行为与旧版一致）；
 * - 桌面端自建模式且地址合法：返回自建地址；
 * - 其余（桌面/安卓原生壳）：返回官方地址。
 */
export function resolveServerBase(): string {
  const custom = resolveCustomServerBase();
  if (custom) return custom;
  if (isRemoteWeb()) return '';
  return OFFICIAL_SERVER_BASE;
}

/**
 * 解析应用商店（插件市场）基地址：**永远是官方地址**。
 * 私有化部署不提供应用商店，自建服务端也不接管市场数据。
 */
export function resolveMarketBase(): string {
  return OFFICIAL_SERVER_BASE;
}

/** 数据私有化是否开启（开启后除插件市场外不再请求任何服务端接口） */
export function isPrivacyMode(): boolean {
  return readServerSettings().privacyMode;
}
