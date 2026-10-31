import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import type { EditorColorScheme, ServerSettings, Settings, ThemePreset, ThemeScope } from '@neomd/shared';
import {
  ALL_THEME_VARS,
  CONTENT_THEME_VARS,
  CHROME_THEME_VARS,
  STRUCTURAL_THEME_VARS,
  allThemes,
  findTheme,
  legacyCustomTheme,
  legacyThemeId,
  resolveTheme,
  scopedThemeVars,
  themeVarAllowed,
  themeVars,
} from '@neomd/shared';
import { mergeSettings, defaultSettings, SETTINGS_KEY, detectRuntime } from '@neomd/core';
import { api, getAccessToken } from '@/api/client';
import { DEFAULT_SERVER_SETTINGS, normalizeServerBase } from '@/lib/server-endpoint';

/**
 * 变量分类表与作用域判定的**权威来源**都在 `@neomd/shared`。
 *
 * 这里 re-export 是为了向后兼容（1.1.1 - 1.3.1 期间它们从本文件导出，
 * SettingsPage / 历史脚本 / 取证脚本都按 `@/stores/settings` 引用）。
 * 1.4.0 把数据源搬走的原因见 themes.ts 里「主题变量的语义分档」注释：
 * 两处各维护一份清单必然漂移 ——「仅正文」白名单漏项就是这么来的。
 */
export { ALL_THEME_VARS, CONTENT_THEME_VARS, CHROME_THEME_VARS, STRUCTURAL_THEME_VARS, themeVarAllowed };

/**
 * `applyTheme()` 的可选覆盖。
 *
 * 引入原因（需求 16）：设置改为「草稿 + 保存」后，主题预览必须能在**不写 store**
 * 的前提下改 CSS 变量。`appearance` 就是那份草稿外观；`scope` 允许调用方临时
 * 指定作用域（切换「应用范围」时立即重算，不必等 localStorage 写回）。
 */
interface ThemeVarApplyOverride {
  appearance?: Settings['appearance'];
  scope?: ThemeScope;
}

/**
 * `commitDraft()` 的敏感字段补丁。
 *
 * 密钥类字段在网页端**只留在内存**（`persist()` 会先把它们清空再写 localStorage），
 * 因此草稿模式对它们只能是「先记在页面内存、保存时才写进 store」，
 * 不能像普通设置项那样整份快照进 localStorage。
 */
interface CommitDraftSecrets {
  storageKeyId?: string;
  storageSecret?: string;
  aiKey?: string;
}


/**
 * 给 settings 补齐服务端配置默认值。
 *
 * `@neomd/core` 的 `defaultSettings()` / `mergeSettings()` 不认 `server` 字段，
 * 而它是 1.0.2 新增的**纯本地**配置（永不上云），因此只能在 store 层兜底，
 * 避免各处读 `settings.server.xxx` 时拿到 undefined 而白屏。
 */
function withServerDefaults(source: Settings): Settings {
  const server = source.server;
  return {
    ...source,
    server: {
      mode: server?.mode === 'custom' ? 'custom' : 'official',
      customBaseUrl: typeof server?.customBaseUrl === 'string' ? server.customBaseUrl : '',
      privacyMode: server?.privacyMode === true,
    },
  };
}

function loadLocal(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return withServerDefaults(defaultSettings());
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // 先做旧主题方案迁移，再合并默认值：顺序反了会把用户的旧配色判成「没配过」。
    // 详见 migrateLegacyAppearance() 的注释（必须在 mergeSettings 之前）。
    const merged = mergeSettings(defaultSettings(), migrateSettingsTheme(parsed));
    // server 是严格本地配置，云端不下发也不覆盖；用本地已存的值优先。
    return withServerDefaults({ ...merged, server: parsed.server ?? merged.server });
  } catch {
    return withServerDefaults(defaultSettings());
  }
}

/* ------------------------------------------------------------------ */
/* 多端分区同步                                                        */
/*                                                                     */
/* global 区（全平台强一致）：storage / ai / sync / naming / shortcuts  */
/* platform 区（允许按端差异化）：appearance / layout / enabledPlugins  */
/* 永不上云（严格本地）：server / localVault / cloudVersion / updatedAt  */
/* ------------------------------------------------------------------ */

/** 云端设置响应：v2 服务端返回拍平视图；旧服务端直接返回平铺 Settings */
interface CloudSettingsResponse {
  payload: Record<string, unknown> | null;
  sensitive: Record<string, unknown> | null;
  version: number;
  updatedAt?: string | null;
  deviceId?: string | null;
  platform?: string | null;
}

interface CloudSensitive {
  storage?: { accessKeyId?: string; accessKeySecret?: string };
  ai?: { apiKey?: string };
}

/** 允许按平台差异化的分区，其余分区默认进 global */
const PLATFORM_SCOPED_KEYS = new Set(['appearance', 'layout', 'enabledPlugins']);
/** 严格本地、永不上云的分区（自定义服务器 / 私有化、本地仓库根目录、版本水位） */
const LOCAL_ONLY_KEYS = new Set(['server', 'localVault', 'cloudVersion', 'updatedAt', 'version']);

/**
 * `appearance` 里**应当跨端强一致**的字段（进 global 区）。
 * 分层原则（1.1.1 建立，1.1.8 补入字体）：
 * - **观感选择**（用户对产品外观的偏好，换设备应当一致）→ global；
 * - **阅读体验**（与屏幕尺寸/观看距离相关，按设备可以不同）→ platform。
 * 为什么要拆而不是把整个 `appearance` 挪到 global：
 * `fontSize` / `lineHeight` / `zoom` / `pageWidth` / `showLineNumbers` 属于阅读体验，PC 大屏与手机小屏本来就该不同，必须留在 platform 区按端差异化；
 *
 * 而下面这些是观感选择，换设备必须一致 —— 否则就会出现「Web 端换了主题/字体，PC 端没变」。
 * 1.1.8 补入 `fontFamily`：用户换字体是「我要用这个字体看正文」的偏好，与设备无关；
 * 原先它留在 platform 区，导致 PC 设了字体网页端不跟随。（字号不跟着走是刻意的：24px 在手机上会明显偏大。） */
const GLOBAL_APPEARANCE_FIELDS = [
  'theme',
  'themePresetId',
  'accent',
  'customThemes',
  'fontFamily',
  'editorColorScheme',
  'customEditorBg',
  'customEditorFg',
] as const;

const GLOBAL_APPEARANCE_FIELD_SET = new Set<string>(GLOBAL_APPEARANCE_FIELDS);

/**
 * 把 `appearance` 拆成「跨端一致字段」与「本机阅读体验字段」两组。
 * 容错：非对象输入返回两个空对象，由调用方决定是否落盘；避免旧版本把 `appearance` 写坏成字符串时整条同步链路抛错。 */
function splitAppearanceFields(appearance: unknown): {
  themePart: Record<string, unknown>;
  readingPart: Record<string, unknown>;
} {
  const themePart: Record<string, unknown> = {};
  const readingPart: Record<string, unknown> = {};
  if (!appearance || typeof appearance !== 'object' || Array.isArray(appearance)) {
    return { themePart, readingPart };
  }
  for (const [field, value] of Object.entries(appearance as Record<string, unknown>)) {
    if (GLOBAL_APPEARANCE_FIELD_SET.has(field)) themePart[field] = value;
    else readingPart[field] = value;
  }
  return { themePart, readingPart };
}

/** `appearance` 里是否含至少一个主题字段（用于判断旧 payload 是否需要迁移） */
export function appearanceHasThemeFields(appearance: unknown): boolean {
  if (!appearance || typeof appearance !== 'object') return false;
  return GLOBAL_APPEARANCE_FIELDS.some(
    (f) => (appearance as Record<string, unknown>)[f] !== undefined,
  );
}

/**
 * 老用户数据的一次性迁移：把旧版「正文配色方案」迁到「主题预设」。
 * 为什么必须做、且必须**在合并默认值之前**做：
 * - `defaultSettings()` 现在自带 `themePresetId: 'daylight'`；
 * - 老用户的 localStorage / 云端 payload 里**没有** `themePresetId`，只有 `editorColorScheme`；
 * - 一旦先 `mergeSettings(defaultSettings(), raw)`，`themePresetId` 就被补成 `'daylight'`，
 *   `resolveTheme()` 会直接命中内置主题，**永远走不到** `editorColorScheme` 的映射分支，
 *   结果就是「老用户的绿色护眼升级后变成日光白」。
 *
 * 判定依据严格：只有**完全没有** `themePresetId` 字段时才迁移，绝不覆盖用户已选的主题。
 */
