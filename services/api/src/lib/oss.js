/**
 * 平台存储路径规则与高层封装。
 *
 * 布局约定：
 *   平台 / 管理员公共资源  mdadmin/...
 *   管理员个人目录         admin/...
 *   用户图片              us/<用户名>/tupian/<yyyyMM>/<文件>
 *   用户备份与快照         us/<用户名>/bk/...
 *   用户其它数据          us/<用户名>/ot/...
 */
import config, { platformStorage } from '../config.js';
import { randomToken } from './crypto.js';
import * as s3 from './s3.js';

/** 平台前缀，默认 mdadmin/ */
export const PLATFORM_PREFIX = config.oss.basePrefix;

const KIND_SUBDIR = {
  image: 'tupian',
  backup: 'bk',
  other: 'ot',
};

/** 去掉路径分隔符与控制字符，保留中文与常见符号 */
export function sanitizeName(name, fallback = 'file') {
  const raw = String(name ?? '').replace(/\\/g, '/');
  const base = raw.slice(raw.lastIndexOf('/') + 1);
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > 120 ? cleaned.slice(-120) : cleaned;
}

/** 生成不易冲突的文件名：base-<8位随机>.<ext> */
export function uniqueName(filename) {
  const safe = sanitizeName(filename, 'file');
  const dot = safe.lastIndexOf('.');
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : '';
  return `${stem.slice(0, 80)}-${randomToken(8).toLowerCase()}${ext}`;
}

/** 用户名归一化，避免出现路径穿越 */
export function safeSegment(segment, fallback = 'unknown') {
  const cleaned = String(segment ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^\.+/, '');
  return cleaned || fallback;
}

/** yyyyMM（UTC），用于图片按月归档 */
export function monthFolder(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}${month}`;
}

/** 拼接路径片段，自动处理多余斜杠 */
export function joinKey(...parts) {
  return parts
    .filter((p) => p !== undefined && p !== null && String(p) !== '')
    .map((p) => String(p).replace(/^\/+|\/+$/g, ''))
    .filter((p) => p !== '')
    .join('/');
}

/** 平台公共前缀：mdadmin/xxx */
export function adminPrefix(sub = '') {
  return sub ? joinKey(PLATFORM_PREFIX, sub) : PLATFORM_PREFIX.replace(/\/$/, '');
}

/** 管理员个人目录：admin/xxx */
export function personalAdminPrefix(sub = '') {
  return sub ? joinKey('admin', sub) : 'admin';
}

/** 用户根前缀：us/<用户名> */
export function userPrefix(username) {
  return joinKey('us', safeSegment(username));
}

/** 用户某类资源前缀 */
export function userAssetPrefix(username, kind = 'other') {
  return joinKey(userPrefix(username), KIND_SUBDIR[kind] ?? KIND_SUBDIR.other);
}

/** 用户图片：us/<username>/tupian/<yyyyMM>/<file> */
export function userImageKey(username, filename, date = new Date()) {
  return joinKey(userAssetPrefix(username, 'image'), monthFolder(date), uniqueName(filename));
}

/** 用户备份 / 快照：us/<username>/bk/... */
export function userBackupKey(username, filename, subFolder = '') {
  return joinKey(userAssetPrefix(username, 'backup'), subFolder, uniqueName(filename));
}

/** 用户其它数据：us/<username>/ot/... */
export function userOtherKey(username, filename, subFolder = '') {
  return joinKey(userAssetPrefix(username, 'other'), subFolder, uniqueName(filename));
}

/**
 * 统一入口：按资源类型生成平台桶内的对象键。
 * @param {'image'|'backup'|'other'|'publish'|'probe'|'admin'|string} kind
 * @param {string|null} username
 * @param {string} filename
 */
export function platformKey(kind, username, filename) {
  const name = uniqueName(filename);
  switch (kind) {
    case 'image':
      return userImageKey(username, filename);
    case 'backup':
    case 'snapshot':
      return userBackupKey(username, filename);
    case 'other':
    case 'data':
      return userOtherKey(username, filename);
    case 'publish':
      return joinKey(adminPrefix('publish'), `${sanitizeName(filename)}`);
    case 'probe':
      return joinKey(adminPrefix('probe'), `${sanitizeName(filename)}`);
    case 'admin':
      return username ? joinKey(personalAdminPrefix(), name) : joinKey(adminPrefix(), name);
    default:
      return joinKey(adminPrefix(kind), name);
  }
}

/* ------------------------------------------------------------------ */
/* 平台桶的高层封装                                                    */
/* ------------------------------------------------------------------ */

/** 当前平台桶配置（含密钥），仅服务端使用 */
export function platformConfig(overrides = {}) {
  return platformStorage(overrides);
}

/** 上传到平台桶 */
export function putPlatformObject(key, body, contentType = 'application/octet-stream') {
  return s3.putObject(platformConfig(), key, body, contentType);
}

/** 读取平台桶对象 */
export function getPlatformObject(key) {
  return s3.getObject(platformConfig(), key);
}

/** 删除平台桶对象（失败不抛出，由调用方决定是否忽略） */
export async function deletePlatformObject(key) {
  try {
    return await s3.deleteObject(platformConfig(), key);
  } catch (err) {
    return { key, deleted: false, error: err.message };
  }
}

/** 平台桶对象的公共访问地址 */
export function platformPublicUrl(key) {
  return s3.publicUrl(platformConfig(), key);
}

/** 平台桶预签名读取地址 */
export function presignPlatformGet(key, expiresSeconds = 3600) {
  return s3.presignGet(platformConfig(), key, expiresSeconds);
}

/** 平台桶预签名上传地址 */
export function presignPlatformPut(key, expiresSeconds = 3600) {
  return s3.presignPut(platformConfig(), key, expiresSeconds);
}

/** 平台桶连通性自检 */
export function probePlatformStorage(prefix = joinKey(adminPrefix('probe'), '/')) {
  return s3.probeStorage(platformConfig(), `${prefix.replace(/\/$/, '')}/`);
}

export default {
  PLATFORM_PREFIX,
  platformKey,
  platformConfig,
  putPlatformObject,
  getPlatformObject,
  deletePlatformObject,
  platformPublicUrl,
  presignPlatformGet,
  presignPlatformPut,
  probePlatformStorage,
};
