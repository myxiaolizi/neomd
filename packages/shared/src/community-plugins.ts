/**
 * 社区插件注册表（1.4.0）。
 *
 * ## 解决的问题
 *
 * 1.3.1 及以前：从插件市场装好一个插件后，
 * - `localStorage['neomd.communityPlugins.v1']` 里有记录，
 * - `settings.enabledPlugins[pluginId] = true`，
 * - **但功能区（ribbon）里没有任何入口** —— `layout.ribbonItems` 是**内置插件
 *   的 id 白名单**，社区插件不该污染它（1.3.1 刚修过「设置页出现幽灵项」），
 *   于是社区插件唯一的执行入口只剩命令面板。
 * 用户的原话是「装了插件用不了」，本质就是**没有可点的入口**。
 *
 * ## 方案（零侵入内置白名单）
 *
 * - 功能区分两类 id：
 *   - 内置：`daily-notes`、`graph` … 仍走 `layout.ribbonItems` 白名单；
 *   - 社区：统一前缀 `community:<pluginId>`，**存在独立 key**
 *     `neomd.communityRibbon.v1` 里，**绝不写入 `layout.ribbonItems`**。
 * - 安装后**默认加入**功能区；用户可移除/重新加入。
 * - 本模块同时是「已装社区插件」的**单一数据源**：读 localStorage、写
 *   localStorage、通知订阅者。EditorPage / PluginCenter 都只跟它打交道，
 *   避免两处各自 parse localStorage 导致状态不同步。
 *
 * 只用 `localStorage`，不依赖 Vue / DOM 事件，因此可被 vitest(node) 直接单测
 * （无 localStorage 时自动降级到内存存储，测试里可注入）。
 */

import { loadPluginModule, PluginSourceError } from './plugin-source';

/** 已装社区插件的存储 key（1.3.x 起沿用，**不要改**，否则老用户已装插件会丢） */
export const COMMUNITY_PLUGINS_KEY = 'neomd.communityPlugins.v1';

/**
 * 社区插件「在功能区的显示」存储 key。
 *
 * 与 `layout.ribbonItems` **完全分离**：内置白名单只放内置插件 id，
 * 社区插件只放这里，两边互不污染（设置页因此不会出现幽灵项）。
 */
export const COMMUNITY_RIBBON_KEY = 'neomd.communityRibbon.v1';

/** 功能区里社区插件的 id 前缀，例如 `community:heading-auto-number` */
export const COMMUNITY_RIBBON_PREFIX = 'community:';

/** 一条已安装的社区插件记录 */
export interface CommunityPluginRecord {
  pluginId: string;
  name: string;
  version: string;
  description: string;
  codeJs: string;
}

/** 极简存储抽象：默认 localStorage，测试可注入内存实现 */
export interface SyncStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Node / 测试环境下的内存存储兜底 */
function createMemoryStorage(): SyncStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

let storage: SyncStorage = (() => {
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
      return localStorage as SyncStorage;
    }
  } catch {
    /* 某些环境访问 localStorage 会抛（隐私模式 / 沙箱 iframe） */
  }
  return createMemoryStorage();
})();

/** 注入存储实现（仅测试使用） */
export function __setCommunityStorage(next: SyncStorage): void {
  storage = next;
  pluginsCache = null;
  ribbonCache = null;
}

/* ------------------------------- 快照 / 订阅 ------------------------------- */

type Listener = () => void;

const listeners = new Set<Listener>();

let pluginsCache: CommunityPluginRecord[] | null = null;
let ribbonCache: string[] | null = null;

/** 订阅数据变化；返回取消订阅函数 */
export function subscribeCommunityPlugins(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* 单个订阅者异常不应影响其他订阅者 */
    }
  }
}

/* ------------------------------ 读取 / 校验 ------------------------------ */

/** 把任意 JSON 值解析成合法记录；非法项丢弃（避免一条脏数据毁掉整份列表） */
function coerceRecord(value: unknown): CommunityPluginRecord | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const pluginId = typeof o.pluginId === 'string' ? o.pluginId.trim() : '';
  if (!pluginId) return null;
  return {
    pluginId,
    name: typeof o.name === 'string' && o.name ? o.name : pluginId,
    version: typeof o.version === 'string' && o.version ? o.version : '1.0.0',
    description: typeof o.description === 'string' ? o.description : '',
    codeJs: typeof o.codeJs === 'string' ? o.codeJs : '',
  };
}

