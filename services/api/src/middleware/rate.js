/**
 * 限流配置与进程内固定窗口限流器。
 * 全局 300 次/分钟由 @fastify/rate-limit 承担；
 * 登录 / 注册 / 评论 / AI 这类关键接口使用本模块的精确配额。
 */
import config from '../config.js';
import { tooManyRequests } from '../lib/http.js';
import { LruCache } from '../lib/lru.js';
import { clientIp } from '../lib/audit.js';

/** 各接口配额（次数 / 时间窗口毫秒） */
export const RATE_LIMITS = {
  login: { max: 10, windowMs: 60_000, label: '登录' },
  register: { max: 5, windowMs: 60 * 60_000, label: '注册' },
  comment: { max: 20, windowMs: 60 * 60_000, label: '评论' },
  ai: { max: 30, windowMs: 60_000, label: 'AI 调用' },
  redeem: { max: 5, windowMs: 60 * 60_000, label: '兑换码核销' },
};

/** 固定窗口计数器 */
class FixedWindowLimiter {
  constructor(name, max, windowMs) {
    this.name = name;
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new LruCache({ max: 20_000, ttlMs: windowMs });
  }

  /**
   * @param {string} key
   * @returns {{allowed: boolean, remaining: number, retryAfter: number, resetAt: number}}
   */
  consume(key) {
    const now = Date.now();
    const current = this.hits.get(key);
    if (!current || current.resetAt <= now) {
      const resetAt = now + this.windowMs;
      this.hits.set(key, { count: 1, resetAt }, this.windowMs);
      return { allowed: true, remaining: this.max - 1, retryAfter: 0, resetAt };
    }
    if (current.count >= this.max) {
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
        resetAt: current.resetAt,
      };
    }
    current.count += 1;
    this.hits.set(key, current, Math.max(1, current.resetAt - now));
    return { allowed: true, remaining: this.max - current.count, retryAfter: 0, resetAt: current.resetAt };
  }
}

const limiters = new Map();

/** 取（或创建）某个限流器 */
function limiterFor(name, overrides = {}) {
  if (!limiters.has(name)) {
    const preset = RATE_LIMITS[name] ?? { max: 30, windowMs: 60_000, label: '请求' };
    const max = Number(overrides.max ?? preset.max);
    const windowMs = Number(overrides.windowMs ?? preset.windowMs);
    limiters.set(name, new FixedWindowLimiter(name, max, windowMs));
  }
  return limiters.get(name);
}

function applyHeaders(reply, limit, result) {
  try {
    reply.header('x-ratelimit-limit', String(limit.max));
    reply.header('x-ratelimit-remaining', String(Math.max(0, result.remaining)));
    reply.header('x-ratelimit-reset', String(Math.ceil(result.resetAt / 1000)));
  } catch {
    /* 响应已发出时忽略 */
  }
}

/** 按客户端 IP 限流（登录 / 注册 / 评论） */
export function ipRateLimit(name, overrides = {}) {
  const limit = limiterFor(name, overrides);
  return async function ipRateLimitHandler(req, reply) {
    const key = `${name}:ip:${clientIp(req)}`;
    const result = limit.consume(key);
    applyHeaders(reply, limit, result);
    if (!result.allowed) {
      const err = tooManyRequests(
        `${RATE_LIMITS[name]?.label ?? '请求'}过于频繁，请 ${result.retryAfter} 秒后再试`,
        'RATE_LIMITED',
        result.retryAfter,
      );
      throw err;
    }
  };
}

/** 按登录用户限流（AI 调用），需在 authenticate 之后执行 */
export function userRateLimit(name, overrides = {}) {
  const limit = limiterFor(name, overrides);
  return async function userRateLimitHandler(req, reply) {
    const userId = req.user?.id ?? `ip:${clientIp(req)}`;
    const key = `${name}:user:${userId}`;
    const result = limit.consume(key);
    applyHeaders(reply, limit, result);
    if (!result.allowed) {
      const err = tooManyRequests(
        `${RATE_LIMITS[name]?.label ?? '请求'}过于频繁，请 ${result.retryAfter} 秒后再试`,
        'RATE_LIMITED',
        result.retryAfter,
      );
      throw err;
    }
  };
}

/** @fastify/rate-limit 全局配置 */
export const globalRateLimitConfig = {
  max: config.rateLimits.global.max,
  timeWindow: config.rateLimits.global.timeWindowMs,
  /*
   * 全局兜底限流**不覆盖存储同步接口**（1.1.9 修复）。
   *
   * 为什么：一次仓库同步的请求数是 `2N + 2`（N 篇文档 = N 次 PUT + N 次 GET，
   * 外加 1 次列举与 1 次设备索引写入）。全局桶只有 300 次/分钟，于是**约 150 篇
   * 文档的仓库在首次全量同步时就会撞上全局限流**，表现为同步到一半报错、
   * 用户以为数据丢了。
   *
   * 而 `/api/storage/*` 本来就有自己的专用桶（`storageRateLimit`，900 次/分钟，
   * 见 routes/storage.js），既按用户维度计费又贴合同步的请求量特征。
   * 让两层同时生效只会让「较严的那层」说了算，等于专用桶形同虚设。
   *
   * 因此这里把存储前缀排除出全局桶，交由专用桶治理 —— 安全性没有下降
   * （专用桶仍然限流，且按 `user:<id>` 分桶，比按 IP 更精确）。
   */
  allowList: (req) =>
    req.url === '/api/health' || req.url.startsWith('/api/storage/'),
  keyGenerator: (req) => clientIp(req),
  /*
   * `statusCode: 429` **必须显式给出**。
   *
   * 为什么：这个返回值会被 `server.js` 的 `setErrorHandler` 统一包装，而该处理器
   * 只认 `error.statusCode` —— 缺失时一律当 500 处理（"服务内部错误"）。
   * 于是限流本该返回 429，实际返回的却是 500：客户端无法区分「请慢一点」与
   * 「服务坏了」，既不会退避重试，还会把限流误报成服务端故障，
   * 在监控里制造大量假告警（本地压测时实测复现：连续请求后 `/api/settings`
   * 返回 `500 INTERNAL_ERROR`，而服务端日志里的真实原因是 `RATE_LIMITED`）。
   */
  errorResponseBuilder: (req, context) => ({
    statusCode: 429,
    ok: false,
    error: {
      code: 'RATE_LIMITED',
      message: `请求过于频繁，请 ${Math.ceil(context.ttl / 1000)} 秒后再试`,
    },
  }),
};

export default { RATE_LIMITS, ipRateLimit, userRateLimit, globalRateLimitConfig };
