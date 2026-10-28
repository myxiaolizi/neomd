/**
 * 上传：服务端中转上传、直传预签名、对象存储连通性自检。
 */
import { z } from 'zod';
import { queryOne } from '../db/pool.js';
import config from '../config.js';
import { HttpError, ok } from '../lib/http.js';
import { parse } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { normalizeConfig, probeStorage } from '../lib/s3.js';
import {
  PLATFORM_PREFIX,
  platformConfig,
  platformKey,
  platformPublicUrl,
  presignPlatformGet,
  presignPlatformPut,
  putPlatformObject,
} from '../lib/oss.js';

const KIND_VALUES = ['image', 'backup', 'other'];

const presignSchema = z.object({
  filename: z.string().trim().min(1, { message: '缺少文件名' }).max(200),
  contentType: z.string().trim().max(120).optional().default('application/octet-stream'),
  kind: z.enum(KIND_VALUES).optional().default('image'),
  expiresIn: z.coerce.number().int().min(60).max(604800).optional().default(3600),
});

const storageConfigSchema = z
  .object({
    provider: z.string().trim().max(40).optional(),
    endpoint: z.string().trim().max(300).optional(),
    region: z.string().trim().max(60).optional(),
    bucket: z.string().trim().max(120).optional(),
    accessKeyId: z.string().trim().max(200).optional(),
    accessKeySecret: z.string().trim().max(300).optional(),
    ak: z.string().trim().max(200).optional(),
    sk: z.string().trim().max(300).optional(),
    publicDomain: z.string().trim().max(300).optional(),
    urlStyle: z.enum(['virtual-hosted', 'path']).optional(),
    basePrefix: z.string().trim().max(200).optional(),
    prefix: z.string().trim().max(200).optional(),
    isPrivate: z.boolean().optional(),
    useTls: z.boolean().optional(),
  })
  .partial();

const probeSchema = z.object({
  storage: storageConfigSchema.optional(),
  prefix: z.string().trim().max(200).optional(),
});

/** 用户已用容量（按仓库统计） */
async function usedBytes(userId) {
  const row = await queryOne('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM user_vaults WHERE user_id = ?', [userId]);
  return Number(row?.bytes ?? 0);
}

/** 按扩展名推断 MIME */
function guessContentType(filename, fallback = 'application/octet-stream') {
  const ext = String(filename ?? '').toLowerCase().split('.').pop();
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    bmp: 'image/bmp',
    pdf: 'application/pdf',
    zip: 'application/zip',
    json: 'application/json',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    html: 'text/html; charset=utf-8',
  };
  return map[ext] ?? fallback;
}

