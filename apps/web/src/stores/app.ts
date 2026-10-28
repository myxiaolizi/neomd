import { defineStore } from 'pinia';
import { computed, ref, shallowRef, triggerRef, watch } from 'vue';
import type { DocMeta, EditorMode, PageWidth, SyncLogEntry, SyncConflict, VersionRecord } from '@neomd/shared';
import { buildDatetimeName, toNameSummary, uid, titleFromPath, sanitizeTitle } from '@neomd/shared';
import {
  Vault,
  BrowserVaultAdapter,
  NativeVaultAdapter,
  getBridge,
  detectRuntime,
  SearchEngine,
  AIClient,
  S3StorageClient,
  RemoteProxyStorageClient,
  SyncEngine,
  generateTitle,
  sha256Hex,
  sharedVaultRegistry,
  type ProxyTransport,
  type SearchHit,
} from '@neomd/core';
import { useSettingsStore } from './settings';
import { useAuthStore } from './auth';
import { creditsApi, vaultsApi, ApiError, getAccessToken, resolveApiUrl, refreshAccessToken } from '@/api/client';

/**
 * 仓库清单的读取与写入统一委托给 `VaultRegistry`（1.1.5）。
 *
 * 历史上这里自带一份极简实现（只存 `{name, location, lastOpenedAt}` 到
 * `neomd.vaultList.v1`）。1.1.5 引入仓库管理功能后，清单需要承载
 * `vaultId / status / 统计信息 / 云端合并` 等能力，因此改由注册表统一负责，
 * 但仍**沿用同一个 storage key**，老数据可无损升级（详见 registry.ts 的 load()）。
 *
 * 这里保留 `loadVaults`/`saveVaults` 两个函数名，是为了不改动既有调用点；
 * 它们现在是注册表的薄封装。
 */
function loadVaults(): VaultEntry[] {
  return sharedVaultRegistry()
    .listSorted()
    .map((e) => ({
      name: e.name,
      location: e.location,
      lastOpenedAt: e.lastOpenedAt,
      vaultId: e.vaultId,
      available: e.available !== false,
      status: e.status,
      lastSyncedAt: e.lastSyncedAt,
      docCount: e.docCount,
      bytes: e.bytes,
    }));
}

function saveVaults(list: VaultEntry[]): void {
  // 已由注册表持久化，这里仅用于「把外部传入的顺序/内容回写」的边缘场景。
  // 正常流程（openVault）直接调 registry.register()，不再经过本函数。
  void list;
}

export interface Tab {
  id: string;
  docId: string;
  title: string;
  path: string;
  dirty: boolean;
  locked?: boolean;
  mode: EditorMode;
  pageWidth: PageWidth;
  scrollTop: number;
  cursor: number;
  content: string;
  /**
   * 用户是否**手动改过**这个标签的标题（1.1.8）。
   *
   * 置位后 `applyAutoTitle()` 不再按正文内容自动命名 ——
   * 否则「新建文档 → 写正文 → 改标题行」时，首次自动保存的 AI 命名会把
   * 用户刚输入的名字覆盖回旧名。显式意图优先于自动推断。
   */
  titleManuallyEdited?: boolean;
  /**
   * 正文是否已从磁盘/IndexedDB 载入（1.1.9 启动极速化）。
   *
   * `restoreTabs()` 会先把上次的标签恢复成「壳」（`contentLoaded: false`，`content` 为空），
   * 再在后台并发读正文回填。编辑器可据此渲染轻量占位，
   * 避免用户看到一篇空白正文并误以为文件坏了。
   * 新建/正常打开的标签一律为 `true`。
   */
  contentLoaded?: boolean;
}

export type DocSortKey = 'updated-desc' | 'updated-asc' | 'created-desc' | 'created-asc' | 'title-asc' | 'title-desc';

/**
 * 供 UI 列表使用的仓库精简条目。
 *
 * 1.1.8 起补齐 `vaultId` 与 `available`：仓库注册表（`packages/core/src/vault/registry.ts`）
 * 才是仓库数据的权威来源，本类型只是喂给列表渲染的投影。
 * 之前缺这两个字段，导致 `syncAllVaults()` 里按 vaultId 去重、
 * 以及过滤「本机可用」仓库的逻辑无字段可用（TS2339）。
 */
export interface VaultEntry {
  name: string;
  location: string;
  lastOpenedAt: number;
  /** 仓库唯一 id（来自注册表），用于跨端对齐与去重 */
  vaultId?: string;
  /** 本机是否可用；云端有但本机没下载过的为 false */
  available?: boolean;
  /** 仓库状态 */
  status?: 'active' | 'disabled';
  /** 上次同步时间（毫秒） */
  lastSyncedAt?: number;
  /** 文档数 */
  docCount?: number;
  /** 占用字节数 */
  bytes?: number;
}

const MODE_ORDER: EditorMode[] = ['wysiwyg', 'source', 'compare', 'read'];
const VAULTS_STORAGE_KEY = 'neomd.vaultList.v1';

/**
 * 同步行为偏好（1.1.8）。
 *
 * 必须定义在**模块顶层**：它出现在 `useAppStore` 的返回值里，
 * 而 `useAppStore` 是导出的，TypeScript 生成声明时要求该名字可被公开引用，
 * 否则报 TS4025（has or is using private name）。
 * 也不能写在 `defineStore(...)` 的 setup 函数体内加 `export`（函数内不允许 export，TS1184）。
 */
export interface SyncBehavior {
  direction: 'both' | 'upload' | 'download';
  conflictPolicy: 'newest' | 'local' | 'remote';
  /** 自动同步间隔（毫秒），0 表示关闭 */
  autoIntervalMs: number;
}

