/**
 * 仓库注册表 API（1.1.5）。
 *
 * 背景：客户端每个仓库目录都有自己的 `vaultId`（存 `.neomd/vault.json`），
 * 1.1.5 之前服务端存储前缀不含 vaultId，导致同一账号的多个仓库互相覆盖。
 * 本路由负责把「用户有哪些仓库」登记到 `user_vaults`，并支撑改名 / 停用 / 删除 / 复制。
 *
 * 与存储层的关系：
 *  - 注册信息（本文件）决定「某 vaultId 是否可用」；
 *  - 实际数据落在 `mdadmin/neomd/users/<username>/vaults/<vaultId>/`（见 lib/vault-scope.js）；
 *  - `storage.js` 每次读写都会调 `assertVaultUsable()`，因此**停用即生效**、无需额外同步。
 */
import { z } from 'zod';
import { execute, query, queryOne } from '../db/pool.js';
import { HttpError, ok } from '../lib/http.js';
import { parse } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { userRateLimit } from '../middleware/rate.js';
import { assertVaultIdShape, getVaultRow, userVaultsRoot, vaultItem, vaultPrefix } from '../lib/vault-scope.js';
import {
  deletePlatformObject,
  getPlatformObject,
  platformConfig,
  putPlatformObject,
} from '../lib/oss.js';
// listObjects 只在 s3.js 里导出（oss.js 未再导出），这里直接用底层实现
import { listObjects } from '../lib/s3.js';

/** 单次复制允许的最大对象数：防止复制巨型仓库把服务拖垮 */
const MAX_COPY_OBJECTS = 5000;
/** 复制时列举/读取的分页大小 */
const COPY_PAGE_SIZE = 1000;

/** 仓库写操作限流（注册/改名/删除/复制属于低频操作，20 次/分钟足够） */
const vaultWriteLimit = userRateLimit('vault', { max: 20, windowMs: 60_000 });

/* ------------------------------------------------------------------ */
/* 请求校验                                                            */
/* ------------------------------------------------------------------ */

const registerSchema = z.object({
  vaultId: z
    .string({ error: '缺少仓库标识' })
    .trim()
    .min(1, { message: '缺少仓库标识' })
    .max(64, { message: '仓库标识最多 64 个字符' }),
  name: z
    .string({ error: '缺少仓库名称' })
    .trim()
    .min(1, { message: '仓库名称不能为空' })
    .max(120, { message: '仓库名称最多 120 个字符' }),
  docCount: z.coerce.number().int().min(0).max(10_000_000).optional().default(0),
  bytes: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().default(0),
  /** 客户端上报「刚刚同步过」时可带上，用于仓库列表展示最近同步时间 */
  markSynced: z.boolean().optional().default(false),
});

const patchSchema = z
  .object({
    name: z.string().trim().min(1, { message: '仓库名称不能为空' }).max(120).optional(),
    status: z.enum(['active', 'disabled'], { error: '状态只能是 active 或 disabled' }).optional(),
  })
  .refine((v) => v.name !== undefined || v.status !== undefined, {
    message: '请至少提供 name 或 status',
  });

const copySchema = z.object({
  newVaultId: z
    .string({ error: '缺少新仓库标识' })
    .trim()
    .min(1, { message: '缺少新仓库标识' })
    .max(64)
    .optional(),
  newName: z.string().trim().min(1, { message: '新仓库名称不能为空' }).max(120).optional(),
});

const purgeQuerySchema = z.object({
  purge: z
    .union([z.literal('1'), z.literal('0'), z.literal('true'), z.literal('false')])
    .optional()
    .default('0'),
});

