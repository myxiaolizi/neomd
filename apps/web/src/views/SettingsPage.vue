<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NmIcon, NmModal } from '@neomd/ui';
import { useSettingsStore } from '@/stores/settings';
import { THEME_SCOPE_STORAGE_KEY, readThemeScope, type ThemeScope } from '@/stores/settings';
import { useAuthStore } from '@/stores/auth';
import { useAppStore } from '@/stores/app';
import { AIClient, detectRuntime, getBridge, defaultSettings, DEFAULT_TOOLBAR_ITEMS, DEFAULT_AI_TITLE_PROMPT } from '@neomd/core';
import { AI_PRESETS, STORAGE_PRESETS, getStoragePreset, getAIPreset, type RightPanelSection, type Settings } from '@neomd/shared';
import { RIGHT_SECTION_LIMIT, toggleRightSectionWithLimit, useLocalLayout } from '@/lib/local-layout';
import {
  settingsApi,
  profileApi,
  uploadApi,
  aiApi,
  aiProvidersApi,
  platformModelsApi,
  type AiProviderMetaDto,
  type PlatformModelDto,
  type OssProbeStepDto,
} from '@/api/client';
import { SITE_URL } from '@/env';
import ServerSettingsSection from '@/components/panels/ServerSettingsSection.vue';
import ObsidianImportSection from '@/components/panels/ObsidianImportSection.vue';
import KnowledgeSettingsSection from '@/components/panels/KnowledgeSettingsSection.vue';
import VaultManagerSection from '@/components/panels/VaultManagerSection.vue';
import SyncSettingsSection from '@/components/panels/SyncSettingsSection.vue';
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  allThemes,
  blankCustomTheme,
  createThemeId,
  findTheme,
  getTheme,
  isCustomTheme,
  normalizeTheme,
  resolveTheme,
  scopedThemeVars,
  themeVars,
  type EditorColorScheme,
  type ThemePreset,
} from '@neomd/shared';

const props = defineProps<{ initialTab?: string }>();
/** 整页版设置不再有模态开关，保留 emit 仅用于「关闭」按钮跳回编辑器 */
const emit = defineEmits<{ close: [] }>();

const settingsStore = useSettingsStore();
const auth = useAuthStore();
const app = useAppStore();
const { layout: localLayout, update: updateLocalLayout } = useLocalLayout();

/**
 * 兜底默认值：所有从 settings 读取的嵌套对象都经由下方 computed 兜底。
 * 历史数据（旧版 localStorage / 云端旧 payload）可能缺少某个子对象，
 * 直接访问 `settings.xxx.yyy` 会抛错导致整页白屏。
 */
const FALLBACK = defaultSettings();

type TabId =
  | 'general'
  | 'editor'
  | 'theme'
  | 'layout'
  | 'shortcuts'
  | 'storage'
  | 'ai'
  | 'vaults'
  | 'knowledge'
  | 'sync'
  | 'server'
  | 'import';
const tab = ref<TabId>('general');
const ALL_TABS: Array<{ id: TabId; label: string; icon: string; nativeOnly?: boolean }> = [
  { id: 'general', label: '通用', icon: 'settings' },
  { id: 'editor', label: '编辑器', icon: 'type' },
  { id: 'theme', label: '主题', icon: 'palette' },
  { id: 'layout', label: '界面布局', icon: 'layout' },
  { id: 'shortcuts', label: '快捷键', icon: 'command' },
  { id: 'storage', label: '对象存储', icon: 'cloud' },
  { id: 'ai', label: 'AI', icon: 'sparkles' },
  // 仓库管理（1.1.5）：网页端同样要看得到云端仓库列表，因此不限桌面端；
  // 「添加仓库 / 复制」等需要本机目录的操作在组件内按平台单独禁用并给出说明。
  { id: 'vaults', label: '仓库', icon: 'hdd' },
  // 知识库基于本地仓库索引，浏览器端同样有仓库适配器，因此不限桌面端
  { id: 'knowledge', label: '知识库', icon: 'graph' },
  { id: 'sync', label: '同步与版本', icon: 'sync' },
  { id: 'server', label: '服务器', icon: 'server', nativeOnly: true },
  { id: 'import', label: '导入', icon: 'upload', nativeOnly: true },
  // 1.1.7：账号页签已移除 —— 账号信息 / 退出登录移到用户头像菜单，资料编辑在网页端用户中心
];

const TABS = computed(() =>
  runtime.platform === 'web' ? ALL_TABS.filter((t) => !t.nativeOnly) : ALL_TABS,
);

const probeResult = ref('');
const probeOk = ref(false);
const probeSteps = ref<OssProbeStepDto[]>([]);
const probing = ref(false);
const aiTestResult = ref('');
const aiTestOk = ref(false);
const aiTesting = ref(false);
const modelList = ref<string[]>([]);
const modelSource = ref('');
const loadingModels = ref(false);
const saving = ref(false);
const saveMessage = ref('');
const saveMessageOk = ref(false);
const nickname = ref('');
const avatarUrl = ref('');
const oldPassword = ref('');
const newPassword = ref('');

/** 即时保存反馈（1.5 秒后自动消失），替代「只有底部一个保存按钮」的反馈缺失 */
const savedHint = ref('');
let savedHintTimer: ReturnType<typeof setTimeout> | null = null;

function flashSaved(label = '已保存'): void {
  savedHint.value = label;
  if (savedHintTimer) clearTimeout(savedHintTimer);
  savedHintTimer = setTimeout(() => {
    savedHint.value = '';
    savedHintTimer = null;
  }, 1500);
}

/** 危险操作二次确认对话框（清空密钥 / 清空快捷键 / 恢复默认等） */
const confirmDialog = ref<{
  open: boolean;
  title: string;
  message: string;
  confirmText: string;
  action: (() => void) | null;
}>({ open: false, title: '', message: '', confirmText: '确认', action: null });

function askConfirm(opts: { title: string; message: string; confirmText?: string; action: () => void }): void {
  confirmDialog.value = {
    open: true,
    title: opts.title,
    message: opts.message,
    confirmText: opts.confirmText ?? '确认',
    action: opts.action,
  };
}

function runConfirm(): void {
  const action = confirmDialog.value.action;
  confirmDialog.value = { open: false, title: '', message: '', confirmText: '确认', action: null };
  action?.();
}

/** 窄屏判定：宽度 ≤ 760px 时弹窗近似全屏、页签横向滚动 */
const isNarrow = ref(false);

let narrowQuery: MediaQueryList | null = null;
function onNarrowChange(e: MediaQueryListEvent): void {
  isNarrow.value = e.matches;
}

onBeforeUnmount(() => {
  if (savedHintTimer) clearTimeout(savedHintTimer);
  narrowQuery?.removeEventListener?.('change', onNarrowChange);
});

/* ------------------------------------------------------------------ */
/* 草稿模式（1.4.0，需求 16）                                          */
/*                                                                     */
/* ## 语义                                                             */
/*                                                                     */
/* 1. 进入设置页 → 把当前 `settings` **深拷贝**成 `draft`（快照）；      */
/* 2. 所有控件只改 `draft`，**不写 store、不推云端**；                   */
/* 3. 底部固定「取消 / 保存」栏：                                      */
/*    - 保存 → `commitDraft()` 一次性合并进 store（含 applyTheme + 云推送）*/
/*    - 取消 → 丢弃草稿，界面回到 store 里的正式值；                    */
/* 4. 有未保存改动时关闭标签页会提示（`beforeunload` + 页面内确认）。     */
/*                                                                     */
/* ## 「实时预览」开关（默认开）                                        */
/*                                                                     */
/* 主题类改动需要「所见即所调」，否则调色盘毫无意义。预览走              */
/* `settingsStore.previewAppearance(draft.appearance)`：只改 `<html>` 上的 */
/* CSS 变量，**不进 store、不推云端**。关掉预览后必须点保存才看得到效果。  */
/* ------------------------------------------------------------------ */

/** 深拷贝设置（草稿与 store 必须彻底隔离，否则改了 draft 就等于改了 store） */
function cloneSettings(source: Settings): Settings {
  return JSON.parse(JSON.stringify(source)) as Settings;
}

/**
 * 从 store 生成「完整可编辑的草稿」。
 *
 * 为什么要把 `secrets` 合进来：网页端密钥类字段**只留在内存**
 * （`persist()` 写 localStorage 前会清空 `accessKeySecret` / `aiKey`），
 * 因此 `settings.storage.accessKeySecret` 读回来总是空串，密钥输入框会空白 ——
 * 它们的真实值在 store 的 `secrets` 里。
 */
function draftFromStore(): Settings {
  const draftValue = cloneSettings(settingsStore.settings);
  const secrets = settingsStore.secrets;
  draftValue.storage.accessKeySecret = secrets.storageSecret ?? draftValue.storage.accessKeySecret ?? '';
  draftValue.storage.accessKeyId = secrets.storageKeyId || draftValue.storage.accessKeyId || '';
  draftValue.ai.apiKey = secrets.aiKey ?? draftValue.ai.apiKey ?? '';
  return draftValue;
}

/** 当前编辑中的草稿（onMounted 时快照；永远不会是 null，初始化给一份空结构兜底） */
const draft = ref<Settings>(draftFromStore());
/** 「保存成功时的基线」：用于判断草稿是否有未保存改动 */
const draftBaseline = ref<string>(JSON.stringify(draft.value));

/** 实时预览开关（主题类改动是否即时反映到界面，不进 store） */
const livePreview = ref(true);

/** 草稿相对基线的差异（逐分区比对，便于提示「改了哪几块」） */
const draftDiffKeys = computed<string[]>(() => {
  const before = JSON.parse(draftBaseline.value) as Settings;
  const now = draft.value;
  const keys: string[] = [];
  const labels: Record<string, string> = {
    appearance: '外观与主题',
    layout: '界面布局',
    naming: '新建命名',
    autosave: '自动保存',
    storage: '对象存储',
    ai: 'AI',
    sync: '同步与版本',
    shortcuts: '快捷键',
    localVault: '本地仓库',
    knowledge: '知识库',
    shareStyle: '分享样式',
    diagram: '图表',
  };
  for (const key of Object.keys(labels)) {
    const a = JSON.stringify((before as unknown as Record<string, unknown>)[key]);
    const b = JSON.stringify((now as unknown as Record<string, unknown>)[key]);
    if (a !== b) keys.push(labels[key] as string);
  }
  return keys;
});

/** 是否有未保存改动 */
const draftDirty = computed(() => draftDiffKeys.value.length > 0);

/* --------------------------- 设置对象兜底读取 --------------------------- */
/* 所有读取都走草稿：控件显示的是「将要保存的值」，不是「已经保存的值」。 */

const storage = computed(() => draft.value.storage ?? FALLBACK.storage);
const ai = computed(() => draft.value.ai ?? FALLBACK.ai);
const appearance = computed(() => draft.value.appearance ?? FALLBACK.appearance);
const naming = computed(() => draft.value.naming ?? FALLBACK.naming);
const autosave = computed(
  () => draft.value.autosave ?? FALLBACK.autosave ?? { enabled: true, versionMinutes: 5, versionChars: 300 },
);
const layout = computed(() => draft.value.layout ?? FALLBACK.layout);
const sync = computed(() => draft.value.sync ?? FALLBACK.sync);
const shortcuts = computed(() => draft.value.shortcuts ?? []);

/** 本地仓库落盘策略（仅 PC 端有效） */
const localVault = computed(() => draft.value.localVault ?? FALLBACK.localVault ?? { root: '', keepVersions: false });
const activeVaultPath = computed(() => app.vaultLocation ?? '');
const canPickDirectory = computed(() => runtime.platform === 'desktop' && Boolean(getBridge()?.dialog?.pickDirectory));

/** 让用户选择本地仓库根目录：选完立刻写入设置，下次打开仓库即生效 */
async function pickLocalVaultRoot(): Promise<void> {
  const bridge = getBridge();
  const pick = bridge?.dialog?.pickDirectory;
  if (!pick) {
    flashSaved('当前环境不支持目录选择');
    return;
  }
  try {
    const picked = await pick();
    if (!picked) return;
    patchSettings({ localVault: { ...localVault.value, root: picked } });
    flashSaved('已更新本地仓库根目录，重新打开仓库后生效');
  } catch (e) {
    flashSaved(`选择目录失败：${(e as Error).message}`);
  }
}

/** 数组类字段单独兜底，避免历史数据缺字段时 `.includes` 抛错 */
const ribbonItems = computed<string[]>(() => layout.value.ribbonItems ?? []);
const toolbarItems = computed<string[]>(() =>
  layout.value.toolbarItems?.length ? layout.value.toolbarItems : DEFAULT_TOOLBAR_ITEMS,
);
const rightPanelSections = computed(() => layout.value.rightPanelSections ?? ['ai', 'file']);

const storageRegions = computed(() => getStoragePreset(storage.value.provider).regions);
const aiPreset = computed(() => getAIPreset(ai.value.provider));
const runtime = detectRuntime();

/** 功能区仅显示已开通的插件按钮，不显示保存等文章操作类按钮 */
const PLUGIN_RIBBON_CATALOG = [
  { id: 'daily-notes', label: '今日日记', icon: 'calendar' },
  { id: 'random-note', label: '漫游笔记', icon: 'dice' },
  { id: 'graph', label: '关系图谱', icon: 'graph' },
  { id: 'tag-list', label: '标签列表', icon: 'tag' },
  { id: 'bookmarks', label: '书签', icon: 'bookmark' },
  { id: 'file-recovery', label: '文件恢复', icon: 'history' },
  { id: 'whiteboard', label: '白板', icon: 'layers' },
  { id: 'slides', label: '幻灯片', icon: 'columns' },
  { id: 'database', label: '数据库', icon: 'table' },
  { id: 'web-browser', label: '网页浏览器', icon: 'globe' },
  { id: 'recorder', label: '录音机', icon: 'mic' },
  { id: 'diagram-flowchart', label: '流程图', icon: 'columns' },
  { id: 'diagram-mindmap', label: '思维导图', icon: 'graph' },
];

const RIBBON_ITEMS = computed(() =>
  PLUGIN_RIBBON_CATALOG.filter((item) => settingsStore.pluginOn(item.id)),
);

const ALL_TOOLBAR_DEFS: Array<{ id: string; label: string }> = [
  { id: 'undo', label: '撤销' },
  { id: 'redo', label: '重做' },
  { id: 'h1', label: 'H1 一级标题' },
  { id: 'h2', label: 'H2 二级标题' },
  { id: 'h3', label: 'H3 三级标题' },
  { id: 'bold', label: '加粗' },
  { id: 'italic', label: '斜体' },
  { id: 'underline', label: '下划线' },
  { id: 'strike', label: '删除线' },
  { id: 'highlight', label: '高亮' },
  { id: 'code', label: '行内代码' },
  { id: 'ul', label: '无序列表' },
  { id: 'ol', label: '有序列表' },
  { id: 'task', label: '任务列表' },
  { id: 'quote', label: '引用' },
  { id: 'table', label: '插入表格' },
  { id: 'link', label: '插入链接' },
  { id: 'image', label: '插入图片' },
  { id: 'codeblock', label: '代码块' },
  { id: 'hr', label: '分隔线' },
];

/* 1.1.1：正文配色方案（COLOR_SCHEMES）已删除 —— 正文颜色全部并入主题。
 * `EditorColorScheme` 类型与 `appearance.editorColorScheme` 字段仍保留在 shared 类型里，
 * 仅由 resolveTheme() 用于把老用户的旧配色迁到对应主题，界面上不再暴露。 */

const orderedToolbarDefs = computed(() => {
  const activeIds = toolbarItems.value;
  const activePart = activeIds
    .map((id) => ALL_TOOLBAR_DEFS.find((d) => d.id === id))
    .filter((d): d is { id: string; label: string } => Boolean(d))
    .map((d) => ({ ...d, enabled: true }));
  const inactivePart = ALL_TOOLBAR_DEFS.filter((d) => !activeIds.includes(d.id)).map((d) => ({
    ...d,
    enabled: false,
  }));
  return [...activePart, ...inactivePart];
});

function toggleToolbarItem(id: string): void {
  const cur = [...toolbarItems.value];
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  patchLayout({ toolbarItems: next });
}

/** 设置页工具栏按钮拖拽排序（1.1.9：移除点击上下箭头调整，统一改为拖拽调整） */
const tbDragId = ref('');
const tbDropId = ref('');
const tbDropSide = ref<'before' | 'after'>('before');

