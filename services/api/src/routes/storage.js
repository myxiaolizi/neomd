/**
 * 平台存储代理：让「没有自配 S3 的登录用户」也能用服务器自己的对象存储做多端同步。
 *
 * 为什么需要这一层：
 *  - 平台 OSS 的 AccessKey 只存在服务端（`lib/oss.js` 的 `platformConfig()`），
 *    浏览器/桌面端绝不能拿到密钥；
 *  - 但 `SyncEngine` 需要 `StorageClient` 的「列举 / 读 / 写 / 删」能力，
 *    于是由本路由按用户隔离地把这些操作代理到平台桶。
 *
 * 多端一致性链路（重要，排查同步问题时按此顺序看）：
 *   1. **PC 端本地文件夹**与 **Web 端 IndexedDB** 都只是「本地副本」，
 *      它们之间没有任何直连通道，谁也不会去读对方；
 *   2. 真正的一致性由 `SyncEngine` 经**平台存储**达成：
 *      `docs/<docId>/<rev>-<hash>.md`（正文） + `docs/<docId>/manifest.json`（元数据）
 *      + `index/<deviceId>.json`（各设备状态） + `versions/<docId>/...`（历史版本）；
 *   3. 各端 `rootPrefix` 统一为 `mdadmin/neomd/users/<username>/`，
 *      因此 A 端写入的 blob 与 B 端要拉的 blob 是**同一个对象键**；
 *   4. 与「设置分区同步」的区别：设置是 global 强一致 + platform 差异化，
 *      而仓库正文**不做平台差异化**——同一个用户的任意端看到的文档集合必须完全一致。
 *
 * 安全边界（硬性）：
 *  - 客户端提交的 key 一律视为**相对 key**，服务端强制拼接 `<用户前缀>`；
 *  - 拒绝 `..` 穿越、绝对路径、反斜杠、空段、控制字符；
 *  - 拼接结果必须仍以用户前缀开头（双保险，防拼接后越界）；
 *  - 任何越界一律 403，不泄露「是否存在该对象」。
 */
import { z } from 'zod';
import config from '../config.js';
import { queryOne } from '../db/pool.js';
import { HttpError, ok } from '../lib/http.js';
import { parse } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { userRateLimit } from '../middleware/rate.js';
import {
  PLATFORM_PREFIX,
  deletePlatformObject,
  getPlatformObject,
  platformConfig,
  platformPublicUrl,
  presignPlatformGet,
  presignPlatformPut,
  putPlatformObject,
} from '../lib/oss.js';
import { headObject, listObjects } from '../lib/s3.js';
import {
  LEGACY_HEADER,
  assertVaultIdShape,
  assertVaultUsable,
  legacyUserPrefix,
  readVaultId,
  userVaultsRoot,
  vaultPrefix,
} from '../lib/vault-scope.js';
import {
  isLegacyReadEnabled,
  legacyGetObject,
  legacyList,
  scheduleMigration,
} from '../lib/vault-legacy.js';

/** 单次列举上限（与 S3 ListObjectsV2 一致） */
const MAX_LIST_KEYS = 1000;
/** 单对象大小上限：与普通上传保持一致，避免代理层被用来传超大文件 */
const MAX_OBJECT_BYTES = config.server.uploadLimit;
/** 用户前缀的根（不含用户名），与 settings.sync.rootPrefix 的默认值对齐 */
const USER_ROOT = `${PLATFORM_PREFIX}neomd/users/`;

/* ------------------------------------------------------------------ */
/* 作用域解析（vaultId 隔离 + 旧前缀兼容）                              */
/* ------------------------------------------------------------------ */

/**
 * 解析本次请求的作用域前缀。
 *
 * 1.1.5 起存储按仓库隔离：`users/<username>/vaults/<vaultId>/`。
 * 但线上已有用户在旧前缀 `users/<username>/` 下存了数据，直接切会让数据「消失」，
 * 因此未携带 vaultId 的请求仍走旧前缀，并在响应头打 `x-vault-legacy: 1` 便于观测，
 * 观察一段时间确认老客户端退场后再移除该分支。
 *
 * @param {object} req Fastify 请求
 * @param {object|null} [body] 请求体（vaultId 也可能从 body 传）
 * @param {object} [reply] Fastify 响应（用于写兼容标记头）
 * @returns {Promise<{ prefix: string, vaultId: string|null, legacy: boolean }>}
 */
