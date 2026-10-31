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
 * 每用户 active 仓库数量上限（1.4.0 需求10 防复发）。
 *
 * ## 为什么需要上限
 *
 * `assertVaultUsable()` 会对未登记的 `(user_id, vault_id)` 自动 INSERT 一条记录。
 * 这条逻辑本身是必要的（否则客户端首次带新 vaultId 访问存储会 403 死锁），
 * 但它**没有任何约束**：客户端每落一个随机 vaultId 就多一行。
 * 配合客户端 `openVault()` 在「云端没有仓库」时落 `uid('vault')` 随机 id 的分支，
 * 每次新 profile / 每次测试脚本运行都会造一条 0 文档空壳。
 * 生产库实测：admin 名下 10 条，其中 6 条是 `vaultmv…` + `name='Neo MD'` + 0 文档的空壳。
 *
 * 20 是很宽松的上限（正常用户 2-5 个仓库），目的是**兜住无界增长**而不是限制正常使用。
 * 达到上限后不再自动登记，返回可读错误告诉用户去仓库管理里创建/清理。
 */
export const MAX_ACTIVE_VAULTS_PER_USER = 20;

/**
 * 校验「该仓库属于当前用户且处于 active」。
 *
 * 1.1.9 增强：若 `user_vaults` 中尚无该 `(user_id, vault_id)` 记录
 * （例如客户端刚打开本地仓库立刻发起 `/api/storage/list` 或 `PUT`，
 * 尚未来得及先完成 `POST /api/vaults` 注册），自动幂等插入一条 `active` 记录，
 * 从服务端根除 `403 VAULT_NOT_REGISTERED` 死锁；若已存在且 `status === 'disabled'`，
 * 依然由 `evaluateVaultAccess` 抛 `403 VAULT_DISABLED`。
 *
 * ## 1.4.0 需求10：自动登记必须收敛（这是仓库泛滥的根因所在）
 *
 * 旧实现是无条件 INSERT，三处缺陷（逐条对应实测到的 6 条空壳）：
 *  1. **无 name 去重**：同一台设备每次拿到新随机 vaultId 就新增一行，
 *     即便生成的显示名完全相同（实测 6 条空壳全部叫 `Neo MD`）；
 *  2. **无痕迹**：插入的行与用户主动创建的完全相同，事后无法区分、不敢清理；
 *  3. **无上限**：可以无限增长。
 *
 * 现在的收敛策略（三层，任何一层命中都不新增行）：
 *  a) **同 name 复用**：仓库名不是随机串（即调用方给了有意义的 `defaultName`）时，
 *     若该用户已有同名 active 仓库，**直接返回那条**，不插入新行。
 *     这挡住了「每次新 profile 都造一条 Neo MD」这个最主要来源。
 *  b) **标记来源**：真正需要新建时写 `auto_registered=1` + `auto_registered_at=NOW()`，
 *     使清理脚本能准确识别（`auto_registered=1 且 doc_count=0 且云端前缀无对象`）。
 *  c) **上限兜底**：active 仓库已达 {@link MAX_ACTIVE_VAULTS_PER_USER} 时拒绝，
 *     返回 `VAULT_LIMIT_REACHED`（409），提示用户去仓库管理里清理。
 *
 * 注意 (a) 的复用是**保守**的：只在 `defaultName` 非空且不等于 vaultId 本身时生效。
 * 若调用方传的是 `defaultName=''`（存储接口多数如此），退回 `id` 作为名字，
 * 此时不做同名复用 —— 否则所有随机 id 的仓库会被塞进同一条记录，反而丢数据。
 *
 * @returns {Promise<object>} 仓库记录
 */
