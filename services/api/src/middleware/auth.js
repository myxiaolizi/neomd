/**
 * 认证装饰器：authenticate / optionalAuth / requireAdmin。
 * 直接作用于根实例（由 server.js 调用），路由注册在其后即可共享装饰器。
 */
import { queryOne } from '../db/pool.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { forbidden, unauthorized } from '../lib/http.js';
import { LruCache } from '../lib/lru.js';

/** 用户信息短缓存，避免每个请求都打数据库 */
const userCache = new LruCache({ max: 5000, ttlMs: 30_000 });

const USER_COLUMNS =
  'id, email, username, role, status, quota_bytes, created_at, last_login_at, last_login_ip';

/** 从 Authorization 头取 Bearer 令牌 */
export function bearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization;
  if (!header) return null;
  const text = Array.isArray(header) ? header[0] : String(header);
  const match = /^Bearer\s+(.+)$/i.exec(text.trim());
  return match ? match[1].trim() : null;
}

/** 读取用户（带缓存），不存在返回 null */
export async function loadUser(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const cached = userCache.get(`u:${id}`);
  if (cached) return cached;
  const row = await queryOne(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? LIMIT 1`, [id]);
  if (!row) return null;
  const user = {
    id: Number(row.id),
    email: row.email,
    username: row.username,
    role: row.role === 'admin' ? 'admin' : 'user',
    status: row.status,
    quotaBytes: Number(row.quota_bytes ?? 0),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    lastLoginIp: row.last_login_ip,
  };
  userCache.set(`u:${id}`, user);
  return user;
}

/** 用户信息变更后清理缓存 */
export function invalidateUserCache(userId) {
  userCache.delete(`u:${Number(userId)}`);
}

/** 当前请求上下文的登录校验 */
async function resolveRequestUser(req) {
  const token = bearerToken(req);
  if (!token) return { user: null, payload: null, reason: 'missing' };
  const payload = verifyAccessToken(token);
  const user = await loadUser(payload.userId);
  if (!user) return { user: null, payload, reason: 'deleted' };
  if (user.status !== 'active') return { user: null, payload, reason: 'disabled' };
  return { user, payload, reason: 'ok' };
}

/** 注册认证装饰器到根实例 */
export function registerAuth(fastify) {
  fastify.decorateRequest('user', null);
  fastify.decorateRequest('deviceId', null);

  /** 必须登录 */
  fastify.decorate('authenticate', async function authenticate(req) {
    let resolved;
    try {
      resolved = await resolveRequestUser(req);
    } catch (err) {
      if (err && err.status) throw err;
      throw unauthorized('登录凭证无效，请重新登录', 'TOKEN_INVALID');
    }
    if (!resolved.user) {
      if (resolved.reason === 'disabled') throw forbidden('账号已被停用，请联系管理员', 'ACCOUNT_DISABLED');
      throw unauthorized('未登录或登录已过期');
    }
    req.user = resolved.user;
    req.deviceId = resolved.payload?.deviceId ?? null;
  });

  /** 可选登录：无令牌或令牌失效时按游客处理 */
  fastify.decorate('optionalAuth', async function optionalAuth(req) {
    try {
      const resolved = await resolveRequestUser(req);
      req.user = resolved.user ?? null;
      req.deviceId = resolved.payload?.deviceId ?? null;
    } catch {
      req.user = null;
      req.deviceId = null;
    }
  });

  /** 必须管理员（通常跟在 authenticate 之后） */
  fastify.decorate('requireAdmin', async function requireAdmin(req) {
    if (!req.user) throw unauthorized('未登录或登录已过期');
    if (req.user.role !== 'admin') throw forbidden('需要管理员权限', 'ADMIN_REQUIRED');
  });

  return fastify;
}

export default registerAuth;
