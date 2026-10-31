/**
 * 仓库注册表（1.1.5）。
 *
 * ## 为什么需要它
 *
 * 1.1.4 及以前，产品是**单仓库架构**：`settings.localVault.root` 只有一个值，
 * `VaultRef` 也只描述「当前打开的这一个仓库」，没有任何地方保存「用户有哪些仓库」。
 * 于是用户实际存在的多个仓库（PC 端「Neo MD / Neo MD-整理 / 郑磊」、
 * 网页端「my / admin」）互相不可见 —— 这正是「同一账号多端看到两套仓库」的直接原因。
 *
 * ## 本模块的职责
 *
 * - 维护**本机已知仓库清单**（`localStorage['neomd.vaults']`），持久化、可跨标签页共享；
 * - 提供增删改查（注册 / 改名 / 停用 / 移除）；
 * - 与云端仓库列表合并（云端有但本机没打开过的仓库，标记 `available: false`）；
 * - 为同步层提供**稳定的 vaultId**，使每个仓库的云端前缀互相隔离
 *   （`users/<username>/vaults/<vaultId>/`），从根本上避免多个仓库写同一前缀互相覆盖。
 *
 * ## 设计取舍
 *
 * - **不改 `Settings` 类型**：仓库清单是「本机事实」（哪台机器上有哪些目录），
 *   与 `settings` 的「用户偏好」语义不同，因此单独一个 storage key，
 *   也避免它被当作偏好同步到云端而制造混乱。
 * - **`location` 只在本机有意义**：桌面端是绝对路径、网页端是 `cloud:<username>`，
 *   所以云端只同步 `vaultId / name / status`，不同步 `location`。
 */
import type { VaultRef } from '@neomd/shared';

/** 仓库启用状态：停用后数据保留但不可打开/同步 */
export type VaultStatus = 'active' | 'disabled';

/** 仓库适配器类型（与 `VaultRef.adapter` 保持一致） */
export type VaultAdapterKind = 'desktop-fs' | 'android-fs' | 'browser-idb';

/** 注册表中的一条仓库记录 */
export interface VaultEntry {
  /** 仓库唯一 id，来自仓库目录内 `.neomd/vault.json`，跨端稳定 */
  vaultId: string;
  /** 显示名（默认取目录名，用户可改） */
  name: string;
  /** 本机位置：桌面端为绝对路径，网页端为 `cloud:<username>` */
  location: string;
  adapter: VaultAdapterKind;
  status: VaultStatus;
  lastOpenedAt: number;
  createdAt: number;
  /**
   * 本机是否可用（目录还在、能打开）。
   * 云端列表里有、但本机从未打开过的仓库为 `false`，
   * UI 应显示为「云端仓库（本机未下载）」并禁用切换。
   */
  available: boolean;
  /** 上次同步时间（毫秒），仅登录且同步过才有 */
  lastSyncedAt?: number;
  /** 文档数（用于列表展示，打开仓库后刷新） */
  docCount?: number;
  /** 占用字节数 */
  bytes?: number;
  /**
   * 云端已不存在（1.4.0 需求10 防复发）。
   *
   * ## 为什么必须有这个标记
   *
   * 场景（生产库实测复现）：某台设备的 localStorage 注册表里存着 6 个已删除的 vaultId，
   * 它们仍在周期同步里被反复访问 `/api/storage/*` → 服务端 `assertVaultUsable()`
   * 自动把 `(user_id, vault_id)` 重新 INSERT 回去 → 刚清理完的幽灵仓库**又弹回来**。
   * 实测：清理后 10→4，约 25 分钟后又被重建回 10 条。
   *
   * 打断这条链的关键就是：**云端已不存在的条目不得进入同步循环**。
   * 因此这里加 `orphan` 标记，由 {@link mergeRemote} 在每次拉取云端清单时对账写入：
   *  - 云端有 → `orphan` 清空（无论本机 available 与否）；
   *  - 云端没有且**有过云端痕迹**（`location` 是 `cloud:*` 或有 `lastSyncedAt`）
   *    → `orphan: true`，`available: false`，并记录 `orphanSince` 时间与连续未命中次数。
   *
   * ## 为什么不直接删
   *
   * `available: false` 有两种截然不同的原因，语义必须区分：
   *  - 「云端有、本机没下载过」→ 应该**可见可切换**（跨设备发现），现有逻辑正确；
   *  - 「云端已删除」→ 应该**不可见或标记为已删除**，且**不参与同步**。
   * 直接删除本地条目在第一种情况下会让用户永远看不到其它设备的仓库，
   * 因此采取「标记 + 跳过同步 + 连续多轮后才物理移除」的渐进策略。
   */
  orphan?: boolean;
  /** 首次被判定为 orphan 的时间（毫秒），用于渐进清理与 UI 展示 */
  orphanSince?: number;
  /**
   * 连续多少轮拉取云端清单都没见到这个 vaultId。
   *
   * 用于**渐进式物理移除**：单次「云端没返回」可能是网络抖动或服务端分页，
   * 连续 {@link ORPHAN_REMOVE_AFTER_MISSES} 次才真正从注册表删除。
   */
  orphanMissCount?: number;
}

