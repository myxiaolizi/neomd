/**
 * 用户设置：payload_json 存公开设置，payload_enc 用 AES-256-GCM 加密存储
 * 存储密钥与 AI 密钥等敏感字段，任何接口都不回传明文以外的形式。
 *
 * ── v2 分区同步（多端一致性）──────────────────────────────────────────────
 * 产品目标：使用云服务登录账号的用户，在**所有平台**看到同一份
 *   S3/OSS（storage）、AI、同步前缀（sync）、命名规则（naming）、快捷键（shortcuts）；
 * 而「外观（appearance）/ 布局（layout）/ 插件开关（enabledPlugins）」允许按平台差异化，
 * 因为 PC 与手机/网页的屏幕尺寸、交互方式差别很大。
 *
 * 存储结构（不新增表、不加列，全部塞进现有 JSON，规避迁移风险）：
 *
 *   payload_json = {
 *     global:   { storage, ai, sync, naming, shortcuts, autosave, shareStyle },
 *     platform: {
 *       desktop: { appearance, layout, enabledPlugins },
 *       web:     { appearance, layout, enabledPlugins },
 *       android: { appearance, layout, enabledPlugins }
 *     }
 *   }
 *
 *   payload_enc 结构相同，但只放敏感字段，例如：
 *     { global: { storage: { accessKeyId, accessKeySecret }, ai: { apiKey } } }
 *
 * 读取：GET /api/settings?platform=desktop → global 与 platform[desktop] 拍平成一份视图，平台分组优先。
 * 写入：PUT /api/settings 只更新本次提交涉及的分组，其它平台分组原样保留。
 *
 * 向后兼容：
 *   - 旧数据：payload 里没有 global / platform 字段时，整体视为 global；
 *   - 旧客户端（1.0.1，把整个 Settings 平铺上传）：同样并入 global，
 *     已存在的 platform 分组不会被破坏，旧客户端仍能读到可用设置（只是不带平台差异）。
 *
 * 历史版本跨端可见链路（与 task-5 的云端版本读取配合）：
 *   storage 配置属于 global → 登录后各端拿到同一份 S3 endpoint/bucket/AK
 *   → SyncEngine 的 rootPrefix 在登录态使用 `users/<username>/` 按用户隔离
 *   → 两端拼出相同的对象键前缀 → 都能 list `versions/<docId>/` 读取同一份历史版本。
 */
import { z } from 'zod';
import { queryOne, execute } from '../db/pool.js';
import { decryptJsonSafe, encryptJson } from '../lib/crypto.js';
import { badRequest, conflict, ok } from '../lib/http.js';
import { parse, deviceIdSchema } from '../lib/validate.js';

/**
 * 允许按平台差异化的分区。
 * 仅作文档与自验用：实际分组由客户端决定，服务端只做「只更新提交的分组」的合并，
 * 因此新增分区（例如以后的 `appearance` 子项）无需改服务端。
 */
export const PLATFORM_SCOPED_KEYS = Object.freeze(['appearance', 'layout', 'enabledPlugins']);

/** 已知平台标识：旧客户端不带 platform 参数读取时，按此确定顺序合并 */
export const KNOWN_PLATFORMS = Object.freeze(['desktop', 'web', 'android']);

const platformNameSchema = z
  .string({ error: '平台标识必须是字符串' })
  .trim()
  .min(1, { message: '平台标识不能为空' })
  .max(24, { message: '平台标识最多 24 个字符' })
  .regex(/^[a-z0-9_-]+$/i, { message: '平台标识只能包含字母、数字、下划线或短横线' });

const getQuerySchema = z.object({
  platform: platformNameSchema.optional(),
});

const sensitiveSchema = z
  .object({
    storage: z.any().optional(),
    ai: z.any().optional(),
  })
  .passthrough();

const putSchema = z.object({
  payload: z.any().optional(),
  sensitive: sensitiveSchema.optional(),
  version: z.coerce.number().int().min(0).max(2147483647).optional(),
  deviceId: deviceIdSchema,
  /** 提交方平台标识，用于日志与响应回显；分组本身的归属由 payload 结构决定 */
  platform: platformNameSchema.optional().nullable(),
});