/**
 * 已安装的社区插件列表（带缓存，内容变化时才返回新数组）。
 *
 * 返回新数组的意义：Vue 的 `computed` / `triggerRef` 依赖**引用变化**判断更新。
 */
export function getCommunityPlugins(): CommunityPluginRecord[] {
  if (pluginsCache) return pluginsCache;
  let raw: string | null = null;
  try {
    raw = storage.getItem(COMMUNITY_PLUGINS_KEY);
  } catch {
    raw = null;
  }
  let parsed: unknown = [];
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = [];
    }
  }
  const list = Array.isArray(parsed) ? parsed.map(coerceRecord).filter((x): x is CommunityPluginRecord => Boolean(x)) : [];
  pluginsCache = list;
  return list;
}

/** 查找单个已装插件 */
export function getCommunityPlugin(pluginId: string): CommunityPluginRecord | undefined {
  return getCommunityPlugins().find((p) => p.pluginId === pluginId);
}

/** 覆盖写入已装列表（内部使用；外部请用 install / uninstall） */
function persistPlugins(list: CommunityPluginRecord[]): void {
  pluginsCache = list;
  try {
    storage.setItem(COMMUNITY_PLUGINS_KEY, JSON.stringify(list));
  } catch {
    /* 存储不可用（配额满 / 隐私模式）时仍保留内存态，保证本次会话可用 */
  }
  emit();
}

/* ------------------------------- 功能区集合 ------------------------------- */

/** 功能区里的社区插件 id（不含 `community:` 前缀） */
export function getCommunityRibbonIds(): string[] {
  if (ribbonCache) return ribbonCache;
  let raw: string | null = null;
  try {
    raw = storage.getItem(COMMUNITY_RIBBON_KEY);
  } catch {
    raw = null;
  }
  let parsed: unknown = [];
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = [];
    }
  }
  let ids = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string' && Boolean(x)) : [];
  // 首次运行（无该 key）时，默认把所有已装插件都放进功能区 ——
  // 这才是「装完就能用」；用户之后手动移除才会写 key。
  if (raw === null) {
    ids = getCommunityPlugins().map((p) => p.pluginId);
  }
  ribbonCache = ids;
  return ids;
}

/** 该社区插件当前是否在功能区 */
export function isCommunityPluginInRibbon(pluginId: string): boolean {
  return getCommunityRibbonIds().includes(pluginId);
}

/** 加入 / 移出功能区 */
export function setCommunityPluginInRibbon(pluginId: string, inRibbon: boolean): void {
  const current = getCommunityRibbonIds();
  const next = inRibbon
    ? current.includes(pluginId)
      ? current
      : [...current, pluginId]
    : current.filter((x) => x !== pluginId);
  if (next === current) return;
  ribbonCache = next;
  try {
    storage.setItem(COMMUNITY_RIBBON_KEY, JSON.stringify(next));
  } catch {
    /* 同上：存储不可用时保留内存态 */
  }
  emit();
}

/* -------------------------------- 安装 / 卸载 -------------------------------- */

export interface InstallInput {
  pluginId: string;
  name?: string;
  version?: string;
  description?: string;
  codeJs: string;
}

export interface InstallResult {
  record: CommunityPluginRecord;
  /** 从源码里读到的声明值（用于提示「源码声明的 id 与市场登记不一致」） */
  declaredId?: string;
  declaredName?: string;
}

/**
 * 安装 / 更新一款社区插件。
 *
 * **安装即校验**：先把源码过一遍 `loadPluginModule()`，语法坏掉的插件当场抛出
 * 可读的 `PluginSourceError`，不会「装上去了但点不动」。
 *
 * 安装成功后**默认加入功能区**（这是需求「装完就能用」的核心），
 * 但**不写入** `layout.ribbonItems`（内置白名单保持干净）。
 *
 * @throws {PluginSourceError} 源码无法执行时
 */
export function installCommunityPlugin(input: InstallInput): InstallResult {
  const codeJs = String(input.codeJs ?? '');
  const mod = loadPluginModule(codeJs); // 校验；失败抛 PluginSourceError
  const declaredId = typeof mod.id === 'string' ? mod.id : undefined;
  const declaredName = typeof mod.name === 'string' ? mod.name : undefined;

  const record: CommunityPluginRecord = {
    pluginId: input.pluginId,
    name: input.name || declaredName || input.pluginId,
    version: input.version || (typeof mod.version === 'string' ? mod.version : '1.0.0'),
    description: input.description ?? '',
    codeJs,
  };

  const list = getCommunityPlugins().filter((p) => p.pluginId !== record.pluginId);
  list.push(record);
  persistPlugins(list);
  // 新装 / 更新后确保它在功能区里
  setCommunityPluginInRibbon(record.pluginId, true);

  return { record, declaredId, declaredName };
}

