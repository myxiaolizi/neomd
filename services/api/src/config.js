/**
 * 配置加载：读取 services/api/.env 与 .env.local（后者覆盖前者），
 * 真实进程环境变量优先级最高。自身实现极简 dotenv，不引入依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 服务根目录：services/api */
export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 解析单个 .env 文件，支持注释、引号与 export 前缀 */
function parseEnvFile(file) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const body = text.startsWith('export ') ? text.slice(7).trim() : text;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\\n/g, '\n');
    out[key] = value;
  }
  return out;
}

/** 依次合并 .env 与 .env.local，真实环境变量最终覆盖 */
function loadEnv() {
  const merged = {};
  for (const name of ['.env', '.env.local']) {
    Object.assign(merged, parseEnvFile(path.join(rootDir, name)));
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && value !== '') merged[key] = value;
  }
  return merged;
}

const env = loadEnv();

/** 读取布尔值 */
function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

/** 读取整数并校验范围 */
function int(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`环境变量 ${name} 必须是 ${min}~${max} 之间的整数，当前值：${raw}`);
  }
  return n;
}

/** 必填字符串校验 */
function required(name) {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`缺少必需的环境变量：${name}`);
  }
  return value;
}

/** 去掉结尾斜杠 */
function trimSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

const nodeEnv = env.NODE_ENV || 'development';

/** 读取服务版本号 */
function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    return String(pkg.version || '1.0.0');
  } catch {
    return '1.0.0';
  }
}

function buildConfig() {
  const jwtSecret = required('JWT_SECRET');
  const jwtRefreshSecret = required('JWT_REFRESH_SECRET');
  const secretsKey = required('SECRETS_KEY');

  if (jwtSecret.length < 32) throw new Error('JWT_SECRET 长度不足，至少需要 32 个字符');
  if (jwtRefreshSecret.length < 32) throw new Error('JWT_REFRESH_SECRET 长度不足，至少需要 32 个字符');
  if (Buffer.from(secretsKey, 'base64').length !== 32) {
    throw new Error('SECRETS_KEY 必须是 32 字节的 base64 字符串（用于 AES-256-GCM）');
  }

  const ossPrefix = env.OSS_PREFIX ?? 'mdadmin/';
  const publicBaseUrl = trimSlash(env.PUBLIC_BASE_URL || 'http://127.0.0.1:3200');

  return {
    rootDir,
    nodeEnv,
    isProduction: nodeEnv === 'production',
    version: readVersion(),
    server: {
      port: int('PORT', 3200, 1, 65535),
      host: env.HOST || '127.0.0.1',
      bodyLimit: 12 * 1024 * 1024,
      uploadLimit: 25 * 1024 * 1024,
      trustProxy: bool('TRUST_PROXY', nodeEnv === 'production'),
    },
    webRoot: env.WEB_ROOT || path.join(rootDir, 'public'),
    publicBaseUrl,
    db: {
      host: env.DB_HOST || '127.0.0.1',
      port: int('DB_PORT', 3306, 1, 65535),
      user: required('DB_USER'),
      password: required('DB_PASSWORD'),
      database: required('DB_NAME'),
      connectionLimit: int('DB_POOL_SIZE', 10, 1, 100),
    },
    jwt: {
      secret: jwtSecret,
      refreshSecret: jwtRefreshSecret,
      accessTtl: '15m',
      refreshTtl: '30d',
      accessTtlSeconds: 15 * 60,
      refreshTtlSeconds: 30 * 24 * 60 * 60,
      issuer: 'neomd-api',
    },
    secretsKey,
    oss: {
      endpoint: trimSlash(env.OSS_ENDPOINT || 'https://s3.cn-guangzhou.aliyuncs.com'),
      region: env.OSS_REGION || 'cn-guangzhou',
      bucket: required('OSS_BUCKET'),
      accessKeyId: required('OSS_AK'),
      accessKeySecret: required('OSS_SK'),
      publicDomain: trimSlash(env.OSS_PUBLIC_DOMAIN || ''),
      basePrefix: ossPrefix.endsWith('/') ? ossPrefix : `${ossPrefix}/`,
      urlStyle: env.OSS_URL_STYLE === 'path' ? 'path' : 'virtual-hosted',
      useTls: true,
      // 桶是否允许匿名读：false 时发布页由服务端代理输出，上传只返回预签名地址
      publicRead: bool('OSS_PUBLIC_READ', false),
      isPrivate: bool('OSS_PRIVATE', !bool('OSS_PUBLIC_READ', false)),
    },
    admin: {
      email: env.ADMIN_EMAIL || 'admin@zhengl.vip',
      username: env.ADMIN_USERNAME || 'admin',
      password: env.ADMIN_PASSWORD || '',
    },
    corsOrigins: (env.CORS_ORIGINS || 'https://md.zhengl.vip,http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    defaultQuotaBytes: 1024 * 1024 * 1024,
    rateLimits: {
      global: { max: 300, timeWindowMs: 60_000 },
      login: { max: 10, timeWindowMs: 60_000 },
      register: { max: 5, timeWindowMs: 60 * 60_000 },
      comment: { max: 20, timeWindowMs: 60 * 60_000 },
      ai: { max: 30, timeWindowMs: 60_000 },
    },
  };
}

/** 平台默认对象存储配置（供 s3/oss 库直接使用） */
export function platformStorage(overrides = {}) {
  const { oss } = config;
  return {
    endpoint: oss.endpoint,
    region: oss.region,
    bucket: oss.bucket,
    accessKeyId: oss.accessKeyId,
    accessKeySecret: oss.accessKeySecret,
    publicDomain: oss.publicDomain,
    basePrefix: oss.basePrefix,
    urlStyle: oss.urlStyle,
    useTls: oss.useTls,
    isPrivate: oss.isPrivate,
    ...overrides,
  };
}

export const config = buildConfig();

export default config;
