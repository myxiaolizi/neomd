/**
 * 后台 1.4.0 新增接口的本地 API 层。
 *
 * ## 为什么不直接改 `@/api/client`
 *
 * `apps/web/src/api/client.ts` **不在本组的写入范围**（1.4.0 并行开发期间它由其他组共用，
 * 改它容易和多处改动冲突）。但后台 1.4.0 新增了 10 个接口，总得有个地方声明类型与调用，
 * 因此把它们收敛到 `components/admin/` 下的这个文件 —— 它属于本组可写范围，
 * 且只有后台组件会 import，不会外溢影响前台。
 *
 * ## 复用而非重造
 *
 * 底层的 `api()`（鉴权、401 刷新、超时、错误码）一律复用 `@/api/client` 的实现，
 * 这里只补充「路径 + 请求体 + 返回类型」。因此行为与其它后台接口完全一致：
 * 401 自动刷新、错误抛 `ApiError`（带 code/status）、超时 8 秒。
 */
import { api, type CommunityPluginDto } from '@/api/client';

/* ------------------------------------------------------------------ */
/* 插件市场编辑（需求2）                                                */
/* ------------------------------------------------------------------ */

/** 后台编辑插件时可改的字段（全部可选，服务端按 PATCH 语义处理） */
export interface AdminPluginPatch {
  name?: string;
  version?: string;
  category?: CommunityPluginDto['category'];
  icon?: string;
  description?: string;
  readmeMd?: string;
  codeJs?: string;
  tags?: string[];
  status?: CommunityPluginDto['status'];
}

/**
 * 字段级变更描述（服务端 diffPlugin 的产物）。
 *
 * 文本类字段直接给 before/after；代码与 README 只给长度（服务端刻意不落全文，
 * 避免几十 KB 的代码把审计日志的 TEXT 挤爆）。
 */
export type AdminPluginChange =
  | { before: string | null; after: string | null }
  | { lengthBefore: number; lengthAfter: number };

export interface AdminPluginUpdateResult {
  plugin: CommunityPluginDto;
  changes: Record<string, AdminPluginChange>;
  /** 提交了但没有任何字段真正变化时为 true（幂等保存） */
  unchanged: boolean;
}

/** 后台读单个插件（编辑弹窗打开时取最新值，避免覆盖别人的改动） */
export function fetchAdminPlugin(id: number): Promise<{ plugin: CommunityPluginDto }> {
  return api<{ plugin: CommunityPluginDto }>(`/api/admin/plugins/${id}`, { auth: true });
}

/** 后台保存插件编辑 */
export function saveAdminPlugin(id: number, patch: AdminPluginPatch): Promise<AdminPluginUpdateResult> {
  return api<AdminPluginUpdateResult>(`/api/admin/plugins/${id}`, { method: 'PUT', body: patch, auth: true });
}

/* ------------------------------------------------------------------ */
/* 插件市场翻页（需求3）                                                */
/* ------------------------------------------------------------------ */

export interface AdminPluginPage {
  items: CommunityPluginDto[];
  page: number;
  pageSize: number;
  total: number;
}

/** 后台插件列表（分页 + 搜索）。与既有 adminApiV2.plugins 等价，但返回 page/pageSize 便于断言 */
export function fetchAdminPlugins(page: number, pageSize: number, search: string): Promise<AdminPluginPage> {
  const q = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (search) q.set('search', search);
  return api<AdminPluginPage>(`/api/admin/plugins?${q}`, { auth: true });
}

/* ------------------------------------------------------------------ */
/* 客户端分发（需求4）                                                  */
/* ------------------------------------------------------------------ */

/**
 * 安装包条目。
 *
 * `onOss` / `onLocal` 是 1.4.0 的关键区分 —— 这两处的产物可能不一致
 * （1.2.0 发布时 APK 就只在本地、清单没登记）。后台必须能一眼看出差异。
 */
export interface AdminReleaseFile {
  file: string;
  version: string | null;
  platform: 'windows' | 'android' | null;
  title: string | null;
  size: number | null;
  lastModified: string | null;
  url: string | null;
  /** 是否属于「当前版本」（判断依据：services/api/package.json 的 version） */
  isCurrent: boolean;
  /** 是否在 download.js 的当前版本清单里 */
  inCurrentManifest: boolean;
  /** 是否为历史 APK（download.js 白名单内的历史条目） */
  historical: boolean;
  onOss: boolean;
  onLocal: boolean;
  /** 是否在客户端下载白名单内 */
  downloadable: boolean;
  /** 白名单内 **且** 分发链路真的能给出文件 */
  available: boolean;
  downloads: number;
  lastDownloadAt: string | null;
  note: string | null;
}

export interface AdminReleasesResult {
  prefix: string;
  /** 当前版本号，恒等于 services/api/package.json 的 version */
  currentVersion: string;
  files: AdminReleaseFile[];
  current: AdminReleaseFile[];
  history: AdminReleaseFile[];
  summary: {
    total: number;
    current: number;
    history: number;
    downloadable: number;
    available: number;
    onOss: number;
    onLocal: number;
    both: number;
    ossOnly: number;
    localOnly: number;
    totalDownloads: number;
  };
  message?: string;
}

export function fetchAdminReleases(): Promise<AdminReleasesResult> {
  return api<AdminReleasesResult>('/api/admin/releases', { auth: true });
}

export interface AdminReleaseProbe {
  file: string;
  url: string;
  publicUrl: string;
  status: number;
  reachable: boolean;
  contentType: string | null;
  contentLength: number | null;
  latencyMs: number;
  message: string;
}