function onTbDragStart(e: DragEvent, id: string): void {
  tbDragId.value = id;
  tbDropId.value = '';
  e.dataTransfer?.setData('text/plain', id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}

function onTbDragOver(e: DragEvent, id: string): void {
  if (!tbDragId.value) return;
  tbDropId.value = id;
  const rect = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect();
  if (rect) tbDropSide.value = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
}

function onTbDragLeave(id: string): void {
  if (tbDropId.value === id) tbDropId.value = '';
}

function onTbDrop(_e: DragEvent, targetId: string): void {
  const from = tbDragId.value;
  const side = tbDropSide.value;
  tbDragId.value = '';
  tbDropId.value = '';
  if (!from || from === targetId) return;
  const cur = [...toolbarItems.value];
  const fromIdx = cur.indexOf(from);
  if (fromIdx >= 0) cur.splice(fromIdx, 1);
  const targetIdx = cur.indexOf(targetId);
  if (targetIdx < 0) {
    cur.push(from);
  } else {
    const insertAt = side === 'after' ? targetIdx + 1 : targetIdx;
    cur.splice(insertAt, 0, from);
  }
  patchLayout({ toolbarItems: cur });
  flashSaved('已调整工具栏顺序（点「保存」生效）');
}

function onTbDragEnd(): void {
  tbDragId.value = '';
  tbDropId.value = '';
  tbDropSide.value = 'before';
}

function resetToolbarItems(): void {
  patchLayout({ toolbarItems: [...DEFAULT_TOOLBAR_ITEMS] });
  flashSaved('已恢复默认工具栏顺序（点「保存」生效）');
}

function updateAutosave(patch: Partial<{ enabled: boolean; versionMinutes: number; versionChars: number }>): void {
  draft.value.autosave = { ...autosave.value, ...patch };
  flashSaved('草稿已更新，点「保存」生效');
}

/**
 * 统一的外观改动入口（**只写草稿**，需求 16）。
 *
 * 改完由 `scheduleLivePreview()` 决定要不要立刻把草稿反映到 CSS 变量上 ——
 * 那一步只碰 `<html>` 的变量，不写 store、不推云端。
 */
function patchAppearance(patch: Partial<typeof appearance.value>): void {
  draft.value.appearance = { ...appearance.value, ...patch };
  scheduleLivePreview();
  flashSaved('草稿已更新，点「保存」生效');
}

/** 统一的布局改动入口（只写草稿） */
function patchLayout(patch: Partial<typeof layout.value>): void {
  draft.value.layout = { ...layout.value, ...patch };
  flashSaved('草稿已更新，点「保存」生效');
}

/** 统一的设置改动入口（只写草稿） */
function patchSettings(patch: Partial<Settings>): void {
  draft.value = mergeDraftPatch(draft.value, patch);
  flashSaved('草稿已更新，点「保存」生效');
}

/**
 * 把 `Partial<Settings>` 浅合并进草稿（嵌套分区逐键合并，数组整体替换）。
 *
 * 不复用 `@neomd/core` 的 `mergeSettings()`：那个函数带「保留本地密钥不被空值覆盖」
 * 与「naming 乱码纠偏」等**同步语义**，用在草稿上会导致「清空密钥」这类操作
 * 在草稿里被静默撤销，用户点了保存却发现密钥还在。
 */
function mergeDraftPatch(base: Settings, patch: Partial<Settings>): Settings {
  const out = { ...base } as Settings;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    const current = (base as unknown as Record<string, unknown>)[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      (out as unknown as Record<string, unknown>)[key] = {
        ...(current as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      };
    } else {
      (out as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

/* --------------------- 草稿：预览 / 保存 / 取消（需求 16） --------------------- */

/**
 * 深比较两个值（数组按整体比较，对象逐键递归）。
 *
 * 用途：算出「草稿相对基线真正改了什么」。见 `buildDraftDelta()` 的注释。
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * 递归取差集：只保留 `next` 与 `base` 不同的叶子。
 *
 * ## 为什么必须只提交差集（不能整份提交草稿）
 *
 * 草稿是「进入设置页时的快照」，而 `onMounted` 里同时会调
 * `settingsStore.requestCloudPull()` —— 拉取通常在这之后完成。
 * 也就是说：**草稿从诞生那一刻起就可能是旧的**。
 *
 * 如果保存时把整份草稿 merge 回 store，会带来两个后果：
 *   1. 拉取刚下来的云端值（另一台设备改的字体/主题/布局）被本端旧快照覆盖；
 *   2. 更糟的是这些字段还会因为「与保存前的 store 值不同」被 `commitDraft()`
 *      标进 pending 集合、反过来推回云端 —— 等于把别人的改动抹掉。
 *
 * 只提交差集就等价于「用户真的动过的那几项」，其余一切尊重当前 store（含云端新值）。
 */
function diffObjects(base: unknown, next: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (
    !next ||
    typeof next !== 'object' ||
    Array.isArray(next) ||
    !base ||
    typeof base !== 'object' ||
    Array.isArray(base)
  ) {
    return out;
  }
  const bo = base as Record<string, unknown>;
  const no = next as Record<string, unknown>;
  for (const key of Object.keys(no)) {
    const bv = bo[key];
    const nv = no[key];
    if (deepEqual(bv, nv)) continue;
    // 两侧都是普通对象 → 继续下钻；否则当作叶子整体写入
    const bothPlainObjects =
      nv &&
      typeof nv === 'object' &&
      !Array.isArray(nv) &&
      bv &&
      typeof bv === 'object' &&
      !Array.isArray(bv);
    if (bothPlainObjects) {
      const sub = diffObjects(bv, nv);
      if (Object.keys(sub).length) out[key] = sub;
    } else {
      out[key] = nv;
    }
  }
  return out;
}

/** 草稿相对基线的差集（顶层键 + 各分区内变化的字段） */
function buildDraftDelta(): Partial<Settings> {
  const base = JSON.parse(draftBaseline.value) as unknown;
  const delta = diffObjects(base, draft.value) as Partial<Settings>;
  // 运行期字段不参与提交：cloudVersion 由 store 维护，updatedAt 由 store 打时间戳
  delete (delta as Record<string, unknown>).cloudVersion;
  delete (delta as Record<string, unknown>).updatedAt;
  return delta;
}

/**
 * 是否允许实时预览当前改动。
 *
 * 只有 `appearance` 的变化值得预览（就是那些 CSS 变量）。布局/命名/存储等
 * 改动即使预览了也看不出来，所以这里只对 appearance 走预览通道。
 */
let previewTimer: ReturnType<typeof setTimeout> | null = null;

/** 防抖预览：连续调色时不要每一帧都重算 26 个变量 */
function scheduleLivePreview(): void {
  if (!livePreview.value) return;
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewTimer = null;
    settingsStore.previewAppearance(draft.value.appearance);
  }, 60);
}

/** 立即把当前草稿外观刷新到 CSS 变量（开启预览时） */
function refreshLivePreview(): void {
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
  if (livePreview.value) settingsStore.previewAppearance(draft.value.appearance);
  else settingsStore.previewAppearance(null);
}

watch(livePreview, () => refreshLivePreview());

/**
 * 保存草稿：把**差集**提交到 store（`commitDraft` 内部负责 applyTheme + 云推送）。
 *
 * 敏感字段单独传：草稿里的 `accessKeySecret` / `aiKey` 是从 `secrets` 合并进来的，
 * 提交时也要同步回 `secrets`，否则「改完密钥点保存」在网页端会丢（只在内存里）。
 * 它们只在**确实被改过**时才传，避免没动密钥的一次保存把 store 里的密钥写空。
 */
function saveDraft(): void {
  const delta = buildDraftDelta();
  const base = JSON.parse(draftBaseline.value) as Settings;
  /*
   * 密钥类字段：`commitDraft` 走 secretsPatch 通道写入，避免被 mergeSettings 的
   * 「保留本地密钥不被空值覆盖」语义吃掉（清空密钥是个合法操作）。
   * 只有变化时才传 —— 否则「保存一个只改了字体的草稿」会把密钥重置成草稿里那份
   * （草稿那份来自 mount 时的 secrets，若期间重新登录过就是旧值）。
   */
  const secretsChanged: {
    storageKeyId?: string;
    storageSecret?: string;
    aiKey?: string;
  } = {};
  if (!deepEqual(base.storage?.accessKeyId, draft.value.storage?.accessKeyId)) {
    secretsChanged.storageKeyId = draft.value.storage?.accessKeyId ?? '';
  }
  if (!deepEqual(base.storage?.accessKeySecret, draft.value.storage?.accessKeySecret)) {
    secretsChanged.storageSecret = draft.value.storage?.accessKeySecret ?? '';
  }
  if (!deepEqual(base.ai?.apiKey, draft.value.ai?.apiKey)) {
    secretsChanged.aiKey = draft.value.ai?.apiKey ?? '';
  }
  delete (delta.storage as Partial<Settings['storage']> | undefined)?.accessKeySecret;
  delete (delta.ai as Partial<Settings['ai']> | undefined)?.apiKey;

  settingsStore.commitDraft(delta, Object.keys(secretsChanged).length ? secretsChanged : undefined);
  // 回落一份「干净的草稿」：重新从 store 快照一次（含刚拉取的云端新值），
  // 保证基线 = 当前正式值，脏标记归零
  draft.value = draftFromStore();
  draftBaseline.value = JSON.stringify(draft.value);
  settingsStore.previewAppearance(null);
  flashSaved('设置已保存');
}

/** 取消：丢弃草稿，界面回到 store 里的正式值 */
function cancelDraft(): void {
  draft.value = draftFromStore();
  draftBaseline.value = JSON.stringify(draft.value);
  // 取消后界面必须回到「已保存」的外观（预览期间 <html> 上是草稿色）
  settingsStore.previewAppearance(null);
  flashSaved('已放弃未保存的改动');
}

/** 恢复本页草稿为出厂默认（只改草稿，仍需点保存才生效） */
function resetDraftToDefault(): void {
  const fresh = draftFromStore();
  const defaults = defaultSettings();
  // 只重置「设置项」，保留严格本地 / 运行期字段
  draft.value = {
    ...fresh,
    appearance: { ...defaults.appearance, customThemes: fresh.appearance.customThemes },
    layout: { ...defaults.layout },
    naming: { ...defaults.naming },
    autosave: {
      enabled: defaults.autosave?.enabled ?? fresh.autosave?.enabled ?? true,
      versionMinutes: defaults.autosave?.versionMinutes ?? fresh.autosave?.versionMinutes ?? 5,
      versionChars: defaults.autosave?.versionChars ?? fresh.autosave?.versionChars ?? 300,
    },
    shortcuts: [...defaults.shortcuts],
  };
  refreshLivePreview();
  flashSaved('草稿已恢复默认，点「保存」生效');
}

/* ------------------------------ 表单校验 ------------------------------ */

/** endpoint 校验：允许省略协议（会自动补 https://），但不接受非法字符 */
function normalizeEndpoint(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const withProto = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withProto);
    if (!u.hostname || !u.hostname.includes('.')) return null;
    return withProto;
  } catch {
    return null;
  }
}

const endpointIssue = computed<string>(() => {
  const raw = storage.value.endpoint?.trim() ?? '';
  if (!raw) return '请填写 Endpoint 地址';
  if (normalizeEndpoint(raw)) return '';
  return 'Endpoint 需为合法地址（可省略协议，将自动补 https://）';
});

const bucketIssue = computed<string>(() => {
  const b = storage.value.bucket?.trim() ?? '';
  if (!b) return '请填写 Bucket 名称';
  if (b.includes('/')) return 'Bucket 名称不能包含「/」';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,62}$/.test(b)) return 'Bucket 名称格式不正确';
  return '';
});

const accessKeyIdIssue = computed<string>(() => {
  const k = storage.value.accessKeyId?.trim() ?? '';
  if (!k) return '请填写 AccessKey ID';
  if (k.length < 8 || k.length > 128) return 'AccessKey ID 长度应在 8-128 位之间';
  return '';
});

/** 协议自动补全提示：用户填了 host 但没写协议时提前告知 */
const endpointAutoProtoHint = computed(() => {
  const raw = storage.value.endpoint?.trim() ?? '';
  return raw && !/^https?:\/\//i.test(raw) ? `提交时将自动补全为 https://${raw}` : '';
});

const storageConfigIssues = computed<string[]>(() => {
  const list: string[] = [];
  if (endpointIssue.value) list.push(endpointIssue.value);
  if (bucketIssue.value) list.push(bucketIssue.value);
  if (accessKeyIdIssue.value) list.push(accessKeyIdIssue.value);
  if (!storage.value.accessKeySecret?.trim()) list.push('请填写 AccessKey Secret');
  return list;
});

const aiBaseUrlIssue = computed<string>(() => {
  if (ai.value.provider === 'platform' || ai.value.usePlatform) return '';
  const raw = ai.value.baseUrl?.trim() ?? '';
  if (!raw) return '请填写 Base URL';
  return normalizeEndpoint(raw) ? '' : 'Base URL 需为合法地址（可省略协议，将自动补 https://）';
});

const aiConfigIssues = computed<string[]>(() => {
  const list: string[] = [];
  if (aiBaseUrlIssue.value) list.push(aiBaseUrlIssue.value);
  if (!(ai.value.provider === 'platform' || ai.value.usePlatform) && !ai.value.apiKey?.trim()) {
    list.push('请填写 API Key');
  }
  return list;
});

const storageTestDisabled = computed(() => probing.value || !auth.isLoggedIn || storageConfigIssues.value.length > 0);
const aiTestDisabled = computed(() => aiTesting.value || !auth.isLoggedIn || aiConfigIssues.value.length > 0);

