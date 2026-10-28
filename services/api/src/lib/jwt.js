/**
 * 访问令牌 / 刷新令牌签发与校验。
 * 载荷统一为 { sub, role, deviceId, type }，访问令牌 15 分钟，刷新令牌 30 天。
 */
import jwt from 'jsonwebtoken';
import config from '../config.js';
import { randomToken, sha256 } from './crypto.js';
import { unauthorized } from './http.js';

const { secret, refreshSecret, accessTtl, refreshTtl, issuer } = config.jwt;

/** 签发访问令牌 */
export function signAccessToken({ userId, role = 'user', deviceId = null }) {
  return jwt.sign(
    { sub: String(userId), role, deviceId: deviceId ?? null, type: 'access' },
    secret,
    { expiresIn: accessTtl, issuer, algorithm: 'HS256', jwtid: randomToken(10) },
  );
}

/** 签发刷新令牌（jti 保证同设备重复登录也能得到不同令牌） */
export function signRefreshToken({ userId, role = 'user', deviceId = null }) {
  return jwt.sign(
    { sub: String(userId), role, deviceId: deviceId ?? null, type: 'refresh' },
    refreshSecret,
    { expiresIn: refreshTtl, issuer, algorithm: 'HS256', jwtid: randomToken(16) },
  );
}

/** 刷新令牌入库时只保存哈希 */
export function hashToken(token) {
  return sha256(token);
}

/** 校验访问令牌，失败抛 401 */
export function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, secret, { issuer, algorithms: ['HS256'] });
    if (!payload || payload.type !== 'access' || !payload.sub) {
      throw new Error('令牌类型不正确');
    }
    return normalizePayload(payload);
  } catch (err) {
    if (err && err.name === 'TokenExpiredError') {
      throw unauthorized('登录已过期，请重新登录', 'TOKEN_EXPIRED');
    }
    throw unauthorized('登录凭证无效，请重新登录', 'TOKEN_INVALID');
  }
}

/** 校验刷新令牌，失败抛 401 */
export function verifyRefreshToken(token) {
  try {
    const payload = jwt.verify(token, refreshSecret, { issuer, algorithms: ['HS256'] });
    if (!payload || payload.type !== 'refresh' || !payload.sub) {
      throw new Error('令牌类型不正确');
    }
    return normalizePayload(payload);
  } catch (err) {
    if (err && err.name === 'TokenExpiredError') {
      throw unauthorized('登录已过期，请重新登录', 'REFRESH_EXPIRED');
    }
    throw unauthorized('刷新令牌无效，请重新登录', 'REFRESH_INVALID');
  }
}

function normalizePayload(payload) {
  return {
    userId: Number(payload.sub),
    role: payload.role === 'admin' ? 'admin' : 'user',
    deviceId: payload.deviceId ?? null,
    expiresAt: payload.exp ? Number(payload.exp) * 1000 : null,
    jti: payload.jti ?? null,
  };
}

/** 刷新令牌过期时间（JS Date，写入数据库用） */
export function refreshExpiryDate(from = new Date()) {
  return new Date(from.getTime() + config.jwt.refreshTtlSeconds * 1000);
}

export default {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashToken,
  refreshExpiryDate,
};