export function probeAdminRelease(file: string): Promise<AdminReleaseProbe> {
  return api<AdminReleaseProbe>(`/api/admin/releases/${encodeURIComponent(file)}/probe`, { auth: true });
}

/* ------------------------------------------------------------------ */
/* 用户管理增强（需求5）                                                */
/* ------------------------------------------------------------------ */

/** 后台用户列表项（1.4.0 扩展了封禁与最后活跃字段） */
export interface AdminUserRow {
  id: number;
  email: string;
  username: string;
  nickname: string | null;
  role: 'user' | 'admin';
  status: 'active' | 'disabled';
  quotaBytes: number;
  credits: number;
  createdAt: string | null;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  banReason: string | null;
  bannedAt: string | null;
  banUntil: string | null;
  /** 封禁到期时间已过（惰性解封前的一瞬间状态） */
  banExpired: boolean;
  /** 派生：处于生效中的封禁 */
  banned: boolean;
  /** 最后活跃（审计表聚合） */
  lastActiveAt: string | null;
  shareCount: number;
  publishCount: number;
  documentCount: number;
  storageBytes: number;
}

export function banUser(id: number, body: { reason: string; hours?: number; until?: string }): Promise<{ user: AdminUserRow; message: string }> {
  return api<{ user: AdminUserRow; message: string }>(`/api/admin/users/${id}/ban`, {
    method: 'POST',
    body,
    auth: true,
  });
}

export function unbanUser(id: number): Promise<{ user: AdminUserRow; message: string }> {
  return api<{ user: AdminUserRow; message: string }>(`/api/admin/users/${id}/unban`, {
    method: 'POST',
    body: {},
    auth: true,
  });
}

/** 批量操作的单条结果 */
export interface BatchResultItem {
  id: number;
  username?: string;
  ok: boolean;
  reason?: string;
  delta?: number;
  balance?: number;
  role?: string;
}

export interface BatchResult {
  action: 'disable' | 'enable' | 'grant' | 'role';
  requested: number;
  succeeded: number;
  skipped: number;
  results: BatchResultItem[];
  message: string;
}

export function batchUsers(body: {
  ids: number[];
  action: 'disable' | 'enable' | 'grant' | 'role';
  amount?: number;
  reason?: string;
  role?: 'user' | 'admin';
}): Promise<BatchResult> {
  return api<BatchResult>('/api/admin/users/batch', { method: 'POST', body, auth: true });
}

export function setUserRole(id: number, role: 'user' | 'admin'): Promise<{ user: AdminUserRow; changed: boolean; message: string }> {
  return api<{ user: AdminUserRow; changed: boolean; message: string }>(`/api/admin/users/${id}/role`, {
    method: 'POST',
    body: { role },
    auth: true,
  });
}

/** 登录记录条目 */
export interface LoginRecord {
  id: number;
  action: string;
  success: boolean;
  reason: string | null;
  deviceId: string | null;
  ip: string | null;
  createdAt: string | null;
}

export function fetchUserLogins(
  id: number,
  query: { page?: number; pageSize?: number; failuresOnly?: boolean } = {},
): Promise<{
  user: { id: number; username: string; email: string; lastLoginAt: string | null; lastLoginIp: string | null };
  items: LoginRecord[];
  page: number;
  pageSize: number;
  total: number;
  summary: { success: number; failed: number; lastSuccessAt: string | null };
}> {
  const q = new URLSearchParams({
    page: String(query.page ?? 1),
    pageSize: String(query.pageSize ?? 20),
  });
  if (query.failuresOnly) q.set('failuresOnly', 'true');
  return api(`/api/admin/users/${id}/logins?${q}`, { auth: true });
}

/** 用户数据概览（聚合数字，不含明细列表） */
export interface UserOverview {
  user: AdminUserRow;
  overview: {
    vaults: { total: number; disabled: number; documents: number; bytes: number };
    shares: { total: number; active: number; views: number; comments: number };
    publishes: { total: number; active: number };
    ai: { calls: number; inTokens: number; outTokens: number; cost: number; errors: number; lastUsedAt: string | null };
    credits: { balance: number; inflow: number; outflow: number; entries: number };
    activity: { lastLoginAt: string | null; lastActiveAt: string | null };
    quota: { quotaBytes: number; storageBytes: number; usageRatio: number };
  };
}

export function fetchUserOverview(id: number): Promise<UserOverview> {
  return api<UserOverview>(`/api/admin/users/${id}/overview`, { auth: true });
}

/**
 * 导出用户 CSV。
 *
 * 为什么不用 `api()`：那个函数会 `res.json()`，而这里要拿原始 CSV 文本。
 * 因此直接用 `resolveApiUrl` + fetch，但**复用同一个令牌来源**（getAccessToken），
 * 并用 blob 触发浏览器下载。
 */
export async function exportUsersCsv(query: { search?: string; status?: string; role?: string; sort?: string } = {}): Promise<number> {
  const { getAccessToken, resolveApiUrl } = await import('@/api/client');
  const q = new URLSearchParams();
  if (query.search) q.set('search', query.search);
  if (query.status) q.set('status', query.status);
  if (query.role) q.set('role', query.role);
  if (query.sort) q.set('sort', query.sort);
  const token = getAccessToken();
  const res = await fetch(resolveApiUrl(`/api/admin/users/export.csv?${q}`), {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`导出失败（HTTP ${res.status}）`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `neomd-users-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 延后回收，避免部分浏览器在下载启动前被 revoke
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return blob.size;
}