function openWebAccountCenter(): void {
  const url = `${SITE_URL.replace(/\/+$/, '')}/account`;
  const bridge = getBridge();
  if (bridge?.shell?.openExternal) {
    void bridge.shell.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

function onProviderChange(id: string): void {
  const preset = getStoragePreset(id as typeof storage.value.provider);
  const region = preset.regions[0]?.id ?? '';
  patchSettings({
    storage: {
      ...storage.value,
      provider: id as typeof storage.value.provider,
      region,
      endpoint: preset.endpointFor(region),
      urlStyle: preset.urlStyle,
    },
  });
  probeResult.value = '';
  probeSteps.value = [];
  flashSaved('已切换服务商（点「保存」生效）');
}

function onRegionChange(region: string): void {
  const preset = getStoragePreset(storage.value.provider);
  patchSettings({ storage: { ...storage.value, region, endpoint: preset.endpointFor(region) } });
}

function onAIProviderChange(id: string): void {
  const preset = getAIPreset(id as typeof ai.value.provider);
  const isPlatform = id === 'platform';
  patchSettings({
    ai: {
      ...ai.value,
      provider: id as typeof ai.value.provider,
      usePlatform: isPlatform,
      baseUrl: preset.baseUrl,
      model: preset.defaultModel,
      models: isPlatform ? preset.models.slice(0, 3) : [],
    },
  });
  modelList.value = [];
  modelSource.value = '';
  aiTestResult.value = '';
  flashSaved('已切换供应商（点「保存」生效）');
}

/* ---------------------------- AI 供应商展示元数据（1.1.7） ---------------------------- */

/**
 * 后台下发的供应商展示配置（启用状态 / 申请地址 / 说明 / 排序）。
 *
 * 前台**只读**消费：老版本把 console 链接写死在 `AI_PRESETS` 里，
 * 小米这类厂商换域名就得发版；现在改由管理后台配置，前台取不到时静默回落到内置预设。
 */
const providerMeta = ref<Map<string, AiProviderMetaDto>>(new Map());
const providerMetaLoading = ref(false);

/** 拉取后台配置；失败不报错（回落到内置预设，不影响用户配置 AI） */
async function loadProviderMeta(): Promise<void> {
  if (providerMetaLoading.value) return;
  providerMetaLoading.value = true;
  try {
    const res = await aiProvidersApi.providers();
    const map = new Map<string, AiProviderMetaDto>();
    for (const item of res?.providers ?? []) map.set(item.id, item);
    providerMeta.value = map;
  } catch {
    providerMeta.value = new Map();
  } finally {
    providerMetaLoading.value = false;
  }
}

/**
 * 「我的 AI 供应商（自带 Key）」列表。
 *
 * 1.1.8 起前台不再有「平台供应商 / 自建供应商」之分，也不再显示开通状态——
 * 用户只看到一份可直接使用的供应商清单（含内置 7 家 + 自定义 OpenAI 兼容），
 * 选中后自己填 Key 即可。平台付费那条线在另一个独立区块里。
 *
 * 排序沿用后台 `sortOrder`（后台可配），取不到则按内置顺序。
 */
const ownProviderList = computed(() => {
  const list = AI_PRESETS.filter((p) => p.id !== 'platform');
  return [...list]
    .map((preset, index) => {
      const meta = providerMeta.value.get(preset.id);
      return {
        preset,
        meta,
        sortOrder: meta?.sortOrder ?? 100 + index,
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((item) => item.preset);
});

/**
 * 某个供应商的「去申请」地址。
 *
 * 优先级：后台配置的 `signupUrl` > 内置预设的 `console`。
 * 这样后台改一次链接，所有客户端下次打开设置页即生效，无需发版。
 */
function providerSignupUrl(presetId: string): string {
  const meta = providerMeta.value.get(presetId);
  const fromMeta = meta?.signupUrl?.trim();
  if (fromMeta) return fromMeta;
  return getAIPreset(presetId as typeof ai.value.provider).console;
}

/** 某个供应商的说明文案（后台优先，其次内置预设） */
function providerNote(presetId: string): string {
  const meta = providerMeta.value.get(presetId);
  const fromMeta = meta?.note?.trim();
  if (fromMeta) return fromMeta;
  return getAIPreset(presetId as typeof ai.value.provider).notes ?? '';
}

/* ---------------------------- 平台 AI 服务（1.1.8） ---------------------------- */

/**
 * 平台付费的可用模型清单（后台统一管理）。
 *
 * 前台只读：模型名、来源供应商名、参数上限、单价。**不含 baseUrl 与任何密钥**，
 * 这部分实现细节完全由后台掌握（B 项要求的分离）。
 */
const platformModels = ref<PlatformModelDto[]>([]);
const platformModelsLoading = ref(false);

/** 拉取平台可用模型；失败静默（显示「暂未开放」而不是报错） */
async function loadPlatformModels(): Promise<void> {
  if (platformModelsLoading.value) return;
  platformModelsLoading.value = true;
  try {
    const res = await platformModelsApi.publicModels();
    platformModels.value = res?.models ?? [];
  } catch {
    platformModels.value = [];
  } finally {
    platformModelsLoading.value = false;
  }
}

/** 当前选中的平台模型（用于展示系统提示词与参数上限） */
const currentPlatformModel = computed<PlatformModelDto | null>(() => {
  if (!ai.value.usePlatform && ai.value.provider !== 'platform') return null;
  return platformModels.value.find((m) => m.model === ai.value.model) ?? platformModels.value[0] ?? null;
});

/** 积分余额（登录后从 /api/ai/usage 拉） */
const aiCreditBalance = ref<number | null>(null);
const aiCreditToday = ref(0);

async function loadAiCredits(): Promise<void> {
  if (!auth.isLoggedIn) {
    aiCreditBalance.value = null;
    aiCreditToday.value = 0;
    return;
  }
  try {
    const usage = await aiApi.usage();
    aiCreditBalance.value = usage.balance;
    aiCreditToday.value = usage.costToday ?? 0;
  } catch {
    aiCreditBalance.value = null;
  }
}

/**
 * 「本次预估」消耗。
 *
 * 用当前模型的单价 × 一个典型请求量（默认按 2000 输入 + 800 输出 token 估）算，
 * 让用户对「问一次大概花多少分」有直观感受，而不是一个抽象数字。
 */
const platformEstimate = computed(() => {
  const m = currentPlatformModel.value;
  if (!m) return '—';
  const inTokens = 2000;
  const outTokens = 800;
  const cost = (m.priceIn * inTokens) / 1000 + (m.priceOut * outTokens) / 1000;
  const rounded = Math.round(cost * 100) / 100;
  return `${rounded} 积分`;
});

/** 切换平台模型：写入 ai.model，并同步一个安全范围内的温度 / maxTokens */
function onPlatformModelChange(m: PlatformModelDto): void {
  patchSettings({
    ai: {
      ...ai.value,
      provider: 'platform',
      usePlatform: true,
      model: m.model,
      // 不超过后台为该模型设的上限
      temperature: Math.min(Number(ai.value.temperature ?? 0.7), m.temperature),
      maxTokens: Math.min(Number(ai.value.maxTokens ?? 4096), m.maxTokens),
    },
  });
  flashSaved(`已切换到 ${m.model}（点「保存」生效）`);
}

/** 展示用的模型数量 */
function providerModelCount(presetId: string): number {
  const meta = providerMeta.value.get(presetId);
  if (meta?.models?.length) return meta.models.length;
  return getAIPreset(presetId as typeof ai.value.provider).models.length;
}

/**
 * 打开某个供应商的申请页。
 *
 * 与旧的 `openConsole()` 区别：地址由调用方传入（后台配置优先），
 * 且统一做 `noopener`，避免第三方页面拿到 `window.opener`。
 */
function openProviderSignup(presetId: string): void {
  const url = providerSignupUrl(presetId);
  if (!url) return;
  window.open(url, '_blank', 'noopener');
}

/**
 * 获取可用模型列表。
 * - 平台模式：走服务端 `aiApi.models('platform')`；
 * - 自带 Key：优先走服务端 `aiApi.test()` 代拉（服务端持凭证，可绕过浏览器跨域）；
 *   服务端未返回模型时才降级直连，且必须 try/catch 并给出可读的说明。
 */
async function fetchModels(): Promise<void> {
  loadingModels.value = true;
  modelSource.value = '';
  try {
    if (ai.value.provider === 'platform' || ai.value.usePlatform) {
      const res = await aiApi.models('platform');
      if (res && res.models.length) {
        applyModelList(
          res.models.map((m) => m.id),
          res.message || `平台已开放 ${res.models.length} 个模型，请点击勾选要启用的模型`,
        );
        return;
      }
      modelList.value = [...aiPreset.value.models];
      modelSource.value = '平台暂未返回模型列表，已使用内置列表';
      return;
    }

    // 自带 Key：先由服务端代拉，避免浏览器直连第三方接口被跨域拦截
    const test = await aiApi.test({
      provider: ai.value.provider,
      baseUrl: ai.value.baseUrl,
      apiKey: ai.value.apiKey,
      model: ai.value.model,
    });
    if (test.ok && test.models?.length) {
      applyModelList(test.models, `服务端已代拉 ${test.models.length} 个模型，请点击勾选要启用的模型（${test.latencyMs} ms）`);
      return;
    }

    // 服务端未返回模型：降级直连，失败时给出说明性提示而非生硬的「接口返回 401」
    try {
      const client = new AIClient(ai.value);
      const res = await client.listModels();
      applyModelList(
        res.models,
        res.source === 'upstream'
          ? `已从接口获取 ${res.models.length} 个模型，请点击勾选要启用的模型`
          : (res.message ?? ''),
      );
    } catch {
      modelList.value = [...aiPreset.value.models];
      modelSource.value = `无法直连供应商接口（浏览器跨域限制），已使用内置模型列表${test.message ? `；服务端提示：${test.message}` : ''}`;
    }
  } catch (e) {
    modelList.value = [...aiPreset.value.models];
    modelSource.value = `获取失败：${(e as Error).message}，已使用内置模型列表`;
  } finally {
    loadingModels.value = false;
  }
}

/** 应用拉取到的模型列表：保留用户已勾选，未勾选时只默认勾选当前默认模型 */
function applyModelList(models: string[], message: string): void {
  modelList.value = models;
  modelSource.value = message;
  const existing = ai.value.models.filter((m) => models.includes(m));
  const defaultM = models.includes(ai.value.model) ? ai.value.model : (models[0] ?? ai.value.model);
  const nextSelected = existing.length ? existing : defaultM ? [defaultM] : [];
  settingsStore.previewAppearance(null);
  draft.value = mergeDraftPatch(draft.value, { ai: { ...ai.value, models: nextSelected, model: defaultM } });
}

function toggleModel(m: string): void {
  const cur = ai.value.models ?? [];
  const list = cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m];
  patchSettings({ ai: { ...ai.value, models: list } });
}

/* --------------------------- 对象存储检测 --------------------------- */

/** 未登录时的统一提示（检测与 AI 测试都需要服务端代探） */
const LOGIN_REQUIRED_STORAGE = '请先登录后再测试对象存储连接（检测需要服务端代探以绕过浏览器跨域限制）';
const LOGIN_REQUIRED_AI = '请先登录后测试 AI 服务';

function resetProbe(): void {
  probeResult.value = '';
  probeOk.value = false;
  probeSteps.value = [];
}

/**
 * 任务 1：对象存储连通性检测改走服务端 `/api/oss/probe`。
 * 浏览器直连 OSS 不会返回 CORS 头，一定会 Failed to fetch，故必须由服务端代探。
 */
async function testStorage(): Promise<void> {
  resetProbe();

  if (!auth.isLoggedIn) {
    probeOk.value = false;
    probeResult.value = LOGIN_REQUIRED_STORAGE;
    return;
  }
  if (storageConfigIssues.value.length) {
    probeOk.value = false;
    probeResult.value = '请先填写完整配置';
    return;
  }

  probing.value = true;
  try {
    const cfg = { ...storage.value };
    // endpoint 允许省略协议，这里统一补全后再提交
    const normalized = normalizeEndpoint(cfg.endpoint);
    if (normalized) cfg.endpoint = normalized;
    const res = await uploadApi.probe({ storage: cfg, prefix: `${cfg.basePrefix || ''}probe/` });
    probeOk.value = res.ok;
    probeSteps.value = res.steps ?? [];
    probeResult.value = res.ok
      ? `连接正常（总耗时 ${res.latencyMs} ms）`
      : `检测失败：${res.message}`;
  } catch (e) {
    probeOk.value = false;
    probeResult.value = `检测失败：${(e as Error).message}`;
  } finally {
    probing.value = false;
  }
}

/** 把后端步骤名映射为中文（列举 / 写入 / 读取 / 删除） */
const STEP_LABELS: Record<OssProbeStepDto['name'], string> = {
  list: '列举',
  put: '写入',
  get: '读取',
  delete: '删除',
};

/** 表格行：把可能缺失的步骤归一成统一结构，避免模板里做联合类型收窄 */
interface ProbeStepRow {
  name: OssProbeStepDto['name'];
  ok: boolean;
  latencyMs: number;
  message: string;
  missing: boolean;
}

/** 始终按「列举 → 写入 → 读取 → 删除」固定顺序展示，缺失的步骤补为占位行 */
const orderedSteps = computed<ProbeStepRow[]>(() => {
  const ORDER: OssProbeStepDto['name'][] = ['list', 'put', 'get', 'delete'];
  if (!probeSteps.value.length) return [];
  return ORDER.map((name) => {
    const hit = probeSteps.value.find((s) => s.name === name);
    if (!hit) return { name, ok: false, latencyMs: 0, message: '未执行', missing: true };
    return { name, ok: Boolean(hit.ok), latencyMs: Number(hit.latencyMs ?? 0), message: hit.message ?? '', missing: false };
  });
});

/* ------------------------------ AI 检测 ------------------------------ */

function resetAiTest(): void {
  aiTestResult.value = '';
  aiTestOk.value = false;
}

/**
 * 任务 2：AI 连通性测试改走服务端 `/api/ai/test`。
 * 平台模式与自带 Key 均不再由网页端直连第三方接口。
 */
async function testAI(): Promise<void> {
  resetAiTest();

  if (!auth.isLoggedIn) {
    aiTestOk.value = false;
    aiTestResult.value = LOGIN_REQUIRED_AI;
    return;
  }

  const isPlatform = ai.value.provider === 'platform' || ai.value.usePlatform;
  if (!isPlatform && aiConfigIssues.value.length) {
    aiTestOk.value = false;
    aiTestResult.value = `请先填写完整配置：${aiConfigIssues.value[0]}`;
    return;
  }

  aiTesting.value = true;
  try {
    const res = isPlatform
      ? await aiApi.test({ provider: 'platform', model: ai.value.model, usePlatform: true })
      : await aiApi.test({
          provider: ai.value.provider,
          baseUrl: ai.value.baseUrl,
          apiKey: ai.value.apiKey,
          model: ai.value.model,
        });

    aiTestOk.value = res.ok;
    if (res.ok) {
      const count = res.models?.length ?? 0;
      aiTestResult.value = isPlatform
        ? `平台通道就绪（可用模型 ${count} 个）`
        : `连通正常（${res.latencyMs} ms，可用模型 ${count} 个）`;
      if (res.models?.length) modelList.value = res.models;
    } else {
      // 失败仍是 HTTP 200，必须看 data.ok 而非 catch
      aiTestResult.value = res.message;
    }
  } catch (e) {
    aiTestOk.value = false;
    aiTestResult.value = (e as Error).message;
  } finally {
    aiTesting.value = false;
  }
}

/** 云端同步（推 / 拉）：必须有 loading 与失败原因展示，禁止静默失败 */
async function syncToCloud(): Promise<void> {
  if (!auth.isLoggedIn) {
    saveMessageOk.value = false;
    saveMessage.value = '请先登录后再同步设置到云端';
    return;
  }
  saving.value = true;
  saveMessage.value = '';
  try {
    const s = settingsStore.settings;
    const payload = {
      appearance: s.appearance,
      naming: s.naming,
      layout: s.layout,
      shortcuts: s.shortcuts,
      enabledPlugins: s.enabledPlugins,
      storage: { ...storage.value, accessKeyId: '', accessKeySecret: '' },
      ai: { ...ai.value, apiKey: '' },
      sync: { ...sync.value, deviceId: '' },
    };
    const sensitive = {
      storage: { accessKeyId: storage.value.accessKeyId, accessKeySecret: storage.value.accessKeySecret },
      ai: { apiKey: ai.value.apiKey },
    };
    const res = await settingsApi.put({
      payload,
      sensitive,
      version: s.cloudVersion ?? 0,
      deviceId: sync.value.deviceId || 'web',
    });
    settingsStore.update({ cloudVersion: res.version });
    saveMessageOk.value = true;
    saveMessage.value = '已同步到云端。';
  } catch (e) {
    saveMessageOk.value = false;
    saveMessage.value = `同步失败：${(e as Error).message}`;
  } finally {
    saving.value = false;
  }
}

async function pullFromCloud(): Promise<void> {
  if (!auth.isLoggedIn) {
    saveMessageOk.value = false;
    saveMessage.value = '请先登录后再从云端恢复设置';
    return;
  }
  saving.value = true;
  saveMessage.value = '';
  try {
    const res = await settingsApi.get();
    // 服务端 payload 为自由结构，按本地 Settings 局部结构断言后用 mergeSettings 合并（缺字段自动补默认值）
    const payload: Partial<Settings> =
      res.payload && typeof res.payload === 'object' ? (res.payload as Partial<Settings>) : {};
    settingsStore.update({ ...payload, cloudVersion: res.version });
    const sensitive = res.sensitive as { storage?: { accessKeyId?: string; accessKeySecret?: string }; ai?: { apiKey?: string } };
    if (sensitive?.storage?.accessKeySecret) settingsStore.setSecret('storage', sensitive.storage.accessKeySecret);
    if (sensitive?.storage?.accessKeyId) settingsStore.setStorageKeyId(sensitive.storage.accessKeyId);
    if (sensitive?.ai?.apiKey) settingsStore.setSecret('ai', sensitive.ai.apiKey);
    /*
     * 云端恢复是「整份覆盖」动作：草稿必须跟着刷新，否则页面还显示旧值、
     * 用户再点一次「保存」会把刚恢复的云端设置又推回本端旧值。
     * 这里同时把基线推进到新值，脏标记归零。
     */
    draft.value = draftFromStore();
    draftBaseline.value = JSON.stringify(draft.value);
    settingsStore.previewAppearance(null);
    saveMessageOk.value = true;
    saveMessage.value = '已从云端恢复设置。';
  } catch (e) {
    saveMessageOk.value = false;
    saveMessage.value = `拉取失败：${(e as Error).message}`;
  } finally {
    saving.value = false;
  }
}

async function saveProfile(): Promise<void> {
  if (!auth.isLoggedIn) {
    saveMessageOk.value = false;
    saveMessage.value = '请先登录后再保存资料';
    return;
  }
  saving.value = true;
  try {
    await profileApi.update({ nickname: nickname.value, avatarUrl: avatarUrl.value });
    if (auth.user) {
      auth.user = { ...auth.user, nickname: nickname.value, avatarUrl: avatarUrl.value };
    }
    saveMessageOk.value = true;
    saveMessage.value = '资料已保存。';
  } catch (e) {
    saveMessageOk.value = false;
    saveMessage.value = `保存失败：${(e as Error).message}`;
  } finally {
    saving.value = false;
  }
}

async function changePassword(): Promise<void> {
  if (newPassword.value.length < 8) {
    saveMessageOk.value = false;
    saveMessage.value = '新密码至少 8 位';
    return;
  }
  saving.value = true;
  try {
    await profileApi.changePassword({ oldPassword: oldPassword.value, newPassword: newPassword.value });
    oldPassword.value = '';
    newPassword.value = '';
    saveMessageOk.value = true;
    saveMessage.value = '密码已修改，其他设备需重新登录。';
  } catch (e) {
    saveMessageOk.value = false;
    saveMessage.value = `修改失败：${(e as Error).message}`;
  } finally {
    saving.value = false;
  }
}

function toggleRibbonItem(id: string): void {
  const items = ribbonItems.value.includes(id)
    ? ribbonItems.value.filter((x) => x !== id)
    : [...ribbonItems.value, id];
  patchLayout({ ribbonItems: items });
  flashSaved();
}

const RIGHT_SECTION_OPTIONS: Array<{ id: RightPanelSection; label: string }> = [
  { id: 'ai', label: 'AI 助手' },
  { id: 'file', label: '文件操作' },
  { id: 'outline', label: '大纲' },
  { id: 'backlinks', label: '反向链接' },
  { id: 'tags', label: '标签' },
  { id: 'history', label: '版本历史' },
  { id: 'stats', label: '文档统计' },
  { id: 'calendar', label: '日历' },
];

/**
 * 切换右侧栏区块的开启状态。
 *
 * 1.4.0：改为走 `toggleRightSectionWithLimit()`，与 EditorPage 的右侧栏开关条
 * **共用同一份上限语义**（最多 `RIGHT_SECTION_LIMIT` 个、超出时挤掉最上方一个）。
 * 改前这里是无上限 push，用户能在设置页把 8 个区块全打开，绕过编辑器那边的限制 ——
 * `.rightstack` 溢出后末位区块只剩 52px 可见，等于开了也用不了。
 */
function toggleRightSection(sec: RightPanelSection): void {
  const { list, evicted } = toggleRightSectionWithLimit(rightPanelSections.value, sec, RIGHT_SECTION_LIMIT);
  patchLayout({ rightPanelSections: list });
  if (evicted) {
    const label = RIGHT_SECTION_OPTIONS.find((o) => o.id === evicted)?.label ?? evicted;
    app.notify(
      `右侧栏最多同时显示 ${RIGHT_SECTION_LIMIT} 个，已自动关闭最上方的「${label}」以腾出位置`,
      'info',
      3600,
    );
  }
}

/* --------------------------- 危险操作（需确认） --------------------------- */

/** 清空对象存储密钥（只改草稿，保存后生效） */
function clearStorageSecrets(): void {
  askConfirm({
    title: '清空对象存储密钥',
    message: '将清空已保存的 AccessKey ID 与 AccessKey Secret，云端同步的密钥也会被覆盖。确定继续？',
    confirmText: '清空密钥',
    action: () => {
      draft.value.storage = { ...draft.value.storage, accessKeyId: '', accessKeySecret: '' };
      resetProbe();
      flashSaved('已清空存储密钥（点「保存」生效）');
    },
  });
}

/** 清空 AI API Key（只改草稿，保存后生效） */
function clearAiKey(): void {
  askConfirm({
    title: '清空 AI API Key',
    message: '将清空已保存的 AI API Key，之后无法再调用第三方 AI 服务（平台积分模式不受影响）。确定继续？',
    confirmText: '清空 Key',
    action: () => {
      draft.value.ai = { ...draft.value.ai, apiKey: '' };
      resetAiTest();
      flashSaved('已清空 AI Key（点「保存」生效）');
    },
  });
}

/** 重置全部快捷键（只改草稿，保存后生效） */
function resetShortcuts(): void {
  askConfirm({
    title: '重置快捷键',
    message: '将清空所有自定义快捷键绑定，恢复为默认组合键。此操作在点「保存」后生效。',
    confirmText: '重置快捷键',
    action: () => {
      draft.value.shortcuts = [...FALLBACK.shortcuts];
      flashSaved('已重置快捷键（点「保存」生效）');
    },
  });
}

/** 恢复全部设置为默认值（保留账号与密钥；只改草稿，保存后生效） */
function resetAllSettings(): void {
  askConfirm({
    title: '恢复默认设置',
    message: '将把外观、命名、布局、快捷键、插件开关等全部恢复为默认值；对象存储与 AI 的账号密钥不会被清除。确定继续？',
    confirmText: '恢复默认',
    action: () => {
      resetDraftToDefault();
    },
  });
}

const shortcutGroups = computed(() => {
  const map = new Map<string, Array<{ command: string; keys: string[] }>>();
  for (const s of shortcuts.value) {
    const group = s.command.split('.')[0] ?? 'other';
    const list = map.get(group) ?? [];
    list.push({ command: s.command, keys: s.keys });
    map.set(group, list);
  }
  return [...map.entries()];
});

const COMMAND_LABELS: Record<string, string> = {
  'editor.h1': '标题 1', 'editor.h2': '标题 2', 'editor.h3': '标题 3',
  'editor.h4': '标题 4', 'editor.h5': '标题 5', 'editor.h6': '标题 6',
  'editor.bold': '加粗', 'editor.italic': '斜体', 'editor.underline': '下划线',
  'editor.strike': '删除线', 'editor.highlight': '高亮', 'editor.code': '行内代码',
  'editor.codeBlock': '代码块', 'editor.link': '插入链接', 'editor.quote': '引用',
  'editor.taskList': '任务列表', 'editor.bulletList': '无序列表', 'editor.numberedList': '有序列表',
  'editor.table': '插入表格', 'editor.hr': '分隔线',
  'app.save': '保存', 'app.sync': '同步', 'app.commandPalette': '命令面板',
  'app.quickSwitch': '快速切换', 'app.search': '全库搜索', 'app.newNote': '新建笔记',
  'app.closeTab': '关闭标签页', 'app.reopenTab': '恢复标签页', 'app.toggleSidebar': '切换侧栏',
  'app.toggleAi': '切换 AI 面板', 'app.toggleMode': '切换视图方式', 'app.settings': '打开设置',
  'app.export': '导出文档', 'daily.today': '今日日记', 'random.open': '漫游笔记',
};

const captureCommand = ref<string | null>(null);

function startCapture(command: string): void {
  captureCommand.value = command;
}

function onCaptureKey(e: KeyboardEvent, command: string): void {
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') {
    captureCommand.value = null;
    return;
  }
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let main = e.key;
  if (main === ' ') main = 'Space';
  else if (main === 'Escape') main = 'Esc';
  else if (main.length === 1) main = main.toUpperCase();
  parts.push(main);
  const combo = parts.join('+');
  draft.value.shortcuts = shortcuts.value.map((s) => (s.command === command ? { ...s, keys: [combo] } : s));
  captureCommand.value = null;
  flashSaved('快捷键已更新（点「保存」生效）');
}

/**
 * 整页设置：组件挂载即视为「打开」，因此直接用 onMounted 做初始化，
 * 不再监听 modelValue（整页版没有模态开关）。
 */
onMounted(() => {
  const requested = (props.initialTab as TabId) ?? 'general';
  if (runtime.platform === 'web' && (requested === 'server' || requested === 'import')) {
    tab.value = 'general';
  } else {
    tab.value = requested;
  }
  resetProbe();
  resetAiTest();
  saveMessage.value = '';
  savedHint.value = '';
  confirmDialog.value.open = false;
  nickname.value = auth.user?.nickname ?? '';
  avatarUrl.value = auth.user?.avatarUrl ?? '';
  // 打开设置页时静默拉一次云端设置，保证跨端一致。
  // 1.1.7：改用节流版 requestCloudPull()，不再每次打开都强制全量拉取 ——
  // 频繁强拉会把「本地刚改、还没推上去」的主题冲掉（配合 store 的 themeDirtySince 双重保护）。
  settingsStore.requestCloudPull();
  // 1.1.7：拉一次后台配置的 AI 供应商展示元数据（申请地址 / 启用状态 / 说明 / 排序）。
  // 失败不影响页面，前台会回落到内置预设。
  void loadProviderMeta();
  // 1.1.8：平台 AI 服务区块的数据（可用模型清单 + 积分余额）
  void loadPlatformModels();
  void loadAiCredits();
  // 窄屏判定统一在这里同步一次，避免首次打开闪一下宽布局
  isNarrow.value = typeof window !== 'undefined' ? window.matchMedia('(max-width: 760px)').matches : false;
});

watch(
  () => tab.value,
  (t) => {
    if (t === 'ai' && !modelList.value.length && (ai.value.models?.length || aiPreset.value.models.length)) {
      modelList.value = ai.value.models?.length ? ai.value.models : aiPreset.value.models;
    }
  },
);

onMounted(() => {
  if (typeof window === 'undefined') return;
  narrowQuery = window.matchMedia('(max-width: 760px)');
  isNarrow.value = narrowQuery.matches;
  narrowQuery.addEventListener?.('change', onNarrowChange);
});

function openConsole(): void {
  window.open(aiPreset.value.console, '_blank', 'noopener');
}

/* ------------------------ 字体选项（1.1.7 需求 G） ------------------------ */

/**
 * 正文字体下拉选项：**按运行平台给出不同列表**。
 *
 * 产品约束：PC 端应该只提供**系统自带字体**（Windows 本地一定有，无需下载、
 * 不占安装包体积）；网页端才允许提供内嵌 webfont（需从网络加载）。
 *
 * 实现方式：桌面端用 `document.fonts.check()` 探测本机是否真有该字体，
 * 没装的直接不列出，避免用户选了却回退到默认字体（看起来「没生效」）。
 */
interface FontOption {
  label: string;
  value: string;
  /** 用于探测的 CSS font-family 片段（不含引号差异） */
  probe?: string;
}

/** PC 端候选：均为 Windows 自带或 Office 常备字体 */
const DESKTOP_FONT_CANDIDATES: FontOption[] = [
  { label: '系统默认', value: 'system-ui' },
  { label: '微软雅黑 Microsoft YaHei', value: "'Microsoft YaHei', sans-serif", probe: 'Microsoft YaHei' },
  { label: '等线 DengXian', value: "DengXian, 'Microsoft YaHei', sans-serif", probe: 'DengXian' },
  { label: '宋体 SimSun', value: "SimSun, 'Songti SC', serif", probe: 'SimSun' },
  { label: '黑体 SimHei', value: "SimHei, sans-serif", probe: 'SimHei' },
  { label: '楷体 KaiTi', value: "KaiTi, serif", probe: 'KaiTi' },
  { label: '仿宋 FangSong', value: "FangSong, serif", probe: 'FangSong' },
  { label: 'Segoe UI', value: "'Segoe UI', sans-serif", probe: 'Segoe UI' },
  { label: '等宽 Consolas', value: "Consolas, 'Cascadia Mono', monospace", probe: 'Consolas' },
  { label: '等宽 Cascadia Code', value: "'Cascadia Code', Consolas, monospace", probe: 'Cascadia Code' },
];

/** 网页端候选：含内嵌字体（webfont 由系统/浏览器提供，跨平台可用） */
const WEB_FONT_CANDIDATES: FontOption[] = [
  { label: '系统默认', value: 'system-ui' },
  { label: '无衬线（Segoe UI / 苹方 / 雅黑）', value: "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif" },
  { label: '衬线（Georgia / 宋体）', value: "Georgia, 'Songti SC', 'SimSun', serif" },
  { label: '等宽（Consolas / 苹方等宽）', value: "'Cascadia Code', Consolas, Menlo, monospace" },
  { label: '楷体（KaiTi / Kaiti SC）', value: "KaiTi, 'Kaiti SC', serif" },
];

/** 探测本机某字体是否可用（仅桌面端有意义） */
function fontAvailable(family: string): boolean {
  if (typeof document === 'undefined') return false;
  try {
    return document.fonts?.check?.(`16px "${family}"`) ?? false;
  } catch {
    return false;
  }
}

/**
 * 当前平台可用的字体列表。
 *
 * 桌面端：只列系统自带字体，并用 `document.fonts.check` 过滤掉本机没装的；
 * 网页端：给出通用族 + 内嵌字体组合（不做探测，浏览器会自行回退）。
 * 兜底：若桌面端探测把列表压到只剩「系统默认」，说明探测接口不可用，
 * 此时退回完整候选表（宁可多列，也不要只剩一项）。
 */
const FONT_OPTIONS = computed<FontOption[]>(() => {
  if (runtime.platform !== 'desktop') return WEB_FONT_CANDIDATES;
  const detected = DESKTOP_FONT_CANDIDATES.filter((f) => !f.probe || fontAvailable(f.probe));
  return detected.length > 1 ? detected : DESKTOP_FONT_CANDIDATES;
});

/** 字体区提示文案（说明当前平台策略） */
const fontHint = computed(() => {
  if (runtime.platform === 'desktop') {
    return 'PC 端仅列出本机已安装的系统字体（无需额外下载，不占安装包体积）。';
  }
  return '网页端提供内嵌字体选项，跨平台可用；实际渲染以浏览器可用字体为准。';
});

/**
 * 恢复默认字体与配套排版（1.1.8 需求 B）。
 *
 * 一次把 fontFamily / fontSize / lineHeight 三项恢复到出厂值，
 * 而不是只重置字体 —— 用户点「恢复默认字体」的心理预期是「正文看起来回到原样」，
 * 只改字体而字号行高仍是调过的值，视觉上不会「回到默认」。
 */
function resetFontSettings(): void {
  const fb = FALLBACK.appearance;
  patchAppearance({
    fontFamily: fb.fontFamily,
    fontSize: fb.fontSize,
    lineHeight: fb.lineHeight,
  });
  flashSaved('已恢复默认字体与排版');
}

/* ------------------------ 主题（1.1.1 重构为可操作版） ------------------------ */

/**
 * 选中某个主题预设。
 *
 * 1.4.0：只写**草稿**（含「主题 accent 镜像到 appearance.accent」），
 * 由 `scheduleLivePreview()` 立即预览；点「保存」才真正落 store + 推云端。
 *
 * 为什么不再调 `settingsStore.applyThemePreset()`：那个方法会立刻写 store、
 * 落 localStorage、推云端，与「保存按钮」语义直接冲突（需求 16）。
 * 它内部做的四件事这里逐项搬到草稿上：
 *   1. `theme` 跟随主题明暗；
 *   2. `themePresetId` 指向新主题；
 *   3. `accent` 镜像主题强调色；
 *   4. 旧版正文字段（editorColorScheme / customEditorBg / customEditorFg）同步，
 *      否则 EditorPage 里残留的旧内联色会盖住新主题变量。
 */
function applyTheme(id: string): void {
  const theme = findTheme(id, appearance.value.customThemes);
  if (!theme) return;
  patchAppearance({
    theme: theme.mode,
    themePresetId: theme.id,
    accent: theme.accent,
    editorColorScheme: PRESET_TO_LEGACY_SCHEME[theme.id] ?? 'custom',
    customEditorBg: theme.contentBg,
    customEditorFg: theme.contentFg,
  });
  flashSaved(`已选择「${theme.name}」（点「保存」生效）`);
}

/** 删除自定义主题（内置主题不可删；只改草稿） */
function removeTheme(t: ThemePreset): void {
  if (!isCustomTheme(t)) return;
  const list = (appearance.value.customThemes ?? []).filter((x) => x.id !== t.id);
  const wasActive = currentTheme.value.id === t.id;
  if (wasActive) {
    const fallback = getTheme(DEFAULT_THEME_ID);
    draft.value.appearance = {
      ...appearance.value,
      customThemes: list,
      ...(fallback
        ? {
            theme: fallback.mode,
            themePresetId: fallback.id,
            accent: fallback.accent,
            editorColorScheme: PRESET_TO_LEGACY_SCHEME[fallback.id] ?? 'custom',
            customEditorBg: fallback.contentBg,
            customEditorFg: fallback.contentFg,
          }
        : {}),
    };
  } else {
    draft.value.appearance = { ...appearance.value, customThemes: list };
  }
  scheduleLivePreview();
  flashSaved('已删除自定义主题（点「保存」生效）');
}

const customThemeOpen = ref(false);
const themeImportOpen = ref(false);
const themeImportText = ref('');

/**
 * 当前生效主题（内置或自定义）—— **按草稿计算**。
 *
 * 这里不再读 `settingsStore.activeTheme`：草稿模式下用户点了主题卡片但还没保存，
 * 预览区、卡片高亮、颜色细化面板都必须显示「草稿里选中的那套」，
 * 否则界面自相矛盾（卡片高亮已变、预览还是旧主题）。
 */
const currentTheme = computed<ThemePreset>(() => {
  const prefersDark =
    typeof window !== 'undefined'
      ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
      : false;
  return resolveTheme(appearance.value, { prefersDark });
});

/** 主题库（内置 + 自定义；按草稿的 customThemes） */
const themeCards = computed<ThemePreset[]>(() => allThemes(appearance.value.customThemes));

/** 当前主题是否为自定义（可编辑颜色 / 可删除） */
const currentIsCustom = computed(() => isCustomTheme(currentTheme.value));

/**
 * 颜色细化编辑的**本地草稿**。
 *
 * 为什么在「设置草稿」之上还要再来一层颜色草稿：
 * - 内置主题不可写（用户改内置主题不该污染内置定义），必须「存为新主题」才落地；
 * - 自定义主题改色时逐字符输入，直接改外层草稿会让主题卡片频繁重排；
 * - 这层草稿让「颜色预览」与「写入主题」解耦：预览用这一层，落盘走显式按钮。
 */
interface ColorDraft {
  contentBg: string;
  contentFg: string;
  chromeBg: string;
  border: string;
  accent: string;
}

function draftFromTheme(t: ThemePreset): ColorDraft {
  return {
    contentBg: t.contentBg,
    contentFg: t.contentFg,
    chromeBg: t.chromeBg,
    border: t.border,
    accent: t.accent,
  };
}

const colorDraft = ref<ColorDraft>(draftFromTheme(resolveTheme(settingsStore.settings.appearance)));

/** 切换主题后把颜色草稿同步为新主题的值（否则预览与卡片不一致） */
watch(
  () => currentTheme.value.id,
  () => {
    colorDraft.value = draftFromTheme(currentTheme.value);
  },
);

/**
 * 颜色草稿是否有未保存改动（相对当前主题）。
 *
 * 注意与设置页顶层的 `draftDirty`（整份设置的脏标记）区分开：
 * 那个决定底部「保存」按钮是否可用，这个决定「存为新主题 / 保存配色」按钮是否可用。
 */
const colorDraftDirty = computed(() => {
  const t = currentTheme.value;
  const d = colorDraft.value;
  return (
    t.contentBg !== d.contentBg ||
    t.contentFg !== d.contentFg ||
    t.chromeBg !== d.chromeBg ||
    t.border !== d.border ||
    t.accent !== d.accent
  );
});

/** 恢复当前主题的默认颜色（内置主题回到内置定义；自定义主题回到首次保存值） */
function resetDraftColors(): void {
  const base = getTheme(currentTheme.value.id) ?? currentTheme.value;
  colorDraft.value = draftFromTheme(base);
  flashSaved('已恢复该主题默认配色');
}

/**
 * 主色调预设色板（1.4.0 从「通用」页签搬到「主题」，见需求 14）。
 *
 * 为什么保留这几个固定色而不是给自由取色器：主色调要驱动
 * `--accent-hover` / `--accent-weak` / `--bg-active` / `--sky` 等一串派生变量，
 * 任意色相都可能与某些主题的纸张色撞在一起（对比度崩掉）；
 * 这 5 个是跨 10 套内置主题都验过可用的。
 */
const ACCENT_SWATCHES: readonly string[] = ['#1677FF', '#0E9F6E', '#7C4DFF', '#FF8A3D', '#E5484D'];

/**
 * 应用范围：主题影响哪些部分。
 *
 * 存储位置说明：这是**本机 UI 偏好**（不改颜色本身），因此只放 localStorage，
 * 不进 settings（避免为了一个开关就触发云端推送）。默认「整体」。
 * key 与 `stores/settings.ts` 的 `THEME_SCOPE_STORAGE_KEY` 共用，保证 store 重算时读到同一份值。
 *
 * 1.4.0：切换范围属于「必须立即生效」的本机偏好（它决定配色覆盖到哪儿，
 * 与草稿里「选了哪套主题」是两件事），因此仍即时重算，不进草稿。
 * 重算时把**草稿外观**一起带上，避免「预览中切范围」被正式值覆盖。
 */
const themeScope = ref<ThemeScope>(readThemeScope());
watch(themeScope, (v) => {
  try {
    localStorage.setItem(THEME_SCOPE_STORAGE_KEY, v);
  } catch {
    /* 忽略 */
  }
  // 写 data 属性便于排查；真正的覆盖范围由 store 的 scopedThemeVars() 决定
  if (typeof document !== 'undefined') document.documentElement.dataset.themeScope = v;
  // 立即重算：按新范围把「主题值 / 中性基线」重新写到 <html>
  settingsStore.previewAppearance(draft.value.appearance);
});

/**
 * 把颜色草稿落地到**设置草稿**：内置主题 → 复制为新自定义主题；
 * 自定义主题 → 原地更新。仍需点底部「保存」才真正写 store + 推云端。
 *
 * ## 需求 13 的根因在这里
 *
 * 改前这里调 `settingsStore.applyThemePreset(currentTheme.value.id)`，
 * 而 `applyThemePreset()` 会把 `appearance.accent` **覆写成主题自带 accent**；
 * 随后 `applyThemeVars()` 又「只要 appearance.accent 有值就拿它覆盖主题 accent」——
 * 于是颜色细化里改的强调色被上一轮的主题值吞掉。
 * 现在强调色的优先级在 store 里已经区分「用户显式改色 vs 主题镜像」，
 * 并且这里写完草稿会立刻走 `scheduleLivePreview()`，改完就能看见效果。
 */
function saveDraftColors(): void {
  const d = colorDraft.value;
  const list = [...(appearance.value.customThemes ?? [])];
  if (currentIsCustom.value) {
    const idx = list.findIndex((t) => t.id === currentTheme.value.id);
    if (idx >= 0) {
      list[idx] = { ...list[idx]!, ...d };
      draft.value.appearance = { ...appearance.value, customThemes: list, accent: d.accent };
      scheduleLivePreview();
      flashSaved('配色已写入草稿，点「保存」生效');
      return;
    }
  }
  // 内置主题：基于当前主题派生一个新自定义主题
  const base = currentTheme.value;
  const theme: ThemePreset = {
    ...base,
    ...d,
    id: createThemeId(),
    name: `${base.name}（自定义）`,
    builtin: false,
  };
  list.push(theme);
  draft.value.appearance = {
    ...appearance.value,
    customThemes: list,
    theme: theme.mode,
    themePresetId: theme.id,
    accent: theme.accent,
    editorColorScheme: PRESET_TO_LEGACY_SCHEME[theme.id] ?? 'custom',
    customEditorBg: theme.contentBg,
    customEditorFg: theme.contentFg,
  };
  scheduleLivePreview();
  flashSaved('已存为新主题（草稿），点「保存」生效');
}

/** 把当前配色存为新主题（复制一份，不动原主题；写入草稿） */
function duplicateAsTheme(): void {
  const base = { ...currentTheme.value, ...colorDraft.value };
  const theme: ThemePreset = {
    ...base,
    id: createThemeId(),
    name: `${currentTheme.value.name} 副本`,
    builtin: false,
  };
  draft.value.appearance = {
    ...appearance.value,
    customThemes: [...(appearance.value.customThemes ?? []), theme],
    theme: theme.mode,
    themePresetId: theme.id,
    accent: theme.accent,
    editorColorScheme: PRESET_TO_LEGACY_SCHEME[theme.id] ?? 'custom',
    customEditorBg: theme.contentBg,
    customEditorFg: theme.contentFg,
  };
  scheduleLivePreview();
  flashSaved('已复制为新主题（草稿），点「保存」生效');
}

/** 重置为内置默认主题（日光白；只改草稿） */
function resetToDefaultTheme(): void {
  applyTheme(DEFAULT_THEME_ID);
}

const themeDraft = ref<ThemePreset>(blankCustomTheme(BUILTIN_THEMES[0]));

/** 打开「新建主题」时以当前主题为基准 */
function openNewTheme(): void {
  themeDraft.value = { ...blankCustomTheme(currentTheme.value), name: '' };
  customThemeOpen.value = true;
}

/** 保存自定义主题（写入草稿，仍需点底部「保存」） */
function saveCustomTheme(): void {
  const name = themeDraft.value.name.trim();
  if (!name) {
    flashSaved('请先填写主题名称');
    return;
  }
  const theme: ThemePreset = { ...themeDraft.value, name, builtin: false };
  draft.value.appearance = {
    ...appearance.value,
    customThemes: [...(appearance.value.customThemes ?? []), theme],
    theme: theme.mode,
    themePresetId: theme.id,
    accent: theme.accent,
    editorColorScheme: PRESET_TO_LEGACY_SCHEME[theme.id] ?? 'custom',
    customEditorBg: theme.contentBg,
    customEditorFg: theme.contentFg,
  };
  colorDraft.value = draftFromTheme(theme);
  scheduleLivePreview();
  customThemeOpen.value = false;
  flashSaved('已保存并应用自定义主题（草稿），点「保存」生效');
}

/** 导出全部自定义主题为 JSON（下载文件；以草稿为准） */
function exportThemes(): void {
  const list = appearance.value.customThemes ?? [];
  if (!list.length) {
    flashSaved('还没有自定义主题可导出');
    return;
  }
  const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'neomd-themes.json';
  a.click();
  URL.revokeObjectURL(url);
  flashSaved('主题已导出');
}

/** 从粘贴的 JSON 导入自定义主题（走 normalizeTheme 容错，脏数据不进草稿） */
function importThemes(): void {
  try {
    const parsed = JSON.parse(themeImportText.value) as unknown;
    const incoming = Array.isArray(parsed) ? parsed : [parsed];
    const valid = incoming.map((t) => normalizeTheme(t)).filter((t): t is ThemePreset => t !== null);
    if (!valid.length) {
      flashSaved('JSON 里没有有效的主题');
      return;
    }
    const existing = appearance.value.customThemes ?? [];
    const merged = [...existing.filter((e) => !valid.some((v) => v.id === e.id)), ...valid];
    draft.value.appearance = { ...appearance.value, customThemes: merged };
    themeImportOpen.value = false;
    themeImportText.value = '';
    flashSaved(`已导入 ${valid.length} 个主题（点「保存」生效）`);
  } catch {
    flashSaved('JSON 解析失败，请检查格式');
  }
}

/**
 * 预览区样式：把草稿颜色按 `scopedThemeVars()` 展开成一套 CSS 变量。
 *
 * 关键点：预览必须与真实渲染**用同一个函数**产出变量，
 * 否则「预览好看、实际难看」。这里把变量挂在预览容器的 :style 上，
 * 容器内部所有元素用 var(--xxx) 取色，等价于真实界面。
 *
 * 1.4.0：「应用范围」不再靠「删掉另一侧变量」实现（那样会回落到 themes.css 的
 * 同一套主题静态值、看起来没生效），而是与 store 一致地调 `scopedThemeVars()`，
 * 让被排除的一侧取中性基线 —— 预览区与真实界面同源。
 */
const previewStyle = computed<Record<string, string>>(() => {
  const themed: ThemePreset = { ...currentTheme.value, ...colorDraft.value };
  const vars = scopedThemeVars(themed, themeScope.value);
  const zoom = Math.min(300, Math.max(50, Number(appearance.value.zoom ?? 100)));
  const scaledFont = Math.round((appearance.value.fontSize || 16) * (zoom / 100) * 100) / 100;
  vars['--preview-font-family'] = appearance.value.fontFamily?.trim() || 'var(--font-ui)';
  vars['--preview-font-size'] = `${scaledFont}px`;
  vars['--preview-line-height'] = String(appearance.value.lineHeight || 1.75);
  return vars;
});

/**
 * 主题 id → 旧版「正文配色方案」的反向映射。
 *
 * `EditorPage.vue` 仍读 `editorColorScheme` 生成正文内联样式（该文件不属本任务），
 * 因此应用主题时必须把老字段写成等价方案，否则旧内联色会盖住新的主题变量。
 * store 里有一份同名常量（`PRESET_TO_LEGACY_SCHEME`），但它是模块私有的；
 * 这里保留同一份映射供草稿计算使用 —— 两处改动必须同步（审计脚本会比对）。
 */
const PRESET_TO_LEGACY_SCHEME: Record<string, EditorColorScheme> = {
  daylight: 'white',
  graphite: 'gray',
  midnight: 'black',
  'eyecare-green': 'green',
  'ocean-blue': 'lightblue',
};

/**
 * 有未保存改动时离开页面的浏览器级提醒。
 *
 * 为什么必须加：设置是**标签页**，用户很可能直接点 × 或按 Ctrl+W，
 * 而「取消 / 保存」栏在页面底部，容易被忽略。`beforeunload` 是唯一能拦住
 * 「直接关窗口」的钩子；标签页关闭由 `onBeforeUnmount` + 页面内确认条兜底。
 */
function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (!draftDirty.value) return;
  e.preventDefault();
  // 现代浏览器忽略自定义文案，但设置 returnValue 才会真的弹确认框
  e.returnValue = '设置里有未保存的改动，确定离开？';
}

onMounted(() => {
  if (typeof window !== 'undefined') window.addEventListener('beforeunload', onBeforeUnload);
});

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('beforeunload', onBeforeUnload);
  // 离开设置页时把预览态的 CSS 变量还原成 store 里的正式值，
  // 否则未保存的配色会「残留」到编辑器界面上（看起来像真的生效了）
  settingsStore.previewAppearance(null);
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
});