async function resolveScope(req, body = null, reply = null) {
  const rawVaultId = readVaultId(req, body);

  if (!rawVaultId) {
    // 兼容路径：老客户端不带 vaultId
    const prefix = legacyUserPrefix(req.user.username);
    if (reply) reply.header(LEGACY_HEADER, '1');
    return { prefix, vaultId: null, legacy: true };
  }

  // 新路径：字形非法 → 400；不属于本用户或已停用 → 403（由 assertVaultUsable 抛）
  const vaultId = assertVaultIdShape(rawVaultId);
  await assertVaultUsable(req.user.id, vaultId);

  // 方案 A：惰性迁移。首次带该 vaultId 的请求会后台把旧前缀内容复制到新前缀。
  // 注意 scheduleMigration 内部 setImmediate + 内存去重，**不会阻塞本次请求**。
  scheduleMigration(req.user.username, vaultId, req.log);

  return { prefix: vaultPrefix(req.user.username, vaultId), vaultId, legacy: false };
}

/* ------------------------------------------------------------------ */
/* 方案 C：双读回退（仅供老数据兼容，迁移完成后必须移除）              */
/* ------------------------------------------------------------------ */

/**
 * 是否允许本次请求走旧前缀回退。
 *
 * **本分支是临时兼容措施**：
 *  - 触发条件：带 vaultId（新体系）+ `STORAGE_LEGACY_READ` 未关闭；
 *  - 退场条件：线上 `x-vault-legacy` 统计归零 + 方案 A 迁移全部完成后，
 *    删除本函数与 `legacyList` / `legacyGetObject` 的调用点；
 *  - 紧急开关：`STORAGE_LEGACY_READ=0` 可一键关闭，无需改代码。
 */
function canFallbackLegacy(scope) {
  return Boolean(scope.vaultId) && isLegacyReadEnabled();
}

/* ------------------------------------------------------------------ */
/* key 校验与拼接                                                      */
/* ------------------------------------------------------------------ */

/** 是否包含非法字符（控制字符、反斜杠、空字节） */
const ILLEGAL_CHARS_RE = /[\u0000-\u001f\u007f\\]/;

/**
 * 校验 key 的字面合法性（不涉及用户归属）。
 *
 * 返回去掉前导斜杠后的原样 key；任何可疑输入直接抛 403。
 * 这里刻意比「宽松清洗」严格：同步链路里出现 `..` 一定是 bug 或攻击，
 * 静默纠正会把问题藏起来，不如直接拒绝。
 */
export function validateKeyShape(raw) {
  const input = String(raw ?? '').trim();
  if (!input) throw new HttpError(400, 'OBJECT_KEY_REQUIRED', '缺少对象 key');
  if (input.length > 512) throw new HttpError(400, 'OBJECT_KEY_TOO_LONG', '对象 key 过长（最多 512 字符）');
  if (ILLEGAL_CHARS_RE.test(input)) {
    throw new HttpError(403, 'OBJECT_KEY_FORBIDDEN', '对象 key 含非法字符');
  }
  // 绝对路径（含 Windows 盘符与协议式前缀）一律拒绝
  if (/^[a-zA-Z]:/.test(input) || input.startsWith('/') || input.startsWith('//')) {
    throw new HttpError(403, 'OBJECT_KEY_FORBIDDEN', '对象 key 不允许使用绝对路径');
  }
  // 目录式前缀（`docs/`、`index/`）允许单个尾斜杠：列举接口依赖它表达「以该目录为根」。
  // 校验时先剥掉尾斜杠，避免被下面的空段检查误判为路径穿越。
  const body = input.endsWith('/') ? input.slice(0, -1) : input;
  if (!body) throw new HttpError(403, 'OBJECT_KEY_FORBIDDEN', '对象 key 不允许只有斜杠');
  const segments = body.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new HttpError(403, 'OBJECT_KEY_FORBIDDEN', '对象 key 含非法路径片段（不允许空段、. 或 ..）');
  }
  return input;
}

