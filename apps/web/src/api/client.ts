import { API_BASE } from '@/env';
import type { StorageConfig } from '@neomd/shared';
import { isPrivacyMode, resolveMarketBase, resolveServerBase } from '@/lib/server-endpoint';

export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/**
 * 解析业务 API 请求完整地址：
 * - 网页端（http/https 且同源）走相对路径 `/api/...`；
 * - 桌面端（`neomd://`、`file://`）或 Android 端（`capacitor://`、WebView 本地协议）
 *   自动拼接服务端基地址：默认官方 `https://md.zhengl.vip`，桌面端配了自建服务器时用自建地址，
 *   避免命中本地静态协议返回 index.html 导致 `请求失败 (200)`。
 */
export function resolveApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const rel = path.startsWith('/') ? path : `/${path}`;
  const base = resolveServerBase();
  // 桌面端自建/官方地址优先，其次是构建期显式指定的接口地址（自建网页部署场景）
  if (base) return `${base}${rel}`;
  if (API_BASE) return `${API_BASE.replace(/\/+$/, '')}${rel}`;
  return rel;
}

/**
 * 解析应用商店（插件市场）请求地址：**永远打官方服务端**。
 * 产品硬要求：私有化部署不提供应用商店，自建服务器也不接管市场数据。
 */
export function resolveMarketApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const rel = path.startsWith('/') ? path : `/${path}`;
  return `${resolveMarketBase().replace(/\/+$/, '')}${rel}`;
}

const TOKEN_KEY = 'neomd.access';
const REFRESH_KEY = 'neomd.refresh';

export function getAccessToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

