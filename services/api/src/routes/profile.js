/**
 * 个人资料：资料读取与修改、改密、仓库备份管理、头像上传。
 * 所有接口都要求登录；返回体里绝不出现 pass_hash。
 */
import { z } from 'zod';
import { execute, query, queryOne } from '../db/pool.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { HttpError, notFound, ok, unauthorized } from '../lib/http.js';
import { parse, parseId, passwordSchema } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import config from '../config.js';
import {
  deletePlatformObject,
  joinKey,
  platformPublicUrl,
  presignPlatformGet,
  putPlatformObject,
  userPrefix,
} from '../lib/oss.js';
// 1.1.5：备份列表按仓库过滤时需校验 vaultId 字形
import { assertVaultIdShape } from '../lib/vault-scope.js';

/** 头像大小上限 2MB */
const AVATAR_LIMIT = 2 * 1024 * 1024;

/** 头像允许的扩展名 -> 内容类型 */
const AVATAR_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

/** 备份预签名地址有效期：1 小时 */
const BACKUP_URL_TTL = 3600;

/** 头像可读地址有效期：7 天（与 /api/upload 保持一致） */
const AVATAR_URL_TTL = 7 * 24 * 3600;

const updateSchema = z
  .object({
    nickname: z
      .string({ error: '昵称必须是字符串' })
      .trim()
      .min(1, { message: '昵称至少 1 个字符' })
      .max(64, { message: '昵称最多 64 个字符' })
      .optional()
      .nullable(),
    avatarUrl: z
      .string({ error: '头像地址必须是字符串' })
      .trim()
      .max(512, { message: '头像地址最多 512 个字符' })
      .refine((value) => value === '' || /^https?:\/\/[^\s]+$/i.test(value), {
        message: '头像地址必须以 http:// 或 https:// 开头',
      })
      .optional()
      .nullable(),
  })
  .refine((value) => value.nickname !== undefined || value.avatarUrl !== undefined, {
    message: '至少需要提交 nickname 或 avatarUrl 中的一项',
  });

const passwordChangeSchema = z
  .object({
    oldPassword: z.string().max(128).optional(),
    currentPassword: z.string().max(128).optional(),
    newPassword: passwordSchema,
  })
  .refine((value) => Boolean(value.oldPassword || value.currentPassword), {
    message: '请输入当前密码',
    path: ['oldPassword'],
  });

const backupSchema = z.object({
  vaultId: z.string({ error: '缺少仓库标识' }).trim().min(1, { message: '缺少仓库标识' }).max(64),
  name: z.string({ error: '缺少备份名称' }).trim().min(1, { message: '备份名称不能为空' }).max(160),
  docCount: z.coerce.number().int().min(0).max(10_000_000).optional().default(0),
  bytes: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().default(0),
  ossKey: z
    .string({ error: '缺少对象键' })
    .trim()
    .min(1, { message: '缺少对象键' })
    .max(512, { message: '对象键过长' })
    .regex(/^[A-Za-z0-9._\-/]+$/, { message: '对象键包含非法字符' }),
});

/** 用户对外投影（不含 pass_hash） */
export function profileUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    email: row.email,
    username: row.username,
    nickname: row.nickname ?? null,
    avatarUrl: row.avatar_url ?? null,
    role: row.role === 'admin' ? 'admin' : 'user',
    status: row.status ?? 'active',
    quotaBytes: Number(row.quota_bytes ?? 0),
    credits: Number(row.credits ?? 0),
    createdAt: row.created_at ?? null,
    lastLoginAt: row.last_login_at ?? null,
    lastLoginIp: row.last_login_ip ?? null,
  };
}

/** 备份对外投影，url 为短时预签名地址 */
function backupItem(row) {
  let url = null;
  try {
    url = config.oss.publicRead ? platformPublicUrl(row.oss_key) : presignPlatformGet(row.oss_key, BACKUP_URL_TTL);
  } catch {
    url = null;
  }
  return {
    id: Number(row.id),
    vaultId: row.vault_id,
    name: row.name,
    docCount: Number(row.doc_count ?? 0),
    bytes: Number(row.bytes ?? 0),
    url,
    createdAt: row.created_at ?? null,
  };
}

