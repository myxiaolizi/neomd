/**
 * 仓库（vault）作用域：前缀计算、vaultId 校验、归属与状态检查。
 *
 * 为什么需要这个模块：
 * 1.1.5 之前所有仓库共用 `mdadmin/neomd/users/<username>/` 一个前缀，
 * 于是同一账号在 PC 端建的多个仓库（每个目录各有独立 vaultId）与网页端仓库
 * 全部写进同一片空间，**互相覆盖**——这正是「admin 在 PC 端有 3 个仓库、
 * 网页端只看到 my 和 admin」的根因。
 *
 * 现在改为按 vaultId 隔离：
 *   mdadmin/neomd/users/<username>/vaults/<vaultId>/docs/<docId>/...
 *   mdadmin/neomd/users/<username>/vaults/<vaultId>/index/<deviceId>.json
 *   mdadmin/neomd/users/<username>/vaults/<vaultId>/versions/<docId>/...
 *
 * 与「设置分区同步」的区别（排查时容易混淆，特此说明）：
 *  - 设置是 global 强一致 + platform 差异化（见 stores/settings.ts）；
 *  - 仓库正文**不做平台差异化**，同一用户的同一 vaultId 在任何端看到的文档集合必须完全一致，
 *    一致性由 SyncEngine 经同一个 vault 前缀达成。
 */
import { execute, queryOne } from '../db/pool.js';
import { HttpError } from './http.js';
import { PLATFORM_PREFIX } from './oss.js';

/** 所有用户空间的根（不含用户名） */
export const USER_ROOT = `${PLATFORM_PREFIX}neomd/users/`;

/** vaultId 合法字形：4-64 位字母/数字/下划线/短横线 */
export const VAULT_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

/** 旧前缀（不带 vaultId）的标记响应头，便于上线后观测还有多少老客户端在打 */
export const LEGACY_HEADER = 'x-vault-legacy';

/**
 * 旧版用户前缀（向后兼容用）：`mdadmin/neomd/users/<username>/`。
 *
 * 线上已有用户在这个前缀下存了数据，直接切到 vault 前缀会让他们的数据「消失」，
 * 因此未携带 vaultId 的请求暂时仍走这里，并在响应头打 `x-vault-legacy: 1`。
 */
export function legacyUserPrefix(username) {
  return `${USER_ROOT}${String(username ?? '').trim()}/`;
}

/** 新前缀：`mdadmin/neomd/users/<username>/vaults/<vaultId>/` */
export function vaultPrefix(username, vaultId) {
  return `${USER_ROOT}${String(username ?? '').trim()}/vaults/${String(vaultId).trim()}/`;
}

/** 某用户全部仓库的父前缀（用于列举仓库、迁移扫描） */
export function userVaultsRoot(username) {
  return `${USER_ROOT}${String(username ?? '').trim()}/vaults/`;
}

/**
 * 校验 vaultId 字形，非法直接抛 400。
 *
 * 这里比 key 校验更严格（不允许 `/`、`.`、`..`），因为 vaultId 会成为路径中的一段，
 * 任何分隔符都可能让「仓库隔离」失效。
 */
export function assertVaultIdShape(raw, label = '仓库标识') {
  const value = String(raw ?? '').trim();
  if (!value) {
    throw new HttpError(400, 'VAULT_ID_REQUIRED', `缺少${label}（vaultId）`);
  }
  if (!VAULT_ID_RE.test(value)) {
    throw new HttpError(
      400,
      'VAULT_ID_INVALID',
      `${label}格式不正确：只允许 4-64 位字母、数字、下划线或短横线`,
    );
  }
  return value;
}

/**
 * 从请求里取出 vaultId。
 *
 * 取值优先级：请求头 `x-vault-id` → query `vaultId` → body `vaultId`。
 * 三者都没有时返回空串（调用方据此走旧前缀兼容路径）。
 */
