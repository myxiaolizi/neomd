/**
 * 客户端下载：公开接口，不要求登录。
 *
 * 分发策略（兼顾"大文件走对象存储"与云服务器资源）：
 * - 体积较大的 Windows 包：302 跳到对象存储预签名地址，流量 OSS → 客户端直达，不经过本服务器；
 * - Android APK：阿里云禁止从 OSS 默认端点公开分发 APK，改由本服务流式代理（仅数 MB）。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import { notFound, ok } from '../lib/http.js';
import { adminPrefix, platformConfig } from '../lib/oss.js';
import { presignGet } from '../lib/s3.js';

/** releases 前缀（默认 mdadmin/releases） */
const RELEASES_PREFIX = adminPrefix('releases');

/** 随服务部署的本地安装包目录（services/api/releases） */
const LOCAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'releases');

/** 读取本地安装包，不存在返回 null */
async function readLocalRelease(file) {
  try {
    const full = path.join(LOCAL_DIR, path.basename(file));
    const buf = await fs.readFile(full);
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

/** 平台桶连接配置（管理员凭据，只用于生成下载链接） */
function storageConfig() {
  return platformConfig();
}

/** 预签名有效期（秒），足够慢速网络完成下载 */
const PRESIGN_TTL = 6 * 60 * 60;

/**
 * 静态安装包清单。
 * `proxy: true` 表示由本服务流出（APK 受 OSS 策略限制必须代理）。
 */
export const DOWNLOAD_FILES = [
  {
    file: 'NeoMD-1.1.8-win-x64.zip',
    title: 'Windows x64 绿色版',
    platform: 'windows',
    size: 159275205,
    proxy: false,
  },
  {
    file: 'NeoMD-1.1.8-setup.exe',
    title: 'Windows x64 安装包',
    platform: 'windows',
    size: 113158359,
    proxy: false,
  },
  {
    file: 'NeoMD-1.1.8.apk',
    title: 'Android APK',
    platform: 'android',
    size: 4338972,
    proxy: true,
  },
];

/** 文件名白名单：只允许字母、数字、点、下划线与短横线，杜绝路径穿越 */
const FILE_RE = /^[A-Za-z0-9._-]+$/;

/** 对外下载地址统一走本站，由本接口决定跳转或代理 */
function downloadUrl(file) {
  return `${String(config.publicBaseUrl).replace(/\/+$/, '')}/api/download/${file}`;
}

/** 清单对外投影 */
function publicFile(item) {
  return {
    file: item.file,
    title: item.title,
    platform: item.platform,
    size: item.size,
    url: downloadUrl(item.file),
  };
}

/** 按文件名查清单项 */
function findFile(name) {
  const target = String(name ?? '');
  return DOWNLOAD_FILES.find((item) => item.file === target) ?? null;
}

/** OSS 对象键 */
function objectKey(file) {
  return `${RELEASES_PREFIX}/${file}`;
}

export async function downloadRoutes(app) {
  // 清单（公开）
  app.get('/api/download/list', async (_req, reply) => {
    return ok(reply, { files: DOWNLOAD_FILES.map(publicFile) });
  });

  // 下载入口（公开）：大文件跳预签名直链，APK 走本服务代理
  app.get('/api/download/:file', async (req, reply) => {
    const name = String(req.params.file ?? '');
    if (!FILE_RE.test(name)) throw notFound('安装包不存在', 'RELEASE_NOT_FOUND');
    const item = findFile(name);
    if (!item) throw notFound('安装包不存在', 'RELEASE_NOT_FOUND');

    const key = objectKey(item.file);
    let signed;
    try {
      signed = presignGet(storageConfig(), key, PRESIGN_TTL);
    } catch (e) {
      req.log.error({ err: e, key }, '生成下载链接失败');
      throw notFound('下载暂不可用，请联系管理员', 'RELEASE_UNAVAILABLE');
    }

    if (!item.proxy) {
      // 大文件：302 到 OSS 预签名地址，客户端直连对象存储
      reply.header('cache-control', 'no-store');
      return reply.redirect(signed, 302);
    }

    // APK：阿里云禁止从 OSS 端点公开分发 APK，因此由本服务直出
    // 优先读取服务器本地文件（构建时随包上传），避免占用对象存储权限
    const local = await readLocalRelease(item.file);
    if (local) {
      reply.header('content-type', 'application/vnd.android.package-archive');
      reply.header('content-disposition', `attachment; filename="${item.file}"`);
      reply.header('content-length', String(local.length));
      reply.header('cache-control', 'public, max-age=600');
      return reply.send(local);
    }

    // 本地文件缺失时回退到对象存储代理
    const upstream = await fetch(signed);
    if (!upstream.ok || !upstream.body) {
      req.log.error({ status: upstream.status, key }, 'APK 上游读取失败');
      throw notFound('安装包暂不可用', 'RELEASE_UNAVAILABLE');
    }
    reply.header('content-type', 'application/vnd.android.package-archive');
    reply.header('content-disposition', `attachment; filename="${item.file}"`);
    const len = upstream.headers.get('content-length');
    if (len) reply.header('content-length', len);
    reply.header('cache-control', 'public, max-age=300');
    return reply.send(Buffer.from(await upstream.arrayBuffer()));
  });
}

export default downloadRoutes;
