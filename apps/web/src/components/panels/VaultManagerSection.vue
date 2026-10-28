<script setup lang="ts">
/**
 * 仓库管理面板（1.1.5 需求：仓库可以备份、复制、删除、停用等）。
 *
 * ## 数据源策略（关键设计）
 *
 * 项目当前是**单仓库架构**：`settings.localVault` 只有一个 `root`，`VaultRef` 只描述
 * 「当前打开的仓库」。多仓库列表在本机由 `stores/app.ts` 的 `vaults`（localStorage
 * `neomd.vaultList.v1`）维护，每条只有 `{ name, location, lastOpenedAt }`。
 *
 * 因此本组件把「仓库列表」抽象成两层：
 *   1. **本机列表**（必有）：来自 `app.vaults`，是本组件的权威数据源；
 *   2. **云端档案**（可选）：来自 `vaultsApi.list()`，用于补充 `status` / `docCount` /
 *      `bytes` / `lastSyncedAt`，以及「云端有但本机没打开过」的仓库。
 *
 * 两者按 `location`（本机）↔ `vaultId`（云端）关联。因为本机条目没有 vaultId，
 * 关联规则是：**当前仓库**直接用 `app.vault?.vaultId` 精确匹配；其余条目按
 * `vaultId === location` 或 `name` 匹配（服务端也允许以 location 作为 vaultId 上报）。
 *
 * 这样设计的好处：即使 `packages/core/src/vault/registry.ts` 的 `VaultRegistry`
 * 尚未落盘，界面也**完全可用**（本机列表 + localStorage 持久化 + 云端档案可选增强），
 * 不会因为一个依赖缺失就整块不可用。
 *
 * ## 与「契约」的关系
 *
 * task-18 描述里约定的 `VaultEntry` / `VaultRegistry`（`packages/core/src/vault/registry.ts`，
 * 由 Lead 并行实现）。本组件按**同一份字段语义**组织本地视图模型 `VaultRow`：
 *   vaultId / name / location / status / lastOpenedAt / createdAt / available
 * 并额外补 docCount / bytes / synced / lastSyncedAt 用于展示。
 *
 * **1.1.5 起 `packages/core/src/vault/registry.ts` 已落盘，本组件直接以
 * `sharedVaultRegistry()` 为唯一数据源**（它接管了 `neomd.vaultList.v1`，
 * 并向下兼容 1.1.4 的极简数组格式），不再直接读写 `app.vaults` 或 localStorage，
 * 避免「注册表写一份、组件写另一份」的状态分裂。
 */