export async function assertVaultUsable(userId, vaultId, defaultName = '') {
  const id = assertVaultIdShape(vaultId);
  let row = await getVaultRow(userId, id);
  if (!row) {
    const rawName = String(defaultName ?? '').trim().slice(0, 120);
    const name = rawName || id;
    /*
     * (a) 同 name 复用：仅在「调用方给了有意义的名字」时启用。
     *
     * 为什么必须排除 `rawName === ''`：storage 侧调用大多不传名字，
     * 此时 name 会退化成随机 vaultId；若允许同名复用，所有随机仓库会撞进
     * 第一个随机 id 的记录里 → 不同仓库的数据互相覆盖（比泛滥严重得多）。
     */
    const canReuseByName = Boolean(rawName) && rawName !== id;
    if (canReuseByName) {
      const existing = await queryOne(
        `SELECT * FROM user_vaults
         WHERE user_id = ? AND name = ? AND status = 'active'
         ORDER BY updated_at DESC LIMIT 1`,
        [userId, name],
      );
      if (existing) {
        // 复用：只推进 updated_at，不新增行。这是「空壳泛滥」的主要堵点。
        await execute('UPDATE user_vaults SET updated_at = NOW() WHERE user_id = ? AND vault_id = ?', [
          userId,
          existing.vault_id,
        ]);
        return existing;
      }
    }

    /*
     * (c) 上限兜底：数一次 active 数量。
     * 只在「确实需要新建」时才查，复用路径不付这个查询成本。
     */
    const countRow = await queryOne(
      `SELECT COUNT(*) AS total FROM user_vaults WHERE user_id = ? AND status = 'active'`,
      [userId],
    );
    const activeCount = Number(countRow?.total ?? 0);
    if (activeCount >= MAX_ACTIVE_VAULTS_PER_USER) {
      throw new HttpError(
        409,
        'VAULT_LIMIT_REACHED',
        `仓库数量已达上限（${MAX_ACTIVE_VAULTS_PER_USER} 个），请先在「仓库管理」中清理不用的仓库`,
      );
    }

    // (b) 自动登记并打标记，便于事后识别与清理
    await execute(
      `INSERT INTO user_vaults
         (user_id, vault_id, name, doc_count, bytes, status, last_synced_at, auto_registered, auto_registered_at, updated_at)
       VALUES (?, ?, ?, 0, 0, 'active', NULL, 1, NOW(), NOW())
       ON DUPLICATE KEY UPDATE updated_at = NOW()`,
      [userId, id, name],
    );
    row = await getVaultRow(userId, id);
  }
  evaluateVaultAccess(row);
  return row;
}

/**
 * 判断一条 `user_vaults` 记录是否是「可安全清理的自动登记空壳」（1.4.0 需求10）。
 *
 * 判据（**全部满足**才返回 true，保守优先 —— 删错不可逆）：
 *  1. `auto_registered = 1`（由本模块自动登记时打的标记）；
 *  2. `doc_count = 0` 且 `bytes = 0`；
 *  3. 名为自动生成形态（等于 vaultId，或为 'Neo MD' 这类默认名）；
 *  4. 从未同步过（`last_synced_at IS NULL`）。
 *
 * 注意：**这只是 DB 侧判据**。调用方还必须额外验证「云端前缀下确实没有任何对象」
 * （见 `tools/re14-clean-vaults.mjs` 的实列验证），因为 DB 统计列可能滞后。
 */
export function isAutoRegisteredShell(row) {
  if (!row) return false;
  if (Number(row.auto_registered ?? 0) !== 1) return false;
  if (Number(row.doc_count ?? 0) !== 0) return false;
  if (Number(row.bytes ?? 0) !== 0) return false;
  if (row.last_synced_at) return false;
  const name = String(row.name ?? '').trim();
  const id = String(row.vault_id ?? '').trim();
  return name === id || name === 'Neo MD' || name === '';
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
  MAX_ACTIVE_VAULTS_PER_USER,
  legacyUserPrefix,
  vaultPrefix,
  userVaultsRoot,
  assertVaultIdShape,
  readVaultId,
  getVaultRow,
  evaluateVaultAccess,
  assertVaultUsable,
  isAutoRegisteredShell,
  vaultItem,
};
