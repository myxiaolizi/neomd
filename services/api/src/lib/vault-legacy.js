/**
 * 旧前缀兼容：双读回退（方案 C）+ 惰性迁移（方案 A）。
 *
 * ## 为什么需要
 * 1.1.5 之前所有仓库共用 `mdadmin/neomd/users/<username>/` 一个前缀。
 * 线上真实用户（如 admin）的数据都躺在那里。若直接切到 `vaults/<id>/`，
 * 用户升级后打开仓库会看到**一片空白**，等同于数据丢失投诉。
 * 因此需要两层保障：
 *
 *  - **C 双读回退**：新前缀读不到时，回退读旧前缀（只读，写入永远走新前缀）。
 *    让老数据「立刻可见」，用户无感。
 *  - **A 惰性迁移**：后台把旧前缀内容**复制**到新前缀，完成后退场 C。
 *
 * ## 两条硬约束（改动本文件前必读）
 * 1. **C 仅供老数据兼容，不可长期化**：
 *    待线上 `x-vault-legacy` 统计归零 + 迁移全部完成后**必须移除本模块的回退分支**。
 *    紧急情况下可用环境变量 `STORAGE_LEGACY_READ=0` 一键关闭回退，无需改代码。
 * 2. **绝不删除旧前缀数据**：迁移是「复制」不是「移动」。
 *    旧数据保留到人工确认无问题后由运维清理，代码里不提供删除旧前缀的路径。
 */
import { getPlatformObject, platformConfig, putPlatformObject } from './oss.js';
// listObjects 只在 s3.js 里导出（oss.js 未再导出），这里直接用底层实现
import { listObjects } from './s3.js';
import { legacyUserPrefix, userVaultsRoot, vaultPrefix } from './vault-scope.js';

/**
 * 双读回退开关。
 *
 * 默认**开启**（线上老数据需要立即可见）；设为 `0` / `false` / `off` 可完全关闭，
 * 关闭后行为与「纯新前缀」一致，用于迁移完成后收尾。
 */