/** 是否为普通对象（数组和 null 都不算） */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 解析 MEDIUMTEXT 中的 JSON */
function parseJson(text, fallback = null) {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(String(text));
  } catch {
    return fallback;
  }
}

/** 是否 v2 分组结构：带 global 或 platform 字段即视为新结构 */
export function isGroupedSettings(value) {
  return (
    isPlainObject(value) &&
    (Object.prototype.hasOwnProperty.call(value, 'global') ||
      Object.prototype.hasOwnProperty.call(value, 'platform'))
  );
}

/**
 * 归一到 `{ global, platform }`。
 * 旧结构（无 global/platform 字段）整体视为 global —— 这是向后兼容的关键。
 */
export function normalizeGroupedSettings(raw) {
  if (!isPlainObject(raw)) return { global: {}, platform: {} };
  if (!isGroupedSettings(raw)) return { global: { ...raw }, platform: {} };
  const global = isPlainObject(raw.global) ? { ...raw.global } : {};
  const platform = {};
  if (isPlainObject(raw.platform)) {
    for (const [name, group] of Object.entries(raw.platform)) {
      if (isPlainObject(group)) platform[name] = { ...group };
    }
  }
  return { global, platform };
}

/**
 * 合并单个分区（global 或某个平台分组）。
 * 对象做一层浅合并，支持「只提交 storage.bucket」这类局部更新；数组/标量整体替换。
 */
export function mergeSettingGroup(base, patch) {
  const out = isPlainObject(base) ? { ...base } : {};
  if (!isPlainObject(patch)) return out;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    if (isPlainObject(current) && isPlainObject(value)) out[key] = { ...current, ...value };
    else out[key] = value;
  }
  return out;
}

/**
 * 把一次提交合并进已有设置：**只更新提交方给出的分组**。
 * - 提交为 v2 结构：global 合并进 global，platform 里出现的平台各自合并，未出现的平台保持不变；
 * - 提交为旧版平铺结构：整体并入 global（不破坏已有平台分组）。
 *
 * @param {unknown} current 现有存储（v2 或旧版结构均可）
 * @param {unknown} incoming 本次提交
 * @returns {{global: Record<string, unknown>, platform: Record<string, Record<string, unknown>>}}
 */
export function mergeIncomingSettings(current, incoming) {
  const base = normalizeGroupedSettings(current);
  const patch = normalizeGroupedSettings(incoming);
  const next = {
    global: mergeSettingGroup(base.global, patch.global),
    platform: { ...base.platform },
  };
  for (const [name, group] of Object.entries(patch.platform)) {
    next.platform[name] = mergeSettingGroup(base.platform[name], group);
  }
  return next;
}

/**
 * 把 `{global, platform}` 拍平成一份设置视图（平台分组优先覆盖 global）。
 *
 * @param {unknown} grouped
 * @param {string|undefined|null} platform 指定平台时只合并该平台；
 *        未指定（旧客户端）时按 desktop → web → android → 其它（字典序）合并，保证仍能读到设置。
 */
export function flattenSettings(grouped, platform) {
  const base = normalizeGroupedSettings(grouped);
  const view = { ...base.global };
  const extra = Object.keys(base.platform)
    .filter((name) => !KNOWN_PLATFORMS.includes(name))
    .sort();
  const names = platform ? [platform] : [...KNOWN_PLATFORMS, ...extra];
  for (const name of names) {
    const group = base.platform[name];
    if (group) Object.assign(view, group);
  }
  return view;
}

/**
 * 响应给客户端前清掉 payload 里可能残留的明文密钥。
 * 正常写入时 key 走 sensitive，但历史行/旧客户端可能把字段平铺进来。
 */
export function stripPlaintextSecrets(view) {
  if (!isPlainObject(view)) return view;
  const out = { ...view };
  if (isPlainObject(out.storage)) out.storage = { ...out.storage, accessKeySecret: '' };
  if (isPlainObject(out.ai)) out.ai = { ...out.ai, apiKey: '' };
  return out;
}

/** 读取用户设置行 */
async function loadRow(userId) {
  return queryOne(
    'SELECT user_id, payload_json, payload_enc, version, updated_at, device_id FROM user_settings WHERE user_id = ? LIMIT 1',
    [userId],
  );
}