export function migrateLegacyAppearance(appearance: unknown): Record<string, unknown> | null {
  if (!appearance || typeof appearance !== 'object' || Array.isArray(appearance)) return null;
  const ap = { ...(appearance as Record<string, unknown>) };
  const preset = ap.themePresetId;
  // 只有完全没有 themePresetId 时才迁移：用户已经选过主题就一律不动，避免覆盖新数据
  if (typeof preset === 'string' && preset.trim()) return null;

  const scheme = ap.editorColorScheme;
  if (typeof scheme !== 'string' || !scheme) return null;

  if (scheme === 'custom') {
    // 旧版「自定义配色」→ 合成一套自定义主题并选中，视觉与原来完全一致
    const legacy = legacyCustomTheme(ap);
    const existing = Array.isArray(ap.customThemes) ? (ap.customThemes as unknown[]) : [];
    const hasIt = existing.some(
      (t) => t && typeof t === 'object' && (t as { id?: string }).id === legacy.id,
    );
    ap.customThemes = hasIt ? existing : [...existing, legacy];
    ap.themePresetId = legacy.id;
    return ap;
  }

  const mappedId = legacyThemeId(scheme as 'white' | 'gray' | 'black' | 'green' | 'lightblue');
  if (!mappedId) return null;
  ap.themePresetId = mappedId;
  return ap;
}

/**
 * 对任意来源的设置对象做老数据主题迁移（不改原对象）。
 * 返回值断言说明：`migrateLegacyAppearance` 只是对 appearance 做浅拷贝 + 补
 * `themePresetId` / `customThemes`，不删除任何字段，因此迁移后的对象仍满足
 * `AppearanceSettings` 的完整结构；断言是为了绕开「Partial<Settings> 里 appearance
 * 仍是完整类型」与迁移函数返回 `Record<string, unknown>` 之间的形式差异。
 */
function migrateSettingsTheme(input: Partial<Settings>): Partial<Settings> {
  const migrated = migrateLegacyAppearance(input.appearance);
  if (!migrated) return input;
  // 这里的 appearance 来自旧数据，migrateLegacyAppearance 可能补出 themePresetId；
  // 先把迁移结果收窄成 AppearanceSettings，再放回 Settings。
  // 这里必须分两步断言：`Record<string, unknown>` → `AppearanceSettings` 是「收窄」，
  // 一步写 `as Partial<Settings>` 会因 appearance 字段类型不兼容而报 TS2322。
  const appearance = migrated as unknown as Settings['appearance'];
  return { ...input, appearance };
}


/* ------------------------------------------------------------------ */
/* 主题「应用范围」（1.1.1 引入，1.4.0 修正语义）                        */
/*                                                                     */
/* ## 1.4.0 修的是什么（需求 12）                                       */
/*                                                                     */
/* 1.1.1 的实现把「正文专属变量」写死成 5 个，切换范围时对不允许的变量执行  */
/* `root.style.removeProperty(key)`。但 `themes.css` 里有                 */
/* `:root[data-theme-preset='midnight'] { --bg: #1b1f26; … }` ——        */
/* 删掉内联样式后这条静态主题规则立刻接管，`--bg` 仍是主题的侧栏色，      */
/* 于是「仅正文」看起来完全没生效（实测：内联已清空，computed 不变）。    */
/*                                                                     */
/* 现在的做法：                                                          */
/* - 分类表搬进 `@neomd/shared`（`CONTENT_THEME_VARS` / `CHROME_THEME_VARS` / */
/*   `STRUCTURAL_THEME_VARS`），本文件只做 re-export，避免两处清单漂移；  */
/* - 排除的一侧**显式写入中性基线值**（`scopedThemeVars()`），            */
/*   内联样式优先级高于样式表，界面才会真的回到中性。                     */
/* ------------------------------------------------------------------ */

export type { ThemeScope } from '@neomd/shared';

/** localStorage key，SettingsPage 与本 store 共用 */
export const THEME_SCOPE_STORAGE_KEY = 'neomd.themeScope';

/** 读取本机保存的应用范围 */
export function readThemeScope(): ThemeScope {
  try {
    const v = localStorage.getItem(THEME_SCOPE_STORAGE_KEY);
    if (v === 'content' || v === 'chrome') return v;
  } catch {
    /* localStorage 被禁用 */
  }
  return 'all';
}

/** 自动 pull 节流窗口：可见性/聚焦事件在 30s 内只触发一次 */
const AUTO_PULL_THROTTLE_MS = 30_000;
/** 轻量版本轮询间隔：只比版本号，云端有变化才拉全量设置 */
const CLOUD_VERSION_POLL_MS = 60_000;

/** 当前运行平台；SSR/异常环境回退 web */
function detectPlatform(): string {
  try {
    return detectRuntime().platform;
  } catch {
    return 'web';
  }
}

/**
 * 从 Settings 拆出 global（强一致）与 platform（按端差异化）两个分区。
 * 「历史版本 / AI / S3 跨端一致」的完整链路（排查时按此顺序看）：
 *   1. storage（endpoint/region/bucket/AK/SK/basePrefix）与 sync（rootPrefix）属 global
 *      → 登录后任何平台 pull 到的都是同一份，两端拼出的对象存储前缀天然相同；
 *   2. SyncEngine 在登录态把 rootPrefix 再接上 `users/<username>/`（见 stores/app.ts 的
 *      buildSyncEngine），按用户名隔离，避免多用户互相覆盖；
 *   3. 于是 A 端保存写入 `…/users/<name>/versions/<docId>/<ts>-<rev>-<hash>.md`，
 *      与 B 端「版本历史」面板 listRemoteVersions 读取的前缀完全一致 → 历史版本跨端可见。
 * 只要 storage / sync 留在 global（本函数保证这一点），这条链路就不会被平台差异化打断。
 */
function splitSettingsPartitions(source: Settings): {
  global: Record<string, unknown>;
  platform: Record<string, unknown>;
} {
  const plain = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
  const globalPart: Record<string, unknown> = {};
  const platformPart: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plain)) {
    // appearance 需要拆成两个分区，其余键按 PLATFORM_SCOPED_KEYS 归属
    if (key === 'appearance') {
      // 主题字段 → global（跨端强一致）；阅读体验字段 → platform（按端差异化）
      const { themePart, readingPart } = splitAppearanceFields(value);
      if (Object.keys(themePart).length) globalPart.appearance = themePart;
      if (Object.keys(readingPart).length) platformPart.appearance = readingPart;
      continue;
    }
    if (PLATFORM_SCOPED_KEYS.has(key)) platformPart[key] = value;
    else globalPart[key] = value;
  }
  return { global: globalPart, platform: platformPart };
}

/** 去掉只属于本机的字段，防止旧云端数据把本地路径/服务器配置带回本端 */
function stripLocalOnly(source: Record<string, unknown>): Partial<Settings> {
  const clone = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
  for (const key of LOCAL_ONLY_KEYS) delete clone[key];
  return clone as Partial<Settings>;
}

/**
 * 读取「纯 global 分区」时使用的哨兵平台名（1.2.1，缺陷2）。
 *
 * ## 为什么需要它（这是「字体设完一会儿自己恢复」的真正根因）
 *
 * 服务端 `GET /api/settings?platform=<p>` 返回的是**拍平视图**：
 *   `flattenSettings()` 用 `Object.assign(view, platform[p])` 把平台分组盖到 global 上。
 * `appearance` 是一个整体对象键，所以 `platform[p].appearance` 会**整块替换**
 * `global.appearance` —— 不是逐字段覆盖。
 *
 * 1.1.7 及更早版本把 `fontFamily` 存在平台分区里，这些旧值至今仍留在
 * `platform.desktop.appearance` / `platform.web.appearance`（生产库实测确认）。
 * 于是 1.1.8+ 改成写 global 之后，客户端拉到的拍平视图里 fontFamily 依旧是平台分区的旧值，
 * 被当成「云端权威值」覆盖回本地 —— 用户看到的就是「字体设了一下又自己恢复」。
 *
 * 而拍平响应里**没有** global / platform 键，客户端无法反推字段来源，
 * 所以这里再取一次「纯 global 视图」：服务端对未登记的平台名只返回 global
 * （该平台分组不存在 → 不覆盖），从而拿到真正的跨端权威值。
 *
 * 根治点在服务端 `flattenSettings` 的合并语义，但那不在本次改动范围内；
 * 客户端按「global 优先」取值，行为上等价于修好了。
 */
const GLOBAL_ONLY_PLATFORM = '__global_only__';

/**
 * 把「纯 global 视图」里的跨端字段覆盖到拍平结果上（只动 GLOBAL_APPEARANCE_FIELDS）。
 *
 * 只覆盖这些字段的原因：它们本来就声明为「跨端强一致」，
 * 平台分区里出现它们只可能是历史残留，必须以 global 为准。
 * 阅读体验字段（字号/行高/页宽/缩放/行号/拼写检查）**继续用平台分区的值**，
 * 这是「按端差异化」设计的底线，不能被这次修复顺手破坏。
 */
