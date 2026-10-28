/**
 * Neo MD 后端服务入口：装配插件、路由、静态资源与优雅停机。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';

import config from './config.js';
import { closePool } from './db/pool.js';
import { migrateAndSeed } from './db/migrate.js';
import { HttpError } from './lib/http.js';
import { formatIssues } from './lib/validate.js';
import { registerAuth } from './middleware/auth.js';
import { globalRateLimitConfig } from './middleware/rate.js';

import { authRoutes } from './routes/auth.js';
import { settingsRoutes } from './routes/settings.js';
import { shareRoutes } from './routes/shares.js';
import { publishRoutes } from './routes/publish.js';
import { uploadRoutes } from './routes/upload.js';
import { aiRoutes } from './routes/ai.js';
import { adminRoutes } from './routes/admin.js';
import { healthRoutes } from './routes/health.js';
import { profileRoutes } from './routes/profile.js';
import { downloadRoutes } from './routes/download.js';
import { creditsRoutes } from './routes/credits.js';
import { pluginRoutes } from './routes/plugins.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { storageRoutes } from './routes/storage.js';
import { vaultRoutes } from './routes/vaults.js';

/** 创建 Fastify 实例 */
export function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || (config.isProduction ? 'info' : 'debug'),
      base: { service: 'neomd-api' },
    },
    trustProxy: config.server.trustProxy,
    bodyLimit: config.server.bodyLimit,
    requestTimeout: 0,
    keepAliveTimeout: 72_000,
  });

  /* ----------------------------- 错误处理 ----------------------------- */

  app.setErrorHandler((error, req, reply) => {
    const requestId = req.id;

    // 业务异常
    if (error instanceof HttpError) {
      if (error.retryAfter) reply.header('retry-after', String(error.retryAfter));
      if (error.status >= 500) req.log.error({ err: error, requestId }, error.message);
      return reply.code(error.status).send({
        ok: false,
        error: { code: error.code, message: error.message },
      });
    }

    // zod 校验异常（直接调用 schema.parse 的场景）
    if (error && error.name === 'ZodError') {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: `请求参数校验失败：${formatIssues(error)}` },
      });
    }

    // Fastify 自身校验
    if (error && error.validation) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: `请求参数校验失败：${error.message}`,
        },
      });
    }

    // 限流插件
    if (error && error.statusCode === 429) {
      const retryAfter = Math.max(1, Number(error.ttl ? Math.ceil(error.ttl / 1000) : 60));
      reply.header('retry-after', String(retryAfter));
      return reply.code(429).send({
        ok: false,
        error: { code: 'RATE_LIMITED', message: `请求过于频繁，请 ${retryAfter} 秒后再试` },
      });
    }

    // 请求体过大 / 类型不支持
    if (error && error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({
        ok: false,
        error: { code: 'BODY_TOO_LARGE', message: '请求体过大，请缩小内容后再试' },
      });
    }
    if (error && error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.code(415).send({
        ok: false,
        error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '不支持的请求内容类型' },
      });
    }
    if (error && (error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || error.code === 'FST_ERR_CTP_INVALID_JSON_BODY')) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'INVALID_JSON', message: '请求体不是合法的 JSON' },
      });
    }

    // 数据库异常
    if (error && typeof error.code === 'string' && /^(ER_|PROTOCOL_|ECONNREFUSED|ETIMEDOUT)/.test(error.code)) {
      req.log.error({ err: error, requestId }, '数据库错误');
      return reply.code(500).send({
        ok: false,
        error: { code: 'DB_ERROR', message: '数据库操作失败，请稍后再试' },
      });
    }

    const status = Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 600 ? Number(error.statusCode) : 500;
    req.log.error({ err: error, requestId }, '未处理的异常');
    return reply.code(status).send({
      ok: false,
      error: {
        code: status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
        message: status === 500 ? '服务内部错误，请稍后再试' : error.message || '请求处理失败',
      },
    });
  });

  /* ------------------------------- 插件 ------------------------------- */

  // 内置允许来源：即使 CORS_ORIGINS 被环境变量覆盖，生产域名也始终放行
  const builtinOrigins = new Set(['https://md.zhengl.vip']);
  const allowedOrigins = new Set([...builtinOrigins, ...config.corsOrigins]);
  app.register(cors, {
    origin(origin, cb) {
      // 同源 / 命令行 / file://（浏览器对 local file 页面发送 Origin: null）
      if (!origin || origin === 'null' || origin === 'file://') return cb(null, true);
      if (allowedOrigins.has(origin)) return cb(null, true);
      // 本地开发与桌面壳：localhost / 127.0.0.1 / ::1 的任意端口，http 与 https 都放行
      if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) return cb(null, true);
      // Electron / Capacitor 自定义协议（neomd://、capacitor://localhost 等）
      if (/^(neomd|capacitor|ionic|app):\/\//i.test(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    /**
     * 允许的请求头。
     *
     * ⚠️ 1.1.8 修复「同步失败：Failed to fetch」的关键：
     * 1.1.5 起仓库同步会携带 `x-vault-id`（标识当前仓库），存储上传会携带
     * `x-object-key` / `x-object-content-type`。这三个头此前**没有列在这里**，
     * 浏览器 CORS 预检（OPTIONS）会直接失败，前端只能看到笼统的
     * `Failed to fetch` —— 表现为「同步能力完全不可用」。
     *
     * 教训：任何新增的自定义请求头，都必须同步加进这个白名单，否则仅在不带该头的
     * 请求上看起来正常，一带头就整条链路失败。
     */
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-user-ai-key',
      'x-device-id',
      'x-requested-with',
      'x-vault-id',
      'x-object-key',
      'x-object-content-type',
    ],
    // content-disposition 供浏览器端下载时读取文件名
    exposedHeaders: [
      'content-disposition',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
      'retry-after',
    ],
    maxAge: 86_400,
  });

  app.register(rateLimit, globalRateLimitConfig);

  app.register(multipart, {
    limits: {
      fileSize: config.server.uploadLimit,
      files: 1,
      fields: 16,
      parts: 20,
    },
  });

  /* ------------------------------- 认证 ------------------------------- */

  registerAuth(app);

  /* ------------------------------- 路由 ------------------------------- */

  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(settingsRoutes);
  app.register(shareRoutes);
  app.register(publishRoutes);
  app.register(uploadRoutes);
  app.register(aiRoutes);
  app.register(adminRoutes);
  app.register(profileRoutes);
  app.register(downloadRoutes);
  app.register(creditsRoutes);
  app.register(pluginRoutes);
  // AI 知识库（1.1.0）：服务端只做无状态 AI 代理，不存储用户笔记内容
  app.register(knowledgeRoutes);
  // 平台存储代理（1.1.1）：未自配 S3 的登录用户经服务端代理使用平台对象存储做多端同步
  app.register(storageRoutes);
  // 仓库注册表（1.1.5）：多仓库按 vaultId 隔离，支撑改名/停用/删除/复制
  app.register(vaultRoutes);

  /* ----------------------------- 静态资源 ----------------------------- */

  const webRoot = path.resolve(config.webRoot);
  const hasWebRoot = fs.existsSync(webRoot);
  const indexFile = path.join(webRoot, 'index.html');
  const hasIndex = hasWebRoot && fs.existsSync(indexFile);

  if (hasWebRoot) {
    app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      wildcard: false,
      index: false,
      cacheControl: true,
      maxAge: config.isProduction ? '7d' : 0,
      immutable: false,
      etag: true,
      lastModified: true,
    });
  } else {
    app.log.warn({ webRoot }, '前端静态目录不存在，跳过静态资源托管');
  }

  // SPA 回退：非 /api、非 /p/ 的 GET 一律返回 index.html
  app.get('/*', async (req, reply) => {
    const urlPath = String(req.url || '/').split('?')[0];
    if (urlPath.startsWith('/api/') || urlPath === '/api') {
      return reply.code(404).send({
        ok: false,
        error: { code: 'NOT_FOUND', message: `接口不存在：${req.method} ${urlPath}` },
      });
    }
    if (urlPath.startsWith('/p/')) {
      return reply.code(404).type('text/html; charset=utf-8').send('<!doctype html><meta charset="utf-8"><title>404</title><p>页面不存在</p>');
    }

    // 命中真实文件则直接返回，否则交回 SPA 路由
    let normalized = '/';
    try {
      normalized = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
    } catch {
      normalized = '/';
    }
    const candidate = path.join(webRoot, normalized);
    if (hasWebRoot && candidate.startsWith(webRoot) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return reply.sendFile(path.relative(webRoot, candidate));
    }
    if (hasIndex) {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply.code(503).send({
      ok: false,
      error: { code: 'WEB_NOT_DEPLOYED', message: '前端资源尚未部署，请先上传构建产物到 WEB_ROOT' },
    });
  });

  /* ----------------------------- 404 兜底 ----------------------------- */

  app.setNotFoundHandler((req, reply) => {
    return reply.code(404).send({
      ok: false,
      error: { code: 'NOT_FOUND', message: `接口不存在：${req.method} ${req.url}` },
    });
  });

  return app;
}