void app;

</script>
<template>
  <div class="settings-page" :class="{ 'is-narrow': isNarrow }">
    <header class="settings-page__head">
      <h2 class="settings-page__title">设置</h2>
      <div class="settings-page__head-actions">
        <!--
          1.4.0（需求16）：设置改为草稿模式，文案必须跟着改。
          改前写的是「改动即时生效并自动同步」，与「保存按钮」语义直接矛盾 ——
          用户按旧文案的预期直接关标签页，改动就静默丢了。
        -->
        <span class="settings-page__hint">
          改动先进入草稿，点底部「保存」才会生效并同步到云端
        </span>
        <label class="settings-page__preview-toggle" title="开启后，配色/主题类改动立即预览，但保存前不会写入设置">
          <input v-model="livePreview" type="checkbox" data-testid="live-preview-toggle" />
          <span>实时预览</span>
        </label>
      </div>
    </header>
    <div class="settings-page__wrap">
    <div class="settings" :class="{ 'is-narrow': isNarrow }">
      <nav class="settings__nav" role="tablist" aria-label="设置分类">
        <button
          v-for="t in TABS"
          :key="t.id"
          type="button"
          class="settings__nav-item"
          :class="{ 'is-active': tab === t.id }"
          role="tab"
          :aria-selected="tab === t.id"
          :title="t.label"
          @click="tab = t.id"
        >
          <NmIcon :name="t.icon" :size="15" />
          <span>{{ t.label }}</span>
        </button>
      </nav>

      <div class="settings__body nm-scroll">
        <!-- 顶部即时保存反馈（1.5s 自动消失） -->
        <Transition name="hint-fade">
          <p v-if="savedHint" class="saved-hint" role="status" aria-live="polite">
            <NmIcon name="check" :size="13" />{{ savedHint }}
          </p>
        </Transition>

        <!-- 通用 -->
        <section v-if="tab === 'general'" class="pane">
          <h3 class="pane__title">明暗外观</h3>
          <div class="field">
            <label class="nm-label">主题</label>
            <div class="seg">
              <button
                v-for="t in (['system', 'light', 'dark'] as const)"
                :key="t"
                type="button"
                class="seg__item"
                :class="{ 'is-active': appearance.theme === t }"
                :title="t === 'system' ? '跟随系统主题' : t === 'light' ? '浅色主题' : '深色主题'"
                @click="patchAppearance({ theme: t })"
              >
                {{ t === 'system' ? '跟随系统' : t === 'light' ? '浅色' : '深色' }}
              </button>
            </div>
            <!--
              1.4.0（需求14）：「主色调」已从本页签移到「主题」页签。
              它是**配色**，和主题预设/颜色细化在一起才找得到；留在「通用」里
              既不符合语义，也让同一件事散落在两个页签（1.2.1 收敛过的老问题）。
              这里只留一句指引，避免老用户找不到。
            -->
            <p class="nm-hint">
              主色调与配色细化已移到「主题」页签；明暗只是主题的明暗基调，选中后仍需点「保存」。
            </p>
          </div>

          <h3 class="pane__title">新建命名</h3>
          <div class="field">
            <label class="nm-label">命名方式</label>
            <div class="seg">
              <button
                type="button"
                class="seg__item"
                :class="{ 'is-active': naming.mode === 'datetime-input' }"
                @click="patchSettings({ naming: { ...naming, mode: 'datetime-input' } })"
              >
                日期时间自动命名
              </button>
              <button
                type="button"
                class="seg__item"
                :class="{ 'is-active': naming.mode === 'ai-after-save' }"
                @click="patchSettings({ naming: { ...naming, mode: 'ai-after-save' } })"
              >
                AI 保存后命名
              </button>
            </div>
            <p class="nm-hint">
              新建文档不再弹窗输入名称，直接按模板自动命名并进入编辑；已配置 AI 时，首次保存会再按正文内容自动改名。
            </p>
          </div>
          <div class="field">
            <label class="nm-label">命名模板</label>
            <input
              class="nm-input"
              :value="naming.template"
              placeholder="YY年MM月DD日HHMM"
              @input="patchSettings({ naming: { ...naming, template: ($event.target as HTMLInputElement).value } })"
            />
            <p class="nm-hint">可用占位符：YY、YYYY、MM、DD、HH、mm、ss、input</p>
          </div>
          <div class="field">
            <div class="row-between">
              <label class="nm-label">AI 命名提示词</label>
              <button
                class="nm-btn nm-btn--sm"
                type="button"
                title="恢复默认的 AI 命名提示词"
                aria-label="恢复默认的 AI 命名提示词"
                @click="patchSettings({ naming: { ...naming, aiPrompt: DEFAULT_AI_TITLE_PROMPT } })"
              >
                恢复默认提示词
              </button>
            </div>
            <textarea
              class="nm-input"
              rows="4"
              :value="naming.aiPrompt ?? DEFAULT_AI_TITLE_PROMPT"
              placeholder="输入用于 AI 生成文档标题的系统提示词…"
              @input="patchSettings({ naming: { ...naming, aiPrompt: ($event.target as HTMLTextAreaElement).value } })"
            />
            <p class="nm-hint">AI 保存后自动命名及重命名弹窗中的「AI 命名」均使用此提示词。</p>
          </div>

          <div class="nm-divider" />
          <h3 class="pane__title">维护</h3>
          <div class="field">
            <p class="nm-hint">以下操作会覆盖当前配置，执行前会二次确认。</p>
            <div class="actions-row">
              <button
                type="button"
                class="nm-btn nm-btn--sm"
                title="恢复全部设置为默认值"
                aria-label="恢复全部设置为默认值"
                @click="resetAllSettings"
              >
                <NmIcon name="restore" :size="13" />
                恢复默认设置
              </button>
            </div>
          </div>
        </section>

        <!-- 编辑器 -->

        <!-- 主题（1.1.1：正文配色并入主题，重构为可操作版） -->
        <section v-else-if="tab === 'theme'" class="pane">
          <h3 class="pane__title">主题</h3>
          <p class="nm-hint">
            主题决定整套配色：正文纸张、侧栏、工具栏、状态栏一并变化。选中即生效，并自动跨端同步。
          </p>

          <!-- ① 实时预览：与真实渲染共用 themeVars()，改任何颜色立刻可见 -->
          <div class="theme-preview" :style="previewStyle" data-testid="theme-preview">
            <div class="theme-preview__chrome">
              <span class="theme-preview__dot" />
              <span class="theme-preview__dot" />
              <span class="theme-preview__dot" />
              <span class="theme-preview__tag">{{ currentTheme.name }}</span>
            </div>
            <div class="theme-preview__paper">
              <h4 class="theme-preview__h">示例标题</h4>
              <p class="theme-preview__p">
                正文会使用主题的纸张色与文字色，<a class="theme-preview__a" href="#" @click.prevent>这是一个链接</a>，
                强调色同步变化。
              </p>
              <blockquote class="theme-preview__quote">引用块使用主题派生的引用底色。</blockquote>
              <pre class="theme-preview__code"><code>const theme = 'code-block-bg';</code></pre>
              <table class="theme-preview__table">
                <thead>
                  <tr><th>列 A</th><th>列 B</th></tr>
                </thead>
                <tbody>
                  <tr><td>表格边框</td><td>跟随主题</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- ② 主题卡片网格 -->
          <h3 class="pane__title">选择主题</h3>
          <div class="themes" data-testid="theme-cards">
            <button
              v-for="t in themeCards"
              :key="t.id"
              type="button"
              class="theme-card"
              :class="{ 'is-active': currentTheme.id === t.id }"
              :title="`应用主题：${t.name}`"
              :aria-pressed="currentTheme.id === t.id"
              @click="applyTheme(t.id)"
            >
              <span class="theme-card__preview" :style="{ background: t.chromeBg, borderColor: t.border }">
                <span class="theme-card__paper" :style="{ background: t.contentBg, color: t.contentFg }">Aa 正文</span>
                <span class="theme-card__bar" :style="{ background: t.accent }" />
              </span>
              <span class="theme-card__name">
                {{ t.name }}
                <NmIcon v-if="currentTheme.id === t.id" name="check" :size="12" />
              </span>
              <span
                v-if="isCustomTheme(t)"
                class="theme-card__del"
                role="button"
                :title="`删除自定义主题「${t.name}」`"
                @click.stop="removeTheme(t)"
              >删除</span>
            </button>
          </div>

          <!--
            ③ 主色调（1.4.0 需求14：从「通用」页签移到这里）。
            它是纯配色项，必须与主题预设/颜色细化放在同一页签；
            同时修掉「改了不生效」—— 见 store 的 applyThemeVars() 里强调色优先级逻辑。
          -->
          <div class="nm-divider" />
          <h3 class="pane__title">主色调</h3>
          <div class="field">
            <div class="swatches" data-testid="accent-swatches">
              <button
                v-for="c in ACCENT_SWATCHES"
                :key="c"
                type="button"
                class="swatch"
                :class="{ 'is-active': (appearance.accent ?? '').toLowerCase() === c.toLowerCase() }"
                :style="{ background: c }"
                :title="`主色调 ${c}`"
                :aria-label="`主色调 ${c}`"
                @click="patchAppearance({ accent: c })"
              />
            </div>
            <p class="nm-hint">
              主色调决定按钮、链接、选中态、聚焦边框与引用块底色。默认跟随所选主题；
              在这里选一个颜色会覆盖主题自带的强调色（颜色细化的「强调色」与此项同源）。
            </p>
          </div>

          <!-- ④ 应用范围 -->
          <div class="nm-divider" />
          <h3 class="pane__title">应用范围</h3>
          <div class="field">
            <div class="seg" data-testid="theme-scope">
              <button
                type="button"
                class="seg__item"
                :class="{ 'is-active': themeScope === 'all' }"
                @click="themeScope = 'all'"
              >整体（正文 + 界面）</button>
              <button
                type="button"
                class="seg__item"
                :class="{ 'is-active': themeScope === 'content' }"
                @click="themeScope = 'content'"
              >仅正文</button>
              <button
                type="button"
                class="seg__item"
                :class="{ 'is-active': themeScope === 'chrome' }"
                @click="themeScope = 'chrome'"
              >仅界面</button>
            </div>
            <p class="nm-hint">
              「仅正文」只让正文纸张/文字跟随主题，侧栏、工具栏、标题栏回到中性配色；
              「仅界面」反之。被排除的一侧会显式写入中性值，不会残留主题色。
            </p>
          </div>

          <!-- ④ 颜色细化编辑 -->
          <div class="nm-divider" />
          <div class="pane__head">
            <h3 class="pane__title">颜色细化</h3>
            <button
              type="button"
              class="nm-btn nm-btn--sm"
              title="把当前主题的颜色恢复为默认值"
              @click="resetDraftColors"
            >
              <NmIcon name="restore" :size="12" />
              恢复该主题默认值
            </button>
          </div>
          <p class="nm-hint">
            当前主题：<strong>{{ currentTheme.name }}</strong>
            <template v-if="!currentIsCustom">（内置主题改动会另存为新自定义主题）</template>
          </p>
          <div class="color-grid" data-testid="theme-colors">
            <label class="color-item">
              <span class="color-item__label">正文背景</span>
              <input v-model="colorDraft.contentBg" type="color" class="color-item__input" aria-label="正文背景色" />
              <code>{{ colorDraft.contentBg }}</code>
            </label>
            <label class="color-item">
              <span class="color-item__label">正文文字</span>
              <input v-model="colorDraft.contentFg" type="color" class="color-item__input" aria-label="正文文字色" />
              <code>{{ colorDraft.contentFg }}</code>
            </label>
            <label class="color-item">
              <span class="color-item__label">界面背景</span>
              <input v-model="colorDraft.chromeBg" type="color" class="color-item__input" aria-label="界面背景色" />
              <code>{{ colorDraft.chromeBg }}</code>
            </label>
            <label class="color-item">
              <span class="color-item__label">边框</span>
              <input v-model="colorDraft.border" type="color" class="color-item__input" aria-label="边框色" />
              <code>{{ colorDraft.border }}</code>
            </label>
            <label class="color-item">
              <span class="color-item__label">强调色</span>
              <input v-model="colorDraft.accent" type="color" class="color-item__input" aria-label="强调色" />
              <code>{{ colorDraft.accent }}</code>
            </label>
          </div>
          <p class="nm-hint">
            代码块底色、引用底色、表格边框由上面 5 个基准色自动派生，随主题一起变化。
          </p>
          <div class="actions-row">
            <button
              type="button"
              class="nm-btn nm-btn--primary nm-btn--sm"
              data-testid="theme-colors-apply"
              :disabled="!colorDraftDirty"
              :title="currentIsCustom ? '写入当前自定义主题（仍需点底部保存）' : '内置主题不能直接改，将另存为新自定义主题（仍需点底部保存）'"
              @click="saveDraftColors"
            >
              {{ currentIsCustom ? '保存配色' : '存为新主题' }}
            </button>
            <button type="button" class="nm-btn nm-btn--sm" data-testid="theme-duplicate" title="把当前配色复制成一套新主题" @click="duplicateAsTheme">
              复制为新主题
            </button>
            <button type="button" class="nm-btn nm-btn--sm" data-testid="theme-reset-default" title="重置为内置默认主题" @click="resetToDefaultTheme">
              重置为默认
            </button>
          </div>

          <!--
            1.2.1（缺陷6）：此处原有的「⑤ 字体与排版」整块已删除。
            它和「编辑器」页签的「字体、字号与排版」是同一批控件（字体族 / 正文字号 / 行高 /
            正文缩放），两处都调 `patchAppearance`，用户在两个页签看到同一项、改了互相不知道
            改的是哪一个 —— 这正是「设置项重复出现」的现场。

            信息架构收敛原则：主题页签只负责**配色**（主题预设 / 配色细化 / 应用范围 /
            自定义主题），凡是影响「排版与编辑行为」的（字体、字号、行高、缩放、行号、
            拼写检查）统一归「编辑器」页签，全页仅此一处。
          -->

          <!-- ⑥ 自定义主题管理 -->
          <div class="nm-divider" />
          <h3 class="pane__title">自定义主题</h3>
          <p class="nm-hint">新建一套属于你的配色，会出现在上方主题列表中；导入导出便于在多台设备间搬运。</p>
          <div class="actions-row">
            <button class="nm-btn nm-btn--sm" type="button" @click="openNewTheme">新建主题…</button>
            <button class="nm-btn nm-btn--sm" type="button" @click="exportThemes">导出主题 JSON</button>
            <button class="nm-btn nm-btn--sm" type="button" @click="themeImportOpen = true">导入主题</button>
          </div>

          <template v-if="customThemeOpen">
            <div class="nm-divider" />
            <div class="grid2">
              <div class="field">
                <label class="nm-label">主题名称</label>
                <input v-model="themeDraft.name" class="nm-input" placeholder="例如：我的暗夜" maxlength="20" />
              </div>
              <div class="field">
                <label class="nm-label">明暗基调</label>
                <div class="seg">
                  <button type="button" class="seg__item" :class="{ 'is-active': themeDraft.mode === 'light' }" @click="themeDraft.mode = 'light'">浅色</button>
                  <button type="button" class="seg__item" :class="{ 'is-active': themeDraft.mode === 'dark' }" @click="themeDraft.mode = 'dark'">深色</button>
                </div>
              </div>
            </div>
            <div class="grid2">
              <div class="field">
                <label class="nm-label">正文背景</label>
                <input v-model="themeDraft.contentBg" class="nm-input" type="color" />
              </div>
              <div class="field">
                <label class="nm-label">正文文字</label>
                <input v-model="themeDraft.contentFg" class="nm-input" type="color" />
              </div>
              <div class="field">
                <label class="nm-label">界面背景</label>
                <input v-model="themeDraft.chromeBg" class="nm-input" type="color" />
              </div>
              <div class="field">
                <label class="nm-label">边框</label>
                <input v-model="themeDraft.border" class="nm-input" type="color" />
              </div>
              <div class="field">
                <label class="nm-label">强调色</label>
                <input v-model="themeDraft.accent" class="nm-input" type="color" />
              </div>
            </div>
            <div class="actions-row">
              <button class="nm-btn nm-btn--primary nm-btn--sm" type="button" @click="saveCustomTheme">保存并应用</button>
              <button class="nm-btn nm-btn--sm" type="button" @click="customThemeOpen = false">取消</button>
            </div>
          </template>

          <template v-if="themeImportOpen">
            <div class="nm-divider" />
            <div class="field">
              <label class="nm-label">粘贴主题 JSON</label>
              <textarea v-model="themeImportText" class="nm-input mono" rows="6" placeholder='{"name":"我的主题","mode":"light","contentBg":"#ffffff",...}' />
            </div>
            <div class="actions-row">
              <button class="nm-btn nm-btn--primary nm-btn--sm" type="button" @click="importThemes">导入</button>
              <button class="nm-btn nm-btn--sm" type="button" @click="themeImportOpen = false">取消</button>
            </div>
          </template>
        </section>
        <section v-else-if="tab === 'editor'" class="pane">
          <h3 class="pane__title">字体、字号与排版</h3>
          <div class="field">
            <div class="row-between">
              <label class="nm-label">正文字体</label>
              <button
                type="button"
                class="nm-btn nm-btn--sm"
                data-testid="font-reset"
                title="恢复到系统默认字体与默认字号/行高"
                @click="resetFontSettings"
              >
                <NmIcon name="restore" :size="12" />
                恢复默认字体
              </button>
            </div>
            <select
              class="nm-input"
              :value="appearance.fontFamily"
              aria-label="正文字体"
              data-testid="font-family"
              @change="patchAppearance({ fontFamily: ($event.target as HTMLSelectElement).value })"
            >
              <option v-for="f in FONT_OPTIONS" :key="f.value" :value="f.value" :style="{ fontFamily: f.value }">
                {{ f.label }}
              </option>
            </select>
            <p class="nm-hint">{{ fontHint }}</p>
          </div>
          <div class="grid2">
            <div class="field">
              <label class="nm-label">正文字号（px）</label>
              <input
                class="nm-input"
                type="number"
                min="12"
                max="32"
                :value="appearance.fontSize"
                aria-label="编辑器正文字号"
                @input="patchAppearance({ fontSize: Number(($event.target as HTMLInputElement).value) })"
              />
            </div>
            <div class="field">
              <label class="nm-label">正文行高</label>
              <input
                class="nm-input"
                type="number"
                min="1.2"
                max="2.6"
                step="0.05"
                :value="appearance.lineHeight"
                aria-label="编辑器正文行高"
                @input="patchAppearance({ lineHeight: Number(($event.target as HTMLInputElement).value) })"
              />
            </div>
          </div>
          <div class="field">
            <label class="nm-label">正文缩放（50% - 300%）</label>
            <div class="row-with-btn">
              <input
                class="nm-input"
                type="number"
                min="50"
                max="300"
                step="5"
                :value="appearance.zoom ?? 100"
                aria-label="正文缩放比例"
                @input="patchAppearance({ zoom: Number(($event.target as HTMLInputElement).value) })"
              />
              <span class="nm-hint" style="margin: 0">%</span>
            </div>
            <p class="nm-hint">也可以直接在正文里按 Ctrl + 滚轮调整，每格 5%。</p>
          </div>
          <div class="field field--row">
            <div>
              <label class="nm-label">显示正文行号</label>
              <p class="nm-hint">开启后在正文、源码与双栏对照编辑器左侧显示行号（首行文件名不占行号）</p>
            </div>
            <button
              type="button"
              class="toggle-btn"
              data-testid="editor-line-numbers"
              aria-label="显示正文行号"
              :class="{ 'is-on': appearance.showLineNumbers }"
              :title="appearance.showLineNumbers ? '关闭正文行号' : '开启正文行号'"
              :aria-pressed="appearance.showLineNumbers"
              @click="patchAppearance({ showLineNumbers: !appearance.showLineNumbers })"
            >
              {{ appearance.showLineNumbers ? '开' : '关' }}
            </button>
          </div>
          <!--
            拼写检查开关（1.1.9 接线）。
            此前 `appearance.spellcheck` 在类型与默认值里都有，但设置页没有入口、
            编辑器又把它硬编码成 false —— 用户永远开不了，属于「字段存在但不可达」。
            现在补上入口，由 `WysiwygEditor` 读同一个字段并实时写回 `.ProseMirror`
            的 spellcheck 属性。注意这是**浏览器原生拼写检查**（红色波浪线），
            不是语法检查；只对所见即所得模式有意义（源码/阅读是纯文本或静态渲染）。
          -->
          <div class="field field--row">
            <div>
              <label class="nm-label">拼写检查</label>
              <p class="nm-hint">开启后浏览器会对正文中疑似拼错的单词画红色波浪线（仅所见即所得模式）</p>
            </div>
            <button
              type="button"
              class="toggle-btn"
              data-testid="editor-spellcheck"
              aria-label="拼写检查"
              :class="{ 'is-on': appearance.spellcheck }"
              :title="appearance.spellcheck ? '关闭拼写检查' : '开启拼写检查'"
              :aria-pressed="appearance.spellcheck"
              @click="patchAppearance({ spellcheck: !appearance.spellcheck })"
            >
              {{ appearance.spellcheck ? '开' : '关' }}
            </button>
          </div>

          <h3 class="pane__title">自动保存与版本记录策略</h3>
          <div class="field field--row">
            <div>
              <label class="nm-label">启用自动保存</label>
              <p class="nm-hint">编辑修改后自动写入本地仓库并同步云端</p>
            </div>
            <button
              type="button"
              class="toggle-btn"
              :class="{ 'is-on': autosave.enabled }"
              :title="autosave.enabled ? '关闭自动保存' : '开启自动保存'"
              :aria-pressed="autosave.enabled"
              @click="updateAutosave({ enabled: !autosave.enabled })"
            >
              {{ autosave.enabled ? '开' : '关' }}
            </button>
          </div>
          <div class="grid2">
            <div class="field">
              <label class="nm-label">有修改时每隔多少分钟记录一个历史版本</label>
              <input
                class="nm-input"
                type="number"
                min="0"
                max="120"
                :value="autosave.versionMinutes"
                aria-label="每隔多少分钟记录历史版本"
                @input="updateAutosave({ versionMinutes: Number(($event.target as HTMLInputElement).value) })"
              />
            </div>
            <div class="field">
              <label class="nm-label">或累积修改多少字符记录一个历史版本</label>
              <input
                class="nm-input"
                type="number"
                min="0"
                max="50000"
                step="50"
                :value="autosave.versionChars"
                aria-label="累积多少字符记录历史版本"
                @input="updateAutosave({ versionChars: Number(($event.target as HTMLInputElement).value) })"
              />
            </div>
          </div>

          <h3 class="pane__title">正文工具栏</h3>
          <div class="field field--row">
            <div>
              <label class="nm-label">显示正文格式化工具栏</label>
              <p class="nm-hint">关闭后仅保留左侧文件操作与右侧视图操作</p>
            </div>
            <button
              type="button"
              class="toggle-btn"
              :class="{ 'is-on': layout.editorToolbar }"
              :title="layout.editorToolbar ? '关闭正文工具栏' : '开启正文工具栏'"
              :aria-pressed="layout.editorToolbar"
              @click="patchLayout({ editorToolbar: !layout.editorToolbar })"
            >
              {{ layout.editorToolbar ? '开' : '关' }}
            </button>
          </div>
          <div class="field">
            <div class="row-between">
              <label class="nm-label">工具栏按钮显隐与拖动排序</label>
              <button
                type="button"
                class="nm-btn nm-btn--sm"
                title="恢复默认工具栏顺序与按钮"
                @click="resetToolbarItems"
              >
                <NmIcon name="restore" :size="12" />
                恢复默认顺序
              </button>
            </div>
            <p class="nm-hint">按住按钮に直接<strong>拖动</strong>即可调整顺序；点击按钮可切换显示 / 隐藏（也可在编辑器顶部工具栏上直接拖拽）。</p>
            <div class="tb-config-list" :class="{ 'is-reordering': Boolean(tbDragId) }">
              <div
                v-for="item in orderedToolbarDefs"
                :key="item.id"
                class="tb-config-row"
                :class="{
                  'is-dragging': tbDragId === item.id,
                  'is-drop-before': tbDropId === item.id && tbDropSide === 'before' && tbDragId !== item.id,
                  'is-drop-after': tbDropId === item.id && tbDropSide === 'after' && tbDragId !== item.id,
                }"
                :draggable="item.enabled"
                @dragstart="item.enabled && onTbDragStart($event, item.id)"
                @dragover.prevent="item.enabled && onTbDragOver($event, item.id)"
                @dragleave="onTbDragLeave(item.id)"
                @drop.prevent="item.enabled && onTbDrop($event, item.id)"
                @dragend="onTbDragEnd"
              >
                <button
                  type="button"
                  class="model-chip tb-chip"
                  :class="{ 'is-on': item.enabled }"
                  :title="
                    item.enabled
                      ? `拖动调整「${item.label}」顺序，点击隐藏`
                      : `点击显示「${item.label}」`
                  "
                  @click="toggleToolbarItem(item.id)"
                >
                  <span v-if="item.enabled" class="tb-chip__grip" aria-hidden="true">⋮⋮</span>
                  <span>{{ item.enabled ? '✓ ' : '' }}{{ item.label }}</span>
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- 界面布局 -->
        <section v-else-if="tab === 'layout'" class="pane">
          <h3 class="pane__title">左侧面板</h3>
          <div class="field">
            <label class="nm-label">显示内容</label>
            <div class="seg">
              <button type="button" class="seg__item" :class="{ 'is-active': layout.leftPanelMode === 'files' }" @click="patchLayout({ leftPanelMode: 'files' })">文件列表</button>
              <button type="button" class="seg__item" :class="{ 'is-active': layout.leftPanelMode === 'outline' }" @click="patchLayout({ leftPanelMode: 'outline' })">大纲</button>
              <button type="button" class="seg__item" :class="{ 'is-active': layout.leftPanelMode === 'both' }" @click="patchLayout({ leftPanelMode: 'both' })">上方大纲 + 下方文件</button>
              <button type="button" class="seg__item" :class="{ 'is-active': layout.leftPanelMode === 'search' }" @click="patchLayout({ leftPanelMode: 'search' })">全库搜索</button>
            </div>
          </div>
          <div class="field">
            <label class="nm-label">点击文件列表打开新文档的方式</label>
            <div class="seg">
              <button
                type="button"
                class="seg__item"
                :class="{ 'is-active': localLayout.openMode === 'replace' }"
                @click="updateLocalLayout({ openMode: 'replace' }); flashSaved()"
              >
                替换当前标签页（单文档模式）
              </button>
              <button
                type="button"
                class="seg__item"
                :class="{ 'is-active': localLayout.openMode === 'keep' }"
                @click="updateLocalLayout({ openMode: 'keep' }); flashSaved()"
              >
                保留当前并新开标签页（多标签模式）
              </button>
            </div>
            <p class="nm-hint">单文档模式下打开另一篇会自动保存并替换当前标签（点击标签栏 + 号仍可同时打开多篇）。</p>
          </div>
          <div class="field field--row">
            <div>
              <label class="nm-label">显示「最近打开」</label>
              <p class="nm-hint">开启后，已出现在最近打开的文档不再重复出现在全部文件</p>
            </div>
            <button
              type="button"
              class="toggle-btn"
              :class="{ 'is-on': layout.showRecent }"
              :title="layout.showRecent ? '隐藏最近打开' : '显示最近打开'"
              :aria-pressed="layout.showRecent"
              @click="patchLayout({ showRecent: !layout.showRecent })"
            >
              {{ layout.showRecent ? '开' : '关' }}
            </button>
          </div>
          <div class="field field--row">
            <div>
              <label class="nm-label">最近打开数量</label>
            </div>
            <input
              class="nm-input nm-input--num"
              type="number"
              min="3"
              max="30"
              :value="layout.recentCount"
              aria-label="最近打开数量"
              @input="patchLayout({ recentCount: Number(($event.target as HTMLInputElement).value) })"
            />
          </div>
          <div class="field field--row">
            <div>
              <label class="nm-label">面板宽度（px）</label>
            </div>
            <input
              class="nm-input nm-input--num"
              type="number"
              min="200"
              max="600"
              :value="localLayout.leftWidth"
              aria-label="左侧面板宽度"
              @input="
                const w = Number(($event.target as HTMLInputElement).value);
                if (Number.isFinite(w) && w >= 200 && w <= 600) {
                  updateLocalLayout({ leftWidth: w });
                  patchLayout({ leftPanelWidth: w });
                }
              "
            />
          </div>

          <h3 class="pane__title">右侧面板</h3>
          <div class="field">
            <label class="nm-label">右侧边栏当前开启的操作区窗口（支持多选同时打开并拖动调整高度）</label>
            <div class="seg">
              <button
                v-for="sec in RIGHT_SECTION_OPTIONS"
                :key="sec.id"
                type="button"
                class="seg__item"
                :class="{ 'is-active': rightPanelSections.includes(sec.id) }"
                @click="toggleRightSection(sec.id)"
              >
                {{ sec.label }}
              </button>
            </div>
            <p class="nm-hint">
              右侧栏支持同时打开多个操作区窗口上下排列，拖动窗口间的分隔线即可自由调整每个操作区的高度；
              最多同时显示 {{ RIGHT_SECTION_LIMIT }} 个，开第 {{ RIGHT_SECTION_LIMIT + 1 }} 个时会自动关闭最上方那个。
            </p>
          </div>

          <h3 class="pane__title">功能区</h3>
          <div class="field field--row">
            <div>
              <label class="nm-label">启用功能区</label>
              <p class="nm-hint">可将常用插件或动作固定在此区域，关闭后隐藏功能区栏</p>
            </div>
            <button
              type="button"
              class="toggle-btn"
              :class="{ 'is-on': layout.ribbonEnabled !== false }"
              :title="layout.ribbonEnabled !== false ? '关闭功能区' : '开启功能区'"
              :aria-pressed="layout.ribbonEnabled !== false"
              @click="patchLayout({ ribbonEnabled: layout.ribbonEnabled === false })"
            >
              {{ layout.ribbonEnabled !== false ? '开' : '关' }}
            </button>
          </div>
          <div class="field">
            <label class="nm-label">位置</label>
            <div class="seg">
              <button type="button" class="seg__item" :class="{ 'is-active': layout.ribbonPosition === 'left' }" @click="patchLayout({ ribbonPosition: 'left' })">最左侧</button>
              <button type="button" class="seg__item" :class="{ 'is-active': layout.ribbonPosition === 'right' }" @click="patchLayout({ ribbonPosition: 'right' })">最右侧</button>
              <button type="button" class="seg__item" :class="{ 'is-active': layout.ribbonPosition === 'statusbar-left' }" @click="patchLayout({ ribbonPosition: 'statusbar-left' })">状态栏左侧</button>
              <button type="button" class="seg__item" :class="{ 'is-active': layout.ribbonPosition === 'statusbar-right' }" @click="patchLayout({ ribbonPosition: 'statusbar-right' })">状态栏右侧</button>
            </div>
            <p class="nm-hint">功能区可固定在窗口最左、最右，或移入底部状态栏的左侧 / 右侧。</p>
          </div>
          <div class="field">
            <label class="nm-label">显示哪些按钮</label>
            <div class="ribbon-grid">
              <button
                v-for="item in RIBBON_ITEMS"
                :key="item.id"
                type="button"
                class="ribbon-item"
                :class="{ 'is-on': ribbonItems.includes(item.id) }"
                :title="ribbonItems.includes(item.id) ? `从功能区移除「${item.label}」` : `把「${item.label}」加入功能区`"
                @click="toggleRibbonItem(item.id)"
              >
                <NmIcon :name="item.icon" :size="14" />
                <span>{{ item.label }}</span>
              </button>
            </div>
            <p v-if="!RIBBON_ITEMS.length" class="nm-hint">
              暂无已开通的插件按钮。可在「插件中心 → 内置插件」中开启插件后再回来配置。
            </p>
          </div>
        </section>

        <!-- 快捷键 -->
        <section v-else-if="tab === 'shortcuts'" class="pane">
          <div class="pane__head">
            <h3 class="pane__title">快捷键</h3>
            <button
              type="button"
              class="nm-btn nm-btn--sm"
              title="重置全部快捷键为默认值"
              aria-label="重置全部快捷键为默认值"
              @click="resetShortcuts"
            >
              重置快捷键
            </button>
          </div>
          <p class="nm-hint">点击组合键后按下新按键即可修改；与浏览器冲突的组合键在网页版不可用，会提示下载客户端。</p>
          <p v-if="!shortcutGroups.length" class="nm-hint">当前没有可用的快捷键绑定，点击右上角「重置快捷键」可恢复默认组合。</p>
          <div v-for="[group, items] in shortcutGroups" :key="group" class="sc-group">
            <div class="sc-group__label">{{ group === 'editor' ? '编辑器' : group === 'app' ? '应用' : '其他' }}</div>
            <div v-for="item in items" :key="item.command" class="sc-row">
              <span class="sc-row__name">{{ COMMAND_LABELS[item.command] ?? item.command }}</span>
              <button
                v-if="captureCommand !== item.command"
                type="button"
                class="sc-row__keys"
                :title="`修改「${COMMAND_LABELS[item.command] ?? item.command}」的快捷键`"
                @click="startCapture(item.command)"
              >
                {{ item.keys.join(' / ') || '未设置' }}
              </button>
              <input
                v-else
                class="sc-row__capture"
                readonly
                placeholder="按下组合键…"
                aria-label="按下新的快捷键组合"
                autofocus
                @keydown="onCaptureKey($event, item.command)"
                @blur="captureCommand = null"
              />
            </div>
          </div>
        </section>

        <!-- 对象存储 -->
        <section v-else-if="tab === 'storage'" class="pane">
          <h3 class="pane__title">对象存储</h3>
          <p class="nm-hint">配置后，笔记、图片与版本会存到你自己的桶，网页版也会使用云端仓库，保证各端一致。</p>

          <p v-if="!auth.isLoggedIn" class="notice notice--warn">
            <NmIcon name="alert" :size="14" />
            <span>{{ LOGIN_REQUIRED_STORAGE }}</span>
          </p>

          <div class="field">
            <label class="nm-label">服务商</label>
            <div class="providers">
              <button
                v-for="p in STORAGE_PRESETS"
                :key="p.id"
                type="button"
                class="provider"
                :class="{ 'is-active': storage.provider === p.id }"
                :title="p.name"
                @click="onProviderChange(p.id)"
              >
                {{ p.name }}
              </button>
            </div>
          </div>
          <div class="grid2">
            <div class="field">
              <label class="nm-label">地域</label>
              <select
                class="nm-input"
                :value="storage.region"
                aria-label="存储地域"
                @change="onRegionChange(($event.target as HTMLSelectElement).value)"
              >
                <option v-for="r in storageRegions" :key="r.id" :value="r.id">{{ r.label }}</option>
              </select>
            </div>
            <div class="field">
              <label class="nm-label">Bucket</label>
              <input
                class="nm-input"
                :class="{ 'is-invalid': Boolean(bucketIssue) }"
                :value="storage.bucket"
                placeholder="例如：neomd-bucket"
                :aria-invalid="Boolean(bucketIssue)"
                @input="patchSettings({ storage: { ...storage, bucket: ($event.target as HTMLInputElement).value } })"
              />
              <p v-if="bucketIssue" class="field-error">{{ bucketIssue }}</p>
            </div>
          </div>
          <div class="field">
            <label class="nm-label">Endpoint</label>
            <input
              class="nm-input"
              :class="{ 'is-invalid': Boolean(endpointIssue) }"
              :value="storage.endpoint"
              placeholder="https://s3.oss-cn-hangzhou.aliyuncs.com"
              :aria-invalid="Boolean(endpointIssue)"
              @input="patchSettings({ storage: { ...storage, endpoint: ($event.target as HTMLInputElement).value } })"
            />
            <p v-if="endpointAutoProtoHint" class="nm-hint">{{ endpointAutoProtoHint }}</p>
            <p v-if="endpointIssue" class="field-error">{{ endpointIssue }}</p>
          </div>
          <div class="grid2">
            <div class="field">
              <label class="nm-label">AccessKey ID</label>
              <input
                class="nm-input"
                :class="{ 'is-invalid': Boolean(accessKeyIdIssue) }"
                :value="storage.accessKeyId"
                autocomplete="off"
                :aria-invalid="Boolean(accessKeyIdIssue)"
                @input="settingsStore.setStorageKeyId(($event.target as HTMLInputElement).value); flashSaved()"
              />
              <p v-if="accessKeyIdIssue" class="field-error">{{ accessKeyIdIssue }}</p>
            </div>
            <div class="field">
              <label class="nm-label">AccessKey Secret</label>
              <div class="row-with-btn">
                <input
                  class="nm-input"
                  type="password"
                  :value="storage.accessKeySecret"
                  autocomplete="new-password"
                  @input="settingsStore.setSecret('storage', ($event.target as HTMLInputElement).value); flashSaved()"
                />
                <button
                  type="button"
                  class="nm-btn nm-btn--sm"
                  title="清空已保存的对象存储密钥"
                  aria-label="清空已保存的对象存储密钥"
                  @click="clearStorageSecrets"
                >
                  清空
                </button>
              </div>
            </div>
          </div>
          <div class="grid2">
            <div class="field">
              <label class="nm-label">自定义访问域名</label>
              <input
                class="nm-input"
                :value="storage.publicDomain"
                placeholder="https://cdn.example.com"
                @input="patchSettings({ storage: { ...storage, publicDomain: ($event.target as HTMLInputElement).value } })"
              />
            </div>
            <div class="field">
              <label class="nm-label">对象前缀</label>
              <input
                class="nm-input"
                :value="storage.basePrefix"
                placeholder="mdadmin/"
                @input="patchSettings({ storage: { ...storage, basePrefix: ($event.target as HTMLInputElement).value } })"
              />
            </div>
          </div>

          <div class="actions-row">
            <button
              type="button"
              class="nm-btn nm-btn--primary"
              :disabled="storageTestDisabled"
              :title="
                !auth.isLoggedIn
                  ? LOGIN_REQUIRED_STORAGE
                  : storageConfigIssues.length
                    ? storageConfigIssues[0]
                    : '由服务端代探对象存储连通性'
              "
              @click="testStorage"
            >
              {{ probing ? '检测中…' : '测试连接' }}
            </button>
            <span v-if="!auth.isLoggedIn" class="nm-hint inline">未登录无法检测</span>
            <span v-else-if="storageConfigIssues.length" class="nm-hint inline">{{ storageConfigIssues[0] }}</span>
          </div>

          <!-- 逐步骤检测结果 -->
          <div v-if="probeResult" class="probe-box" :class="{ 'is-ok': probeOk }" role="status" aria-live="polite">
            <p class="probe-box__head">
              <NmIcon :name="probeOk ? 'check' : 'alert'" :size="14" />
              <span>{{ probeResult }}</span>
            </p>
            <ul v-if="orderedSteps.length" class="probe-steps">
              <li
                v-for="s in orderedSteps"
                :key="s.name"
                class="probe-step"
                :class="{ 'is-ok': s.ok && !s.missing, 'is-bad': s.missing || !s.ok }"
              >
                <span class="probe-step__icon">{{ s.missing ? '—' : s.ok ? '✓' : '✗' }}</span>
                <span class="probe-step__name">{{ STEP_LABELS[s.name] }}</span>
                <span class="probe-step__time">{{ s.missing ? '未执行' : `${s.latencyMs} ms` }}</span>
                <span v-if="!s.missing && !s.ok" class="probe-step__msg">{{ s.message }}</span>
              </li>
            </ul>
          </div>
        </section>

        <!-- AI -->
        <section v-else-if="tab === 'ai'" class="pane">
          <h3 class="pane__title">AI 服务</h3>

          <p v-if="!auth.isLoggedIn" class="notice notice--warn">
            <NmIcon name="alert" :size="14" />
            <span>{{ LOGIN_REQUIRED_AI }}（测试需服务端代探以绕过浏览器跨域限制）</span>
          </p>

          <!-- ============ 1.1.8 区块二：平台 AI 服务（扣积分，后台统一管理） ============ -->
          <section class="ai-block" :class="{ 'is-active': ai.usePlatform || ai.provider === 'platform' }">
            <header class="ai-block__head">
              <div class="ai-block__title">
                <NmIcon name="sparkles" :size="15" />
                <strong>平台 AI 服务</strong>
                <span class="ai-block__tag">扣积分</span>
              </div>
              <button
                type="button"
                class="nm-btn nm-btn--sm"
                :class="{ 'nm-btn--primary': ai.usePlatform || ai.provider === 'platform' }"
                :disabled="ai.usePlatform || ai.provider === 'platform'"
                @click="onAIProviderChange('platform')"
              >
                {{ ai.usePlatform || ai.provider === 'platform' ? '当前使用中' : '切换到此服务' }}
              </button>
            </header>
            <p class="ai-block__desc">
              由平台统一接入并承担费用，按后台配置的计费方式扣除积分。你无需填写任何 Key。
            </p>

            <!-- 积分与预估消耗 -->
            <div class="ai-credits">
              <div class="ai-credits__item">
                <span class="ai-credits__label">剩余积分</span>
                <span class="ai-credits__value">{{ aiCreditBalance === null ? '—' : aiCreditBalance }}</span>
              </div>
              <div class="ai-credits__item">
                <span class="ai-credits__label">今日消耗</span>
                <span class="ai-credits__value">{{ aiCreditToday }}</span>
              </div>
              <div class="ai-credits__item">
                <span class="ai-credits__label">本次预估</span>
                <span class="ai-credits__value">{{ platformEstimate }}</span>
              </div>
            </div>
            <p v-if="!auth.isLoggedIn" class="nm-hint">登录后才会显示积分余额。</p>

            <!-- 可用模型列表（后台统一管理，前台只读选择） -->
            <div class="field">
              <label class="nm-label">可用模型</label>
              <p v-if="platformModelsLoading" class="nm-hint">正在加载可用模型…</p>
              <p v-else-if="!platformModels.length" class="nm-hint">
                平台暂未开放可用模型。管理员在后台启用供应商并配置密钥后，这里会自动出现可选模型。
              </p>
              <div v-else class="platform-models">
                <button
                  v-for="m in platformModels"
                  :key="m.model"
                  type="button"
                  class="platform-model"
                  :class="{ 'is-on': ai.model === m.model }"
                  :title="`${m.providerName} · 温度上限 ${m.temperature} · 最多 ${m.maxTokens} tokens`"
                  @click="onPlatformModelChange(m)"
                >
                  <span class="platform-model__name">{{ m.model }}</span>
                  <span class="platform-model__meta">
                    {{ m.providerName }}
                    <template v-if="m.isDefault"> · 默认</template>
                  </span>
                  <span class="platform-model__price">{{ m.priceIn }}/{{ m.priceOut }} 积分/千token</span>
                </button>
              </div>
            </div>

            <!-- 系统提示词（后台为该模型配置，前台只读展示，允许覆盖） -->
            <div v-if="currentPlatformModel?.systemPrompt" class="field">
              <div class="row-between">
                <label class="nm-label">系统提示词（平台预设）</label>
                <span class="nm-hint inline">只读展示，可在 AI 助手中临时覆盖</span>
              </div>
              <pre class="ai-prompt">{{ currentPlatformModel.systemPrompt }}</pre>
            </div>

            <!-- 参数：受后台为该模型设定的上限约束 -->
            <div v-if="currentPlatformModel" class="grid2">
              <div class="field">
                <label class="nm-label">
                  温度
                  <span class="nm-hint inline">上限 {{ currentPlatformModel.temperature }}</span>
                </label>
                <input
                  class="nm-input"
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  :value="Math.min(Number(ai.temperature ?? 0.7), currentPlatformModel.temperature)"
                  aria-label="平台模型温度"
                  @input="patchSettings({ ai: { ...ai, temperature: Number(($event.target as HTMLInputElement).value) } })"
                />
              </div>
              <div class="field">
                <label class="nm-label">
                  最大 tokens
                  <span class="nm-hint inline">上限 {{ currentPlatformModel.maxTokens }}</span>
                </label>
                <input
                  class="nm-input"
                  type="number"
                  :min="1"
                  :max="currentPlatformModel.maxTokens"
                  :value="Math.min(Number(ai.maxTokens ?? 4096), currentPlatformModel.maxTokens)"
                  aria-label="平台模型最大 tokens"
                  @input="patchSettings({ ai: { ...ai, maxTokens: Number(($event.target as HTMLInputElement).value) } })"
                />
              </div>
            </div>
          </section>

          <!-- ============ 1.1.8 区块一：我的 AI 供应商（自带 Key，不涉及积分） ============ -->
          <section class="ai-block" :class="{ 'is-active': !ai.usePlatform && ai.provider !== 'platform' }">
            <header class="ai-block__head">
              <div class="ai-block__title">
                <NmIcon name="key" :size="15" />
                <strong>我的 AI 供应商</strong>
                <span class="ai-block__tag ai-block__tag--own">自带 Key</span>
              </div>
              <span class="ai-block__hint">不消耗积分，费用由你自己的账号承担</span>
            </header>

            <div class="field">
              <label class="nm-label">选择供应商</label>
              <div class="providers providers--grid">
                <div
                  v-for="p in ownProviderList"
                  :key="p.id"
                  class="provider-card"
                  :class="{ 'is-active': ai.provider === p.id && !ai.usePlatform }"
                >
                  <button type="button" class="provider-card__main" @click="onAIProviderChange(p.id)">
                    <span class="provider-card__name">{{ p.name }}</span>
                  </button>
                  <span class="provider-card__meta">
                    <span class="provider-card__count">{{ p.models.length }} 个模型</span>
                    <a
                      v-if="providerSignupUrl(p.id)"
                      class="provider-card__link"
                      :href="providerSignupUrl(p.id)"
                      target="_blank"
                      rel="noopener noreferrer"
                      :title="`打开 ${p.name} 申请 API Key`"
                      @click.stop
                    >
                      去申请
                      <NmIcon name="external" :size="10" />
                    </a>
                  </span>
                  <span v-if="providerNote(p.id)" class="provider-card__note">
                    {{ providerNote(p.id) }}
                  </span>
                </div>
              </div>
            </div>
          </section>

          <!-- 自带 Key 的连接细节与参数：仅当选中「我的 AI 供应商」时显示（避免与上方平台 AI 服务表单重复） -->
          <template v-if="!ai.usePlatform && ai.provider !== 'platform'">
            <div class="field">
              <label class="nm-label">Base URL</label>
              <input
                class="nm-input"
                :class="{ 'is-invalid': Boolean(aiBaseUrlIssue) }"
                :value="ai.baseUrl"
                placeholder="https://api.deepseek.com/v1"
                :aria-invalid="Boolean(aiBaseUrlIssue)"
                @input="patchSettings({ ai: { ...ai, baseUrl: ($event.target as HTMLInputElement).value } })"
              />
              <p v-if="aiBaseUrlIssue" class="field-error">{{ aiBaseUrlIssue }}</p>
            </div>
            <div class="field">
              <label class="nm-label">API Key</label>
              <div class="row-with-btn">
                <input
                  class="nm-input"
                  type="password"
                  :value="ai.apiKey"
                  placeholder="sk-..."
                  autocomplete="new-password"
                  @input="settingsStore.setSecret('ai', ($event.target as HTMLInputElement).value); flashSaved()"
                />
                <button
                  type="button"
                  class="nm-btn nm-btn--sm"
                  :title="`打开 ${aiPreset.name} 控制台申请 Key`"
                  aria-label="打开供应商控制台申请 Key"
                  @click="openConsole"
                >
                  <NmIcon name="external" :size="13" />
                  申请
                </button>
                <button
                  type="button"
                  class="nm-btn nm-btn--sm"
                  title="清空已保存的 AI API Key"
                  aria-label="清空已保存的 AI API Key"
                  @click="clearAiKey"
                >
                  清空
                </button>
              </div>
            </div>

            <div class="field">
              <div class="row-between">
                <label class="nm-label">模型</label>
                <button
                  type="button"
                  class="nm-btn nm-btn--sm"
                  :disabled="loadingModels || !auth.isLoggedIn"
                  :title="!auth.isLoggedIn ? LOGIN_REQUIRED_AI : '由服务端代拉可用模型列表'"
                  @click="fetchModels"
                >
                  <NmIcon name="refresh" :size="12" />
                  {{ loadingModels ? '获取中…' : '获取最新列表' }}
                </button>
              </div>
              <p v-if="modelSource" class="nm-hint">{{ modelSource }}</p>
              <div class="model-list">
                <button
                  v-for="m in (modelList.length ? modelList : aiPreset.models)"
                  :key="m"
                  type="button"
                  class="model-chip"
                  :class="{ 'is-on': (ai.models?.length ? ai.models : aiPreset.models).includes(m) }"
                  :title="`启用 / 停用模型 ${m}`"
                  @click="toggleModel(m)"
                >
                  {{ m }}
                </button>
              </div>
              <p class="nm-hint">点击可多选可用模型；AI 助手中可随时切换。</p>
            </div>

            <div class="field">
              <label class="nm-label">默认模型（AI 自动命名等后台任务使用）</label>
              <select
                class="nm-input"
                :value="ai.model"
                aria-label="默认模型"
                @change="patchSettings({ ai: { ...ai, model: ($event.target as HTMLSelectElement).value } })"
              >
                <option v-for="m in (ai.models?.length ? ai.models : aiPreset.models)" :key="m" :value="m">{{ m }}</option>
              </select>
            </div>

            <div class="grid2">
              <div class="field">
                <label class="nm-label">Temperature</label>
                <input
                  class="nm-input"
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  :value="ai.temperature"
                  aria-label="Temperature"
                  @input="patchSettings({ ai: { ...ai, temperature: Number(($event.target as HTMLInputElement).value) } })"
                />
              </div>
              <div class="field">
                <label class="nm-label">最大 Token</label>
                <input
                  class="nm-input"
                  type="number"
                  min="256"
                  max="32000"
                  :value="ai.maxTokens"
                  aria-label="最大 Token"
                  @input="patchSettings({ ai: { ...ai, maxTokens: Number(($event.target as HTMLInputElement).value) } })"
                />
              </div>
            </div>
          </template>

          <div class="actions-row">
            <button
              type="button"
              class="nm-btn nm-btn--primary"
              :disabled="aiTestDisabled"
              :title="
                !auth.isLoggedIn ? LOGIN_REQUIRED_AI : aiConfigIssues.length ? aiConfigIssues[0] : '由服务端代测 AI 连通性'
              "
              @click="testAI"
            >
              {{ aiTesting ? '测试中…' : '测试连接' }}
            </button>
            <span v-if="!auth.isLoggedIn" class="nm-hint inline">未登录无法测试</span>
            <span v-else-if="aiConfigIssues.length" class="nm-hint inline">{{ aiConfigIssues[0] }}</span>
          </div>

          <div v-if="aiTestResult" class="probe-box" :class="{ 'is-ok': aiTestOk }" role="status" aria-live="polite">
            <p class="probe-box__head">
              <NmIcon :name="aiTestOk ? 'check' : 'alert'" :size="14" />
              <span>{{ aiTestResult }}</span>
            </p>
          </div>
        </section>

        <!-- 仓库（1.1.5：仓库可以备份、复制、删除、停用等） -->
        <section v-else-if="tab === 'vaults'" class="pane">
          <h3 class="pane__title">仓库</h3>
          <VaultManagerSection compact />
        </section>

        <!-- 知识库（1.1.0：把仓库作为 AI 知识库） -->
        <section v-else-if="tab === 'knowledge'" class="pane">
          <h3 class="pane__title">知识库</h3>
          <KnowledgeSettingsSection compact />
        </section>

        <!-- 同步 -->
        <section v-else-if="tab === 'sync'" class="pane">
          <h3 class="pane__title">同步与版本</h3>
          <!--
            同步状态与操作（1.1.8）：
            手动同步 / 全部同步 / 自动同步间隔 / 同步方向 / 冲突策略 / 同步日志。
            组件自包含，不需要额外 props（compact 仅控制内边距）。
          -->
          <SyncSettingsSection compact />
          <div class="nm-divider" />
          <p class="nm-hint">联网登录同一账号后，所有修改会自动同步到云端，无需手动点击同步按钮。</p>
          <div class="field">
            <label class="nm-label">当前平台 / 设备名称（将记录在历史版本中）</label>
            <input v-if="runtime.platform === 'web'" class="nm-input" value="web" readonly disabled />
            <input
              v-else
              class="nm-input"
              :value="sync.deviceName || (runtime.platform === 'desktop' ? 'Windows-PC' : 'Android')"
              placeholder="例如：办公室台式机"
              aria-label="设备名称"
              @input="patchSettings({ sync: { ...sync, deviceName: ($event.target as HTMLInputElement).value } })"
            />
            <p v-if="runtime.platform === 'web'" class="nm-hint">网页端固定使用 <code>web</code> 表示，不支持修改。</p>
          </div>
          <div class="grid2">
            <div class="field">
              <label class="nm-label">版本保留天数</label>
              <input
                class="nm-input"
                type="number"
                min="1"
                :value="sync.versionRetentionDays"
                aria-label="版本保留天数"
                @input="patchSettings({ sync: { ...sync, versionRetentionDays: Number(($event.target as HTMLInputElement).value) } })"
              />
            </div>
            <div class="field">
              <label class="nm-label">每篇最多版本数</label>
              <input
                class="nm-input"
                type="number"
                min="5"
                :value="sync.versionRetentionCount"
                aria-label="每篇最多版本数"
                @input="patchSettings({ sync: { ...sync, versionRetentionCount: Number(($event.target as HTMLInputElement).value) } })"
              />
            </div>
          </div>

          <div class="nm-divider" />
          <h3 class="pane__title">本地仓库与版本</h3>
          <template v-if="runtime.platform === 'desktop'">
            <p class="nm-hint">
              PC 端所有仓库都以真实文件夹保存明文 <code>.md</code>，随时可用系统文件管理器打开。
              默认<strong>只在本地保留最新版本</strong>，历史版本由云端对象存储承载，避免磁盘无限膨胀。
            </p>
            <div class="field">
              <label class="nm-label">本地仓库根目录</label>
              <div class="row-with-btn">
                <input
                  class="nm-input"
                  :value="localVault.root"
                  placeholder="留空则使用「文档 / Neo MD」"
                  aria-label="本地仓库根目录"
                  @input="patchSettings({ localVault: { ...localVault, root: ($event.target as HTMLInputElement).value } })"
                />
                <button class="nm-btn nm-btn--sm" type="button" :disabled="!canPickDirectory" @click="pickLocalVaultRoot">
                  选择目录
                </button>
              </div>
              <p class="nm-hint">
                当前生效位置：<code>{{ activeVaultPath || '尚未打开仓库' }}</code>
              </p>
            </div>
            <div class="field">
              <label class="nm-label">本地历史版本</label>
              <div class="actions-row">
                <button
                  type="button"
                  class="toggle-btn"
                  :class="{ 'is-on': localVault.keepVersions }"
                  :aria-pressed="localVault.keepVersions"
                  @click="patchSettings({ localVault: { ...localVault, keepVersions: !localVault.keepVersions } })"
                >
                  {{ localVault.keepVersions ? '开（本地留痕）' : '关（仅存最新版本）' }}
                </button>
              </div>
              <p class="nm-hint">
                关闭时本地每篇笔记只保留一份最新内容；开启后会在仓库的 <code>.neomd/versions/</code>
                下额外留痕，占用更多磁盘。
              </p>
            </div>
          </template>
          <p v-else class="nm-hint">该策略仅对 PC 客户端生效；网页端与移动端的历史版本始终由云端承载。</p>

          <div class="nm-divider" />
          <p v-if="saveMessage" class="probe-box" :class="{ 'is-ok': saveMessageOk }" role="status" aria-live="polite">
            <span>{{ saveMessage }}</span>
          </p>
        </section>

        <!-- 账号 -->

        <!-- 服务器（1.0.2：PC 端可接入自建服务端；应用商店始终走官方） -->
        <section v-else-if="tab === 'server'" class="pane">
          <h3 class="pane__title">服务端连接</h3>
          <p class="nm-hint">
            默认连接官方服务端。你也可以填入自己部署的 Neo MD 服务端地址，让数据只经过你的服务器。
          </p>
          <ServerSettingsSection compact @changed="flashSaved('服务器配置已保存')" />
          <div class="nm-divider" />
          <p class="nm-hint">
            注意：<strong>插件市场（应用商店）始终使用官方统一服务</strong>，不受这里的选择影响，也不支持私有化部署。
          </p>
        </section>

        <!-- 导入（1.1.0：Obsidian 仓库导入） -->
        <section v-else-if="tab === 'import'" class="pane">
          <h3 class="pane__title">导入 Obsidian 仓库</h3>
          <p class="nm-hint">
            把已有 Obsidian 仓库的笔记批量导入当前 Neo MD 仓库。
            导入会保留源文件的真实修改日期，并自动把 Obsidian 专有语法（硬换行、Callout、<code>%%注释%%</code>、<code>==高亮==</code>、嵌入等）
            转换为 Neo MD 可正确渲染的写法。
          </p>
          <ObsidianImportSection compact />
        </section>

        <section v-else class="pane">
          <h3 class="pane__title">账号</h3>
          <template v-if="runtime.platform === 'desktop'">
            <p class="nm-hint">
              PC 客户端不支持直接修改个人资料或密码。如需设置头像昵称、修改密码、配置分享页样式或管理备份，请点击下方链接前往网页端用户中心操作，修改后各端自动同步生效。
            </p>
            <div class="actions-row">
              <button class="nm-btn nm-btn--primary" type="button" @click="openWebAccountCenter">
                <NmIcon name="external" :size="14" />
                打开网页端用户中心（md.zhengl.vip/account）
              </button>
            </div>
          </template>
          <template v-else-if="auth.isLoggedIn">
            <div class="field">
              <label class="nm-label">昵称</label>
              <input v-model="nickname" class="nm-input" maxlength="64" placeholder="显示名称" />
            </div>
            <div class="field">
              <label class="nm-label">头像链接</label>
              <input v-model="avatarUrl" class="nm-input" placeholder="https://…" />
            </div>
            <button
              type="button"
              class="nm-btn nm-btn--primary nm-btn--sm"
              :disabled="saving"
              title="保存个人资料"
              @click="saveProfile"
            >
              {{ saving ? '保存中…' : '保存资料' }}
            </button>

            <div class="nm-divider" />
            <h3 class="pane__title">修改密码</h3>
            <div class="grid2">
              <div class="field">
                <label class="nm-label">当前密码</label>
                <input v-model="oldPassword" class="nm-input" type="password" autocomplete="current-password" />
              </div>
              <div class="field">
                <label class="nm-label">新密码</label>
                <input v-model="newPassword" class="nm-input" type="password" autocomplete="new-password" />
              </div>
            </div>
            <button
              type="button"
              class="nm-btn nm-btn--sm"
              :disabled="saving"
              title="修改登录密码"
              @click="changePassword"
            >
              {{ saving ? '提交中…' : '修改密码' }}
            </button>

            <div class="nm-divider" />
            <h3 class="pane__title">跨端自动同步状态</h3>
            <p class="nm-hint">联网登录同一账号后，设置与云端仓库均自动实时同步，无需手动点击。</p>
            <p v-if="saveMessage" class="probe-box" :class="{ 'is-ok': saveMessageOk }" role="status" aria-live="polite">
              <span>{{ saveMessage }}</span>
            </p>
          </template>
          <template v-else>
            <p class="nm-hint">当前未登录，所有数据只保存在本机。登录后可跨设备自动同步设置、积分与分享。</p>
            <button class="nm-btn nm-btn--primary" @click="emit('close'); $router.push('/login')">前往登录</button>
          </template>
        </section>
      </div>
    </div>
    </div>

    <!--
      底部固定操作栏（1.4.0，需求16）。
      为什么固定在容器底部而不是内容流末尾：设置页有 12 个页签、内容很长，
      放末尾等于「用户永远看不到保存按钮」；固定在底部才能支撑「改完随手保存」。
      它同时承担「未保存改动」的提示职责，所以有改动时会变色并显示改了哪几块。
    -->
    <footer class="settings-savebar" data-testid="settings-save-bar" :class="{ 'is-dirty': draftDirty }">
      <span class="settings-savebar__state" role="status" aria-live="polite">
        <template v-if="draftDirty">
          <NmIcon name="alert" :size="13" />
          <span>有未保存的改动：{{ draftDiffKeys.join('、') }}</span>
        </template>
        <template v-else>
          <NmIcon name="check" :size="13" />
          <span>全部改动已保存</span>
        </template>
      </span>
      <div class="settings-savebar__actions">
        <button
          type="button"
          class="nm-btn nm-btn--sm"
          data-testid="settings-reset-default"
          title="把本页草稿恢复为出厂默认值（仍需点保存才生效）"
          @click="resetAllSettings"
        >
          恢复默认
        </button>
        <button
          type="button"
          class="nm-btn nm-btn--sm"
          data-testid="settings-cancel"
          :disabled="!draftDirty"
          title="放弃未保存的改动，界面回到上次保存的设置"
          @click="cancelDraft"
        >
          取消
        </button>
        <button
          type="button"
          class="nm-btn nm-btn--primary nm-btn--sm"
          data-testid="settings-save"
          :disabled="!draftDirty"
          title="保存全部改动（写入设置并同步到云端）"
          @click="saveDraft"
        >
          <NmIcon name="check" :size="13" />
          保存
        </button>
      </div>
    </footer>

    <!-- 危险操作二次确认 -->
    <NmModal v-model="confirmDialog.open" :title="confirmDialog.title" :width="440">
      <p class="confirm-text">{{ confirmDialog.message }}</p>
      <template #footer>
        <button type="button" class="nm-btn" @click="confirmDialog.open = false">取消</button>
        <button type="button" class="nm-btn nm-btn--danger" @click="runConfirm">{{ confirmDialog.confirmText }}</button>
      </template>
    </NmModal>
  </div>