/**
 * 把客户端提交的 key 归一化成「相对本次作用域前缀的 key」。
 *
 * 三种输入形态与处理方式（**这是跨端同步能否对齐的关键**）：
 *  1. 相对 key（`docs/<docId>/1-abc.md`）→ 直接使用；
 *  2. 本作用域的完整 key（`<prefix>docs/...`）→ **剥离该前缀**，用剩余部分。
 *     `SyncEngine` 的 `rootPrefix` 已含完整前缀，它传给 StorageClient 的就是完整 key，
 *     若不剥离，拼接后会变成 `<prefix><prefix>docs/...`（双前缀）导致读写永远对不上；
 *  3. 落在用户根下但不在本作用域前缀内（其它用户 / 同用户其它仓库）→ **403**，绝不重定基。
 *     重定基虽然"安全"（不会真读到别人数据），但会把攻击/串号静默变成一次成功写入，
 *     掩盖问题且污染目标空间。
 *
 * @param {string} prefix 本次作用域前缀（以 / 结尾），如 `mdadmin/neomd/users/u/vaults/vid/`
 * @param {string} raw 客户端提交的 key
 */
export function toRelativeKey(prefix, raw) {
  const scope = String(prefix ?? '');
  if (!scope.endsWith('/')) throw new HttpError(500, 'SCOPE_INVALID', '作用域前缀配置异常');
  const input = validateKeyShape(raw);

  // 形态 2：本作用域完整 key → 剥离前缀
  if (input.startsWith(scope)) {
    const relative = input.slice(scope.length);
    if (!relative) throw new HttpError(400, 'OBJECT_KEY_REQUIRED', '缺少对象 key');
    return relative;
  }

  // 形态 3：落在用户空间（含其它仓库）但不是本作用域 → 明确越界
  if (input.startsWith(USER_ROOT)) {
    throw new HttpError(403, 'OBJECT_KEY_FORBIDDEN', '对象 key 越界：只能访问当前仓库的存储空间');
  }

  // 形态 1：相对 key
  return input;
}

/**
 * 把相对 key 拼成本作用域的完整对象键，并做「结果必须以该前缀开头」的最终校验。
 * @param {string} prefix 作用域前缀（以 / 结尾）
 * @param {string} raw 客户端提交的 key（相对 key 或本作用域完整 key）
 * @returns {{ key: string, relative: string }}
 */
export function resolveScopedKey(prefix, raw) {
  const scope = String(prefix ?? '');
  const relative = toRelativeKey(scope, raw);
  const key = `${scope}${relative}`;
  // 双保险：拼接后必须仍在作用域内，且不含穿越片段（防任何漏网之鱼）
  if (!key.startsWith(scope) || key.includes('..')) {
    throw new HttpError(403, 'OBJECT_KEY_FORBIDDEN', '对象 key 越界：只能访问当前仓库的存储空间');
  }
  return { key, relative };
}

/**
 * @deprecated 1.1.5 起请用 `resolveScopedKey(prefix, raw)`。
 * 保留此签名仅为兼容可能的旧调用方（按「旧前缀 + 用户名」解析）。
 */
export function resolveUserKey(username, raw) {
  return resolveScopedKey(legacyUserPrefix(username), raw);
}

/** 该用户的对象前缀（旧前缀，仅兼容期使用） */
export function userPrefixOf(username) {
  return legacyUserPrefix(username);
}

/* ------------------------------------------------------------------ */
/* 请求体与查询串校验                                                  */
/* ------------------------------------------------------------------ */

const listQuerySchema = z.object({
  prefix: z.string().max(512).optional().default(''),
  maxKeys: z.coerce.number().int().min(1).max(MAX_LIST_KEYS).optional().default(MAX_LIST_KEYS),
  /** 兼容 S3 语义的游标（透传给底层 listObjects 不生效，这里仅占位保证前端可传） */
  continuationToken: z.string().max(1024).optional(),
});

const keyQuerySchema = z.object({
  key: z.string({ error: '缺少对象 key' }).trim().min(1, { message: '缺少对象 key' }).max(512),
});

const presignSchema = z.object({
  key: z.string({ error: '缺少对象 key' }).trim().min(1, { message: '缺少对象 key' }).max(512),
  method: z.enum(['GET', 'PUT']).optional().default('GET'),
  expiresSeconds: z.coerce.number().int().min(60).max(604800).optional().default(3600),
  contentType: z.string().trim().max(120).optional(),
});

/**
 * 同步专用限流桶。
 *
 * 为什么不用现成的 `upload` 桶：一次全量同步会有 `2N+2` 个请求
 * （N 篇文档 = N 个 PUT + N 个 GET，外加 1 次列举与 1 次 index 写入），
 * 按默认 30 次/分钟会在同步第 15 篇时就被 429 打断。
 * 这里用 `userRateLimit` 的 overrides 放宽到 900 次/分钟，
 * 既能承载千篇级仓库的增量同步，又保留了对异常刷接口的防护。
 */
