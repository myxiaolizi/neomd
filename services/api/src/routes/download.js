/**
 * 客户端下载：公开接口，不要求登录。
 *
 * 分发策略（兼顾"大文件走对象存储"与云服务器资源）：
 * - 体积较大的 Windows 包：302 跳到对象存储预签名地址，流量 OSS → 客户端直达，不经过本服务器；
 * - Android APK：阿里云禁止从 OSS 默认端点公开分发 APK，改由本服务流式代理（仅数 MB）。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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
 * 当前产品版本号。
 *
 * ## 为什么清单必须动态生成（1.3.1 根治）
 *
 * 这里原先是一张**硬编码 1.1.8 文件名**的静态清单。后果有两个，都很严重：
 *
 * 1. 每次发版都要有人记得手改这三行，漏改就**发不出去**。1.2.0 发布时就是这样：
 *    APK 明明已经放进 `server/releases/`，但清单里没有 1.2.0 的条目，
 *    `/api/download/NeoMD-1.2.0.apk` 直接 404 —— 客户端下载页至今点不动，
 *    而构建日志里一切正常，属于「静默缺件」。
 * 2. 下载入口用清单做**白名单**（`findFile` 找不到就 404），所以清单漏了哪个文件，
 *    即使磁盘上真的有，也永远下不到。
 *
 * 现在改成从 `services/api/package.json` 的 `version` 推导 —— 版本号只有一个事实源，
 * 发版脚本 `release-119.mjs version --to x.y.z` 改完就自动跟随，不存在"忘记改清单"。
 *
 * `size` 不再写死：清单接口里允许为 `null`，前端只把它当展示用的参考值；
 * 真实大小由响应头 `content-length` 或 OSS 对象的实际字节数给出。
 */
const APP_VERSION = (() => {
  try {
    // 与 config.js 的 readVersion() 保持一致：读本包自己的 package.json
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8'));
    return String(pkg.version ?? '').trim();
  } catch {
    return '';
  }
})();

/**
 * 下载清单：**当前版本三项 + 磁盘上历史 APK**。
 *
 * 历史 APK 为什么会出现在清单里：`server/releases/` 保留了历次构建产物，
 * 已经分享出去的旧链接（README、Release 页面、聊天记录）不应该因为发新版而失效。
 * Windows 的 zip / exe 走 OSS 预签名，历史版本仍在桶里，因此按同样的规则登记。
 */
export const DOWNLOAD_FILES = (() => {
  if (!APP_VERSION) {
    // 读不到版本号时清单为空：宁可"下载页提示暂不可用"，也不要用一个错误的版本号去 404
    return [];
  }
  return [
    {
      file: `NeoMD-${APP_VERSION}-win-x64.zip`,
      title: 'Windows x64 绿色版',
      platform: 'windows',
      size: null,
      proxy: false,
    },
    {
      file: `NeoMD-${APP_VERSION}-setup.exe`,
      title: 'Windows x64 安装包',
      platform: 'windows',
      size: null,
      proxy: false,
    },
    {
      file: `NeoMD-${APP_VERSION}.apk`,
      title: 'Android APK',
      platform: 'android',
      size: null,
      proxy: true,
    },
  ];
})();

/** 文件名的型号识别：给历史 APK 反推平台与标题用 */
const APK_RE = /^NeoMD-(\d+(?:\.\d+)*)\.apk$/;

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

/**
 * 列出磁盘上所有历史 APK，登记为「仅可下载、不在主清单展示」的条目。
 *
 * 为什么不放进 `/api/download/list`：那个接口是给下载页渲染卡片的，
 * 一次列十几个历史 APK 只会让用户困惑。历史条目只用来**放行白名单**，
 * 让旧链接仍然可用。
 *
 * 目录不可读（未部署 releases/、权限不足）时返回空数组，不影响当前版本下载。
 */
async function listHistoricalApks() {
  try {
    const names = await fs.readdir(LOCAL_DIR);
    return names
      .filter((n) => APK_RE.test(n))
      .sort()
      .map((n) => ({
        file: n,
        title: `Android APK（历史版本 ${APK_RE.exec(n)[1]}）`,
        platform: 'android',
        size: null,
        proxy: true,
        historical: true,
      }));
  } catch {
    return [];
  }
}

/** 按文件名查清单项（当前版本优先，其次历史 APK） */
async function findFile(name) {
  const target = String(name ?? '');
  const hit = DOWNLOAD_FILES.find((item) => item.file === target);
  if (hit) return hit;
  const historical = await listHistoricalApks();
  return historical.find((item) => item.file === target) ?? null;
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
    const item = await findFile(name);
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
