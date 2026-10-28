/**
 * 认证路由：注册、登录、刷新、登出、当前用户、修改密码。
 */
import { z } from 'zod';
import { execute, queryOne } from '../db/pool.js';
import config from '../config.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import {
  hashToken,
  refreshExpiryDate,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../lib/jwt.js';
import { conflict, notFound, ok, unauthorized } from '../lib/http.js';
import { deviceIdSchema, emailSchema, parse, passwordSchema, usernameSchema } from '../lib/validate.js';
import { audit, clientIp } from '../lib/audit.js';
import { ipRateLimit } from '../middleware/rate.js';
import { invalidateUserCache } from '../middleware/auth.js';
import { addCredits, grantDailyCreditsIfEligible, loadBilling } from '../lib/platform.js';

/** 对外可见的用户信息（绝不包含 pass_hash） */
export function publicUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    email: row.email,
    username: row.username,
    role: row.role,
    status: row.status ?? 'active',
    quotaBytes: Number(row.quota_bytes ?? config.defaultQuotaBytes),
    createdAt: row.created_at ?? null,
    lastLoginAt: row.last_login_at ?? null,
    lastLoginIp: row.last_login_ip ?? null,
  };
}

/** 签发一对令牌并把刷新令牌写入数据库 */
async function issueTokens(user, deviceId, req) {
  const uid = Number(user.id);
  const role = user.role === 'admin' ? 'admin' : 'user';
  const accessToken = signAccessToken({ userId: uid, role, deviceId });
  const refreshToken = signRefreshToken({ userId: uid, role, deviceId });
  const userAgent = String(req.headers?.['user-agent'] ?? '').slice(0, 255) || null;
  await execute(
    'INSERT INTO refresh_tokens (user_id, token_hash, device_id, user_agent, expires_at, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
    [uid, hashToken(refreshToken), deviceId ? String(deviceId).slice(0, 64) : null, userAgent, refreshExpiryDate()],
  );
  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: config.jwt.accessTtlSeconds,
    refreshExpiresIn: config.jwt.refreshTtlSeconds,
  };
}

const registerSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  password: passwordSchema,
  deviceId: deviceIdSchema,
});

const loginSchema = z
  .object({
    account: z.string().trim().max(190).optional(),
    email: z.string().trim().max(190).optional(),
    username: z.string().trim().max(64).optional(),
    password: z.string({ error: '密码不能为空' }).min(1, { message: '密码不能为空' }).max(128),
    deviceId: deviceIdSchema,
  })
  .refine((v) => Boolean(v.account || v.email || v.username), {
    message: '请填写邮箱或用户名',
    path: ['account'],
  });

const refreshSchema = z.object({
  refreshToken: z.string().min(10, { message: '刷新令牌不能为空' }).max(2048),
  deviceId: deviceIdSchema,
});

const logoutSchema = z.object({
  refreshToken: z.string().max(2048).optional(),
  allDevices: z.boolean().optional().default(false),
});

const passwordSchemaBody = z.object({
  currentPassword: z.string({ error: '请输入当前密码' }).min(1, { message: '请输入当前密码' }).max(128),
  newPassword: passwordSchema,
});