/** 读取最新用户行 */
async function loadUserRow(userId) {
  return queryOne('SELECT * FROM users WHERE id = ? LIMIT 1', [userId]);
}

/** 备份对象的合法前缀：本人 us/<用户名>/bk/ 或平台公共 admin/ */
function allowedKeyPrefixes(username) {
  return [`${joinKey(userPrefix(username), 'bk')}/`, 'admin/'];
}

/**
 * 按仓库统计备份数量（供前端做过滤下拉）。
 * 只返回有备份的仓库，避免列表里出现一堆 0。
 */
async function loadBackupCountsByVault(userId) {
  const rows = await query(
    `SELECT vault_id, COUNT(*) AS total, COALESCE(SUM(bytes), 0) AS bytes
       FROM backups WHERE user_id = ? GROUP BY vault_id ORDER BY total DESC`,
    [userId],
  );
  return rows.map((r) => ({
    vaultId: r.vault_id,
    count: Number(r.total ?? 0),
    bytes: Number(r.bytes ?? 0),
  }));
}

/** 从文件名 / MIME 推断头像扩展名 */
function avatarExt(filename, mimetype) {
  const raw = String(filename ?? '').toLowerCase();
  const dot = raw.lastIndexOf('.');
  const ext = dot >= 0 ? raw.slice(dot + 1) : '';
  if (AVATAR_TYPES[ext]) return ext;
  const map = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp' };
  return map[String(mimetype ?? '').toLowerCase()] ?? 'png';
}