/** 云端返回的仓库摘要（`GET /api/vaults`） */
export interface RemoteVaultDto {
  vaultId: string;
  name: string;
  docCount?: number;
  bytes?: number;
  status?: VaultStatus;
  lastSyncedAt?: string | number | null;
  createdAt?: string | number | null;
  updatedAt?: string | number | null;
}

/**
 * 存储 key。
 *
 * **沿用既有的 `neomd.vaultList.v1`**，而不是新开一个 key。
 *
 * 原因：1.1.4 及以前 `apps/web/src/stores/app.ts` 已经用这个 key 存了一份
 * 极简的仓库列表（`{ name, location, lastOpenedAt }`）。如果这里另起一个 key，
 * 就会出现「两套仓库清单各自为政」的状态分裂 —— 打开仓库更新了 A 清单，
 * 设置页读的是 B 清单，用户会看到列表不刷新。因此本注册表**接管**这个 key，
 * 并向下兼容旧的极简结构（缺 `vaultId` / `status` 时自动补默认值）。
 */
const STORAGE_KEY = 'neomd.vaultList.v1';
/** 当前仓库位置的 key，与既有代码保持一致（`app.ts` 与 `EditorPage.vue` 都在用） */
export const LAST_VAULT_KEY = 'neomd.lastVault';

/**
 * 判定为 orphan 后，连续多少轮「云端清单里没有它」才真正从注册表移除（1.4.0）。
 *
 * 为什么不是一次就删：单次漏返回可能是网络抖动、服务端分页、或云端接口临时失败。
 * 3 轮（配合默认 120s 的自动同步间隔 ≈ 6 分钟）既能较快清掉真正的幽灵条目，
 * 又不会因为一次抖动就丢掉用户真正存在的仓库。
 */
export const ORPHAN_REMOVE_AFTER_MISSES = 3;

/**
 * 判断一条注册表记录是否**曾经与云端建立过关联**（1.4.0）。
 *
 * 只有「有过云端痕迹」的条目才可能被判为 orphan：
 *  - `location` 以 `cloud:` 开头（云端发现/创建的仓库）；
 *  - 或有过 `lastSyncedAt`（同步过说明云端确实认识它）。
 *
 * **纯本地目录仓库（桌面端真实文件夹、从未同步）永不判 orphan** ——
 * 用户可能只是没登录云端，把他的本地仓库标成「已删除」是不可接受的。
 */
function hadCloudPresence(e: VaultEntry): boolean {
  if (typeof e.location === 'string' && e.location.startsWith('cloud:')) return true;
  if (e.lastSyncedAt && e.lastSyncedAt > 0) return true;
  return false;
}

/** 把各种时间表示统一成毫秒时间戳 */
function toMs(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return fallback;
}

/** 从位置字符串推断适配器类型（用于补全历史记录） */
function inferAdapter(location: string): VaultAdapterKind {
  if (location.startsWith('cloud:')) return 'browser-idb';
  return 'desktop-fs';
}

/** 从位置字符串推断显示名（末段目录名，去掉 `cloud:` 前缀） */
export function nameFromLocation(location: string): string {
  const clean = location.startsWith('cloud:') ? location.slice('cloud:'.length) : location;
  const parts = clean.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || clean || '未命名仓库';
}

/** 校验并归一化一条仓库记录（容错：历史数据可能缺字段） */
function normalizeEntry(raw: unknown): VaultEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<VaultEntry>;
  const vaultId = typeof r.vaultId === 'string' ? r.vaultId.trim() : '';
  const location = typeof r.location === 'string' ? r.location.trim() : '';
  if (!vaultId || !location) return null;
  return {
    vaultId,
    name: (typeof r.name === 'string' && r.name.trim()) || nameFromLocation(location),
    location,
    adapter: r.adapter ?? inferAdapter(location),
    status: r.status === 'disabled' ? 'disabled' : 'active',
    lastOpenedAt: toMs(r.lastOpenedAt),
    createdAt: toMs(r.createdAt, Date.now()),
    available: r.available !== false,
    lastSyncedAt: r.lastSyncedAt ? toMs(r.lastSyncedAt) : undefined,
    docCount: typeof r.docCount === 'number' ? r.docCount : undefined,
    bytes: typeof r.bytes === 'number' ? r.bytes : undefined,
    /*
     * orphan 三件套必须在这里显式透传（1.4.0）。
     *
     * 这是实测踩到的坑：加了 `orphan` 字段、也写进了 persist()，
     * 但 `normalizeEntry()` 是**白名单式**构造新对象（只挑已知字段），
     * 漏掉的字段会在「读盘 → 再存」时被静默丢弃 —— 表现为
     * 「明明标了 orphan，刷新后又变回普通条目，继续参与同步」。
     *
     * 因此新增 persistent 字段时**必须同时**改三处：
     * `VaultEntry` 接口、`normalizeEntry()`、以及 `persist()` 的序列化。
     * `persist()` 用的是 `JSON.stringify(this.entries)`，会自动带上全部字段，
     * 所以只有这里需要显式补。
     */
    orphan: r.orphan === true ? true : undefined,
    orphanSince: typeof r.orphanSince === 'number' && r.orphanSince > 0 ? r.orphanSince : undefined,
    orphanMissCount: typeof r.orphanMissCount === 'number' && r.orphanMissCount > 0 ? r.orphanMissCount : undefined,
  };
}