/** 生成一个可用的新 vaultId（复制时未指定则自动生成） */
function generateVaultId() {
  // 16 位随机串，满足 ^[A-Za-z0-9_-]{4,64}$，且与客户端生成风格接近
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = 'v';
  for (let i = 0; i < 15; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export async function vaultRoutes(app) {
  /* ------------------------------ 列表 ------------------------------ */

  app.get('/api/vaults', { preHandler: [app.authenticate] }, async (req, reply) => {
    const rows = await query(
      'SELECT * FROM user_vaults WHERE user_id = ? ORDER BY updated_at DESC, id DESC',
      [req.user.id],
    );
    return ok(reply, {
      vaults: rows.map(vaultItem),
      /** 新前缀根，便于客户端排查「我的数据在哪个前缀」 */
      storageRoot: userVaultsRoot(req.user.username),
    });
  });

  /* ------------------------------ 注册（幂等 upsert） ------------------------------ */

  /**
   * 注册或更新仓库。
   *
   * 幂等：同一 `(user_id, vault_id)` 只保留一行，重复调用只更新名称与统计，
   * 因此客户端可以在「打开仓库」「每次同步完成」时无脑调用，不会产生脏数据。
   */
  app.post('/api/vaults', { preHandler: [app.authenticate, vaultWriteLimit] }, async (req, reply) => {
    const body = parse(registerSchema, req.body ?? {}, '仓库信息');
    const vaultId = assertVaultIdShape(body.vaultId);

    // 已存在时要保留原有 status：用户手动停用的仓库，不该因为一次同步请求就被悄悄启用
    const existing = await getVaultRow(req.user.id, vaultId);

    await execute(
      `INSERT INTO user_vaults (user_id, vault_id, name, doc_count, bytes, status, last_synced_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, NOW())
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         doc_count = VALUES(doc_count),
         bytes = VALUES(bytes),
         last_synced_at = VALUES(last_synced_at),
         updated_at = NOW()`,
      [
        req.user.id,
        vaultId,
        body.name,
        body.docCount,
        body.bytes,
        body.markSynced ? new Date() : (existing?.last_synced_at ?? null),
      ],
    );

    const row = await getVaultRow(req.user.id, vaultId);
    await audit(req, existing ? 'vault.update' : 'vault.register', vaultId, {
      name: body.name,
      docCount: body.docCount,
      bytes: body.bytes,
    });

    // 新建返回 201，更新返回 200，便于客户端区分
    return ok(reply, { vault: vaultItem(row), created: !existing }, existing ? 200 : 201);
  });

  /* ------------------------------ 改名 / 停用 / 启用 ------------------------------ */

  app.patch(
    '/api/vaults/:vaultId',
    { preHandler: [app.authenticate, vaultWriteLimit] },
    async (req, reply) => {
      const vaultId = assertVaultIdShape(req.params.vaultId);
      const body = parse(patchSchema, req.body ?? {}, '仓库修改');
      const existing = await getVaultRow(req.user.id, vaultId);
      if (!existing) throw new HttpError(404, 'VAULT_NOT_FOUND', '仓库不存在或不属于当前账号');

      // 逐字段拼 SET，避免把未提供的字段写成 NULL
      const sets = [];
      const params = [];
      if (body.name !== undefined) {
        sets.push('name = ?');
        params.push(body.name);
      }
      if (body.status !== undefined) {
        sets.push('status = ?');
        params.push(body.status);
      }
      sets.push('updated_at = NOW()');
      params.push(req.user.id, vaultId);
      await execute(`UPDATE user_vaults SET ${sets.join(', ')} WHERE user_id = ? AND vault_id = ?`, params);

      const row = await getVaultRow(req.user.id, vaultId);
      await audit(req, 'vault.patch', vaultId, { name: body.name, status: body.status });
      return ok(reply, { vault: vaultItem(row) });
    },
  );

  /* ------------------------------ 删除 ------------------------------ */

  /**
   * 删除仓库注册记录。
   *
   * **默认不删对象存储里的内容**（防误删）：删注册只让该仓库从列表消失，
   * 数据仍在 `vaults/<vaultId>/` 下，重新注册同 vaultId 即可恢复。
   * 只有显式带 `?purge=1` 才清理对象，且**严格限制在该 vaultId 前缀内**。
   */
  app.delete(
    '/api/vaults/:vaultId',
    { preHandler: [app.authenticate, vaultWriteLimit] },
    async (req, reply) => {
      const vaultId = assertVaultIdShape(req.params.vaultId);
      const params = parse(purgeQuerySchema, req.query ?? {}, '删除参数');
      const purge = params.purge === '1' || params.purge === 'true';

      const existing = await getVaultRow(req.user.id, vaultId);
      if (!existing) throw new HttpError(404, 'VAULT_NOT_FOUND', '仓库不存在或不属于当前账号');

      let purgedObjects = 0;
      if (purge) {
        const prefix = vaultPrefix(req.user.username, vaultId);
        // 双重保险：清理前缀必须落在本用户的 vaults 根下
        if (!prefix.startsWith(userVaultsRoot(req.user.username))) {
          throw new HttpError(403, 'VAULT_FORBIDDEN', '清理前缀越界');
        }
        purgedObjects = await purgeVaultObjects(prefix);
      }

      await execute('DELETE FROM user_vaults WHERE user_id = ? AND vault_id = ?', [req.user.id, vaultId]);
      await audit(req, 'vault.delete', vaultId, { purge, purgedObjects });
      return ok(reply, { vaultId, deleted: true, purged: purge, purgedObjects });
    },
  );

  /* ------------------------------ 复制 ------------------------------ */

  /**
   * 复制仓库：把源 vault 前缀下所有对象复制到新 vault 前缀，并登记新仓库。
   *
   * 实现选择「读 + 写」而不是 S3 服务端 copy：
   *  - 本项目 `lib/s3.js` 未实现 CopyObject（需要 `x-amz-copy-source` 签名，改动面较大）；
   *  - 同步对象多为几十 KB 的 .md，逐个小对象读写足够快；
   *  - 逐个处理可控制内存：任何时刻只有一个对象的字节驻留内存。
   *
   * 保护：对象数超过 MAX_COPY_OBJECTS 直接 400，避免复制巨型仓库拖垮服务。
   */
  app.post(
    '/api/vaults/:vaultId/copy',
    { preHandler: [app.authenticate, vaultWriteLimit] },
    async (req, reply) => {
      const srcVaultId = assertVaultIdShape(req.params.vaultId);
      const body = parse(copySchema, req.body ?? {}, '复制参数');

      // **先校验客户端输入，再访问数据库**：
      // 参数非法属于调用方错误，应在触达 DB/OSS 之前就返回 400，
      // 否则 DB 抖动时会把「参数写错」误报成 500，排查成本高。
      const targetId = body.newVaultId ? assertVaultIdShape(body.newVaultId, '新仓库标识') : '';
      if (targetId && targetId === srcVaultId) {
        throw new HttpError(400, 'VAULT_COPY_SELF', '新仓库标识不能与源仓库相同');
      }

      const srcRow = await getVaultRow(req.user.id, srcVaultId);
      if (!srcRow) throw new HttpError(404, 'VAULT_NOT_FOUND', '源仓库不存在或不属于当前账号');

      // 目标 vaultId：未指定则生成
      const newVaultId = targetId || generateVaultId();
      const targetExists = await getVaultRow(req.user.id, newVaultId);
      if (targetExists) {
        throw new HttpError(409, 'VAULT_ID_TAKEN', '新仓库标识已被占用，请换一个');
      }

      const srcPrefix = vaultPrefix(req.user.username, srcVaultId);
      const dstPrefix = vaultPrefix(req.user.username, newVaultId);
      // 双重保险：源与目标都必须落在本用户 vaults 根下
      const root = userVaultsRoot(req.user.username);
      if (!srcPrefix.startsWith(root) || !dstPrefix.startsWith(root)) {
        throw new HttpError(403, 'VAULT_FORBIDDEN', '复制前缀越界');
      }

      // 先探测对象数量，超限直接拒绝（不产生任何副作用）
      let probe;
      try {
        probe = await listObjects(platformConfig(), srcPrefix, MAX_COPY_OBJECTS + 1);
      } catch (err) {
        throw new HttpError(502, 'VAULT_COPY_LIST_FAILED', `读取源仓库失败：${err.message}`);
      }
      if (probe.objects.length > MAX_COPY_OBJECTS) {
        throw new HttpError(
          400,
          'VAULT_COPY_TOO_LARGE',
          `源仓库对象数超过 ${MAX_COPY_OBJECTS} 个，请先在客户端精简后再复制`,
        );
      }

      // 逐个复制（单个对象失败不中断整体，记入 failed 列表返回）
      const failed = [];
      let copied = 0;
      let copiedBytes = 0;
      for (const obj of probe.objects) {
        const relative = obj.key.slice(srcPrefix.length);
        if (!relative) continue;
        try {
          const source = await getPlatformObject(obj.key);
          await putPlatformObject(
            `${dstPrefix}${relative}`,
            source.buffer,
            source.contentType || 'application/octet-stream',
          );
          copied += 1;
          copiedBytes += source.size;
        } catch (err) {
          failed.push({ key: relative, error: err.message });
        }
      }

      // 登记新仓库（沿用源仓库的统计口径，名称取用户指定或「原名 副本」）
      const newName = body.newName || `${srcRow.name ?? '仓库'} 副本`;
      await execute(
        `INSERT INTO user_vaults (user_id, vault_id, name, doc_count, bytes, status, last_synced_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', NULL, NOW())
         ON DUPLICATE KEY UPDATE name = VALUES(name), doc_count = VALUES(doc_count), bytes = VALUES(bytes), updated_at = NOW()`,
        [req.user.id, newVaultId, newName, Number(srcRow.doc_count ?? 0), copiedBytes],
      );

      const row = await getVaultRow(req.user.id, newVaultId);
      await audit(req, 'vault.copy', newVaultId, { from: srcVaultId, copied, failed: failed.length });

      return ok(
        reply,
        {
          vault: vaultItem(row),
          newVaultId,
          copied,
          failed,
          /** 部分失败时前端应提示用户，而不是当成完全成功 */
          partial: failed.length > 0,
        },
        201,
      );
    },
  );
}

/**
 * 清理某前缀下的全部对象（仅用于 `?purge=1`）。
 * 逐页列举并删除，避免一次性把上万个 key 读进内存。
 */
async function purgeVaultObjects(prefix) {
  let deleted = 0;
  // 最多翻 50 页（= 5 万个对象），防止异常情况下无限循环
  for (let page = 0; page < 50; page++) {
    const result = await listObjects(platformConfig(), prefix, COPY_PAGE_SIZE);
    if (result.objects.length === 0) break;
    for (const obj of result.objects) {
      // 只删前缀内的对象（listObjects 已按前缀返回，这里再断言一次）
      if (!obj.key.startsWith(prefix)) continue;
      await deletePlatformObject(obj.key);
      deleted += 1;
    }
    // 未截断说明已到末尾
    if (!result.truncated) break;
  }
  return deleted;
}

export default vaultRoutes;