</template>

<style scoped>
/*
 * 设置页是**整页标签页**（不再包在 NmModal 弹窗里），因此这里必须是
 * 「撑满父容器」的布局，而不是弹窗时代的固定高度。
 *
 * 历史遗留（已修）：
 *   margin: -4px -20px -18px;  ← 为抵消弹窗内边距的负 margin，会把整块内容拽偏
 *   height: 68vh;              ← 弹窗高度，导致内容区只有视口的 68%
 * 真正的高度链由外层承担：`.settings-page`(flex column, height:100%)
 * → `.settings-page__wrap`(flex:1 1 auto, min-height:0) → `.settings`(height:100%)。
 */
.settings {
  display: grid;
  grid-template-columns: 176px 1fr;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.settings__nav {
  border-right: 1px solid var(--border);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--bg-sidebar);
  min-height: 0;
  overflow-y: auto;
}
.settings__nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  border-radius: 7px;
  font-size: 13px;
  color: var(--fg-2);
  text-align: left;
}
.settings__nav-item:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.settings__nav-item.is-active {
  background: var(--bg-active);
  color: var(--accent);
  font-weight: 600;
}
.settings__body {
  padding: 16px 20px 28px;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.settings__foot-hint {
  margin-right: auto;
  font-size: 11.5px;
  color: var(--fg-3);
}

/* 即时保存反馈 */
.saved-hint {
  position: sticky;
  top: 0;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 12px;
  padding: 5px 11px;
  border-radius: 999px;
  background: rgba(22, 163, 74, 0.12);
  color: #16a34a;
  font-size: 12px;
  font-weight: 600;
}
.hint-fade-enter-active,
.hint-fade-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.hint-fade-enter-from,
.hint-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* 提示与校验 */
.notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 14px;
  padding: 9px 12px;
  border-radius: 8px;
  font-size: 12.5px;
  line-height: 1.6;
}
.notice--warn {
  background: rgba(217, 48, 37, 0.08);
  color: #d93025;
}
.field-error {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: #d93025;
  line-height: 1.5;
}
.nm-input.is-invalid {
  border-color: #d93025;
}
.nm-hint.inline {
  margin: 0;
}