export function setTokens(access: string | null, refresh?: string | null): void {
  try {
    if (access) localStorage.setItem(TOKEN_KEY, access);
    else localStorage.removeItem(TOKEN_KEY);
    if (refresh !== undefined) {
      if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
      else localStorage.removeItem(REFRESH_KEY);
    }
  } catch {
    /* 隐私模式下忽略 */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code = 'unknown',
    public readonly status = 0,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 数据私有化模式下被拦截的请求。
 *
 * 开启 `settings.server.privacyMode` 后，除应用商店（官方插件市场）以外的
 * 所有 `/api/*` 请求都会在 `api()` 入口直接抛本错误，**不会真的发出网络请求**。
 * 调用方约定：捕获后静默降级（本地功能照常可用），不要向用户弹红色报错。
 */
export class PrivacyModeError extends ApiError {
  constructor(message = '已开启数据私有化模式，本次操作需要连接服务器，已跳过') {
    super(message, 'PRIVACY_MODE', 0);
    this.name = 'PrivacyModeError';
  }
}

/** 判断一个异常是否由私有化模式拦截产生（调用方据此静默降级） */
export function isPrivacyModeError(e: unknown): e is PrivacyModeError {
  return e instanceof PrivacyModeError;
}

/**
 * 供**不走 `api()` 入口**的流式请求（SSE / `fetch` 直连）复用的守卫。
 *
 * `api()` 已在入口统一拦截，但 `AiPanel` 的平台 AI 走 `fetch` + ReadableStream
 * 直接读 SSE，绕过了入口，因此需要显式调用本函数判定；
 * 命中时抛 `PrivacyModeError`，调用方按静默降级处理（不要弹红色报错）。
 */
export function assertServerAllowed(): void {
  if (isPrivacyMode()) throw new PrivacyModeError();
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  auth?: boolean;
  formData?: FormData;
  signal?: AbortSignal;
  retryOn401?: boolean;
  /** 应用商店（插件市场）请求：永远走官方服务端，且不受私有化模式拦截 */
  viaMarket?: boolean;
  /**
   * 单次请求超时（毫秒）。
   * 默认 {@link DEFAULT_REQUEST_TIMEOUT_MS}；传 0 表示不限时（仅个别长任务需要）。
   */
  timeoutMs?: number;
};

/**
 * 请求默认超时时间。
 *
 * 为什么必须有：慢网络 / 服务端假死时 `fetch` 可能挂起数十秒，
 * 而首屏启动会因此一直停在「正在打开仓库」。8 秒足够一次正常往返，
 * 超时后由调用方按"本地优先"策略静默降级。
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 8000;

let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  // 私有化模式下不刷新令牌（也不会走到这里，双重保险）
  if (isPrivacyMode()) return false;
  const refresh = getRefreshToken();
  if (!refresh) return false;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(resolveApiUrl('/api/auth/refresh'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: refresh }),
        });
        const json = (await res.json()) as ApiEnvelope<{ accessToken: string; refreshToken: string }>;
        if (!json.ok || !json.data) return false;
        setTokens(json.data.accessToken, json.data.refreshToken);
        return true;
      } catch {
        return false;
      } finally {
        setTimeout(() => {
          refreshing = null;
        }, 0);
      }
    })();
  }
  return refreshing;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    method = 'GET',
    body,
    auth = false,
    formData,
    signal,
    retryOn401 = true,
    viaMarket = false,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = options;
  // 数据私有化统一入口拦截：非应用商店请求一律不发网络、直接抛 PrivacyModeError，调用方静默降级
  if (!viaMarket && isPrivacyMode()) throw new PrivacyModeError();
  const url = viaMarket ? resolveMarketApiUrl(path) : resolveApiUrl(path);
  const headers: Record<string, string> = {};
  if (!formData && body !== undefined) headers['content-type'] = 'application/json';
  if (auth) {
    const token = getAccessToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }

  /*
   * 超时与外部 signal 合并：
   * - 外部 signal 用来支持「用户主动取消」（例如 AI 流式回答点停止）；
   * - 内部定时器用来兜住「服务端不回包」的死等情况。
   * 两者都映射到同一个 controller，但只有内部定时器触发才判定为超时错误，
   * 避免把用户取消误报成网络超时。
   */
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onExternalAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: formData ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: controller.signal,
    });

    if (res.status === 401 && auth && retryOn401) {
      const ok = await tryRefresh();
      if (ok) return api<T>(path, { ...options, retryOn401: false });
    }

    let json: ApiEnvelope<T> | null = null;
    try {
      json = (await res.json()) as ApiEnvelope<T>;
    } catch {
      json = null;
    }
    if (!res.ok || !json || json.ok !== true) {
      const message = json?.error?.message ?? `请求失败 (${res.status})`;
      throw new ApiError(message, json?.error?.code ?? 'http_error', res.status);
    }
    return json.data as T;
  } catch (e) {
    // 只在"我们自己的超时"触发时改写异常；用户主动取消原样抛出（AbortError）
    if (timedOut) {
      throw new ApiError(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`, 'timeout', 0);
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

export const authApi = {
  register: (body: { email: string; username: string; password: string }) =>
    api<{ accessToken: string; refreshToken: string; user: UserDto }>('/api/auth/register', { method: 'POST', body }),
  login: (body: { account: string; password: string; deviceId?: string }) =>
    api<{ accessToken: string; refreshToken: string; user: UserDto }>('/api/auth/login', { method: 'POST', body }),
  logout: () => api<{ ok: boolean }>('/api/auth/logout', { method: 'POST', auth: true }),
  me: async () => {
    const data = await api<{ user: UserDto; stats?: Record<string, number> } | UserDto>('/api/auth/me', { auth: true });
    // 服务端返回 { user, stats }，这里统一成 UserDto
    return 'user' in data ? data.user : (data as UserDto);
  },
  changePassword: (body: { oldPassword: string; newPassword: string }) =>
    api<{ ok: boolean }>('/api/auth/password', { method: 'PUT', body, auth: true }),
};

export interface UserDto {
  id: number;
  email: string;
  username: string;
  role: 'user' | 'admin';
  status: 'active' | 'disabled';
  quotaBytes: number;
  usedBytes?: number;
  createdAt?: string;
  lastLoginAt?: string | null;
  /* 以下为 V2 个人资料字段，服务端在 /api/profile 与 /api/auth/me 中按需返回 */
  nickname?: string | null;
  avatarUrl?: string | null;
  credits?: number;
}

export const settingsApi = {
  get: () => api<{ payload: Record<string, unknown>; sensitive: Record<string, unknown>; version: number }>('/api/settings', { auth: true }),
  put: (body: { payload: unknown; sensitive: unknown; version: number; deviceId: string }) =>
    api<{ version: number }>('/api/settings', { method: 'PUT', body, auth: true }),
};

export interface ShareItemDto {
  id: number;
  token: string;
  title: string;
  url?: string;
  hasPassword?: boolean;
  allowComment?: boolean;
  commentCount?: number;
  createdAt: string;
  viewCount: number;
  revokedAt: string | null;
}

export interface PublishItemDto {
  id: number;
  slug: string;
  url: string;
  title: string;
  createdAt: string;
  revokedAt: string | null;
}

export const shareApi = {
  create: (body: {
    docId: string;
    title: string;
    markdown: string;
    mode: 'read' | 'comment';
    allowComment: boolean;
    expiresInDays?: number;
    accessCode?: string;
    style?: Record<string, unknown>;
  }) => api<{ token: string; url: string; hasPassword?: boolean }>('/api/shares', { method: 'POST', body, auth: true }),
  list: async (): Promise<ShareItemDto[]> => {
    const res = await api<ShareItemDto[] | { items: ShareItemDto[] }>('/api/shares', { auth: true });
    return Array.isArray(res) ? res : (res?.items ?? []);
  },
  comments: (shareId: number) =>
    api<{
      items: Array<{ id: number; authorName: string; body: string; quote?: string; status: string; createdAt: string }>;
    }>(`/api/shares/${shareId}/comments`, { auth: true }),
  revoke: (id: number) => api<{ ok: boolean }>(`/api/shares/${id}`, { method: 'DELETE', auth: true }),
  getPublic: (token: string, accessCode?: string) => {
    const q = accessCode ? `?code=${encodeURIComponent(accessCode)}` : '';
    return api<{
      title: string;
      html: string;
      allowComment: boolean;
      hasPassword?: boolean;
      createdAt: string;
      author?: { username: string; nickname: string; avatarUrl: string | null };
      shareStyle?: {
        brandTitle?: string;
        brandSubtitle?: string;
        accentColor?: string;
        paperStyle?: 'white' | 'warm' | 'green' | 'dark';
        hideProductBrand?: boolean;
      } | null;
      comments: Array<{
        id: number;
        authorName: string;
        body: string;
        createdAt: string;
        annotation?: { quote: string; selector: unknown } | null;
      }>;
    }>(`/api/public/shares/${encodeURIComponent(token)}${q}`);
  },
  addComment: (token: string, body: { authorName: string; body: string; annotation?: { quote: string; selector: unknown } | null }) =>
    api<{ id: number }>(`/api/public/shares/${encodeURIComponent(token)}/comments`, { method: 'POST', body }),
  view: (token: string) =>
    api<{ ok: boolean }>(`/api/public/shares/${encodeURIComponent(token)}/view`, { method: 'POST' }),
};

export const publishApi = {
  create: (body: { docId: string; title: string; markdown: string }) =>
    api<{ slug: string; url: string }>('/api/publish', { method: 'POST', body, auth: true }),
  list: async (): Promise<PublishItemDto[]> => {
    const res = await api<PublishItemDto[] | { items: PublishItemDto[] }>('/api/publish', { auth: true });
    return Array.isArray(res) ? res : (res?.items ?? []);
  },
  revoke: (id: number) => api<{ ok: boolean }>(`/api/publish/${id}`, { method: 'DELETE', auth: true }),
};

/** 对象存储代探的单个步骤（列举 / 写入 / 读取 / 删除） */
export interface OssProbeStepDto {
  name: 'list' | 'put' | 'get' | 'delete';
  ok: boolean;
  message: string;
  latencyMs: number;
}

/**
 * 服务端代探结果。
 * 注意：探测本身失败时接口仍是 HTTP 200，需判 `ok` 字段而非依赖 catch。
 */
export interface OssProbeResultDto {
  ok: boolean;
  canList: boolean;
  canPut: boolean;
  canGet: boolean;
  canDelete: boolean;
  latencyMs: number;
  message: string;
  /** 逐步明细，旧版服务端可能不返回，前端需容忍缺省 */
  steps?: OssProbeStepDto[];
}

export const uploadApi = {
  upload: (form: FormData) => api<{ url: string; key: string; size: number }>('/api/upload', { method: 'POST', formData: form, auth: true }),
  presign: (body: { filename: string; contentType: string; size: number }) =>
    api<{ url: string; publicUrl: string; key: string }>('/api/upload/presign', { method: 'POST', body, auth: true }),
  /**
   * 对象存储连通性自检：由服务端代探（浏览器直连 OSS 会被 CORS 拦截）。
   * 传空 `storage` 时服务端会回退到平台内置存储配置。
   */
  probe: (body: { storage?: Partial<StorageConfig>; prefix?: string }) =>
    api<OssProbeResultDto>('/api/oss/probe', { method: 'POST', body, auth: true }),
};

export interface AdminStats {
  users: { total: number; active: number; disabled: number; admins: number; newToday: number; newThisWeek: number };
  shares: { total: number; active: number; views: number };
  publishes: { total: number; active: number };
  comments: { total: number; hidden: number };
  storage: { bytes: number; documents: number; vaults: number };
  ai: { requests24h: number; inTokens24h: number; outTokens24h: number };
  signupsDaily: Array<{ date: string; count: number }>;
  uptimeSeconds: number;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page?: number;
  size?: number;
}

export const adminApi = {
  stats: () => api<AdminStats>('/api/admin/stats', { auth: true }),
  users: (query: { page?: number; size?: number; search?: string }) => {
    const q = new URLSearchParams();
    if (query.page) q.set('page', String(query.page));
    if (query.size) q.set('size', String(query.size));
    if (query.search) q.set('search', query.search);
    return api<Paged<UserDto>>(`/api/admin/users?${q}`, { auth: true });
  },
  updateUser: (id: number, body: { role?: string; status?: string; quotaBytes?: number }) =>
    api<{ ok: boolean }>(`/api/admin/users/${id}`, { method: 'PUT', body, auth: true }),
  resetPassword: (id: number) => api<{ password: string }>(`/api/admin/users/${id}/reset-password`, { method: 'POST', auth: true }),
  deleteUser: (id: number) => api<{ ok: boolean }>(`/api/admin/users/${id}`, { method: 'DELETE', auth: true }),
  shares: (query: { page?: number; size?: number }) =>
    api<Paged<Record<string, unknown>>>(`/api/admin/shares?page=${query.page ?? 1}&size=${query.size ?? 20}`, { auth: true }),
  revokeShare: (id: number) => api<{ ok: boolean }>(`/api/admin/shares/${id}`, { method: 'DELETE', auth: true }),
  publishes: (query: { page?: number; size?: number }) =>
    api<Paged<Record<string, unknown>>>(`/api/admin/publishes?page=${query.page ?? 1}&size=${query.size ?? 20}`, { auth: true }),
  revokePublish: (id: number) => api<{ ok: boolean }>(`/api/admin/publishes/${id}`, { method: 'DELETE', auth: true }),
  audit: (query: { page?: number; size?: number }) =>
    api<Paged<Record<string, unknown>>>(`/api/admin/audit?page=${query.page ?? 1}&size=${query.size ?? 30}`, { auth: true }),
  comments: (query: { page?: number; size?: number }) =>
    api<Paged<Record<string, unknown>>>(`/api/admin/comments?page=${query.page ?? 1}&size=${query.size ?? 20}`, { auth: true }),
  setCommentStatus: (id: number, status: 'visible' | 'hidden') =>
    api<{ ok: boolean }>(`/api/admin/comments/${id}`, { method: 'PUT', body: { status }, auth: true }),
};

/* ---------------- V2 --------------- */

export interface UserProfileDto extends UserDto {
  nickname?: string | null;
  avatarUrl?: string | null;
  credits?: number;
}

export const profileApi = {
  get: () => api<{ user: UserProfileDto; stats: Record<string, number> }>('/api/profile', { auth: true }),
  update: (body: { nickname?: string; avatarUrl?: string }) =>
    api<{ user: UserProfileDto }>('/api/profile', { method: 'PUT', body, auth: true }),
  changePassword: (body: { oldPassword: string; newPassword: string }) =>
    api<{ ok: boolean }>('/api/profile/password', { method: 'PUT', body, auth: true }),
  backups: () =>
    api<{ items: Array<{ id: number; vaultId: string; name: string; docCount: number; bytes: number; url: string; createdAt: string }> }>(
      '/api/profile/backups',
      { auth: true },
    ),
  createBackup: (body: { vaultId: string; name: string; docCount: number; bytes: number; ossKey: string }) =>
    api<{ backup: unknown }>('/api/profile/backups', { method: 'POST', body, auth: true }),
  deleteBackup: (id: number) => api<{ ok: boolean }>(`/api/profile/backups/${id}`, { method: 'DELETE', auth: true }),
  uploadAvatar: (form: FormData) => api<{ url: string }>('/api/profile/avatar', { method: 'POST', formData: form, auth: true }),
};

export const creditsApi = {
  balance: () => api<{ balance: number; ledger: Array<Record<string, unknown>> }>('/api/credits', { auth: true }),
  redeem: (code: string) => api<{ added: number; balance: number }>('/api/credits/redeem', { method: 'POST', body: { code }, auth: true }),
  pricing: () =>
    api<{
      creditPerYuan: number;
      modelPrices: Record<string, { in: number; out: number }>;
      paymentMethods: Array<{ id: string; name: string; note: string; enabled: boolean }>;
      currency: string;
    }>('/api/credits/pricing'),
};

export const downloadApi = {
  list: () =>
    api<{ files: Array<{ file: string; title: string; platform: 'windows' | 'android'; size: number; url: string }> }>(
      '/api/download/list',
    ),
};

/* ------------------------------------------------------------------ */
/* 仓库管理（1.1.5）                                                    */
/*                                                                     */
/* 服务端 `user_vaults` 表按 (user_id, vault_id) 存仓库档案，           */
/* 用于「跨端看到同一批仓库」与「云端备份 / 停用状态」。                 */
/* 本机仓库列表仍以 localStorage 为准（见 stores/app.ts 的 vaults），    */
/* 这里只负责云端档案的增删改查。                                       */
/* ------------------------------------------------------------------ */

/** 仓库云端档案（服务端投影） */
export interface VaultDto {
  vaultId: string;
  name: string;
  /** 文档数（服务端只存统计快照，不存内容） */
  docCount?: number;
  /** 占用字节数 */
  bytes?: number;
  /** active 正常 / disabled 已停用（停用后数据保留，仅标记不可用） */
  status?: 'active' | 'disabled';
  /** 上次同步时间（ISO 字符串） */
  lastSyncedAt?: string | null;
  /** 创建时间 */
  createdAt?: string | null;
  /** 是否已存在于云端档案（本机新仓库可能尚未上报） */
  synced?: boolean;
}

export const vaultsApi = {
  /** 列出当前账号下的全部仓库档案 */
  list: () => api<{ vaults: VaultDto[] }>('/api/vaults', { auth: true }),
  /** 新建或更新仓库档案（首次上报时用） */
  upsert: (body: { vaultId: string; name: string; docCount?: number; bytes?: number }) =>
    api<{ vault: VaultDto }>('/api/vaults', { method: 'POST', body, auth: true }),
  /** 改名 / 停用启用 */
  update: (vaultId: string, body: { name?: string; status?: 'active' | 'disabled' }) =>
    api<{ vault: VaultDto }>(`/api/vaults/${encodeURIComponent(vaultId)}`, {
      method: 'PATCH',
      body,
      auth: true,
    }),
  /** 删除仓库档案；purge=true 时同时清理云端备份与历史版本 */
  remove: (vaultId: string, purge = false) =>
    api<{ ok: boolean }>(`/api/vaults/${encodeURIComponent(vaultId)}${purge ? '?purge=1' : ''}`, {
      method: 'DELETE',
      auth: true,
    }),
  /** 复制仓库（服务端为副本分配新 vaultId） */
  copy: (vaultId: string, body: { newVaultId: string; newName: string }) =>
    api<{ vault: VaultDto }>(`/api/vaults/${encodeURIComponent(vaultId)}/copy`, {
      method: 'POST',
      body,
      auth: true,
    }),
};

/**
 * AI 连通性自检结果。
 * 注意：连通失败时接口仍是 HTTP 200，需判 `ok` 字段而非依赖 catch；
 * `message` 为服务端给出的中文原因（如「平台积分不足」「管理员尚未启用平台 AI 供应商」）。
 */
export interface AiTestResultDto {
  ok: boolean;
  mode: 'platform' | 'byok';
  message: string;
  latencyMs: number;
  /** 由服务端代拉的可用模型列表（平台模式或 BYOK 复用同一套上游凭证时可用） */
  models?: string[];
}

export const aiApi = {
  models: (provider: string, userKey?: string) => {
    const q = new URLSearchParams({ provider });
    const headers = userKey ? { 'x-user-ai-key': userKey } : undefined;
    return api<{ models: Array<{ id: string; owned_by?: string }>; source: 'upstream' | 'static'; message?: string }>(
      `/api/ai/models?${q}`,
      { headers } as never,
    ).catch(() => null);
  },
  /** 由服务端代测 AI 连通性（平台通道或自带 Key），避免网页端直连第三方接口被跨域拦截 */
  test: (body: { provider: string; baseUrl?: string; apiKey?: string; model?: string; usePlatform?: boolean }) =>
    api<AiTestResultDto>('/api/ai/test', { method: 'POST', body, auth: true }),
  usage: () =>
    api<{
      balance: number;
      tokensToday: number;
      costToday: number;
      history: Array<{ model: string; inTokens: number; outTokens: number; cost: number; createdAt: string }>;
    }>('/api/ai/usage', { auth: true }),
};

export interface CommunityPluginDto {
  id: number;
  pluginId: string;
  userId: number;
  authorName: string;
  name: string;
  version: string;
  category: 'core' | 'navigation' | 'writing' | 'data' | 'visual' | 'collab';
  icon: string;
  description: string;
  readmeMd: string;
  codeJs?: string;
  status: 'published' | 'pending' | 'rejected' | 'disabled';
  downloads: number;
  stars: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 应用商店（插件市场）接口。
 *
 * **产品硬要求**：以下所有请求都通过 `viaMarket: true` 走官方服务端
 * （`https://md.zhengl.vip`），既忽略桌面端自建服务器配置，也不受数据私有化模式影响。
 * 私有化部署不提供应用商店。
 */
export const pluginsApi = {
  market: (query: { category?: string; search?: string } = {}) => {
    const q = new URLSearchParams();
    if (query.category) q.set('category', query.category);
    if (query.search) q.set('search', query.search);
    return api<{ items: CommunityPluginDto[] }>(`/api/plugins/market?${q}`, { viaMarket: true });
  },
  my: () =>
    api<{
      items: CommunityPluginDto[];
      stats: { publishedCount: number; totalCount: number; totalDownloads: number; totalStars: number };
    }>('/api/plugins/my', { auth: true, viaMarket: true }),
  publish: (body: {
    pluginId: string;
    name: string;
    version: string;
    category: string;
    icon?: string;
    description: string;
    readmeMd?: string;
    codeJs: string;
  }) => api<{ plugin: CommunityPluginDto }>('/api/plugins', { method: 'POST', body, auth: true, viaMarket: true }),
  update: (
    pluginId: string,
    body: {
      name?: string;
      version?: string;
      category?: string;
      icon?: string;
      description?: string;
      readmeMd?: string;
      codeJs?: string;
    },
  ) =>
    api<{ plugin: CommunityPluginDto }>(`/api/plugins/${encodeURIComponent(pluginId)}`, {
      method: 'PUT',
      body,
      auth: true,
      viaMarket: true,
    }),
  remove: (pluginId: string) =>
    api<{ deleted: boolean }>(`/api/plugins/${encodeURIComponent(pluginId)}`, {
      method: 'DELETE',
      auth: true,
      viaMarket: true,
    }),
  download: (pluginId: string) =>
    api<{ plugin: CommunityPluginDto }>(`/api/plugins/${encodeURIComponent(pluginId)}/download`, {
      method: 'POST',
      viaMarket: true,
    }),
  star: (pluginId: string) =>
    api<{ stars: number }>(`/api/plugins/${encodeURIComponent(pluginId)}/star`, { method: 'POST', viaMarket: true }),
};

export interface ModelPriceRule {
  mode?: 'tokens' | 'request' | 'free';
  in: number;
  out: number;
  perCall?: number;
  providers?: string[];
}

export const adminApiV2 = {
  ai: () =>
    api<{
      providers: Array<{
        provider: string;
        name: string;
        baseUrl: string;
        enabled: boolean;
        priority?: number;
        apiKeySet: boolean;
        models: string[];
        updatedAt: string;
      }>;
    }>('/api/admin/ai', { auth: true }),
  saveAi: (provider: string, body: { baseUrl?: string; enabled?: boolean; priority?: number; models?: string[]; apiKey?: string }) =>
    api<{ ok: boolean }>(`/api/admin/ai/${provider}`, { method: 'PUT', body, auth: true }),
  billing: () =>
    api<{
      creditPerYuan: number;
      signupGrantCredits?: number;
      dailyGrantCredits?: number;
      modelPrices: Record<string, ModelPriceRule>;
      paymentMethods: Array<{ id: string; name: string; note: string; enabled: boolean }>;
    }>('/api/admin/billing', { auth: true }),
  saveBilling: (body: Record<string, unknown>) => api<{ ok: boolean }>('/api/admin/billing', { method: 'PUT', body, auth: true }),
  redeemCodes: (page = 1, size = 30) =>
    api<{ items: Array<Record<string, unknown>>; total: number }>(`/api/admin/redeem-codes?page=${page}&size=${size}`, { auth: true }),
  createCodes: (body: { count: number; credits: number }) =>
    api<{ codes?: string[]; items?: Array<{ code: string }> }>('/api/admin/redeem-codes', { method: 'POST', body, auth: true }),
  deleteCode: (id: number) => api<{ ok: boolean }>(`/api/admin/redeem-codes/${id}`, { method: 'DELETE', auth: true }),
  releases: () =>
    api<{ files: Array<{ key: string; size: number; lastModified: string; url: string }> }>('/api/admin/releases', { auth: true }),
  userDetail: (id: number) => api<Record<string, unknown>>(`/api/admin/users/${id}`, { auth: true }),
  adjustCredits: (id: number, body: { amount: number; reason: string }) =>
    api<{ ok: boolean }>(`/api/admin/users/${id}/credits`, { method: 'PUT', body, auth: true }),
  shareComments: (shareId: number) =>
    api<{
      items: Array<{ id: number; shareId: number; authorName: string; body: string; quote?: string; status: 'visible' | 'hidden'; createdAt: string }>;
    }>(`/api/admin/shares/${shareId}/comments`, { auth: true }),
  plugins: (page = 1, size = 30, search = '') =>
    api<{ items: CommunityPluginDto[]; total: number }>(
      `/api/admin/plugins?page=${page}&pageSize=${size}&search=${encodeURIComponent(search)}`,
      { auth: true },
    ),
  setPluginStatus: (id: number, status: 'published' | 'pending' | 'rejected' | 'disabled') =>
    api<{ id: number; status: string }>(`/api/admin/plugins/${id}/status`, { method: 'PUT', body: { status }, auth: true }),
};

/* ------------------------------------------------------------------ */
/* AI 供应商展示元数据（1.1.7 新增，仅追加）                          */
/* ------------------------------------------------------------------ */

/**
 * 前台展示用的供应商条目。
 *
 * 1.1.7 起「启用状态 / 申请地址 / 文档地址 / 说明文案 / 排序」由管理后台配置，
 * 前台**只读**消费这些字段，不再使用写死在内置预设里的 console 链接。
 */
export interface AiProviderMetaDto {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  defaultModel: string;
  docs?: string;
  supportsCors?: boolean;
  docsUrl: string;
  apiKeyUrl: string;
  /** 申请 Key 的地址（后台可配置） */
  signupUrl: string;
  /** 说明文案（后台可配置） */
  note: string;
  /** 展示排序，升序（后台可配置） */
  sortOrder: number;
  /** 管理员是否启用该平台供应商 */
  enabled: boolean;
  /** `platform` = 平台代付；`custom` = 自建/自定义 */
  group: 'platform' | 'custom';
}

/** 后台可编辑的完整元数据（含默认值与密钥状态） */
export interface AdminAiProviderMetaDto {
  provider: string;
  name: string;
  enabled: boolean;
  signupUrl: string;
  docsUrl: string;
  note: string;
  sortOrder: number;
  group: 'platform' | 'custom';
  modelCount: number;
  apiKeySet: boolean;
  defaults: { signupUrl: string; docsUrl: string; note: string; sortOrder: number };
  updatedAt: string | null;
}

/**
 * 供应商展示元数据接口。
 *
 * 前台 `providers()` 公开可读（无需登录），供设置页渲染分组、状态徽章与「去申请」链接；
 * 后台 `meta()` / `saveMeta()` 需要管理员权限，只改展示字段，不涉及密钥与接口地址。
 */
export const aiProvidersApi = {
  /** 前台只读：拿后台下发的供应商展示配置 */
  providers: () =>
    api<{ providers: AiProviderMetaDto[] }>('/api/ai/providers').catch(() => null),
  /** 后台读：含默认值（用于「恢复默认」按钮）与密钥配置状态 */
  meta: () =>
    api<{ providers: AdminAiProviderMetaDto[] }>('/api/admin/ai-providers-meta', { auth: true }),
  /** 后台写：批量保存展示字段，字符串传空串表示恢复默认 */
  saveMeta: (
    providers: Array<{
      provider: string;
      enabled?: boolean;
      signupUrl?: string;
      docsUrl?: string;
      note?: string;
      sortOrder?: number;
    }>,
  ) =>
    api<{ providers: Array<Partial<AdminAiProviderMetaDto> & { provider: string }> }>(
      '/api/admin/ai-providers-meta',
      { method: 'PUT', body: { providers }, auth: true },
    ),
};

/* ------------------------------------------------------------------ */
/* 1.1.7 后台管理端：数据看板与扩展管理（仅追加）                       */
/* ------------------------------------------------------------------ */

/** 看板趋势的单日数据点 */
export interface AdminTrendPoint {
  date: string;
  newUsers: number;
  activeUsers: number;
  aiCalls: number;
  knowledgeQueries: number;
  syncBytes: number;
}

/** AI 供应商调用占比 */
export interface AdminProviderShare {
  provider: string;
  name: string;
  calls: number;
  inTokens: number;
  outTokens: number;
  cost: number;
  /** 占全部调用的比例，0~1，调用总数为 0 时为 0 */
  share: number;
}

/** 仓库文档数 Top N */
export interface AdminVaultTopItem {
  vaultId: string;
  name: string;
  username: string | null;
  docCount: number;
  bytes: number;
  status: 'active' | 'disabled';
  lastSyncedAt: string | null;
}

/** 存储占用 Top N 用户 */
export interface AdminStorageTopItem {
  userId: number;
  username: string | null;
  bytes: number;
  docCount: number;
  vaults: number;
}

/** 实时状态：数据库 / 对象存储 / 队列 */
export interface AdminRealtimeStatus {
  ok: boolean;
  db: { ok: boolean; error: string | null };
  oss: { configured: boolean; ok: boolean | null; message: string; latencyMs: number };
  /** 本服务为同步处理模型，没有消息队列，固定为 null */
  queue: null;
  auditEvents24h: number;
  uptimeSeconds: number;
  version: string;
  env: string;
  latencyMs: number;
  checkedAt: string;
}

/**
 * 环比数据（1.1.8 看板）。
 *
 * `delta` 为今日相对昨日的百分比变化（0.15 = +15%）；
 * `null` 表示「昨日无可比基数」，前端应显示「新增」而不是无穷大。
 */
export interface AdminCompareItem {
  today: number;
  yesterday: number;
  delta: number | null;
}

/** 看板全量数据 */
export interface AdminDashboard {
  range: { days: number; span: number };
  metrics: {
    users: { total: number; active: number; disabled: number; admins: number; newToday: number; newThisWeek: number; activeToday: number };
    documents: { total: number; vaults: number; disabledVaults: number };
    storage: { bytes: number; backupBytes: number; backups: number };
    ai: {
      callsToday: number;
      callsTotal: number;
      inTokensToday: number;
      outTokensToday: number;
      inTokensTotal: number;
      outTokensTotal: number;
      costToday: number;
      /** 今日失败调用数（1.1.8） */
      errorsToday: number;
      /** 今日失败率 0~1（1.1.8） */
      failRateToday: number;
      /** 今日平均响应时间 ms（1.1.8，仅统计成功且有耗时的调用） */
      avgLatencyToday: number;
    };
    knowledge: { queriesToday: number; queriesTotal: number; chunksToday: number; contextCharsToday: number };
    credits: { circulating: number; consumedToday: number; rechargedToday: number };
  };
  /** 今日 vs 昨日的环比（1.1.8） */
  compare: {
    users: AdminCompareItem;
    ai: AdminCompareItem;
    knowledge: AdminCompareItem;
  };
  trends: AdminTrendPoint[];
  distributions: {
    aiProviders: AdminProviderShare[];
    vaultsTop: AdminVaultTopItem[];
    storageTop: AdminStorageTopItem[];
  };
  status: AdminRealtimeStatus;
  generatedAt: string;
}

/** 仓库管理列表项 */
export interface AdminVaultDto {
  id: number;
  userId: number;
  username: string | null;
  email: string | null;
  vaultId: string;
  name: string;
  docCount: number;
  bytes: number;
  status: 'active' | 'disabled';
  lastSyncedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** 积分流水条目 */
export interface AdminLedgerDto {
  id: number;
  delta: number;
  balanceAfter: number;
  kind: 'recharge' | 'consume' | 'grant' | 'refund';
  ref: string | null;
  detail: unknown;
  createdAt: string | null;
  username: string | null;
  email: string | null;
}

/** 配置中心条目 */
export interface AdminConfigItem {
  key: string;
  value: string;
  /** 敏感项的值已打码为 ••••••，原样保存会被忽略 */
  sensitive: boolean;
  updatedAt: string | null;
}

/**
 * 后台数据看板与扩展管理接口（1.1.7 新增）。
 *
 * 与既有 `adminApi` / `adminApiV2` 互不重叠，只做新增，方便后续拆分。
 */
export const adminApiV3 = {
  /** 看板全量数据：`days` 支持 1~90，默认 7 */
  dashboard: (days = 7) => api<AdminDashboard>(`/api/admin/dashboard?days=${days}`, { auth: true }),

  /** 实时状态（可单独轮询，比拉全量看板轻） */
  status: () => api<AdminRealtimeStatus>('/api/admin/status', { auth: true }),

  /** 仓库管理列表 */
  vaults: (query: { page?: number; pageSize?: number; search?: string; status?: string } = {}) => {
    const q = new URLSearchParams();
    if (query.page) q.set('page', String(query.page));
    if (query.pageSize) q.set('pageSize', String(query.pageSize));
    if (query.search) q.set('search', query.search);
    if (query.status) q.set('status', query.status);
    return api<{
      items: AdminVaultDto[];
      page: number;
      pageSize: number;
      total: number;
      summary: { total: number; bytes: number; docs: number; disabled: number };
    }>(`/api/admin/vaults?${q}`, { auth: true });
  },
  setVaultStatus: (id: number, status: 'active' | 'disabled') =>
    api<{ id: number; status: string }>(`/api/admin/vaults/${id}`, { method: 'PUT', body: { status }, auth: true }),
  deleteVault: (id: number) => api<{ deleted: boolean; id: number }>(`/api/admin/vaults/${id}`, { method: 'DELETE', auth: true }),

  /** 积分流水 */
  ledger: (query: { page?: number; pageSize?: number; search?: string; userId?: number; kind?: string } = {}) => {
    const q = new URLSearchParams();
    if (query.page) q.set('page', String(query.page));
    if (query.pageSize) q.set('pageSize', String(query.pageSize));
    if (query.search) q.set('search', query.search);
    if (query.userId) q.set('userId', String(query.userId));
    if (query.kind) q.set('kind', query.kind);
    return api<{
      items: AdminLedgerDto[];
      page: number;
      pageSize: number;
      total: number;
      summary: { inflow: number; outflow: number };
    }>(`/api/admin/ledger?${q}`, { auth: true });
  },

  /** 配置中心：读取全部配置（敏感项值已打码） */
  config: () => api<{ items: AdminConfigItem[] }>('/api/admin/config', { auth: true }),
  /** 配置中心：批量保存。传打码值 •••••• 的项会被服务端跳过 */
  saveConfig: (entries: Array<{ key: string; value: string }>) =>
    api<{ updated: number; skipped?: boolean; keys?: string[] }>('/api/admin/config', {
      method: 'PUT',
      body: { entries },
      auth: true,
    }),
};


/* ==== 1.1.8 追加：平台模型治理 + 知识库令牌 ==== */

/**
 * 平台「对外开放」的单个模型（前台「平台 AI 服务」区块消费）。
 *
 * 刻意**不含** provider 的 baseUrl / apiKey：用户只需知道「有哪些模型可选、
 * 温度与 token 上限是多少、大概多少钱」，实现细节由后台管理。
 */
export interface PlatformModelDto {
  model: string;
  /** 内部供应商标识（仅用于展示来源，不含凭证） */
  provider: string;
  providerName: string;
  temperature: number;
  maxTokens: number;
  priceIn: number;
  priceOut: number;
  /** 后台为该模型配置的默认系统提示词（前台只读展示） */
  systemPrompt: string;
  isDefault: boolean;
}

/** 后台视角的「每模型设置」 */
export interface ModelSettingDto {
  enabled?: boolean;
  temperature?: number;
  maxTokens?: number;
  priceIn?: number;
  priceOut?: number;
  systemPrompt?: string;
}

/** 后台视角的供应商模型治理配置 */
export interface AdminAiModelProviderDto {
  provider: string;
  name: string;
  enabled: boolean;
  apiKeySet: boolean;
  models: string[];
  defaultModel: string;
  systemPrompt: string;
  modelSettings: Record<string, ModelSettingDto>;
  defaults: { signupUrl: string; docsUrl: string; note: string; sortOrder: number; defaultModel?: string };
  /** 每模型的生效值（模型级 > 供应商兜底 > 内置默认），含来源标记 */
  resolved: Array<{
    model: string;
    enabled: boolean;
    temperature: number;
    maxTokens: number;
    priceIn: number;
    priceOut: number;
    systemPrompt: string;
    systemPromptSource: 'model' | 'provider' | 'none';
    isDefault: boolean;
  }>;
}

/** 参数上限（后台表单用，避免前端写死） */
export interface AiModelLimitsDto {
  temperature: { min: number; max: number; default: number };
  maxTokens: { min: number; max: number; default: number };
  maxTokensCap: { min: number; max: number; default: number };
  priceIn: { min: number; max: number; default: number };
  priceOut: { min: number; max: number; default: number };
  systemPromptMax: number;
}

/** 知识库访问令牌（列表项，**不含明文与哈希**） */
export interface KnowledgeTokenDto {
  id: number;
  name: string;
  /** 明文前 12 位，用于区分不同令牌 */
  tokenPrefix: string;
  scope: 'read' | 'write';
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string | null;
  status: 'active' | 'revoked' | 'expired';
  usable: boolean;
}

/**
 * 知识库令牌接口（1.1.8）。
 *
 * 安全约定：`create()` 的响应里含一次性明文 `token` 字段，
 * **之后任何接口都不会再返回它**——前端必须当场让用户复制。
 */
export const knowledgeTokensApi = {
  list: () => api<{ tokens: KnowledgeTokenDto[] }>('/api/knowledge/tokens', { auth: true }),
  /** 创建令牌：响应中的 token 是明文，只出现这一次 */
  create: (body: { name: string; scope?: 'read' | 'write'; expiresInDays?: number }) =>
    api<{ token: string; item: KnowledgeTokenDto; warning: string }>('/api/knowledge/tokens', {
      method: 'POST',
      body,
      auth: true,
    }),
  revoke: (id: number) =>
    api<{ item: KnowledgeTokenDto }>(`/api/knowledge/tokens/${id}`, { method: 'DELETE', auth: true }),
  test: (id: number) =>
    api<{
      passed: boolean;
      checks: Array<{ key: string; label: string; ok: boolean; detail: string }>;
      item: KnowledgeTokenDto;
      selfCheckHint: string;
    }>(`/api/knowledge/tokens/${id}/test`, { method: 'POST', body: {}, auth: true }),
};

/**
 * 平台模型治理接口。
 *
 * - `publicModels()`：前台只读，拿「可用模型列表」；
 * - `adminList()` / `adminSave()`：后台读写模型列表、每模型设置与系统提示词。
 */
export const platformModelsApi = {
  /** 前台：平台付费可用的模型清单（无需登录） */
  publicModels: () => api<{ models: PlatformModelDto[] }>('/api/ai/platform-models').catch(() => null),
  /** 后台：读全部治理配置 */
  adminList: () =>
    api<{ providers: AdminAiModelProviderDto[]; models: PlatformModelDto[]; limits: AiModelLimitsDto }>(
      '/api/admin/ai-models',
      { auth: true },
    ),
  /** 后台：保存某供应商的模型治理配置 */
  adminSave: (
    provider: string,
    body: {
      models?: string[];
      defaultModel?: string;
      systemPrompt?: string;
      modelSettings?: Record<string, ModelSettingDto>;
    },
  ) =>
    api<{ provider: AdminAiModelProviderDto }>(`/api/admin/ai-models/${provider}`, {
      method: 'PUT',
      body,
      auth: true,
    }),
};