export async function uploadRoutes(app) {
  // 服务端中转上传（≤25MB）
  app.post('/api/upload', { preHandler: [app.authenticate] }, async (req, reply) => {
    let file;
    if (!req.isMultipart()) {
      throw new HttpError(400, 'NOT_MULTIPART', '请使用 multipart/form-data 上传文件');
    }
    try {
      file = await req.file({ limits: { fileSize: config.server.uploadLimit } });
    } catch (err) {
      if (err && err.code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new HttpError(413, 'UPLOAD_TOO_LARGE', `文件超出大小限制（最大 ${Math.round(config.server.uploadLimit / 1024 / 1024)}MB）`);
      }
      throw new HttpError(400, 'UPLOAD_FAILED', `读取上传内容失败：${err.message}`);
    }
    if (!file) throw new HttpError(400, 'NO_FILE', '请选择要上传的文件');

    const buffer = await file.toBuffer();
    if (buffer.length === 0) throw new HttpError(400, 'EMPTY_FILE', '文件内容为空');
    if (buffer.length > config.server.uploadLimit) {
      throw new HttpError(413, 'UPLOAD_TOO_LARGE', `文件超出大小限制（最大 ${Math.round(config.server.uploadLimit / 1024 / 1024)}MB）`);
    }

    // 配额校验：仓库占用 + 本次上传不得超过配额
    const used = await usedBytes(req.user.id);
    if (used + buffer.length > req.user.quotaBytes) {
      throw new HttpError(403, 'QUOTA_EXCEEDED', '存储配额不足，请清理空间或联系管理员扩容');
    }

    const kindField = file.fields?.kind;
    const kindRaw = Array.isArray(kindField) ? kindField[0]?.value : kindField?.value;
    const kind = KIND_VALUES.includes(String(kindRaw)) ? String(kindRaw) : inferKind(file.filename, file.mimetype);
    const key = platformKey(kind, req.user.username, file.filename || 'upload.bin');
    const contentType = file.mimetype && file.mimetype !== 'application/octet-stream'
      ? file.mimetype
      : guessContentType(file.filename);

    try {
      await putPlatformObject(key, buffer, contentType);
    } catch (err) {
      throw new HttpError(502, 'OSS_UPLOAD_FAILED', `上传到对象存储失败：${err.message}`);
    }

    await audit(req, 'upload.put', key, { size: buffer.length, kind });

    // 私有桶返回可直读的预签名地址，公共桶直接返回公共域名地址
    const publicRead = config.oss.publicRead;
    const signedExpires = 7 * 24 * 3600;
    const signedUrl = publicRead ? platformPublicUrl(key) : presignPlatformGet(key, signedExpires);

    return ok(reply, {
      key,
      url: signedUrl,
      publicUrl: platformPublicUrl(key),
      signedUrl,
      signedExpiresIn: publicRead ? null : signedExpires,
      size: buffer.length,
      contentType,
      kind,
    }, 201);
  });

  // 直传预签名
  app.post('/api/upload/presign', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = parse(presignSchema, req.body, '直传参数');
    const key = platformKey(body.kind, req.user.username, body.filename);
    let uploadUrl;
    try {
      uploadUrl = presignPlatformPut(key, body.expiresIn);
    } catch (err) {
      throw new HttpError(500, 'PRESIGN_FAILED', `生成直传地址失败：${err.message}`);
    }
    return ok(reply, {
      key,
      uploadUrl,
      method: 'PUT',
      headers: { 'content-type': body.contentType },
      publicUrl: platformPublicUrl(key),
      readUrl: config.oss.publicRead ? platformPublicUrl(key) : presignPlatformGet(key, 7 * 24 * 3600),
      expiresIn: body.expiresIn,
    });
  });

  // 对象存储连通性自检（服务端代发，避免浏览器直连 OSS 的 CORS 限制）
  app.post('/api/oss/probe', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = parse(probeSchema, req.body ?? {}, '存储配置');
    let cfg;
    let prefix;
    try {
      if (body.storage && Object.keys(body.storage).length > 0) {
        cfg = normalizeConfig({ ...body.storage });
        prefix = body.prefix || 'mdadmin/probe/';
      } else {
        cfg = platformConfig();
        prefix = body.prefix || `${PLATFORM_PREFIX}probe/`;
      }
    } catch (err) {
      throw new HttpError(400, 'STORAGE_CONFIG_INVALID', `存储配置不完整：${err.message}`);
    }

    // probeStorage 内部负责尾斜杠归一、逐步骤计时、探针对象清理与中文错误说明
    const result = await probeStorage(cfg, prefix);
    await audit(req, 'oss.probe', cfg.bucket, {
      ok: result.ok,
      message: result.message,
      warnings: result.warnings,
    });
    return ok(reply, result);
  });
}

/** 未显式指定类型时按文件名/MIME 推断分类 */
function inferKind(filename, mimetype) {
  const ext = String(filename ?? '').toLowerCase().split('.').pop();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'].includes(ext)) return 'image';
  if (['zip', 'tar', 'gz', '7z', 'bak'].includes(ext)) return 'backup';
  if (String(mimetype ?? '').startsWith('image/')) return 'image';
  return 'other';
}

export default uploadRoutes;