/* 1.1.1：.scheme-grid / .scheme-card / .scheme-preview 三组样式随「正文配色方案」
   UI 一起删除（正文颜色已全部由主题变量驱动，不再有独立的配色方案卡片）。 */

.tb-config-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-sidebar);
}
.tb-config-row {
  display: inline-flex;
  align-items: center;
  border-radius: 12px;
  transition: transform 0.12s ease, opacity 0.12s ease;
}
.tb-config-row.is-dragging {
  opacity: 0.35;
}
.tb-config-row.is-drop-before {
  box-shadow: -2px 0 0 var(--accent);
}
.tb-config-row.is-drop-after {
  box-shadow: 2px 0 0 var(--accent);
}
.tb-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: grab;
}
.tb-config-list.is-reordering .tb-chip {
  cursor: grabbing;
}
.tb-chip__grip {
  font-size: 11px;
  opacity: 0.55;
  letter-spacing: -1px;
}
.pane__title {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 700;
}
.pane__title:not(:first-child) {
  margin-top: 20px;
}
.pane__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.pane__head .pane__title {
  margin: 0;
}
.field {
  margin-bottom: 14px;
}
.field--row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.nm-input--num {
  width: 96px;
  flex: 0 0 auto;
}
.seg {
  display: inline-flex;
  padding: 3px;
  gap: 2px;
  border-radius: 8px;
  background: var(--bg-hover);
  border: 1px solid var(--border);
  flex-wrap: wrap;
}
.seg__item {
  padding: 6px 11px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--fg-2);
}
.seg__item.is-active {
  background: var(--bg-elevated);
  color: var(--accent);
  font-weight: 600;
  box-shadow: var(--shadow-1);
}
.swatches {
  display: flex;
  gap: 8px;
}
.swatch {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid transparent;
}
.swatch.is-active {
  border-color: var(--bg-elevated);
  box-shadow: 0 0 0 2px currentColor;
}
.toggle-btn {
  min-width: 60px;
  height: 28px;
  padding: 0 12px;
  border-radius: 14px;
  font-size: 12px;
  font-weight: 600;
  background: var(--bg-hover);
  color: var(--fg-3);
  border: 1px solid var(--border);
  flex: 0 0 auto;
}
.toggle-btn.is-on {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.providers {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.provider {
  height: 30px;
  padding: 0 12px;
  border-radius: 8px;
  font-size: 12.5px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--fg-2);
}
.provider.is-active {
  border-color: var(--accent);
  background: var(--accent-weak);
  color: var(--accent);
  font-weight: 600;
}

/* ---------- 供应商卡片（1.1.7：平台 / 自建分组） ---------- */
.providers__legend {
  font-size: 11px;
  color: var(--fg-3);
}
.providers--grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 8px;
  margin-top: 7px;
}
.provider-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  transition: border-color 0.15s, background 0.15s;
}
.provider-card.is-active {
  border-color: var(--accent);
  background: var(--accent-weak);
}
.provider-card__main {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.provider-card__name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.provider-card.is-active .provider-card__name {
  color: var(--accent);
}
.provider-card__badge {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
}
.provider-card__badge--on {
  color: #0f7b6c;
  background: rgba(15, 123, 108, 0.13);
}
.provider-card__badge--off {
  color: var(--fg-3);
  background: rgba(15, 23, 42, 0.06);
}
.provider-card__badge--free {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.provider-card__badge--custom {
  color: #8a6d3b;
  background: rgba(250, 173, 20, 0.16);
}

/* ---------- 1.1.8：两个独立区块（平台 AI 服务 / 我的 AI 供应商） ---------- */
.ai-block {
  margin-top: 6px;
  padding: 13px 15px;
  border-radius: 11px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  transition: border-color 0.15s;
}
.ai-block.is-active {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
}
.ai-block__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.ai-block__title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  color: var(--fg);
}
.ai-block__tag {
  padding: 0 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  line-height: 17px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.ai-block__tag--own {
  color: #8a6d3b;
  background: rgba(250, 173, 20, 0.16);
}
.ai-block__hint {
  font-size: 11px;
  color: var(--fg-3);
}
.ai-block__desc {
  margin: 7px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--fg-3);
}

/* 积分卡 */
.ai-credits {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 10px;
}
.ai-credits__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.035);
}
.ai-credits__label {
  font-size: 11px;
  color: var(--fg-3);
}
.ai-credits__value {
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--fg);
}