function applyGlobalAppearanceAuthority(
  flat: Record<string, unknown> | null,
  globalOnly: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!flat) return flat;
  if (!globalOnly || typeof globalOnly !== 'object') return flat;
  const globalAppearance = globalOnly.appearance;
  if (!globalAppearance || typeof globalAppearance !== 'object') return flat;
  const flatAppearance =
    flat.appearance && typeof flat.appearance === 'object'
      ? { ...(flat.appearance as Record<string, unknown>) }
      : {};
  const authoritative: Record<string, unknown> = {};
  for (const field of GLOBAL_APPEARANCE_FIELDS) {
    const value = (globalAppearance as Record<string, unknown>)[field];
    if (value !== undefined) authoritative[field] = value;
  }
  if (!Object.keys(authoritative).length) return flat;
  return { ...flat, appearance: { ...flatAppearance, ...authoritative } };
}

/**
 * 归一化云端 payload：
 * - v2：`{ global, platform: { desktop: {...} } }` → 分别取出 global 与本平台分组；
 * - 旧服务端/旧数据（无 global/platform 字段）：整体视为 global。
 * **1.1.1 主题跨端修复的两个动作（都在这里做，拉取侧唯一入口）**：
 * 1. **隔离**：把「本平台 appearance」里的主题字段剔除，只保留阅读体验字段。
 *    否则旧 payload（appearance 整体存在 platform 里）会在合并时把 global 刚同步过来的
 *    主题又覆盖回本端旧值 —— 这正是「Web 改了主题 PC 不生效」的最后一环。
 * 2. **迁移**：若 global 区完全没有主题字段（老用户升级后第一次拉），
 *    则把上面剔除下来的主题字段补进 global，实现一次性平滑迁移，
 *    不需要用户重新选一次主题。
 */
function splitRemotePayload(raw: Record<string, unknown> | null): {
  global: Record<string, unknown> | null;
  platform: Record<string, unknown> | null;
} {
  if (!raw || typeof raw !== 'object') return { global: null, platform: null };
  const grouped =
    Object.prototype.hasOwnProperty.call(raw, 'global') ||
    Object.prototype.hasOwnProperty.call(raw, 'platform');
  if (!grouped) return { global: raw, platform: null };
  const globalPart =
    raw.global && typeof raw.global === 'object' ? { ...(raw.global as Record<string, unknown>) } : null;
  const groups =
    raw.platform && typeof raw.platform === 'object'
      ? (raw.platform as Record<string, Record<string, unknown>>)
      : null;
  const rawPlatform = groups ? groups[detectPlatform()] ?? null : null;
  if (!rawPlatform) return { global: globalPart, platform: null };

  const platformPart: Record<string, unknown> = { ...rawPlatform };
  if (rawPlatform.appearance && typeof rawPlatform.appearance === 'object') {
    const { themePart, readingPart } = splitAppearanceFields(rawPlatform.appearance);
    platformPart.appearance = readingPart;
    // 平台分组里若残留主题字段（旧 payload 结构），补进 global 只做「缺失填充」，不覆盖已有值
    if (Object.keys(themePart).length) {
      const mergedGlobalAppearance = {
        ...((globalPart?.appearance && typeof globalPart.appearance === 'object'
          ? globalPart.appearance
          : {}) as Record<string, unknown>),
      };
      for (const field of GLOBAL_APPEARANCE_FIELDS) {
        if (mergedGlobalAppearance[field] === undefined && themePart[field] !== undefined) {
          mergedGlobalAppearance[field] = themePart[field];
        }
      }
      if (globalPart) globalPart.appearance = mergedGlobalAppearance;
    }
  }
  return { global: globalPart, platform: platformPart };
}