/** 启动流程：迁移数据库 → 初始化管理员 → 监听端口 */
async function start() {
  const app = buildServer();

  try {
    await migrateAndSeed();
  } catch (err) {
    app.log.error({ err }, '数据库初始化失败，服务无法启动');
    await closePool().catch(() => {});
    process.exit(1);
  }

  try {
    await app.listen({ port: config.server.port, host: config.server.host });
    app.log.info(
      { address: `${config.server.host}:${config.server.port}`, webRoot: path.resolve(config.webRoot), publicBaseUrl: config.publicBaseUrl, version: config.version },
      'Neo MD API 已启动',
    );
    console.log(`[api] 监听地址：http://${config.server.host}:${config.server.port}`);
    console.log(`[api] 对外地址：${config.publicBaseUrl}`);
  } catch (err) {
    app.log.error({ err }, '监听端口失败');
    await closePool().catch(() => {});
    process.exit(1);
  }

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, '开始优雅停机');
    try {
      await app.close();
      await closePool();
      app.log.info('已停止');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, '停机过程出错');
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => void shutdown(signal));
  }
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, '未处理的 Promise 拒绝');
  });
  process.on('uncaughtException', (err) => {
    app.log.error({ err }, '未捕获的异常');
  });
}

const invokedDirectly = Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  void start();
}

export default buildServer;