const storageRateLimit = userRateLimit('storage', { max: 900, windowMs: 60_000 });

/** 用户已用容量（与 routes/upload.js 同一口径） */async function usedBytes(userId) {
  const row = await queryOne('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM user_vaults WHERE user_id = ?', [userId]);
  return Number(row?.bytes ?? 0);
}

/** 从请求里取出原始字节（支持 octet-stream 与 multipart 两种投递方式） */
async function readRawBody(req) {
  if (req.isMultipart && req.isMultipart()) {
    const file = await req.file({ limits: { fileSize: MAX_OBJECT_BYTES } });
    if (!file) throw new HttpError(400, 'EMPTY_BODY', '缺少上传内容');
    const buffer = await file.toBuffer();
    const headerKey = req.headers['x-object-key'];
    const fieldKey = file.fields?.key;
    const fieldValue = Array.isArray(fieldKey) ? fieldKey[0]?.value : fieldKey?.value;
    return {
      buffer,
      key: String(headerKey ?? fieldValue ?? '').trim(),
      contentType: file.mimetype || 'application/octet-stream',
    };
  }
  const buffer = await req.body;
  if (!Buffer.isBuffer(buffer)) {
    throw new HttpError(400, 'EMPTY_BODY', '请求体必须是原始字节流（application/octet-stream）');
  }
  const headerKey = req.headers['x-object-key'];
  return {
    buffer,
    key: String(headerKey ?? '').trim(),
    contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
  };
}