export function isLegacyReadEnabled() {
  const raw = String(process.env.STORAGE_LEGACY_READ ?? '1').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/** 迁移完成标记对象名（放在 vault 前缀下，天然按仓库隔离） */
export const MIGRATION_MARKER = '.migrated';

/** 旧前缀下新体系占用的子目录名：回退列举时必须排除，否则会把所有仓库的数据混在一起 */
const NEW_LAYOUT_DIR = 'vaults/';

/** 单次迁移最多复制的对象数（超过则放弃迁移，留给人工处理，避免拖垮服务） */
const MAX_MIGRATE_OBJECTS = 5000;

/** 列举分页大小 */
const PAGE_SIZE = 1000;

/**
 * 正在迁移中的 vault（内存去重）。
 *
 * 为什么需要：客户端一次同步会并发打出十几个请求，
 * 若每个请求都触发迁移检查，会同时跑十几份相同复制。
 * 进程内 Set 足够——迁移本身是幂等的（写标记），跨进程重复只会白做功不会坏数据。
 */
const migrating = new Set();

/** 本进程已确认「无需迁移」的 vault（避免每次请求都去 OSS 探测） */
const noMigrationNeeded = new Set();

/**
 * 存储操作接口（可注入）。
 *
 * 为什么要可注入：迁移逻辑是「决策 + 复制」，其中决策部分（何时迁、迁哪些、失败不写标记）
 * 是最容易出错也最需要测试的，但它依赖 OSS。ESM 导出只读、无法 monkey-patch，
 * 因此把 OSS 操作收敛成这个接口，生产环境用默认实现，测试传内存桩。
 */
const defaultStore = {
  list: (prefix, maxKeys) => listObjects(platformConfig(), prefix, maxKeys),
  get: (key) => getPlatformObject(key),
  put: (key, body, contentType) => putPlatformObject(key, body, contentType),
};

/** 当前生效的存储实现（测试可临时替换） */
let store = defaultStore;

/** 仅供测试：替换存储实现 */
export function __setStore(next) {
  store = next ?? defaultStore;
}

/** 仅供测试：恢复默认存储实现 */
export function __restoreStore() {
  store = defaultStore;
}

function vaultKeyOf(username, vaultId) {
  return `${username}/${vaultId}`;
}

/** 判断某前缀下是否有对象（只探 1 个，代价最小） */
async function hasAnyObject(prefix) {
  const result = await store.list(prefix, 1);
  return result.objects.length > 0;
}

/**
 * 迁移标记是否已存在。
 * 标记对象本身也会出现在列举里，所以只要前缀非空且第一个就是标记，
 * 或明确列举 `.migrated` 命中，都视为已迁移。
 */
async function hasMigrationMarker(username, vaultId) {
  const prefix = vaultPrefix(username, vaultId);
  const result = await store.list(`${prefix}${MIGRATION_MARKER}`, 1);
  return result.objects.some((obj) => obj.key === `${prefix}${MIGRATION_MARKER}`);
}

/**
 * 执行一次惰性迁移（内部函数，调用方负责异步）。
 *
 * 触发条件（全部满足才迁移）：
 *  1. 双读开关开启；
 *  2. 新前缀 `vaults/<id>/` 下**没有任何对象**（否则说明已有数据，不该覆盖）；
 *  3. 尚未写过 `.migrated` 标记；
 *  4. 旧前缀下有 `docs/` 或 `index/` 对象（说明确实有老数据要搬）。
 *
 * 成功后写 `vaults/<id>/.migrated`；**任何失败都不写标记**，下次请求会自然重试。
 *
 * @returns {Promise<{ migrated: boolean, copied?: number, reason?: string }>}
 */
export async function migrateLegacyVault(username, vaultId) {
  const oldPrefix = legacyUserPrefix(username);
  const newPrefix = vaultPrefix(username, vaultId);

  // 防御：目标前缀必须落在本用户 vaults 根下
  if (!newPrefix.startsWith(userVaultsRoot(username))) {
    return { migrated: false, reason: 'prefix-out-of-scope' };
  }

  try {
    // 已有标记 → 确定迁移完成，直接跳过
    if (await hasMigrationMarker(username, vaultId)) {
      return { migrated: false, reason: 'already-marked' };
    }

    /**
     * 关于「目标前缀非空」——这里是**失败可重试**与**不覆盖用户新数据**的平衡点。
     *
     * 不能简单地「非空就放弃」：上一次迁移可能**部分成功**（复制几个对象后失败），
     * 此时新前缀已非空但没有标记。若直接放弃，该 vault 永远无法完成迁移，
     * 用户会持续缺一部分文档。
     *
     * 也不能无脑重跑覆盖：用户可能已经在新建的 vault 里正常写入了新内容，
     * 若用旧前缀的旧内容覆盖回去，就是**真实的数据丢失**。
     *
     * 因此判定交给下面的「逐对象内容比对」：
     *  - 目标不存在 → 复制；
     *  - 目标存在且内容**相同** → 上次残留，跳过即可（幂等）；
     *  - 目标存在且内容**不同** → 用户已在新体系写过 → 立即中止，不写标记，交人工确认。
     */

    // 旧前缀下是否真有同步数据（只看 docs/ 与 index/，避免把头像/备份也搬进来）
    const [hasDocs, hasIndex] = await Promise.all([
      hasAnyObject(`${oldPrefix}docs/`),
      hasAnyObject(`${oldPrefix}index/`),
    ]);
    if (!hasDocs && !hasIndex) {
      return { migrated: false, reason: 'nothing-to-migrate' };
    }

    // 列举旧前缀的全部同步对象（排除 vaults/ 子目录，那是新体系的数据）
    const sources = [];
    for (let page = 0; page < 10; page++) {
      const listed = await store.list(oldPrefix, PAGE_SIZE);
      for (const obj of listed.objects) {
        const relative = obj.key.slice(oldPrefix.length);
        if (!relative || relative.startsWith(NEW_LAYOUT_DIR)) continue;
        // 只搬同步目录，不搬头像/备份等其它资产
        if (!/^(docs|index|versions)\//.test(relative)) continue;
        sources.push({ key: obj.key, relative, size: obj.size });
      }
      if (!listed.truncated || sources.length > MAX_MIGRATE_OBJECTS) break;
    }

    if (sources.length === 0) {
      return { migrated: false, reason: 'nothing-to-migrate' };
    }
    if (sources.length > MAX_MIGRATE_OBJECTS) {
      // 超限不迁移：交给人工处理，避免单次请求拖垮服务
      return { migrated: false, reason: 'too-many-objects' };
    }

    // 逐个复制（读 + 写），内存峰值 = 单个对象。
    //
    // 幂等 + 防覆盖：
    //  - 目标不存在 → 复制；
    //  - 目标存在且内容相同 → 上次部分迁移的残留，跳过（不重复写，省流量）；
    //  - 目标存在且内容不同 → 用户已在新前缀写过新内容 → **立即中止**，不写标记，
    //    交由人工确认（绝不能静默用旧内容覆盖用户新写的文档）。
    let copied = 0;
    let skipped = 0;
    for (const item of sources) {
      const targetKey = `${newPrefix}${item.relative}`;
      // 双重断言：目标必须是本 vault 前缀内的对象
      if (!targetKey.startsWith(newPrefix) || targetKey.includes('..')) continue;

      const source = await store.get(item.key);
      const targetExists = (await store.list(targetKey, 1)).objects.some((o) => o.key === targetKey);
      if (targetExists) {
        let same = false;
        try {
          const existing = await store.get(targetKey);
          same =
            Buffer.isBuffer(existing.buffer) &&
            Buffer.isBuffer(source.buffer) &&
            existing.buffer.equals(source.buffer);
        } catch {
          same = false;
        }
        if (!same) {
          // 内容不同 = 用户已在新区写过，停止迁移保护用户数据
          return { migrated: false, reason: 'target-conflict' };
        }
        skipped += 1;
        continue;
      }

      await store.put(targetKey, source.buffer, source.contentType || 'application/octet-stream');
      copied += 1;
    }

    // 全部成功才写标记（失败不写 → 下次重试）
    await store.put(
      `${newPrefix}${MIGRATION_MARKER}`,
      JSON.stringify({
        from: oldPrefix,
        copied,
        skipped,
        at: new Date().toISOString(),
        note: '旧前缀惰性迁移完成标记；旧数据未被删除，确认无误后可由运维手工清理',
      }),
      'application/json; charset=utf-8',
    );

    return { migrated: true, copied, skipped };
  } catch (err) {
    // 迁移失败不影响用户请求，下次自动重试
    return { migrated: false, reason: `error: ${err.message}` };
  }
}

/**
 * 调度一次惰性迁移（**立即返回，不阻塞请求**）。
 *
 * 调用点在 `storage.js` 的 `resolveScope`：每次带 vaultId 的请求都会调一次，
 * 但内部用内存 Set 去重，只有第一次真正触发后台复制。
 */
export function scheduleMigration(username, vaultId, logger) {
  if (!isLegacyReadEnabled()) return;
  const key = vaultKeyOf(username, vaultId);
  if (migrating.has(key) || noMigrationNeeded.has(key)) return;

  migrating.add(key);
  // setImmediate：把复制推到本轮事件循环之后，用户请求先返回
  setImmediate(() => {
    migrateLegacyVault(username, vaultId)
      .then((result) => {
        if (result.migrated) {
          logger?.info?.({ vaultId, copied: result.copied }, '旧前缀数据迁移完成');
        } else if (result.reason === 'nothing-to-migrate' || result.reason === 'already-marked' || result.reason === 'target-not-empty') {
          // 这几种是「确定不需要迁移」，记入内存避免反复探测 OSS
          noMigrationNeeded.add(key);
        } else {
          logger?.warn?.({ vaultId, reason: result.reason }, '旧前缀数据迁移未完成，将在下次请求重试');
        }
      })
      .catch((err) => {
        logger?.warn?.({ err, vaultId }, '旧前缀数据迁移异常，将在下次请求重试');
      })
      .finally(() => {
        migrating.delete(key);
      });
  });
}

/* ------------------------------------------------------------------ */
/* 方案 C：双读回退                                                     */
/* ------------------------------------------------------------------ */

/**
 * 回退列举：从旧前缀按同样规则列举，并**剔除新体系目录**。
 *
 * @param {string} username 用户名
 * @param {string} relativePrefix 已归一化的相对前缀（如 `docs/`、空串）
 * @param {number} maxKeys 上限
 * @returns {Promise<{objects: Array<{key: string, size: number, etag: string, lastModified: any}>, truncated: boolean}>}
 */
export async function legacyList(username, relativePrefix, maxKeys) {
  const oldPrefix = legacyUserPrefix(username);
  const fullPrefix = `${oldPrefix}${relativePrefix}`;
  // 双重断言：回退前缀必须仍在旧用户前缀内（不能借回退绕过越界校验）
  if (!fullPrefix.startsWith(oldPrefix)) {
    throw new Error('legacy prefix out of scope');
  }
  const result = await store.list(fullPrefix, maxKeys);
  return {
    // 关键：排除 `vaults/` 子目录，否则会把其它仓库的新数据混进回退结果
    objects: result.objects.filter((obj) => {
      const relative = obj.key.slice(oldPrefix.length);
      return relative && !relative.startsWith(NEW_LAYOUT_DIR);
    }),
    truncated: result.truncated,
  };
}

/**
 * 回退读取单对象：从旧前缀读。
 * @param {string} username
 * @param {string} relative 已归一化的相对 key（如 `docs/a/1-x.md`）
 */
export async function legacyGetObject(username, relative) {
  const oldPrefix = legacyUserPrefix(username);
  const key = `${oldPrefix}${relative}`;
  if (!key.startsWith(oldPrefix) || key.includes('..')) {
    throw new Error('legacy key out of scope');
  }
  return store.get(key);
}

/** 仅供测试：清空内部去重缓存 */
export function __resetMigrationState() {
  migrating.clear();
  noMigrationNeeded.clear();
}

export default {
  isLegacyReadEnabled,
  migrateLegacyVault,
  scheduleMigration,
  legacyList,
  legacyGetObject,
  MIGRATION_MARKER,
  __setStore,
  __restoreStore,
  __resetMigrationState,
};