/* 平台模型卡 */
.platform-models {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
  margin-top: 7px;
}
.platform-model {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s, background 0.15s;
}
.platform-model.is-on {
  border-color: var(--accent);
  background: var(--accent-weak);
}
.platform-model__name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.platform-model.is-on .platform-model__name {
  color: var(--accent);
}
.platform-model__meta {
  font-size: 11px;
  color: var(--fg-3);
}
.platform-model__price {
  font-size: 11px;
  color: var(--fg-3);
  font-variant-numeric: tabular-nums;
}

/* 系统提示词只读展示 */
.ai-prompt {
  margin: 6px 0 0;
  padding: 9px 11px;
  max-height: 180px;
  overflow: auto;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: rgba(15, 23, 42, 0.035);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--fg-2);
  white-space: pre-wrap;
  word-break: break-word;
}
.provider-card__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--fg-3);
}
.provider-card__count {
  font-variant-numeric: tabular-nums;
}
.provider-card__link {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--accent);
  text-decoration: none;
}
.provider-card__link:hover {
  text-decoration: underline;
}
.provider-card__note {
  font-size: 11px;
  line-height: 1.5;
  color: var(--fg-3);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.actions-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  flex-wrap: wrap;
}
.row-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.row-with-btn {
  display: flex;
  gap: 8px;
  align-items: center;
}