export const useAppStore = defineStore('app', () => {
  const settingsStore = useSettingsStore();

  /**
   * 仓库注册表单例（提前到 store 顶部声明，1.1.9）。
   *
   * 原来它声明在 store 末尾（「仓库管理（1.1.5）」小节），但
   * `openVault()` / `resolveAuthoritativeVaultId()` 这些靠前的函数也要用它。
   * `const` 有暂时性死区：一旦有调用路径在 store setup 完成前触发这些函数，
   * 就会抛 `Cannot access 'vaultRegistry' before initialization`，
   * 而这类异常又常被 fire-and-forget 吞掉，表现为「什么都没发生」。
   * 提到顶部后，任何时序都不会踩到。
   */
  const vaultRegistry = sharedVaultRegistry();

  const vault = shallowRef<Vault | null>(null);
  const vaultReady = ref(false);
  const vaultName = ref('');
  const vaultLocation = ref('');
  const vaults = ref<VaultEntry[]>(loadVaults());
  const docs = ref<DocMeta[]>([]);
  const sortBy = ref<DocSortKey>((localStorage.getItem('neomd.sortBy') as DocSortKey) || 'updated-desc');
  const folderOrder = ref<string[]>([]);
  const customFolders = ref<string[]>([]);
  const tabs = ref<Tab[]>([]);
  const activeTabId = ref<string>('');
  const searchEngine = shallowRef<SearchEngine>(new SearchEngine());
  /**
   * 全文搜索索引是否已建好（1.1.8）。
   *
   * 启动时建索引领跑在后台，未完成前搜索会退化为「只搜文件名」，
   * 界面可据此提示「索引构建中」，避免用户以为搜索坏了。
   */
  const searchReady = ref(false);

  const statusText = ref('');
  const busy = ref(false);
  const toast = ref<{ id: string; type: 'info' | 'success' | 'error'; message: string } | null>(null);
  const credits = ref<number | null>(null);

  const syncLogs = ref<SyncLogEntry[]>([]);
  const syncConflicts = ref<SyncConflict[]>([]);
  const syncState = ref<'idle' | 'syncing' | 'error' | 'offline'>('idle');
  const lastSyncAt = ref<number>(0);

  /** 应用内输入框（替代 window.prompt，Electron 不支持 prompt） */
  const inputDialog = ref<{
    open: boolean;
    title: string;
    label: string;
    value: string;
    placeholder: string;
    resolve: ((v: string | null) => void) | null;
  }>({ open: false, title: '', label: '', value: '', placeholder: '', resolve: null });

  function askInput(title: string, label = '', placeholder = '', initial = ''): Promise<string | null> {
    return new Promise((resolve) => {
      inputDialog.value = { open: true, title, label, value: initial, placeholder, resolve };
    });
  }

  function submitInput(value: string | null): void {
    const fn = inputDialog.value.resolve;
    inputDialog.value = { ...inputDialog.value, open: false, resolve: null };
    fn?.(value);
  }

  const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value) ?? null);
  const activeMode = computed<EditorMode>(() => activeTab.value?.mode ?? 'wysiwyg');
  const activePageWidth = computed<PageWidth>(
    () => activeTab.value?.pageWidth ?? settingsStore.settings.appearance.pageWidth,
  );
  const isDirty = computed(() => tabs.value.some((t) => t.dirty));

  function notify(message: string, type: 'info' | 'success' | 'error' = 'info', ms = 2600): void {
    const id = uid('toast');
    toast.value = { id, type, message };
    setTimeout(() => {
      if (toast.value?.id === id) toast.value = null;
    }, ms);
  }

  /**
   * 关键路径的「后台执行 + 记日志」（1.1.9）。
   *
   * 为什么需要它（本轮两次事故的共同教训）：
   *   本项目有大量 `void someAsync()` 形式的 fire-and-forget 调用（打开仓库后自动同步、
   *   保存后推送、登录后首拉……）。语义上我们不关心它们的结果，但**不关心结果 != 不要错误**：
   *   一旦里面有 `ReferenceError`（未定义符号）或网络异常，Promise 会静默 reject，
   *   既没有 toast、也没有日志，表现就是「点了按钮什么都没发生」——
   *   本轮 `markFirstSyncDone is not defined` 之所以能活到线上，就是因为被这种方式吞掉了。
   *
   * 设计取舍：
   *  - **只用在关键路径**（同步 / 保存 / 打开仓库 / 首拉），不做全局强制，
   *    否则会产生大量噪音，而 `.catch(() => {})` 这种空实现反而更糟 —— 它把错误彻底埋掉；
   *  - 出错时 `console.error` 打上 `[neomd]` 前缀和标签，便于用户反馈时从控制台自查；
   *  - **不弹 toast**：后台任务的失败不应打断写作，但必须留下可追溯的痕迹。
   *
   * @param promise 后台任务
   * @param label 出问题时用于定位的标签（如 `sync:auto`、`vault:firstSync`）
   */
  function fireAndLog(promise: Promise<unknown> | undefined, label: string): void {
    if (!promise) return;
    promise.catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[neomd] ${label} 后台任务失败：`, msg, e);
      syncLogs.value = [
        {
          id: `bg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          at: Date.now(),
          level: 'warn' as const,
          message: `后台任务失败（${label}）：${msg}`,
        },
        ...syncLogs.value,
      ].slice(0, 200);
    });
  }

  function setSort(field: string): void {
    const map: Record<string, DocSortKey> = {
      updated: 'updated-desc',
      'updated-desc': 'updated-desc',
      'updated-asc': 'updated-asc',
      created: 'created-desc',
      'created-desc': 'created-desc',
      'created-asc': 'created-asc',
      title: 'title-asc',
      path: 'title-asc',
      'title-asc': 'title-asc',
      'title-desc': 'title-desc',
    };
    const next = map[field];
    if (next) {
      sortBy.value = next;
      try {
        localStorage.setItem('neomd.sortBy', next);
      } catch {
        /* ignore */
      }
      void refreshDocs();
    }
  }

  function folderOrderKey(): string {
    return `neomd.folderOrder:${vaultLocation.value || 'default'}`;
  }

  function customFoldersKey(): string {
    return `neomd.customFolders:${vaultLocation.value || 'default'}`;
  }

  function loadVaultMeta(): void {
    try {
      const fo = localStorage.getItem(folderOrderKey());
      folderOrder.value = fo ? (JSON.parse(fo) as string[]) : [];
    } catch {
      folderOrder.value = [];
    }
    try {
      const cf = localStorage.getItem(customFoldersKey());
      customFolders.value = cf ? (JSON.parse(cf) as string[]) : [];
    } catch {
      customFolders.value = [];
    }
  }

  function setFolderOrder(order: string[]): void {
    folderOrder.value = [...order];
    try {
      localStorage.setItem(folderOrderKey(), JSON.stringify(folderOrder.value));
    } catch {
      /* ignore */
    }
  }

  function createFolder(folderPath: string): void {
    const clean = folderPath.trim().replace(/^\/+|\/+$/g, '');
    if (!clean) return;
    if (!customFolders.value.includes(clean)) {
      customFolders.value = [...customFolders.value, clean];
      try {
        localStorage.setItem(customFoldersKey(), JSON.stringify(customFolders.value));
      } catch {
        /* ignore */
      }
    }
    if (!folderOrder.value.includes(clean)) {
      setFolderOrder([...folderOrder.value, clean]);
    }
    notify(`已创建文件夹「${clean}」`, 'success');
  }

  async function moveDocToFolder(docId: string, targetFolder: string): Promise<void> {
    if (!vault.value) return;
    const meta = vault.value.get(docId);
    if (!meta) return;
    const fileName = meta.path.split('/').pop() ?? `${meta.title}.md`;
    const cleanFolder = targetFolder.trim().replace(/^\/+|\/+$/g, '');
    const nextPath = cleanFolder ? `${cleanFolder}/${fileName}` : fileName;
    if (nextPath === meta.path) return;
    await renameDoc(docId, nextPath);
  }

  async function switchVault(location: string, displayName?: string): Promise<void> {
    if (isDirty.value) {
      await saveActiveTab();
    }
    tabs.value = [];
    activeTabId.value = '';
    await openVault(location, displayName);
    if (docs.value.length) {
      const first = docs.value[0];
      if (first) await openDoc(first.docId);
    }
  }

  /**
   * 新建仓库（1.1.8：PC 端**必须选择真实文件夹**）。
   *
   * 用户原话：「在PC端新建仓库是要选择对应文件夹，PC的正文数据都是存在电脑文件夹中的，
   * 同时通过S3或账号同步到云端和其他平台」。因此桌面端不再自动拼 `文档/Neo MD/<名字>`，
   * 而是**强制**弹目录选择器，让用户明确指定落盘位置。
   *
   * 为什么不用「自动拼默认路径」：用户有多块盘、多个同步目录时，
   * 自动拼出来的路径往往会和用户既有的资料夹结构冲突，事后还要手工搬。
   * 显式选择虽然多一步，但不会被搞乱。
   *
   * @param name 仓库显示名
   * @param pickedLocation 已选定的目录（桌面端由调用方先弹选择器后传入，避免二次弹窗）
   * @returns 是否成功创建
   */
  async function createAndSwitchVault(name: string, pickedLocation?: string): Promise<boolean> {
    const clean = sanitizeTitle(name.trim()) || '新仓库';
    const runtime = detectRuntime();
    const bridge = getBridge();
    let loc = `vault:${clean}`;

    if (runtime.platform === 'desktop') {
      // 桌面端：必须拿到真实文件夹
      let dir = pickedLocation?.trim() ?? '';
      if (!dir) {
        const pick = bridge?.dialog?.pickDirectory;
        if (!pick) {
          notify('当前环境不支持选择文件夹，无法创建本地仓库', 'error', 4600);
          return false;
        }
        try {
          dir = (await pick()) ?? '';
        } catch (e) {
          notify(`选择文件夹失败：${(e as Error).message}`, 'error', 4600);
          return false;
        }
      }
      if (!dir) {
        // 用户取消 → 中止创建（不能静默退回逻辑仓库，那会让正文数据落不到磁盘）
        notify('已取消：创建本地仓库必须选择一个文件夹', 'info', 3600);
        return false;
      }
      loc = dir;
    } else if (canSync()) {
      // 网页/移动端：登录后走云端仓库（数据经平台存储同步）
      loc = `cloud:${clean}`;
    }

    await switchVault(loc, clean);
    notify(`已创建仓库「${clean}」${runtime.platform === 'desktop' ? '（本地文件夹）' : ''}`, 'success');

    /*
     * 建完立即登记到云端，使其它端能发现这个仓库（需求 C）。
     * 失败不阻塞——本地仓库已经可用，只是暂时在其它端看不到。
     */
    if (canSync()) {
      const auth = useAuthStore();
      if (auth.isLoggedIn) {
        fireAndLog(pullVaultList().then(() => pushVaultEntry()), 'vault:create→pull+publish');
      }
    }
    return true;
  }

  /* ---------------- 仓库 ---------------- */

  async function pickAndOpenLocalVault(): Promise<void> {
    const runtime = detectRuntime();
    const bridge = getBridge();
    if (runtime.platform === 'desktop' && bridge?.dialog) {
      const picked = await bridge.dialog.pickDirectory();
      if (!picked) return;
      const folderName = picked.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '本地仓库';
      await switchVault(picked, folderName);
      notify(`已打开本地文件夹仓库「${folderName}」`, 'success');
      return;
    }
    const name = await askInput('关联本地仓库', '输入仓库名称', '例如：本地笔记', '');
    if (name && name.trim()) {
      await createAndSwitchVault(name.trim());
    }
  }

  /**
   * 桌面端默认本地仓库根目录。
   *
   * 产品约定：PC 端**所有**仓库都必须落到真实本地文件夹（明文 .md），
   * 而不是停留在 IndexedDB 之类的逻辑仓库里。因此桌面端首次启动时
   * 会向主进程要一个默认目录（`文档/Neo MD`），并在用户自定义根目录后优先用它。
   */
  async function desktopDefaultVaultDir(): Promise<string> {
    const runtime = detectRuntime();
    const bridge = getBridge();
    if (runtime.platform !== 'desktop' || !bridge?.paths) return '';
    const custom = settingsStore.settings.localVault?.root?.trim();
    if (custom) return custom;
    try {
      return await bridge.paths.vaultDefault();
    } catch {
      return '';
    }
  }

  /**
   * 把任意仓库位置规整为「桌面端必有本地路径」。
   *
   * - 已是绝对路径（Windows `C:\...` / POSIX `/...`）→ 原样使用；
   * - `cloud:xxx` / `vault:xxx` / 相对名 → 映射到 `<本地根>/<名字>`，
   *   让云端仓库在 PC 上同样有一份明文文件夹，而不是只活在浏览器里。
   */
  async function resolveDesktopVaultLocation(location: string, displayName?: string): Promise<string> {
    const runtime = detectRuntime();
    if (runtime.platform !== 'desktop') return location;
    const isAbsolute = /^[A-Za-z]:[\\/]/.test(location) || location.startsWith('/') || location.startsWith('\\\\');
    if (isAbsolute) return location;

    const base = await desktopDefaultVaultDir();
    if (!base) return location;
    // 若 location 是 cloud:<vaultId>，优先用注册表里的显示名或传入的 displayName 作为文件夹名
    const regHit = sharedVaultRegistry().findByLocation(location) ?? sharedVaultRegistry().get(location.replace(/^cloud:/, ''));
    const rawName =
      displayName?.trim() ||
      regHit?.name?.trim() ||
      (location.includes(':') ? location.slice(location.indexOf(':') + 1) : location);
    const safe = (sanitizeTitle(rawName) || 'Neo MD').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'Neo MD';
    const sep = base.includes('\\') ? '\\' : '/';
    const baseClean = base.replace(/[\\/]+$/, '');
    const baseTail = baseClean.split(/[\\/]/).pop() ?? '';
    // 若默认根目录本身已经叫这个名字（例如 base 是 "...\Documents\Neo MD" 且 safe 也是 "Neo MD"），直接使用 base，避免套娃 "...\Neo MD\Neo MD"
    const joined = baseTail.toLowerCase() === safe.toLowerCase() ? baseClean : `${baseClean}${sep}${safe}`;
    // 归一到全应用统一的 Windows 盘符路径表示
    return joined.replace(/\//g, '\\');
  }

  /**
   * 网页端与登录用户的默认仓库位置（1.1.9 增强）。
   *
   * 优先顺序：
   *  1. 本机注册表里已有的当前可用仓库（避免每次刷新都强行切回 `cloud:<username>` 伪仓库）；
   *  2. 本机注册表里第一个非伪仓库的可用云端仓库；
   *  3. 已登录时退回 `cloud:<username>`（首次启动后再由 `runFirstSyncIfNeeded` 自动替换为云端真实仓库）。
   */
  function cloudVaultLocation(): string {
    const registry = sharedVaultRegistry();
    const cur = registry.current();
    if (cur && cur.status === 'active' && cur.location) {
      return cur.location;
    }
    const firstActive = registry.listSorted().find((e) => e.status === 'active' && e.location);
    if (firstActive) {
      return firstActive.location;
    }
    const auth = useAuthStore();
    const cfg = settingsStore.settings.storage;
    if (auth.isLoggedIn && auth.user) {
      return `cloud:${auth.user.username}`;
    }
    if (cfg.bucket) return `cloud:${cfg.bucket}`;
    return 'Neo MD';
  }

  /**
   * 打开云端仓库前，先问服务端「这个仓库的权威 id 是什么」（1.1.9）。
   *
   * 为什么必须这样做（这是「PC 端与 Web 端两套仓库」的第二个根因）：
   * 网页端启动时只知道 `cloud:<username>`（如 `cloud:admin`），服务端登记的
   * 却是真实的 `vaultId`（如 `admin`，或 PC 端生成的 `vaultmvs96...`）。
   * 1.1.8 的做法是让 `Vault.open()` 自己 `uid('vault')` 生成一个随机 id，
   * 于是网页端同步前缀变成 `users/admin/vaults/vaultmvs96.../`，
   * 与 PC 端的 `users/admin/vaults/admin/` 完全不同 —— **两端永远看不到彼此的文档**。
   *
   * 现在改为：打开前拉一次 `/api/vaults`，按「位置里的 id → 仓库名 → 唯一仓库」的顺序
   * 找到服务端已登记的 vaultId，并把它作为权威 id 传下去（`forceVaultId`）。
   * 只有服务端确实为空（首次登录、还没建过仓库）时才允许本地新建 id。
   *
   * @returns 权威 vaultId（找不到时返回空串，调用方按「本地新建」处理）
   */
  async function resolveAuthoritativeVaultId(location: string, displayName?: string): Promise<string> {
    const auth = useAuthStore();
    if (!auth.isLoggedIn || !auth.user) return '';
    const isCloudLike =
      location.startsWith('cloud:') ||
      location.startsWith('vault:') ||
      // 桌面端把 cloud:xxx 映射成了本地绝对路径，此时只能靠显示名匹配
      !/^[A-Za-z]:[\\/]|^\//.test(location);
    if (!isCloudLike) return '';

    const locationTarget = location.startsWith('cloud:')
      ? location.slice('cloud:'.length).trim()
      : location.startsWith('vault:')
        ? location.slice('vault:'.length).trim()
        : '';
    const nameTarget = (displayName?.trim() || locationTarget).toLowerCase();

    let remote: Array<{ vaultId: string; name: string }> = [];
    try {
      const res = await vaultsApi.list();
      remote = res.vaults ?? [];
      // 合并进注册表，让「云端有、本机没打开过」的仓库也能在列表里出现
      vaultRegistry.mergeRemote(remote);
      const remoteIds = new Set(remote.map((v) => v.vaultId).filter(Boolean));
      if (remoteIds.size > 0) {
        const username = auth.user.username.trim().toLowerCase();
        vaultRegistry.prunePseudoCloudVaults(remoteIds, username ? [username] : []);
      }
      refreshVaultList();
    } catch {
      // 拉取失败不阻塞打开：退回本机注册表已知的 id，实在没有才让 Vault 自己新建
    }

    // ① 位置里直接写的就是服务端 id（`cloud:admin` / `cloud:vaultxxx`）
    const byId = remote.find((v) => v.vaultId === locationTarget);
    if (byId) return byId.vaultId;
    // ② 按显示名匹配（PC 端 `cloud:郑磊` 映射到本地目录时走这条）
    if (nameTarget) {
      const byName = remote.find((v) => (v.name ?? '').trim().toLowerCase() === nameTarget);
      if (byName) return byName.vaultId;
    }
    // ③ 本机注册表里已有该位置的权威 id（通常是上一次 pullVaultList 的结果）
    const regHit = vaultRegistry.findByLocation(location);
    if (regHit && !regHit.vaultId.startsWith('pending:')) return regHit.vaultId;
    // ④ 服务端只有唯一一个仓库，且我们打开的是「按用户名生成的伪仓库」→ 就是它
    //    （典型场景：首次登录 admin，云端只有 vaultId=admin，本地位置是 cloud:admin）
    const isPseudoLocation = Boolean(
      locationTarget &&
        (locationTarget.toLowerCase() === auth.user.username.toLowerCase() ||
          locationTarget.toLowerCase() === 'my'),
    );
    if (remote.length === 1 && isPseudoLocation && remote[0]) return remote[0].vaultId;

    /*
     * ⑤ 四级全部落空：云端确实没有任何仓库，且打开的是「按用户名生成的入口」
     *    （`cloud:<username>` / `cloud:my`）。
     *
     * **这里绝不能返回空串**：返回空串会让 `Vault.open()` 落到 `uid('vault')`，
     * 网页端就凭空得到一个随机 vaultId（如 `vaultmvs96oocjltn7zwu`），
     * 而服务端只有 `admin`，两端前缀从此对不上 —— 这正是线上故障的形态。
     *
     * 正确做法：用**稳定的用户名**作为首个仓库的 vaultId：
     *  - 稳定：同一账号在任何端首次进入都得到同一个 id，天然对齐；
     *  - 可读：排查时一眼看出「这是谁的默认仓库」；
     *  - 服务端会在首同步时由 `pushVaultEntry()` 幂等登记 `(user_id, 'admin')`。
     */
    if (!remote.length && isPseudoLocation && /^[A-Za-z0-9_-]{4,64}$/.test(locationTarget)) {
      return locationTarget.toLowerCase();
    }
    return '';
  }

  async function openVault(location: string, displayName?: string, expectedVaultId?: string): Promise<void> {
    const runtime = detectRuntime();
    const bridge = getBridge();
    let adapter;
    if (runtime.platform === 'desktop' && bridge) adapter = new NativeVaultAdapter(bridge, 'desktop-fs');
    else if (runtime.platform === 'android' && bridge) adapter = new NativeVaultAdapter(bridge, 'android-fs');
    else adapter = new BrowserVaultAdapter();

    const registry = sharedVaultRegistry();
    // 查找注册表里是否已有对应条目，提取其已知的真实 vaultId 与显示名
    const regByLoc = registry.findByLocation(location);
    const idFromCloudLoc =
      location.startsWith('cloud:') && /^vault[a-z0-9_-]{4,60}$/i.test(location.slice(6).trim())
        ? location.slice(6).trim()
        : '';
    const regById =
      expectedVaultId
        ? registry.get(expectedVaultId)
        : idFromCloudLoc
          ? registry.get(idFromCloudLoc)
          : null;
    const knownEntry = regById ?? regByLoc;
    const resolvedDisplayName =
      displayName?.trim() ||
      knownEntry?.name?.trim() ||
      (location.startsWith('cloud:') ? location.slice(6) : location.startsWith('vault:') ? location.slice(6) : '');
    /*
     * 服务端权威 id 优先于本机一切推断（详见 resolveAuthoritativeVaultId 的说明）。
     * `serverVaultId` 非空时说明服务端确实登记过这个仓库，此时必须强制采用它，
     * 即使本地磁盘 `.neomd/vault.json` 里还留着上一次随机生成的 id。
     */
    const serverVaultId = await resolveAuthoritativeVaultId(location, resolvedDisplayName);
    const resolvedExpectedId =
      serverVaultId ||
      expectedVaultId ||
      (knownEntry && !knownEntry.vaultId.startsWith('pending:') ? knownEntry.vaultId : '') ||
      idFromCloudLoc;

    const v = new Vault(adapter);
    // 本地版本留痕策略：默认只在云端保留历史，本地永远只存最新版本的明文 .md
    v.keepLocalVersions = Boolean(settingsStore.settings.localVault?.keepVersions);
    // 桌面端：任何逻辑仓库都要落到真实本地文件夹
    const effectiveLocation = await resolveDesktopVaultLocation(location, resolvedDisplayName);
    busy.value = true;
    try {
      /*
       * 1.1.8 启动极速化：`open()` 不再等磁盘对账。
       * 1.1.9 传入 expectedVaultId / expectedName，保证跨端打开云端仓库时 vaultId 100% 一致；
       * `forceVaultId` 仅在上面的服务端查询拿到权威 id 时置位 —— 此时本地旧 id 必须让位。
       */
      await v.open(effectiveLocation, {
        deferReconcile: true,
        expectedVaultId: resolvedExpectedId || undefined,
        expectedName: resolvedDisplayName || undefined,
        forceVaultId: Boolean(serverVaultId),
      });
      vault.value = v;
      const cleanName =
        resolvedDisplayName ||
        (location.startsWith('cloud:') ? location.slice(6) : location.startsWith('vault:') ? location.slice(6) : v.name) ||
        'Neo MD';
      vaultName.value = cleanName;
      vaultLocation.value = v.location;
      vaultReady.value = true;
      loadVaultMeta();
      await refreshDocs();
      /*
       * 搜索索引异步化（1.1.8）。
       */
      searchReady.value = false;
      rebuildSearchIndex()
        .catch(() => undefined)
        .finally(() => {
          searchReady.value = true;
        });
      /*
       * 后台对账完成后增量刷新文件列表。
       */
      void v.reconcileDeferred
        ?.then(async () => {
          if (vault.value !== v) return;
          await refreshDocs();
          registry.updateStats(v.vaultId, {
            docCount: docs.value.length,
            bytes: docs.value.reduce((sum, d) => sum + (d.size ?? 0), 0),
          });
          vaults.value = loadVaults();
          void rebuildSearchIndex().catch(() => undefined);
        })
        .catch(() => undefined);
      localStorage.setItem('neomd.lastVault', effectiveLocation);
      /**
       * 注册到仓库注册表（1.1.5 / 1.1.9）。
       *
       * 若桌面端把原先 `cloud:<vaultId>` 映射成了本地绝对路径 `effectiveLocation`，
       * 先更新已有同 vaultId 条目的 location，避免产生两条记录。
       */
      const existingById = registry.get(v.vaultId);
      if (existingById && existingById.location !== effectiveLocation) {
        existingById.location = effectiveLocation;
        existingById.available = true;
      }
      registry.register({
        vaultId: v.vaultId,
        name: cleanName,
        location: effectiveLocation,
      });
      registry.attachVaultId(effectiveLocation, v.vaultId, cleanName);
      registry.setCurrent(v.vaultId);
      registry.updateStats(v.vaultId, {
        docCount: docs.value.length,
        bytes: docs.value.reduce((sum, d) => sum + (d.size ?? 0), 0),
      });
      // 用注册表的权威顺序刷新 store 里的列表，保证 UI 与持久化一致
      vaults.value = loadVaults();
      /*
       * 打开仓库后立即自动注册并同步（1.1.9）：
       * 先调 pushVaultEntry() 确保仓库在服务端 user_vaults 表中已登记，再执行同步。
       */
      if (canSync()) {
        const auth = useAuthStore();
        if (auth.isLoggedIn) {
          // 关键路径：用 fireAndLog 兜错，避免「登记/首拉内部抛错 → 界面什么都没发生」
          fireAndLog(
            pushVaultEntry(false).then(() => runFirstSyncIfNeeded()),
            'vault:open→firstSync',
          );
        } else {
          fireAndLog(syncNow({ silent: true }), 'sync:open');
        }
      }
    } catch (e) {
      notify(`打开仓库失败：${(e as Error).message}`, 'error', 4200);
      throw e;
    } finally {
      busy.value = false;
    }
  }

  async function refreshDocs(): Promise<void> {
    if (!vault.value) return;
    const list = vault.value.list();
    const sorted = [...list];
    switch (sortBy.value) {
      case 'title-asc':
        sorted.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
        break;
      case 'title-desc':
        sorted.sort((a, b) => b.title.localeCompare(a.title, 'zh'));
        break;
      case 'created-desc':
        sorted.sort((a, b) => (b.createdAt ?? b.updatedAt) - (a.createdAt ?? a.updatedAt));
        break;
      case 'created-asc':
        sorted.sort((a, b) => (a.createdAt ?? a.updatedAt) - (b.createdAt ?? b.updatedAt));
        break;
      case 'updated-asc':
        sorted.sort((a, b) => a.updatedAt - b.updatedAt);
        break;
      case 'updated-desc':
      default:
        sorted.sort((a, b) => b.updatedAt - a.updatedAt);
        break;
    }
    docs.value = sorted;
    syncTabsWithVault();
  }

  function syncTabsWithVault(): void {
    if (!vault.value) return;
    for (const tab of tabs.value) {
      const meta = vault.value.get(tab.docId);
      if (!meta) continue;
      if (meta.path !== tab.path) {
        tab.path = meta.path;
        tab.title = meta.title;
      }
    }
  }

  async function rebuildSearchIndex(): Promise<void> {
    if (!vault.value) return;
    const engine = new SearchEngine();
    const v = vault.value;
    for (const meta of v.list()) {
      try {
        const body = await v.read(meta.docId);
        engine.add({ id: meta.docId, path: meta.path, title: meta.title, body, tags: '' });
      } catch {
        /* 单文件失败不影响整体 */
      }
    }
    searchEngine.value = engine;
    triggerRef(searchEngine);
  }

  async function indexDoc(meta: DocMeta, content: string): Promise<void> {
    searchEngine.value.add({ id: meta.docId, path: meta.path, title: meta.title, body: content, tags: '' });
    triggerRef(searchEngine);
  }

  function search(query: string, opts: { limit?: number } = {}): SearchHit[] {
    const hits = searchEngine.value.search(query, { limit: opts.limit ?? 40 });
    return hits.map((h) => {
      const meta = vault.value?.get(h.docId);
      return { ...h, path: meta?.path ?? h.path, title: meta?.title ?? h.title };
    });
  }

  /* ---------------- 标签页 ---------------- */

  async function openDoc(docId: string, options: { mode?: EditorMode } = {}): Promise<void> {
    if (!vault.value) return;
    const existing = tabs.value.find((t) => t.docId === docId);
    if (existing) {
      activeTabId.value = existing.id;
      if (options.mode) existing.mode = options.mode;
      // 1.1.7：重复打开同一篇也要刷新「最近打开」排序（见下方 touchRecent 说明）
      touchRecent(docId);
      return;
    }
    const meta = vault.value.get(docId);
    if (!meta) return;
    const content = await vault.value.read(docId);
    const tab: Tab = {
      id: uid('tab'),
      docId,
      title: meta.title,
      path: meta.path,
      dirty: false,
      mode: options.mode ?? 'wysiwyg',
      pageWidth: settingsStore.settings.appearance.pageWidth,
      scrollTop: 0,
      cursor: 0,
      content,
      // 正常打开路径一定已读到正文；壳路径由 restoreTabs 显式置 false
      contentLoaded: true,
    };
    tabs.value.push(tab);
    activeTabId.value = tab.id;
    // 1.1.7：打开即计入「最近打开」
    touchRecent(docId);
    persistTabs();
  }

  /**
   * 「最近打开」时间戳表（docId → 最后打开时间）。
   *
   * 为什么需要单独维护：`LeftPanel` 的「最近打开」是 `[...docs].sort((a,b) => b.updatedAt - a.updatedAt)`，
   * 即**按「内容修改时间」排序**。但用户报障「打开 郑磊 仓库里 笔记本 目录的文件，
   * 不会出现在最近打开列表」—— 因为**打开文件并不会修改内容**，`updatedAt` 不变，
   * 该文档自然排不进前 N 名（尤其在文档很多的老仓库里，它可能排到几十名开外）。
   *
   * 修复方式：用一份独立的「打开时间」映射覆盖排序依据，不改动 `DocMeta.updatedAt`
   * （那是内容版本语义，被同步与历史版本依赖，绝不能因「打开」而被污染）。
   *
   * 持久化到 localStorage：跨会话保留，符合用户对「最近打开」的直觉。
   */
  const RECENT_KEY = 'neomd.recentOpened.v1';

  function loadRecent(): Record<string, number> {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, number>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  const recentOpenedAt = ref<Record<string, number>>(loadRecent());

  /** 记录一次「打开」，并裁剪到最近 500 条防止无限增长 */
  function touchRecent(docId: string): void {
    if (!docId) return;
    const next = { ...recentOpenedAt.value, [docId]: Date.now() };
    // 超出上限时丢弃最旧的，避免 localStorage 膨胀
    const entries = Object.entries(next);
    if (entries.length > 500) {
      entries.sort((a, b) => b[1] - a[1]);
      recentOpenedAt.value = Object.fromEntries(entries.slice(0, 500));
    } else {
      recentOpenedAt.value = next;
    }
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recentOpenedAt.value));
    } catch {
      /* 存储已满或被禁用时忽略 */
    }
  }

  /**
   * 供 UI 使用的「展示层文档列表」：把 `updatedAt` 与「最近打开时间」取较大值。
   *
   * 为什么需要这层投影（1.1.7「最近打开」修复的核心）：
   * `LeftPanel` 的「最近打开」是 `[...docs].sort((a,b) => b.updatedAt - a.updatedAt)`，
   * 即按**内容修改时间**排序。但「打开文件」不会修改内容，`updatedAt` 不变，
   * 于是用户「打开 郑磊 仓库里 笔记本 目录的文件」后该文件根本进不了最近列表
   * （在老仓库里可能排到几十名开外）。这就是用户报障的现象。
   *
   * 关键取舍：
   *  - **不改 `vault` 内部的 `DocMeta.updatedAt`**：那是内容版本语义，
   *    被 `SyncEngine` 的 manifest 合并比较、`rev` 递增与历史版本依赖，
   *    绝不能因为「只是打开看一眼」而被污染（否则会造成假冲突与错误覆盖）。
   *  - 只在**这层展示投影**里提升时间，`app.docs` 本身保持纯净。
   *  - `LeftPanel` 不允许改（他人写作用域），因此通过 EditorPage 传这份投影给它。
   *
   * 产品语义说明：「最近打开」与「最近修改」合并为同一条时间轴，符合
   * Obsidian 等同类产品的用户直觉（打开即置顶）。
   */
  const docsForPanel = computed<DocMeta[]>(() => {
    const map = recentOpenedAt.value;
    if (!map || Object.keys(map).length === 0) return docs.value;
    return docs.value.map((d) => {
      const touched = map[d.docId];
      return touched && touched > d.updatedAt ? { ...d, updatedAt: touched } : d;
    });
  });

  /**
   * 本次会话内新建、尚未做过 AI 命名的文档。
   * 新建时不再弹窗问文件名：先按模板自动命名并直接进入编辑，
   * 首次手动保存时再让 AI 按正文内容改成更贴切的标题。
   */
  const freshlyCreated = new Set<string>();

  async function createDoc(input: { title?: string; folder?: string; content?: string; path?: string } = {}): Promise<void> {
    if (!vault.value) {
      notify('请先打开一个仓库', 'error');
      return;
    }
    const naming = settingsStore.settings.naming;
    let name = (input.title ?? '').trim();
    if (!name && !input.path) {
      // 免弹窗：按模板直接落一个名字。
      // 1.0.2 默认模板 `YYMMDD日HHMM-{input}`，input 为空 → 得到 `261026日2130-`。
      // 内容缩写留到首次保存时由 AI 补齐（见 applyAutoTitle）。
      name = buildDatetimeName('', naming).replace(/\.md$/i, '');
    }
    const initialContent = input.content ?? '';
    const meta = await vault.value.create({
      // 传了 path 就以它为准确路径。这是 `.flow` / `.mind` 这类非 Markdown 文档
      // 能落成纯扩展名的关键：Vault.create 在没有显式 path 时会无条件补 `.md`，
      // 于是 title 传 `x.flow` 会得到 `x.flow.md`，编辑器分流判定就失效了。
      ...(input.path ? { path: input.path } : { folder: input.folder }),
      title: sanitizeTitle(name) || sanitizeTitle((input.path ?? '').replace(/\.(flow|mind)$/i, '')) || '未命名',
      content: initialContent,
    });
    freshlyCreated.add(meta.docId);
    await refreshDocs();
    await openDoc(meta.docId);
    await indexDoc(meta, initialContent);
    notify('已新建文档，直接开始写作', 'info', 1600);
  }

  function updateTabContent(tabId: string, content: string): void {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (!tab) return;
    tab.content = content;
    tab.dirty = true;
  }

  const lastVersionedMap = new Map<string, { at: number; len: number }>();

  function currentDeviceName(): string {
    const rt = detectRuntime();
    if (rt.platform === 'web') return 'web';
    const custom = settingsStore.settings.sync.deviceName?.trim();
    if (custom) return custom;
    return rt.platform === 'desktop' ? 'Windows-PC' : 'Android';
  }

  /**
   * 新建文档首次保存时按正文内容自动命名。
   * 自动保存默认开启，往往在用户按下 Ctrl+S 之前就已落盘（dirty 变为 false），
   * 因此这里不能只在「有未保存改动」的分支里处理，否则首次命名永远不会触发。
   *
   * ⚠️ 与「手动改标题行」的竞态（1.1.8 修复）：
   * 用户新建文档 → 先写正文 → 再改标题行时，首次自动保存会触发这里的 AI 命名，
   * 把用户刚手动输入的名字**覆盖回旧名**。
   * 因此这里必须先检查 `titleManuallyEdited`：一旦用户手动改过名，
   * 就再也不自动命名 —— 用户的显式意图永远优先于自动推断。
   */
  function applyAutoTitle(tab: Tab): void {
    if (tab.titleManuallyEdited) return;
    const isFirstSave = freshlyCreated.delete(tab.docId);
    const naming = settingsStore.settings.naming;
    // 1.1.9：严格尊重用户选择的命名模式 —— 只有选了 'ai-after-save' 才触发 AI 自动改名
    if (naming.mode !== 'ai-after-save') return;
    const enoughContent = tab.content.trim().length >= (isFirstSave ? 20 : 40);
    if (!settingsStore.aiConfigured || !enoughContent) return;
    // 新建文档首次保存：静默按内容改名（不弹窗打断写作）；之后的 AI 命名沿用确认设置
    void autoTitle(tab, { silent: isFirstSave });
  }

  async function saveActiveTab(options: { auto?: boolean } = {}): Promise<void> {
    const tab = activeTab.value;
    if (!tab || !vault.value) return;
    if (!tab.dirty) {
      // 内容已由自动保存落盘，手动保存不再重复写盘，但仍要补一次首次 AI 命名
      if (!options.auto) applyAutoTitle(tab);
      return;
    }
    let shouldVersion = true;
    if (options.auto) {
      const asCfg = settingsStore.settings.autosave ?? { enabled: true, versionMinutes: 5, versionChars: 300 };
      const prev = lastVersionedMap.get(tab.docId) ?? { at: Date.now(), len: tab.content.length };
      const elapsedMin = (Date.now() - prev.at) / 60000;
      const deltaChars = Math.abs(tab.content.length - prev.len);
      const byTime = asCfg.versionMinutes > 0 && elapsedMin >= asCfg.versionMinutes;
      const byChars = asCfg.versionChars > 0 && deltaChars >= asCfg.versionChars;
      shouldVersion = byTime || byChars;
    }
    const devName = currentDeviceName();
    // 本地留痕策略关闭时（PC 端默认），先在保存前把「旧内容」取出来，保存后异步推到云端
    // versions/<docId>/，保证历史版本不丢，同时本地磁盘只保留最新版本。
    //
    // 1.1.7 修复：这里原先判断 `storageConfigured`（只认自配 S3），未配 S3 的登录用户
    // 拿不到 prevContent → 下面的 archiveVersionToCloud 永不触发 → **完全没有历史版本**。
    // 与「同步不触发」是同一个根因，必须一起改用 canSync()。
    const keepLocal = Boolean(settingsStore.settings.localVault?.keepVersions);
    let prevContent = '';
    if (shouldVersion && !keepLocal && canSync()) {
      try {
        prevContent = await vault.value.read(tab.docId);
      } catch {
        prevContent = '';
      }
    }
    const saved = await vault.value.save(tab.docId, tab.content, 'save', shouldVersion, devName);
    if (shouldVersion) {
      lastVersionedMap.set(tab.docId, { at: Date.now(), len: tab.content.length });
      if (prevContent && prevContent !== tab.content) {
        void archiveVersionToCloud(tab.docId, Math.max(1, saved.rev - 1), prevContent);
      }
    }
    tab.dirty = false;
    tab.title = saved.title;
    await refreshDocs();
    await indexDoc(saved, tab.content);

    if (!options.auto) applyAutoTitle(tab);
    // 保存后自动与云端版本实时同步（无论是本地关联文件夹仓库还是云端仓库）
    // 1.1.7：同样改用 canSync()，让未自配 S3 的登录用户也能把改动推上平台存储
    if (canSync()) {
      fireAndLog(syncNow({ silent: Boolean(options.auto) }), 'sync:afterSave');
    }
  }

  async function autoTitle(tab: Tab, opts: { silent?: boolean } = {}): Promise<void> {
    const aiCfg = settingsStore.settings.ai;
    const client = new AIClient({
      ...aiCfg,
      usePlatform: Boolean(aiCfg.usePlatform || aiCfg.provider === 'platform'),
      apiKey: aiCfg.usePlatform || aiCfg.provider === 'platform' ? 'platform' : aiCfg.apiKey,
    });
    try {
      busy.value = true;
      const naming = settingsStore.settings.naming;
      const summaryRaw = await generateTitle(client, tab.content, naming.aiPrompt);
      // 1.0.2：把 AI 结果裁成 4-10 字缩写，拼回「YYMMDD日HHMM-」模板。
      // AI 不可用或缩写太短时 summary 为空 → 文件名保持纯时间戳，不会塞半截词。
      const summary = toNameSummary(summaryRaw);
      if (!summary) return;
      let title = buildDatetimeName(summary, naming).replace(/\.md$/i, '');
      if (!title) return;
      if (naming.confirmBeforeRename && !opts.silent) {
        const agree = await askInput('AI 建议文件名', `是否重命名为「${title}」？（清空则不重命名）`, '', title);
        if (agree === null || !agree.trim()) return;
        title = agree.trim();
      }
      const currentName = (tab.path.split('/').pop() ?? '').replace(/\.md$/i, '');
      if (sanitizeTitle(title) === currentName) return;
      const folder = tab.path.includes('/') ? tab.path.slice(0, tab.path.lastIndexOf('/')) : '';
      await vault.value?.rename(tab.docId, folder ? `${folder}/${title}.md` : `${title}.md`);
      await refreshDocs();
      syncTabsWithVault();
      persistTabs();
      notify(`已按内容自动命名「${title}」`, 'success', 2400);
    } catch (e) {
      // AI 命名失败属于非致命：文件名保持新建时的时间戳名，不打断写作。
      // 私有化模式下同理（AI 通道不可用）。
      if (opts.silent) return;
      notify(`AI 命名失败：${(e as Error).message}`, 'error');
    } finally {
      busy.value = false;
    }
  }

  async function renameDoc(docId: string, nextPath: string): Promise<void> {
    if (!vault.value) return;
    try {
      const { rewritten } = await vault.value.rename(docId, nextPath);
      /**
       * 标记「用户手动改过标题」（1.1.8 竞态修复）。
       *
       * 必须在这里置位：之后 `applyAutoTitle()` 会跳过 AI 自动命名，
       * 否则新建文档「先写正文、再改标题」时，首次自动保存会把名字覆盖回去。
       * 所有引用该文档的标签都要置位（同一文档可能开着多个标签）。
       */
      for (const t of tabs.value) {
        if (t.docId === docId) t.titleManuallyEdited = true;
      }
      await refreshDocs();
      syncTabsWithVault();
      notify(rewritten ? `已重命名，并更新 ${rewritten} 篇文档的引用` : '已重命名', 'success');
    } catch (e) {
      notify(`重命名失败：${(e as Error).message}`, 'error');
    }
  }

  async function deleteDoc(docId: string): Promise<void> {
    if (!vault.value) return;
    await vault.value.remove(docId, { deleteFile: true });
    tabs.value = tabs.value.filter((t) => t.docId !== docId);
    if (!tabs.value.find((t) => t.id === activeTabId.value)) activeTabId.value = tabs.value[0]?.id ?? '';
    await refreshDocs();
    notify('已删除', 'success');
  }

  /**
   * 关闭标签页。
   *
   * 1.1.7 需求：「文件修改即保存，不要询问用户是否保存」。
   * 因此这里**不再弹「有未保存的更改，仍然关闭？」**——而是先尽力把改动落盘，
   * 再关闭。用户不会因为一个对话框丢掉内容，也永远不会被对话框打断。
   *
   * `force` 保留：某些内部路径（如切换仓库、重置标签）需要在**不触发保存**的情况下
   * 直接丢弃，那里仍会传 `force = true`。
   */
  function closeTab(tabId: string, force = false): boolean {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (!tab) return true;
    if (tab.dirty && !force) {
      // 先保存再关：`saveActiveTab` 内部会判断当前活动标签并落盘。
      // 若待关的正是活动标签，它会被保存；即使保存失败也只记录日志，不再弹窗阻断。
      void saveActiveTab({ auto: true }).catch((e) => {
        // 保存失败不应阻止关闭，但要留下可诊断信息
        console.warn('[closeTab] 关闭前保存失败：', (e as Error)?.message ?? e);
      });
    }
    const idx = tabs.value.findIndex((t) => t.id === tabId);
    tabs.value = tabs.value.filter((t) => t.id !== tabId);
    if (activeTabId.value === tabId) {
      const next = tabs.value[Math.min(idx, tabs.value.length - 1)];
      activeTabId.value = next?.id ?? '';
    }
    persistTabs();
    return true;
  }

  function cycleMode(): void {
    const tab = activeTab.value;
    if (!tab) return;
    const idx = MODE_ORDER.indexOf(tab.mode);
    tab.mode = MODE_ORDER[(idx + 1) % MODE_ORDER.length]!;
  }

  function setMode(mode: EditorMode): void {
    if (activeTab.value) activeTab.value.mode = mode;
  }

  /**
   * 页宽统一写入设置项（唯一数据源），并同步到已打开标签页，
   * 这样工具栏下拉、命令面板、设置面板三处改动都会立即对正文生效。
   */
  function setPageWidth(width: PageWidth): void {
    settingsStore.updateAppearance({ pageWidth: width });
    for (const tab of tabs.value) tab.pageWidth = width;
    persistTabs();
  }

  /* ---------------- 正文缩放（1.0.2） ---------------- */

  /** 缩放范围与步长：Ctrl+滚轮每格 5% */
  const ZOOM_MIN = 50;
  const ZOOM_MAX = 300;
  const ZOOM_STEP = 5;

  /** 当前缩放百分比（来自设置为唯一数据源） */
  const zoom = computed<number>(() => clampZoom(settingsStore.settings.appearance.zoom ?? 100));

  function clampZoom(v: number): number {
    if (!Number.isFinite(v)) return 100;
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(v)));
  }

  /** 设置缩放百分比（会写回设置，随 appearance 分区同步） */
  function setZoom(next: number): void {
    const value = clampZoom(next);
    if (value === zoom.value) return;
    settingsStore.updateAppearance({ zoom: value });
  }

  /** Ctrl+滚轮缩放：deltaY < 0 放大，> 0 缩小，每次 5% */
  function zoomBy(deltaSteps: number): void {
    setZoom(zoom.value + deltaSteps * ZOOM_STEP);
  }

  function zoomIn(): void {
    zoomBy(1);
  }

  function zoomOut(): void {
    zoomBy(-1);
  }

  function resetZoom(): void {
    setZoom(100);
  }

  /**
   * 标签持久化开关（1.1.9）。
   *
   * 为什么需要：桌面端「移动至新窗口」会用 `?doc=<id>&fresh=1` 打开一个**只含一篇文档**的新窗口。
   * 若该窗口退出时把「当前标签集合」照常写回 localStorage，就会把原窗口的标签列表冲掉，
   * 用户回到原窗口发现标签全没了 —— 「移动一次，全丢一次」。
   * 因此 `fresh` 模式下本进程**完全不写**标签持久化，新窗口退出即丢，原窗口不受影响。
   */
  let tabsPersistenceEnabled = true;

  function persistTabs(): void {
    if (!tabsPersistenceEnabled) return;
    try {
      const data = tabs.value.map((t) => ({ docId: t.docId, mode: t.mode, pageWidth: t.pageWidth }));
      localStorage.setItem('neomd.tabs', JSON.stringify({ tabs: data, active: activeTabId.value }));
    } catch {
      /* ignore */
    }
  }

  /**
   * 恢复标签页（1.1.9：启动极速化）。
   *
   * 旧实现是 `for (item of saved) await openDoc(item.docId)` —— **串行读每一篇正文**。
   * 上次开 10 个标签就要串行 10 次磁盘/IPC 读，全部读完 EditorPage 才敢挂载界面，
   * 这是「打开速度要像 Obsidian」这条需求的最大阻塞点。
   *
   * 新策略：
   *  - `eagerDocId` 指定「只需要立刻可编辑的那一篇」，函数**只等它**就返回；
   *  - 其余标签先建「壳」（docId / title / path / mode / pageWidth 全部来自索引与持久化），
   *    `content` 留空且 `contentLoaded=false`，正文本函数内部 `void` 异步补齐后回填；
   *  - `fresh: true` 时完全跳过旧标签，只开 `eagerDocId`，并且本进程不写标签持久化。
   *
   * 数据安全（底线）：异步补齐正文回填前必须确认该标签**没有被用户编辑过**。
   * 否则会出现「壳已显示 → 用户点进去开始打字 → 后台正文回来把刚打的字覆盖掉」。
   * 此时宁可放弃这次回填（保留用户内容），也绝不覆盖。
   */
  async function restoreTabs(opts: { eagerDocId?: string; fresh?: boolean } = {}): Promise<void> {
    tabsPersistenceEnabled = opts.fresh !== true;
    const eagerId = opts.eagerDocId?.trim() ?? '';

    if (opts.fresh) {
      // 新窗口：只开指定这一篇，不恢复旧标签、不写持久化
      if (eagerId) await openDoc(eagerId);
      return;
    }

    let saved: Array<{ docId: string; mode?: EditorMode; pageWidth?: PageWidth }> = [];
    try {
      const raw = localStorage.getItem('neomd.tabs');
      if (raw) {
        const data = JSON.parse(raw) as {
          tabs: Array<{ docId: string; mode?: EditorMode; pageWidth?: PageWidth }>;
        };
        saved = Array.isArray(data.tabs) ? data.tabs : [];
      }
    } catch {
      saved = [];
    }

    // 先把所有标签建成壳：纯内存操作 + 读索引（`vault.get`），不碰磁盘正文
    const shells: Tab[] = [];
    for (const item of saved) {
      if (!item?.docId) continue;
      if (eagerId && item.docId === eagerId) continue; // 这一篇下面用 openDoc 真正打开
      const meta = vault.value?.get(item.docId);
      if (!meta) continue; // 文档已被删除/改名 → 不复活幽灵标签
      shells.push({
        id: uid('tab'),
        docId: item.docId,
        // 标题优先用索引里的真实 title（`meta.title` 来自正文解析或文件名），
        // 不用持久化的旧标题 —— 壳阶段与补齐阶段显示不一致会闪一下
        title: meta.title,
        path: meta.path,
        dirty: false,
        mode: item.mode ?? 'wysiwyg',
        pageWidth: item.pageWidth ?? settingsStore.settings.appearance.pageWidth,
        scrollTop: 0,
        cursor: 0,
        content: '',
        contentLoaded: false,
      });
    }

    // eager：这一篇必须立即可编辑（其余壳先挂在后面，保持用户原来的顺序感）
    if (eagerId && vault.value?.get(eagerId)) {
      await openDoc(eagerId);
    }
    if (shells.length) tabs.value.push(...shells);
    if (!activeTabId.value) {
      const lastShell = shells[shells.length - 1];
      if (lastShell) activeTabId.value = lastShell.id;
    }

    if (!shells.length) return;

    /*
     * 后台补齐正文（并发出，不阻塞启动）。
     *
     * 这里刻意用 `void` 起一个独立任务而不是 await：EditorPage 的 `booting`
     * 只等到 eager 那篇就绪，壳的正文在后台陆续填充，用户几乎不会察觉。
     */
    void (async () => {
      for (const shell of shells) {
        const current = tabs.value.find((t) => t.id === shell.id);
        if (!current) continue; // 用户已关掉这个标签
        try {
          const markdown = await vault.value?.read(current.docId);
          // 回填前重新取一次：用户可能在这段时间里已经编辑/关闭了它
          const latest = tabs.value.find((t) => t.id === shell.id);
          if (!latest) continue;
          if (latest.dirty || latest.content) {
            /*
             * 用户已经动过这个标签（打字了，或别的路径已经填过内容）。
             * 放弃回填并标记为「已加载」，避免把用户输入覆盖掉。
             * 代价是这一次可能显示的不是云端最新版，但用户输入绝不能丢。
             */
            latest.contentLoaded = true;
            continue;
          }
          latest.content = markdown ?? '';
          latest.contentLoaded = true;
          // 标题以**索引里的真实 title** 为准（正文首行可能是空行/frontmatter，不可靠）；
          // 用户手动改过标题时一律不动。
          const meta = vault.value?.get(latest.docId);
          if (meta?.title && !latest.titleManuallyEdited) latest.title = meta.title;
        } catch {
          // 单篇读取失败：保留空壳并标记已加载，避免 UI 永远显示「加载中」
          const latest = tabs.value.find((t) => t.id === shell.id);
          if (latest) latest.contentLoaded = true;
        }
      }
    })();
  }

  /* ---------------- 积分 ---------------- */

  async function loadCredits(): Promise<void> {
    const auth = useAuthStore();
    if (!auth.isLoggedIn) {
      credits.value = null;
      return;
    }
    try {
      const res = await creditsApi.balance();
      credits.value = res.balance;
    } catch {
      credits.value = null;
    }
  }

  /* ---------------- 同步 ---------------- */

  /**
   * 同步方向与冲突策略（1.1.8 新增，本地持久化）。
   *
   * 为什么存在 localStorage 而不是 settings 云同步：
   * 这两个是「本机行为偏好」——同一账号在不同设备上可能有不同意图
   * （例如办公机双向同步、临时机只下载）。放进云同步会让所有端被一台机器的选择绑住。
   */
  const SYNC_OPTS_KEY = 'neomd.syncOptions.v1';

  /**
   * 同步行为偏好：见模块顶层的 `SyncBehavior` 定义（此处只做局部引用）。
   */
  function loadSyncBehavior(): SyncBehavior {
    const fallback: SyncBehavior = { direction: 'both', conflictPolicy: 'newest', autoIntervalMs: 0 };
    try {
      const raw = localStorage.getItem(SYNC_OPTS_KEY);
      if (!raw) {
        /*
         * 本机从未写过同步偏好（新装/清缓存）：**继承云端设置里的间隔**，而不是硬性关掉。
         *
         * 为什么必须继承：`settings.sync.autoSyncIntervalMs` 的默认值是 120000，
         * 如果这里固定回落到 0（关闭），就会出现「云端设置写着每 2 分钟自动同步、
         * 实际却从不同步」的分裂 —— 用户在设置页看到的和程序在做的不一致，
         * 排查时会误以为是定时器坏了。
         *
         * 注意只在「key 完全不存在」时继承：用户若显式点过「关闭」，
         * localStorage 里会有一条 `autoIntervalMs: 0`，那种情况必须尊重用户选择。
         */
        const fromSettings = settingsStore.settings.sync?.autoSyncIntervalMs;
        return {
          ...fallback,
          autoIntervalMs: typeof fromSettings === 'number' && fromSettings > 0 ? fromSettings : 0,
        };
      }
      const p = JSON.parse(raw) as Partial<SyncBehavior>;
      return {
        direction:
          p.direction === 'upload' || p.direction === 'download' ? p.direction : 'both',
        conflictPolicy:
          p.conflictPolicy === 'local' || p.conflictPolicy === 'remote' ? p.conflictPolicy : 'newest',
        autoIntervalMs:
          typeof p.autoIntervalMs === 'number' && p.autoIntervalMs >= 0 ? p.autoIntervalMs : 0,
      };
    } catch {
      return fallback;
    }
  }

  const syncBehavior = ref<SyncBehavior>(loadSyncBehavior());
  const syncDirection = computed(() => syncBehavior.value.direction);
  const syncConflictPolicy = computed(() => syncBehavior.value.conflictPolicy);
  const autoSyncIntervalMs = computed(() => syncBehavior.value.autoIntervalMs);

  /** 更新同步行为（写盘 + 重建自动同步定时器） */
  function updateSyncBehavior(patch: Partial<SyncBehavior>): void {
    syncBehavior.value = { ...syncBehavior.value, ...patch };
    try {
      localStorage.setItem(SYNC_OPTS_KEY, JSON.stringify(syncBehavior.value));
    } catch {
      /* 忽略 */
    }
    installAutoSyncTimer();
  }

  /** 自动同步定时器句柄 */
  let autoSyncTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 安装/重建自动同步定时器。
   * 间隔为 0 时清除定时器（关闭自动同步）。
   */
  function installAutoSyncTimer(): void {
    if (autoSyncTimer) {
      clearInterval(autoSyncTimer);
      autoSyncTimer = null;
    }
    const ms = syncBehavior.value.autoIntervalMs;
    if (!ms || ms < 30_000) return; // 低于 30 秒的间隔没有意义，也容易打爆服务端
    autoSyncTimer = setInterval(() => {
      if (canSync() && syncState.value !== 'syncing') fireAndLog(syncNow({ silent: true }), 'sync:autoTimer');
    }, ms);
  }

  /** 当前环境是否具备同步能力。
   *
   * 三档回落（与 buildSyncEngine 完全对应）：
   *  1. 用户自配了 `bucket + AK + SK` → 直连自己的对象存储；
   *  2. 未自配但**已登录** → 走服务端平台存储代理（`RemoteProxyStorageClient`）；
   *  3. 都无 → 不可同步。
   *
   * **为什么单独抽这个函数**：1.1.7 之前代码里散落着 `settingsStore.storageConfigured`
   * 判断（只认档位 1），把档位 2 完全挡住了，表现为「没配 S3 的用户同步按钮点了没反应」。
   * 现在所有「要不要同步」的判断都必须走这里，避免再次漏掉档位 2。
   */
  function canSync(): boolean {
    if (settingsStore.storageConfigured) return true;
    const auth = useAuthStore();
    return Boolean(auth.isLoggedIn && auth.user);
  }

  /**
   * 平台存储代理的传输层实现。
   *
   * 为什么在这里实现而不是放进 `@neomd/core`：
   * `core` 是 Web / 桌面 / 移动共用包，不应反向依赖 `apps/web` 的 `api()`；
   * 因此由 store 注入「发请求」与「拼 URL」两个能力，core 只保留纯逻辑。
   *
   * 其中 `fetch` 的实现刻意**不复用 `api()`**：
   * `api()` 会 `res.json()` 解析包体，而同步需要读原始字节（正文 .md 与 JSON 索引）；
   * 但 401 刷新、私有化拦截这两件事仍要对齐，因此这里手动复刻了同样的行为。
   */
  const proxyTransport: ProxyTransport = {
    async fetch(path, init) {
      // 私有化模式：仓库同步依赖服务端，直接拒绝（与 api() 入口同一语义）
      if (settingsStore.privacyMode) {
        throw new Error('已开启数据私有化模式，无法使用平台存储同步');
      }
      const send = (): Promise<Response> => {
        const token = getAccessToken();
        const headers: Record<string, string> = { ...(init.headers ?? {}) };
        if (token) headers.authorization = `Bearer ${token}`;
        return fetch(resolveApiUrl(path), {
          method: init.method,
          headers,
          // GET/HEAD 不能带 body，否则浏览器直接抛 TypeError
          body: init.method === 'GET' || init.method === 'HEAD' ? undefined : (init.body ?? undefined),
        });
      };

      let res = await send();
      /*
       * 令牌过期：刷新后重试一次。
       *
       * 1.1.9 改为复用 `client.ts` 的 `refreshAccessToken()`，不再自己抄一份：
       * 原实现有两个致命缺陷 ——
       *  ① 没有并发去重：一轮同步几十个请求同时 401 会并发刷新几十次，
       *     而服务端每次刷新都吊销旧 refresh token，除第一个外全部失败；
       *  ② 不知道别的窗口刚刷过令牌，多窗口/「移动至新窗口」必然被踢出登录。
       * 现在与 `api()` 共享同一份刷新 Promise 与跨窗口协调逻辑。
       */
      if (res.status === 401) {
        if (await refreshAccessToken()) res = await send();
      }
      return res;
    },
    resolveUrl(path) {
      return resolveApiUrl(path);
    },
  };

  /**
   * 构建同步引擎。
   *
   * **三档回落策略**（这是 1.1.1「PC 与 Web 不同步」问题的根因修复）：
   *   1. 用户自配了 `bucket + accessKeyId + accessKeySecret` → 用 `S3StorageClient` 直连自己的桶；
   *   2. 未自配 S3 但**已登录** → 用 `RemoteProxyStorageClient` 走服务端平台存储
   *      （服务端持平台密钥，按 `mdadmin/neomd/users/<username>/` 隔离，客户端拿不到密钥）；
   *   3. 未自配且未登录 → 返回 null（没有可用的远端，符合预期）。
   *
   * 多端一致性链路（排查「PC 改了 Web 看不到」时按此顺序看）：
   *   - **PC 端本地文件夹**与**Web 端 IndexedDB** 都只是「本地副本」，彼此不直接通信；
   *   - 真正的一致性由 `SyncEngine` 经**同一个远端前缀**达成：
   *     `docs/<docId>/<rev>-<hash>.md`（正文）+ `docs/<docId>/manifest.json`（元数据）
   *     + `index/<deviceId>.json`（各设备状态）+ `versions/<docId>/...`（历史版本）；
   *   - 各端 `rootPrefix` 统一为 `mdadmin/neomd/users/<username>/`，
   *     因此 A 端写入的 blob 与 B 端要拉的 blob 是**同一个对象键**——这是跨端可见的前提；
   *   - 注意与「设置分区同步」的区别：设置是 global 强一致 + platform 差异化，
   *     而**仓库正文不做平台差异化**，同一用户的任意端看到的文档集合必须完全一致。
   */
  /**
   * 判断用户是否配置了**结构上可用**的自建对象存储，且它确实属于用户自己。
   *
   * 重要根因修复（1.1.9）：线上 1.1.8 报「同步失败：Failed to fetch」的根因是
   *   `admin` 账号的云端设置里残留了拼写错误的 `bucket: "zhenglob"`（真实桶是 `zhengle`）
   *   + 平台内置 AK，于是 `buildSyncEngine()` 优先走 `S3StorageClient` 直连
   *   `zhenglob.oss-cn-guangzhou.aliyuncs.com`；该桶不存在、阿里云又不对失败响应
   *   返回 CORS 头，浏览器只能抛笼统的 `TypeError: Failed to fetch`。
   *
   * 修复分两层，且都**不依赖硬编码字符串**：
   *  1. **不变量（硬性）**：只要用户已登录，`buildSyncEngineForVault()` 永不直连自建 S3，
   *     一律走服务端平台存储代理。因此「已登录 + 脏 S3 配置」这条失败路径已被结构性消除，
   *     不再需要按桶名黑名单去挡；
   *  2. **结构化校验**：仅在「未登录 + 想直连自己桶」时才走这里，此时只做格式与自洽性判断
   *     —— 桶名必须符合 S3 命名规则、endpoint 必须是合法 URL、AK/SK 必须像一对真实凭证。
   *     任何一项不满足就判定为「没配」，让用户看到「请检查对象存储配置」这个可自助的提示，
   *     而不是拿一个必然失败的配置去撞网络、再抛一句看不懂的 Failed to fetch。
   */
  function hasValidCustomS3(): boolean {
    const cfg = settingsStore.settings.storage;
    const secrets = settingsStore.secrets;
    const bucket = (cfg?.bucket ?? '').trim();
    const ak = (cfg?.accessKeyId || secrets.storageKeyId || '').trim();
    const sk = (cfg?.accessKeySecret || secrets.storageSecret || '').trim();
    if (!bucket || !ak || !sk) return false;

    // 桶名必须符合 S3/OSS 命名规则：3-63 位小写字母数字与短横线，且不以短横线开头结尾。
    // 这条能挡住 `zhenglob` 之外的同类拼写问题（大小写混用、带空格、写成 URL 等）。
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) return false;

    // endpoint 必须是可以真正发请求的 URL；只填空串/纯域名的配置无法被 S3StorageClient 使用
    const endpoint = (cfg?.endpoint ?? '').trim();
    if (endpoint && !/^https?:\/\/[^\s]+$/i.test(endpoint)) return false;

    // 明显填错：把 Secret 粘到了 AccessKey ID 里（这两者长度量级不同，相等一定不对）
    if (ak === sk) return false;
    if (ak.length < 8 || sk.length < 8) return false;

    return true;
  }

  /** 自建对象存储「配了但不可用」的原因（供同步失败时给出可自助的中文提示） */
  function customS3Problem(): string {
    const cfg = settingsStore.settings.storage;
    const secrets = settingsStore.secrets;
    const bucket = (cfg?.bucket ?? '').trim();
    const ak = (cfg?.accessKeyId || secrets.storageKeyId || '').trim();
    const sk = (cfg?.accessKeySecret || secrets.storageSecret || '').trim();
    if (!bucket && !ak && !sk) return '';
    if (bucket && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
      return `对象存储桶名「${bucket}」不符合 S3 命名规则（只能是小写字母、数字与短横线，3-63 位）。`;
    }
    if (!ak || !sk) return '对象存储配置不完整：缺少 AccessKey ID 或 Secret。';
    const endpoint = (cfg?.endpoint ?? '').trim();
    if (endpoint && !/^https?:\/\/[^\s]+$/i.test(endpoint)) {
      return `对象存储 Endpoint「${endpoint}」不是合法 URL。`;
    }
    return '';
  }

  function buildSyncEngineForVault(targetVault: Vault): SyncEngine | null {
    const cfg = settingsStore.settings.storage;
    const secrets = settingsStore.secrets;
    const accessKeyId = cfg.accessKeyId || secrets.storageKeyId;
    const accessKeySecret = cfg.accessKeySecret || secrets.storageSecret;
    const auth = useAuthStore();
    const loggedIn = Boolean(auth.isLoggedIn && auth.user);
    const selfHosted = !loggedIn && hasValidCustomS3();

    const baseRoot = settingsStore.settings.sync.rootPrefix;
    const vaultSegment = targetVault.vaultId ? `vaults/${targetVault.vaultId}/` : '';
    const rootPrefix =
      auth.isLoggedIn && auth.user
        ? `${baseRoot}users/${auth.user.username}/${vaultSegment}`
        : `${baseRoot}${vaultSegment}`;

    let client;
    if (loggedIn) {
      /*
       * **不变量（1.1.9，请勿为了"尊重用户配置"而改动）**：
       * 已登录用户永不直连自建 S3。原因有三：
       *  1. 平台的桶/凭证只在服务端，浏览器本来也拿不到；
       *  2. 直连第三方 OSS 需要该桶单独配置 CORS，而绝大多数用户不会配 ——
       *     这正是「同步失败：Failed to fetch」唯一根因的温床；
       *  3. 服务端代理已按 `user + vaultId` 做严格隔离，安全边界比客户端持密钥更清。
       * 用户想要「自带存储」时，应先退出登录（或使用私有模式），此时才走下面的 selfHosted 分支。
       *
       * 传入 `rootPrefix` 让本类在边界处把完整 key 归一成相对 key（1.1.9）：
       * 网络上永远是相对 key，不再依赖服务端 `toRelativeKey()` 的反向剥离兜底。
       */
      client = new RemoteProxyStorageClient(proxyTransport, {
        maxObjectBytes: 25 * 1024 * 1024,
        vaultId: targetVault.vaultId ?? '',
        rootPrefix,
      });
    } else if (selfHosted) {
      client = new S3StorageClient({ ...cfg, accessKeyId, accessKeySecret });
    } else {
      return null;
    }

    const isCurrentVault = vault.value === targetVault;
    return new SyncEngine(
      client,
      {
        ...settingsStore.settings.sync,
        rootPrefix,
        deviceId: ensureDeviceId(),
        vaultId: targetVault.vaultId,
      },
      {
        listLocal: () => targetVault.localStates(),
        readLocal: async (docId) => {
          try {
            return await targetVault.read(docId);
          } catch {
            return null;
          }
        },
        writeLocal: async (entry, markdown) => {
          await targetVault.applyRemote(entry, markdown);
          if (isCurrentVault) await refreshDocs();
        },
        deleteLocal: async (docId) => {
          await targetVault.remove(docId, { deleteFile: true });
          if (isCurrentVault) await refreshDocs();
        },
        markSynced: (docId, rev) => targetVault.markSynced(docId, rev),
        readLocalVersion: async () => null,
        recordVersion: async () => undefined,
        onLog: (entry) => {
          syncLogs.value = [entry, ...syncLogs.value].slice(0, 200);
        },
        onConflict: (conflict) => {
          syncConflicts.value = [...syncConflicts.value, conflict];
        },
        onProgress: () => undefined,
      },
      {
        direction: syncDirection.value,
        conflictPolicy: syncConflictPolicy.value,
      },
    );
  }

  function buildSyncEngine(): SyncEngine | null {
    if (!vault.value) return null;
    return buildSyncEngineForVault(vault.value);
  }

  /**
   * 取（或惰性生成）稳定的本机设备标识。
   *
   * 为什么必须有：`SyncEngine` 把每台设备的同步状态写到 `index/<deviceId>.json`，
   * 若 `deviceId` 为空串，键会退化成 `index/.json` —— **所有设备挤在同一个索引文件里互相覆盖**，
   * 表现为「A 端刚同步完，B 端一同步就把 A 的状态冲掉」，是跨端不同步的隐性根因之一。
   *
   * 取值优先级：
   *   1. 用户/云端设置里已有的 `sync.deviceId`（老用户保持一致，不打断既有索引）；
   *   2. localStorage 里已生成过的 `neomd.deviceId`（多标签页共享）；
   *   3. 新生成一个随机 id 并落 localStorage。
   *
   * 注意与 `currentDeviceName()` 的区别：deviceName 是给人看的展示名（可重名），
   * deviceId 是给对象键用的唯一标识（必须唯一且稳定）。
   */
  function ensureDeviceId(): string {
    const fromSettings = settingsStore.settings.sync?.deviceId?.trim();
    if (fromSettings) return fromSettings;
    try {
      const stored = localStorage.getItem('neomd.deviceId')?.trim();
      if (stored) return stored;
      // 生成：时间戳 + 随机串，既保证唯一也便于排查时看出设备创建时间
      const generated = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem('neomd.deviceId', generated);
      return generated;
    } catch {
      // localStorage 不可用（隐私模式/无痕）时退化为会话级临时 id，
      // 至少能避免多设备共用 `.json`，代价是每次刷新会换索引文件
      return `tmp-${Math.random().toString(36).slice(2, 10)}`;
    }
  }

  /* ---------------- 云端历史版本 ---------------- */

  /**
   * 列出某篇文档在云端对象存储里的历史版本。
   *
   * PC 端本地默认只保留最新版本，历史版本面板需要从这里读。
   * 未配置对象存储时返回空数组（不报错，面板会给出说明文案）。
   */
  async function listCloudVersions(docId: string): Promise<VersionRecord[]> {
    const engine = buildSyncEngine();
    if (!engine || !docId) return [];
    try {
      const remote = await engine.listRemoteVersions(docId);
      return remote.map((r) => ({
        id: `${docId}-${r.rev}-${r.hash}`,
        docId,
        rev: r.rev,
        hash: r.hash,
        size: r.size,
        createdAt: r.createdAt,
        origin: 'save',
        storageKey: r.storageKey,
        synced: true,
        label: '云端',
      }));
    } catch {
      return [];
    }
  }

  /** 读取云端某个历史版本的内容 */
  async function readCloudVersion(storageKey: string): Promise<string> {
    const engine = buildSyncEngine();
    if (!engine) throw new Error('尚未配置对象存储，无法读取云端版本');
    return engine.readRemoteVersion(storageKey);
  }

  /**
   * 把一次保存前的旧内容归档到云端历史版本。
   * 失败只记日志，不打断保存流程（本地保存已经成功）。
   */
  async function archiveVersionToCloud(docId: string, rev: number, markdown: string): Promise<void> {
    const engine = buildSyncEngine();
    if (!engine) return;
    try {
      const hash = await sha256Hex(markdown, 16);
      await engine.putRemoteVersion(docId, rev, hash, markdown);
    } catch (e) {
      const entry: SyncLogEntry = {
        id: uid('log'),
        at: Date.now(),
        level: 'warn',
        message: `云端版本归档失败：${(e as Error).message}`,
      };
      syncLogs.value = [entry, ...syncLogs.value].slice(0, 200);
    }
  }

  /**
   * 把同步异常翻译成人能看懂的中文原因（1.1.8）。
   *
   * 为什么需要：浏览器对 CORS 预检失败、DNS 失败、连接被拒等情况**统一抛
   * `TypeError: Failed to fetch`**，不带任何细节。用户看到「同步失败：Failed to fetch」
   * 完全无法自救。这里按已知失败模式归类，并给出可操作的下一步。
   *
   * @param err 原始异常
   * @param vaultId 当前仓库 id（用于判断「未注册」这类特定原因）
   */
  function explainSyncError(err: unknown, vaultId: string): string {
    const raw = err instanceof Error ? err.message : String(err);
    // 原有错误已带中文（来自 RemoteProxyStorageClient 的 readError）直接透出
    if (/[\u4e00-\u9fa5]/.test(raw)) return raw;

    if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) {
      /*
       * 这是最容易被误判的一类。线上 1.1.8 的真实成因（已抓包确认）是：
       * 已登录用户被自建 S3 配置"抢"走了通道，浏览器直连阿里云 OSS，
       * 而该桶既不存在、也没配 CORS → 只剩一句 Failed to fetch。
       *
       * 1.1.9 起「已登录永不直连自建 S3」已成为不变量，所以这里先判断
       * 当前是否还残留着一份自建存储配置：如果有，直接点明它并给出「重置」指引，
       * 这比泛泛而谈「网络可能中断」有用得多。
       */
      const problem = customS3Problem();
      const auth = useAuthStore();
      if (problem) {
        return auth.isLoggedIn
          ? `${problem}当前已登录，同步会改用平台存储（不经你的自建 S3），因此这条配置不影响同步；` +
              '建议到「设置 → 对象存储」把无效配置清空，或点「重置对象存储配置」恢复默认。'
          : `${problem}请到「设置 → 对象存储」检查填写，或点「重置对象存储配置」清空后改用平台存储。`;
      }
      /*
       * 其余成因按概率排序：
       * 1. CORS 预检失败（自定义头未在服务端 allowedHeaders 里）；
       * 2. 服务器不可达 / 证书问题 / 断网；
       * 3. 私有化模式误拦。
       */
      return (
        '无法连接到服务器（Failed to fetch）。可能原因：' +
        '① 网络中断或服务器不可达；' +
        '② 浏览器拦截了跨域请求（自定义请求头未被服务端允许）；' +
        '③ 自建服务器地址配置错误。' +
        '请检查网络与「设置 → 服务器」中的地址，再点「立即同步」重试。'
      );
    }
    if (/\b401\b|未登录|登录已过期/.test(raw)) {
      return '登录状态已失效，请重新登录后再同步。';
    }
    if (/VAULT_NOT_REGISTERED|未注册/.test(raw)) {
      return `当前仓库尚未在服务器登记（vaultId=${vaultId || '未知'}），请重新打开一次该仓库以自动登记，然后再同步。`;
    }
    if (/VAULT_DISABLED|已停用/.test(raw)) {
      return '该仓库已在仓库管理中被停用，请先启用后再同步。';
    }
    if (/QUOTA_EXCEEDED|配额/.test(raw)) {
      return '存储配额不足，请清理空间或联系管理员扩容。';
    }
    if (/请求超时|timeout/i.test(raw)) {
      return '同步请求超时。可能是网络较慢或云端数据较多，请稍后重试。';
    }
    return raw;
  }

  /** 同步结果摘要（供设置页与状态栏展示） */
  const lastSyncSummary = ref<{ ok: boolean; message: string; at: number } | null>(null);

  /**
   * 当前对象存储配置的问题描述（1.1.9，空串表示没问题）。
   *
   * 供设置页「对象存储」区块展示一行黄色提示 + 「重置」按钮。
   * 之所以暴露成 store 的 computed（而不是让设置页自己拼校验逻辑），
   * 是因为同步链路与设置页必须用**同一套判据**，否则会出现
   * 「设置页说没问题、同步却一直失败」这种最难排查的分裂。
   */
  const storageConfigProblem = computed(() => customS3Problem());

  /**
   * 重置对象存储配置（1.1.9）。
   *
   * 场景：用户的云端设置里残留了一份拼错的桶名 / 过期的 AK，
   * 而这份配置在 1.1.8 里会抢走同步通道，让同步 100% 失败（Failed to fetch）。
   *
   * 设计取舍：**只清空「导致失败的那部分」**（桶名、Endpoint、AK/SK），
   * 保留 provider / region / 前缀这类无害字段，避免把用户其它设置一起抹掉。
   * 且**必须由用户显式点击**触发 —— 静默改用户配置是更糟的体验。
   */
  function resetStorageConfig(): void {
    const cur = settingsStore.settings.storage;
    settingsStore.update({
      storage: { ...cur, bucket: '', endpoint: '', publicDomain: '' },
    });
    // 密钥走 setSecret / setStorageKeyId：这两个是直写内存并落盘，不经过 mergeSettings
    // （mergeSettings 会「保留本地密钥」，用 update() 清不掉）
    settingsStore.setStorageKeyId('');
    settingsStore.setSecret('storage', '');
    notify('已重置对象存储配置，同步将使用平台存储（登录状态）或本机模式。', 'success', 4200);
  }

  async function syncNow(opts: { silent?: boolean } = {}): Promise<void> {
    if (syncState.value === 'syncing') return;
    const engine = buildSyncEngine();
    if (!engine) {
      const msg = canSync()
        ? '仓库尚未就绪，无法同步'
        : '尚未登录且未配置对象存储，无法同步。请登录账号，或在设置中配置 S3/OSS。';
      if (!opts.silent) notify(msg, 'error', 4600);
      lastSyncSummary.value = { ok: false, message: msg, at: Date.now() };
      return;
    }
    const vaultId = vault.value?.vaultId ?? '';
    syncState.value = 'syncing';
    statusText.value = '正在同步…';
    try {
      const result = await engine.sync(currentDeviceName());
      const at = Date.now();
      lastSyncAt.value = at;
      /*
       * 同步本体成功 → 立即把状态复位为 idle（1.1.9）。
       *
       * 这一步必须在**任何后置簿记之前**完成，而且后置簿记要单独 try/catch（见下）。
       * 否则会出现本轮事故的同款错位：`refreshDocs()` / `markSynced()` / 上报云端
       * 任何一处抛错，都会被外层 catch 捕获 → `syncState='error'` + 「同步失败」提示，
       * 而实际上云端数据**已经同步成功**。用户看到的是「同步失败」，服务端却是成功的，
       * 这种"成功被报成失败"比直接失败更难排查。
       */
      syncState.value = 'idle';
      statusText.value = '';

      const summary =
        `拉取 ${result.pulled} 篇，推送 ${result.pushed} 篇` +
        (result.skipped ? `，跳过 ${result.skipped} 篇` : '') +
        (result.conflicts ? `，冲突 ${result.conflicts} 个` : '') +
        (result.errors.length ? `，${result.errors.length} 个错误` : '');
      lastSyncSummary.value = { ok: result.errors.length === 0, message: summary, at };

      if (!opts.silent) {
        notify(
          result.errors.length ? `同步部分失败：${summary}` : `同步完成：${summary}`,
          result.errors.length ? 'error' : 'success',
          3200,
        );
      }

      /*
       * 后置簿记（刷新列表 / 建索引 / 回写注册表 / 上报云端）。
       *
       * 这些都不影响「同步是否成功」这个事实，因此**单独兜错**：
       * 失败只记 warn 日志，绝不回退 syncState、绝不弹「同步失败」。
       */
      try {
        await refreshDocs();
        await rebuildSearchIndex();
        if (vaultId) {
          const bytes = docs.value.reduce((sum, d) => sum + (d.size ?? 0), 0);
          vaultRegistry.markSynced(vaultId, { docCount: docs.value.length, bytes });
          refreshVaultList();
          // 上报云端失败不阻塞：下次同步会再报一次（服务端按 (user, vault) 幂等）
          fireAndLog(pushVaultEntry(true), 'vault:publishAfterSync');
        }
        if (vaultId) markFirstSyncDone(vaultId);
      } catch (bookErr) {
        syncLogs.value = [
          {
            id: `sync-book-${Date.now()}`,
            at: Date.now(),
            level: 'warn' as const,
            message: `同步已完成，但刷新本地列表/索引时出错：${(bookErr as Error).message}`,
          },
          ...syncLogs.value,
        ].slice(0, 200);
      }
    } catch (e) {
      // 走到这里说明**同步本体**真的失败了（网络/权限/引擎异常）
      syncState.value = 'error';
      statusText.value = '';
      const reason = explainSyncError(e, vaultId);
      lastSyncSummary.value = { ok: false, message: reason, at: Date.now() };
      syncLogs.value = [
        {
          id: `sync-err-${Date.now()}`,
          at: Date.now(),
          level: 'error' as const,
          message: `同步失败：${reason}`,
        },
        ...syncLogs.value,
      ].slice(0, 200);
      if (!opts.silent) notify(`同步失败：${reason}`, 'error', 6000);
    }
  }

  /**
   * 同步单个指定仓库（1.1.9）。
   *
   * - 若就是当前打开的仓库 → 直接调 `syncNow()`；
   * - 若是非当前仓库 → 使用独立的临时 `Vault` + `SyncEngine` 实例在后台完成同步，
   *   并将真实 `vaultId`（替换 `pending:`）、统计与 `lastSyncedAt` 回写注册表及云端 `/api/vaults`。
   */
  async function syncVaultById(vaultIdOrLoc: string, opts: { silent?: boolean } = {}): Promise<boolean> {
    if (!canSync()) {
      if (!opts.silent) notify('尚未登录且未配置对象存储，无法同步', 'error', 3600);
      return false;
    }
    const registry = sharedVaultRegistry();
    const entry = registry.get(vaultIdOrLoc) ?? registry.findByLocation(vaultIdOrLoc);
    if (!entry) {
      if (!opts.silent) notify('找不到该仓库记录', 'error', 3200);
      return false;
    }
    if (entry.status === 'disabled') {
      if (!opts.silent) notify(`仓库「${entry.name}」已停用，无法同步`, 'info', 3200);
      return false;
    }
    // 当前仓库直接走主流程
    if (
      (vault.value && entry.vaultId === vault.value.vaultId) ||
      (vaultLocation.value && entry.location === vaultLocation.value)
    ) {
      await syncNow({ silent: opts.silent });
      return Boolean(lastSyncSummary.value?.ok);
    }

    try {
      const runtime = detectRuntime();
      const bridge = getBridge();
      let adapter;
      if (runtime.platform === 'desktop' && bridge) adapter = new NativeVaultAdapter(bridge, 'desktop-fs');
      else if (runtime.platform === 'android' && bridge) adapter = new NativeVaultAdapter(bridge, 'android-fs');
      else adapter = new BrowserVaultAdapter();

      const tmpVault = new Vault(adapter);
      tmpVault.keepLocalVersions = Boolean(settingsStore.settings.localVault?.keepVersions);
      const rawLoc = entry.location || `cloud:${entry.vaultId}`;
      const effectiveLocation = await resolveDesktopVaultLocation(rawLoc, entry.name);
      const expectedId = entry.vaultId.startsWith('pending:') ? undefined : entry.vaultId;
      await tmpVault.open(effectiveLocation, {
        expectedVaultId: expectedId,
        expectedName: entry.name,
      });

      // 把可能存在的 pending: 占位 id 替换为真实 vaultId，并补齐 location
      if (entry.location !== effectiveLocation) {
        entry.location = effectiveLocation;
        entry.available = true;
      }
      registry.attachVaultId(effectiveLocation, tmpVault.vaultId, entry.name);

      const auth = useAuthStore();
      const docsList = tmpVault.list();
      const bytes = docsList.reduce((sum, d) => sum + (d.size ?? 0), 0);

      // 同步前先向服务端登记仓库档案，避免 403
      if (auth.isLoggedIn) {
        try {
          await vaultsApi.upsert({
            vaultId: tmpVault.vaultId,
            name: entry.name,
            docCount: docsList.length,
            bytes,
            markSynced: false,
          });
        } catch {
          /* ignore */
        }
      }

      const engine = buildSyncEngineForVault(tmpVault);
      if (!engine) return false;
      const result = await engine.sync(currentDeviceName());
      const afterDocs = tmpVault.list();
      const afterBytes = afterDocs.reduce((sum, d) => sum + (d.size ?? 0), 0);
      registry.markSynced(tmpVault.vaultId, { docCount: afterDocs.length, bytes: afterBytes });
      markFirstSyncDone(tmpVault.vaultId);

      if (auth.isLoggedIn) {
        try {
          await vaultsApi.upsert({
            vaultId: tmpVault.vaultId,
            name: entry.name,
            docCount: afterDocs.length,
            bytes: afterBytes,
            markSynced: true,
          });
        } catch {
          /* ignore */
        }
      }

      refreshVaultList();
      if (!opts.silent) {
        notify(
          result.errors.length
            ? `仓库「${entry.name}」同步部分失败`
            : `仓库「${entry.name}」已同步（拉取 ${result.pulled} 篇，推送 ${result.pushed} 篇）`,
          result.errors.length ? 'error' : 'success',
          3200,
        );
      }
      return result.errors.length === 0;
    } catch (e) {
      if (!opts.silent) {
        notify(`同步仓库「${entry.name}」失败：${explainSyncError(e, entry.vaultId)}`, 'error', 4600);
      }
      return false;
    }
  }

  /**
   * 「全部仓库同步」的运行状态（1.1.9）。
   *
   * 为什么必须是 store 级的 ref 而不是组件局部状态：
   *  - 按钮在 `VaultManagerSection` 与设置页两处都有，需要一个共享的"正在跑"信号；
   *  - `syncAllVaults()` 可能持续几十秒（50 个仓库 × 全量同步），
   *    期间用户再点一次必须被**明确挡住**，否则会并发跑两轮、互相覆盖 index；
   *  - UI 需要进度（第几个 / 共几个），否则用户只能干等，以为卡死。
   */
  const syncAllState = ref<{ running: boolean; done: number; total: number; current: string }>({
    running: false,
    done: 0,
    total: 0,
    current: '',
  });

  /** 单个仓库同步的硬超时（毫秒）—— 防止某个仓库卡住把整轮拖死 */
  const SYNC_ONE_VAULT_TIMEOUT_MS = 120_000;
  /** 整轮「全部同步」的总时长上限（毫秒）—— 超时后停止继续，已完成的保留结果 */
  const SYNC_ALL_TOTAL_BUDGET_MS = 10 * 60_000;

  /** 给一个 Promise 套上超时；超时抛错而不是永久挂起 */
  function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)} 秒）`)), ms);
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  /**
   * 「全部仓库同步」：遍历本机注册表中所有启用状态的仓库，依次完成同步（1.1.9）。
   *
   * 为什么需要超时与预算（否则「立即全部同步」会让界面长时间无响应）：
   *  - 每个仓库的同步都是「列举 + 逐文档 head/get/put」，仓库多、文档多时单轮可达数分钟；
   *  - 50 个仓库串行下来可能几十分钟，用户只会看到按钮转圈、什么反馈都没有；
   *  - 因此：**单仓库 2 分钟硬超时**（避免一个坏仓库拖死全部）+
   *    **整轮 10 分钟预算**（到点停止，已同步的保留，未做的明确告知）；
   *  - 全程更新 `syncAllState`，UI 可显示「第 3/8 个：郑磊」。
   *
   * @returns `synced` 成功数、`skipped` 失败/跳过数、`budgetExhausted` 是否因总预算用尽而中止
   */
  async function syncAllVaults(
    opts: { silent?: boolean } = {},
  ): Promise<{ synced: number; skipped: number; budgetExhausted: boolean }> {
    if (!canSync()) {
      if (!opts.silent) notify('请先登录账号或配置对象存储后再同步所有仓库', 'info', 3600);
      return { synced: 0, skipped: 0, budgetExhausted: false };
    }
    /*
     * 防重入：已经在跑就直接返回。
     * 不加这个保护时，用户连点两次会并发跑两轮「全部同步」，
     * 两轮同时写 `index/<deviceId>.json` 与 manifest，互相覆盖导致状态错乱。
     */
    if (syncAllState.value.running) {
      if (!opts.silent) notify('「全部同步」正在进行中，请等待完成', 'info', 2600);
      return { synced: 0, skipped: 0, budgetExhausted: false };
    }

    const registry = sharedVaultRegistry();
    const allEntries = registry.list().filter((e) => e.status === 'active');
    const curId = vault.value?.vaultId || registry.currentId;
    const curLoc = vaultLocation.value;
    const others = allEntries.filter((e) => e.vaultId !== curId && (!curLoc || e.location !== curLoc));
    const total = (allEntries.length > 0 ? 1 : 0) + others.length;
    let synced = 0;
    let skipped = 0;
    let budgetExhausted = false;
    const startedAt = Date.now();

    syncAllState.value = { running: true, done: 0, total, current: '当前仓库' };
    try {
      // 先同步当前仓库
      await syncNow({ silent: true });
      if (lastSyncSummary.value?.ok) synced += 1;
      else skipped += 1;
      syncAllState.value = { ...syncAllState.value, done: 1 };

      // 再依次同步其余仓库
      for (const entry of others) {
        // 整轮预算检查：超时后停止，已完成的保留
        if (Date.now() - startedAt > SYNC_ALL_TOTAL_BUDGET_MS) {
          budgetExhausted = true;
          break;
        }
        syncAllState.value = { ...syncAllState.value, current: entry.name || entry.vaultId };
        statusText.value = `正在同步「${entry.name}」（${syncAllState.value.done + 1}/${total}）…`;
        try {
          const ok = await withTimeout(
            syncVaultById(entry.vaultId || entry.location, { silent: true }),
            SYNC_ONE_VAULT_TIMEOUT_MS,
            `仓库「${entry.name}」同步`,
          );
          if (ok) synced += 1;
          else skipped += 1;
        } catch (e) {
          // 单个仓库超时/异常不影响其余仓库
          skipped += 1;
          syncLogs.value = [
            {
              id: `syncall-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              at: Date.now(),
              level: 'warn' as const,
              message: `全部同步：仓库「${entry.name}」失败或超时：${(e as Error).message}`,
            },
            ...syncLogs.value,
          ].slice(0, 200);
        }
        syncAllState.value = { ...syncAllState.value, done: syncAllState.value.done + 1 };
      }
    } finally {
      syncAllState.value = { running: false, done: 0, total: 0, current: '' };
      statusText.value = '';
    }

    refreshVaultList();
    if (!opts.silent) {
      const remain = total - synced - skipped;
      notify(
        budgetExhausted
          ? `全部同步已达单轮时长上限，已完成 ${synced} 个，${Math.max(0, remain)} 个未同步（可再次点击继续）`
          : others.length > 0
            ? `全部仓库同步完成：共 ${synced} 个仓库同步成功${skipped ? `，${skipped} 个失败` : ''}`
            : synced > 0
              ? '当前仓库已同步完成'
              : '同步未完成，请查看同步日志',
        budgetExhausted ? 'info' : skipped === 0 && synced > 0 ? 'success' : 'info',
        4200,
      );
    }
    return { synced, skipped, budgetExhausted };
  }

  /**
   * 「首次同步」标记（1.1.8）。
   *
   * 为什么要区分首次与每次：
   * 首次登录（或首次在某个仓库上登录）时，本地通常是空的，必须**主动**把云端数据
   * 拉下来，用户才知道「同步是通的」。而之后每次打开仓库都做同样的重活没有意义，
   * 只会拖慢启动。因此打一个按仓库区分的标记，只在第一次做「编排式首拉」。
   *
   * 为什么按 `vaultId` 而不是账号：一个账号在 PC 端可能有多个本地仓库
   * （「郑磊 / Neo MD / Neo MD-整理」），每个仓库的「是否还需要首拉」是独立事实，
   * 用账号维度会让第二个仓库永远拿不到首拉。
   */
  const FIRST_SYNC_PREFIX = 'neomd.firstSyncDone.v1:';

  function firstSyncKey(vaultId: string): string {
    return `${FIRST_SYNC_PREFIX}${vaultId}`;
  }

  /**
   * 该仓库是否已完成首拉。
   *
   * 注意 `vaultId` 为空时返回 `true`：此时无法判断，宁可「当作已完成」也不要
   * 在每次启动都触发一次全量同步（那会让启动变慢且刷爆网络）。
   */
  function isFirstSyncDone(vaultId: string): boolean {
    if (!vaultId) return true;
    try {
      return localStorage.getItem(firstSyncKey(vaultId)) === '1';
    } catch {
      return true;
    }
  }

  /** 记录该仓库已完成首拉（localStorage 不可用时静默放弃，不阻断主流程） */
  function markFirstSyncDone(vaultId: string): void {
    if (!vaultId) return;
    try {
      localStorage.setItem(firstSyncKey(vaultId), '1');
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 首次登录时的「拉取与全量对齐编排」（1.1.9）。
   *
   * 顺序：
   *  1. `pullVaultList()` —— 拉取云端仓库档案并合并进本机注册表；
   *  2. 若在网页端发现当前打开的是旧版按用户名生成的空壳伪仓库（如 `cloud:admin`、`cloud:my`），
   *     且云端已有真实仓库（如 PC 端同步上来的「郑磊 / Neo MD / Neo MD-整理」），
   *     自动清理伪仓库并切换到云端排第一的真实仓库；
   *  3. 对当前仓库执行同步，并将本机其余未同步的本地仓库也一并后台登记同步到云端。
   */
  let firstSyncRunning = false;
  async function runFirstSyncIfNeeded(): Promise<boolean> {
    if (firstSyncRunning) return false;
    const auth = useAuthStore();
    if (!auth.isLoggedIn || !vault.value) return false;
    const vaultId = vault.value.vaultId;
    if (!vaultId) return false;

    firstSyncRunning = true;
    try {
      let remoteVaults: Array<{ vaultId: string; name: string }> = [];
      try {
        const res = await vaultsApi.list();
        remoteVaults = res.vaults ?? [];
        vaultRegistry.mergeRemote(remoteVaults);
        refreshVaultList();
      } catch {
        /* ignore */
      }

      const remoteIds = new Set(remoteVaults.map((v) => v.vaultId).filter(Boolean));
      const username = auth.user?.username?.trim().toLowerCase() ?? '';
      const curLoc = vault.value.location || '';
      const curNameLower = (vaultName.value || '').trim().toLowerCase();
      const locTargetLower = curLoc.startsWith('cloud:') ? curLoc.slice(6).trim().toLowerCase() : '';
      const isPseudoVault =
        !remoteIds.has(vaultId) &&
        curLoc.startsWith('cloud:') &&
        (curNameLower === username ||
          locTargetLower === username ||
          curNameLower === 'admin' ||
          curNameLower === 'my' ||
          locTargetLower === 'admin' ||
          locTargetLower === 'my') &&
        docs.value.length === 0;

      if (remoteIds.size > 0) {
        const pruned = vaultRegistry.prunePseudoCloudVaults(remoteIds, username ? [username] : []);
        if (pruned) refreshVaultList();
      }

      if (isPseudoVault && remoteIds.size > 0) {
        const firstReal = vaultRegistry
          .listSorted()
          .find((e) => remoteIds.has(e.vaultId) && e.status === 'active');
        if (firstReal) {
          const targetLoc = firstReal.location || `cloud:${firstReal.vaultId}`;
          await switchVault(targetLoc, firstReal.name);
          return true;
        }
      }

      const firstTime = !isFirstSyncDone(vaultId);
      const before = docs.value.length;
      await syncNow({ silent: true });
      const after = docs.value.length;

      if (firstTime) {
        if (before === 0 && after > 0) {
          notify(`已从云端拉取 ${after} 篇文档到本地`, 'success', 4200);
        }
        markFirstSyncDone(vaultId);
      }

      // PC 端：把本机已有的其它本地仓库（如 郑磊、Neo MD、Neo MD-整理）也在后台自动登记并同步到云端
      const others = vaultRegistry
        .list()
        .filter((e) => e.status === 'active' && e.vaultId !== vault.value?.vaultId && !remoteIds.has(e.vaultId));
      if (others.length > 0) {
        for (const other of others) {
          await syncVaultById(other.vaultId || other.location, { silent: true });
        }
      }
      return true;
    } finally {
      firstSyncRunning = false;
    }
  }

  // 1.1.9：监听 keepVersions 变化，实时同步到当前打开的 Vault
  watch(
    () => settingsStore.settings.localVault?.keepVersions,
    (val) => {
      if (vault.value) vault.value.keepLocalVersions = Boolean(val);
    },
  );

  // 1.1.9：监听登录状态变化，登录后自动触发拉取与同步
  watch(
    () => useAuthStore().isLoggedIn,
    (loggedIn) => {
      if (loggedIn && vaultReady.value) {
        fireAndLog(runFirstSyncIfNeeded(), 'vault:login→firstSync');
      }
    },
  );

  /**
   * 冲突处理：   * - 保留本地：把本地内容另存为「冲突副本」，再用远端覆盖
   * - 使用远端：直接采用远端内容
   * - 合并：使用三方合并结果（若无则保留本地）
   */
  async function resolveConflict(docId: string, choice: 'local' | 'remote' | 'merged'): Promise<void> {
    const conflict = syncConflicts.value.find((c) => c.docId === docId);
    if (!conflict || !vault.value) return;
    const tab = tabs.value.find((t) => t.docId === docId);
    try {
      if (choice === 'local') {
        // 本地内容另存为新文件，避免丢失；随后接受远端
        const copyTitle = `${conflict.path.replace(/\.md$/i, '')}-冲突副本-${new Date()
          .toISOString()
          .slice(5, 16)
          .replace(/[:T]/g, '')}`;
        await vault.value.create({ title: copyTitle, content: conflict.localMarkdown });
        if (tab) {
          tab.content = conflict.remoteMarkdown;
          tab.dirty = true;
        }
        await refreshDocs();
        notify('已把本地内容另存为冲突副本，并采用远端版本', 'success', 4200);
      } else if (choice === 'remote') {
        if (tab) {
          tab.content = conflict.remoteMarkdown;
          tab.dirty = true;
        }
        notify('已采用远端版本', 'success');
      } else {
        const merged = conflict.mergedMarkdown ?? conflict.localMarkdown;
        if (tab) {
          tab.content = merged;
          tab.dirty = true;
        }
        notify('已使用合并结果', 'success');
      }
      syncConflicts.value = syncConflicts.value.filter((c) => c.docId !== docId);
    } catch (e) {
      notify(`冲突处理失败：${(e as Error).message}`, 'error');
    }
  }

  /* ---------------- 工具 ---------------- */

  function docTitle(docId: string): string {
    return vault.value?.get(docId)?.title ?? titleFromPath(docId);
  }

  /* ---------------- 仓库管理（1.1.5） ---------------- */

  /** 仓库注册表实例已在 store 顶部创建（见 vaultRegistry 的声明说明） */

  /** 当前仓库的完整注册信息 */
  const currentVaultEntry = computed(() => vaultRegistry.current());

  /** 与 store 的 vaults 同步（注册表变更后调用，触发 UI 更新） */
  function refreshVaultList(): void {
    vaults.value = loadVaults();
  }

  /** 重命名仓库（只改显示名，不动目录名与 vaultId） */
  function renameVault(vaultId: string, name: string): boolean {
    const ok = vaultRegistry.rename(vaultId, name);
    if (ok) refreshVaultList();
    return ok;
  }

  /** 停用 / 启用仓库：停用后数据保留，但不允许切换为当前仓库 */
  function setVaultStatus(vaultId: string, status: 'active' | 'disabled'): boolean {
    const ok = vaultRegistry.setStatus(vaultId, status);
    if (ok) refreshVaultList();
    return ok;
  }

  /** 从本机清单移除仓库（不删文件、不删云端数据） */
  function removeVault(vaultId: string): boolean {
    const ok = vaultRegistry.remove(vaultId);
    if (ok) refreshVaultList();
    return ok;
  }

  /**
   * 切换到另一个仓库。
   *
   * 复用既有的 `switchVault(location, displayName)`（它会先保存当前标签、清空 tabs
   * 再打开新仓库），这里只负责把「注册表里的 vaultId」翻译成 location 并做前置校验。
   * 之所以不重写打开流程，是因为 `switchVault` 里已经处理了「保存未落盘的编辑」这类
   * 容易漏掉的收尾工作，另起一套必然出现两条路径行为不一致。
   */
  async function switchVaultById(vaultId: string): Promise<void> {
    const entry = vaultRegistry.get(vaultId);
    if (!entry) {
      notify('该仓库不在本机清单中', 'error');
      return;
    }
    if (entry.status === 'disabled') {
      notify('该仓库已停用，请先启用后再切换', 'info', 3200);
      return;
    }
    const targetLocation = entry.location || `cloud:${entry.vaultId}`;
    if (entry.vaultId === vaultRegistry.currentId) return;
    await switchVault(targetLocation, entry.name);
  }

  /**
   * 从云端同步仓库清单，与本机合并。
   */
  async function pullVaultList(): Promise<void> {
    const auth = useAuthStore();
    if (!auth.isLoggedIn) return;
    try {
      const res = await vaultsApi.list();
      const list = res.vaults ?? [];
      vaultRegistry.mergeRemote(list);
      const remoteIds = new Set(list.map((v) => v.vaultId).filter(Boolean));
      if (remoteIds.size > 0) {
        const username = auth.user?.username?.trim().toLowerCase() ?? '';
        vaultRegistry.prunePseudoCloudVaults(remoteIds, username ? [username] : []);
      }
      refreshVaultList();
    } catch (e) {
      // 清单同步失败不应影响本地使用
      if (e instanceof ApiError && e.status === 401) return;
      notify(`获取云端仓库列表失败：${(e as Error).message}`, 'info', 3600);
    }
  }

  /** 把本机当前仓库登记到云端（供其它端发现） */
  async function pushVaultEntry(markSynced = false): Promise<void> {
    const auth = useAuthStore();
    if (!auth.isLoggedIn || !vault.value) return;
    const entry = vaultRegistry.get(vault.value.vaultId);
    if (!entry) return;
    try {
      await vaultsApi.upsert({
        vaultId: entry.vaultId,
        name: entry.name,
        docCount: docs.value.length,
        bytes: docs.value.reduce((sum, d) => sum + (d.size ?? 0), 0),
        markSynced,
      });
    } catch {
      /* 登记失败不阻塞编辑 */
    }
  }

  return {
    vault,
    vaultReady,
    vaultName,
    vaultLocation,
    vaults,
    vaultRegistry,
    currentVaultEntry,
    renameVault,
    setVaultStatus,
    removeVault,
    pullVaultList,
    pushVaultEntry,
    refreshVaultList,
    docs,
    docsForPanel,
    canSync,
    sortBy,
    folderOrder,
    customFolders,
    tabs,
    activeTabId,
    activeTab,
    activeMode,
    activePageWidth,
    isDirty,
    statusText,
    busy,
    toast,
    searchEngine,
    searchReady,
    credits,
    syncLogs,
    syncConflicts,
    syncState,
    lastSyncAt,
    inputDialog,
    askInput,
    submitInput,
    openVault,
    cloudVaultLocation,
    refreshDocs,
    rebuildSearchIndex,
    indexDoc,
    search,
    openDoc,
    createDoc,
    updateTabContent,
    saveActiveTab,
    renameDoc,
    deleteDoc,
    closeTab,
    cycleMode,
    setMode,
    setPageWidth,
    zoom,
    setZoom,
    zoomIn,
    zoomOut,
    zoomBy,
    resetZoom,
    persistTabs,
    restoreTabs,
    loadCredits,
    syncNow,
    syncVaultById,
    installAutoSyncTimer,
    runFirstSyncIfNeeded,
    syncAllVaults,
    syncAllState,
    lastSyncSummary,
    storageConfigProblem,
    resetStorageConfig,
    autoSyncIntervalMs,
    syncConflictPolicy,
    syncDirection,
    updateSyncBehavior,
    syncBehavior,
    listCloudVersions,
    readCloudVersion,
    resolveConflict,
    setSort,
    setFolderOrder,
    createFolder,
    moveDocToFolder,
    switchVault,
    switchVaultById,
    createAndSwitchVault,
    pickAndOpenLocalVault,
    notify,
    docTitle,
    ApiError,
  };
});