/** 归一化敏感字段：v2 分组（global + 本平台）与旧版平铺都支持 */
function splitRemoteSensitive(raw: Record<string, unknown> | null): CloudSensitive {
  if (!raw || typeof raw !== 'object') return {};
  const pick = (src: unknown): CloudSensitive =>
    src && typeof src === 'object' ? (src as CloudSensitive) : {};
  const grouped =
    Object.prototype.hasOwnProperty.call(raw, 'global') ||
    Object.prototype.hasOwnProperty.call(raw, 'platform');
  if (!grouped) return pick(raw);
  const groups =
    raw.platform && typeof raw.platform === 'object'
      ? (raw.platform as Record<string, unknown>)
      : null;
  const globalPart = pick(raw.global);
  const platformPart = pick(groups?.[detectPlatform()]);
  return {
    storage: { ...(globalPart.storage ?? {}), ...(platformPart.storage ?? {}) },
    ai: { ...(globalPart.ai ?? {}), ...(platformPart.ai ?? {}) },
  };
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings>(loadLocal());
  const ready = ref(false);

  /** 敏感字段单独存放（桌面端交给安全存储，网页端仅内存） */
  const secrets = ref<{ storageSecret: string; storageKeyId: string; aiKey: string }>({
    storageSecret: settings.value.storage.accessKeySecret ?? '',
    storageKeyId: settings.value.storage.accessKeyId ?? '',
    aiKey: settings.value.ai.apiKey ?? '',
  });

  function persist(): void {
    try {
      const snapshot = JSON.parse(JSON.stringify(settings.value)) as Settings;
      // 敏感字段不进 localStorage：网页端只留在内存，桌面端交给安全存储
      snapshot.storage.accessKeySecret = '';
      snapshot.ai.apiKey = '';
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(snapshot));
    } catch {
      /* 存储已满或被禁用时忽略 */
    }
  }

  /* ------------------------ 主题预设（1.0.2，task-3）------------------------ */

  /**
   * 「本地主题改动尚未确认推送到云端」标记（1.1.7 修复主题被云端旧值回滚）。
   *
   * 用户操作序列：选主题 → 关闭设置 → 重开设置。
   * 选主题时 `applyThemePreset()` 会 `scheduleCloudPush()`（1 秒防抖）。
   * 若这段时间内推送还没完成（或推送失败、断网、被私有化模式拦截），云端仍是**旧主题**；
   * 而重开设置页时 `SettingsPage` 会 `pullCloudSettings()`，于是 `mergeSettings` 用云端旧值
   * 把本地刚选的主题覆盖掉 —— 用户看到的就是「设置主题后再次点击设置页主题又会恢复为默认主题」。
   */
  const THEME_DIRTY_KEY = 'neomd.themeDirtySince';

  function loadThemeDirty(): number | null {
    try {
      const raw = localStorage.getItem(THEME_DIRTY_KEY);
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  const themeDirtySince = ref<number | null>(loadThemeDirty());

  function markThemeDirty(): void {
    const now = Date.now();
    themeDirtySince.value = now;
    try {
      localStorage.setItem(THEME_DIRTY_KEY, String(now));
    } catch {
      /* 存储被禁用时仅内存生效 */
    }
  }

  function clearThemeDirty(): void {
    themeDirtySince.value = null;
    try {
      localStorage.removeItem(THEME_DIRTY_KEY);
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 「本地布局已确认与云端一致」的基线快照（1.1.9）。
   *
   * ## 为什么不用「脏标记」布尔量
   *
   * 最初的实现是照抄主题那套 `*DirtySince` 布尔标记，但实测发现它**会永久置位**：
   * `updateLayout()` 除了用户拖拽，还被大量程序化路径调用（面板开合、功能区切换、
   * 启动时恢复布局状态……）。只要启动过程中有过一次 `updateLayout()`，标记就被点亮，
   * 于是**永远不再接受云端布局**——跨设备（同平台两个浏览器）的布局同步彻底失效。
   *
   * ## 现在的做法：按字段比对「本地 vs 上次同步基线」
   *
   * - `layoutBaseline` 记录**上一次与云端达成一致时**的 layout 快照；
   * - 拉取时逐字段比对：`本地值 !== 基线值` 说明这是本地未同步的改动 → 保留本地；
   *   `本地值 === 基线值` 说明本地没动过 → 接受云端值。
   *
   * 这样既不会把用户的拖拽结果回滚，也不会因为「曾经调用过 updateLayout」而永久
   * 拒绝远端更新。粒度也从「整块 layout」细化到「单个字段」——用户只改了工具栏顺序时，
   * 另一台设备改的面板宽度仍能正常同步下来。
   */
  const LAYOUT_BASELINE_KEY = 'neomd.layoutBaseline.v1';

  function loadLayoutBaseline(): Record<string, unknown> | null {
    try {
      const raw = localStorage.getItem(LAYOUT_BASELINE_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** 上一次与云端一致时的 layout 快照（null 表示还没有基线，此时完全接受云端） */
  const layoutBaseline = ref<Record<string, unknown> | null>(loadLayoutBaseline());

  /** 记录当前 layout 为「已同步基线」（推送或拉取成功后调用） */
  function snapshotLayoutBaseline(): void {
    try {
      const snap = JSON.parse(JSON.stringify(settings.value.layout ?? {})) as Record<string, unknown>;
      layoutBaseline.value = snap;
      localStorage.setItem(LAYOUT_BASELINE_KEY, JSON.stringify(snap));
    } catch {
      /* 序列化/存储失败时退化为「无基线」，下次拉取会完全接受云端 */
    }
  }

  /**
   * 拉取前快照本地 layout 与基线，用于 merge 之后把「本地未同步字段」还原回来。
   *
   * 返回一个「还原函数」而不是数据：调用点只需在 merge 之后执行它，
   * 不必了解比对细节。
   */
  function captureLocalLayoutOverrides(): () => void {
    const local = JSON.parse(JSON.stringify(settings.value.layout ?? {})) as Record<string, unknown>;
    const base = layoutBaseline.value;
    return () => {
      // 没有基线 → 首次登录该端，全盘接受云端（这是跨端首次同步的正确行为）
      if (!base) return;
      const merged = { ...(settings.value.layout ?? {}) } as Record<string, unknown>;
      let changed = false;
      for (const key of Object.keys(local)) {
        // 本地值与基线不同 = 本地有未同步改动 → 用本地值覆盖云端值
        if (JSON.stringify(local[key]) !== JSON.stringify(base[key])) {
          merged[key] = local[key];
          changed = true;
        }
      }
      if (changed) {
        // merged 由「云端合并结果 + 本地未同步字段」拼成，键集合与 LayoutSettings 一致；
        // 中间的 Record 只是逐字段比对的载体，故经 unknown 转回正式类型
        settings.value.layout = merged as unknown as Settings['layout'];
        // 让云端尽快收敛到本地值
        scheduleCloudPush();
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /* global 外观字段的「字段级基线」（1.2.1，缺陷2）                        */
  /*                                                                     */
  /* ## 为什么 1.1.9 的 themeDirtySince 兜不住 fontFamily                */
  /*                                                                     */
  /* 1.1.7 引入的 `themeDirtySince` 是**整块**脏标记，且拉取后的还原是     */
  /* 硬编码字段清单（theme / themePresetId / accent / customThemes /     */
  /* editorColorScheme / customEditorBg / customEditorFg）—— 里面**没有** */
  /* fontFamily。于是「改了字体 → PUT 还没落地 → 拉取」这条链路上，       */
  /* fontFamily 没有任何保护，直接被云端旧值覆盖回去 —— 用户看到的         */
  /* 就是「字体设了一下又自己恢复」。                                     */
  /*                                                                     */
  /* ## 为什么不能简单地把 fontFamily 补进那张清单                        */
  /*                                                                     */
  /* 那是「整块还原」：只要脏标记在，连别的设备刚改的主题也一起拒绝，       */
  /* 而脏标记又只在推送成功时清除，弱网下会长时间僵住（1.1.9 踩过的坑）。   */
  /* 这里改用与 layout 同构的**字段级基线**：                              */
  /* - `appearanceBaseline` 记录上一次与云端达成一致时的 global 外观字段； */
  /* - 拉取时逐字段比对：本地值 !== 基线值 → 本地有未推送改动 → 保留本地； */
  /* - 本地值 === 基线值 → 本地没动过 → 接受云端值（跨端同步仍然有效）。   */
  /* 粒度到字段：只改字体时，另一台设备改的主题照样能同步下来。            */
  /*                                                                     */
  /* 基线只在「该字段确实与云端一致」时推进：拉取时被本地还原过的字段       */
  /* **不更新基线**（见 snapshotAppearanceBaseline 的 skip 参数），否则     */
  /* 会把「本地未推送值」误标成已同步，下一次拉取又会把它冲掉。            */
  /* ------------------------------------------------------------------ */
  const APPEARANCE_BASELINE_KEY = 'neomd.appearanceBaseline.v1';

  function loadAppearanceBaseline(): Record<string, unknown> | null {
    try {
      const raw = localStorage.getItem(APPEARANCE_BASELINE_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** 上一次与云端一致时的 global 外观字段快照（null = 还没有基线，此时完全接受云端） */
  const appearanceBaseline = ref<Record<string, unknown> | null>(loadAppearanceBaseline());

  /**
   * 把当前 global 外观字段记为「已同步基线」。
   *
   * @param skip 这些字段**不**推进基线（它们在本次拉取中被本地值还原，云端还没有）。
   *   省略即「全部字段都与云端一致」（推送成功时调用）。
   */
  function snapshotAppearanceBaseline(skip: readonly string[] = []): void {
    try {
      const current = settings.value.appearance as unknown as Record<string, unknown>;
      const prev = appearanceBaseline.value ?? {};
      const snap: Record<string, unknown> = {};
      for (const field of GLOBAL_APPEARANCE_FIELDS) {
        if (skip.includes(field) && prev[field] !== undefined) {
          // 保留旧基线：该字段仍属「本地未同步」，下次拉取要继续保护
          snap[field] = prev[field];
          continue;
        }
        if (current[field] !== undefined) snap[field] = JSON.parse(JSON.stringify(current[field]));
      }
      appearanceBaseline.value = snap;
      localStorage.setItem(APPEARANCE_BASELINE_KEY, JSON.stringify(snap));
    } catch {
      /* 序列化/存储失败时退化为「无基线」，下次拉取会完全接受云端 */
    }
  }

  /**
   * 「本地已改、还没成功推到云端」的 global 外观字段集合（1.2.1，缺陷2）。
   *
   * ## 为什么光有基线还不够
   *
   * 基线只在「曾经与云端对齐过一次」之后才存在。新装/清缓存/换设备的**第一次**
   * 打开时 `appearanceBaseline` 是 null，此时按设计要全盘接受云端 —— 但用户紧接着
   * 改字体、这次 PUT 又因为弱网/429 失败了，下一次拉取就会把这个改动冲掉。
   * 这正是用户描述的「改了一下又自己恢复」最容易命中的路径。
   *
   * ## 为什么不是又一个布尔脏标记
   *
   * 1.1.9 的教训是 `themeDirtySince` 这类**整块**布尔量会永久僵住。这里是
   * **字段级集合**且**只在推送成功时清空对应字段**：
   * - 只有真正被用户改过的字段才进集合，别的字段照常同步；
   * - 推送一旦成功（哪怕只成功一次）就清空，不会永久拒绝云端。
   *
   * 持久化到 localStorage：刷新页面后仍能保护住还没推上去的改动。
   */
  const APPEARANCE_PENDING_KEY = 'neomd.appearancePending.v1';

  function loadAppearancePending(): Set<string> {
    try {
      const raw = localStorage.getItem(APPEARANCE_PENDING_KEY);
      if (!raw) return new Set();
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      // 只保留仍在 GLOBAL_APPEARANCE_FIELDS 名单里的字段，防止旧版本残留的键无限堆积
      return new Set(parsed.filter((f): f is string => typeof f === 'string' && GLOBAL_APPEARANCE_FIELD_SET.has(f)));
    } catch {
      return new Set();
    }
  }

  const appearancePending = ref<Set<string>>(loadAppearancePending());

  function persistAppearancePending(): void {
    try {
      localStorage.setItem(APPEARANCE_PENDING_KEY, JSON.stringify([...appearancePending.value]));
    } catch {
      /* 存储被禁用时仅内存生效 */
    }
  }

  /** 标记若干 global 外观字段「本地已改、待推送」 */
  function markAppearancePending(fields: readonly string[]): void {
    if (!fields.length) return;
    const next = new Set(appearancePending.value);
    for (const f of fields) if (GLOBAL_APPEARANCE_FIELD_SET.has(f)) next.add(f);
    appearancePending.value = next;
    persistAppearancePending();
  }

  /** 推送成功后清空待推送集合（云端已收下这些值，不再需要保护） */
  function clearAppearancePending(): void {
    if (!appearancePending.value.size) return;
    appearancePending.value = new Set();
    persistAppearancePending();
  }

  /**
   * 拉取前快照本地 global 外观字段，用于 merge 之后把「本地未同步字段」还原回来。
   *
   * 返回还原函数：执行后返回**被还原的字段名**（调用方据此决定基线怎么推进）。
   */
  function captureLocalAppearanceOverrides(): () => string[] {
    const local = JSON.parse(JSON.stringify(settings.value.appearance ?? {})) as Record<string, unknown>;
    const base = appearanceBaseline.value;
    const pending = new Set(appearancePending.value);
    return () => {
      const restored: string[] = [];
      const merged = { ...(settings.value.appearance ?? {}) } as Record<string, unknown>;
      for (const field of GLOBAL_APPEARANCE_FIELDS) {
        const localValue = local[field];
        if (localValue === undefined) continue;
        /*
         * 保护条件（任一成立即保留本地值）：
         *  a) 该字段在「待推送」集合里 —— 用户刚改过、推送还没成功（无基线时也能兜住）；
         *  b) 有基线且本地值 !== 基线值 —— 本地改过而云端不知道。
         * 两条都不成立 = 本地没动过 → 接受云端值，跨端同步照常生效。
         */
        const isPending = pending.has(field);
        const differsFromBaseline = Boolean(base) && JSON.stringify(localValue) !== JSON.stringify(base?.[field]);
        if (!isPending && !differsFromBaseline) continue;
        merged[field] = localValue;
        restored.push(field);
      }
      if (restored.length) {
        // merged = 云端合并结果 + 本地未同步字段，键集合与 AppearanceSettings 一致；
        // 中间的 Record 只是逐字段比对的载体，故经 unknown 转回正式类型
        settings.value.appearance = merged as unknown as Settings['appearance'];
        // 让云端尽快收敛到本地值
        scheduleCloudPush();
      }
      return restored;
    };
  }

  /** 正文缩放比例夹紧到 50-300（与 stores/app.ts 的 zoom 逻辑保持同一口径） */
  function clampZoomPercent(v: number): number {
    if (!Number.isFinite(v)) return 100;
    return Math.min(300, Math.max(50, Math.round(v)));
  }
  /* 与 task-2（server）、task-4（cloud sync）共用本文件：本段只放主题相关代码，
     请勿在此文件其它位置做无关整理，以免与并行改动冲突。 */

  /**
   * 把一套外观设置折算成 CSS 变量写到 `<html>`（需求 11 / 12 / 13 的共同落点）。
   *
   * @param theme    要应用的主题
   * @param override 可选的外观覆盖（**草稿预览**走这里：只改 CSS 变量，不进 store、
   *                 不推云端）。省略时读 store 里的正式值。
   *
   * ## 三条 1.4.0 的修正
   *
   * 1. **作用域**改用 `scopedThemeVars()`：排除的一侧写中性基线值，而不是
   *    `removeProperty()` —— 删掉内联样式会回落到 `themes.css` 里同一套主题的
   *    静态规则，界面照样被染色（这是「仅正文仍全局生效」的根因）。
   * 2. **结构色保护**：`themeVars()` 内部已过 `protectStructuralColors()`，
   *    分割线对背景的对比度保证 ≥ 1.2:1（需求 11）。
   * 3. **颜色细化（accent）**：`appearance.accent` 仍优先于主题自带强调色，
   *    但只在用户**显式改过**时生效 —— 见下面 `accentOverride` 的取值逻辑。
   */
  function applyThemeVars(theme: ThemePreset, override?: ThemeVarApplyOverride): void {
    const root = document.documentElement;
    const appearance = override?.appearance ?? settings.value.appearance;
    /**
     * 强调色优先级：草稿/设置里的 `accent` > 主题自带 `accent`。
     *
     * 1.4.0 之前这里是「只要 appearance.accent 有值就覆盖」，而
     * `applyThemePreset()` 每次都把 `appearance.accent` 写成**主题值**，
     * 于是「颜色细化」里改的强调色会被上一轮的主题 accent 吞掉（需求 13）。
     * 现在把「用户显式改色」与「主题同步」区分开：
     * - `appearance.accent` 有值且**与主题 accent 不同** → 用户改过，以用户值优先；
     * - 相同（applyThemePreset 写入的镜像值）→ 视为「跟随主题」，直接用主题值。
     */
    const accentRaw = appearance.accent?.trim();
    const accentOverrideValue =
      accentRaw && accentRaw.toLowerCase() !== theme.accent.toLowerCase() ? accentRaw : '';
    const effective: ThemePreset = accentOverrideValue ? { ...theme, accent: accentOverrideValue } : theme;
    const scope = override?.scope ?? readThemeScope();
    const vars = scopedThemeVars(effective, scope);
    // 先清空上一次写入的变量，避免某套主题少产出某个键时残留上一套的值
    for (const key of ALL_THEME_VARS) root.style.removeProperty(key);
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, value);
    }
    // 排查用：让审计脚本能直接读到「当前生效的范围」，不必去翻 localStorage
    root.dataset.themeScope = scope;
  }

  /**
   * 应用外观相关的全部 CSS 变量（主题 + 排版）。
   *
   * @param override 草稿预览用；省略 = 用 store 里的正式设置。
   */
  function applyTheme(override?: ThemeVarApplyOverride): void {
    if (typeof document === 'undefined') return;
    const appearance = override?.appearance ?? settings.value.appearance;
    const root = document.documentElement;
    const prefersDark =
      typeof window !== 'undefined'
        ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
        : false;
    // 未显式选主题时的明暗回退依据 prefers-color-scheme
    // 主题决定整体明暗：未显式选主题的旧数据由 resolveTheme 按 appearance.theme
    // 回退到对应明暗的内置主题（dark → 午夜黑，其余 → 日光白），老用户外观不突变。
    const theme = resolveTheme(appearance, { prefersDark });
    root.dataset.themePreset = theme.id;
    root.dataset.theme = theme.mode === 'dark' ? 'dark' : 'light';
    applyThemeVars(theme, override);
    // 正文缩放：以 fontSize 为基准按 zoom 百分比放大字号，行高同步换算；只影响正文排版
    const zoom = clampZoomPercent(appearance.zoom ?? 100);
    // 这样只影响正文排版，不会像 CSS zoom 那样把侧栏/工具栏一起放大。
    const scaledFont = Math.round(appearance.fontSize * (zoom / 100) * 100) / 100;
    root.style.setProperty('--content-font-size', `${scaledFont}px`);
    root.style.setProperty('--content-line-height', String(appearance.lineHeight));
    /**
     * 正文字体（1.1.8 修复「设置字体不生效」）。
     *
     * 根因：`content.css` 里 `.nm-content` 写的是 `font-family: var(--font-content)`，
     * 而 `--font-content` 此前只在 `index.css` 里被静态定义为 `var(--font-ui)`，
     * **从来没有读取过用户的 `appearance.fontFamily`** —— 于是设置里换字体在界面上毫无变化。 */
    const family = String(appearance.fontFamily ?? '').trim();
    if (family) {
      root.style.setProperty('--font-content', family);
    } else {
      // 未设置字体时回落到界面字体，保持与界面一致的默认观感
      root.style.setProperty('--font-content', 'var(--font-ui)');
    }
      // 页面级缩放单独存一份，供需要的样式读取（不影响界面组件）
    root.style.setProperty('--content-zoom', String(zoom / 100));
    root.dataset.contentZoom = String(zoom);
  }

  /**
   * 「实时预览」：把**草稿**外观应用到界面，但不写 store、不推云端。
   *
   * 需求 16 要求设置改为「草稿 + 保存」语义，同时又不能把主题预览做得像死物 ——
   * 所以预览单独走这条通道：改 CSS 变量立即看得见，点「保存」才落到 store。
   * 关闭预览或取消时传 `null`，界面回到 store 里的正式值。
   */
  function previewAppearance(draft: Settings['appearance'] | null): void {
    if (draft) applyTheme({ appearance: draft });
    else applyTheme();
  }

  /**
   * 一次性提交设置页草稿（需求 16 的核心入口）。
   *
   * 为什么不是循环调用 `update()` / `updateAppearance()` / `updateLayout()`：
   * 那会把 `applyTheme()` + `persist()` + `scheduleCloudPush()` 各跑三遍 ——
   * `scheduleCloudPush()` 虽只出一次推送（1s 防抖），但会白做两次全量主题重算
   * （26 个变量 × setProperty），且中间态会让「结构色纠正」按半套设置算一次、
   * 视觉上闪一下。
   *
   * @param next 待合并的整份设置（设置页草稿，已含 appearance / layout）
   * @param secrets 可选：草稿里的敏感字段，保存时一并落到 store（不进 localStorage）
   */
  function commitDraft(next: Partial<Settings>, secretsPatch?: CommitDraftSecrets): void {
    const prevAppearance = settings.value.appearance;
    /*
     * 与 `updateAppearance()` 保持同一套「切明暗时自动换主题预设」的行为：
     * 用户在草稿里点「深色」而当前主题是浅色，保存后必须真的变深色，
     * 否则 `resolveTheme()` 会因为 `themePresetId` 仍是浅色主题而忽略 `theme`。
     */
    if (next.appearance && next.appearance.theme !== prevAppearance.theme) {
      const adjusted = { ...prevAppearance, ...next.appearance };
      const prefersDark =
        typeof window !== 'undefined'
          ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
          : false;
      const wantDark = adjusted.theme === 'dark' || (adjusted.theme === 'system' && prefersDark);
      const currentPreset = findTheme(adjusted.themePresetId, adjusted.customThemes);
      if (!currentPreset || (currentPreset.mode === 'dark') !== wantDark) {
        const targetTheme = findTheme(wantDark ? 'midnight' : 'daylight', adjusted.customThemes);
        if (targetTheme) {
          adjusted.themePresetId = targetTheme.id;
          adjusted.editorColorScheme = PRESET_TO_LEGACY_SCHEME[targetTheme.id] ?? 'custom';
          adjusted.customEditorBg = targetTheme.contentBg;
          adjusted.customEditorFg = targetTheme.contentFg;
        }
      }
      next = { ...next, appearance: adjusted };
    }
    settings.value = mergeSettings(settings.value, next);
    settings.value.updatedAt = Date.now();
    /*
     * 主题类字段的「本地已改、待推送」标记：按**保存后的值 vs 保存前**逐字段比对，
     * 而不是像 `updateAppearance()` 那样看「patch 里出现过哪些键」——
     * 草稿里可能整份 appearance 都在，但真正变化的只有一两个字段。
     */
    if (next.appearance) {
      const after = settings.value.appearance as unknown as Record<string, unknown>;
      const changed = GLOBAL_APPEARANCE_FIELDS.filter(
        (f) => JSON.stringify(after[f]) !== JSON.stringify((prevAppearance as unknown as Record<string, unknown>)[f]),
      );
      if (GLOBAL_APPEARANCE_FIELD_SET.has('theme') && changed.includes('theme')) markThemeDirty();
      markAppearancePending(changed);
    }
    if (secretsPatch) {
      if (secretsPatch.storageKeyId !== undefined) {
        secrets.value.storageKeyId = secretsPatch.storageKeyId;
        settings.value.storage.accessKeyId = secretsPatch.storageKeyId;
      }
      if (secretsPatch.storageSecret !== undefined) {
        secrets.value.storageSecret = secretsPatch.storageSecret;
        settings.value.storage.accessKeySecret = secretsPatch.storageSecret;
      }
      if (secretsPatch.aiKey !== undefined) {
        secrets.value.aiKey = secretsPatch.aiKey;
        settings.value.ai.apiKey = secretsPatch.aiKey;
      }
    }
    persist();
    applyTheme();
    scheduleCloudPush();
  }

  /**
   * 旧版「正文配色方案」→ 主题 id 的反向同步表。
   * `EditorPage.vue` 仍读 `editorColorScheme` 生成正文内联样式（该文件由 Lead 挂载，
   * 本任务不改），因此应用主题时必须把老字段写成等价方案，否则旧内联色会盖住新的主题变量。 */
  const PRESET_TO_LEGACY_SCHEME: Record<string, EditorColorScheme> = {
    daylight: 'white',
    graphite: 'gray',
    midnight: 'black',
    'eyecare-green': 'green',
    'ocean-blue': 'lightblue',
  };

  /** 应用主题预设（内置或自定义）：同步维护旧版正文字段与明暗基调，保证全链路一致 */
  function applyThemePreset(id: string): void {
    const appearance = settings.value.appearance;
    const theme = findTheme(id, appearance.customThemes);
    if (!theme) return;
    settings.value.appearance = {
      ...appearance,
      theme: theme.mode,
      themePresetId: theme.id,
      accent: theme.accent,
      editorColorScheme: PRESET_TO_LEGACY_SCHEME[theme.id] ?? 'custom',
      customEditorBg: theme.contentBg,
      customEditorFg: theme.contentFg,
    };
    markThemeDirty();
    // 主题预设会一次性改掉多个 global 外观字段，同样要进「待推送」集合，
    // 否则推送失败时这些字段在下一次拉取会被云端旧值覆盖（缺陷2 的同一条链路）
    markAppearancePending([
      'theme',
      'themePresetId',
      'accent',
      'editorColorScheme',
      'customEditorBg',
      'customEditorFg',
    ]);
    persist();
    applyTheme();
    scheduleCloudPush();
  }

  /** 当前生效主题（响应式；未选主题时按旧字段回退） */
  const activeTheme = computed<ThemePreset>(() => {
    const prefersDark =
      typeof window !== 'undefined'
        ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
        : false;
    return resolveTheme(settings.value.appearance, { prefersDark });
  });

  /** 主题库：内置主题 + 用户自定义主题 */
  const themeList = computed<ThemePreset[]>(() => allThemes(settings.value.appearance.customThemes));

  let cloudPushTimer: ReturnType<typeof setTimeout> | null = null;
  let autoPullTimer: ReturnType<typeof setTimeout> | null = null;
  let versionPollTimer: ReturnType<typeof setInterval> | null = null;
  let lastAutoPullAt = 0;
  let autoPullInstalled = false;
  let pullingCloud = false;
  /**
   * 拉取过程中发现有本地未同步改动、需要补一次推送（1.2.1）。
   *
   * 为什么必须单独记这个标记：`scheduleCloudPush()` 在 `pullingCloud` 为 true 时
   * **直接 return**（避免拉取中途又发推送导致互相打架）。而「还原本地未同步字段」
   * 恰恰发生在拉取过程中，那里调用的 `scheduleCloudPush()` 永远不会生效。
   *
   * 结果是：本地改动被基线保护住了（不会丢），但**永远也推不上去** ——
   * 正是 1.1.9「脏标记永久僵住」的另一种形态。所以这里在拉取结束时补发一次。
   */
  let pushAfterPull = false;

  function scheduleCloudPush(): void {
    if (pullingCloud) {
      // 拉取中：记下来，等拉取结束后补发（见 finally 里的 pushAfterPull）
      pushAfterPull = true;
      return;
    }
    if (!getAccessToken()) return;
    if (cloudPushTimer) clearTimeout(cloudPushTimer);
    cloudPushTimer = setTimeout(() => {
      cloudPushTimer = null;
      void pushCloudSettings();
    }, 1000);
  }

  /**
   * 节流后的自动拉取（30s 窗口）。 */
  function requestCloudPull(): void {
    if (!getAccessToken()) return;
    const wait = AUTO_PULL_THROTTLE_MS - (Date.now() - lastAutoPullAt);
    if (wait <= 0) {
      void pullCloudSettings();
      return;
    }
    if (autoPullTimer) return;
    autoPullTimer = setTimeout(() => {
      autoPullTimer = null;
      if (getAccessToken()) void pullCloudSettings();
    }, wait);
  }

  async function pullCloudSettings(): Promise<void> {
    if (!getAccessToken()) return;
    if (pullingCloud) return;
    pullingCloud = true;
    lastAutoPullAt = Date.now();
    try {
      const platform = detectPlatform();
      const res = await api<CloudSettingsResponse>(
        `/api/settings?platform=${encodeURIComponent(platform)}`,
        { auth: true },
      );
      const remoteVer = Number(res.version ?? 0);
      /*
       * 再取一次「纯 global 视图」，用它纠正拍平视图里被平台分区遮蔽的跨端外观字段。
       *
       * 这一步是缺陷2 的关键修复：拍平视图的 `appearance` 会被
       * `platform.<p>.appearance` **整块替换**，而 1.1.7 遗留在平台分区里的
       * fontFamily 旧值正是「字体设完自己恢复」的来源。取不到时（老服务端 /
       * 私有化模式）静默退化为原行为，只信任拍平视图。
       */
      let globalOnlyPayload: Record<string, unknown> | null = null;
      try {
        const globalRes = await api<CloudSettingsResponse>(
          `/api/settings?platform=${encodeURIComponent(GLOBAL_ONLY_PLATFORM)}`,
          { auth: true },
        );
        globalOnlyPayload = globalRes.payload ?? null;
      } catch {
        /* 忽略：退化为仅用拍平视图 */
      }
      const correctedPayload = applyGlobalAppearanceAuthority(res.payload, globalOnlyPayload);
      const { global: remoteGlobal, platform: remotePlatform } = splitRemotePayload(correctedPayload);
      /*
       * 本地 global 外观字段（主题 / 字体 / 强调色 / 自定义主题……）的未推送改动保护。
       *
       * 1.2.1 起改为**字段级基线**，不再用 1.1.7 那张硬编码清单：
       * 老清单漏了 fontFamily，导致「改字体 → 推送没落地 → 拉取」时字体被云端旧值
       * 直接冲掉（缺陷2）。逐字段比对既能保护刚改的字段，又不会像整块脏标记那样
       * 永久拒绝云端（1.1.9 的教训）。
       */
      const restoreLocalAppearance = captureLocalAppearanceOverrides();
      // 布局同理：本地有未同步改动时，merge 后要把本地 layout 原样还原（1.1.9）
      const restoreLocalLayout = captureLocalLayoutOverrides();

      // global 区：强一致，云端值覆盖本地 —— 任何平台登录后都拿到同一份 S3 / AI / 同步前缀 / 命名 / 快捷键
      // 主题：global 里可能来自旧 payload（只有 editorColorScheme），合并前先迁移成 themePresetId
      if (remoteGlobal) {
        settings.value = mergeSettings(settings.value, migrateSettingsTheme(stripLocalOnly(remoteGlobal)));
      }
      // global 区已合并完毕，下面处理本平台分组的阅读体验字段
      // 注意：这里的 appearance 已被 splitRemotePayload 剔除主题字段，只含阅读体验字段，
      // 因此不会把 global 刚同步过来的主题覆盖回本端旧值（这正是跨端不生效的最后一环）。
      if (remotePlatform) {
        settings.value = mergeSettings(settings.value, stripLocalOnly(remotePlatform));
      }

      /*
       * 还原本地未推送的 global 外观字段（含 fontFamily）。
       * 必须在两次 merge 之后执行 —— 否则会被云端值重新盖掉。
       */
      const restoredAppearanceFields = restoreLocalAppearance();

      /*
       * 还原本地未同步的布局字段（逐字段比对基线，见 captureLocalLayoutOverrides）。
       *
       * 只还原「本地改过而云端不知道」的字段：工具栏顺序 / 功能区 / 面板宽度都是
       * 还原本地未同步的布局字段（逐字段比对基线，见 captureLocalLayoutOverrides）。
       * 而本地没动过的字段仍接受云端值，保证另一台设备的改动能同步下来。
       * 放在外观字段还原之后、cloudVersion 赋值之前，二者作用对象不重叠（layout vs appearance）。
       */
      restoreLocalLayout();

      const sens = splitRemoteSensitive(res.sensitive);
      if (sens.storage?.accessKeyId) {
        secrets.value.storageKeyId = sens.storage.accessKeyId;
        settings.value.storage.accessKeyId = sens.storage.accessKeyId;
      }
      if (sens.storage?.accessKeySecret) {
        secrets.value.storageSecret = sens.storage.accessKeySecret;
        settings.value.storage.accessKeySecret = sens.storage.accessKeySecret;
      }
      if (sens.ai?.apiKey) {
        secrets.value.aiKey = sens.ai.apiKey;
        settings.value.ai.apiKey = sens.ai.apiKey;
      }
      settings.value.cloudVersion = remoteVer;
      /*
       * 拉取成功且已处理完「本地未同步字段」→ 此刻的 layout 就是与云端一致的基线。
       * 若本地仍有未同步字段，restoreLocalLayout() 内部已安排一次推送，
       * 推送成功时会把基线更新为含本地改动的版本。
       */
      snapshotLayoutBaseline();
      /*
       * global 外观字段的基线同理，但必须**跳过本次被还原的字段**：
       * 它们的本地值云端还没有，若也写进基线，下一次拉取就会误判为「本地没动过」
       * 而被云端旧值覆盖 —— 这正是缺陷2「等一会儿自己变回去」的复发路径。
       * 同时这些字段仍留在 pending 集合里，由下一次成功推送清空。
       */
      snapshotAppearanceBaseline(restoredAppearanceFields);
      persist();
      applyTheme();
    } catch {
      /* 离线 / 未登录 / 私有化模式（PrivacyModeError）时静默忽略 */
    } finally {
      pullingCloud = false;
      /*
       * 拉取期间如果有本地未同步改动被还原（scheduleCloudPush 当时只能置标记），
       * 此刻立刻补发一次推送，让云端收敛到本地值。
       *
       * 没有这一步，本地改动会**永远停在本地**：基线 / pending 一直保护它，
       * 但再没有任何推送把它送上去 —— 用户看到的就是「改了设置，另一端永远不同步」，
       * 即 1.1.9 脏标记僵住的翻版。这是本次修复最容易踩空的一环。
       */
      if (pushAfterPull) {
        pushAfterPull = false;
        scheduleCloudPush();
      }
    }
  }

  async function pushCloudSettings(attempt = 0): Promise<void> {
    if (!getAccessToken() || pullingCloud) return;
    const platform = detectPlatform();
    try {
      const { global: globalPart, platform: platformPart } = splitSettingsPartitions(settings.value);
      /*
       * 把「跨端强一致」的外观字段**同时镜像进平台分组**（1.2.1，缺陷2 的真正根因）。
       *
       * ## 为什么必须镜像（这是「字体设完一会儿自己恢复」的最后一环）
       *
       * 服务端 `GET /api/settings?platform=xxx` 返回的是**拍平视图**：
       *   flattenSettings() 用 `Object.assign(view, group)` 把平台分组盖到 global 上，
       * 而 `appearance` 是一个整体对象键 —— 于是 `platform.<p>.appearance`
       * **整块替换** `global.appearance`，而不是逐字段覆盖。
       *
       * 1.1.7 及更早版本把 `fontFamily` 写在 platform 分区里，这些旧值至今仍留在
       * `platform.desktop.appearance` / `platform.web.appearance` 里（生产库实测确实存在）。
       * 于是即使 1.1.8+ 把 fontFamily 改成写 global，客户端拉到的拍平视图里
       * fontFamily 仍是平台分区里的**旧值**，被当成「云端的权威值」覆盖回本地。
       *
       * 客户端没法从拍平视图反推哪个字段来自哪个分区（响应里没有 global/platform 键），
       * 所以只能**在写侧自愈**：推送时把 global 里的主题类字段同步写进平台分组，
       * 让 `platform.<p>.appearance` 不再残留旧值。这样无论服务端拍平顺序如何，
       * 两个分区的值都一致，拉取结果必然正确。
       *
       * 注意：这里只镜像 `GLOBAL_APPEARANCE_FIELDS`（跨端强一致字段），
       * 阅读体验字段（字号 / 行高 / 页宽 / 缩放 / 行号 / 拼写检查）**仍然各端独立**，
       * 不会被另一台设备覆盖 —— 这是「按端差异化」设计的底线。
       */
      const mirroredAppearance: Record<string, unknown> = {};
      const globalAppearance = (globalPart.appearance ?? {}) as Record<string, unknown>;
      for (const field of GLOBAL_APPEARANCE_FIELDS) {
        if (globalAppearance[field] !== undefined) {
          mirroredAppearance[field] = globalAppearance[field];
        }
      }
      if (Object.keys(mirroredAppearance).length) {
        // 服务端对 appearance 做浅合并（`{...current, ...incoming}`），
        // 因此这里只带主题类字段，平台自己的阅读体验字段不会被动到。
        platformPart.appearance = {
          ...((platformPart.appearance as Record<string, unknown> | undefined) ?? {}),
          ...mirroredAppearance,
        };
      }
      // payload 结构为 v2：global 与「本平台」分组分开提交，服务端按分组浅合并
      const payload = { global: globalPart, platform: { [platform]: platformPart } };
      const sensitive = {
        global: {
          storage: {
            accessKeyId: settings.value.storage.accessKeyId || secrets.value.storageKeyId || '',
            accessKeySecret: settings.value.storage.accessKeySecret || secrets.value.storageSecret || '',
          },
          ai: {
            apiKey: settings.value.ai.apiKey || secrets.value.aiKey || '',
          },
        },
      };
      const deviceId = localStorage.getItem('neomd.deviceId') || 'device';
      const saved = await api<{ version: number }>('/api/settings', {
        method: 'PUT',
        auth: true,
        body: {
          payload,
          sensitive,
          version: settings.value.cloudVersion ?? 0,
          deviceId,
          platform,
        },
      });
      settings.value.cloudVersion = Number(saved.version ?? settings.value.cloudVersion ?? 0);
      // 云端已收下本地主题 → 清除脏标记，后续拉取可以正常接受云端值
      clearThemeDirty();
      // 推送成功 → 当前 layout 即「与云端一致」的基线（1.1.9）
      snapshotLayoutBaseline();
      /*
       * 推送成功 = 云端已经收下当前 global 外观字段（含 fontFamily），
       * 因此整份 global 外观都可以推进为基线，本地不再有「未推送改动」。
       * 这一步是让「保护」不会永久生效的关键：没有它，基线永远停在旧值上，
       * 本地每次拉取都会把旧本地值当成未推送改动还原，跨端同步就废了。
       */
      snapshotAppearanceBaseline();
      clearAppearancePending();
      persist();
    } catch {
      if (attempt >= 1) return;
      // 只重试一次：网络抖动时需要一次机会，但连续失败说明是服务端/鉴权问题，继续重试只会放大压力
      await pushCloudSettings(attempt + 1);
    }
  }

  /** 轻量版本轮询：只比较版本号，云端有变化才拉全量设置 */
  async function pollCloudVersion(): Promise<void> {
    if (!getAccessToken() || pullingCloud) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    try {
      const res = await api<{ version: number }>('/api/settings/version', { auth: true });
      const remote = Number(res.version ?? 0);
      if (remote > Number(settings.value.cloudVersion ?? 0)) await pullCloudSettings();
    } catch {
      /* 忽略网络抖动与私有化模式拦截 */
    }
  }

  /** 安装自动同步触发器：窗口聚焦 / 重新可见 / 60s 版本轮询 + 启动即拉一次 */
  function installCloudAutoPull(): void {
    if (autoPullInstalled || typeof window === 'undefined') return;
    autoPullInstalled = true;
    window.addEventListener('focus', () => requestCloudPull());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') requestCloudPull();
    });
    versionPollTimer = setInterval(() => {
      void pollCloudVersion();
    }, CLOUD_VERSION_POLL_MS);
    requestCloudPull();
  }

  /** 卸载自动同步触发器（测试/HMR 时避免重复注册） */
  function disposeCloudAutoPull(): void {
    if (autoPullTimer) {
      clearTimeout(autoPullTimer);
      autoPullTimer = null;
    }
    if (cloudPushTimer) {
      clearTimeout(cloudPushTimer);
      cloudPushTimer = null;
    }
    if (versionPollTimer) {
      clearInterval(versionPollTimer);
      versionPollTimer = null;
    }
    autoPullInstalled = false;
  }

  function update(patch: Partial<Settings>): void {
    settings.value = mergeSettings(settings.value, patch);
    settings.value.updatedAt = Date.now();
    persist();
    applyTheme();
    scheduleCloudPush();
  }

  /** 判据：这次 appearance 改动是否碰到了「跨端强一致」的主题字段 */
  function touchesThemeFields(patch: Partial<Settings['appearance']>): boolean {
    return GLOBAL_APPEARANCE_FIELDS.some((f) => (patch as Record<string, unknown>)[f] !== undefined);
  }

  function updateAppearance(patch: Partial<Settings['appearance']>): void {
    const next = { ...settings.value.appearance, ...patch };
    // 当用户切换明暗外观（light / dark / system）时，若当前主题预设的 mode 与目标明暗不一致，
    // 自动切换到匹配的默认浅色（daylight）或深色（midnight）主题预设，确保点击立即生效。
    if (patch.theme !== undefined && patch.themePresetId === undefined) {
      const prefersDark =
        typeof window !== 'undefined'
          ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
          : false;
      const wantDark = patch.theme === 'dark' || (patch.theme === 'system' && prefersDark);
      const currentPreset = findTheme(next.themePresetId, next.customThemes);
      if (!currentPreset || (currentPreset.mode === 'dark') !== wantDark) {
        const targetId = wantDark ? 'midnight' : 'daylight';
        const targetTheme = findTheme(targetId, next.customThemes);
        if (targetTheme) {
          next.themePresetId = targetTheme.id;
          next.editorColorScheme = PRESET_TO_LEGACY_SCHEME[targetTheme.id] ?? 'custom';
          next.customEditorBg = targetTheme.contentBg;
          next.customEditorFg = targetTheme.contentFg;
        }
      }
    }
    settings.value.appearance = next;
    if (touchesThemeFields(patch)) markThemeDirty();
    /*
     * 标记「这些 global 外观字段本地已改、还没推上去」（1.2.1，缺陷2）。
     *
   * 与 `markThemeDirty()` 并存而不是替换它：`themeDirtySince` 还被
     * `splitRemotePayload` 之外的旧逻辑与测试引用，贸然删掉风险大；
     * 而真正决定「拉取时保不保这个字段」的是下面的字段级 pending 集合，
     * 粒度更细，也不会像布尔量那样永久僵住。
     */
    markAppearancePending(
      GLOBAL_APPEARANCE_FIELDS.filter((f) => (patch as Record<string, unknown>)[f] !== undefined),
    );
    persist();
    applyTheme();
    scheduleCloudPush();
  }

  function updateLayout(patch: Partial<Settings['layout']>): void {
    settings.value.layout = { ...settings.value.layout, ...patch };
    /*
     * 这里**不**置「脏标记」。布局是否与云端一致由 `captureLocalLayoutOverrides()`
     * 逐字段比对基线决定（见该函数的注释）——因为 `updateLayout()` 除了用户拖拽，
   * 还被面板开合、功能区切换等程序化路径大量调用，用布尔标记会永久置位，
     * 反而让跨端布局同步彻底失效。
     */
    persist();
    scheduleCloudPush();
  }

  /**
   * 更新服务器连接配置（仅桌面端使用）。
   * 三个字段全部是**严格本地**配置（`server` 在 `LOCAL_ONLY_KEYS` 中，永不进云端 payload），
   * 因此这里直接改内存 + 落盘，不走 `update()`（后者会触发云端推送）。 */
  function updateServer(patch: Partial<ServerSettings>): void {
    const cur = settings.value.server ?? DEFAULT_SERVER_SETTINGS;
    const next: ServerSettings = {
      mode: patch.mode ?? cur.mode,
      customBaseUrl:
        patch.customBaseUrl === undefined ? cur.customBaseUrl : normalizeServerBase(patch.customBaseUrl),
      privacyMode: patch.privacyMode ?? cur.privacyMode,
    };
    settings.value.server = next;
    settings.value.updatedAt = Date.now();
    persist();
  }

  function setSecret(kind: 'ai' | 'storage', value: string): void {
    if (kind === 'ai') {
      secrets.value.aiKey = value;
      settings.value.ai.apiKey = value;
    } else {
      secrets.value.storageSecret = value;
      settings.value.storage.accessKeySecret = value;
    }
    scheduleCloudPush();
  }

  function setStorageKeyId(value: string): void {
    secrets.value.storageKeyId = value;
    settings.value.storage.accessKeyId = value;
    scheduleCloudPush();
  }

  function togglePlugin(id: string, enabled: boolean): void {
    settings.value.enabledPlugins = { ...settings.value.enabledPlugins, [id]: enabled };
    persist();
    scheduleCloudPush();
  }

  function pluginOn(id: string): boolean {
    return settings.value.enabledPlugins[id] !== false;
  }

  const aiConfigured = computed(
    () => Boolean(settings.value.ai.apiKey) || settings.value.ai.usePlatform,
  );
  const storageConfigured = computed(
    () => Boolean(settings.value.storage.bucket && (settings.value.storage.accessKeyId || settings.value.storage.accessKeySecret)),
  );

  /** 数据私有化是否开启：开启后编辑器除应用商店外完全不再请求服务端 */
  const privacyMode = computed(() => settings.value.server?.privacyMode === true);

  /**
   * 服务端是否已"明确配置"： */
  const serverConfigured = computed(() => {
    const server = settings.value.server;
    if (!server) return true;
    if (server.mode !== 'custom') return true;
    return Boolean(normalizeServerBase(server.customBaseUrl));
  });

  /** AI 可用模型：优先用户勾选，其次服务商预设 */
  const aiModels = computed(() => {
    const ai = settings.value.ai;
    if (ai.models && ai.models.length) return ai.models;
    return [];
  });

  function init(): void {
    applyTheme();
    ready.value = true;
    if (typeof window !== 'undefined') {
      // 用箭头函数包一层：`addEventListener` 会把 Event 当第一个实参传给 applyTheme，
      // 而 applyTheme 的首参现在是「草稿覆盖」，直接传会污染类型判断
      window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme());
    }
    // 监听系统明暗变化，让「跟随系统」的用户无需手动切换
  }

  watch(() => settings.value.appearance.theme, () => applyTheme());

    // 主题预设或自定义主题列表变化时也要重算 CSS 变量（切主题会同时改这两者）
  watch(
    () => [settings.value.appearance.themePresetId, settings.value.appearance.customThemes] as const,
    () => applyTheme(),
    { deep: true },
  );

  return {
    settings,
    secrets,
    ready,
    init,
    update,
    updateAppearance,
    updateLayout,
    updateServer,
    setSecret,
    setStorageKeyId,
    togglePlugin,
    pluginOn,
    persist,
    pullCloudSettings,
    pushCloudSettings,
  /** 节流版拉取：打开设置页、窗口重新可见等场景调用 */
    requestCloudPull,
    pollCloudVersion,
    disposeCloudAutoPull,
    aiConfigured,
    storageConfigured,
    aiModels,
    privacyMode,
    serverConfigured,
  /* 主题预设（task-3） */
    activeTheme,
    themeList,
    applyThemePreset,
  /** 重新套用当前主题（切换「应用范围」等本机偏好后调用，让变量立即重算） */
    reapplyTheme: applyTheme,
  /* 草稿模式（1.4.0，需求 16） */
    /** 一次性提交设置页草稿：合并 → 落盘 → 重算主题 → 触发云推送 */
    commitDraft,
    /** 实时预览：把草稿外观写进 CSS 变量，不进 store、不推云端；传 null 恢复正式值 */
    previewAppearance,
  };
});