export async function storageRoutes(app) {
  /**
   * 注册原始字节解析器（仅在本插件作用域内生效，不影响其它路由）。
   *
   * 为什么必须显式注册：Fastify 默认只解析 application/json 与 text/plain，
   * 同步客户端用 `application/octet-stream` 直接投递文件字节（避免 base64 膨胀 33%），
   * 不注册就会拿到 undefined body。
   */
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  /* ------------------------------ 列举 ------------------------------ */

  /**
   * 列出该用户（指定仓库）前缀下的对象。
   * 注意：客户端传的 prefix 同样是**相对**前缀，服务端强制拼作用域前缀后再列举，
   * 因此不可能通过 prefix 窥探其它用户或其它仓库的目录。
   */
  app.get('/api/storage/list', { preHandler: [app.authenticate] }, async (req, reply) => {
    const params = parse(listQuerySchema, req.query, '列举参数');
    const scope = await resolveScope(req, null, reply);
    const scopePrefix = scope.prefix;
    // prefix 允许以 / 结尾表示目录；剥离作用域前缀后再拼接，避免双前缀
    let relativePrefix = '';
    if (params.prefix) {
      relativePrefix = toRelativeKey(scopePrefix, params.prefix);
      if (params.prefix.endsWith('/') && !relativePrefix.endsWith('/')) relativePrefix += '/';
    }
    const fullPrefix = `${scopePrefix}${relativePrefix}`;
    // 双保险：列举前缀必须在本次作用域内
    if (!fullPrefix.startsWith(scopePrefix)) {
      throw new HttpError(403, 'OBJECT_KEY_FORBIDDEN', '列举前缀越界：只能访问当前仓库的存储空间');
    }

    let result;
    try {
      result = await listObjects(platformConfig(), fullPrefix, params.maxKeys);
    } catch (err) {
      throw new HttpError(502, 'STORAGE_LIST_FAILED', `列举失败：${err.message}`);
    }

    /**
     * 方案 C：新前缀没数据时回退旧前缀。
     *
     * 为什么必须回退：线上老用户升级到 1.1.5 后，数据还在 `users/<username>/` 下，
     * 新前缀 `vaults/<id>/` 为空；若不回退，用户会看到「仓库全空」＝数据丢失投诉。
     * 只读回退，写入永远走新前缀（见 PUT 接口）。
     */
    if (result.objects.length === 0 && canFallbackLegacy(scope) && relativePrefix) {
      try {
        const legacy = await legacyList(req.user.username, relativePrefix, params.maxKeys);
        if (legacy.objects.length > 0) {
          // 打标记便于线上观测「还有多少请求依赖旧前缀」
          reply.header(LEGACY_HEADER, '1');
          const legacyPrefix = legacyUserPrefix(req.user.username);
          return ok(reply, {
            objects: legacy.objects.map((obj) => ({
              key: obj.key.slice(legacyPrefix.length),
              size: obj.size,
              etag: obj.etag,
              lastModified: obj.lastModified ? new Date(obj.lastModified).getTime() : 0,
            })),
            truncated: legacy.truncated,
            prefix: relativePrefix,
            /** 明确告知客户端本次结果来自旧前缀（迁移完成前会一直如此） */
            legacySource: true,
          });
        }
      } catch (err) {
        // 回退失败不影响主流程：返回空列表即可，下次请求会重试
        req.log?.warn?.({ err, vaultId: scope.vaultId }, '旧前缀回退列举失败');
      }
    }

    return ok(reply, {
      // 返回给客户端的是**相对 key**，前端不需要知道自己的前缀
      objects: result.objects
        .filter((obj) => obj.key.startsWith(scopePrefix))
        .map((obj) => ({
          key: obj.key.slice(scopePrefix.length),
          size: obj.size,
          etag: obj.etag,
          lastModified: obj.lastModified ? new Date(obj.lastModified).getTime() : 0,
        })),
      truncated: result.truncated,
      prefix: relativePrefix,
    });
  });

  /* ------------------------------ 下载 ------------------------------ */

  /**
   * 下载对象内容。
   *
   * 注意 `exposeHeadRoute: false`（**单数**，route 级选项；全局配置才叫 `exposeHeadRoutes`）：
   * Fastify 5 的 `app.get()` 默认会**顺带注册一个 HEAD 路由**，
   * 而本文件下面又显式声明了 `app.head()`（需要返回 content-length / etag 供同步判定存在性），
   * 两者叠加会抛 `FST_ERR_DUPLICATED_ROUTE` 导致服务启动失败。这里关掉自动 HEAD。
   */
  app.get(
    '/api/storage/object',
    { preHandler: [app.authenticate], exposeHeadRoute: false },
    async (req, reply) => {
      const params = parse(keyQuerySchema, req.query, '对象参数');
      const scope = await resolveScope(req, null, reply);
      const { key, relative } = resolveScopedKey(scope.prefix, params.key);

      let obj;
      try {
        obj = await getPlatformObject(key);
      } catch (err) {
        const notFound = /\b404\b|NoSuchKey/.test(String(err.message));
        /**
         * 方案 C：新前缀找不到时回退读旧前缀（只读）。
         * 注意 relative 已经过 `resolveScopedKey` 归一与越界校验，
         * 回退时传给 `legacyGetObject` 的正是这个相对 key，
         * 因此**不会因为回退而绕过任何越界检查**（内部还会再断言一次前缀）。
         */
        if (notFound && canFallbackLegacy(scope)) {
          try {
            const legacyObj = await legacyGetObject(req.user.username, relative);
            reply.header(LEGACY_HEADER, '1');
            return reply
              .code(200)
              .header('content-type', legacyObj.contentType || 'application/octet-stream')
              .header('content-length', String(legacyObj.size))
              .header('etag', legacyObj.etag || '')
              .header('x-storage-legacy', '1')
              .header('cache-control', 'no-store')
              .send(legacyObj.buffer);
          } catch {
            // 旧前缀也没有 → 走下面的 404，保持原语义
          }
        }
        if (notFound) {
          throw new HttpError(404, 'OBJECT_NOT_FOUND', '对象不存在');
        }
        throw new HttpError(502, 'STORAGE_GET_FAILED', `下载失败：${err.message}`);
      }

      return reply
        .code(200)
        .header('content-type', obj.contentType || 'application/octet-stream')
        .header('content-length', String(obj.size))
        .header('etag', obj.etag || '')
        // content-disposition 属于 CORS 必须暴露的头，已在 server.js 的 exposedHeaders 里声明
        .header('cache-control', 'no-store')
        .send(obj.buffer);
    },
  );

  /* ------------------------------ 元信息 ------------------------------ */

  /**
   * 对象是否存在（同步链路高频调用）。
   *
   * HEAD 响应不能带 body，因此这里只用头部表达结果：
   *  - 200 + content-length/etag → 存在；
   *  - 404（空 body）→ 不存在。
   */
  app.head('/api/storage/object', { preHandler: [app.authenticate] }, async (req, reply) => {
    const params = parse(keyQuerySchema, req.query, '对象参数');
    const scope = await resolveScope(req, null, reply);
    const { key, relative } = resolveScopedKey(scope.prefix, params.key);
    let meta = null;
    try {
      meta = await headObject(platformConfig(), key);
    } catch {
      meta = null;
    }
    // 方案 C：新前缀不存在时回退查旧前缀（只读，用于迁移完成前判定「对象是否存在」）
    if (!meta && canFallbackLegacy(scope)) {
      try {
        const legacyObj = await legacyGetObject(req.user.username, relative);
        reply.header(LEGACY_HEADER, '1');
        return reply
          .code(200)
          .header('content-length', String(legacyObj.size))
          .header('etag', legacyObj.etag || '')
          .header('x-storage-legacy', '1')
          .send();
      } catch {
        // 旧前缀也没有 → 落到下面的 404
      }
    }
    if (!meta) return reply.code(404).send();
    return reply
      .code(200)
      .header('content-length', String(meta.size))
      .header('etag', meta.etag || '')
      .header('last-modified', meta.lastModified || '')
      .send();
  });

  /* ------------------------------ 上传 ------------------------------ */

  app.put(
    '/api/storage/object',
    // bodyLimit 放宽到单对象上限：全局 bodyLimit 只有 12MB，不足以承载较大的 .md 或备份文件
    { preHandler: [app.authenticate, storageRateLimit], bodyLimit: MAX_OBJECT_BYTES },
    async (req, reply) => {
      const body = await readRawBody(req);
      // key 优先取 query，其次取请求头 / multipart 字段，保证三种投递方式都能用
      const queryKey = req.query && typeof req.query.key === 'string' ? req.query.key : '';
      const rawKey = queryKey || body.key;
      // vaultId 也可能从 body 传（multipart 场景），因此把 body 一并交给作用域解析
      const scope = await resolveScope(req, body, reply);
      const { key, relative } = resolveScopedKey(scope.prefix, rawKey);

      if (!body.buffer || body.buffer.length === 0) {
        throw new HttpError(400, 'EMPTY_BODY', '上传内容为空');
      }
      if (body.buffer.length > MAX_OBJECT_BYTES) {
        throw new HttpError(
          413,
          'OBJECT_TOO_LARGE',
          `单个对象超出大小限制（最大 ${Math.round(MAX_OBJECT_BYTES / 1024 / 1024)}MB）`,
        );
      }

      // 配额校验：覆盖写入时先扣掉旧对象体积，避免重复同步把自己卡死
      const used = await usedBytes(req.user.id);
      const quota = Number(req.user.quotaBytes ?? 0);
      if (quota > 0) {
        let existing = 0;
        try {
          const old = await headObject(platformConfig(), key);
          existing = Number(old?.size ?? 0);
        } catch {
          existing = 0;
        }
        if (used - existing + body.buffer.length > quota) {
          throw new HttpError(403, 'QUOTA_EXCEEDED', '存储配额不足，请清理空间或联系管理员扩容');
        }
      }

      try {
        await putPlatformObject(key, body.buffer, body.contentType || 'application/octet-stream');
      } catch (err) {
        throw new HttpError(502, 'STORAGE_PUT_FAILED', `上传失败：${err.message}`);
      }

      return ok(reply, {
        key: relative,
        size: body.buffer.length,
        etag: '',
        url: platformPublicUrl(key),
      });
    },
  );

  /* ------------------------------ 删除 ------------------------------ */

  app.delete(
    '/api/storage/object',
    { preHandler: [app.authenticate, storageRateLimit] },
    async (req, reply) => {
      const params = parse(keyQuerySchema, req.query, '对象参数');
      const scope = await resolveScope(req, null, reply);
      const { key, relative } = resolveScopedKey(scope.prefix, params.key);
      try {
        await deletePlatformObject(key);
      } catch (err) {
        throw new HttpError(502, 'STORAGE_DELETE_FAILED', `删除失败：${err.message}`);
      }
      return ok(reply, { key: relative, deleted: true });
    },
  );

  /* ------------------------------ 预签名 ------------------------------ */

  app.post('/api/storage/presign', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = parse(presignSchema, req.body ?? {}, '预签名参数');
    const scope = await resolveScope(req, body, reply);
    const { key, relative } = resolveScopedKey(scope.prefix, body.key);
    let url;
    try {
      url =
        body.method === 'PUT'
          ? presignPlatformPut(key, body.expiresSeconds)
          : presignPlatformGet(key, body.expiresSeconds);
    } catch (err) {
      throw new HttpError(502, 'PRESIGN_FAILED', `生成签名地址失败：${err.message}`);
    }
    await audit(req, 'storage.presign', relative, { method: body.method });
    return ok(reply, {
      key: relative,
      url,
      method: body.method,
      expiresIn: body.expiresSeconds,
    });
  });
}

export default storageRoutes;