export async function profileRoutes(app) {
  // 资料 + 统计
  app.get('/api/profile', { preHandler: [app.authenticate] }, async (req, reply) => {
    const row = await loadUserRow(req.user.id);
    if (!row) throw notFound('账号不存在', 'USER_NOT_FOUND');

    const [shareStats, publishStats, vaultStats, backupStats] = await Promise.all([
      queryOne(
        'SELECT COUNT(*) AS total, COALESCE(SUM(view_count), 0) AS views FROM shares WHERE user_id = ? AND revoked_at IS NULL',
        [row.id],
      ),
      queryOne('SELECT COUNT(*) AS total FROM publishes WHERE user_id = ? AND revoked_at IS NULL', [row.id]),
      queryOne(
        `SELECT COUNT(*) AS vaults, COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(doc_count), 0) AS docs
         FROM user_vaults WHERE user_id = ?`,
        [row.id],
      ),
      queryOne('SELECT COUNT(*) AS total FROM backups WHERE user_id = ?', [row.id]),
    ]);

    return ok(reply, {
      user: profileUser(row),
      stats: {
        shares: Number(shareStats?.total ?? 0),
        shareViews: Number(shareStats?.views ?? 0),
        publishes: Number(publishStats?.total ?? 0),
        vaults: Number(vaultStats?.vaults ?? 0),
        documents: Number(vaultStats?.docs ?? 0),
        storageBytes: Number(vaultStats?.bytes ?? 0),
        backups: Number(backupStats?.total ?? 0),
      },
    });
  });

  // 修改昵称 / 头像地址
  app.put('/api/profile', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = parse(updateSchema, req.body, '资料内容');
    const current = await loadUserRow(req.user.id);
    if (!current) throw notFound('账号不存在', 'USER_NOT_FOUND');

    const nextNickname = body.nickname === undefined ? current.nickname ?? null : body.nickname === null ? null : body.nickname;
    const nextAvatar =
      body.avatarUrl === undefined ? current.avatar_url ?? null : body.avatarUrl === '' || body.avatarUrl === null ? null : body.avatarUrl;

    await execute('UPDATE users SET nickname = ?, avatar_url = ? WHERE id = ?', [nextNickname, nextAvatar, current.id]);
    await audit(req, 'profile.update', `user:${current.id}`, {
      nickname: nextNickname,
      avatarUrl: nextAvatar,
      before: { nickname: current.nickname ?? null, avatarUrl: current.avatar_url ?? null },
    });

    const updated = await loadUserRow(req.user.id);
    return ok(reply, { user: profileUser(updated) });
  });

  // 修改密码：改完把该用户所有刷新令牌作废
  app.put('/api/profile/password', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = parse(passwordChangeSchema, req.body, '密码信息');
    const row = await queryOne('SELECT id, pass_hash FROM users WHERE id = ? LIMIT 1', [req.user.id]);
    if (!row) throw notFound('账号不存在', 'USER_NOT_FOUND');

    const oldPassword = body.oldPassword ?? body.currentPassword ?? '';
    const passed = await verifyPassword(row.pass_hash, oldPassword);
    if (!passed) throw unauthorized('当前密码不正确', 'PASSWORD_MISMATCH');

    const passHash = await hashPassword(body.newPassword);
    await execute('UPDATE users SET pass_hash = ? WHERE id = ?', [passHash, row.id]);
    await execute('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [row.id]);
    await audit(req, 'profile.password_change', `user:${row.id}`);

    return ok(reply, { updated: true, reLoginRequired: true });
  });

  /* ------------------------------ 备份 ------------------------------ */

  // 备份列表（1.1.5 起支持按仓库过滤：`?vaultId=xxx`）
  //
  // 为什么要按仓库过滤：一个用户可能有多本仓库，备份混在一起列表会很难用。
  // vaultId 做字形校验（防注入与脏参数），但不校验归属——因为备份记录本身已按
  // `user_id = req.user.id` 过滤，别人的 vaultId 只会查到空列表，不会泄露数据。
  app.get('/api/profile/backups', { preHandler: [app.authenticate] }, async (req, reply) => {
    const vaultIdRaw = String(req.query?.vaultId ?? '').trim();
    let rows;
    if (vaultIdRaw) {
      const vaultId = assertVaultIdShape(vaultIdRaw);
      rows = await query(
        'SELECT * FROM backups WHERE user_id = ? AND vault_id = ? ORDER BY id DESC LIMIT 200',
        [req.user.id, vaultId],
      );
    } else {
      rows = await query('SELECT * FROM backups WHERE user_id = ? ORDER BY id DESC LIMIT 200', [
        req.user.id,
      ]);
    }
    return ok(reply, {
      items: rows.map(backupItem),
      /** 未指定 vaultId 时额外返回按仓库分组的计数，便于前端做过滤下拉 */
      byVault: vaultIdRaw
        ? undefined
        : await loadBackupCountsByVault(req.user.id),
    });
  });

  // 登记备份
  app.post('/api/profile/backups', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = parse(backupSchema, req.body, '备份信息');
    const prefixes = allowedKeyPrefixes(req.user.username);
    if (!prefixes.some((prefix) => body.ossKey.startsWith(prefix))) {
      throw new HttpError(
        400,
        'BACKUP_KEY_INVALID',
        `备份对象键必须以 ${prefixes[0]} 或 ${prefixes[1]} 开头`,
      );
    }

    const result = await execute(
      `INSERT INTO backups (user_id, vault_id, name, doc_count, bytes, oss_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [req.user.id, body.vaultId, body.name, body.docCount, body.bytes, body.ossKey],
    );
    const row = await queryOne('SELECT * FROM backups WHERE id = ? LIMIT 1', [Number(result.insertId)]);
    await audit(req, 'profile.backup.create', `backup:${result.insertId}`, {
      vaultId: body.vaultId,
      bytes: body.bytes,
      ossKey: body.ossKey,
    });

    return ok(reply, { backup: backupItem(row) }, 201);
  });

  // 删除备份（仅本人，同时删对象）
  app.delete('/api/profile/backups/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const id = parseId(req.params.id, '备份编号');
    const row = await queryOne('SELECT id, user_id, oss_key FROM backups WHERE id = ? LIMIT 1', [id]);
    if (!row) throw notFound('备份不存在', 'BACKUP_NOT_FOUND');
    if (Number(row.user_id) !== req.user.id) {
      throw new HttpError(403, 'BACKUP_FORBIDDEN', '只能删除自己的备份');
    }

    if (row.oss_key) await deletePlatformObject(row.oss_key);
    await execute('DELETE FROM backups WHERE id = ?', [id]);
    await audit(req, 'profile.backup.delete', `backup:${id}`, { ossKey: row.oss_key });

    return ok(reply, { id, deleted: true });
  });

  /* ------------------------------ 头像 ------------------------------ */

  // 上传头像（multipart，≤2MB，仅图片）
  app.post('/api/profile/avatar', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!req.isMultipart()) {
      throw new HttpError(400, 'NOT_MULTIPART', '请使用 multipart/form-data 上传头像');
    }

    // 先按 Content-Length 拦一道：multipart 边界与表头开销很小，留 64KB 余量即可
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > AVATAR_LIMIT + 64 * 1024) {
      throw new HttpError(413, 'AVATAR_TOO_LARGE', '头像不能超过 2MB');
    }

    let file;
    try {
      file = await req.file({ limits: { fileSize: AVATAR_LIMIT } });
    } catch (err) {
      if (err && (err.code === 'FST_REQ_FILE_TOO_LARGE' || err.code === 'FST_FILES_LIMIT')) {
        throw new HttpError(413, 'AVATAR_TOO_LARGE', '头像不能超过 2MB');
      }
      throw new HttpError(400, 'AVATAR_UPLOAD_FAILED', `读取上传内容失败：${err.message}`);
    }
    if (!file) throw new HttpError(400, 'NO_FILE', '请选择要上传的头像图片');

    let buffer;
    try {
      buffer = await file.toBuffer();
    } catch (err) {
      if (err && (err.code === 'FST_REQ_FILE_TOO_LARGE' || /File size limit/i.test(String(err.message)))) {
        throw new HttpError(413, 'AVATAR_TOO_LARGE', '头像不能超过 2MB');
      }
      throw new HttpError(400, 'AVATAR_UPLOAD_FAILED', `读取上传内容失败：${err.message}`);
    }
    // 解析器可能静默截断，truncated 与长度双重校验
    if (file.truncated || buffer.length === 0) {
      throw file.truncated ? new HttpError(413, 'AVATAR_TOO_LARGE', '头像不能超过 2MB') : new HttpError(400, 'EMPTY_FILE', '文件内容为空');
    }
    if (buffer.length > AVATAR_LIMIT) throw new HttpError(413, 'AVATAR_TOO_LARGE', '头像不能超过 2MB');

    const mimetype = String(file.mimetype ?? '');
    if (!mimetype.startsWith('image/')) {
      throw new HttpError(400, 'AVATAR_TYPE_INVALID', '头像只支持图片文件');
    }

    const ext = avatarExt(file.filename, mimetype);
    const key = joinKey(userPrefix(req.user.username), 'ot', `avatar-${Date.now()}.${ext}`);
    try {
      await putPlatformObject(key, buffer, AVATAR_TYPES[ext] ?? mimetype);
    } catch (err) {
      throw new HttpError(502, 'OSS_UPLOAD_FAILED', `上传头像失败：${err.message}`);
    }

    const url = config.oss.publicRead ? platformPublicUrl(key) : presignPlatformGet(key, AVATAR_URL_TTL);
    await execute('UPDATE users SET avatar_url = ? WHERE id = ?', [url, req.user.id]);
    await audit(req, 'profile.avatar', `user:${req.user.id}`, { key, size: buffer.length });

    return ok(reply, { url, key, size: buffer.length, contentType: AVATAR_TYPES[ext] ?? mimetype }, 201);
  });
}

export default profileRoutes;