/** 空对象归一为 null，避免客户端把 `{}` 当成「云端有配置」 */
function emptyToNull(value) {
  return isPlainObject(value) && Object.keys(value).length === 0 ? null : value;
}

export async function settingsRoutes(app) {
  // 读取设置（?platform=desktop 时返回 global 与该平台合并后的视图）
  app.get('/api/settings', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { platform } = parse(getQuerySchema, req.query ?? {}, '平台参数');
    const row = await loadRow(req.user.id);
    if (!row) {
      return ok(reply, {
        payload: null,
        sensitive: null,
        version: 0,
        updatedAt: null,
        deviceId: null,
        platform: platform ?? null,
      });
    }

    const payloadView = emptyToNull(
      stripPlaintextSecrets(flattenSettings(parseJson(row.payload_json, null), platform)),
    );
    const decrypted = decryptJsonSafe(row.payload_enc);
    const sensitiveView = emptyToNull(flattenSettings(decrypted, platform));

    return ok(reply, {
      payload: payloadView,
      sensitive: sensitiveView,
      version: Number(row.version ?? 0),
      updatedAt: row.updated_at ?? null,
      deviceId: row.device_id ?? null,
      platform: platform ?? null,
    });
  });

  // 写入设置（版本冲突返回 409；只更新本次提交涉及的分组）
  app.put('/api/settings', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = parse(putSchema, req.body, '设置内容');
    if (body.payload === undefined && body.sensitive === undefined) {
      throw badRequest('payload 与 sensitive 至少需要提交一项', 'EMPTY_SETTINGS');
    }

    const current = await loadRow(req.user.id);
    const currentVersion = Number(current?.version ?? 0);
    const incomingVersion = body.version === undefined ? currentVersion : Number(body.version);
    if (current && incomingVersion < currentVersion) {
      throw conflict(
        `设置已在其它设备更新（云端版本 ${currentVersion}，提交版本 ${incomingVersion}），请先拉取最新设置`,
        'SETTINGS_VERSION_CONFLICT',
      );
    }

    // 先归一现状为 { global, platform }，再按提交内容逐分组合并，未提交的分组保持原样
    const currentPayload = normalizeGroupedSettings(parseJson(current?.payload_json, null));
    const currentSensitive = normalizeGroupedSettings(decryptJsonSafe(current?.payload_enc));

    const nextPayload =
      body.payload === undefined
        ? currentPayload
        : mergeIncomingSettings(currentPayload, body.payload);
    const nextSensitive =
      body.sensitive === undefined
        ? currentSensitive
        : mergeIncomingSettings(currentSensitive, body.sensitive);

    // 空分组不必落库，避免把 `{ global: {}, platform: {} }` 写成「有设置」
    const payloadJson = JSON.stringify({
      global: nextPayload.global,
      platform: nextPayload.platform,
    });
    const sensitiveEnc = encryptJson({
      global: nextSensitive.global,
      platform: nextSensitive.platform,
    });

    const nextVersion = Math.max(currentVersion, incomingVersion) + 1;
    const deviceId = body.deviceId ? String(body.deviceId).slice(0, 64) : current?.device_id ?? null;

    await execute(
      `INSERT INTO user_settings (user_id, payload_json, payload_enc, version, updated_at, device_id)
       VALUES (?, ?, ?, ?, NOW(), ?)
       ON DUPLICATE KEY UPDATE payload_json = VALUES(payload_json), payload_enc = VALUES(payload_enc),
         version = VALUES(version), updated_at = NOW(), device_id = VALUES(device_id)`,
      [req.user.id, payloadJson, sensitiveEnc, nextVersion, deviceId],
    );

    const saved = await loadRow(req.user.id);
    return ok(reply, {
      version: Number(saved?.version ?? nextVersion),
      updatedAt: saved?.updated_at ?? null,
      deviceId: saved?.device_id ?? deviceId,
      platform: body.platform ?? null,
    });
  });

  // 仅取版本号，用于轻量轮询（客户端发现版本变化才拉全量设置）
  app.get('/api/settings/version', { preHandler: [app.authenticate] }, async (req, reply) => {
    const row = await loadRow(req.user.id);
    return ok(reply, {
      version: Number(row?.version ?? 0),
      updatedAt: row?.updated_at ?? null,
      deviceId: row?.device_id ?? null,
    });
  });
}

export default settingsRoutes;