import { computed, onMounted, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import {
  detectRuntime,
  getBridge,
  sharedVaultRegistry,
  Vault,
  NativeVaultAdapter,
  BrowserVaultAdapter,
  VaultRegistry,
  type VaultEntry,
  type RemoteVaultDto,
} from '@neomd/core';
import { formatBytes } from '@neomd/shared';
import { useAppStore } from '@/stores/app';
import { useAuthStore } from '@/stores/auth';
import { vaultsApi, profileApi, isPrivacyModeError } from '@/api/client';

const props = defineProps<{ compact?: boolean }>();

const app = useAppStore();
const auth = useAuthStore();
const runtime = detectRuntime();
const bridge = getBridge();
/** 仓库注册表（进程内单例，设置页 / 编辑器 / 同步层共用同一份清单） */
const registry: VaultRegistry = sharedVaultRegistry();

const isDesktop = computed(() => runtime.platform === 'desktop');
const canPickDirectory = computed(() => Boolean(bridge?.dialog?.pickDirectory));
/** 本机是否为浏览器端（网页 / 移动）：浏览器端没有任意目录访问权，只能走云端仓库 */
const isBrowserOnly = computed(() => runtime.platform === 'web');

/* ------------------------------------------------------------------ */
/* 视图模型                                                            */
/* ------------------------------------------------------------------ */

/** 一行仓库（registry 条目 + 本机实时状态） */
interface VaultRow {
  /** 行唯一键（= vaultId） */
  key: string;
  vaultId: string;
  name: string;
  location: string;
  status: 'active' | 'disabled';
  lastOpenedAt: number;
  createdAt: number;
  /** 是否本机可打开（云端独有仓库为 false） */
  available: boolean;
  /** 是否就是当前打开的仓库 */
  isCurrent: boolean;
  docCount: number;
  bytes: number;
  /** 是否已有云端档案（有 lastSyncedAt 或能从云端列表匹配到） */
  synced: boolean;
  lastSyncedAt: number;
}

const loading = ref(false);
const busyKey = ref('');
const errorMsg = ref('');
const infoMsg = ref('');

/**
 * registry 的响应式镜像。
 *
 * `VaultRegistry` 内部是普通数组（不是 Vue ref），因此每次写操作后调用
 * `syncFromRegistry()` 把最新快照放进 ref，computed 才会重算。
 */
const entries = ref<VaultEntry[]>([]);
const currentId = ref('');

function syncFromRegistry(): void {
  // listSorted() 已按「当前优先、最近打开优先」排好序
  entries.value = registry.listSorted();
  currentId.value = registry.currentId;
}

/** 云端已知的 vaultId 集合（用于判断「是否已同步到云端」） */
const remoteIds = ref<Set<string>>(new Set());

/** 当前仓库的 vaultId（本机 Vault 实例在 open() 时生成并持久化到 .neomd/vault.json） */
const currentVaultId = computed(() => {
  const v = app.vault as unknown as { vaultId?: string } | null;
  return v?.vaultId ?? '';
});

/**
 * 组装展示行：直接把 registry 条目投影成视图模型。
 *
 * 相比 1.1.5 之前的「location / 名称猜云端档案」做法，registry 已原生提供
 * vaultId / status / available / docCount / bytes / lastSyncedAt，因此这里
 * 只做两件事：补 `isCurrent`（用 registry.currentId 判定）、过滤用户已删除的条目。
 */
const rows = computed<VaultRow[]>(() => {
  const curId = currentId.value;
  const liveVaultId = currentVaultId.value;
  return entries.value
    .map<VaultRow>((e) => {
      // 当前仓库：registry 的 currentId 与 Vault 实例的 vaultId 任一命中即可
      // （registry 里可能还是 pending: 占位 id，此时用 app.vaultLocation 兜底判当前）
      const isCurrent =
        e.vaultId === curId ||
        (Boolean(liveVaultId) && e.vaultId === liveVaultId) ||
        (Boolean(app.vaultLocation) && e.location === app.vaultLocation);
      return {
        key: e.vaultId || e.location,
        vaultId: e.vaultId,
        name: e.name,
        location: e.location,
        status: e.status === 'disabled' ? 'disabled' : 'active',
        lastOpenedAt: e.lastOpenedAt,
        createdAt: e.createdAt,
        available: e.available !== false,
        isCurrent,
        docCount: e.docCount ?? 0,
        bytes: e.bytes ?? 0,
        synced: remoteIds.value.has(e.vaultId) || typeof e.lastSyncedAt === 'number',
        lastSyncedAt: typeof e.lastSyncedAt === 'number' ? e.lastSyncedAt : 0,
      };
    })
    // 已被用户删除的条目不再展示（当前仓库永远保留，不允许删除）
    .filter((r) => r.isCurrent || !isDeleted(r));
});

/** 当前仓库名（头部展示） */
const currentName = computed(
  () => rows.value.find((r) => r.isCurrent)?.name || app.vaultName || '未打开',
);

/** 汇总：仓库数 / 文档总数 / 总占用 */
const summary = computed(() => {
  const list = rows.value;
  return {
    vaults: list.length,
    docs: list.reduce((s, r) => s + r.docCount, 0),
    bytes: list.reduce((s, r) => s + r.bytes, 0),
  };
});

/* ------------------------------------------------------------------ */
/* 数据加载                                                            */
/* ------------------------------------------------------------------ */

function flashInfo(msg: string): void {
  infoMsg.value = msg;
  errorMsg.value = '';
  window.setTimeout(() => {
    if (infoMsg.value === msg) infoMsg.value = '';
  }, 2600);
}

function flashError(msg: string): void {
  errorMsg.value = msg;
  infoMsg.value = '';
}

/**
 * 统计当前仓库的文档数与占用，回填进 registry。
 *
 * 只统计**当前仓库**：`Vault.usage()` 需要打开仓库才能读，而 `Vault.open()`
 * 会重建索引、写 `.neomd/`，副作用太大，不适合为了列表统计去逐个打开。
 * 其余仓库的统计优先用云端快照（registry.mergeRemote 已写入 docCount/bytes）。
 */
async function loadLocalStats(): Promise<void> {
  if (!app.vault) return;
  try {
    const usage = await app.vault.usage();
    const row = rows.value.find((r) => r.isCurrent);
    if (!row) return;
    registry.updateStats(row.vaultId, { docCount: app.docs.length, bytes: usage.bytes });
    syncFromRegistry();
  } catch {
    /* 统计失败不影响列表展示 */
  }
}

/** 拉取云端仓库档案并合并进 registry（未登录 / 私有化模式 / 404 时静默跳过） */
async function loadRemote(): Promise<void> {
  if (!auth.isLoggedIn) return;
  try {
    const res = await vaultsApi.list();
    const list = (res.vaults ?? []) as RemoteVaultDto[];
    remoteIds.value = new Set(list.map((v) => v.vaultId).filter(Boolean));
    // mergeRemote 会：覆盖已有条目的 name/status/统计；插入「云端独有」的 available:true 条目
    registry.mergeRemote(list);
    if (remoteIds.value.size > 0) {
      const username = auth.user?.username?.trim().toLowerCase() ?? '';
      registry.prunePseudoCloudVaults(remoteIds.value, username ? [username] : []);
    }
    syncFromRegistry();
    app.refreshVaultList();
  } catch (e) {
    // 私有化模式属于预期内，不报错；其余情况给出可读提示但不阻断本机功能
    if (isPrivacyModeError(e)) return;
    const msg = (e as Error).message || '';
    if (/404|not found/i.test(msg)) {
      errorMsg.value =
        '服务端仓库接口尚未就绪（/api/vaults 返回 404），云端档案功能暂不可用；本机仓库管理不受影响。';
    } else {
      errorMsg.value = `读取云端仓库档案失败：${msg}`;
    }
  }
}

async function refresh(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  errorMsg.value = '';
  try {
    syncFromRegistry();
    await loadLocalStats();
    await loadRemote();
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void refresh();
});

/* ------------------------------------------------------------------ */
/* 本机「已删除」黑名单                                                */
/* ------------------------------------------------------------------ */

/**
 * 本机「已删除」黑名单（vaultId / location / 名称 三种键都记）。
 *
 * 为什么 registry 之外还需要它：`registry.mergeRemote()` 会把「云端有、本机没有」
 * 的仓库重新插回列表（这是它的正确职责 —— 让用户看到其它设备上的仓库）。
 * 但如果本地删除时云端档案因网络 / 404 / 延迟未真正删掉，下一次刷新就会表现为
 * 「删了又回来了」。因此本组件额外记一份删除黑名单，在渲染层过滤，
 * 用户的重置意图得到尊重；「添加仓库」重新选中同一目录时解除黑名单。
 */
const DELETED_KEY = 'neomd.vaultDeleted.v1';

function loadDeleted(): Set<string> {
  try {
    const raw = localStorage.getItem(DELETED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

const deletedSet = ref<Set<string>>(loadDeleted());

function saveDeleted(next: Set<string>): void {
  deletedSet.value = next;
  try {
    localStorage.setItem(DELETED_KEY, JSON.stringify([...next]));
  } catch {
    /* 忽略 */
  }
}

/** 该行是否已被用户删除（任一键命中即视为已删除） */
function isDeleted(row: { vaultId: string; location: string; name: string }): boolean {
  const set = deletedSet.value;
  return set.has(row.vaultId) || set.has(row.location) || set.has(row.name);
}

/** 解除某条记录的黑名单（重新添加 / 重新打开该仓库时调用） */
function undelete(vaultId: string, location: string, name: string): void {
  const set = deletedSet.value;
  if (!set.has(vaultId) && !set.has(location) && !set.has(name)) return;
  const next = new Set(set);
  next.delete(vaultId);
  next.delete(location);
  next.delete(name);
  saveDeleted(next);
}

/** 最终状态：直接取 registry 的 status（registry 已是唯一真相） */
function statusOf(row: VaultRow): 'active' | 'disabled' {
  return row.status;
}

/* ------------------------------------------------------------------ */
/* 操作：切换                                                          */
/* ------------------------------------------------------------------ */

async function switchTo(row: VaultRow): Promise<void> {
  if (busyKey.value) return;
  if (row.isCurrent) return;
  if (statusOf(row) === 'disabled') {
    flashError(`「${row.name}」已停用，无法切换。请先启用该仓库（数据保留）。`);
    return;
  }
  const targetLoc = row.location || `cloud:${row.vaultId}`;
  busyKey.value = row.key;
  errorMsg.value = '';
  try {
    await app.switchVault(targetLoc, row.name);
    const liveVaultId = currentVaultId.value;
    if (liveVaultId) {
      registry.attachVaultId(app.vaultLocation || targetLoc, liveVaultId, row.name);
      registry.setCurrent(liveVaultId);
    }
    undelete(row.vaultId, targetLoc, row.name);
    flashInfo(`已切换到「${row.name}」`);
    await refresh();
  } catch (e) {
    flashError(`切换失败：${(e as Error).message}`);
  } finally {
    busyKey.value = '';
  }
}

/* ------------------------------------------------------------------ */
/* 操作：同步单个仓库 / 全部同步                                       */
/* ------------------------------------------------------------------ */

async function syncOne(row: VaultRow): Promise<void> {
  if (busyKey.value) return;
  if (statusOf(row) === 'disabled') {
    flashError(`「${row.name}」已停用，无法同步。`);
    return;
  }
  busyKey.value = row.key;
  errorMsg.value = '';
  try {
    const ok = await app.syncVaultById(row.vaultId || row.location);
    if (ok) flashInfo(`「${row.name}」已同步完成`);
    await refresh();
  } catch (e) {
    flashError(`同步失败：${(e as Error).message}`);
  } finally {
    busyKey.value = '';
  }
}

async function syncAll(): Promise<void> {
  if (loading.value || busyKey.value) return;
  loading.value = true;
  errorMsg.value = '';
  try {
    const res = await app.syncAllVaults();
    flashInfo(`全部仓库同步完成：${res.synced} 个成功${res.skipped ? `，${res.skipped} 个跳过或失败` : ''}`);
  } catch (e) {
    flashError(`全部同步失败：${(e as Error).message}`);
  } finally {
    loading.value = false;
    await refresh();
  }
}

/* ------------------------------------------------------------------ */
/* 操作：新建仓库 / 添加仓库                                           */
/* ------------------------------------------------------------------ */

async function createNewVault(): Promise<void> {
  if (busyKey.value) return;
  try {
    /*
     * 这里把 bridge 与 pickDirectory 先取到局部变量再做判空。
     *
     * 为什么不用 `bridge!.dialog.pickDirectory()`：`canPickDirectory` 是个 computed，
     * TypeScript 无法从它反推出 `bridge` 非空（跨表达式不传递收窄），
     * 于是必须用 `!` 断言 —— 一旦将来 getBridge() 的返回类型或调用时机变化，
     * 这个断言就会变成「静默的运行时 undefined 调用」。显式判空更安全，
     * 也顺带消掉了 vue-tsc 的 TS2532。
     */
    const pickDirectory = bridge?.dialog?.pickDirectory;
    if (isDesktop.value && canPickDirectory.value && pickDirectory) {
      const picked = await pickDirectory();
      if (!picked) return;
      const defaultName = picked.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '新仓库';
      const name = await app.askInput('新建仓库', '确认或修改新仓库名称（数据保存在所选文件夹）', '例如：工作笔记', defaultName);
      const finalName = (name ?? defaultName).trim() || defaultName;
      undelete(`pending:${picked}`, picked, finalName);
      const created = await app.createAndSwitchVault(finalName, picked);
      if (created) {
        flashInfo(`已在文件夹「${picked}」创建仓库「${finalName}」`);
        await refresh();
      }
      return;
    }
    const name = await app.askInput('新建云端仓库', '输入新仓库名称', '例如：知识库', '');
    if (!name || !name.trim()) return;
    const created = await app.createAndSwitchVault(name.trim());
    if (created) {
      flashInfo(`已创建仓库「${name.trim()}」`);
      await refresh();
    }
  } catch (e) {
    flashError(`创建仓库失败：${(e as Error).message}`);
  }
}

async function addVault(): Promise<void> {
  if (isBrowserOnly.value) {
    await createNewVault();
    return;
  }
  const pick = bridge?.dialog?.pickDirectory;
  if (!pick) {
    flashError('当前环境不支持目录选择（缺少原生桥接），无法添加仓库。');
    return;
  }
  try {
    const picked = await pick();
    if (!picked) return;
    const name = picked.split(/[\\/]/).filter(Boolean).pop() || picked;
    // 立即打开一次该文件夹以生成/读取 .neomd/vault.json 的真实 vaultId，并统计文档数与同步到云端
    const adapter = isDesktop.value && bridge ? new NativeVaultAdapter(bridge, 'desktop-fs') : new BrowserVaultAdapter();
    const tmp = new Vault(adapter);
    await tmp.open(picked);
    const docsList = tmp.list();
    const bytes = docsList.reduce((sum, d) => sum + (d.size ?? 0), 0);
    const entry = registry.register({ vaultId: tmp.vaultId, name, location: picked });
    registry.attachVaultId(picked, tmp.vaultId, name);
    registry.updateStats(tmp.vaultId, { docCount: docsList.length, bytes });
    undelete(entry.vaultId, picked, name);
    syncFromRegistry();
    app.refreshVaultList();
    if (app.canSync()) {
      await app.syncVaultById(tmp.vaultId, { silent: true });
    }
    flashInfo(`已关联本地仓库「${name}」（${docsList.length} 篇文档），并已同步到云端。`);
    await refresh();
  } catch (e) {
    flashError(`选择目录失败：${(e as Error).message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 操作：改名                                                          */
/* ------------------------------------------------------------------ */

const renameOpen = ref(false);
const renameRow = ref<VaultRow | null>(null);
const renameValue = ref('');
const renameError = ref('');

function openRename(row: VaultRow): void {
  renameRow.value = row;
  renameValue.value = row.name;
  renameError.value = '';
  renameOpen.value = true;
}

async function confirmRename(): Promise<void> {
  const row = renameRow.value;
  if (!row) return;
  const next = renameValue.value.trim();
  if (!next) {
    renameError.value = '仓库名称不能为空';
    return;
  }
  if (next.length > 40) {
    renameError.value = '仓库名称最多 40 个字符';
    return;
  }
  renameError.value = '';
  busyKey.value = row.key;
  try {
    // 本机：只改显示名，不动目录（registry.rename 会立即持久化）
    registry.rename(row.vaultId, next);
    syncFromRegistry();
    // 当前仓库改名时同步顶部显示名，避免左侧栏仍显示旧名
    if (row.isCurrent) app.vaultName = next;
    // 云端：有档案才同步
    if (row.synced) {
      try {
        await vaultsApi.update(row.vaultId, { name: next });
      } catch (e) {
        if (!isPrivacyModeError(e)) {
          flashError(`本机已改名，但同步到云端失败：${(e as Error).message}`);
          renameOpen.value = false;
          await refresh();
          return;
        }
      }
    }
    renameOpen.value = false;
    flashInfo(`已改名为「${next}」`);
    await refresh();
  } finally {
    busyKey.value = '';
  }
}

/* ------------------------------------------------------------------ */
/* 操作：停用 / 启用                                                    */
/* ------------------------------------------------------------------ */

async function toggleStatus(row: VaultRow): Promise<void> {
  const cur = statusOf(row);
  const next: 'active' | 'disabled' = cur === 'disabled' ? 'active' : 'disabled';
  if (row.isCurrent && next === 'disabled') {
    flashError('不能停用当前正在使用的仓库。请先切换到其它仓库。');
    return;
  }
  busyKey.value = row.key;
  try {
    // registry.setStatus 会立即持久化到 neomd.vaultList.v1，是本机唯一真相
    registry.setStatus(row.vaultId, next);
    syncFromRegistry();
    // 云端档案同步（失败不回滚本机状态，但要如实告知）
    if (row.synced) {
      try {
        await vaultsApi.update(row.vaultId, { status: next });
      } catch (e) {
        if (!isPrivacyModeError(e)) {
          flashError(
            next === 'disabled'
              ? `已在本机停用，但同步到云端失败：${(e as Error).message}`
              : `已在本机启用，但同步到云端失败：${(e as Error).message}`,
          );
          await refresh();
          return;
        }
      }
    }
    flashInfo(next === 'disabled' ? `已停用「${row.name}」（数据保留）` : `已启用「${row.name}」`);
    await refresh();
  } finally {
    busyKey.value = '';
  }
}

/* ------------------------------------------------------------------ */
/* 操作：备份                                                          */
/* ------------------------------------------------------------------ */

/**
 * 备份仓库。
 *
 * 实际做法（如实说明，不静默降级）：
 * - **桌面端 / 已打开的本机仓库**：调 `vault.snapshot()` 在仓库内生成
 *   `.neomd/snapshots/<时间戳>.json` 完整快照（`Vault` 原生能力，含全部文档内容），
 *   拿到 `ossKey`（快照相对路径）后上报云端档案；
 * - 已登录且配置了对象存储时，进一步调 `profileApi.createBackup` 登记备份记录；
 * - 未登录 / 未配存储：只保留本地快照，并明确告知「仅本机快照」；
 * - **云端独有仓库**（本机未打开）：无法读取内容，明确提示不可用及原因。
 */
async function backup(row: VaultRow): Promise<void> {
  if (busyKey.value) return;
  if (!row.available) {
    flashError(
      `无法备份「${row.name}」：该仓库只存在于云端档案，本机没有对应目录，读不到文档内容。请先在 PC 端打开该仓库目录。`,
    );
    return;
  }
  if (!row.isCurrent) {
    flashError(
      `无法直接备份「${row.name}」：当前架构一次只能打开一个仓库，备份需要读取文档内容。请先切换到该仓库再备份。`,
    );
    return;
  }
  const vault = app.vault as unknown as { snapshot?: (label?: string) => Promise<string> } | null;
  if (!vault?.snapshot) {
    flashError('当前仓库适配器不支持生成快照（缺少 snapshot 能力），备份不可用。');
    return;
  }
  busyKey.value = row.key;
  errorMsg.value = '';
  try {
    const snapshotPath = await vault.snapshot('manual-backup');
    const usage = await app.vault!.usage();
    const docCount = app.docs.length;

    if (auth.isLoggedIn) {
      try {
        await profileApi.createBackup({
          vaultId: row.vaultId || row.location,
          name: row.name,
          docCount,
          bytes: usage.bytes,
          ossKey: snapshotPath,
        });
        flashInfo(`已备份「${row.name}」：本机快照 ${snapshotPath}，并已登记到云端备份记录。`);
      } catch (e) {
        if (isPrivacyModeError(e)) {
          flashInfo(`已生成本机快照 ${snapshotPath}（私有化模式，不上传云端备份记录）。`);
        } else {
          flashError(
            `本机快照已生成（${snapshotPath}），但登记云端备份记录失败：${(e as Error).message}`,
          );
        }
      }
    } else {
      flashInfo(`已生成本机快照 ${snapshotPath}。登录后可同时登记到云端备份记录。`);
    }
    await refresh();
  } catch (e) {
    flashError(`备份失败：${(e as Error).message}`);
  } finally {
    busyKey.value = '';
  }
}

/* ------------------------------------------------------------------ */
/* 操作：复制                                                          */
/* ------------------------------------------------------------------ */

/** 递归复制目录（仅桌面端，用原生 bridge.fs） */
async function copyDirectory(from: string, to: string): Promise<number> {
  const fs = bridge?.fs;
  if (!fs) throw new Error('当前环境缺少文件系统桥接');
  await fs.mkdirp(to);
  const entries = await fs.list(from);
  let count = 0;
  for (const entry of entries) {
    // 跳过版本目录：副本不需要带上历史留痕，体积可能非常大
    if (entry.isDirectory && entry.name === 'versions') continue;
    const src = `${from}${from.includes('\\') ? '\\' : '/'}${entry.name}`;
    const dst = `${to}${to.includes('\\') ? '\\' : '/'}${entry.name}`;
    if (entry.isDirectory) {
      count += await copyDirectory(src, dst);
    } else {
      const bin = await fs.readBinary(src);
      await fs.writeBinary(dst, bin);
      count += 1;
    }
  }
  return count;
}

/**
 * 复制仓库。
 *
 * 优先级：
 * 1. **服务端已就绪且仓库有云端档案** → 调 `vaultsApi.copy()`（服务端分配新 vaultId）；
 * 2. **桌面端** → 退化为「本机目录复制」：递归复制到 `<原名>-副本`，再注册为本机新仓库；
 * 3. 其余情况（网页端 / 无 bridge）→ 明确提示不可用。
 */
async function duplicate(row: VaultRow): Promise<void> {
  if (busyKey.value) return;
  busyKey.value = row.key;
  errorMsg.value = '';
  const newName = `${row.name}-副本`;

  // ① 服务端复制（需要已登录 + 有云端档案 + 本机有目录才复制得了内容）
  if (auth.isLoggedIn && row.synced && row.vaultId && isDesktop.value && row.available) {
    try {
      const newVaultId = `${row.vaultId}-copy-${Date.now().toString(36)}`;
      const res = await vaultsApi.copy(row.vaultId, { newVaultId, newName });
      // 云端副本登记进 registry，让用户立刻看到它（available:false，本机尚无目录）
      registry.mergeRemote([
        {
          vaultId: res.vault.vaultId,
          name: res.vault.name || newName,
          docCount: res.vault.docCount,
          bytes: res.vault.bytes,
          status: res.vault.status,
          lastSyncedAt: res.vault.lastSyncedAt ?? null,
          createdAt: res.vault.createdAt ?? null,
        },
      ]);
      syncFromRegistry();
      flashInfo(
        `已在云端创建副本「${newName}」（vaultId=${res.vault.vaultId}）。本机目录仍需单独复制。`,
      );
      await refresh();
      return;
    } catch (e) {
      if (!isPrivacyModeError(e)) {
        // 服务端未就绪 → 继续走本机目录复制，但把原因告知用户
        const msg = (e as Error).message || '';
        if (!/404|not found/i.test(msg)) {
          flashError(`云端复制失败：${msg}。将尝试本机目录复制。`);
        }
      }
    }
  }

  // ② 本机目录复制
  if (!isDesktop.value || !bridge?.fs) {
    flashError(
      isBrowserOnly.value
        ? '网页端无法复制仓库目录（浏览器没有任意目录读写权限）。请在 PC 客户端操作。'
        : '当前环境缺少文件系统桥接，无法复制仓库目录。',
    );
    busyKey.value = '';
    return;
  }
  if (!row.available) {
    flashError(`无法复制「${row.name}」：本机没有对应目录。请先在 PC 端打开该仓库。`);
    busyKey.value = '';
    return;
  }

  try {
    const sep = row.location.includes('\\') ? '\\' : '/';
    const parent = row.location.slice(0, row.location.lastIndexOf(sep));
    let target = `${parent}${sep}${newName}`;
    // 避免重名：已存在时追加序号
    let seq = 2;
    while (await bridge.fs.exists(target)) {
      target = `${parent}${sep}${newName}(${seq})`;
      seq += 1;
    }
    const files = await copyDirectory(row.location, target);
    // 副本作为新仓库登记（占位 vaultId，首次打开时由 .neomd/vault.json 校正）
    const copyName = target.split(/[\\/]/).filter(Boolean).pop() || newName;
    const entry = registry.register({ vaultId: `pending:${target}`, name: copyName, location: target });
    undelete(entry.vaultId, target, copyName);
    syncFromRegistry();
    flashInfo(`已复制仓库到「${target}」（${files} 个文件），可在列表中切换。`);
    await refresh();
  } catch (e) {
    flashError(`复制失败：${(e as Error).message}`);
  } finally {
    busyKey.value = '';
  }
}

/* ------------------------------------------------------------------ */
/* 操作：删除                                                          */
/* ------------------------------------------------------------------ */

const deleteOpen = ref(false);
const deleteRow = ref<VaultRow | null>(null);
const deletePurge = ref(false);

function openDelete(row: VaultRow): void {
  if (row.isCurrent) return;
  deleteRow.value = row;
  deletePurge.value = false;
  deleteOpen.value = true;
}

/**
 * 确认删除。
 *
 * 行为如实描述（界面上也会写清楚）：
 * - 本机：**只从仓库列表移除记录，不删除磁盘上的文件夹**；
 * - 云端：删除仓库档案；勾选「同时清理云端备份」时带 `purge=1`。
 */
async function confirmDelete(): Promise<void> {
  const row = deleteRow.value;
  if (!row) return;
  if (row.isCurrent) {
    flashError('不能删除当前正在使用的仓库，请先切换到其它仓库。');
    deleteOpen.value = false;
    return;
  }
  busyKey.value = row.key;
  try {
    // 本机：从 registry 移除记录（registry.remove 内部拒绝移除当前仓库，这里已提前拦截）
    const removed = registry.remove(row.vaultId);
    syncFromRegistry();
    // 云端：删除仓库档案；勾选「同时清理云端备份」时带 purge=1
    if (row.synced) {
      try {
        await vaultsApi.remove(row.vaultId, deletePurge.value);
      } catch (e) {
        if (!isPrivacyModeError(e)) {
          flashError(`已从本机列表移除，但删除云端档案失败：${(e as Error).message}`);
          deleteOpen.value = false;
          await refresh();
          return;
        }
      }
    }
    // 记入本机删除黑名单：即使云端档案删除失败/延迟，`mergeRemote` 也不会把它加回来
    {
      const set = new Set(deletedSet.value);
      if (row.vaultId) set.add(row.vaultId);
      if (row.location) set.add(row.location);
      if (row.name) set.add(row.name);
      saveDeleted(set);
    }
    deleteOpen.value = false;
    flashInfo(
      !removed
        ? `未能从仓库列表移除「${row.name}」（可能已是当前仓库或记录已不存在）。`
        : deletePurge.value
          ? `已删除「${row.name}」的仓库记录，并清理了云端备份。磁盘上的文件夹未删除。`
          : `已删除「${row.name}」的仓库记录。磁盘文件夹与云端文档内容均未删除。`,
    );
    await refresh();
  } finally {
    busyKey.value = '';
  }
}

/* ------------------------------------------------------------------ */
/* 展示辅助                                                            */
/* ------------------------------------------------------------------ */

function fmtTime(ts: number | string | null): string {
  if (!ts) return '—';
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t) || t <= 0) return '—';
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtSize(bytes: number): string {
  if (!bytes) return '—';
  try {
    return formatBytes(bytes);
  } catch {
    return `${Math.round(bytes / 1024)} KB`;
  }
}

/** 路径中段省略，避免长路径撑破布局（保留盘符与末尾目录名） */
function ellipsisPath(p: string): string {
  if (p.length <= 52) return p;
  const parts = p.split(/[\\/]/);
  if (parts.length <= 2) return `${p.slice(0, 24)}…${p.slice(-24)}`;
  const head = parts[0];
  const tail = parts.slice(-2).join(p.includes('\\') ? '\\' : '/');
  return `${head}…${p.includes('\\') ? '\\' : '/'}${tail}`;
}
</script>

<template>
  <div class="vm" :class="{ 'vm--compact': props.compact }" data-testid="vault-manager">
    <!-- 头部：标题 + 操作 -->
    <div class="vm-head">
      <div class="vm-head__text">
        <h4 class="vm-head__title">
          仓库管理
          <span class="vm-badge">{{ summary.vaults }} 个仓库</span>
        </h4>
        <p class="nm-hint">
          每个仓库是一个独立的本地文件夹（或云端仓库）。当前使用的仓库：
          <strong>{{ currentName }}</strong>
        </p>
      </div>
      <div class="vm-head__actions">
        <button
          type="button"
          class="nm-btn nm-btn--primary nm-btn--sm"
          :title="isDesktop ? '选择电脑文件夹创建新仓库并同步到云端' : '创建新云端仓库'"
          data-testid="vm-create"
          @click="createNewVault"
        >
          <NmIcon name="plus" :size="12" />
          新建仓库
        </button>
        <button
          v-if="!isBrowserOnly"
          type="button"
          class="nm-btn nm-btn--sm"
          :disabled="!canPickDirectory"
          title="选择本机已有文件夹加入仓库列表并同步"
          data-testid="vm-add"
          @click="addVault"
        >
          <NmIcon name="folder" :size="12" />
          关联本地文件夹
        </button>
        <button
          type="button"
          class="nm-btn nm-btn--sm"
          :disabled="loading || !app.canSync()"
          title="将全部仓库立即与云端同步"
          data-testid="vm-sync-all"
          @click="syncAll"
        >
          <NmIcon name="sync" :size="12" />
          全部同步
        </button>
        <button
          type="button"
          class="nm-btn nm-btn--sm"
          :disabled="loading"
          title="重新读取仓库列表与云端档案"
          data-testid="vm-refresh"
          @click="refresh"
        >
          <NmIcon name="refresh" :size="12" />
          {{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </div>

    <!-- 汇总条 -->
    <div class="vm-summary">
      <span class="vm-summary__item"><strong>{{ summary.vaults }}</strong> 仓库</span>
      <span class="vm-summary__sep">·</span>
      <span class="vm-summary__item"><strong>{{ summary.docs }}</strong> 篇文档</span>
      <span class="vm-summary__sep">·</span>
      <span class="vm-summary__item">占用 <strong>{{ fmtSize(summary.bytes) }}</strong></span>
      <span class="vm-summary__grow" />
      <span class="vm-summary__hint">
        {{ auth.isLoggedIn ? '已登录：停用状态与改名会同步到云端档案' : '未登录：仅本机生效' }}
      </span>
    </div>

    <!-- 提示条 -->
    <p v-if="errorMsg" class="vm-notice vm-notice--err" role="alert" data-testid="vm-error">
      <NmIcon name="alert" :size="14" />
      <span>{{ errorMsg }}</span>
    </p>
    <p v-if="infoMsg" class="vm-notice vm-notice--ok" role="status" data-testid="vm-info">
      <NmIcon name="check" :size="14" />
      <span>{{ infoMsg }}</span>
    </p>

    <!-- 仓库列表 -->
    <div v-if="rows.length" class="vm-list" data-testid="vm-list">
      <div
        v-for="row in rows"
        :key="row.key"
        class="vm-row"
        :class="{
          'vm-row--current': row.isCurrent,
          'vm-row--disabled': statusOf(row) === 'disabled',
        }"
        :data-vault="row.name"
        data-testid="vm-row"
      >
        <span class="vm-row__bar" aria-hidden="true" />

        <div class="vm-row__main">
          <div class="vm-row__title">
            <span class="vm-row__dot" :class="{ 'is-on': row.isCurrent }" aria-hidden="true" />
            <span class="vm-row__name" data-testid="vm-row-name">{{ row.name }}</span>
            <span v-if="row.isCurrent" class="vm-tag vm-tag--current" data-testid="vm-current">当前</span>
            <span
              v-if="statusOf(row) === 'disabled'"
              class="vm-tag vm-tag--off"
              data-testid="vm-disabled"
            >已停用</span>
            <span v-else class="vm-tag">已启用</span>
            <span v-if="!row.available" class="vm-tag vm-tag--ghost" title="该仓库只存在于云端档案，本机尚未打开">
              仅云端
            </span>
            <span
              v-if="auth.isLoggedIn"
              class="vm-tag"
              :class="row.synced ? 'vm-tag--synced' : 'vm-tag--ghost'"
              :title="row.synced ? '已登记云端档案' : '尚未登记云端档案'"
            >
              {{ row.synced ? '已同步' : '未同步' }}
            </span>
          </div>

          <div class="vm-row__meta">
            <span class="vm-row__path" :title="row.location">{{ ellipsisPath(row.location) }}</span>
          </div>

          <div class="vm-row__stats">
            <span>{{ row.docCount }} 篇</span>
            <span class="vm-dot">·</span>
            <span>{{ fmtSize(row.bytes) }}</span>
            <template v-if="row.lastSyncedAt">
              <span class="vm-dot">·</span>
              <span>上次同步 {{ fmtTime(row.lastSyncedAt) }}</span>
            </template>
            <template v-else>
              <span class="vm-dot">·</span>
              <span class="vm-muted">从未同步</span>
            </template>
          </div>
        </div>

        <div class="vm-row__ops">
          <button
            type="button"
            class="nm-btn nm-btn--sm"
            :disabled="row.isCurrent || statusOf(row) === 'disabled' || busyKey === row.key"
            :title="
              row.isCurrent
                ? '已经是当前仓库'
                : statusOf(row) === 'disabled'
                  ? '该仓库已停用，请先启用'
                  : `切换到「${row.name}」`
            "
            data-testid="vm-switch"
            @click="switchTo(row)"
          >
            切换
          </button>
          <button
            type="button"
            class="nm-btn nm-btn--sm"
            :disabled="statusOf(row) === 'disabled' || busyKey === row.key || !app.canSync()"
            title="立即将该仓库与云端同步"
            data-testid="vm-sync"
            @click="syncOne(row)"
          >
            {{ busyKey === row.key ? '同步中…' : '同步' }}
          </button>
          <button
            type="button"
            class="nm-btn nm-btn--sm"
            :disabled="busyKey === row.key"
            title="为仓库生成完整快照，登录后可同时登记云端备份"
            data-testid="vm-backup"
            @click="backup(row)"
          >
            备份
          </button>
          <button
            type="button"
            class="nm-btn nm-btn--sm"
            :disabled="busyKey === row.key"
            title="复制该仓库为新仓库（云端优先，桌面端可退化为目录复制）"
            data-testid="vm-copy"
            @click="duplicate(row)"
          >
            复制
          </button>
          <button
            type="button"
            class="nm-btn nm-btn--sm"
            :disabled="busyKey === row.key"
            title="只改显示名，不改磁盘目录名"
            data-testid="vm-rename"
            @click="openRename(row)"
          >
            改名
          </button>
          <button
            type="button"
            class="nm-btn nm-btn--sm"
            :disabled="row.isCurrent || busyKey === row.key"
            :title="
              row.isCurrent
                ? '不能停用当前正在使用的仓库'
                : statusOf(row) === 'disabled'
                  ? '重新启用该仓库（数据保留）'
                  : '停用该仓库，数据保留'
            "
            data-testid="vm-status"
            @click="toggleStatus(row)"
          >
            {{ statusOf(row) === 'disabled' ? '启用' : '停用' }}
          </button>
          <button
            type="button"
            class="nm-btn nm-btn--sm vm-btn--danger"
            :disabled="row.isCurrent || busyKey === row.key"
            :title="row.isCurrent ? '不能删除当前正在使用的仓库，请先切换' : '从仓库列表移除（不删除磁盘文件夹）'"
            data-testid="vm-delete"
            @click="openDelete(row)"
          >
            删除
          </button>
        </div>
      </div>
    </div>

    <!-- 空态 -->
    <div v-else class="vm-empty">
      <NmIcon name="folder" :size="22" />
      <p>还没有可管理的仓库。</p>
      <p class="nm-hint">
        {{ isBrowserOnly ? '网页端会自动使用云端仓库；登录后可从云端档案看到其它设备上的仓库。' : '点击右上角「添加仓库」选择一个本机文件夹开始。' }}
      </p>
    </div>

    <!-- 改名对话框 -->
    <div v-if="renameOpen" class="vm-mask" @mousedown.self="renameOpen = false">
      <div class="vm-dialog" role="dialog" aria-modal="true" aria-label="仓库改名">
        <h4 class="vm-dialog__title">仓库改名</h4>
        <p class="nm-hint">只修改显示名称，不会改变磁盘上的文件夹名。</p>
        <input
          v-model="renameValue"
          class="nm-input"
          maxlength="40"
          placeholder="输入新的仓库名称"
          aria-label="新的仓库名称"
          data-testid="vm-rename-input"
          @keydown.enter="confirmRename"
        />
        <p v-if="renameError" class="vm-field-error">{{ renameError }}</p>
        <div class="vm-dialog__foot">
          <button type="button" class="nm-btn nm-btn--sm" @click="renameOpen = false">取消</button>
          <button
            type="button"
            class="nm-btn nm-btn--primary nm-btn--sm"
            data-testid="vm-rename-confirm"
            @click="confirmRename"
          >
            确定
          </button>
        </div>
      </div>
    </div>

    <!-- 删除二次确认 -->
    <div v-if="deleteOpen" class="vm-mask" @mousedown.self="deleteOpen = false">
      <div class="vm-dialog" role="dialog" aria-modal="true" aria-label="删除仓库确认" data-testid="vm-delete-dialog">
        <h4 class="vm-dialog__title">删除仓库「{{ deleteRow?.name }}」？</h4>
        <p class="vm-dialog__body">
          此操作<strong>只移除仓库列表中的记录</strong>，<strong>不会删除磁盘上的文件夹</strong>，
          也不会删除已同步到云端的文档内容。之后仍可通过「添加仓库」重新选回该目录。
        </p>
        <label v-if="deleteRow?.synced" class="vm-check">
          <input v-model="deletePurge" type="checkbox" />
          <span>同时清理云端备份记录与历史版本（文档内容仍保留）</span>
        </label>
        <div class="vm-dialog__foot">
          <button type="button" class="nm-btn nm-btn--sm" @click="deleteOpen = false">取消</button>
          <button
            type="button"
            class="nm-btn nm-btn--danger nm-btn--sm"
            data-testid="vm-delete-confirm"
            @click="confirmDelete"
          >
            确认删除
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vm {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.vm--compact {
  gap: 10px;
}

/* 头部 */
.vm-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.vm-head__title {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.vm-head__text .nm-hint {
  margin: 0;
}
.vm-head__actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  flex-wrap: wrap;
}
.vm-badge {
  font-size: 11px;
  font-weight: 500;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--bg-elevated, #f1f2f4);
  color: var(--fg-3, #8a8f99);
  border: 1px solid var(--border, rgba(15, 23, 42, 0.1));
}

/* 汇总条 */
.vm-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 7px 12px;
  border-radius: 8px;
  border: 1px solid var(--border, rgba(15, 23, 42, 0.1));
  background: var(--bg-elevated, #fff);
  font-size: 12px;
  color: var(--fg-2, #4b5563);
}
.vm-summary__item strong {
  color: var(--fg, #1a1d21);
  font-weight: 650;
}
.vm-summary__sep {
  color: var(--fg-3, #8a8f99);
}
.vm-summary__grow {
  flex: 1 1 auto;
}
.vm-summary__hint {
  font-size: 11.5px;
  color: var(--fg-3, #8a8f99);
}

/* 提示 */
.vm-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  padding: 9px 12px;
  border-radius: 8px;
  font-size: 12.5px;
  line-height: 1.6;
  word-break: break-word;
}
.vm-notice--err {
  background: rgba(217, 48, 37, 0.08);
  color: #d93025;
}
.vm-notice--ok {
  background: rgba(22, 163, 74, 0.1);
  color: #16a34a;
}

/* 列表 */
.vm-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.vm-row {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 11px 13px 11px 15px;
  border-radius: 10px;
  border: 1px solid var(--border, rgba(15, 23, 42, 0.1));
  background: var(--bg-elevated, #fff);
  min-width: 0;
  flex-wrap: wrap;
  transition: border-color 0.14s ease, box-shadow 0.14s ease;
}
.vm-row:hover {
  border-color: var(--border-strong, rgba(15, 23, 42, 0.18));
}
.vm-row--current {
  border-color: var(--accent, #1677ff);
  box-shadow: 0 0 0 2px var(--accent-weak, rgba(22, 119, 255, 0.13));
}
.vm-row--disabled {
  opacity: 0.72;
}
/* 当前仓库左侧色条 */
.vm-row__bar {
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: transparent;
}
.vm-row--current .vm-row__bar {
  background: var(--accent, #1677ff);
}

.vm-row__main {
  flex: 1 1 260px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.vm-row__title {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  min-width: 0;
}
.vm-row__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1.5px solid var(--fg-3, #8a8f99);
  background: transparent;
  flex: 0 0 auto;
}
.vm-row__dot.is-on {
  border-color: var(--accent, #1677ff);
  background: var(--accent, #1677ff);
}
.vm-row__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg, #1a1d21);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.vm-row__meta {
  min-width: 0;
}
.vm-row__path {
  font-family: var(--font-mono, Consolas, monospace);
  font-size: 11px;
  color: var(--fg-3, #8a8f99);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
  max-width: 100%;
}
.vm-row__stats {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: var(--fg-2, #4b5563);
}
.vm-dot {
  color: var(--fg-3, #8a8f99);
}
.vm-muted {
  color: var(--fg-3, #8a8f99);
}

/* 标签 */
.vm-tag {
  font-size: 10.5px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--bg-elevated, #f1f2f4);
  color: var(--fg-3, #8a8f99);
  border: 1px solid var(--border, rgba(15, 23, 42, 0.1));
  white-space: nowrap;
  flex: 0 0 auto;
}
.vm-tag--current {
  background: color-mix(in srgb, var(--accent, #1677ff) 14%, transparent);
  color: var(--accent, #1677ff);
  border-color: color-mix(in srgb, var(--accent, #1677ff) 38%, transparent);
  font-weight: 650;
}
.vm-tag--off {
  background: rgba(217, 48, 37, 0.1);
  color: #d93025;
  border-color: rgba(217, 48, 37, 0.28);
}
.vm-tag--synced {
  background: rgba(22, 163, 74, 0.1);
  color: #16a34a;
  border-color: rgba(22, 163, 74, 0.28);
}
.vm-tag--ghost {
  opacity: 0.85;
}

/* 操作按钮组 */
.vm-row__ops {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  flex: 0 0 auto;
}
.vm-row__ops .nm-btn {
  height: 26px;
  padding: 0 10px;
  font-size: 12px;
}
.vm-btn--danger {
  color: #d93025;
  border-color: rgba(217, 48, 37, 0.3);
}
.vm-btn--danger:hover:not([disabled]) {
  background: rgba(217, 48, 37, 0.08);
}
.nm-btn[disabled] {
  opacity: 0.42;
  cursor: not-allowed;
}

/* 空态 */
.vm-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 28px 16px;
  border: 1px dashed var(--border, rgba(15, 23, 42, 0.14));
  border-radius: 10px;
  color: var(--fg-3, #8a8f99);
  text-align: center;
}
.vm-empty p {
  margin: 0;
  font-size: 12.5px;
}

/* 对话框 */
.vm-mask {
  position: fixed;
  inset: 0;
  z-index: 8600;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(15, 23, 42, 0.42);
  backdrop-filter: blur(4px);
}
.vm-dialog {
  width: min(440px, 100%);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px 20px 16px;
  border-radius: 12px;
  border: 1px solid var(--border, rgba(15, 23, 42, 0.1));
  background: var(--bg-elevated, #fff);
  box-shadow: var(--shadow-3, 0 16px 40px rgba(0, 0, 0, 0.28));
}
.vm-dialog__title {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  color: var(--fg, #1a1d21);
  word-break: break-word;
}
.vm-dialog__body {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--fg-2, #4b5563);
}
.vm-dialog__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.vm-field-error {
  margin: 0;
  font-size: 11.5px;
  color: #d93025;
}
.vm-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--fg-2, #4b5563);
  cursor: pointer;
}
.vm-check input {
  margin-top: 3px;
  accent-color: var(--accent, #1677ff);
  flex: 0 0 auto;
}

/* 窄屏：操作按钮整行换行，避免横向溢出 */
@media (max-width: 900px) {
  .vm-head {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }
  .vm-head__actions {
    justify-content: flex-start;
  }
  .vm-row {
    flex-direction: column;
    align-items: stretch;
  }
  .vm-row__ops {
    width: 100%;
  }
  .vm-row__ops .nm-btn {
    flex: 1 1 auto;
    min-width: 56px;
  }
  .vm-summary__hint {
    width: 100%;
  }
}
</style>