/* 检测结果（含逐步骤明细） */
.probe-box {
  margin-top: 14px;
  padding: 10px 12px;
  border-radius: 9px;
  border: 1px solid rgba(217, 48, 37, 0.28);
  background: rgba(217, 48, 37, 0.06);
  font-size: 12.5px;
  color: #d93025;
  line-height: 1.6;
}
.probe-box.is-ok {
  border-color: rgba(22, 163, 74, 0.3);
  background: rgba(22, 163, 74, 0.07);
  color: #16a34a;
}
.probe-box__head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-weight: 600;
}
.probe-steps {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: grid;
  gap: 4px;
}
.probe-step {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  color: var(--fg-2);
  font-size: 12px;
}
.probe-step.is-ok .probe-step__icon {
  color: #16a34a;
}
.probe-step.is-bad {
  border-color: rgba(217, 48, 37, 0.4);
}
.probe-step.is-bad .probe-step__icon {
  color: #d93025;
}
.probe-step__icon {
  width: 14px;
  text-align: center;
  font-weight: 700;
  flex: 0 0 auto;
}
.probe-step__name {
  min-width: 42px;
  font-weight: 600;
  color: var(--fg);
  flex: 0 0 auto;
}
.probe-step__time {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-3);
  flex: 0 0 auto;
}
.probe-step__msg {
  margin-left: auto;
  font-size: 11.5px;
  color: #d93025;
  text-align: right;
  word-break: break-word;
}

.model-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0;
  max-height: 160px;
  overflow-y: auto;
  padding: 2px;
}
.model-chip {
  font-size: 11.5px;
  padding: 4px 10px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--fg-2);
}
.model-chip.is-on {
  border-color: var(--accent);
  background: var(--accent-weak);
  color: var(--accent);
  font-weight: 600;
}
.ribbon-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 7px;
}
.ribbon-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  font-size: 12.5px;
  color: var(--fg-3);
}
.ribbon-item.is-on {
  border-color: var(--accent);
  background: var(--accent-weak-2);
  color: var(--accent);
}
.sc-group {
  margin-bottom: 16px;
}
.sc-group__label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--fg-3);
  margin-bottom: 6px;
}
.sc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}
.sc-row__name {
  font-size: 12.5px;
  color: var(--fg-2);
}
.sc-row__keys {
  font-family: var(--font-mono);
  font-size: 11.5px;
  padding: 4px 10px;
  border-radius: 6px;
  background: var(--bg-hover);
  border: 1px solid var(--border);
  color: var(--fg);
  min-width: 110px;
  text-align: center;
}
.sc-row__keys:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.sc-row__capture {
  font-family: var(--font-mono);
  font-size: 11.5px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--accent);
  background: var(--accent-weak-2);
  color: var(--accent);
  outline: none;
  min-width: 110px;
  text-align: center;
}
.confirm-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--fg-2);
}
code {
  font-family: var(--font-mono);
  background: var(--bg-hover);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.92em;
}

/* 窄屏 / 移动端：页签改为横向滚动条，高度仍然撑满父容器（不再写死视口高度） */
@media (max-width: 760px) {
  .settings {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
    height: 100%;
    min-height: 0;
    overflow-x: hidden;
  }
  .settings__nav {
    flex-direction: row;
    overflow-x: auto;
    overflow-y: hidden;
    border-right: none;
    border-bottom: 1px solid var(--border);
    gap: 4px;
    padding: 6px;
    scrollbar-width: none;
  }
  .settings__nav::-webkit-scrollbar {
    display: none;
  }
  .settings__nav-item {
    white-space: nowrap;
    flex: 0 0 auto;
  }
  .settings__body {
    padding: 14px 14px 24px;
    overflow-x: hidden;
  }
  .grid2 {
    grid-template-columns: 1fr;
  }
  .field--row {
    flex-wrap: wrap;
    gap: 8px;
  }
  .row-with-btn {
    flex-wrap: wrap;
  }
  .settings__foot-hint {
    display: none;
  }
}

/* ------------------------ 整页设置布局（1.0.2） ------------------------ */
.settings-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  /* 作为 EditorPage 里 .shell__panes（flex row）的直接子元素，必须显式 grow：
     否则会按内容宽度收缩（实测 1500px 视口下只占 760px，右侧留大片空白）。
     min-width: 0 配合，允许内部内容区正常滚动而不撑破容器。 */
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  background: var(--bg);
}
.settings-page__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 40px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
  flex: 0 0 auto;
}
.settings-page__title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 650;
  color: var(--fg);
}
.settings-page__head-actions {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.settings-page__hint {
  font-size: 11.5px;
  color: var(--fg-3);
}

/* 实时预览开关（1.4.0 需求16）：与页面提示同排，放在标题栏右侧 */
.settings-page__preview-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--fg-2);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.settings-page__preview-toggle input {
  width: 13px;
  height: 13px;
  accent-color: var(--accent);
  cursor: pointer;
}

/*
 * 底部固定保存栏（1.4.0 需求16）。
 *
 * 为什么用 sticky 而不是 fixed：父容器是 `.shell__panes` 里的整页面板，
 * fixed 会相对视口定位、盖在标签栏上；sticky 相对滚动容器底部吸附，
 * 内容滚到哪它都贴在底部，且不影响上方布局。
 * 显式背景 + 上边框是必需的：它会盖住正文内容的最后一行，
 * 半透明会让文字透过来显得脏。
 */
.settings-savebar {
  position: sticky;
  bottom: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: 0 0 auto;
  padding: 10px 16px;
  border-top: 1px solid var(--border-strong);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-2);
}
.settings-savebar.is-dirty .settings-savebar__state {
  color: var(--accent);
  font-weight: 600;
}
.settings-savebar__state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--fg-3);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.settings-savebar__actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}
.settings-page__wrap {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  overflow: hidden;
}
/* 覆盖原弹窗内的尺寸约束，让 nav 与 body 撑满整页 */
.settings-page__wrap .settings {
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  border: none;
  border-radius: 0;
  box-shadow: none;
  background: transparent;
}
.settings-page__wrap .settings__nav {
  width: 196px;
  flex: 0 0 196px;
  border-right: 1px solid var(--border);
  padding: 10px 8px;
  overflow-y: auto;
  background: var(--bg-sidebar);
}
.settings-page__wrap .settings__body {
  flex: 1 1 auto;
  min-width: 0;
  padding: 18px 24px 60px;
  overflow-y: auto;
}
.settings-page__wrap .pane {
  max-width: 880px;
}

/* 主题卡片 */
.themes {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
  margin-top: 10px;
}.theme-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  text-align: left;
  transition: border-color 0.14s ease, box-shadow 0.14s ease;
}
.theme-card:hover {
  border-color: var(--border-strong);
}
.theme-card.is-active {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-weak);
}
.theme-card__preview {
  position: relative;
  display: block;
  height: 62px;
  border-radius: 7px;
  border: 1px solid;
  overflow: hidden;
}
.theme-card__paper {
  position: absolute;
  inset: 8px 8px 8px 26px;
  border-radius: 4px;
  font-size: 10px;
  line-height: 1.5;
  padding: 3px 5px;
  overflow: hidden;
}
.theme-card__bar {
  position: absolute;
  left: 8px;
  top: 8px;
  width: 12px;
  bottom: 8px;
  border-radius: 3px;
  opacity: 0.85;
}
.theme-card__name {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 550;
  color: var(--fg);
}
.theme-card__del {
  position: absolute;
  right: 8px;
  top: 8px;
  font-size: 10px;
  color: var(--fg-3);
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
}
.theme-card__del:hover {
  color: #d93025;
  border-color: #d930254d;
}

/* ------------------------------------------------------------------ */
/* 主题实时预览（1.1.1 新增）                                          */
/*                                                                     */
/* 预览容器通过 :style 绑定 themeVars() 产出的整套变量，内部元素一律    */
/* 用 var(--xxx) 取色 —— 与真实编辑器完全同一条取色链路，因此「预览所见」 */
/* 就等于「应用后所得」。                                              */
/* ------------------------------------------------------------------ */
.theme-preview {
  margin-top: 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--bg);
  font-family: var(--font-ui);
}
.theme-preview__chrome {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  background: var(--bg-sidebar);
  border-bottom: 1px solid var(--border);
}
.theme-preview__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fg-3);
  opacity: 0.45;
}
.theme-preview__tag {
  margin-left: auto;
  font-size: 11px;
  color: var(--fg-3);
}
.theme-preview__paper {
  padding: 14px 18px 16px;
  background: var(--bg-elevated);
  color: var(--content-fg, var(--fg));
  font-family: var(--preview-font-family, var(--font-content, var(--font-ui)));
  font-size: var(--preview-font-size, var(--content-font-size, 14px));
  line-height: var(--preview-line-height, var(--content-line-height, 1.75));
}
.theme-preview__h {
  margin: 0 0 8px;
  font-size: 1.25em;
  font-weight: 650;
  color: var(--content-fg, var(--fg));
}
.theme-preview__p {
  margin: 0 0 10px;
  font-size: 1em;
  line-height: inherit;
}
.theme-preview__a {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.theme-preview__quote {
  margin: 0 0 10px;
  padding: 6px 12px;
  border-left: 3px solid var(--accent);
  background: var(--quote-bg);
  border-radius: 0 6px 6px 0;
  font-size: 12px;
  color: var(--fg-2);
}
.theme-preview__code {
  margin: 0 0 10px;
  padding: 9px 12px;
  background: var(--code-block-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--fg);
  overflow-x: auto;
}
.theme-preview__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}
.theme-preview__table th,
.theme-preview__table td {
  border: 1px solid var(--table-border);
  padding: 5px 9px;
  text-align: left;
}
.theme-preview__table th {
  background: var(--bg-hover);
  font-weight: 600;
}

/* 颜色细化编辑：每项 = 色块 + 标签 + 十六进制值 */
.color-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
  margin: 10px 0 8px;
}
.color-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elevated);
  cursor: pointer;
}
.color-item:hover {
  border-color: var(--border-strong);
}
.color-item__label {
  font-size: 12px;
  color: var(--fg-2);
  flex: 1 1 auto;
}
.color-item__input {
  width: 26px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: none;
  cursor: pointer;
  flex: 0 0 auto;
}
.color-item code {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--fg-3);
  flex: 0 0 auto;
}

/* 窄屏（<900px）：预览与卡片纵向堆叠，不横向溢出 */
@media (max-width: 900px) {
  .theme-preview__paper {
    padding: 12px 14px 14px;
  }
  .color-grid {
    grid-template-columns: 1fr;
  }
  .themes {
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  }
}

@media (max-width: 760px) {
  .settings-page__wrap .settings {
    flex-direction: column;
  }
  .settings-page__wrap .settings__nav {
    width: 100%;
    flex: 0 0 auto;
    display: flex;
    gap: 4px;
    overflow-x: auto;
    border-right: none;
    border-bottom: 1px solid var(--border);
    padding: 8px;
  }
  .settings-page__wrap .settings__nav-item {
    flex: 0 0 auto;
    white-space: nowrap;
  }
  .settings-page__wrap .settings__body {
    padding: 12px 14px 48px;
  }
}
</style>