/** 注册路由 */
export async function authRoutes(app) {
  // 注册
  app.post('/api/auth/register', { preHandler: [ipRateLimit('register')] }, async (req, reply) => {
    const body = parse(registerSchema, req.body, '注册信息');

    const existingEmail = await queryOne('SELECT id FROM users WHERE email = ? LIMIT 1', [body.email]);
    if (existingEmail) throw conflict('该邮箱已被注册', 'EMAIL_TAKEN');
    const existingName = await queryOne('SELECT id FROM users WHERE username = ? LIMIT 1', [body.username]);
    if (existingName) throw conflict('该用户名已被占用', 'USERNAME_TAKEN');

    const passHash = await hashPassword(body.password);
    const result = await execute(
      "INSERT INTO users (email, username, pass_hash, role, status, quota_bytes, created_at) VALUES (?, ?, ?, 'user', 'active', ?, NOW())",
      [body.email, body.username, passHash, config.defaultQuotaBytes],
    );
    const userId = Number(result.insertId);
    // 新用户默认赠送积分 + 每日积分
    try {
      const billing = await loadBilling();
      const signupGrant = Number(billing.signupGrantCredits ?? 0);
      if (Number.isFinite(signupGrant) && signupGrant > 0) {
        await addCredits(userId, signupGrant, {
          kind: 'grant',
          ref: 'signup_bonus',
          detail: { reason: '新用户注册赠送积分', amount: signupGrant },
        });
      }
      await grantDailyCreditsIfEligible(userId);
    } catch {
      /* 赠送异常不阻断注册 */
    }
    const user = await queryOne(
      'SELECT id, email, username, role, status, quota_bytes, credits, created_at, last_login_at, last_login_ip FROM users WHERE id = ?',
      [userId],
    );
    const tokens = await issueTokens(user, body.deviceId ?? null, req);
    await audit(req, 'auth.register', `user:${userId}`, { email: body.email, username: body.username }, userId);

    return ok(reply, { user: publicUser(user), ...tokens }, 201);
  });

  // 登录
  app.post('/api/auth/login', { preHandler: [ipRateLimit('login')] }, async (req, reply) => {
    const body = parse(loginSchema, req.body, '登录信息');
    const identifier = (body.email || body.username || body.account || '').trim();
    const byEmail = identifier.includes('@');

    const user = await queryOne(
      byEmail
        ? 'SELECT * FROM users WHERE email = ? LIMIT 1'
        : 'SELECT * FROM users WHERE username = ? OR email = ? LIMIT 1',
      byEmail ? [identifier.toLowerCase()] : [identifier, identifier.toLowerCase()],
    );

    if (!user) {
      await audit(req, 'auth.login_failed', `account:${identifier}`, { reason: 'not_found' }, null);
      throw unauthorized('邮箱/用户名或密码不正确', 'LOGIN_FAILED');
    }
    const passed = await verifyPassword(user.pass_hash, body.password);
    if (!passed) {
      await audit(req, 'auth.login_failed', `user:${user.id}`, { reason: 'bad_password' }, Number(user.id));
      throw unauthorized('邮箱/用户名或密码不正确', 'LOGIN_FAILED');
    }
    if (user.status !== 'active') {
      await audit(req, 'auth.login_failed', `user:${user.id}`, { reason: 'disabled' }, Number(user.id));
      throw unauthorized('账号已被停用，请联系管理员', 'ACCOUNT_DISABLED');
    }

    const ip = clientIp(req);
    await execute('UPDATE users SET last_login_at = NOW(), last_login_ip = ? WHERE id = ?', [ip, user.id]);
    await grantDailyCreditsIfEligible(Number(user.id));
    invalidateUserCache(user.id);

    const tokens = await issueTokens(user, body.deviceId ?? null, req);
    const fresh = { ...user, last_login_at: new Date(), last_login_ip: ip };
    await audit(req, 'auth.login', `user:${user.id}`, { deviceId: body.deviceId ?? null }, Number(user.id));

    return ok(reply, { user: publicUser(fresh), ...tokens });
  });

  // 刷新令牌（轮换）
  app.post('/api/auth/refresh', async (req, reply) => {
    const body = parse(refreshSchema, req.body, '刷新参数');
    const payload = verifyRefreshToken(body.refreshToken);
    const tokenHash = hashToken(body.refreshToken);

    const row = await queryOne(
      'SELECT id, user_id, device_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ? LIMIT 1',
      [tokenHash],
    );
    if (!row || row.revoked_at) {
      throw unauthorized('刷新令牌已失效，请重新登录', 'REFRESH_REVOKED');
    }
    if (new Date(String(row.expires_at).replace(' ', 'T') + 'Z').getTime() <= Date.now()) {
      throw unauthorized('刷新令牌已过期，请重新登录', 'REFRESH_EXPIRED');
    }

    const user = await queryOne('SELECT * FROM users WHERE id = ? LIMIT 1', [payload.userId]);
    if (!user) throw unauthorized('账号不存在，请重新登录', 'USER_NOT_FOUND');
    if (user.status !== 'active') throw unauthorized('账号已被停用，请联系管理员', 'ACCOUNT_DISABLED');

    // 旧令牌立即作废，签发新令牌
    await execute('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ?', [row.id]);
    const tokens = await issueTokens(user, body.deviceId ?? row.device_id ?? null, req);
    return ok(reply, { user: publicUser(user), ...tokens });
  });

  // 登出
  app.post('/api/auth/logout', { preHandler: [app.optionalAuth] }, async (req, reply) => {
    const body = parse(logoutSchema, req.body ?? {}, '登出参数');
    if (body.allDevices && req.user) {
      await execute('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [req.user.id]);
      await audit(req, 'auth.logout_all', `user:${req.user.id}`);
    } else if (body.refreshToken) {
      await execute('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = ? AND revoked_at IS NULL', [
        hashToken(body.refreshToken),
      ]);
      await audit(req, 'auth.logout', req.user ? `user:${req.user.id}` : 'device');
    }
    return ok(reply, { loggedOut: true });
  });

  // 当前用户
  app.get('/api/auth/me', { preHandler: [app.authenticate] }, async (req, reply) => {
    await grantDailyCreditsIfEligible(req.user.id);
    const row = await queryOne('SELECT * FROM users WHERE id = ? LIMIT 1', [req.user.id]);
    if (!row) throw notFound('账号不存在', 'USER_NOT_FOUND');

    const [shareStats, publishStats, vaultStats] = await Promise.all([
      queryOne(
        'SELECT COUNT(*) AS total, COALESCE(SUM(view_count), 0) AS views FROM shares WHERE user_id = ? AND revoked_at IS NULL',
        [row.id],
      ),
      queryOne('SELECT COUNT(*) AS total FROM publishes WHERE user_id = ? AND revoked_at IS NULL', [row.id]),
      queryOne('SELECT COUNT(*) AS vaults, COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(doc_count), 0) AS docs FROM user_vaults WHERE user_id = ?', [row.id]),
    ]);

    return ok(reply, {
      user: publicUser(row),
      stats: {
        shares: Number(shareStats?.total ?? 0),
        shareViews: Number(shareStats?.views ?? 0),
        publishes: Number(publishStats?.total ?? 0),
        vaults: Number(vaultStats?.vaults ?? 0),
        documents: Number(vaultStats?.docs ?? 0),
        storageBytes: Number(vaultStats?.bytes ?? 0),
      },
    });
  });

  // 修改密码
  app.put('/api/auth/password', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = parse(passwordSchemaBody, req.body, '密码信息');
    const row = await queryOne('SELECT id, pass_hash FROM users WHERE id = ? LIMIT 1', [req.user.id]);
    if (!row) throw notFound('账号不存在', 'USER_NOT_FOUND');

    const passed = await verifyPassword(row.pass_hash, body.currentPassword);
    if (!passed) throw unauthorized('当前密码不正确', 'PASSWORD_MISMATCH');

    const passHash = await hashPassword(body.newPassword);
    await execute('UPDATE users SET pass_hash = ? WHERE id = ?', [passHash, row.id]);
    // 全设备下线，强制用新口令重新登录
    await execute('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [row.id]);
    await audit(req, 'auth.password_change', `user:${row.id}`);

    return ok(reply, { updated: true, reLoginRequired: true });
  });
}

export default authRoutes;