/**
 * 仓库注册表。
 *
 * 所有写操作都会立即持久化到 `localStorage`，保证刷新/重启后不丢。
 * 读取时做一次容错归一化，历史脏数据不会让整个列表崩掉。
 */
export class VaultRegistry {
  private entries: VaultEntry[] = [];
  private currentVaultId = '';
  private storage: Storage | null;

  constructor(storage?: Storage) {
    // 允许注入，便于单测；浏览器环境默认用 localStorage
    this.storage =
      storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    this.load();
  }

  /* ------------------------------ 持久化 ------------------------------ */

  private load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) {
        this.bootstrapFromLastVault();
        return;
      }
      const parsed: unknown = JSON.parse(raw);
      /**
       * 兼容两种形态：
       * - **旧格式（1.1.4 及以前）**：顶层就是数组 `[{ name, location, lastOpenedAt }]`，
       *   没有 vaultId、没有 status、没有当前仓库标记；
       * - **新格式（1.1.5 起）**：`{ entries: [...], currentVaultId }`。
       *
       * 旧格式的每一项会被补上占位 vaultId（`pending:<location>`），
       * 等仓库真正打开时由 `attachVaultId()` 换成 `.neomd/vault.json` 里的真实 id。
       */
      const rawEntries = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { entries?: unknown[] })?.entries)
          ? (parsed as { entries: unknown[] }).entries
          : [];
      this.entries = rawEntries
        .map((item) => {
          // 旧条目没有 vaultId，用 location 派生占位 id
          const loc = (item as { location?: string })?.location;
          const withId =
            item && typeof item === 'object' && !(item as { vaultId?: string }).vaultId && loc
              ? { ...(item as object), vaultId: `pending:${loc}` }
              : item;
          return normalizeEntry(withId);
        })
        .filter((e): e is VaultEntry => e !== null);
      this.currentVaultId = Array.isArray(parsed)
        ? ''
        : typeof (parsed as { currentVaultId?: string }).currentVaultId === 'string'
          ? (parsed as { currentVaultId: string }).currentVaultId
          : '';
      // 旧格式没有 currentVaultId → 用 lastVault 反查
      if (!this.currentVaultId) {
        const last = this.storage.getItem(LAST_VAULT_KEY);
        const hit = last ? this.entries.find((e) => e.location === last) : null;
        if (hit) this.currentVaultId = hit.vaultId;
      }
      // 老版本升级：列表为空但有 lastVault，用它补一条
      if (!this.entries.length) this.bootstrapFromLastVault();
      // 读盘后立刻修一次历史脏数据（见 repair() 的说明）
      if (this.repair()) this.persist();
    } catch {
      this.entries = [];
      this.bootstrapFromLastVault();
    }
  }

  /**
   * 修复历史脏数据（1.1.9）。
   *
   * 为什么必须有这一步：1.1.8 的 `mergeRemote()` 把「云端有、本机没有」的仓库
   * 以 `location: ''` + `available: false` 插进列表，而 `normalizeEntry()` 又要求
   * `location` 非空 —— 于是同一条记录**读盘时被丢掉、下次拉取时又插回来**，
   * 用户看到的就是「列表里同一个名字出现两条，其中一条点不动」。
   * 更隐蔽的后果是 `findByLocation('')` 会命中这个空壳，
   * 后续 `register()` 可能把真实仓库的位置写到一个空条目上。
   *
   * 修复策略（幂等，可反复调用）：
   *  - `location` 为空但 `vaultId` 是真实 id → 补成 `cloud:<vaultId>` 并置为可用；
   *  - `location` 为空且 `vaultId` 还是 `pending:` 占位 → 丢弃（既无位置又无身份，无从恢复）；
   *  - 同一个 `vaultId` 出现多条 → 合并成一条（统计取"更完整"的值）。
   *
   * @returns 是否发生修改（调用方据此决定是否 persist）
   */
  private repair(): boolean {
    const before = JSON.stringify(this.entries);
    const beforeCurrent = this.currentVaultId;
    const out: VaultEntry[] = [];
    for (const entry of this.entries) {
      if (!entry.location) {
        if (entry.vaultId.startsWith('pending:')) continue;
        entry.location = `cloud:${entry.vaultId}`;
        entry.adapter = 'browser-idb';
        entry.available = true;
      }
      const dupIndex = out.findIndex((e) => e.vaultId === entry.vaultId);
      if (dupIndex < 0) {
        out.push(entry);
        continue;
      }
      /*
       * 合并同一 vaultId 的两条记录。
       *
       * 「哪条更可信」按优先级：真实本机目录（桌面端绝对路径）> `cloud:` 逻辑位置；
       * 其次是「同步过」> 「没同步过」。统计类字段取更完整的值，
       * 避免合并后列表反而显示成 0 篇 / 从未同步。
       */
      const keep = out[dupIndex]!;
      const score = (e: VaultEntry): number => {
        const realPath = e.location.startsWith('cloud:') ? 0 : 1;
        return realPath * 4 + (e.lastSyncedAt ? 2 : 0) + (e.available ? 1 : 0);
      };
      const winner = score(entry) > score(keep) ? entry : keep;
      winner.lastOpenedAt = Math.max(keep.lastOpenedAt, entry.lastOpenedAt);
      winner.lastSyncedAt = Math.max(keep.lastSyncedAt ?? 0, entry.lastSyncedAt ?? 0) || undefined;
      winner.docCount = Math.max(keep.docCount ?? 0, entry.docCount ?? 0) || undefined;
      winner.bytes = Math.max(keep.bytes ?? 0, entry.bytes ?? 0) || undefined;
      const created = [keep.createdAt, entry.createdAt].filter((t) => Number.isFinite(t) && t > 0);
      winner.createdAt = created.length ? Math.min(...created) : 0;
      if (!winner.name) winner.name = keep.name || entry.name;
      // 停用是用户显式操作，任一条为 disabled 就保留该状态，不能被合并悄悄启用
      if (keep.status === 'disabled' || entry.status === 'disabled') winner.status = 'disabled';
      out[dupIndex] = winner;
    }
    this.entries = out;
    /*
     * 「当前仓库」不能被修复逻辑顺手改掉（1.1.9 硬约束）。
     *
     * 用户升级后打开应用，必须还是上次那个仓库。repair() 只允许在
     * **当前仓库那条记录本身被丢弃**（空 location 且是 `pending:` 占位）时才重新选一个，
     * 其余情况一律保持 `currentVaultId` 不变 —— 即使它的 id 在合并中被改写，
     * 也要把 currentVaultId 迁到存活的那一条上，而不是另选一个。
     */
    if (this.currentVaultId && !this.entries.some((e) => e.vaultId === this.currentVaultId)) {
      const fallback =
        this.entries.find((e) => e.status === 'active' && e.available) ??
        this.entries.find((e) => e.status === 'active') ??
        this.entries[0];
      this.currentVaultId = fallback?.vaultId ?? '';
      if (fallback && this.storage) {
        try {
          this.storage.setItem(LAST_VAULT_KEY, fallback.location);
        } catch {
          /* ignore */
        }
      }
    }
    return JSON.stringify(this.entries) !== before || this.currentVaultId !== beforeCurrent;
  }

  /**
   * 从既有的 `neomd.lastVault` 引导出第一条仓库记录。
   *
   * 这是**老用户升级的兼容路径**：1.1.4 及以前只存了「上次打开的仓库位置」，
   * 没有任何仓库清单。首次加载注册表时把它变成一条记录，
   * 用户就不会在升级后「仓库凭空消失」。
   */
  private bootstrapFromLastVault(): void {
    if (!this.storage) return;
    const last = this.storage.getItem(LAST_VAULT_KEY);
    if (!last) return;
    const entry: VaultEntry = {
      // 此时还不知道真实 vaultId（要打开仓库才能读到 .neomd/vault.json），
      // 先用位置派生一个稳定的临时 id；真正打开后由 `attachVaultId()` 替换。
      vaultId: `pending:${last}`,
      name: nameFromLocation(last),
      location: last,
      adapter: inferAdapter(last),
      status: 'active',
      lastOpenedAt: Date.now(),
      createdAt: Date.now(),
      available: true,
    };
    this.entries = [entry];
    this.currentVaultId = entry.vaultId;
    this.persist();
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(
        STORAGE_KEY,
        JSON.stringify({ entries: this.entries, currentVaultId: this.currentVaultId }),
      );
    } catch {
      /* 配额满等异常不应影响主流程 */
    }
  }

  /* ------------------------------ 查询 ------------------------------ */

  list(): VaultEntry[] {
    return [...this.entries];
  }

  /** 按「当前优先、最近打开优先」排序后的列表，供 UI 直接渲染 */
  listSorted(): VaultEntry[] {
    return [...this.entries].sort((a, b) => {
      const aCur = a.vaultId === this.currentVaultId ? 1 : 0;
      const bCur = b.vaultId === this.currentVaultId ? 1 : 0;
      if (aCur !== bCur) return bCur - aCur;
      return b.lastOpenedAt - a.lastOpenedAt;
    });
  }

  get(vaultId: string): VaultEntry | null {
    return this.entries.find((e) => e.vaultId === vaultId) ?? null;
  }

  findByLocation(location: string): VaultEntry | null {
    return this.entries.find((e) => e.location === location) ?? null;
  }

  current(): VaultEntry | null {
    return this.get(this.currentVaultId);
  }

  get currentId(): string {
    return this.currentVaultId;
  }

  /* ------------------------------ 写入 ------------------------------ */

  /**
   * 注册或更新一个仓库。
   *
   * 按 `location` 去重：同一目录重复打开不会产生多条记录；
   * 若已有记录的 `vaultId` 是 `pending:` 占位符，则用真实 id 替换。
   */
  register(input: {
    vaultId: string;
    name?: string;
    location: string;
    adapter?: VaultAdapterKind;
  }): VaultEntry {
    const existing = this.findByLocation(input.location);
    const now = Date.now();
    if (existing) {
      existing.vaultId = input.vaultId;
      if (input.name?.trim()) existing.name = input.name.trim();
      existing.lastOpenedAt = now;
      existing.available = true;
      this.entries = [...this.entries];
      this.persist();
      return existing;
    }
    const entry: VaultEntry = {
      vaultId: input.vaultId,
      name: input.name?.trim() || nameFromLocation(input.location),
      location: input.location,
      adapter: input.adapter ?? inferAdapter(input.location),
      status: 'active',
      lastOpenedAt: now,
      createdAt: now,
      available: true,
    };
    this.entries = [...this.entries, entry];
    this.persist();
    return entry;
  }

  /**
   * 把占位 `pending:<location>` 记录替换成真实 vaultId。
   *
   * 调用时机：仓库真正打开后（`vault.open()` 已读到 `.neomd/vault.json`）。
   * 若该真实 id 已存在另一条记录（同目录被注册过两次），则合并去重。
   */
  attachVaultId(location: string, realVaultId: string, name?: string): VaultEntry | null {
    const idx = this.entries.findIndex((e) => e.location === location);
    if (idx < 0) return null;
    const entry = this.entries[idx]!;
    if (entry.vaultId === realVaultId) {
      if (name?.trim()) entry.name = name.trim();
      this.persist();
      return entry;
    }
    // 已存在同 id 的其它记录 → 删掉当前这条，避免重复
    const dup = this.entries.find((e, i) => i !== idx && e.vaultId === realVaultId);
    if (dup) {
      this.entries = this.entries.filter((_, i) => i !== idx);
      dup.lastOpenedAt = Date.now();
      dup.available = true;
      if (name?.trim()) dup.name = name.trim();
      if (this.currentVaultId === entry.vaultId) this.currentVaultId = dup.vaultId;
      this.persist();
      return dup;
    }
    const wasCurrent = this.currentVaultId === entry.vaultId;
    entry.vaultId = realVaultId;
    if (name?.trim()) entry.name = name.trim();
    if (wasCurrent) this.currentVaultId = realVaultId;
    this.entries = [...this.entries];
    this.persist();
    return entry;
  }

  rename(vaultId: string, name: string): boolean {
    const entry = this.get(vaultId);
    const next = name.trim();
    if (!entry || !next) return false;
    entry.name = next;
    this.entries = [...this.entries];
    this.persist();
    return true;
  }

  setStatus(vaultId: string, status: VaultStatus): boolean {
    const entry = this.get(vaultId);
    if (!entry) return false;
    entry.status = status;
    this.entries = [...this.entries];
    this.persist();
    return true;
  }

  setCurrent(vaultId: string): boolean {
    const entry = this.get(vaultId);
    if (!entry || entry.status === 'disabled') return false;
    this.currentVaultId = vaultId;
    entry.lastOpenedAt = Date.now();
    this.entries = [...this.entries];
    this.persist();
    if (this.storage) {
      try {
        this.storage.setItem(LAST_VAULT_KEY, entry.location);
      } catch {
        /* 忽略 */
      }
    }
    return true;
  }

  /** 更新统计信息（打开仓库后回填文档数与占用） */
  updateStats(vaultId: string, stats: { docCount?: number; bytes?: number }): void {
    const entry = this.get(vaultId);
    if (!entry) return;
    if (typeof stats.docCount === 'number') entry.docCount = stats.docCount;
    if (typeof stats.bytes === 'number') entry.bytes = stats.bytes;
    this.entries = [...this.entries];
    this.persist();
  }

  /**
   * 记录一次成功的同步（1.1.8 新增）。
   *
   * 为什么需要它：`VaultManagerSection` 判断仓库「是否已同步」用的是
   * `entry.lastSyncedAt`（见该组件 `synced: remoteIds.has(vaultId) || typeof lastSyncedAt === 'number'`），
   * 但 1.1.8 之前**全项目没有任何地方写过这个字段** ——
   * `syncNow()` 只设置了 store 级的全局 `lastSyncAt`，没有回写到仓库注册表。
   * 结果就是「仓库管理里每个仓库永远显示未同步」，即使用户刚刚同步成功。
   *
   * 这里在同步成功后回写，同时刷新统计，保证 UI 与真实状态一致。
   *
   * @param vaultId 仓库 id
   * @param stats 可选：同步后回填文档数与占用
   * @returns 是否命中该仓库
   */
  markSynced(vaultId: string, stats: { docCount?: number; bytes?: number } = {}): boolean {
    const entry = this.get(vaultId);
    if (!entry) return false;
    const now = Date.now();
    entry.lastSyncedAt = now;
    if (typeof stats.docCount === 'number') entry.docCount = stats.docCount;
    if (typeof stats.bytes === 'number') entry.bytes = stats.bytes;
    this.entries = [...this.entries];
    this.persist();
    return true;
  }

  /**
   * 从本机注册表移除。
   *
   * **不删除任何文件**，也不删除云端内容 —— 只把这条记录从清单里去掉。
   * 删除磁盘目录是另一件危险的事，必须由 UI 显式确认后单独执行。
   */
  remove(vaultId: string): boolean {
    if (vaultId === this.currentVaultId) return false; // 当前仓库不允许移除
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.vaultId !== vaultId);
    if (this.entries.length === before) return false;
    this.persist();
    return true;
  }

  /**
   * 与云端列表合并（1.1.9 增强，1.4.0 加 orphan 对账）。
   *
   * 规则：
   * - 云端有、本机也有的（按 vaultId 匹配，或本机存在同名且为 `pending:` / `cloud:<name>` 的条目）
   *   → 用云端的 vaultId / name / status / 统计覆盖，保留本机有效 `location` 并确保 `available: true`；
   * - 云端有、本机没有 → 插入一条 `location: "cloud:" + r.vaultId`、`available: true` 的记录，
   *   让 Web 端与 PC 端都能直接点击切换打开该云端仓库并拉取文档内容（PC 端在 `openVault` 时会自动将其映射到 `<默认本地目录>/<仓库名>`）；
   * - **本机有、云端没有（1.4.0 新增）** → 标 `orphan: true` 并累加 `orphanMissCount`；
   *   连续 {@link ORPHAN_REMOVE_AFTER_MISSES} 轮未出现才从注册表移除。
   *
   * ## 为什么「本机有、云端没有」必须处理（原先的注释写的是「保留」）
   *
   * 旧行为是原样保留，理由是「可能还没同步过」。但这条宽松策略造成了实测到的**反弹**：
   * 某设备的 localStorage 里留着 6 个已删除的 vaultId → 周期同步仍会访问
   * `/api/storage/*`（`syncVaultById` / `syncAllVaults` 遍历的就是这份注册表）
   * → 服务端 `assertVaultUsable()` 把它们重新登记回 `user_vaults`
   * → 刚清理干净的幽灵仓库又出现（实测清理后 25 分钟回弹到 10 条）。
   *
   * 现在的语义严格区分两种情况（这是本修复的核心）：
   *  - **云端有、本机没下载** → `available:false` 但**不是** orphan，仍可发现/切换 ✅
   *  - **云端已删除** → `orphan:true` + `available:false`，**跳过同步**，N 轮后移除
   *
   * 关键约束：`hadCloudPresence()` 保证**纯本地仓库永不被判 orphan**
   * （用户只是没登录云端，不能把本地仓库标成已删除）。
   */
  mergeRemote(remote: RemoteVaultDto[]): void {
    if (!Array.isArray(remote) || !remote.length) return;
    let changed = false;

    /*
     * 先记录本轮云端返回的全部 vaultId，供后面的 orphan 对账使用。
     *
     * 注意还要收集「location 里指向的云目标」，因为有些老条目
     * `vaultId` 是 `pending:...` 而 `location` 是 `cloud:<真实id>`，
     * 只比 vaultId 会把它误判成 orphan。
     */
    const remoteIds = new Set<string>();

    for (const r of remote) {
      if (!r || typeof r.vaultId !== 'string' || !r.vaultId) continue;
      remoteIds.add(r.vaultId);
      const cleanName = r.name?.trim() || r.vaultId;
      let local = this.get(r.vaultId);
      if (!local) {
        // 尝试匹配本机尚未对齐真实 vaultId 的同名条目（如 pending:... 或 cloud:<name>）
        local =
          this.entries.find(
            (e) =>
              e.name === cleanName &&
              (e.vaultId.startsWith('pending:') ||
                e.location === `cloud:${cleanName}` ||
                e.location === `cloud:${r.vaultId}` ||
                !e.location),
          ) ?? null;
        if (local) {
          const wasCurrent = this.currentVaultId === local.vaultId;
          local.vaultId = r.vaultId;
          if (wasCurrent) this.currentVaultId = r.vaultId;
          changed = true;
        }
      }
      if (local) {
        if (cleanName && cleanName !== local.name) {
          local.name = cleanName;
          changed = true;
        }
        if (!local.location) {
          local.location = `cloud:${r.vaultId}`;
          changed = true;
        }
        if (!local.available) {
          local.available = true;
          changed = true;
        }
        // 云端确实有它 → 清除 orphan 状态（可能是重新恢复的仓库，或上次网络抖动误判）
        if (local.orphan) {
          local.orphan = false;
          local.orphanSince = undefined;
          local.orphanMissCount = 0;
          changed = true;
        }
        if (r.status === 'disabled' || r.status === 'active') {
          if (local.status !== r.status) {
            local.status = r.status;
            changed = true;
          }
        }
        if (typeof r.docCount === 'number') local.docCount = r.docCount;
        if (typeof r.bytes === 'number') local.bytes = r.bytes;
        if (r.lastSyncedAt) local.lastSyncedAt = toMs(r.lastSyncedAt);
        changed = true;
      } else {
        this.entries.push({
          vaultId: r.vaultId,
          name: cleanName,
          location: `cloud:${r.vaultId}`,
          adapter: 'browser-idb',
          status: r.status === 'disabled' ? 'disabled' : 'active',
          lastOpenedAt: 0,
          createdAt: toMs(r.createdAt, Date.now()),
          available: true,
          lastSyncedAt: r.lastSyncedAt ? toMs(r.lastSyncedAt) : undefined,
          docCount: typeof r.docCount === 'number' ? r.docCount : undefined,
          bytes: typeof r.bytes === 'number' ? r.bytes : undefined,
        });
        changed = true;
      }
    }

    /*
     * ── orphan 对账（1.4.0 需求10 防复发的核心）──
     *
     * 遍历「本轮云端没返回」的条目：
     *  - 有云端痕迹 → 累加 miss 次数，首次命中时打 `orphan:true` 与 `orphanSince`；
     *    达到 ORPHAN_REMOVE_AFTER_MISSES 后从注册表物理移除；
     *  - 无云端痕迹（纯本地仓库）→ 完全不动。
     */
    const now = Date.now();
    const beforeLen = this.entries.length;
    this.entries = this.entries.filter((e) => {
      // 云端这轮返回了它（按 vaultId 或 location 指向的云目标）
      if (remoteIds.has(e.vaultId)) return true;
      const locTarget =
        typeof e.location === 'string' && e.location.startsWith('cloud:')
          ? e.location.slice('cloud:'.length).trim()
          : '';
      if (locTarget && remoteIds.has(locTarget)) return true;

      // 纯本地仓库：永不判 orphan
      if (!hadCloudPresence(e)) return true;

      const misses = (e.orphanMissCount ?? 0) + 1;
      e.orphanMissCount = misses;
      if (!e.orphan) {
        e.orphan = true;
        e.orphanSince = now;
        // orphan 必须同时不可用、不可切换 —— 避免用户点进一个云端已删除的仓库
        e.available = false;
        changed = true;
      }
      if (misses >= ORPHAN_REMOVE_AFTER_MISSES) {
        // 连续多轮确认云端确实没有 → 物理移除，彻底打断反弹链路
        changed = true;
        return false;
      }
      changed = true;
      return true;
    });

    /*
     * 移除后可能把 currentVaultId 指向不存在的条目 → 回落到第一个可用仓库。
     * 与 `prunePseudoCloudVaults()` 的处理保持一致。
     */
    if (this.entries.length !== beforeLen && !this.entries.some((e) => e.vaultId === this.currentVaultId)) {
      const next =
        this.entries.find((e) => remoteIds.has(e.vaultId) && e.status === 'active') ??
        this.entries.find((e) => e.status === 'active' && !e.orphan) ??
        this.entries[0];
      this.currentVaultId = next?.vaultId ?? '';
      if (next && this.storage) {
        try {
          this.storage.setItem(LAST_VAULT_KEY, next.location);
        } catch {
          /* ignore */
        }
      }
    }

    if (changed) {
      this.entries = [...this.entries];
      this.persist();
    }
  }

  /**
   * 判断某个仓库当前是否可以参与**同步**（1.4.0 需求10）。
   *
   * 这是打断反弹链路的实际执行点：`syncAllVaults()` / `syncVaultById()` 在遍历
   * 注册表时应该用本方法过滤，而不是直接遍历 `list()`。
   *
   * 不可同步的情况：
   *  - `orphan: true`（云端已删除，再访问会让服务端把它的登记**重新建回来**）；
   *  - `status === 'disabled'`（用户主动停用）；
   *  - 没有任何 `location`（无法打开）。
   */
  isSyncable(entry: VaultEntry | null | undefined): boolean {
    if (!entry) return false;
    if (entry.orphan) return false;
    if (entry.status === 'disabled') return false;
    if (!entry.location) return false;
    return true;
  }

  /** 返回**可参与同步**的仓库列表（1.4.0 需求10，供同步循环使用） */
  listSyncable(): VaultEntry[] {
    return this.entries.filter((e) => this.isSyncable(e));
  }

  /** 返回当前被标记为 orphan 的仓库（供 UI 展示「云端已删除」与测试断言） */
  listOrphans(): VaultEntry[] {
    return this.entries.filter((e) => e.orphan === true);
  }

  /**
   * 清理旧版按用户名自动生成的伪仓库（如 `cloud:admin`、`cloud:my`）（1.1.9）。
   *
   * 背景：1.1.8 及以前网页端启动时固定打开 `cloud:<username>`（如 `admin`、`my`），
   * 导致同一浏览器先后登录不同账号或 PC 已同步真实仓库（「郑磊 / Neo MD / Neo MD-整理」）后，
   * 网页端仍残留 `admin` 和 `my` 两个空壳仓库。
   *
   * 规则：当云端已存在至少一个真实仓库（`remoteIds.size > 0`）时，
   * 移除满足以下全部条件的伪仓库条目：
   *  1. `vaultId` 不在云端 `remoteIds` 中；
   *  2. `location` 形如 `cloud:<name>` 且不是 `cloud:<真实vaultId>`（或者是已知用户名伪仓库）；
   *  3. 文档数为 0（或未统计）且从未同步过（无 `lastSyncedAt`）。
   *
   * 注意：若被清理的正好是 `currentVaultId`，会将 `currentVaultId` 切换到云端第一个可用仓库。
   */
  prunePseudoCloudVaults(remoteVaultIds: Iterable<string>, extraNames: string[] = []): boolean {
    const remoteSet = new Set(Array.from(remoteVaultIds).filter(Boolean));
    if (remoteSet.size === 0) return false;
    const pseudoNames = new Set(
      ['admin', 'my', ...extraNames].map((s) => s.trim().toLowerCase()).filter(Boolean),
    );
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => {
      if (remoteSet.has(e.vaultId)) return true;
      const isCloudLoc = e.location.startsWith('cloud:');
      if (!isCloudLoc) return true; // 本地真实目录仓库绝不自动清理
      const locTarget = e.location.slice('cloud:'.length).trim();
      if (remoteSet.has(locTarget)) return true;
      const isPseudoName =
        pseudoNames.has(e.name.trim().toLowerCase()) ||
        pseudoNames.has(locTarget.toLowerCase()) ||
        e.vaultId.startsWith('pending:cloud:');
      const isEmptyUnsynced = (e.docCount ?? 0) === 0 && !e.lastSyncedAt;
      if (isPseudoName || isEmptyUnsynced) {
        return false;
      }
      return true;
    });
    if (this.entries.length === before) return false;
    if (!this.entries.some((e) => e.vaultId === this.currentVaultId)) {
      const next =
        this.entries.find((e) => remoteSet.has(e.vaultId) && e.status === 'active') ??
        this.entries.find((e) => e.status === 'active') ??
        this.entries[0];
      this.currentVaultId = next?.vaultId ?? '';
      if (next && this.storage) {
        try {
          this.storage.setItem(LAST_VAULT_KEY, next.location);
        } catch {
          /* ignore */
        }
      }
    }
    this.persist();
    return true;
  }

  /** 清空（仅供测试与「重置本机仓库清单」使用，不动任何文件） */
  clear(): void {
    this.entries = [];
    this.currentVaultId = '';
    this.persist();
  }
}

/**
 * 进程内单例。
 *
 * 与 `knowledge/vault-bridge.ts` 同样的理由：设置页、编辑器、同步层都要读同一份清单，
 * 各自 new 一个会出现「A 改名了 B 看不到」的状态分裂。
 */
let singleton: VaultRegistry | null = null;

export function sharedVaultRegistry(): VaultRegistry {
  if (!singleton) singleton = new VaultRegistry();
  return singleton;
}

/** 测试用：重置单例 */
export function resetSharedVaultRegistry(): void {
  singleton = null;
}