export function readVaultId(req, body) {
  const headerRaw = req?.headers?.['x-vault-id'];
  const header = String(Array.isArray(headerRaw) ? headerRaw[0] : (headerRaw ?? '')).trim();
  if (header) return header;
  const queryRaw = req?.query?.vaultId;
  const query = String(Array.isArray(queryRaw) ? queryRaw[0] : (queryRaw ?? '')).trim();
  if (query) return query;
  const bodyRaw = body?.vaultId;
  return String(bodyRaw ?? '').trim();
}

/**
 * 读取仓库注册记录（只查该用户名下的，天然隔离）。
 * @returns {Promise<object|null>}
 */
export async function getVaultRow(userId, vaultId) {
  return queryOne('SELECT * FROM user_vaults WHERE user_id = ? AND vault_id = ? LIMIT 1', [
    userId,
    String(vaultId),
  ]);
}

/**
 * 纯函数：根据仓库注册行判断本次访问是否放行。
 *
 * 为什么单独抽出来（不直接写在断言里）：
 * 安全判定是这条链路最关键的逻辑，抽成纯函数后才能在没有数据库的环境下单测，
 * 也避免「改 SQL 时不小心把判断改坏」。
 *
 * @param {object|null} row `user_vaults` 行；null 表示「没查到」
 * @returns {{ ok: true, status: string } | never} 放行时返回状态；否则抛 403
 */
export function evaluateVaultAccess(row) {
  if (!row) {
    // 不区分「不存在」与「属于别人」，避免通过错误码探测他人 vaultId 是否存在
    throw new HttpError(
      403,
      'VAULT_NOT_REGISTERED',
      '该仓库未注册或不属于当前账号，请先在客户端打开一次仓库以完成注册',
    );
  }
  const status = row.status === 'disabled' ? 'disabled' : 'active';
  if (status === 'disabled') {
    throw new HttpError(403, 'VAULT_DISABLED', '该仓库已停用，请先在仓库管理中重新启用');
  }
  return { ok: true, status };
}

/**
 * 校验「该仓库属于当前用户且处于 active」。
 *
 * 1.1.9 增强：若 `user_vaults` 中尚无该 `(user_id, vault_id)` 记录
 * （例如客户端刚打开本地仓库立刻发起 `/api/storage/list` 或 `PUT`，
 * 尚未来得及先完成 `POST /api/vaults` 注册），自动幂等插入一条 `active` 记录，
 * 从服务端根除 `403 VAULT_NOT_REGISTERED` 死锁；若已存在且 `status === 'disabled'`，
 * 依然由 `evaluateVaultAccess` 抛 `403 VAULT_DISABLED`。
 *
 * @returns {Promise<object>} 仓库记录
 */
export async function assertVaultUsable(userId, vaultId, defaultName = '') {
  const id = assertVaultIdShape(vaultId);
  let row = await getVaultRow(userId, id);
  if (!row) {
    const name = String(defaultName || id).trim().slice(0, 120) || id;
    await execute(
      `INSERT INTO user_vaults (user_id, vault_id, name, doc_count, bytes, status, last_synced_at, updated_at)
       VALUES (?, ?, ?, 0, 0, 'active', NULL, NOW())
       ON DUPLICATE KEY UPDATE updated_at = NOW()`,
      [userId, id, name],
    );
    row = await getVaultRow(userId, id);
  }
  evaluateVaultAccess(row);
  return row;
}

/** 仓库对外投影（不含 user_id 等内部字段） */
export function vaultItem(row) {
  if (!row) return null;
  return {
    vaultId: row.vault_id,
    name: row.name ?? null,
    docCount: Number(row.doc_count ?? 0),
    bytes: Number(row.bytes ?? 0),
    status: row.status === 'disabled' ? 'disabled' : 'active',
    lastSyncedAt: row.last_synced_at ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

export default {
  USER_ROOT,
  VAULT_ID_RE,
  LEGACY_HEADER,
  legacyUserPrefix,
  vaultPrefix,
  userVaultsRoot,
  assertVaultIdShape,
  readVaultId,
  getVaultRow,
  evaluateVaultAccess,
  assertVaultUsable,
  vaultItem,
};