/** 卸载一款社区插件（同时移出功能区） */
export function uninstallCommunityPlugin(pluginId: string): void {
  const next = getCommunityPlugins().filter((p) => p.pluginId !== pluginId);
  persistPlugins(next);
  setCommunityPluginInRibbon(pluginId, false);
}

/** 强制丢弃缓存（跨标签页 / 外部写入 localStorage 后调用） */
export function refreshCommunityPlugins(): void {
  pluginsCache = null;
  ribbonCache = null;
  emit();
}

/* --------------------------------- 工具函数 --------------------------------- */

/** 社区插件的功能区 id：`community:<pluginId>` */
export function toCommunityRibbonId(pluginId: string): string {
  return `${COMMUNITY_RIBBON_PREFIX}${pluginId}`;
}

/** 是否是社区插件的功能区 id，是则返回 pluginId */
export function parseCommunityRibbonId(ribbonId: string): string | null {
  if (!ribbonId.startsWith(COMMUNITY_RIBBON_PREFIX)) return null;
  const pluginId = ribbonId.slice(COMMUNITY_RIBBON_PREFIX.length);
  return pluginId || null;
}

/* ------------------------------ 执行入口（宿主侧） ------------------------------ */

/** 社区插件可用的宿主 API（与 PLUGIN_DEVELOPMENT_GUIDE 对齐） */
export interface CommunityPluginHostApi {
  getMarkdown(): string;
  setMarkdown(next: string): void;
  insertMarkdown(snippet: string): void;
  getTitle(): string;
  notify(message: string, type?: 'info' | 'success' | 'error'): void;
  registerCommand(cmd: { id: string; title: string; run: () => void }): void;
}

export interface RunOutcome {
  /** 是否有可观测的文档变化 */
  changed: boolean;
  /** 插件主动 notify 的消息条数（有就是「真的执行了」的正向信号） */
  notified: number;
  /** 插件注册的命令数 */
  commands: number;
  /** 给用户看的说明（成功 / 失败都填） */
  message: string;
}

/**
 * 执行一款社区插件，并**如实返回**是否产生了效果。
 *
 * 关键点（针对「点了没反应」）：
 * - 插件没有 `setup`、或 `setup` 既没改文档也没 notify、也没注册命令
 *   => `changed=false`，调用方据此提示用户「插件执行完成但未修改文档」，
 *   而不是假装成功（这正是 1.3.1 那类「界面提示成功但什么都没发生」的缺陷）。
 * - 任何异常都转成可读中文消息并返回，不向 UI 抛裸错误。
 *
 * @param record 已装插件记录
 * @param api    宿主 API 实现（由 EditorPage 提供当前文档上下文）
 */
export function runCommunityPlugin(record: CommunityPluginRecord, api: CommunityPluginHostApi): RunOutcome {
  const before = api.getMarkdown();
  let notified = 0;
  let commands = 0;

  const proxyApi: CommunityPluginHostApi = {
    getMarkdown: () => api.getMarkdown(),
    getTitle: () => api.getTitle(),
    setMarkdown: (next) => api.setMarkdown(next),
    insertMarkdown: (snippet) => api.insertMarkdown(snippet),
    notify: (message, type) => {
      notified += 1;
      api.notify(message, type);
    },
    registerCommand: (cmd) => {
      commands += 1;
      api.registerCommand(cmd);
    },
  };

  try {
    const mod = loadPluginModule(record.codeJs);
    if (typeof mod.setup !== 'function') {
      return {
        changed: false,
        notified,
        commands,
        message: `插件「${record.name}」没有定义 setup(api)，无法执行；请检查插件是否遵循 Neo MD 插件规范。`,
      };
    }
    mod.setup(proxyApi);
    const after = api.getMarkdown();
    const changed = after !== before;
    if (changed) {
      return { changed, notified, commands, message: `插件「${record.name}」已执行，文档已更新` };
    }
    if (notified > 0 || commands > 0) {
      return { changed, notified, commands, message: `插件「${record.name}」已执行` };
    }
    return {
      changed: false,
      notified,
      commands,
      message: `插件「${record.name}」已执行，但没有产生任何变化（既未修改文档，也没有任何提示）`,
    };
  } catch (e) {
    const msg = e instanceof PluginSourceError ? e.message : `插件执行异常：${(e as Error).message}`;
    return { changed: false, notified, commands, message: msg };
  }
}
