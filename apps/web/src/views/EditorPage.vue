<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { NmIcon, NmModal } from '@neomd/ui';
import {
  detectRuntime,
  getBridge,
  isTouchFirst,
  buildExportHtml,
  splitForDocx,
  markdownToPlainText,
  parseDoc,
  AIClient,
  generateTitle,
} from '@neomd/core';
import type { EditorMode, LeftPanelMode, PageWidth, RightPanelSection } from '@neomd/shared';
import { buildDiaryName, formatCompactNumber, isDiaryTitle, relativeTime } from '@neomd/shared';
import { useAppStore, type DocSortKey } from '@/stores/app';
import { useSettingsStore } from '@/stores/settings';
import { useAuthStore } from '@/stores/auth';
import LeftPanel from '@/components/layout/LeftPanel.vue';
import TabBar from '@/components/layout/TabBar.vue';
import EditorBar from '@/components/layout/EditorBar.vue';
import WysiwygEditor from '@/components/editor/WysiwygEditor.vue';
import SourceEditor from '@/components/editor/SourceEditor.vue';
import DocTitleLine from '@/components/editor/DocTitleLine.vue';
import CompareView from '@/components/editor/CompareView.vue';
import ReadView from '@/components/editor/ReadView.vue';
import FormatToolbar from '@/components/editor/FormatToolbar.vue';
import CommandPalette, { type Command } from '@/components/common/CommandPalette.vue';
import SearchPanel from '@/components/common/SearchPanel.vue';
import InputDialog from '@/components/common/InputDialog.vue';
import RightSection from '@/components/panels/right/RightSection.vue';
import ResizeHandle from '@/components/layout/ResizeHandle.vue';
import RibbonContextMenu, { type RibbonItemDef } from '@/components/layout/RibbonContextMenu.vue';
import {
  useLocalLayout,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  RIGHT_SECTION_HEIGHT_MIN,
  RIGHT_SECTION_HEIGHT_MAX,
} from '@/lib/local-layout';
import UserMenu from '@/components/panels/UserMenu.vue';

/*
 * 首屏无关的重量级组件改为**懒加载**（1.1.8 启动极速化）。
 *
 * 为什么：这些组件原先都是静态 import，会被打进 `EditorPage` 的入口 chunk，
 * 导致首屏必须下载并解析它们才能渲染编辑器：
 * - `SettingsPage` 约 116KB（含主题/供应商/存储/快捷键等全部设置面板）
 * - `PluginCenter` 插件商店、`AiPanel` AI 面板、`FlowchartEditor`/`MindmapEditor` 图编辑器
 * - `HistoryModal`/`ShareModal`/`ConflictModal` 三个弹窗
 *
 * 它们都只在用户**主动点击**后才出现，因此改成按需加载：
 * 首屏少下载几百 KB，JS 解析时间同步下降。
 * 注意 `LeftPanel` / `TabBar` / `EditorBar` / `WysiwygEditor` 等首屏必需组件保持静态引入。
 */
const SettingsPage = defineAsyncComponent(() => import('@/views/SettingsPage.vue'));
const PluginCenter = defineAsyncComponent(() => import('@/components/panels/PluginCenter.vue'));
const AiPanel = defineAsyncComponent(() => import('@/components/panels/AiPanel.vue'));
const FlowchartEditor = defineAsyncComponent(() => import('@/components/diagram/FlowchartEditor.vue'));
const MindmapEditor = defineAsyncComponent(() => import('@/components/diagram/MindmapEditor.vue'));
const HistoryModal = defineAsyncComponent(() => import('@/components/panels/HistoryModal.vue'));
const ShareModal = defineAsyncComponent(() => import('@/components/panels/ShareModal.vue'));
const ConflictModal = defineAsyncComponent(() => import('@/components/panels/ConflictModal.vue'));

const router = useRouter();
const app = useAppStore();
const settingsStore = useSettingsStore();
const auth = useAuthStore();

const paletteOpen = ref(false);
const paletteCommands = ref<Command[]>([]);
const searchOpen = ref(false);
const searchQuery = ref('');
const settingsTab = ref<string>('general');
const historyOpen = ref(false);
/** 插件中心（功能区入口，替代原先塞在设置里的插件页签） */

/* ---------------- 正文缩放（1.0.2） ---------------- */

/** 状态栏缩放下拉的预设比例 */
const ZOOM_PRESETS = [50, 75, 100, 125, 150, 200, 300];
const zoomMenuOpen = ref(false);
const zoomInput = ref('');

/** 应用手动输入的缩放比例：夹到 50-300，非法输入忽略 */
function applyCustomZoom(): void {
  const n = Number(zoomInput.value);
  if (!Number.isFinite(n) || n <= 0) {
    zoomMenuOpen.value = false;
    return;
  }
  app.setZoom(n);
  zoomInput.value = '';
  zoomMenuOpen.value = false;
}
const shareOpen = ref(false);
const exportOpen = ref(false);
const exportFormat = ref<'html' | 'pdf' | 'docx'>('pdf');
const exportBusy = ref(false);
const mobileDrawer = ref(false);
const mobileAi = ref(false);
const bootError = ref('');
/**
 * 启动状态拆成两个（1.1.9 启动极速化）。
 *
 * 用户要求「像 Obsidian 那样打开即用」。原来只有一个 `booting`，用
 * `v-if="booting"` 挡住**整个工作台**：仓库索引 + 标签正文全部读完之前，
 * 左侧栏、标签栏、工具栏一个都不渲染，用户面对的是全屏骨架，感知上就是「启动很慢」。
 *
 * 现在拆开：
 * - `shellReady`：外壳（左侧栏 / 标签栏 / 工具栏 / 状态栏）可以渲染了。
 *   它不需要等文档正文，`onMounted` 里同步置 true 即可 —— 首帧就能画出真实外壳。
 * - `docReady`：正文区可以渲染真实编辑器了（当前文档正文已就绪）。
 *   只挡住正文区那一块，用轻量占位，不再阻塞外壳。
 *
 * 这样即使 app.ts 的标签正文还是串行读，用户也能立刻看到并操作界面框架，
 * 感知延迟大幅下降（这是「感知性能」优化，不依赖任何后端/接口改动）。
 */
const shellReady = ref(false);
const docReady = ref(false);
/** 正文区占位用的阶段文案（原 bootPhase，语义不变，现在只影响正文区） */
const bootPhase = ref('正在打开本地仓库…');
const wordCount = ref({ chars: 0, words: 0 });
const recentClosed = ref<Array<{ docId: string; mode: EditorMode }>>([]);
// 注意：`splitDirection` / `splitTabId` 都定义在下方（读写 localLayout，用于持久化），
// 此处不再声明局部 ref。
const findBarOpen = ref(false);
const findBarReplaceMode = ref(false);
const findText = ref('');
const replaceText = ref('');
const renameModal = ref<{ open: boolean; docId: string; folder: string; name: string; aiLoading: boolean }>({
  open: false,
  docId: '',
  folder: '',
  name: '',
  aiLoading: false,
});
const moveModal = ref<{ open: boolean; docId: string; currentFolder: string; targetFolder: string }>({
  open: false,
  docId: '',
  currentFolder: '',
  targetFolder: '',
});
const runtime = detectRuntime();
const touch = isTouchFirst();

const wysiwygRef = ref<InstanceType<typeof WysiwygEditor> | null>(null);
/** 分屏第二栏的编辑器引用（1.1.8 真分屏：第二栏也能独立编辑） */
const splitWysiwygRef = ref<InstanceType<typeof WysiwygEditor> | null>(null);

const activeTab = computed(() => app.activeTab);

/**
 * 分屏第二栏的标签（1.1.8 真分屏）。
 *
 * 用户原话：「标题栏的左右分屏和上下分屏；不是当前文件预览；而是可以同时打开不同的文件」。
 *
 * 改前有三处不足：
 * 1. 第二栏渲染的是 `<ReadView>`（只读预览），不能编辑；
 * 2. 第二栏没有自己的标签选择器，只能显示「当前文件」或右键时选中的那一个；
 * 3. `splitTabId` 是普通 ref，刷新就丢。
 *
 * 现在：`splitTabId` 持久化到 localLayout；第二栏有自己的标签下拉选择器，
 * 可以选任意已打开的标签；第二栏渲染真正的编辑器，与主栏互不干扰。
 */
const splitTab = computed(() => {
  if (splitDirection.value === 'none') return null;
  const found = app.tabs.find((t) => t.id === splitTabId.value);
  return found ?? activeTab.value;
});
const mode = computed<EditorMode>(() => activeTab.value?.mode ?? 'wysiwyg');
/**
 * 页宽以设置为唯一数据源：工具栏下拉、命令面板、设置面板改完立即对所有文档生效，
 * 避免「改了页宽但当前标签页仍用旧的 per-tab 值」导致看起来设置不生效。
 */
const pageWidth = computed<PageWidth>(() => settingsStore.settings.appearance.pageWidth);
const pageWidthClass = computed(() => [
  `nm-page-${pageWidth.value}`,
  settingsStore.settings.appearance.showLineNumbers ? 'nm-show-linenos' : '',
]);
const layout = computed(() => settingsStore.settings.layout);
const autosaveEnabled = computed(() => settingsStore.settings.autosave?.enabled !== false);
const narrow = ref(false);

/* 1.1.1：正文配色方案已并入主题。
 * 原来这里有一个 `editorColorStyle` computed，把 editorColorScheme 换算成
 * 内联 background-color / color / --fg / --bg / --bg-elevated 绑到 .shell__doc 上，
 * 会**直接覆盖主题变量**，导致「主题看着不生效」。现已整体删除：
 * 正文颜色只由 <html> 上的主题变量（--content-bg / --content-fg / --bg-elevated）决定。
 * `appearance.editorColorScheme` 字段仍保留，仅由 resolveTheme() 用于老数据迁移。 */

/** 功能区仅展示已开通的插件按钮，不显示保存等文章操作类按钮 */
const PLUGIN_RIBBON_DEFS: Record<string, { icon: string; title: string; pluginId: string }> = {
  'daily-notes': { icon: 'calendar', title: '今日日记 Ctrl+D', pluginId: 'daily-notes' },
  daily: { icon: 'calendar', title: '今日日记 Ctrl+D', pluginId: 'daily-notes' },
  'random-note': { icon: 'dice', title: '漫游笔记 Ctrl+Shift+R', pluginId: 'random-note' },
  random: { icon: 'dice', title: '漫游笔记 Ctrl+Shift+R', pluginId: 'random-note' },
  graph: { icon: 'graph', title: '关系图谱', pluginId: 'graph' },
  'tag-list': { icon: 'tag', title: '标签列表', pluginId: 'tag-list' },
  tags: { icon: 'tag', title: '标签列表', pluginId: 'tag-list' },
  bookmarks: { icon: 'bookmark', title: '书签', pluginId: 'bookmarks' },
  'file-recovery': { icon: 'history', title: '文件恢复', pluginId: 'file-recovery' },
  whiteboard: { icon: 'layers', title: '白板', pluginId: 'whiteboard' },
  slides: { icon: 'columns', title: '幻灯片演示', pluginId: 'slides' },
  database: { icon: 'table', title: '数据库视图', pluginId: 'database' },
  'web-browser': { icon: 'globe', title: '内嵌浏览器', pluginId: 'web-browser' },
  recorder: { icon: 'mic', title: '语音录音机', pluginId: 'recorder' },
  'diagram-flowchart': { icon: 'columns', title: '流程图', pluginId: 'diagram-flowchart' },
  'new-flowchart': { icon: 'columns', title: '流程图', pluginId: 'diagram-flowchart' },
  'diagram-mindmap': { icon: 'graph', title: '思维导图', pluginId: 'diagram-mindmap' },
  'new-mindmap': { icon: 'graph', title: '思维导图', pluginId: 'diagram-mindmap' },
};

const ribbonActions = computed(() => {
  const seen = new Set<string>();
  const out: Array<{ id: string; icon: string; title: string }> = [];
  const rawList = layout.value.ribbonItems ?? [];
  // 兼容升级：若用户的 ribbonItems 尚未包含图表插件 id，默认追加进候选并交由 pluginOn 判断显隐
  const candidates = [...rawList, 'diagram-flowchart', 'diagram-mindmap'];
  for (const rawId of candidates) {
    const def = PLUGIN_RIBBON_DEFS[rawId];
    if (!def) continue;
    if (!settingsStore.pluginOn(def.pluginId)) continue;
    if (seen.has(def.pluginId)) continue;
    seen.add(def.pluginId);
    out.push({ id: def.pluginId, icon: def.icon, title: def.title });
  }
  return out;
});

/**
 * 功能区「末位固定按钮」（1.1.8）。
 *
 * 用户原话：「功能区最后一个图标，如果在左侧或右侧就最下对齐；放置插件商店的入口，
 * 点击后标签页打开插件商店，可以管理当前插件或安装新插件」。
 *
 * 从 `ribbonActions` 里拆出来单独渲染，才能在竖排时给它 `margin-top: auto` 贴底 ——
 * 混在同一个 `v-for` 里就没法只让最后一项吃自动外边距。
 * 复用既有的 `PluginCenter.vue`（`openPluginStore()` 以标签页打开），不新造组件。
 */
const ribbonBottomAction = { id: 'plugin-center', icon: 'layers', title: '插件商店（管理已装插件 / 安装新插件）' };

const headings = computed(() => (activeTab.value ? parseDoc(activeTab.value.content).headings : []));

const searchResults = computed(() => {
  if (!searchQuery.value.trim()) return [];
  return app.search(searchQuery.value, { limit: 60 }).map((h) => ({
    docId: h.docId,
    path: h.path,
    title: h.title,
    snippet: h.snippet,
    score: h.score,
    matches: h.matches ?? [],
  }));
});

/** 左侧栏顶部动作 */
const panelActions = computed(() => {
  const items: Array<{ id: string; icon: string; title: string }> = [
    { id: 'search', icon: 'search', title: '全库搜索 Ctrl+Shift+F' },
    { id: 'command', icon: 'command', title: '命令面板 Ctrl+P' },
    { id: 'width', icon: 'width', title: `页宽：${widthLabel(pageWidth.value)}` },
    { id: 'sync', icon: 'sync', title: '同步 Ctrl+S' },
    { id: 'save', icon: 'save', title: '保存 Ctrl+S' },
    { id: 'history', icon: 'history', title: '版本历史' },
    { id: 'sort', icon: 'filter', title: '排序方式' },
  ];
  return items;
});

function widthLabel(w: PageWidth): string {
  return w === 'narrow' ? '窄' : w === 'standard' ? '标准' : w === 'wide' ? '宽' : '铺满';
}

function cycleWidth(): void {
  const order: PageWidth[] = ['narrow', 'standard', 'wide', 'full'];
  const idx = order.indexOf(pageWidth.value);
  app.setPageWidth(order[(idx + 1) % order.length]!);
}

/* ---------------- 启动 ---------------- */

/**
 * 启动阶段网络任务超时上限。
 *
 * 超过这个时间仍未返回，就**放弃等待**、直接用本地数据把编辑器渲染出来；
 * 云端设置与积分本来就有响应式更新，晚到会自然补上，不需要阻塞首屏。
 */
const BOOT_NETWORK_TIMEOUT_MS = 8000;

/**
 * 给 Promise 套一层超时，且**永不 reject**。
 *
 * 启动路径上任何一个网络请求（或校验接口）卡住或报错，都不应该让用户停在
 * 「正在打开仓库」的转圈上；超时/失败统一回退到 `fallback` 继续往下走。
 */
function withBootTimeout<T>(task: Promise<T>, ms: number, fallback: T, label: string): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn(`[boot] ${label} 超过 ${ms}ms 未完成，改用本地数据继续启动`);
      resolve(fallback);
    }, ms);
    task.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // 失败静默：登录态失效、服务端 5xx、断网都属于可恢复情况
        console.warn(`[boot] ${label} 失败，改用本地数据继续启动`, err);
        resolve(fallback);
      },
    );
  });
}

async function boot(): Promise<void> {
  docReady.value = false;
  bootError.value = '';
  bootPhase.value = '正在打开本地仓库…';

  try {
    // ① 零网络等待：直接根据本地记忆的仓库路径或缓存用户信息计算出本地/云端仓库位置
    const info = detectRuntime();
    const bridge = getBridge();
    let location = localStorage.getItem('neomd.lastVault') ?? '';

    if (info.platform === 'desktop' && bridge?.paths) {
      if (!location) location = await bridge.paths.vaultDefault();
    } else if (info.platform === 'android' && bridge?.paths) {
      if (!location) location = await bridge.paths.documents();
    } else {
      // 网页端：authStore 初始化时已同步从 localStorage 恢复缓存 user，无需等待网络即可计算云仓库名
      location = location || app.cloudVaultLocation();
    }

    // ② 立即打开本地仓库（内部已启用 deferReconcile，只读本地缓存索引 JSON，几毫秒内完成）
    if (!app.vaultReady) await app.openVault(location);

    /**
     * ③ 恢复标签（1.1.9 启动极速化 + 多窗口）。
     *
     * `?doc=<docId>&fresh=1`（「移动至新窗口」，desktop 主进程按此约定拼 URL）：
     * - 只打开该文档；
     * - **完全不恢复**旧标签列表 —— 否则新窗口会把原窗口的全部标签克隆一份，
     *   「移动」就变成「整组复制」；
     * - 交给 `restoreTabs({ fresh: true })` 而不是「自己跳过 + openDoc」：
     *   fresh 分支在 store 里还会**关闭本进程的标签持久化**，否则这个只剩一篇的
     *   新窗口退出时会把 `neomd.tabs` 覆盖成单标签，把原窗口的标签列表冲掉。
     *
     * 非 fresh 情形把「当前应激活的 docId」作为 `eagerDocId` 传下去：
     * 让 restoreTabs 只**同步**读这一篇的正文，其余标签先建壳、后台再补
     * （这一步是首屏时间的主要来源，过去是串行读 N 篇）。
     */
    const urlDocId =
      typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('doc')?.trim() || '' : '';
    const isFreshWindow =
      typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('fresh') === '1';

    if (isFreshWindow && urlDocId) {
      await app.restoreTabs({ fresh: true, eagerDocId: urlDocId });
    } else {
      const eagerDocId = urlDocId || app.activeTab?.docId || '';
      await app.restoreTabs({ eagerDocId });
      // ④ 若带 ?doc=<docId> 启动，优先打开并激活目标文档（无 fresh 时仍恢复旧标签）
      if (urlDocId && app.docs.some((d) => d.docId === urlDocId)) {
        await app.openDoc(urlDocId);
      } else if (!app.tabs.length && app.docs.length) {
        const first = [...app.docs].sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (first) await app.openDoc(first.docId);
      }
    }
  } catch (e) {
    bootError.value = (e as Error).message;
  } finally {
    // ⑤ 当前文档就绪 → 放开正文区（外壳早在 onMounted 就已渲染，不受这里影响）
    docReady.value = true;

    // ⑥ 打开后再在后台异步恢复登录态、同步云端设置项、积分与仓库数据（完全不阻塞 UI）
    app.installAutoSyncTimer();
    void (async () => {
      const restored = await withBootTimeout(
        auth.restore().then(() => true),
        BOOT_NETWORK_TIMEOUT_MS,
        false,
        '恢复登录状态',
      );
      if (restored && auth.isLoggedIn) {
        await Promise.all([
          withBootTimeout(settingsStore.pullCloudSettings(), BOOT_NETWORK_TIMEOUT_MS, undefined, '拉取云端设置'),
          withBootTimeout(app.loadCredits(), BOOT_NETWORK_TIMEOUT_MS, undefined, '拉取积分'),
        ]);
      }
      if (app.vaultReady && app.canSync()) {
        if (auth.isLoggedIn) {
          await app.runFirstSyncIfNeeded();
        }
        await app.syncNow({ silent: true });
      }
    })().catch(() => undefined);
  }
}

/* ---------------- 命令（仅保留正文编辑与视图排版相关命令，不放保存等文件操作） ---------------- */

function buildCommands(): Command[] {
  const base: Command[] = [
    { id: 'h1', title: '一级标题 (H1)', group: '正文标题', keys: 'Ctrl+1', icon: 'heading', run: () => applyHeading(1) },
    { id: 'h2', title: '二级标题 (H2)', group: '正文标题', keys: 'Ctrl+2', icon: 'heading', run: () => applyHeading(2) },
    { id: 'h3', title: '三级标题 (H3)', group: '正文标题', keys: 'Ctrl+3', icon: 'heading', run: () => applyHeading(3) },
    { id: 'h4', title: '四级标题 (H4)', group: '正文标题', keys: 'Ctrl+4', icon: 'heading', run: () => applyHeading(4) },
    { id: 'bold', title: '加粗选中文本', group: '正文格式', keys: 'Ctrl+B', icon: 'bold', run: () => onFormatCommand('bold') },
    { id: 'italic', title: '斜体选中文本', group: '正文格式', keys: 'Ctrl+I', icon: 'italic', run: () => onFormatCommand('italic') },
    { id: 'underline', title: '下划线', group: '正文格式', keys: 'Ctrl+U', icon: 'underline', run: () => onFormatCommand('underline') },
    { id: 'strike', title: '删除线', group: '正文格式', keys: 'Ctrl+Shift+X', icon: 'strike', run: () => onFormatCommand('strike') },
    { id: 'highlight', title: '荧光笔高亮', group: '正文格式', keys: 'Ctrl+Shift+H', icon: 'highlighter', run: () => onFormatCommand('highlight') },
    { id: 'code', title: '行内代码', group: '正文格式', icon: 'code', run: () => onFormatCommand('code') },
    { id: 'ul', title: '无序列表', group: '正文段落', keys: 'Ctrl+Shift+8', icon: 'list', run: () => onFormatCommand('ul') },
    { id: 'ol', title: '有序列表', group: '正文段落', keys: 'Ctrl+Shift+9', icon: 'outline', run: () => onFormatCommand('ol') },
    { id: 'task', title: '待办任务列表', group: '正文段落', keys: 'Ctrl+Shift+T', icon: 'check', run: () => onFormatCommand('task') },
    { id: 'quote', title: '引用块', group: '正文段落', keys: 'Ctrl+Shift+Q', icon: 'quote', run: () => onFormatCommand('quote') },
    { id: 'codeblock', title: '插入代码块', group: '正文插入', keys: 'Ctrl+Shift+E', icon: 'codeBlock', run: () => onFormatCommand('codeblock') },
    { id: 'table', title: '插入 3×3 表格', group: '正文插入', keys: 'Ctrl+Shift+M', icon: 'table', run: () => onFormatCommand('table') },
    { id: 'link', title: '插入超链接', group: '正文插入', keys: 'Ctrl+K', icon: 'link', run: () => onFormatCommand('link') },
    { id: 'hr', title: '插入水平分隔线', group: '正文插入', keys: 'Ctrl+Shift+-', icon: 'hr', run: () => onFormatCommand('hr') },
    { id: 'toc', title: '在顶部插入正文目录 (TOC)', group: '正文插入', icon: 'outline', run: () => onFileOp('insert-toc') },
    { id: 'frontmatter', title: '插入 YAML Frontmatter 属性头', group: '正文插入', icon: 'tag', run: () => onFileOp('insert-frontmatter') },
    { id: 'clean-blank', title: '清理多余空行与行尾空格', group: '正文排版', icon: 'layout', run: () => onFileOp('clean-blank') },
    { id: 'find', title: '在正文中查找与替换', group: '正文排版', keys: 'Ctrl+F', icon: 'search', run: () => { findBarOpen.value = true; findBarReplaceMode.value = true; } },
    { id: 'linenos', title: `切换正文行号（当前：${settingsStore.settings.appearance.showLineNumbers ? '开' : '关'}）`, group: '正文视图', icon: 'list', run: () => settingsStore.updateAppearance({ showLineNumbers: !settingsStore.settings.appearance.showLineNumbers }) },
    { id: 'width', title: `切换正文页宽（当前：${widthLabel(pageWidth.value)}）`, group: '正文视图', icon: 'width', run: cycleWidth },
    { id: 'mode', title: '切换编辑视图模式', group: '正文视图', keys: 'Ctrl+E', icon: 'layers', run: () => app.cycleMode() },
    { id: 'format', title: '显示/隐藏正文工具栏', group: '正文视图', icon: 'type', run: () => settingsStore.updateLayout({ editorToolbar: !layout.value.editorToolbar }) },
    { id: 'new-window', title: '新建独立窗口', group: '正文视图', keys: 'Ctrl+Shift+N', icon: 'external', run: () => void openNewAppWindow() },
  ];
  // 挂载用户导入或安装的社区扩展插件命令
  try {
    const raw = localStorage.getItem('neomd.communityPlugins.v1');
    if (raw) {
      const list = JSON.parse(raw) as Array<{ pluginId: string; name: string; codeJs: string }>;
      for (const item of list) {
        if (!settingsStore.pluginOn(item.pluginId)) continue;
        base.push({
          id: `plugin:${item.pluginId}`,
          title: `运行扩展插件：${item.name}`,
          group: '扩展插件',
          icon: 'sparkles',
          run: () => runCommunityPlugin(item),
        });
      }
    }
  } catch {
    /* ignore */
  }
  return base;
}

function runCommunityPlugin(item: { pluginId: string; name: string; codeJs: string }): void {
  const tab = activeTab.value;
  const hostApi = {
    getMarkdown: () => tab?.content ?? '',
    setMarkdown: (next: string) => {
      if (tab) app.updateTabContent(tab.id, String(next ?? ''));
    },
    insertMarkdown: (snippet: string) => {
      if (tab) app.updateTabContent(tab.id, `${tab.content}${snippet}`);
    },
    getTitle: () => tab?.title ?? '',
    notify: (msg: string, type: 'info' | 'success' | 'error' = 'info') => app.notify(msg, type),
    registerCommand: (cmd: { id: string; title: string; run: () => void }) => {
      cmd?.run?.();
    },
  };
  try {
    const cleaned = item.codeJs.replace(/^\s*export\s+default\s+/, 'return ');
    const factory = new Function(cleaned) as () => { setup?: (api: typeof hostApi) => void };
    const mod = factory();
    if (typeof mod?.setup === 'function') {
      mod.setup(hostApi);
    } else {
      app.notify(`插件「${item.name}」已执行`, 'success');
    }
  } catch (e) {
    app.notify(`插件执行异常：${(e as Error).message}`, 'error');
  }
}

watch(paletteOpen, (v) => {
  if (v) paletteCommands.value = buildCommands();
});

/* ---------------- 快捷键 ---------------- */

function keyCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let main = e.key;
  if (main === ' ') main = 'Space';
  else if (main === 'Escape') main = 'Esc';
  else if (main.length === 1) main = main.toUpperCase();
  parts.push(main);
  return parts.join('+');
}

/**
 * 浏览器保留快捷键：命中时明确提示不可用并建议使用桌面端，
 * 而不是静默失效让用户困惑。
 */
const BROWSER_RESERVED = new Set([
  'Ctrl+W',
  'Ctrl+Shift+W',
  'Ctrl+T',
  'Ctrl+Shift+T',
  'Ctrl+N',
  'Ctrl+Shift+N',
  'Ctrl+Shift+F',
  'Ctrl+L',
  'Ctrl+R',
  'F5',
  'Ctrl+Shift+R',
  'Ctrl+P',
  'Ctrl+S',
  'Ctrl+O',
]);

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

function runShortcutCommand(command: string): boolean {
  switch (command) {
    case 'editor.h1':
    case 'editor.h2':
    case 'editor.h3':
    case 'editor.h4':
    case 'editor.h5':
    case 'editor.h6':
      applyHeading(Number(command.slice(-1)));
      return true;
    case 'editor.bold':
      onFormatCommand('bold');
      return true;
    case 'editor.italic':
      onFormatCommand('italic');
      return true;
    case 'editor.underline':
      onFormatCommand('underline');
      return true;
    case 'editor.strike':
      onFormatCommand('strike');
      return true;
    case 'editor.highlight':
      onFormatCommand('highlight');
      return true;
    case 'editor.code':
      onFormatCommand('code');
      return true;
    case 'editor.codeBlock':
      onFormatCommand('codeblock');
      return true;
    case 'editor.link':
      onFormatCommand('link');
      return true;
    case 'editor.quote':
      onFormatCommand('quote');
      return true;
    case 'editor.taskList':
      onFormatCommand('task');
      return true;
    case 'editor.bulletList':
      onFormatCommand('ul');
      return true;
    case 'editor.numberedList':
      onFormatCommand('ol');
      return true;
    case 'editor.table':
      onFormatCommand('table');
      return true;
    case 'editor.hr':
      onFormatCommand('hr');
      return true;
    case 'app.save':
      void saveAndSync();
      return true;
    case 'app.sync':
      void app.syncNow();
      return true;
    case 'app.commandPalette':
      paletteOpen.value = true;
      return true;
    case 'app.quickSwitch':
    case 'app.search':
      searchOpen.value = true;
      return true;
    case 'app.newNote':
      void app.createDoc({});
      return true;
    case 'app.closeTab':
      if (app.activeTabId) closeTab(app.activeTabId);
      return true;
    case 'app.reopenTab': {
      const last = recentClosed.value.pop();
      if (last) void app.openDoc(last.docId, { mode: last.mode });
      return true;
    }
    case 'app.toggleSidebar':
      settingsStore.updateLayout({ leftPanelOpen: !layout.value.leftPanelOpen });
      return true;
    case 'app.toggleAi':
      toggleAi();
      return true;
    case 'app.toggleMode':
      app.cycleMode();
      return true;
    case 'app.settings':
      openSettings();
      return true;
    case 'app.export':
      exportOpen.value = true;
      return true;
    case 'daily.today':
      openDaily();
      return true;
    case 'random.open':
      openRandom();
      return true;
    default:
      return false;
  }
}

function onKeydown(e: KeyboardEvent): void {
  const combo = keyCombo(e);

  // 1. 优先匹配用户在设置页自定义的快捷键（settingsStore.settings.shortcuts）
  const customShortcuts = settingsStore.settings.shortcuts ?? [];
  const matchedCustom = customShortcuts.find((s) =>
    s.keys.some((k) => k.toLowerCase() === combo.toLowerCase()),
  );
  if (matchedCustom) {
    // 若在普通 input/textarea 输入框内，仅放行全局 app.* 快捷键，避免拦截正常打字
    const inInput = isEditable(e.target) && !(e.target as HTMLElement | null)?.closest('.ProseMirror, .cm-editor');
    if (!inInput || matchedCustom.command.startsWith('app.') || matchedCustom.command.startsWith('daily.') || matchedCustom.command.startsWith('random.')) {
      if (runShortcutCommand(matchedCustom.command)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
  }

  // 标题快捷键必须优先于输入框判断
  const heading = /^Ctrl\+([1-6])$/.exec(combo);
  if (heading) {
    e.preventDefault();
    e.stopPropagation();
    applyHeading(Number(heading[1]));
    return;
  }

  // 粘贴为纯文本：只接管正文区域的按键，输入框内保留浏览器原生的粘贴行为
  if (combo === 'Ctrl+Shift+V') {
    const el = document.activeElement as HTMLElement | null;
    const inEditor = !el || el === document.body || Boolean(el.closest('.ProseMirror, .cm-editor, .shell__content'));
    if (!inEditor) return;
    e.preventDefault();
    e.stopPropagation();
    runEditorCtx('paste-plain');
    return;
  }

  const handled: Record<string, () => void> = {
    'Ctrl+P': () => (paletteOpen.value = true),
    'Ctrl+Shift+F': () => (searchOpen.value = true),
    'Ctrl+S': () => void saveAndSync(),
    'Ctrl+N': () => void app.createDoc({}),
    'Ctrl+Shift+N': () => void openNewAppWindow(),
    'Ctrl+,': () => openSettings(),
    'Ctrl+E': () => app.cycleMode(),
    'Ctrl+Shift+A': () => toggleAi(),
    'Ctrl+\\': () => settingsStore.updateLayout({ leftPanelOpen: !layout.value.leftPanelOpen }),
    'Ctrl+W': () => app.activeTabId && closeTab(app.activeTabId),
    'Ctrl+O': () => (searchOpen.value = true),
    'Ctrl+Shift+P': () => (exportOpen.value = true),
    'Ctrl+D': () => openDaily(),
    'Ctrl+Shift+R': () => openRandom(),
  };

  const fn = handled[combo];
  if (fn) {
    e.preventDefault();
    e.stopPropagation();
    fn();
    return;
  }

  // 其余 Ctrl/Meta 组合若被浏览器占用，给出明确提示
  if ((e.ctrlKey || e.metaKey) && BROWSER_RESERVED.has(combo) && !isEditable(e.target)) {
    e.preventDefault();
    notifyShortcutUnavailable(combo);
  }
}

let lastShortcutNotice = 0;
function notifyShortcutUnavailable(combo: string): void {
  const now = Date.now();
  if (now - lastShortcutNotice < 2500) return;
  lastShortcutNotice = now;
  if (runtime.platform === 'web') {
    app.notify(`快捷键 ${combo} 被浏览器占用，无法在此使用。建议下载 PC 客户端。`, 'info', 4200);
  }
}

function targetWysiwyg() {
  return splitDirection.value !== 'none' && activePane.value === 'split'
    ? (splitWysiwygRef.value ?? wysiwygRef.value)
    : wysiwygRef.value;
}

function applyHeading(level: number): void {
  if (mode.value === 'source' || mode.value === 'compare') {
    const cm = document.querySelector('.cm-content') as HTMLElement | null;
    if (cm) {
      cm.focus();
      document.execCommand('insertText', false, `${'#'.repeat(level)} `);
    }
    return;
  }
  const w = targetWysiwyg() as unknown as { setHeading?: (lv: 1 | 2 | 3 | 4 | 5 | 6) => void } | null;
  if (w?.setHeading) {
    w.setHeading(level as 1 | 2 | 3 | 4 | 5 | 6);
    return;
  }
  targetWysiwyg()?.runCommand((ed) => {
    if (ed.isActive('heading', { level })) ed.chain().focus().setParagraph().run();
    else ed.chain().focus().setNode('heading', { level }).run();
  });
}

/* ---------------- 格式工具栏 ---------------- */

const editorCtxMenu = ref<{ x: number; y: number } | null>(null);

function openEditorMenu(e: MouseEvent): void {
  if (!activeTab.value || mode.value === 'read') return;
  e.preventDefault();
  e.stopPropagation();
  const x = e.clientX;
  const y = e.clientY;
  setTimeout(() => {
    editorCtxMenu.value = { x, y };
  }, 0);
}

function editorMenuPos(m: { x: number; y: number }): { left: string; top: string } {
  const vw = typeof globalThis.innerWidth === 'number' ? globalThis.innerWidth : 1200;
  const vh = typeof globalThis.innerHeight === 'number' ? globalThis.innerHeight : 800;
  return {
    left: `${Math.min(m.x, Math.max(8, vw - 210))}px`,
    top: `${Math.min(m.y, Math.max(8, vh - 360))}px`,
  };
}

function runEditorCtx(cmd: string): void {
  editorCtxMenu.value = null;
  if (cmd === 'copy') {
    const sel = wysiwygRef.value?.getSelectionText() || window.getSelection()?.toString() || '';
    if (sel) void navigator.clipboard?.writeText(sel);
    return;
  }
  if (cmd === 'cut') {
    const sel = wysiwygRef.value?.getSelectionText() || window.getSelection()?.toString() || '';
    if (sel) {
      void navigator.clipboard?.writeText(sel);
      wysiwygRef.value?.replaceSelection('');
    }
    return;
  }
  if (cmd === 'paste') {
    void navigator.clipboard?.readText().then((t) => {
      if (t) wysiwygRef.value?.replaceSelection(t);
    });
    return;
  }
  if (cmd === 'paste-plain') {
    void navigator.clipboard
      ?.readText?.()
      .then((t) => {
        if (!t) {
          app.notify('剪贴板里没有可粘贴的文本', 'info', 1800);
          return;
        }
        // 所见即所得：交给 Tiptap 以纯文本插入（丢弃字体/颜色/表格等富文本样式）
        if (mode.value === 'wysiwyg' && wysiwygRef.value?.pastePlainText) {
          wysiwygRef.value.pastePlainText(t);
          return;
        }
        // 源码 / 对照模式：CodeMirror 里本就是纯文本，直接写入光标处
        const cm = document.querySelector('.cm-content') as HTMLElement | null;
        if (cm) {
          cm.focus();
          document.execCommand('insertText', false, t);
        }
      })
      .catch(() => app.notify('无法读取剪贴板，请使用 Ctrl+Shift+V', 'error', 2200));
    return;
  }
  onFormatCommand(cmd);
}

function closeEditorMenu(): void {
  editorCtxMenu.value = null;
}

function onFormatCommand(cmd: string, _arg?: string): void {
  if (cmd === 'palette') {
    paletteOpen.value = true;
    return;
  }
  const target = targetWysiwyg();
  if (cmd === 'undo' || cmd === 'redo') {
    target?.runCommand((ed) => {
      if (cmd === 'undo') ed.chain().focus().undo().run();
      else ed.chain().focus().redo().run();
    });
    return;
  }
  if (cmd.startsWith('h') && /^h[1-6]$/.test(cmd)) {
    applyHeading(Number(cmd.slice(1)));
    return;
  }
  if (cmd === 'image') {
    void app.askInput('插入图片', '输入图片 URL 地址', 'https://').then((url) => {
      if (!url || !url.trim()) return;
      const cleanUrl = url.trim();
      if (target?.insertMarkdownBlock) {
        target.insertMarkdownBlock(`![](${cleanUrl})`);
      } else {
        target?.runCommand((ed) => {
          ed.chain().focus().insertContent(`<img src="${cleanUrl}" alt="" />`).run();
        });
      }
    });
    return;
  }
  target?.runCommand((ed) => {
    const c = ed.chain().focus();
    switch (cmd) {
      case 'bold':
        c.toggleBold().run();
        break;
      case 'italic':
        c.toggleItalic().run();
        break;
      case 'underline':
        c.toggleUnderline().run();
        break;
      case 'strike':
        c.toggleStrike().run();
        break;
      case 'highlight':
        c.toggleHighlight().run();
        break;
      case 'code':
        c.toggleCode().run();
        break;
      case 'ul':
        c.toggleBulletList().run();
        break;
      case 'ol':
        c.toggleOrderedList().run();
        break;
      case 'task':
        c.toggleTaskList().run();
        break;
      case 'quote':
        c.toggleBlockquote().run();
        break;
      case 'table':
        c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
        break;
      case 'codeblock':
        c.toggleCodeBlock().run();
        break;
      case 'hr':
        c.setHorizontalRule().run();
        break;
      case 'link': {
        void app.askInput('插入链接', '输入链接地址', 'https://').then((v) => {
          if (!v) return;
          ed.chain().focus().extendMarkRange('link').setLink({ href: v }).run();
        });
        break;
      }
      default:
        break;
    }
  });
}

/* ---------------- 文档操作 ---------------- */

async function saveAndSync(): Promise<void> {
  await app.saveActiveTab({ auto: false });
}

/**
 * 点击状态栏左下角的同步状态（1.1.7 新增）。
 *
 * 用户原话：「任务栏左下角有自动同步已就绪，但是点击无法操作」。
 * 现在的行为：
 * - 有云存储配置 → 立即 `syncNow()`，完成后会 toast「同步完成：拉取 x，推送 y」；
 * - 未配置云存储 → `syncNow()` 内部会提示去设置里配 Bucket/AccessKey，
 *   但用户可能不知道该去哪配，所以这里额外把设置页打开到「对象存储」页签，
 *   给一条明确的下一步（否则点了只弹个 toast 仍然像"没反应"）。
 * - 正在同步中重复点击：直接给一条进行中的提示，不重复触发。
 */
async function onSyncStatusClick(): Promise<void> {
  if (app.syncState === 'syncing') {
    app.notify('正在同步中，请稍候…', 'info', 1800);
    return;
  }
  if (!settingsStore.storageConfigured) {
    app.notify('尚未配置对象存储，已为你打开设置中的「对象存储」', 'info', 3200);
    openSettings('storage');
    return;
  }
  await app.syncNow();
}

/**
 * 传给编辑器的实际字号（1.1.7 修复：缩放不生效）。
 *
 * 根因：`settings.ts` 的 `applyTheme()` 已经把 `--content-font-size` 按 zoom 换算好
 * 写在 `<html>` 上（100% → 16px、125% → 20px），但 `WysiwygEditor.vue` 在它自己的
 * 根元素上又内联写了一次 `--content-font-size`，值是未经缩放的原始 `appearance.fontSize`。
 * 内联变量作用域更近，直接把 html 上那份**遮蔽**了 —— 所以状态栏百分比在变、
 * 正文却始终 16px。`SourceEditor` / `CompareView` 同理（CodeMirror 的 theme.fontSize
 * 直接取 props.fontSize）。
 *
 * 修法：在调用处就把 zoom 乘进去。这样三处编辑器拿到的都是「已经缩放过的最终字号」，
 * 无需改动它们各自的内联变量逻辑，也不影响 `--content-zoom` 供代码块等样式使用。
 *
 * 保留 2 位小数，避免 20.8 这类值被浮点误差截断成 20.79。
 */
const effectiveFontSize = computed(() => {
  const base = settingsStore.settings.appearance.fontSize || 16;
  return Math.round(base * (app.zoom / 100) * 100) / 100;
});

function toggleAutosave(): void {
  const cur = settingsStore.settings.autosave ?? { enabled: true, versionMinutes: 5, versionChars: 300 };
  const next = !cur.enabled;
  settingsStore.update({ autosave: { ...cur, enabled: next } });
  app.notify(next ? '已开启自动保存' : '已关闭自动保存', 'info', 1800);
}

/**
 * 正文第一行（标题行）提交改名。
 *
 * 链路：`DocTitleLine` 只 emit 新标题 → 这里拼成新路径 → `app.renameDoc()`（store 已公开）
 * → `vault.rename()` 落盘 + 重写全库 wikilink + `refreshDocs()` + `syncTabsWithVault()`。
 * 因此标签页标题、左侧文件列表、vault 内 path 会一起更新（用户需求 A 的「同步重命名」）。
 *
 * 注意：**不改动文档内容**。标题行是独立 UI，不写进 markdown，
 * 所以内容 hash / 同步去重 / 历史版本 / 导出均不受影响。
 */
function renameDocByTab(tab: { docId: string; title: string; path: string } | null | undefined, nextTitle: string): void {
  if (!tab) return;
  const clean = nextTitle.trim();
  if (!clean || clean === tab.title) return;
  // 保留原目录，只换文件名；扩展名沿用原文件的（.md / .mind / .flow …）
  const rawPath = tab.path || '';
  const parts = rawPath.split('/');
  parts.pop();
  const folder = parts.join('/');
  const extMatch = /\.([A-Za-z0-9]+)$/.exec(rawPath.split('/').pop() ?? '');
  const ext = extMatch ? extMatch[0] : '.md';
  const nextPath = folder ? `${folder}/${clean}${ext}` : `${clean}${ext}`;
  void app.renameDoc(tab.docId, nextPath);
}

function renameActiveDoc(nextTitle: string): void {
  renameDocByTab(activeTab.value, nextTitle);
}

function renameSplitDoc(nextTitle: string): void {
  renameDocByTab(splitTab.value, nextTitle);
}

/** 打开重命名弹窗（仅修改文件名，支持添加日期、时间与 AI 智能命名） */
function promptRename(docId?: string): void {
  const targetId = docId || activeTab.value?.docId || '';
  const meta = app.docs.find((d) => d.docId === targetId);
  const tab = app.tabs.find((t) => t.docId === targetId);
  const rawPath = tab?.path || meta?.path || '';
  if (!targetId || !rawPath) return;
  const parts = rawPath.replace(/\.md$/i, '').split('/');
  const baseName = parts.pop() || '无标题';
  const folder = parts.join('/');
  renameModal.value = {
    open: true,
    docId: targetId,
    folder,
    name: baseName,
    aiLoading: false,
  };
}

function renameAddDatePrefix(): void {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const prefix = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-`;
  const clean = renameModal.value.name.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  renameModal.value.name = `${prefix}${clean}`;
}

function renameAddDatetimeSuffix(): void {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const suffix = `-${String(d.getFullYear()).slice(2)}年${pad(d.getMonth() + 1)}月${pad(d.getDate())}日${pad(d.getHours())}${pad(d.getMinutes())}`;
  renameModal.value.name = `${renameModal.value.name}${suffix}`;
}

async function renameWithAi(): Promise<void> {
  if (!settingsStore.aiConfigured) {
    app.notify('请先配置 AI 服务或开启平台积分 AI', 'error');
    return;
  }
  renameModal.value.aiLoading = true;
  try {
    const docId = renameModal.value.docId;
    const tab = app.tabs.find((t) => t.docId === docId);
    const body = tab ? tab.content : (await app.vault?.read(docId)) || '';
    const aiCfg = settingsStore.settings.ai;
    const client = new AIClient({
      ...aiCfg,
      usePlatform: Boolean(aiCfg.usePlatform || aiCfg.provider === 'platform'),
      apiKey: aiCfg.usePlatform || aiCfg.provider === 'platform' ? 'platform' : aiCfg.apiKey,
    });
    const suggested = await generateTitle(client, body, settingsStore.settings.naming.aiPrompt);
    if (suggested) renameModal.value.name = suggested;
  } catch (e) {
    app.notify(`AI 命名失败：${(e as Error).message}`, 'error');
  } finally {
    renameModal.value.aiLoading = false;
  }
}

async function confirmRenameModal(): Promise<void> {
  const { docId, folder, name } = renameModal.value;
  const cleanName = name.trim().replace(/[\\/:*?"<>|]/g, '-');
  if (!docId || !cleanName) return;
  renameModal.value.open = false;
  const nextPath = folder ? `${folder}/${cleanName}.md` : `${cleanName}.md`;
  await app.renameDoc(docId, nextPath);
}

/** 打开移动目录弹窗（与重命名独立分离） */
function promptMovePath(docId?: string): void {
  const targetId = docId || activeTab.value?.docId || '';
  const meta = app.docs.find((d) => d.docId === targetId);
  if (!targetId || !meta) return;
  const parts = meta.path.split('/');
  parts.pop();
  const curFolder = parts.join('/');
  moveModal.value = {
    open: true,
    docId: targetId,
    currentFolder: curFolder,
    targetFolder: curFolder,
  };
}

const availableFolders = computed(() => {
  const set = new Set<string>(['']);
  for (const f of app.customFolders) if (f) set.add(f);
  for (const d of app.docs) {
    const segs = d.path.split('/');
    segs.pop();
    if (segs.length) set.add(segs.join('/'));
  }
  return [...set];
});

async function confirmMoveModal(): Promise<void> {
  const { docId, targetFolder } = moveModal.value;
  if (!docId) return;
  moveModal.value.open = false;
  await app.moveDocToFolder(docId, targetFolder);
}

/** 在系统文件夹中定位显示当前文档 */
async function showDocInFolder(docId?: string): Promise<void> {
  const targetId = docId || activeTab.value?.docId || '';
  const meta = app.docs.find((d) => d.docId === targetId);
  const relPath = meta?.path || activeTab.value?.path || '';
  const bridge = getBridge();
  if (runtime.platform === 'desktop' && bridge?.shell?.showItemInFolder && app.vaultLocation) {
    const base = app.vaultLocation.replace(/[\\/]+$/, '');
    const sep = base.includes('\\') ? '\\' : '/';
    const full = relPath ? `${base}${sep}${relPath.split('/').join(sep)}` : base;
    await bridge.shell.showItemInFolder(full);
    app.notify(`已在文件夹中打开：${full}`, 'info', 2200);
    return;
  }
  if (relPath) {
    void navigator.clipboard?.writeText(relPath);
    app.notify(`当前为云端/网页仓库，已复制文件路径：${relPath}`, 'info', 2400);
  }
}

function copyNumberStat(val: number, label: string): void {
  void navigator.clipboard?.writeText(String(val));
  app.notify(`已复制${label}：${val}`, 'success', 1600);
}

async function deleteDoc(docId: string): Promise<void> {
  const doc = app.docs.find((d) => d.docId === docId);
  if (!doc) return;
  const ok = window.confirm(`删除「${doc.title}」？该操作不可撤销。`);
  if (!ok) return;
  await app.deleteDoc(docId);
}

function closeTab(id: string): void {
  const tab = app.tabs.find((t) => t.id === id);
  if (tab) {
    /**
     * 只有**真实文档**标签才进「最近关闭」列表。
     *
     * 1.1.9 修：原来只特判了 SETTINGS_TAB_ID，漏了 PLUGIN_TAB_ID。
     * 于是关掉插件商店后它被塞进 recentClosed，用户 `Ctrl+Shift+T`（重开标签）
     * 会恢复出一个 docId 为 `__plugins__`、内容为空的假文档标签，看起来像文档丢了。
     */
    const isVirtual = id === SETTINGS_TAB_ID || id === PLUGIN_TAB_ID;
    if (!isVirtual) recentClosed.value.push({ docId: tab.docId, mode: tab.mode });
  }
  if (recentClosed.value.length > 20) recentClosed.value.shift();
  if (id === SETTINGS_TAB_ID) {
    closeSettingsTab();
    return;
  }
  if (id === PLUGIN_TAB_ID) {
    closePluginStoreTab();
    return;
  }
  app.closeTab(id);
}

function onTabAction({ id, action }: { id: string; action: string }): void {
  const tab = app.tabs.find((t) => t.id === id);
  if (!tab) return;
  switch (action) {
    case 'close':
      closeTab(id);
      break;
    case 'lock':
      tab.locked = !tab.locked;
      tab.mode = tab.locked ? 'read' : 'wysiwyg';
      break;
    case 'source':
      tab.mode = 'source';
      break;
    case 'find':
      app.activeTabId = id;
      findBarOpen.value = true;
      findBarReplaceMode.value = false;
      break;
    case 'replace':
      app.activeTabId = id;
      findBarOpen.value = true;
      findBarReplaceMode.value = true;
      break;
    case 'rename':
      void promptRename(tab.docId);
      break;
    case 'copy-path':
      void navigator.clipboard?.writeText(tab.path);
      app.notify('已复制路径', 'success', 1500);
      break;
    case 'close-all':
      app.tabs.slice().forEach((t) => closeTab(t.id));
      break;
    case 'close-others':
      app.tabs.filter((t) => t.id !== id).forEach((t) => closeTab(t.id));
      break;
    case 'close-right': {
      const idx = app.tabs.findIndex((t) => t.id === id);
      app.tabs.slice(idx + 1).forEach((t) => closeTab(t.id));
      break;
    }
    case 'split-v':
      void splitTabIntoPane(id, 'v');
      break;
    case 'split-h':
      void splitTabIntoPane(id, 'h');
      break;
    case 'window':
      void moveTabToNewWindow(tab);
      break;
    default:
      break;
  }
}

/**
 * 把标签移动到新窗口（1.1.7 修复「移动至新窗口」不可用）。
 *
 * 原实现的 bug：`window.open(window.location.href, '_blank', ...)`。
 * 桌面端主进程的 `setWindowOpenHandler` 对非 http(s) 地址一律 `{ action: 'deny' }`
 * —— 而本应用跑在自定义协议 `neomd://` 下，于是这次 window.open **被直接拒绝**，
 * 表现为"点了没反应"。网页端虽然能开，但开出来的是空白新窗口、不带任何文档。
 *
 * 正确做法：走主进程新增的 `window:newWindow` IPC，由 Electron 自己开窗口，
 * 并把 docId 拼进 URL 交给新窗口（新窗口启动后自动打开这篇文档）。
 * 网页端没有该能力，退化为在浏览器新标签打开同一路由，并给出提示。
 */
/** 新建一个独立的应用窗口（Ctrl+Shift+N / 命令面板调用） */
async function openNewAppWindow(docId?: string): Promise<void> {
  const bridge = getBridge() as unknown as
    | { win?: { newWindow?: (docId?: string) => Promise<number> } }
    | undefined;
  const openNewWindow = bridge?.win?.newWindow;
  if (typeof openNewWindow === 'function') {
    try {
      await openNewWindow(docId);
      app.notify('已打开新的程序窗口', 'success', 2000);
    } catch (e) {
      app.notify(`打开新窗口失败：${(e as Error).message}`, 'error', 3200);
    }
    return;
  }
  const url = new URL(window.location.href);
  if (docId) url.searchParams.set('doc', docId);
  else url.searchParams.delete('doc');
  window.open(url.toString(), '_blank', 'noopener');
  app.notify('已在浏览器新标签页打开工作台', 'info', 2400);
}

async function moveTabToNewWindow(tab: { id: string; docId: string; title: string }): Promise<void> {
  // 设置 / 插件商店这类虚拟标签没有真实文档，移过去没有意义
  if (tab.id === SETTINGS_TAB_ID || tab.id === PLUGIN_TAB_ID) {
    app.notify('这个标签不是文档，无法移动到新窗口', 'info', 2200);
    return;
  }
  const bridge = getBridge() as unknown as
    | { win?: { newWindow?: (docId?: string) => Promise<number> } }
    | undefined;
  const openNewWindow = bridge?.win?.newWindow;
  if (typeof openNewWindow === 'function') {
    try {
      await saveTabIfDirty(tab.id);
      await openNewWindow(tab.docId);
      /**
       * 无条件关掉原标签（1.1.9 修「移动变成复制」）。
       *
       * 改前是 `if (app.tabs.length > 1) app.closeTab(...)`，本意是「别让原窗口变成空壳」，
       * 但结果是：只有 1 个标签时点「移动至新窗口」，新窗口开出来了、原窗口那篇还留着
       * —— 用户看到的是复制，不是移动。「移动」的语义就是从这个窗口消失；
       * 原窗口剩 0 个标签时显示空状态引导（新建 / 从左侧选），比「悄悄不移动」更符合预期。
       */
      app.closeTab(tab.id, true);
      app.notify(`已移动到新的窗口打开「${tab.title}」`, 'success', 2400);
    } catch (e) {
      app.notify(`打开新窗口失败：${(e as Error).message}`, 'error', 3200);
    }
    return;
  }
  // 网页端：新标签打开并带上 doc 参数；fresh=1 让新窗口**不恢复**旧标签列表，
  // 否则新页面会把原窗口的全部标签克隆一份（用户看到的是「移动」变成「整组复制」）。
  await saveTabIfDirty(tab.id);
  const url = new URL(window.location.href);
  url.searchParams.set('doc', tab.docId);
  url.searchParams.set('fresh', '1');
  window.open(url.toString(), '_blank', 'noopener');
  app.closeTab(tab.id, true);
  app.notify(`已在新窗口/标签页中移动「${tab.title}」`, 'success', 2600);
}

/**
 * 保存指定标签（若脏）。
 *
 * 供「移动到新窗口」「单文档模式下切换文件」等场景使用：
 * 用户要求「文件时修改即保存，不要询问用户是否保存」，
 * 因此这里静默保存、绝不弹 confirm；保存失败只给一条提示。
 *
 * @returns 是否成功（没有该标签时返回 true，视为无需处理）
 */
async function saveTabIfDirty(tabId: string): Promise<boolean> {
  const tab = app.tabs.find((t) => t.id === tabId);
  if (!tab) return true;
  if (!tab.dirty) return true;
  // saveActiveTab 只作用于活动标签，这里临时切过去再切回来
  const prev = app.activeTabId;
  app.activeTabId = tab.id;
  try {
    await app.saveActiveTab({ auto: true });
    return true;
  } catch (e) {
    app.notify(`保存失败：${(e as Error).message}`, 'error', 3600);
    return false;
  } finally {
    // 只有原来那个标签还在时才切回，避免切到一个已关闭的 id
    if (app.tabs.some((t) => t.id === prev)) app.activeTabId = prev;
  }
}

function doFindNext(): void {
  const q = findText.value;
  if (!q || !activeTab.value) return;
  const win = window as unknown as { find?: (s: string) => boolean };
  if (typeof win.find === 'function') {
    win.find(q);
  }
}

function doReplaceOne(): void {
  const q = findText.value;
  const tab = activeTab.value;
  if (!q || !tab) return;
  const idx = tab.content.indexOf(q);
  if (idx === -1) {
    app.notify('未找到匹配内容', 'info', 1600);
    return;
  }
  const next = tab.content.slice(0, idx) + replaceText.value + tab.content.slice(idx + q.length);
  app.updateTabContent(tab.id, next);
  app.notify('已替换 1 处', 'success', 1400);
}

function doReplaceAll(): void {
  const q = findText.value;
  const tab = activeTab.value;
  if (!q || !tab) return;
  const parts = tab.content.split(q);
  if (parts.length <= 1) {
    app.notify('未找到匹配内容', 'info', 1600);
    return;
  }
  app.updateTabContent(tab.id, parts.join(replaceText.value));
  app.notify(`已替换 ${parts.length - 1} 处`, 'success', 1600);
}

async function promptCreateFolder(): Promise<void> {
  const name = await app.askInput('新建子文件夹', '输入子文件夹名称（支持多级如 项目/设计）', '例如：项目笔记', '');
  if (!name || !name.trim()) return;
  app.createFolder(name.trim());
}

async function promptCreateVault(): Promise<void> {
  const name = await app.askInput('新建仓库', '输入新仓库名称', '例如：知识库', '');
  if (!name || !name.trim()) return;
  await app.createAndSwitchVault(name.trim());
}

function jumpToHeading(offset: number): void {
  const tab = activeTab.value;
  if (!tab) return;
  const needle = tab.content.slice(offset, offset + 30).split('\n')[0] ?? '';
  const el = document.querySelector('.ProseMirror');
  if (el && needle) {
    const node = Array.from(el.querySelectorAll('h1,h2,h3,h4,h5,h6')).find((h) => (h.textContent ?? '').includes(needle));
    node?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const cm = document.querySelector('.cm-scroller');
  if (cm) cm.scrollTop = offset * 0.9;
}

/**
 * 按标题文本跳转（右侧栏大纲点击时使用）。
 * 与 `jumpToHeading(offset)` 的区别：这里拿到的是文本而不是字符偏移，
 * 因此直接在 DOM 里按文本匹配标题节点。
 */
function jumpToHeadingText(text: string): void {
  const needle = String(text ?? '').trim();
  if (!needle) return;
  const el = document.querySelector('.ProseMirror');
  if (el) {
    const node = Array.from(el.querySelectorAll('h1,h2,h3,h4,h5,h6')).find(
      (h) => (h.textContent ?? '').trim() === needle || (h.textContent ?? '').includes(needle),
    );
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
  }
  // 源码/对照模式下按行查找
  const tab = activeTab.value;
  if (tab) {
    const idx = tab.content.indexOf(needle);
    const cm = document.querySelector('.cm-scroller');
    if (cm && idx >= 0) cm.scrollTop = idx * 0.9;
  }
}

/**
 * 打开（或创建）某一天的日记。
 *
 * 命名约定（1.1.7 用户明确要求）：文件名是 `YYYY-MM-DD 日记`（例 `2026-10-27 日记`），
 * 且该文档正文第一行（标题行）也是同一个字符串 —— 两者由同一份 `title` 驱动：
 *   - 文件名来自 `createDoc({ title })` / `vault.rename()`；
 *   - 第一行来自编辑器顶部的 `DocTitleLine`（绑定 `activeTab.title`）。
 * 所以这里**不在正文里再写一遍 `# 标题`**，否则标题行与 H1 会重复显示。
 *
 * 去重：已存在当日日记（含 1.1.7 之前的旧格式 `YYYY-MM-DD`）时直接打开，不重复创建。
 *
 * @param date 可选 ISO 日期（`YYYY-MM-DD`）；不传则用今天。右侧栏日历点击某天时传入。
 */
function openDaily(date?: string): void {
  const title = buildDiaryName(date);
  // 兼容旧格式：同一天的 `YYYY-MM-DD` 也视为已存在，避免升级后出现两篇同日日记
  const existing = app.docs.find((d) => isDiaryTitle(d.title, date));
  if (existing) {
    void app.openDoc(existing.docId);
    return;
  }
  void app.createDoc({
    title,
    folder: '日记',
    content: '## 今天做了什么\n\n- \n\n## 明日计划\n\n- \n',
  });
}

function openRandom(): void {
  if (!app.docs.length) return;
  const pick = app.docs[Math.floor(Math.random() * app.docs.length)]!;
  void app.openDoc(pick.docId);
}

function toggleAi(): void {
  if (touch) mobileAi.value = !mobileAi.value;
  else settingsStore.updateLayout({ rightPanelOpen: !layout.value.rightPanelOpen });
}

function onFileOp(op: string): void {
  const tab = activeTab.value;
  if (!tab) return;
  switch (op) {
    case 'save':
      void saveAndSync();
      break;
    case 'rename':
      promptRename(tab.docId);
      break;
    case 'move-path':
      promptMovePath(tab.docId);
      break;
    case 'duplicate': {
      void app.createDoc({
        title: `${tab.title}-副本`,
        content: tab.content,
      });
      break;
    }
    case 'insert-toc': {
      const hs = parseDoc(tab.content).headings;
      if (!hs.length) {
        app.notify('当前文档没有标题，无法生成目录', 'info');
        break;
      }
      const tocLines = ['## 目录', ...hs.map((h) => `${'  '.repeat(Math.max(0, h.level - 1))}- ${h.text}`), '', '---', ''];
      app.updateTabContent(tab.id, `${tocLines.join('\n')}\n${tab.content}`);
      app.notify('已在文档顶部生成目录', 'success');
      break;
    }
    case 'insert-frontmatter': {
      if (tab.content.trimStart().startsWith('---')) {
        app.notify('文档已包含 Frontmatter 属性头', 'info');
        break;
      }
      const dateStr = new Date().toISOString().slice(0, 10);
      const fm = `---\ntitle: ${tab.title}\ndate: ${dateStr}\ntags:\n  - 笔记\n---\n\n`;
      app.updateTabContent(tab.id, `${fm}${tab.content}`);
      app.notify('已插入 YAML Frontmatter', 'success');
      break;
    }
    case 'clean-blank': {
      const cleaned = tab.content
        .split(/\r?\n/)
        .map((l) => l.replace(/[ \t]+$/, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n');
      app.updateTabContent(tab.id, cleaned);
      app.notify('已清理多余空行与行尾空格', 'success');
      break;
    }
    case 'copy-md':
      void navigator.clipboard?.writeText(tab.content);
      app.notify('已复制全文 Markdown 源码', 'success');
      break;
    case 'show-in-folder':
      void showDocInFolder(tab.docId);
      break;
    case 'history':
      historyOpen.value = true;
      break;
    case 'share':
      shareOpen.value = true;
      break;
    case 'export':
      exportOpen.value = true;
      break;
    case 'delete':
      void deleteDoc(tab.docId);
      break;
    default:
      break;
  }
}

function onPanelAction(id: string): void {
  switch (id) {
    case 'daily':
    case 'daily-notes':
      openDaily();
      break;
    case 'random':
    case 'random-note':
      openRandom();
      break;
    case 'file-recovery':
      historyOpen.value = true;
      break;
    case 'tag-list':
    case 'tags':
      settingsStore.updateLayout({ leftPanelOpen: true, leftPanelMode: 'search' });
      searchQuery.value = '#';
      break;
    case 'width':
      cycleWidth();
      break;
    case 'history':
      historyOpen.value = true;
      break;
    case 'search':
      searchOpen.value = true;
      break;
    case 'command':
      paletteOpen.value = true;
      break;
    case 'save':
      void saveAndSync();
      break;
    case 'sync':
      app.syncNow();
      break;
    case 'plugin-center':
      openPluginStore();
      break;
    case 'new-flowchart':
    case 'diagram-flowchart':
      void createDiagram('flowchart');
      break;
    case 'new-mindmap':
    case 'diagram-mindmap':
      void createDiagram('mindmap');
      break;
    default:
      app.notify(`已触发插件：${PLUGIN_RIBBON_DEFS[id]?.title ?? id}`, 'info', 1800);
      break;
  }
}

/* ---------------- 导出 ---------------- */

async function doExport(): Promise<void> {
  const tab = activeTab.value;
  if (!tab) return;
  exportBusy.value = true;
  try {
    const html = buildExportHtml(tab.content, { title: tab.title, toc: true, theme: 'light' });
    if (exportFormat.value === 'html') {
      downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${tab.title}.html`);
    } else if (exportFormat.value === 'pdf') {
      const bridge = getBridge() as unknown as { printToPdf?: (h: string, t: string) => Promise<string> } | undefined;
      if (bridge?.printToPdf) await bridge.printToPdf(html, tab.title);
      else {
        const w = window.open('', '_blank');
        if (w) {
          w.document.write(html);
          w.document.close();
          setTimeout(() => w.print(), 400);
        }
      }
    } else {
      await exportDocx(tab.title, tab.content);
    }
    exportOpen.value = false;
    app.notify('导出已完成', 'success');
  } catch (e) {
    app.notify(`导出失败：${(e as Error).message}`, 'error');
  } finally {
    exportBusy.value = false;
  }
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function exportDocx(title: string, source: string): Promise<void> {
  const blocks = splitForDocx(source);
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const para = (text: string, style = '', bold = false): string =>
    `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}</w:pPr><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  const parts: string[] = [para(title, 'Title', true)];
  for (const b of blocks) {
    if (b.type === 'heading') parts.push(para(b.text, `Heading${Math.min(6, b.level)}`, true));
    else if (b.type === 'paragraph') parts.push(para(b.text));
    else if (b.type === 'quote') parts.push(para(b.text, 'Quote'));
    else if (b.type === 'code') parts.push(para(b.text, 'Code'));
    else if (b.type === 'hr') parts.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:color="CCCCCC"/></w:pBdr></w:pPr></w:p>');
    else if (b.type === 'list') b.items.forEach((it) => parts.push(para(`• ${it}`, 'ListParagraph')));
    else if (b.type === 'table') {
      const rows = b.rows.map((r) => `<w:tr>${r.map((c) => `<w:tc><w:p><w:r><w:t xml:space="preserve">${esc(c)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('');
      parts.push(`<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="E3E6EA"/><w:left w:val="single" w:sz="4" w:color="E3E6EA"/><w:bottom w:val="single" w:sz="4" w:color="E3E6EA"/><w:right w:val="single" w:sz="4" w:color="E3E6EA"/><w:insideH w:val="single" w:sz="4" w:color="E3E6EA"/><w:insideV w:val="single" w:sz="4" w:color="E3E6EA"/></w:tblBorders></w:tblPr>${rows}</w:tbl><w:p/>`);
    }
  }
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${parts.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:sz w:val="48"/><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:rPr><w:sz w:val="40"/><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:rPr><w:sz w:val="32"/><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:rPr><w:sz w:val="28"/><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:rPr><w:i/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:rPr><w:rFonts w:ascii="Consolas"/><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:pPr><w:ind w:left="420"/></w:pPr></w:style></w:styles>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const files: Array<[string, string]> = [
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rels],
    ['word/document.xml', documentXml],
    ['word/styles.xml', stylesXml],
    ['word/_rels/document.xml.rels', docRels],
  ];
  const zip = await buildStoreZip(files);
  // Uint8Array 在新版 TS DOM 类型里是 Uint8Array<ArrayBufferLike>，不能直接当 BlobPart；
  // 复制一份到独立的 ArrayBuffer 上，保证类型与运行时都正确。
  const docxBytes = new Uint8Array(zip.byteLength);
  docxBytes.set(zip);
  downloadBlob(
    new Blob([docxBytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    `${title}.docx`,
  );
}

async function buildStoreZip(files: Array<[string, string]>): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (d: Uint8Array): number => {
    let c = 0xffffffff;
    for (const b of d) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  for (const [name, content] of files) {
    const nb = enc.encode(name);
    const data = enc.encode(content);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nb.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nb.length, true);
    local.set(nb, 30);
    chunks.push(local, data);
    const cd = new Uint8Array(46 + nb.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nb.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nb, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const total = chunks.reduce((s, c) => s + c.length, 0) + centralSize + end.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  for (const c of central) {
    out.set(c, p);
    p += c.length;
  }
  out.set(end, p);
  return out;
}

/* ---------------- 自动保存 ---------------- */

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleAutosave(): void {
  if (!autosaveEnabled.value) return;
  const tab = activeTab.value;
  if (!tab || !tab.dirty) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    autosaveTimer = null;
    const cur = app.tabs.find((t) => t.id === tab.id);
    if (!cur || !cur.dirty) return;
    await app.saveActiveTab({ auto: true });
  }, 1500);
}

function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (!app.isDirty) return;
  void app.saveActiveTab();
  e.preventDefault();
  e.returnValue = '';
}

/* ---------------- 生命周期 ---------------- */

function onResize(): void {
  narrow.value = window.innerWidth < 900;
}

/**
 * Ctrl + 滚轮缩放正文。
 *
 * 只接管「正文区域内 + 按住 Ctrl/Cmd」的滚轮；其余滚轮行为（普通滚动、
 * 源码编辑器内部滚动）完全不受影响。每格 5%，范围 50-300。
 * 必须 `passive: false` 才能 preventDefault 掉浏览器自带的整页缩放。
 */
function onWheelZoom(e: WheelEvent): void {
  if (!(e.ctrlKey || e.metaKey)) return;
  const target = e.target as HTMLElement | null;
  const inContent = target?.closest('.shell__content');
  if (!inContent) return;
  e.preventDefault();
  // deltaY < 0 上滚 → 放大
  app.zoomBy(e.deltaY < 0 ? 1 : -1);
  closeZoomMenu();
}

function closeZoomMenu(): void {
  zoomMenuOpen.value = false;
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('resize', onResize);
  window.addEventListener('mousedown', closeEditorMenu);
  window.addEventListener('mousedown', closeZoomMenu);
  window.addEventListener('wheel', onWheelZoom, { passive: false });
  onResize();

  /**
   * 首帧就放开外壳（1.1.9）。
   *
   * `shellReady` 必须在 `await boot()` **之前**置 true，否则外壳会跟着异步启动流程一起等，
   * 「先渲染真实外壳」就完全失效了。放在 nextTick 后置位可以保证这一帧的 DOM 已经提交，
   * 用户看到的是「界面已经在、正文在填充」，而不是「全屏转圈」。
   */
  void nextTick(() => {
    shellReady.value = true;
  });

  await boot();
  // 监听桌面端文件关联打开事件
  const bridge = getBridge() as unknown as
    | { app?: { onOpenFile?: (cb: (filePath: string) => void) => void } }
    | undefined;
  bridge?.app?.onOpenFile?.((filePath: string) => {
    const fileName = filePath.split(/[\\/]/).pop() ?? '';
    const hit = app.docs.find((d) => d.path === fileName || d.path.endsWith(`/${fileName}`));
    if (hit) void app.openDoc(hit.docId);
  });
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('beforeunload', onBeforeUnload);
  window.removeEventListener('resize', onResize);
  window.removeEventListener('mousedown', closeEditorMenu);
  window.removeEventListener('mousedown', closeZoomMenu);
  window.removeEventListener('wheel', onWheelZoom);
  if (autosaveTimer) clearTimeout(autosaveTimer);
});

watch(
  () => activeTab.value?.content,
  (v) => {
    if (v) {
      const text = markdownToPlainText(v, 100000);
      const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
      const latin = (text.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9_-]+/g) ?? []).length;
      wordCount.value = { words: cjk + latin, chars: text.length };
    }
    scheduleAutosave();
  },
);

const readingMinutes = computed(() => Math.max(1, Math.round(wordCount.value.words / 300)));

/**
 * 打开设置。
 *
 * 1.0.2 起设置不再是弹窗，而是编辑器内的一个**标签页**（与文档标签并列）。
 * 实现上用一个虚拟 tab id `__settings__` 标记，TabBar 里显示为「设置」，
 * 内容区渲染 `SettingsPage`。`tab` 参数决定打开后停在哪个页签。
 */
const SETTINGS_TAB_ID = '__settings__';
const PLUGIN_TAB_ID = '__plugins__';

/**
 * 打开插件商店（1.0.2：功能区入口 → 编辑器内新开标签页，而不是弹窗）。
 * 标签内容是 `<PluginCenter embedded />`，可直接在里面切换插件开关与浏览市场。
 */
function openPluginStore(): void {
  const exists = app.tabs.some((t) => t.id === PLUGIN_TAB_ID);
  if (!exists) {
    app.tabs.push({
      id: PLUGIN_TAB_ID,
      docId: PLUGIN_TAB_ID,
      title: '插件商店',
      path: '',
      dirty: false,
      locked: true,
      mode: 'wysiwyg',
      pageWidth: pageWidth.value,
      scrollTop: 0,
      cursor: 0,
      content: '',
    });
  }
  app.activeTabId = PLUGIN_TAB_ID;
}

/** 关闭插件商店标签页 */
function closePluginStoreTab(): void {
  const idx = app.tabs.findIndex((t) => t.id === PLUGIN_TAB_ID);
  if (idx >= 0) app.tabs.splice(idx, 1);
  if (app.activeTabId === PLUGIN_TAB_ID) {
    const next = app.tabs[Math.max(0, idx - 1)] ?? app.tabs[0];
    app.activeTabId = next?.id ?? '';
  }
}

/* ---------------- 功能区右键菜单（1.0.2） ---------------- */

/** 功能区全部可选按钮（用于右键「添加功能按钮」列表） */
const RIBBON_ALL_ITEMS: RibbonItemDef[] = [
  { id: 'daily-notes', label: '今日日记', icon: 'calendar' },
  { id: 'random-note', label: '漫游笔记', icon: 'dice' },
  { id: 'graph', label: '关系图谱', icon: 'graph' },
  { id: 'tag-list', label: '标签列表', icon: 'tag' },
  { id: 'bookmarks', label: '书签', icon: 'bookmark' },
  { id: 'file-recovery', label: '文件恢复', icon: 'history' },
  { id: 'whiteboard', label: '白板', icon: 'layers' },
  { id: 'slides', label: '幻灯片', icon: 'columns' },
  { id: 'database', label: '数据库', icon: 'table' },
  { id: 'web-browser', label: '内嵌浏览器', icon: 'globe' },
  { id: 'recorder', label: '语音录音', icon: 'mic' },
  { id: 'diagram-flowchart', label: '流程图', icon: 'columns' },
  { id: 'diagram-mindmap', label: '思维导图', icon: 'graph' },
];

const ribbonMenu = ref<{ open: boolean; x: number; y: number; targetId?: string; targetLabel?: string }>({
  open: false,
  x: 0,
  y: 0,
});

/** 在功能区按钮上右键 */
function openRibbonMenu(e: MouseEvent, id?: string, label?: string): void {
  e.preventDefault();
  e.stopPropagation();
  ribbonMenu.value = { open: true, x: e.clientX, y: e.clientY, targetId: id, targetLabel: label };
}

function closeRibbonMenu(): void {
  ribbonMenu.value = { ...ribbonMenu.value, open: false };
}

/** 隐藏某个功能区按钮（从 ribbonItems 移除） */
function ribbonHide(id: string): void {
  const next = (layout.value.ribbonItems ?? []).filter((x) => x !== id);
  settingsStore.updateLayout({ ribbonItems: next });
  closeRibbonMenu();
}

/** 上下移动功能区按钮顺序 */
function ribbonMove(id: string, dir: 'up' | 'down'): void {
  const list = [...(layout.value.ribbonItems ?? [])];
  const i = list.indexOf(id);
  if (i < 0) return;
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j]!, list[i]!];
  settingsStore.updateLayout({ ribbonItems: list });
  closeRibbonMenu();
}

/** 添加 / 移除某个按钮 */
function ribbonToggle(id: string): void {
  const list = [...(layout.value.ribbonItems ?? [])];
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
  else list.push(id);
  settingsStore.updateLayout({ ribbonItems: list });
  closeRibbonMenu();
}

/* ---------------- 本地窗口布局（侧栏宽度，1.0.2） ---------------- */

/**
 * 左右侧栏宽度存 localStorage（`neomd.localLayout`），**不进云同步**。
 * 用户明确要求：这类尺寸只对当前设备的当前窗口有意义。
 *
 * 1.1.7 起这里还承载：分屏方向 / 分屏比例 / 打开新文件的行为（openMode）。
 */
const {
  layout: localLayout,
  update: updateLocalLayout,
  bounds: layoutBounds,
  defaults: layoutDefaults,
} = useLocalLayout();

/* ---------------- 分屏（1.1.7）：状态持久化到本机 localStorage ---------------- */

/**
 * 分屏方向与比例都放 `localLayout`（localStorage），理由同侧栏宽度：
 * 这是"这台设备的这个窗口"的视图偏好，换设备没有参考价值，不该进云同步。
 *
 * `splitDirection` 原本是本文件的局部 ref（不持久化），现在改成读写 localLayout 的计算属性，
 * 保持所有既有调用点（右键菜单、分屏关闭按钮）不变，但重启后能恢复上次的分屏布局。
 */
const splitDirection = computed<'none' | 'v' | 'h'>({
  get: () => localLayout.value.splitDirection,
  set: (v) => updateLocalLayout({ splitDirection: v }),
});

/**
 * 源码 / 对照模式标题行的左内边距（1.1.9 动态化）。
 *
 * 这两个模式的正文由 CodeMirror 渲染：`.cm-content` 左右各 32px、`.cm-line` 再各 4px，
 * 左侧还有行号 gutter（`padding-left: 12px` + 行号自身宽度）。
 * 于是标题行要跟正文左缘对齐，左内边距必须随「行号开/关」变化：
 * - 开行号：gutter 约 46px 才对齐（12 padding + 行号数字 + 间隙）；
 * - 关行号：gutter 消失，只剩 32px 的 `.cm-content` 内边距。
 *
 * 改前这里写死 46 —— 关掉行号后标题行会比正文右移 14px，看起来像「多缩进了一格」。
 */
const sourceTitlePadLeft = computed(() => (settingsStore.settings.appearance.showLineNumbers ? 46 : 32));

/** 当前聚焦的分屏窗格（'primary' 主栏 | 'split' 第二栏），用于让左栏点文件或工具栏命令作用于当前聚焦栏 */
const activePane = ref<'primary' | 'split'>('primary');

/**
 * 分屏第二栏显示的标签 id（1.1.8 持久化）。
 * 空串 = 未指定，由 `splitTab` 回落到当前活动标签。
 */
const splitTabId = computed<string>({
  get: () => localLayout.value.splitTabId,
  set: (v) => updateLocalLayout({ splitTabId: v }),
});

/** 分屏第二栏的标签选择器数据（虚拟标签不可在窄栏渲染，已排除） */
const splitSelectableTabs = computed(() =>
  tabBarTabs.value.filter((t) => t.id !== SETTINGS_TAB_ID && t.id !== PLUGIN_TAB_ID),
);

/** 仓库中尚未在标签栏打开的其它文档（供分屏第二栏下拉菜单直接点选打开不同文件） */
const splitUnopenedDocs = computed(() => {
  const openedDocIds = new Set(app.tabs.map((t) => t.docId));
  return app.docs.filter((d) => !openedDocIds.has(d.docId));
});

/** 切换分屏第二栏显示的标签（1.1.8 真分屏） */
function chooseSplitTab(id: string): void {
  splitTabId.value = id;
  activePane.value = 'split';
  splitPickerOpen.value = false;
}

/** 在分屏第二栏直接选择打开仓库内任意文档（无需先用 + 号新建标签） */
async function chooseSplitDoc(docId: string): Promise<void> {
  splitPickerOpen.value = false;
  const prevActive = app.activeTabId;
  await app.openDoc(docId);
  const openedTab = app.tabs.find((t) => t.docId === docId);
  if (openedTab) {
    splitTabId.value = openedTab.id;
  }
  // 保持主栏原来的活动标签不变，实现左右/上下两栏各自显示不同文件
  if (prevActive && app.tabs.some((t) => t.id === prevActive) && prevActive !== openedTab?.id) {
    app.activeTabId = prevActive;
  }
  activePane.value = 'split';
}

/** 分屏标签下拉是否展开 */
const splitPickerOpen = ref(false);

/** 分屏比例：第一栏占可用空间的比例（垂直分屏指宽度，水平分屏指高度） */
const splitRatio = computed(() => localLayout.value.splitRatio);

/** 拖动分屏分隔条时更新比例 */
function onSplitRatio(next: number): void {
  updateLocalLayout({ splitRatio: Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, next)) });
}

/* ---------------- 打开新文件的行为（1.1.7 / 1.1.9 分屏协同） ---------------- */

/**
 * 打开文档的统一入口。
 *
 * - 当处于分屏状态且焦点在第二栏（`activePane === 'split'`）时：
 *   在第二栏打开目标文档，保留主栏文档不关闭，支持同时对照编辑两篇不同文档！
 * - 当处于分屏状态且焦点在主栏时：
 *   在主栏打开目标文档，且绝不关闭第二栏正在显示的标签！
 * - 未分屏时：按 `localLayout.openMode`（`replace` 替换当前标签 / `keep` 保留并新开标签）执行。
 */
async function openDocInMode(docId: string, options: { keep?: boolean } = {}): Promise<void> {
  if (splitDirection.value !== 'none' && activePane.value === 'split') {
    await chooseSplitDoc(docId);
    return;
  }

  const alreadyOpen = app.tabs.some((t) => t.docId === docId);
  const keepCurrent =
    options.keep === true ||
    localLayout.value.openMode === 'keep' ||
    alreadyOpen ||
    splitDirection.value !== 'none';

  if (!keepCurrent) {
    // 单文档模式：先把当前文档落到磁盘（用户要求：修改即保存、不询问），再关掉它
    const cur = activeTab.value;
    if (cur && cur.docId !== docId && cur.id !== splitTabId.value) {
      const saved = await saveTabIfDirty(cur.id);
      if (saved) app.closeTab(cur.id, true);
    }
  }
  await app.openDoc(docId);
}

/**
 * 标签栏「+」号的语义（1.1.7）。
 */
function onNewTabClick(): void {
  void app.createDoc({});
  if (localLayout.value.openMode === 'replace') {
    app.notify('已新开一个标签（+ 号即同时打开多篇）', 'info', 2200);
  }
}

const SPLIT_HANDLE_MIN = 20;
const SPLIT_HANDLE_MAX = 80;
const splitHandleValue = computed(() => Math.round(splitRatio.value * 100));

function onSplitHandleUpdate(value: number): void {
  onSplitRatio(value / 100);
}

/**
 * 标签栏分屏按钮 / 右键菜单设置分屏方向（1.1.9 增强：默认同时打开不同文件）。
 *
 * 开启分屏时：
 * 1. 若已有其它已打开的文档标签，优先选另一篇作为第二栏；
 * 2. 若当前只有 1 个标签但仓库里还有别的文档，自动把仓库中另一篇文档打开到第二栏，
 *    避免分屏一打开两边是同一篇文件（看起来像「当前文件预览」）。
 */
async function onSetSplit(dir: 'none' | 'v' | 'h'): Promise<void> {
  if (dir === 'none') {
    splitDirection.value = 'none';
    activePane.value = 'primary';
    return;
  }
  splitDirection.value = dir;
  const curId = activeTab.value?.id ?? '';
  const validSplit = app.tabs.find(
    (t) => t.id === splitTabId.value && t.id !== curId && t.id !== SETTINGS_TAB_ID && t.id !== PLUGIN_TAB_ID,
  );
  if (validSplit) return;

  const otherTab = app.tabs.find(
    (t) => t.id !== curId && t.id !== SETTINGS_TAB_ID && t.id !== PLUGIN_TAB_ID,
  );
  if (otherTab) {
    splitTabId.value = otherTab.id;
    return;
  }

  // 当前只有一个标签：从仓库中找另一篇文档自动打开到第二栏
  const otherDoc = app.docs.find((d) => d.docId !== activeTab.value?.docId);
  if (otherDoc) {
    await chooseSplitDoc(otherDoc.docId);
    activePane.value = 'primary';
  } else if (activeTab.value) {
    splitTabId.value = activeTab.value.id;
  }
}

/**
 * 标签栏右键「左右分屏 / 上下分屏」的入口（1.1.9 修「两栏显示同一篇」）。
 *
 * 改前直接把 `splitTabId` 设成被右键的那个标签。但最常用的操作恰恰是
 * **右键当前正在编辑的标签** → 主栏和第二栏都渲染同一篇文档，
 * 观感就是「当前文件的预览」，而不是用户要的「同时打开不同的文件」。
 *
 * 现在的规则：
 * - 右键的标签 ≠ 主栏当前标签：把它放进第二栏，主栏不动 → 天然是两篇不同文件；
 * - 右键的标签 = 主栏当前标签：转交 `onSetSplit`，由它按「优先其它已开标签、
 *   否则从仓库里再打开一篇」去挑另一篇，保证两栏不是同一篇；
 * - 已在同方向对同一标签分屏时再点一次：收起分屏（保留「再点一次取消」的手感）。
 */
async function splitTabIntoPane(id: string, dir: 'v' | 'h'): Promise<void> {
  if (splitDirection.value === dir && splitTabId.value === id) {
    splitDirection.value = 'none';
    activePane.value = 'primary';
    return;
  }
  const curId = activeTab.value?.id ?? '';
  if (id === curId) {
    await onSetSplit(dir);
    return;
  }
  splitDirection.value = dir;
  splitTabId.value = id;
  // 不抢焦点：右键动作的意图是「并排看」，主栏仍应是操作目标
  activePane.value = 'primary';
}

/* ---------------- 右侧栏功能区块（1.1.9：多区块上下窗口堆叠 + 拖拽调整高度） ---------------- */

/** 右侧栏可显示的全部区块（顺序即按钮与上下窗口堆叠顺序） */
const RIGHT_SECTIONS: Array<{ id: RightPanelSection; label: string; icon: string }> = [
  { id: 'ai', label: 'AI 助手', icon: 'sparkles' },
  { id: 'file', label: '文件操作', icon: 'folder' },
  { id: 'outline', label: '大纲', icon: 'outline' },
  { id: 'backlinks', label: '反向链接', icon: 'link' },
  { id: 'tags', label: '标签', icon: 'tag' },
  { id: 'history', label: '版本历史', icon: 'history' },
  { id: 'stats', label: '文档统计', icon: 'chart' },
  { id: 'calendar', label: '日历', icon: 'calendar' },
];

function rightSectionOn(id: RightPanelSection): boolean {
  const list = settingsStore.settings.layout.rightPanelSections ?? [];
  return list.includes(id);
}

/** 当前已开启的右侧栏区块列表（按 RIGHT_SECTIONS 标准顺序排列，上下堆叠展示） */
const enabledRightSections = computed<RightPanelSection[]>(() => {
  const enabled = settingsStore.settings.layout.rightPanelSections ?? [];
  return RIGHT_SECTIONS.map((s) => s.id).filter((id) => enabled.includes(id));
});

/** 切换某个区块的开启/关闭状态（多选开关，支持同时打开多个操作区上下排列） */
function toggleRightSection(id: RightPanelSection): void {
  const list = [...(settingsStore.settings.layout.rightPanelSections ?? [])];
  const idx = list.indexOf(id);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(id);
  settingsStore.updateLayout({ rightPanelSections: list });
}

/** 获取某个右侧区块的默认高度（px） */
function defaultRightSectionHeight(id: RightPanelSection): number {
  if (id === 'ai') return 380;
  if (id === 'file') return 300;
  if (id === 'calendar') return 260;
  return 220;
}

/** 读取某个右侧区块当前高度（优先用户拖拽记忆值） */
function getRightSectionHeight(id: RightPanelSection): number {
  const saved = localLayout.value.rightSectionHeights?.[id];
  if (typeof saved === 'number' && Number.isFinite(saved)) return saved;
  return defaultRightSectionHeight(id);
}

/** 拖动区块下方分隔条时更新该区块高度并持久化到 localLayout */
function setRightSectionHeight(id: RightPanelSection, height: number): void {
  const clamped = Math.min(RIGHT_SECTION_HEIGHT_MAX, Math.max(RIGHT_SECTION_HEIGHT_MIN, Math.round(height)));
  updateLocalLayout({
    rightSectionHeights: {
      ...(localLayout.value.rightSectionHeights ?? {}),
      [id]: clamped,
    },
  });
}

/**
 * 单个右侧子系统窗口的内联尺寸（1.1.9 重做）。
 *
 * 用户原话：「右侧多个操作区每个高度可调，但最后一个面板下方有多余手柄、总高不足时留白、
 * 超出时出现双滚动条」。
 *
 * 三条规则：
 * 1. 只有一个区块：让它占满整个右侧栏（`flex: 1 1 auto`），不需要拖（也没有手柄）；
 * 2. 多个区块里的**非末位**：用用户拖过的固定高度（`flex: 0 0 auto` + height）。
 *    `flex-shrink: 0` 是关键 —— 否则总高超出时这些块会被压缩，
 *    高度记忆值看起来「不生效」，而且压缩后的块内部再滚一层，就又变成双滚动条；
 * 3. 多个区块里的**末位**：不再给固定高度，而是 `flex: 1 1 0` 吃掉剩余空间。
 *    这样「总高不足」时是末位块填满容器 → 不再留白；
 *    「总高超出」时末位块缩到 minHeight（80px），超出部分由外层 `.rightstack`
 *    唯一的那条滚动条承担 → 不再双滚动条。
 */
function rightPaneStyle(id: RightPanelSection, idx: number): Record<string, string> {
  if (enabledRightSections.value.length === 1) {
    return { flex: '1 1 auto', minHeight: '160px' };
  }
  if (idx === enabledRightSections.value.length - 1) {
    return { flex: '1 1 0', minHeight: `${RIGHT_SECTION_HEIGHT_MIN}px` };
  }
  return { height: `${getRightSectionHeight(id)}px`, flex: '0 0 auto' };
}

/** 右侧栏「历史版本」区块展示的最近版本 */
const cloudVersions = ref<Array<{ id: string; rev: number; createdAt: number; label?: string }>>([]);

async function loadRightHistoryVersions(): Promise<void> {
  const docId = activeTab.value?.docId;
  if (!docId || !app.vault || !rightSectionOn('history')) {
    cloudVersions.value = [];
    return;
  }
  try {
    const local = await app.vault.listVersions(docId);
    if (local.length) {
      cloudVersions.value = local;
      return;
    }
    cloudVersions.value = await app.listCloudVersions(docId);
  } catch {
    cloudVersions.value = [];
  }
}

watch(
  () => [activeTab.value?.docId, activeTab.value?.dirty, rightSectionOn('history')] as const,
  () => {
    void loadRightHistoryVersions();
  },
  { immediate: true },
);

const settingsTabOpen = computed(() => app.tabs.some((t) => t.id === SETTINGS_TAB_ID));
const isSettingsActive = computed(() => app.activeTabId === SETTINGS_TAB_ID);
const isPluginActive = computed(() => app.activeTabId === PLUGIN_TAB_ID);

/* ---------------- 图编辑器（1.1.0） ---------------- */

/** 当前标签是否是流程图（按扩展名分流） */
const isFlowTab = computed(() => /\.flow$/i.test(activeTab.value?.path ?? ''));
/** 当前标签是否是思维导图 */
const isMindTab = computed(() => /\.mind$/i.test(activeTab.value?.path ?? ''));

/**
 * 分屏第二栏标签的图文档判定（1.1.9）。
 *
 * 只看 `splitTab.path` 的扩展名。图文档的内容是 JSON，若落进 markdown 编辑器，
 * 用户会看到一大段 `{"nodes":[...]}` 文本，等于第二栏废掉。
 */
const isSplitFlowTab = computed(() => /\.flow$/i.test(splitTab.value?.path ?? ''));
const isSplitMindTab = computed(() => /\.mind$/i.test(splitTab.value?.path ?? ''));

/**
 * 新建图文档并打开。
 *
 * 关键一：`Vault.create()` 的扩展名白名单已包含 `.mind`/`.flow`（1.1.0 改），
 * 所以传带扩展名的 path 即可落成纯 `.flow` / `.mind` 文件，不会被补成 `.md`。
 *
 * 关键二：`Vault.create()` 只在「没有显式 path」时才做重名去重（uniquePath），
 * 传了显式 path 会**直接覆盖同名文件**。因此这里必须自己按 `app.docs` 查重，
 * 否则重复点「新建流程图」会覆盖掉用户已经画好的图（表现为「新建后图不见了」）。
 */
async function createDiagram(kind: 'flowchart' | 'mindmap'): Promise<void> {
  const isFlow = kind === 'flowchart';
  const ext = isFlow ? 'flow' : 'mind';
  const label = isFlow ? '未命名流程图' : '未命名思维导图';
  // 已占用的路径：同时参考文档索引与已打开标签，避免索引尚未刷新时撞名
  const taken = new Set<string>();
  for (const d of app.docs) taken.add(d.path.toLowerCase());
  for (const t of app.tabs) if (t.path) taken.add(t.path.toLowerCase());

  // 从当前文档数起递增，直到找到未被占用的路径
  let seq = app.docs.length + 1;
  let path = `${label}-${String(seq).padStart(2, '0')}.${ext}`;
  while (taken.has(path.toLowerCase())) {
    seq += 1;
    path = `${label}-${String(seq).padStart(2, '0')}.${ext}`;
  }

  // 初始内容留空：编辑器解析失败时回落到 createEmptyDoc，给出可直接编辑的空图
  await app.createDoc({ path, content: '' });
  app.notify(isFlow ? '已新建流程图，从左侧图形库拖入形状开始' : '已新建思维导图，Tab 添加子主题', 'success', 2600);
}

function openSettings(tab = 'general'): void {
  settingsTab.value = tab;
  // 已打开则直接激活，避免重复插入标签
  const exists = app.tabs.some((t) => t.id === SETTINGS_TAB_ID);
  if (!exists) {
    app.tabs.push({
      id: SETTINGS_TAB_ID,
      docId: SETTINGS_TAB_ID,
      title: '设置',
      path: '',
      dirty: false,
      locked: true,
      mode: 'wysiwyg',
      pageWidth: pageWidth.value,
      scrollTop: 0,
      cursor: 0,
      content: '',
    });
  }
  app.activeTabId = SETTINGS_TAB_ID;
}

/** 关闭设置标签页并回到一个真实文档 */
function closeSettingsTab(): void {
  const idx = app.tabs.findIndex((t) => t.id === SETTINGS_TAB_ID);
  if (idx >= 0) app.tabs.splice(idx, 1);
  if (app.activeTabId === SETTINGS_TAB_ID) {
    const next = app.tabs[Math.max(0, idx - 1)] ?? app.tabs[0];
    app.activeTabId = next?.id ?? '';
  }
}

/** TabBar 里传给视图的精简标签（设置标签用固定标题与图标） */
const tabBarTabs = computed(() =>
  app.tabs.map((t) =>
    t.id === SETTINGS_TAB_ID ? { id: t.id, title: '设置', dirty: false, locked: true } : t.id === PLUGIN_TAB_ID ? { id: t.id, title: '插件商店', dirty: false, locked: true } : t,
  ),
);
</script>

<template>
  <div class="shell" :class="{ 'is-narrow': narrow }">
    <!--
      外壳骨架（1.1.9 启动极速化：只在**首帧之前**出现）。

      原实现是 `v-if="booting"` 挡住整个工作台，直到仓库索引 + 全部标签正文读完
      才一次性渲染 —— 用户看到全屏骨架的时间等于完整启动时间。

      现在 `shellReady` 在 onMounted 里 nextTick 就置 true（不等待 boot()），
      所以这个骨架通常只存在一帧：作用只是避免「DOM 还没挂载」时的白屏闪烁。
    -->
    <div v-if="!shellReady" class="skel" role="status" aria-live="polite" aria-label="正在打开工作台">
      <!-- 顶部工具条骨架 -->
      <div class="skel__bar">
        <span class="skel__dot" />
        <span class="skel__line skel__line--w120" />
        <span class="skel__line skel__line--w80" />
        <span class="skel__spacer" />
        <span class="skel__line skel__line--w60" />
      </div>
      <div class="skel__body">
        <!-- 左侧文件列表骨架 -->
        <aside class="skel__side">
          <span class="skel__search" />
          <span v-for="i in 9" :key="i" class="skel__row" :style="{ width: `${92 - (i % 4) * 13}%` }" />
        </aside>
        <!-- 正文区骨架 -->
        <div class="skel__main">
          <span class="skel__title" />
          <span class="skel__line skel__line--w70" />
          <span class="skel__line" />
          <span class="skel__line skel__line--w90" />
          <span class="skel__line skel__line--w60" />
          <span class="skel__line" />
          <span class="skel__line skel__line--w80" />
          <span class="skel__line skel__line--w40" />
        </div>
      </div>
      <!-- 阶段提示：保留可读进度，但不占据版面中心 -->
      <p class="skel__phase">{{ bootPhase }}</p>
    </div>

    <template v-else>
      <!-- 启动失败：整体替换为错误面板（此时连仓库都没打开，外壳没有可展示的数据） -->
      <div v-if="bootError && !docReady" class="boot">
        <NmIcon name="alert" :size="26" />
        <p class="boot__error">{{ bootError }}</p>
        <button class="nm-btn nm-btn--primary" @click="boot">重试</button>
      </div>

      <main v-else class="shell__main">
        <!-- 主工作区：左侧栏置顶直通顶部，标签栏从左侧栏结束的位置开始 -->
        <div class="shell__body">
          <!--
            桌面端：功能区（图标栏）本身也作为窗口拖拽区。
            全局样式里 `.nm-drag button` 已自动设为 `no-drag`，所以按钮点击不受影响，
            只有图标之间的空隙与顶部留白可拖动窗口 —— 正好补上此前
            「窗口最左上角 40×40 图标栏无法拖动」的缺口。
          -->
          <aside
            v-if="layout.ribbonEnabled !== false && layout.ribbonPosition === 'left' && !narrow"
            class="ribbon ribbon--left nm-drag"
            @contextmenu="openRibbonMenu($event)"
          >
            <button
              v-for="r in ribbonActions"
              :key="r.id"
              class="ribbon__btn"
              :title="r.title"
              @click="onPanelAction(r.id)"
              @contextmenu="openRibbonMenu($event, r.id, r.title)"
            >
              <NmIcon :name="r.icon" :size="16" />
            </button>
            <!-- 末位固定按钮：插件商店（竖排时贴底，见 .ribbon__btn--bottom） -->
            <button
              class="ribbon__btn ribbon__btn--bottom"
              :class="{ 'is-on': isPluginActive }"
              :title="ribbonBottomAction.title"
              :data-ribbon-bottom="ribbonBottomAction.id"
              @click="onPanelAction(ribbonBottomAction.id)"
            >
              <NmIcon :name="ribbonBottomAction.icon" :size="16" />
            </button>
          </aside>

          <div
            v-if="layout.leftPanelOpen && !narrow"
            class="shell__left"
            :style="{ width: `${localLayout.leftWidth}px` }"
          >
            <LeftPanel
              :docs="app.docsForPanel"
              :active-doc-id="(splitDirection !== 'none' && activePane === 'split' ? splitTab?.docId : activeTab?.docId) ?? ''"
              :show-recent="layout.showRecent"
              :recent-count="layout.recentCount"
              :view="layout.leftPanelMode"
              :outline-content="activeTab?.content ?? ''"
              :outline-headings="headings"
              :sort-by="app.sortBy"
              :folder-order="app.folderOrder"
              :custom-folders="app.customFolders"
              :vault-name="app.vaultName"
              :vaults="app.vaults"
              :search-hits="searchResults"
              :search-query="searchQuery"
              @open="(id: string) => openDocInMode(id)"
              @create="app.createDoc({})"
              @create-folder="promptCreateFolder"
              @outline-jump="jumpToHeading"
              @set-view="(v: LeftPanelMode) => settingsStore.updateLayout({ leftPanelMode: v })"
              @set-sort="(s: DocSortKey) => app.setSort(s)"
              @reorder-folders="(order: string[]) => app.setFolderOrder(order)"
              @move-doc="({ docId, folder }: { docId: string; folder: string }) => app.moveDocToFolder(docId, folder)"
              @switch-vault="(loc: string) => app.switchVault(loc)"
              @create-vault="promptCreateVault"
              @open-local-vault="app.pickAndOpenLocalVault()"
              @update:search-query="(q: string) => (searchQuery = q)"
              @rename="(id: string) => promptRename(id)"
              @move-path="(id: string) => promptMovePath(id)"
              @show-in-folder="(id: string) => showDocInFolder(id)"
              @delete="deleteDoc"
            >
              <template #footer>
                <!--
                  1.1.8：独立的「设置」按钮已移除（用户要求「设置按钮只要在用户头像即可」），
                  左侧栏页脚的仓库选择器由 LeftPanel 自己渲染，这里只放用户头像菜单。
                  设置入口仍可通过头像菜单 / Ctrl+, / 命令面板进入。
                -->
                <UserMenu align="left" @open-settings="openSettings" @open-ai="openSettings('ai')" @open-storage="openSettings('storage')" />
              </template>
            </LeftPanel>
          </div>

          <!-- 左侧栏宽度拖拽手柄：宽度只存本地，不进云同步 -->
          <ResizeHandle
            v-if="layout.leftPanelOpen && !narrow"
            direction="vertical"
            :value="localLayout.leftWidth"
            :min="layoutBounds.leftWidth.min"
            :max="layoutBounds.leftWidth.max"
            :default-value="layoutDefaults.leftWidth"
            label="调整左侧栏宽度"
            @update="(v: number) => updateLocalLayout({ leftWidth: v })"
          />

          <!-- 右侧主文档列：顶部为标签栏（从左侧栏结束开始），标签栏下方直接是统一工具栏 -->
          <div class="shell__work">
            <TabBar
              :tabs="tabBarTabs"
              :active-id="app.activeTabId"
              :left-panel-open="layout.leftPanelOpen"
              :split-direction="splitDirection"
              @select="(id: string) => (app.activeTabId = id)"
              @close="closeTab"
              @new-tab="onNewTabClick"
              @toggle-left="settingsStore.updateLayout({ leftPanelOpen: !layout.leftPanelOpen })"
              @tab-action="onTabAction"
              @set-split="onSetSplit"
            />

            <div class="shell__work-inner">
              <!-- 1.1.1：不再绑定 editorColorStyle（内联色会覆盖主题变量），正文颜色全部交给主题 -->
              <section class="shell__doc">
                <!--
                  图编辑器（流程图 / 思维导图）自带完整工具栏，不走富文本工具条：
                  页宽 / 编辑模式 / 加粗等按钮对图文档毫无意义，还会挤掉 38px 画布高度，
                  观感上就是「页面错乱」。因此图文档下整条 EditorBar 不渲染。
                -->
                <EditorBar
                  v-if="activeTab && !isFlowTab && !isMindTab"
                  :mode="mode"
                  :page-width="pageWidth"
                  :dirty="activeTab.dirty"
                  :autosave-enabled="autosaveEnabled"
                  :show-format-tools="layout.editorToolbar"
                  :toolbar-items="layout.toolbarItems"
                  :right-panel-open="layout.rightPanelOpen"
                  @new-doc="app.createDoc({})"
                  @save="saveAndSync"
                  @toggle-autosave="toggleAutosave"
                  @open-palette="paletteOpen = true"
                  @cmd="onFormatCommand"
                  @open-history="historyOpen = true"
                  @set-mode="app.setMode"
                  @set-page-width="app.setPageWidth"
                  @open-share="shareOpen = true"
                  @open-export="exportOpen = true"
                  @toggle-right-panel="toggleAi"
                  @reorder-tools="(list: string[]) => settingsStore.updateLayout({ toolbarItems: list })"
                />

                <!-- 查找栏同理：图文档的内容是 JSON，文本查找没有意义，不渲染 -->
                <div v-if="findBarOpen && activeTab && !isFlowTab && !isMindTab" class="findbar">
                  <NmIcon name="search" :size="14" />
                  <input v-model="findText" class="findbar__input" placeholder="查找内容…" @keyup.enter="doFindNext" />
                  <button class="nm-btn nm-btn--sm" @click="doFindNext">下一个</button>
                  <template v-if="findBarReplaceMode">
                    <input v-model="replaceText" class="findbar__input" placeholder="替换为…" @keyup.enter="doReplaceOne" />
                    <button class="nm-btn nm-btn--sm" @click="doReplaceOne">替换</button>
                    <button class="nm-btn nm-btn--sm" @click="doReplaceAll">全部替换</button>
                  </template>
                  <button class="nm-btn nm-btn--sm" @click="findBarReplaceMode = !findBarReplaceMode">
                    {{ findBarReplaceMode ? '收起替换' : '替换' }}
                  </button>
                  <button class="findbar__close" title="关闭" @click="findBarOpen = false">
                    <NmIcon name="close" :size="13" />
                  </button>
                </div>

                <div class="shell__panes" :class="`shell__panes--${splitDirection}`">
                  <!-- 设置标签页：整页设置（1.0.2 起不再用弹窗） -->
                  <SettingsPage
                    v-if="isSettingsActive"
                    :initial-tab="settingsTab"
                    @close="closeSettingsTab"
                  />
                  <!--
                    插件商店标签页：功能区入口，新标签页打开可进入配置。
                    `:open="true"` 显式告诉组件「已经打开」——组件内部据此触发市场/已装插件的加载
                    （它原本只在 props.open 变化时加载，标签页形态下不传就会一片空白）。
                  -->
                  <PluginCenter v-else-if="isPluginActive" embedded :open="true" />
                  <!-- 流程图 / 思维导图：按文件扩展名分流到专用编辑器（1.1.0） -->
                  <FlowchartEditor
                    v-else-if="isFlowTab"
                    :key="`flow-${activeTab!.id}`"
                    :model-value="activeTab!.content"
                    :title="activeTab!.title"
                    @update:model-value="(v: string) => app.updateTabContent(activeTab!.id, v)"
                    @save="saveAndSync"
                  />
                  <MindmapEditor
                    v-else-if="isMindTab"
                    :key="`mind-${activeTab!.id}`"
                    :model-value="activeTab!.content"
                    :title="activeTab!.title"
                    @update:model-value="(v: string) => app.updateTabContent(activeTab!.id, v)"
                    @save="saveAndSync"
                  />
                  <!--
                    1.1.7 修复「滚动条出现在页面中间」：
                    滚动容器 `.shell__content` 现在**铺满到编辑器区最右端**（右侧栏在场时
                    就是右侧栏左边界），滚动条因此贴在最右侧；页面宽度（窄/标准/宽/铺满）
                    下沉到内层 `.shell__page`，由它负责 max-width + 居中。
                    改前是 max-width 直接加在滚动容器上，容器只有 760px 宽且居中，
                    滚动条就落在了 1226px 处（离右边界 1440px 差 214px）—— 用户看到的
                    「滚动条在页面中间」正是这个。
                  -->
                  <div
                    v-else
                    class="shell__content"
                    :class="{ 'is-pane-active': splitDirection !== 'none' && activePane === 'primary' }"
                    @mousedown="activePane = 'primary'"
                    @contextmenu="openEditorMenu"
                  >
                    <div class="shell__page" :class="pageWidthClass">
                    <template v-if="activeTab">
                      <WysiwygEditor
                        v-if="mode === 'wysiwyg'"
                        ref="wysiwygRef"
                        :key="`w-${activeTab.id}`"
                        :model-value="activeTab.content"
                        :font-size="effectiveFontSize"
                        :line-height="settingsStore.settings.appearance.lineHeight"
                        :title="activeTab.title"
                        @update:model-value="(v: string) => app.updateTabContent(activeTab!.id, v)"
                      >
                        <!-- 正文第一行：文件名（不写入内容、不冻结、不占行号） -->
                        <template #title>
                          <DocTitleLine
                            :key="`t-${activeTab.id}`"
                            :model-value="activeTab.title"
                            :font-size="effectiveFontSize + 2"
                            :padding-left="settingsStore.settings.appearance.showLineNumbers ? 36 : 0"
                            :padding-right="0"
                            @rename="(next: string) => renameActiveDoc(next)"
                          />
                        </template>
                      </WysiwygEditor>
                      <SourceEditor
                        v-else-if="mode === 'source'"
                        :key="`s-${activeTab.id}`"
                        :model-value="activeTab.content"
                        :show-line-numbers="settingsStore.settings.appearance.showLineNumbers"
                        :font-size="effectiveFontSize"
                        :line-height="settingsStore.settings.appearance.lineHeight"
                        @update:model-value="(v: string) => app.updateTabContent(activeTab!.id, v)"
                        @save="saveAndSync"
                      >
                        <!-- 正文第一行：文件名（不写入内容、不冻结、不占行号） -->
                        <template #title>
                          <DocTitleLine
                            :key="`ts-${activeTab.id}`"
                            :model-value="activeTab.title"
                            :font-size="effectiveFontSize + 2"
                            :padding-left="sourceTitlePadLeft"
                            :padding-right="32"
                            @rename="(next: string) => renameActiveDoc(next)"
                          />
                        </template>
                      </SourceEditor>
                      <CompareView
                        v-else-if="mode === 'compare'"
                        :key="`c-${activeTab.id}`"
                        :model-value="activeTab.content"
                        :font-size="effectiveFontSize"
                        :line-height="settingsStore.settings.appearance.lineHeight"
                        :show-line-numbers="settingsStore.settings.appearance.showLineNumbers"
                        @update:model-value="(v: string) => app.updateTabContent(activeTab!.id, v)"
                      >
                        <template #title>
                          <DocTitleLine
                            :key="`tc-${activeTab.id}`"
                            :model-value="activeTab.title"
                            :font-size="effectiveFontSize + 2"
                            :padding-left="sourceTitlePadLeft"
                            :padding-right="32"
                            @rename="(next: string) => renameActiveDoc(next)"
                          />
                        </template>
                        <!-- 对照模式右侧预览区也要有同一行文件名，两栏首行才对得齐 -->
                        <template #preview-title>
                          <DocTitleLine
                            :key="`tcp-${activeTab.id}`"
                            :model-value="activeTab.title"
                            :font-size="effectiveFontSize + 2"
                            :padding-left="sourceTitlePadLeft"
                            :padding-right="32"
                            @rename="(next: string) => renameActiveDoc(next)"
                          />
                        </template>
                      </CompareView>
                      <ReadView
                        v-else
                        :key="`r-${activeTab.id}`"
                        :model-value="activeTab.content"
                        :title="activeTab.title"
                        :font-size="effectiveFontSize"
                        :line-height="settingsStore.settings.appearance.lineHeight"
                      >
                        <template #title>
                          <DocTitleLine
                            :key="`tr-${activeTab.id}`"
                            :model-value="activeTab.title"
                            :font-size="effectiveFontSize + 2"
                            :padding-left="0"
                            :padding-right="0"
                            readonly
                          />
                        </template>
                      </ReadView>
                    </template>
                    <!--
                      正文加载中的占位（1.1.9）。
                      与空状态区分开：`activeTab` 还没建出来时，如果直接落到「还没有打开任何文档」，
                      用户会以为文档丢了。这里只挡住正文区，左侧栏和标签栏此刻已经可以操作了。
                    -->
                    <div v-else-if="!docReady" class="docboot" role="status" aria-live="polite">
                      <span class="docboot__title" />
                      <span class="docboot__line" />
                      <span class="docboot__line docboot__line--w90" />
                      <span class="docboot__line docboot__line--w70" />
                      <p class="docboot__phase">{{ bootPhase }}</p>
                    </div>
                    <div v-else class="empty">
                      <div class="empty__mark">N</div>
                      <h2>还没有打开任何文档</h2>
                      <p>从左侧选择一篇，或新建一篇开始写作。</p>
                      <div class="empty__row">
                        <button class="nm-btn nm-btn--primary" @click="app.createDoc({})">新建文档 Ctrl+N</button>
                        <button class="nm-btn" @click="paletteOpen = true">编辑命令 Ctrl+P</button>
                      </div>
                    </div>
                    </div>
                  </div>

                  <!--
                    分屏分隔条（1.1.7）：两栏之间可拖动调整占比。
                  -->
                  <ResizeHandle
                    v-if="splitDirection !== 'none' && splitTab"
                    :key="`split-handle-${splitDirection}`"
                    :direction="splitDirection === 'h' ? 'horizontal' : 'vertical'"
                    :value="splitHandleValue"
                    :min="SPLIT_HANDLE_MIN"
                    :max="SPLIT_HANDLE_MAX"
                    :default-value="50"
                    label="调整分屏比例"
                    @update="onSplitHandleUpdate"
                  />

                  <!--
                    分屏第二栏（1.1.9 真分屏：可独立选择打开仓库内任意不同文件并编辑）。
                  -->
                  <div
                    v-if="splitDirection !== 'none' && splitTab"
                    class="shell__splitpane"
                    :class="{ 'is-pane-active': activePane === 'split' }"
                    :style="{ flex: `0 0 ${splitRatio * 100}%` }"
                    @mousedown="activePane = 'split'"
                  >
                    <div class="splitpane__head">
                      <!-- 第二栏自己的文档/标签选择器：支持已打开标签 + 仓库全部其它文档 -->
                      <div class="splitpane__picker">
                        <button
                          class="splitpane__pickbtn"
                          :title="`切换此分屏显示的文档（当前：${splitTab.title}）`"
                          aria-haspopup="menu"
                          :aria-expanded="splitPickerOpen"
                          @click="splitPickerOpen = !splitPickerOpen"
                        >
                          <NmIcon name="file" :size="12" />
                          <span class="splitpane__pickname">{{ splitTab.title }}</span>
                          <NmIcon name="chevronDown" :size="10" />
                        </button>
                        <div v-if="splitPickerOpen" class="splitpane__pickmenu" role="menu" @mousedown.stop>
                          <div v-if="splitSelectableTabs.length" class="splitpane__pickgroup">已打开标签</div>
                          <button
                            v-for="t in splitSelectableTabs"
                            :key="`sp-pick-${t.id}`"
                            class="splitpane__pickitem"
                            :class="{ 'is-active': t.id === splitTab.id }"
                            role="menuitemradio"
                            :aria-checked="t.id === splitTab.id"
                            @click="chooseSplitTab(t.id)"
                          >
                            <NmIcon name="file" :size="12" />
                            <span class="splitpane__picktext">{{ t.title }}</span>
                            <NmIcon v-if="t.id === splitTab.id" name="check" :size="11" />
                          </button>
                          <template v-if="splitUnopenedDocs.length">
                            <div class="splitpane__pickgroup">仓库其他文档</div>
                            <button
                              v-for="d in splitUnopenedDocs"
                              :key="`sp-doc-${d.docId}`"
                              class="splitpane__pickitem"
                              role="menuitem"
                              @click="chooseSplitDoc(d.docId)"
                            >
                              <NmIcon name="file" :size="12" />
                              <span class="splitpane__picktext">{{ d.title }}</span>
                            </button>
                          </template>
                          <p v-if="!splitSelectableTabs.length && !splitUnopenedDocs.length" class="splitpane__pickempty">
                            没有可选的文档
                          </p>
                        </div>
                      </div>
                      <button class="splitpane__close" title="关闭分屏" @click="onSetSplit('none')">
                        <NmIcon name="close" :size="13" />
                      </button>
                    </div>
                    <div class="splitpane__body" :class="pageWidthClass">
                      <!--
                        分屏第二栏按标签自己的 `mode` 分流（1.1.9 补齐）。

                        改前只有两个分支：`mode !== 'source'` 一律 WysiwygEditor，否则 SourceEditor。
                        于是第二栏选了「阅读视图」或「对照模式」的标签时，
                        渲染出来的仍是所见即所得编辑器 —— 用户切到阅读视图，第二栏却还能打字。
                        现在补上 read / compare 两个分支，与主栏的四分支保持一致。

                        图文档（.flow / .mind）额外前置一个分支：它们是 JSON 内容，
                        当成 markdown 渲染只会得到一团乱码，必须交给专用编辑器。
                      -->
                      <FlowchartEditor
                        v-if="isSplitFlowTab"
                        :key="`sp-flow-${splitTab.id}`"
                        class="splitpane__editor"
                        :model-value="splitTab.content"
                        :title="splitTab.title"
                        @update:model-value="(v: string) => app.updateTabContent(splitTab!.id, v)"
                        @save="saveAndSync"
                      />
                      <MindmapEditor
                        v-else-if="isSplitMindTab"
                        :key="`sp-mind-${splitTab.id}`"
                        class="splitpane__editor"
                        :model-value="splitTab.content"
                        :title="splitTab.title"
                        @update:model-value="(v: string) => app.updateTabContent(splitTab!.id, v)"
                        @save="saveAndSync"
                      />
                      <WysiwygEditor
                        v-else-if="splitTab.mode === 'wysiwyg' || !splitTab.mode"
                        :key="`sp-w-${splitTab.id}`"
                        ref="splitWysiwygRef"
                        class="splitpane__editor"
                        :model-value="splitTab.content"
                        :font-size="effectiveFontSize"
                        :line-height="settingsStore.settings.appearance.lineHeight"
                        :title="splitTab.title"
                        @update:model-value="(v: string) => app.updateTabContent(splitTab!.id, v)"
                      >
                        <template #title>
                          <DocTitleLine
                            :key="`spt-w-${splitTab.id}`"
                            :model-value="splitTab.title"
                            :font-size="effectiveFontSize + 2"
                            :padding-left="settingsStore.settings.appearance.showLineNumbers ? 36 : 0"
                            :padding-right="0"
                            @rename="(next: string) => renameSplitDoc(next)"
                          />
                        </template>
                      </WysiwygEditor>
                      <SourceEditor
                        v-else-if="splitTab.mode === 'source'"
                        :key="`sp-s-${splitTab.id}`"
                        class="splitpane__editor"
                        :model-value="splitTab.content"
                        :show-line-numbers="settingsStore.settings.appearance.showLineNumbers"
                        :font-size="effectiveFontSize"
                        :line-height="settingsStore.settings.appearance.lineHeight"
                        @update:model-value="(v: string) => app.updateTabContent(splitTab!.id, v)"
                      >
                        <template #title>
                          <DocTitleLine
                            :key="`spt-s-${splitTab.id}`"
                            :model-value="splitTab.title"
                            :font-size="effectiveFontSize + 2"
                            :padding-left="sourceTitlePadLeft"
                            :padding-right="32"
                            @rename="(next: string) => renameSplitDoc(next)"
                          />
                        </template>
                      </SourceEditor>
                      <CompareView
                        v-else-if="splitTab.mode === 'compare'"
                        :key="`sp-c-${splitTab.id}`"
                        class="splitpane__editor"
                        :model-value="splitTab.content"
                        :font-size="effectiveFontSize"
                        :line-height="settingsStore.settings.appearance.lineHeight"
                        :show-line-numbers="settingsStore.settings.appearance.showLineNumbers"
                        @update:model-value="(v: string) => app.updateTabContent(splitTab!.id, v)"
                      >
                        <template #title>
                          <DocTitleLine
                            :key="`spt-c-${splitTab.id}`"
                            :model-value="splitTab.title"
                            :font-size="effectiveFontSize + 2"
                            :padding-left="sourceTitlePadLeft"
                            :padding-right="32"
                            @rename="(next: string) => renameSplitDoc(next)"
                          />
                        </template>
                        <template #preview-title>
                          <DocTitleLine
                            :key="`spt-cp-${splitTab.id}`"
                            :model-value="splitTab.title"
                            :font-size="effectiveFontSize + 2"
                            :padding-left="sourceTitlePadLeft"
                            :padding-right="32"
                            @rename="(next: string) => renameSplitDoc(next)"
                          />
                        </template>
                      </CompareView>
                      <ReadView
                        v-else
                        :key="`sp-r-${splitTab.id}`"
                        class="splitpane__editor"
                        :model-value="splitTab.content"
                        :title="splitTab.title"
                        :font-size="effectiveFontSize"
                        :line-height="settingsStore.settings.appearance.lineHeight"
                      >
                        <template #title>
                          <DocTitleLine
                            :key="`spt-r-${splitTab.id}`"
                            :model-value="splitTab.title"
                            :font-size="effectiveFontSize + 2"
                            :padding-left="0"
                            :padding-right="0"
                            readonly
                          />
                        </template>
                      </ReadView>
                    </div>
                  </div>
                </div>
              </section>

              <!-- 右侧栏宽度拖拽手柄：手柄在右侧栏左边，因此需 invert -->
              <ResizeHandle
                v-if="layout.rightPanelOpen && !narrow"
                direction="vertical"
                invert
                :value="localLayout.rightWidth"
                :min="layoutBounds.rightWidth.min"
                :max="layoutBounds.rightWidth.max"
                :default-value="layoutDefaults.rightWidth"
                label="调整右侧栏宽度"
                @update="(v: number) => updateLocalLayout({ rightWidth: v })"
              />

              <div v-if="layout.rightPanelOpen && !narrow" class="shell__right" :style="{ width: `${localLayout.rightWidth}px` }">
                <!--
                  右侧栏顶部区块开关条（1.1.9）：
                  支持多选同时开启多个操作区（上下窗口堆叠），且每个操作区可独立拖拽调整高度；
                  AI 助手与文件操作也拆分为两个对等的独立上下窗口区块，所有功能交互完全统一。
                -->
                <div class="righttabs" role="toolbar" aria-label="右侧栏功能区块开关">
                  <button
                    v-for="s in RIGHT_SECTIONS"
                    :key="s.id"
                    class="righttabs__btn"
                    :class="{ 'is-on': rightSectionOn(s.id) }"
                    :title="`${s.label}（点击开启/关闭此窗口）`"
                    :aria-pressed="rightSectionOn(s.id)"
                    :data-right-tab="s.id"
                    @click="toggleRightSection(s.id)"
                  >
                    <NmIcon :name="s.icon" :size="13" />
                  </button>
                  <button
                    class="righttabs__btn righttabs__btn--close"
                    title="关闭右侧边栏"
                    @click="settingsStore.updateLayout({ rightPanelOpen: false })"
                  >
                    <NmIcon name="close" :size="12" />
                  </button>
                </div>

                <div class="rightstack nm-scroll">
                  <template v-for="(secId, idx) in enabledRightSections" :key="secId">
                    <div
                      class="rightstack__pane"
                      :class="{
                        'rightstack__pane--single': enabledRightSections.length === 1,
                        'rightstack__pane--last': idx === enabledRightSections.length - 1,
                      }"
                      :data-right-pane="secId"
                      :style="rightPaneStyle(secId, idx)"
                    >
                      <AiPanel
                        v-if="secId === 'ai' || secId === 'file'"
                        :active-tab="secId === 'file' ? 'file' : 'ai'"
                        @close="toggleRightSection(secId)"
                        @file-op="onFileOp"
                      />
                      <RightSection
                        v-else-if="secId === 'outline'"
                        section="outline"
                        :outline="headings.map((h) => ({ level: h.level, text: h.text }))"
                        @jump="jumpToHeadingText"
                        @close="toggleRightSection(secId)"
                      />
                      <RightSection
                        v-else-if="secId === 'backlinks'"
                        section="backlinks"
                        :doc-id="activeTab?.docId"
                        :title="activeTab?.title"
                        :docs="app.docs"
                        @open-doc="(id: string) => openDocInMode(id)"
                        @close="toggleRightSection(secId)"
                      />
                      <RightSection
                        v-else-if="secId === 'tags'"
                        section="tags"
                        :content="activeTab?.content ?? ''"
                        @close="toggleRightSection(secId)"
                      />
                      <RightSection
                        v-else-if="secId === 'history'"
                        section="history"
                        :versions="cloudVersions"
                        @open-version="historyOpen = true"
                        @close="toggleRightSection(secId)"
                      />
                      <RightSection
                        v-else-if="secId === 'stats'"
                        section="stats"
                        :content="activeTab?.content ?? ''"
                        @close="toggleRightSection(secId)"
                      />
                      <RightSection
                        v-else-if="secId === 'calendar'"
                        section="calendar"
                        :docs="app.docs"
                        @open-daily="(date: string) => openDaily(date)"
                        @close="toggleRightSection(secId)"
                      />
                    </div>
                    <!--
                      只有「非最后一块」的下方才有手柄（1.1.9 修）。
                      改前条件是 `idx < enabledRightSections.length` —— 恒为 true，
                      于是最后一块下面也画了一条手柄，用户拖它会把最后一块拉出容器、露出空白。

                      为什么最后一个区块下面不该有手柄：它的高度不是由用户给定，
                      而是「吃掉剩余空间」（见 rightPaneStyle），拖它没有可分配的对象。
                    -->
                    <ResizeHandle
                      v-if="enabledRightSections.length > 1 && idx < enabledRightSections.length - 1"
                      :key="`rh-${secId}`"
                      direction="horizontal"
                      :value="getRightSectionHeight(secId)"
                      :min="RIGHT_SECTION_HEIGHT_MIN"
                      :max="RIGHT_SECTION_HEIGHT_MAX"
                      :default-value="defaultRightSectionHeight(secId)"
                      :label="`调整「${RIGHT_SECTIONS.find((x) => x.id === secId)?.label ?? secId}」高度`"
                      @update="(h: number) => setRightSectionHeight(secId, h)"
                    />
                  </template>
                  <!-- 所有区块都被关掉时给一条提示 -->
                  <p v-if="!enabledRightSections.length" class="rightstack__empty">
                    点上方图标开启要显示的窗口（AI 助手 / 文件操作 / 大纲 / 反链 / 标签 / 历史 / 统计 / 日历，可同时打开多个并拖动调整高度）
                  </p>
                </div>
              </div>

              <aside v-if="layout.ribbonEnabled !== false && layout.ribbonPosition === 'right' && !narrow" class="ribbon ribbon--right">
                <button
                  v-for="r in ribbonActions"
                  :key="r.id"
                  class="ribbon__btn"
                  :title="r.title"
                  @click="onPanelAction(r.id)"
                  @contextmenu="openRibbonMenu($event, r.id, r.title)"
                >
                  <NmIcon :name="r.icon" :size="16" />
                </button>
                <!-- 末位固定按钮：插件商店（竖排时贴底，见 .ribbon__btn--bottom） -->
                <button
                  class="ribbon__btn ribbon__btn--bottom"
                  :class="{ 'is-on': isPluginActive }"
                  :title="ribbonBottomAction.title"
                  :data-ribbon-bottom="ribbonBottomAction.id"
                  @click="onPanelAction(ribbonBottomAction.id)"
                >
                  <NmIcon :name="ribbonBottomAction.icon" :size="16" />
                </button>
              </aside>
            </div>
          </div>
        </div>

        <!-- 底部状态栏：不显示侧栏收起按钮，支持显示文件路径并点击打开所在文件夹，点击字数/字符复制对应数字 -->
        <footer class="statusbar">
          <div class="statusbar__left">
            <UserMenu v-if="!layout.leftPanelOpen || narrow" align="left" @open-settings="openSettings" @open-ai="openSettings('ai')" @open-storage="openSettings('storage')" />
            <!--
              1.1.7 修复「自动同步已就绪点了没反应」：
              原来是 `<span class="st st--plain">`，纯展示元素、没有任何点击处理，
              用户点了自然毫无反应。改成 button 并接到 `onSyncStatusClick()`，
              title 也从陈述句改成明确的动作提示。
            -->
            <button
              class="st st--sync"
              :class="{ 'is-syncing': app.syncState === 'syncing', 'is-error': app.syncState === 'error' }"
              :title="
                app.syncState === 'syncing'
                  ? '正在同步…'
                  : app.lastSyncAt
                    ? `上次自动同步：${relativeTime(app.lastSyncAt)}（点击立即同步）`
                    : '点击立即同步'
              "
              :aria-label="app.lastSyncAt ? '立即同步' : '立即同步（尚未同步过）'"
              @click="onSyncStatusClick"
            >
              <NmIcon :name="app.syncState === 'error' ? 'cloudOff' : 'cloudCheck'" :size="13" />
              <span>{{ app.lastSyncAt ? `已自动同步 (${relativeTime(app.lastSyncAt)})` : '自动同步已就绪' }}</span>
            </button>
            <button
              v-if="activeTab"
              class="st st--path"
              :title="`点击在文件夹中打开：${app.vaultLocation ? `${app.vaultLocation}/${activeTab.path}` : activeTab.path}`"
              @click="showDocInFolder(activeTab.docId)"
            >
              <NmIcon name="folder" :size="12" />
              <span class="st__path-text">{{ app.vaultLocation && !app.vaultLocation.startsWith('cloud:') ? `${app.vaultLocation}/${activeTab.path}` : activeTab.path }}</span>
            </button>
            <template v-if="layout.ribbonEnabled !== false && layout.ribbonPosition === 'statusbar-left'">
              <button
                v-for="r in ribbonActions"
                :key="`sbl-${r.id}`"
                class="st"
                :title="r.title"
                @click="onPanelAction(r.id)"
              >
                <NmIcon :name="r.icon" :size="13" />
              </button>
              <button
                class="st"
                :class="{ 'is-on': isPluginActive }"
                :title="ribbonBottomAction.title"
                @click="onPanelAction(ribbonBottomAction.id)"
              >
                <NmIcon :name="ribbonBottomAction.icon" :size="13" />
              </button>
            </template>
          </div>
          <div class="statusbar__right">
            <template v-if="layout.ribbonEnabled !== false && layout.ribbonPosition === 'statusbar-right'">
              <button
                v-for="r in ribbonActions"
                :key="`sbr-${r.id}`"
                class="st"
                :title="r.title"
                @click="onPanelAction(r.id)"
              >
                <NmIcon :name="r.icon" :size="13" />
              </button>
              <button
                class="st"
                :class="{ 'is-on': isPluginActive }"
                :title="ribbonBottomAction.title"
                @click="onPanelAction(ribbonBottomAction.id)"
              >
                <NmIcon :name="ribbonBottomAction.icon" :size="13" />
              </button>
            </template>
            <button class="st" title="点击复制字数" @click="copyNumberStat(wordCount.words, '字数')">
              字数 {{ formatCompactNumber(wordCount.words) }}
            </button>
            <button class="st" title="点击复制字符数" @click="copyNumberStat(wordCount.chars, '字符数')">
              字符 {{ formatCompactNumber(wordCount.chars) }}
            </button>
            <span class="st st--plain">阅读 {{ readingMinutes }} 分钟</span>

            <!--
              正文缩放（1.0.2）：
              - 点击展开预设比例 50/75/100/125/150/200/300，并支持手动输入百分比；
              - 正文区域 Ctrl + 滚轮每格 5%。
            -->
            <div class="zoomctl viewswitch">
              <button
                class="st zoomctl__btn"
                :title="`正文缩放 ${app.zoom}%（点击选择，Ctrl+滚轮可调整）`"
                aria-label="正文缩放"
                @click="zoomMenuOpen = !zoomMenuOpen"
              >
                <NmIcon name="search" :size="12" />
                <span>{{ app.zoom }}%</span>
              </button>
              <div v-if="zoomMenuOpen" class="zoomctl__menu" @mousedown.stop>
                <button
                  v-for="z in ZOOM_PRESETS"
                  :key="z"
                  class="zoomctl__item"
                  :class="{ 'is-active': z === app.zoom }"
                  @click="app.setZoom(z); zoomMenuOpen = false"
                >
                  <span>{{ z }}%</span>
                  <NmIcon v-if="z === app.zoom" name="check" :size="12" />
                </button>
                <div class="zoomctl__sep" />
                <form class="zoomctl__custom" @submit.prevent="applyCustomZoom">
                  <input
                    v-model="zoomInput"
                    class="zoomctl__input"
                    type="number"
                    min="50"
                    max="300"
                    step="5"
                    aria-label="自定义缩放比例"
                    placeholder="自定义"
                  />
                  <span class="zoomctl__unit">%</span>
                  <button class="zoomctl__apply" type="submit">应用</button>
                </form>
              </div>
            </div>

            <button class="st" title="AI 助手 Ctrl+Shift+A" @click="toggleAi">
              <NmIcon name="sparkles" :size="13" />
              <span v-if="auth.isLoggedIn && app.credits !== null">积分 {{ formatCompactNumber(app.credits) }}</span>
            </button>
          </div>
        </footer>
      </main>
    </template>

    <CommandPalette v-model="paletteOpen" :commands="paletteCommands" />
    <!-- 功能区右键菜单（隐藏/排序/位置） -->
    <RibbonContextMenu
      :open="ribbonMenu.open"
      :x="ribbonMenu.x"
      :y="ribbonMenu.y"
      :target-id="ribbonMenu.targetId"
      :target-label="ribbonMenu.targetLabel"
      :all-items="RIBBON_ALL_ITEMS"
      :enabled-ids="layout.ribbonItems ?? []"
      :position="layout.ribbonPosition"
      @close="closeRibbonMenu"
      @hide="ribbonHide"
      @move="ribbonMove"
      @toggle="ribbonToggle"
      @set-position="(p) => { settingsStore.updateLayout({ ribbonPosition: p }); closeRibbonMenu(); }"
      @disable-ribbon="settingsStore.updateLayout({ ribbonEnabled: false }); closeRibbonMenu()"
      @open-settings="openSettings('layout'); closeRibbonMenu()"
    />
    <InputDialog />
    <SearchPanel
      v-model="searchOpen"
      :results="searchResults"
      :query="searchQuery"
      @update:query="(q: string) => (searchQuery = q)"
      @open="(id: string) => { void openDocInMode(id); searchOpen = false; }"
      @replace-query="(q: string) => (searchQuery = q)"
    />
    
    <!-- 插件中心：功能区入口打开，承载内置插件开关 + 插件市场 + 我的 + 发布 + 开发指南 -->
    
    <HistoryModal v-model="historyOpen" :doc-id="activeTab?.docId ?? ''" />
    <ShareModal v-model="shareOpen" :doc-id="activeTab?.docId ?? ''" :title="activeTab?.title ?? ''" :content="activeTab?.content ?? ''" />
    <ConflictModal />

    <!-- 重命名弹窗（支持添加日期前缀、日期时间后缀与 AI 智能命名） -->
    <NmModal v-model="renameModal.open" title="重命名文档" :width="480">
      <div class="rename-box">
        <label class="nm-label">新文件名称（不含 .md 后缀）</label>
        <input
          v-model="renameModal.name"
          class="nm-input"
          placeholder="输入文档名称…"
          autofocus
          @keyup.enter="confirmRenameModal"
        />
        <div class="rename-quick">
          <span class="rename-quick__label">快捷命名：</span>
          <button type="button" class="nm-btn nm-btn--sm" @click="renameAddDatePrefix">
            <NmIcon name="calendar" :size="12" />添加今日日期前缀
          </button>
          <button type="button" class="nm-btn nm-btn--sm" @click="renameAddDatetimeSuffix">
            <NmIcon name="clock" :size="12" />追加时间戳后缀
          </button>
          <button
            type="button"
            class="nm-btn nm-btn--primary nm-btn--sm"
            :disabled="renameModal.aiLoading"
            @click="renameWithAi"
          >
            <NmIcon name="sparkles" :size="12" />
            {{ renameModal.aiLoading ? 'AI 生成中…' : 'AI 智能命名' }}
          </button>
        </div>
        <p v-if="renameModal.folder" class="nm-hint">所属目录：<code>{{ renameModal.folder }}/</code>（如需更改目录请使用右键「移动至文件夹」）</p>
      </div>
      <template #footer>
        <button class="nm-btn" @click="renameModal.open = false">取消</button>
        <button class="nm-btn nm-btn--primary" @click="confirmRenameModal">确定重命名</button>
      </template>
    </NmModal>

    <!-- 移动至文件夹弹窗（与重命名独立分离） -->
    <NmModal v-model="moveModal.open" title="移动文档至文件夹" :width="440">
      <div class="rename-box">
        <label class="nm-label">选择现有文件夹或输入新目录路径</label>
        <input
          v-model="moveModal.targetFolder"
          class="nm-input"
          placeholder="留空表示仓库根目录，或如：项目/设计"
          @keyup.enter="confirmMoveModal"
        />
        <div class="folder-chips">
          <button
            v-for="f in availableFolders"
            :key="f || '__root__'"
            type="button"
            class="folder-chip"
            :class="{ 'is-active': moveModal.targetFolder === f }"
            @click="moveModal.targetFolder = f"
          >
            <NmIcon name="folder" :size="12" />
            <span>{{ f || '仓库根目录 (/)' }}</span>
          </button>
        </div>
      </div>
      <template #footer>
        <button class="nm-btn" @click="moveModal.open = false">取消</button>
        <button class="nm-btn nm-btn--primary" @click="confirmMoveModal">确认移动</button>
      </template>
    </NmModal>

    <NmModal v-model="exportOpen" title="导出文档" :width="460">
      <div class="export">
        <button
          v-for="f in (['pdf', 'docx', 'html'] as const)"
          :key="f"
          class="export__item"
          :class="{ 'is-active': exportFormat === f }"
          @click="exportFormat = f"
        >
          <NmIcon :name="f === 'html' ? 'globe' : 'file'" :size="18" />
          <div>
            <strong>{{ f === 'pdf' ? 'PDF 文档' : f === 'docx' ? 'Word 文档 (.docx)' : 'HTML 网页' }}</strong>
            <span>{{ f === 'pdf' ? '桌面端由系统打印生成' : f === 'docx' ? '保留标题层级、列表与表格' : '单文件，可直接分享' }}</span>
          </div>
          <NmIcon v-if="exportFormat === f" name="check" :size="15" />
        </button>
      </div>
      <template #footer>
        <button class="nm-btn" @click="exportOpen = false">取消</button>
        <button class="nm-btn nm-btn--primary" :disabled="exportBusy" @click="doExport">
          {{ exportBusy ? '导出中…' : '开始导出' }}
        </button>
      </template>
    </NmModal>

    <Transition name="toast">
      <div v-if="app.toast" class="toast" :class="`toast--${app.toast.type}`">{{ app.toast.message }}</div>
    </Transition>

    <Teleport to="body">
      <div
        v-if="editorCtxMenu"
        class="editor-ctxmenu"
        :style="editorMenuPos(editorCtxMenu)"
        @mousedown.stop
        @click.stop
      >
        <button class="editor-ctxmenu__item" @click="runEditorCtx('cut')"><NmIcon name="edit" :size="13" /><span>剪切</span></button>
        <button class="editor-ctxmenu__item" @click="runEditorCtx('copy')"><NmIcon name="copy" :size="13" /><span>复制</span></button>
        <button class="editor-ctxmenu__item" @click="runEditorCtx('paste')"><NmIcon name="file" :size="13" /><span>粘贴</span></button>
        <button class="editor-ctxmenu__item" @click="runEditorCtx('paste-plain')">
          <NmIcon name="type" :size="13" /><span>粘贴为纯文本</span><kbd class="editor-ctxmenu__kbd">Ctrl+Shift+V</kbd>
        </button>
        <div class="editor-ctxmenu__sep" />
        <button class="editor-ctxmenu__item" @click="runEditorCtx('h1')"><NmIcon name="heading" :size="13" /><span>一级标题 Ctrl+1</span></button>
        <button class="editor-ctxmenu__item" @click="runEditorCtx('h2')"><NmIcon name="heading" :size="13" /><span>二级标题 Ctrl+2</span></button>
        <button class="editor-ctxmenu__item" @click="runEditorCtx('h3')"><NmIcon name="heading" :size="13" /><span>三级标题 Ctrl+3</span></button>
        <div class="editor-ctxmenu__sep" />
        <button class="editor-ctxmenu__item" @click="runEditorCtx('bold')"><NmIcon name="bold" :size="13" /><span>加粗 Ctrl+B</span></button>
        <button class="editor-ctxmenu__item" @click="runEditorCtx('italic')"><NmIcon name="italic" :size="13" /><span>斜体 Ctrl+I</span></button>
        <button class="editor-ctxmenu__item" @click="runEditorCtx('codeblock')"><NmIcon name="codeBlock" :size="13" /><span>代码块</span></button>
        <button class="editor-ctxmenu__item" @click="runEditorCtx('table')"><NmIcon name="table" :size="13" /><span>插入表格</span></button>
        <button class="editor-ctxmenu__item" @click="runEditorCtx('link')"><NmIcon name="link" :size="13" /><span>插入链接</span></button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg);
}
.shell__main {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
}
.shell__body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  min-width: 0;
}
.shell__work {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.shell__work-inner {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
}
.shell__left {
  flex: 0 0 auto;
  min-height: 0;
  /* 边框由 LeftPanel 根节点与拖拽手柄共同提供，这里不再重复画一条，
     否则与 .leftpanel 的 border-right 叠加成 2px，视觉上过粗。 */
}
.ribbon {
  width: 40px;
  flex: 0 0 40px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  /*
   * 顶部留白略大：桌面端这里作为窗口拖拽区，需要一小块稳定可拖的空白。
   * 底部 padding 必须是 0 —— 末位「插件商店」按钮用 margin-top: auto 贴底，
   * 若底部还有 padding，按钮会被顶起来一段（实测 8px），就不是「最下对齐」了。
   * 贴底按钮与上方按钮之间的间距由 `gap` 与按钮自身的 margin-top 共同决定。
   */
  padding: 14px 4px 0;
  background: var(--bg-sidebar);
}
.ribbon--left {
  border-right: 1px solid var(--border);
}
.ribbon--right {
  border-left: 1px solid var(--border);
}
.ribbon__btn {
  width: 30px;
  height: 30px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
}
.ribbon__btn:hover,
.ribbon__btn.is-on {
  background: var(--bg-hover);
  color: var(--accent);
}
.ribbon__btn.is-on {
  background: var(--bg-active);
}
/*
 * 功能区末位固定按钮（1.1.8）：竖排时贴底。
 *
 * 1.1.9 修「不贴底」：原来还挂着 `margin-bottom: 6px`，实测功能区高 770px、
 * 按钮底边 764px、距底 6px —— 用户看到的就是「差一点没到底」。
 * 用户要求「最下对齐」，因此把这段外边距归零，`margin-top: auto` 单独负责把它推到最下方。
 * `.ribbon` 自身的底部 padding 也必须是 0（见上方注释），否则同样会顶起 8px。
 * 左右两个停靠位共用这一个类，所以两边一起生效。
 */
.ribbon__btn--bottom {
  margin-top: auto;
  margin-bottom: 0;
}
.shell__doc {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.findbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
  flex: 0 0 auto;
}
.findbar__input {
  height: 26px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--fg);
  font-size: 12px;
  width: 160px;
}
.findbar__close {
  margin-left: auto;
  width: 24px;
  height: 24px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
}
.findbar__close:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
/*
 * 正文/设置/插件/图编辑器的容器行（1.1.9 修「分屏被吞或挤坏」）。
 *
 * `flex: 1 1 0%` 里的 **0% 是关键**：原来的 `flex: 1 1 auto` 意味着基准尺寸取
 * 内容宽度（auto），而设置页、插件商店、流程图这些子组件的最小内容宽度都很大
 * （设置页左侧导航 + 表单、插件商店 168px 导航 + 卡片网格），
 * 于是这个容器会被内容撑到超出可用宽度，同一行里的分屏第二栏就被挤出去 / 压成 0。
 * 改成 0% 基准后，容器严格按剩余空间分配，子组件自己负责内部滚动。
 *
 * `min-width: 0` 同理：flex item 默认 `min-width: auto`，不加这一条依然会被内容顶开。
 */
.shell__panes {
  flex: 1 1 0%;
  min-height: 0;
  min-width: 0;
  display: flex;
}
/*
 * 主栏里承载「设置 / 插件商店 / 图编辑器 / 正文」的那个子项也必须能收缩，
 * 否则上面 0% 基准省下来的空间又会被它自己顶回去。
 */
.shell__panes > .shell__content,
.shell__panes > :deep(.settings-page),
.shell__panes > :deep(.plugincenter-shell) {
  flex: 1 1 0%;
  min-width: 0;
  min-height: 0;
}
/*
 * 图编辑器（流程图 / 思维导图）也是 `.shell__panes` 的直接子项。
 *
 * 它们的根节点是纵向 flex 容器：一条 48px 工具栏 + 画布。画布的最小内容宽度
 * 由 SVG / 节点坐标决定，一旦不限制就会把父容器顶宽（用户报的「页面错乱 / 横向溢出」）。
 * 这里统一钉住布局契约：占满剩余空间、允许收缩、内部自己滚动。
 * 图组件自身的样式归 diagram 任务，所以只用 :deep 兜布局，不改它们的文件。
 */
.shell__panes > :deep(.flow),
.shell__panes > :deep(.mind) {
  flex: 1 1 0%;
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
/* 分屏第二栏里的图编辑器同理（它外面还多套一层 .splitpane__body） */
.shell__splitpane :deep(.flow),
.shell__splitpane :deep(.mind) {
  flex: 1 1 0%;
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.shell__panes--v {
  flex-direction: row;
}
.shell__panes--h {
  flex-direction: column;
}
.shell__splitpane {
  flex: 1 1 50%;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  background: var(--bg);
}
.shell__panes--h .shell__splitpane {
  border-left: none;
  border-top: 1px solid var(--border);
}
.splitpane__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 32px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--fg-2);
  background: var(--bg-sidebar);
}
.splitpane__close {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
}
.splitpane__close:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
/* 分屏第二栏自己的标签选择器（1.1.8） */
.splitpane__picker {
  position: relative;
  min-width: 0;
  flex: 1 1 auto;
  margin-right: 6px;
}
.splitpane__pickbtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  height: 22px;
  padding: 0 6px;
  border-radius: 5px;
  font-size: 12px;
  color: var(--fg-2);
}
.splitpane__pickbtn:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.splitpane__pickname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.splitpane__pickmenu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 700;
  min-width: 180px;
  max-height: 52vh;
  overflow-y: auto;
  padding: 5px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-3);
}
.splitpane__pickitem {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 9px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--fg);
  text-align: left;
}
.splitpane__pickitem:hover {
  background: var(--bg-hover);
}
.splitpane__pickitem.is-active {
  color: var(--accent);
  font-weight: 600;
}
.splitpane__picktext {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.splitpane__pickempty {
  margin: 6px 9px 8px;
  font-size: 12px;
  color: var(--fg-3);
}
.splitpane__pickgroup {
  padding: 5px 8px 3px;
  font-size: 10.5px;
  font-weight: 700;
  color: var(--fg-3);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.rightstack__pane {
  display: flex;
  flex-direction: column;
  min-height: 80px;
  overflow: hidden;
  border-bottom: 1px solid var(--border);
}
/*
 * 末位区块不画下边框（1.1.9）。
 *
 * 改前用 `:last-of-type` 判断，但堆叠容器里夹着 ResizeHandle（它根节点也是 div），
 * 于是「最后一个 div」永远是手柄而不是区块 —— 末位区块的下边框一直存在，
 * 加上手柄的边框，视觉上就是「最后一块下面多了一条线」。
 * 现在改由模板显式打 `--last`，不再依赖 DOM 顺序猜测。
 */
.rightstack__pane--last {
  border-bottom: none;
}
.rightstack__pane :deep(.rsection),
.rightstack__pane :deep(.ai) {
  flex: 1 1 auto;
  height: 100%;
  min-height: 0;
}
/*
 * 分屏第二栏的身体区（1.1.8）。
 * 改前是 `overflow-y: auto` + ReadView 预览；现在是真正的编辑器。
 * 编辑器自己带滚动（.wysiwyg / .source-editor__scroller），
 * 这里不能再设 overflow-y: auto，否则出现双滚动条、且内层滚不到底。
 */
.splitpane__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.splitpane__editor {
  flex: 1 1 auto;
  min-height: 0;
}
/*
 * 正文滚动区（1.1.7 修复「滚动条不在最右端」）。
 *
 * 这个容器必须**铺满整个编辑器区宽度**（右侧栏在场时到右侧栏左边界），
 * `overflow-y: auto` 才会把滚动条画在最右侧。
 * 页面宽度限制（窄 620 / 标准 760 / 宽 1080 / 铺满）已下沉到内层 `.shell__page`，
 * 由它做 max-width + margin:auto 实现「居中但不影响滚动条位置」。
 */
.shell__content {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
}
/*
 * 页面宽度层：只负责限制内容宽度并居中。
 * 四个 nm-page-* 类原本直接挂在滚动容器上，现在挂在这一层，语义保持不变。
 */
.shell__page {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin: 0 auto;
  width: 100%;
}
/*
 * 内层编辑器不再自己滚动 —— 滚动已上提到 `.shell__content`。
 * 若保留 `.wysiwyg` 的 overflow-y:auto，会出现「双滚动条」，
 * 且它的滚动条仍然贴在 760px 处（页面中间的旧问题）。
 */
.shell__page :deep(.wysiwyg) {
  height: auto;
  min-height: 100%;
  overflow-y: visible;
}
.shell__right {
  flex: 0 0 auto;
  min-height: 0;
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

/* 右侧栏顶部区块切换（1.0.2）：一排小图标，点击显隐对应功能区块 */
.righttabs {
  display: flex;
  align-items: center;
  gap: 1px;
  height: 30px;
  padding: 0 6px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
  flex: 0 0 auto;
  overflow-x: auto;
  scrollbar-width: none;
}
.righttabs::-webkit-scrollbar {
  display: none;
}
.righttabs__btn {
  width: 24px;
  height: 22px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
  flex: 0 0 auto;
}
.righttabs__btn:hover {
  background: var(--bg-hover);
  color: var(--fg-2);
}
.righttabs__btn.is-on {
  background: var(--bg-active);
  color: var(--accent);
}
/* 标签条最右侧的关闭按钮（1.1.8）：与功能图标分开，避免误点成切换 */
.righttabs__btn--close {
  margin-left: auto;
  color: var(--fg-3);
}
.righttabs__btn--close:hover {
  background: var(--bg-hover);
  color: var(--fg);
}

/* 区块堆叠容器：可整体滚动，各区块内部再各自滚动 */
/*
 * 右侧栏内容区（1.1.8）。
 *
 * 因为已改为「一次只显示一个区块」，这里不再需要处理多个区块上下堆叠时的高度分配：
 * 单个区块占满剩余高度，区块内部的 `.rsection__body` / `.ai__*` 自己滚动。
 * `overflow-y: auto` 保留为兜底（区块内容异常长时不至于撑破侧栏）。
 */
.rightstack {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
/* 所有区块都被关掉时的提示 */
.rightstack__empty {
  margin: 16px 14px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--fg-3);
}
.statusbar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 30px;
  padding: 0 10px;
  border-top: 1px solid var(--border);
  background: var(--bg-sidebar);
  font-size: 11px;
  color: var(--fg-3);
  flex: 0 0 auto;
}
.statusbar__left,
.statusbar__right {
  display: flex;
  align-items: center;
  gap: 4px;
}
.statusbar__left {
  flex: 1;
}
.st {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 6px;
  border-radius: 5px;
  color: var(--fg-3);
  font-size: 11px;
  white-space: nowrap;
}
.st:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.st--plain {
  cursor: default;
}
.st--plain:hover {
  background: transparent;
  color: var(--fg-3);
}
.st--path {
  max-width: 340px;
}
/*
 * 同步状态按钮（1.1.7）：从 span 改成 button 后要有可点击的视觉反馈，
 * 否则用户仍然会以为它只是一段文字。
 */
.st--sync {
  cursor: pointer;
}
.st--sync:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.st--sync.is-syncing {
  color: var(--accent);
}
.st--sync.is-syncing :deep(.nm-icon) {
  animation: nm-sync-spin 1.1s linear infinite;
}
.st--sync.is-error {
  color: #d93025;
}
@keyframes nm-sync-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* ---------------- 状态栏正文缩放控件（1.0.2） ---------------- */
.zoomctl {
  position: relative;
}
.zoomctl__btn {
  gap: 3px;
  font-variant-numeric: tabular-nums;
}
.zoomctl__menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 700;
  width: 132px;
  padding: 5px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-3);
}
.zoomctl__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 6px 9px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--fg);
  text-align: left;
}
.zoomctl__item:hover {
  background: var(--bg-hover);
}
.zoomctl__item.is-active {
  color: var(--accent);
  font-weight: 600;
}
.zoomctl__sep {
  height: 1px;
  background: var(--border);
  margin: 4px 2px;
}
.zoomctl__custom {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px 2px;
}
.zoomctl__input {
  width: 100%;
  height: 24px;
  padding: 0 6px;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: var(--bg-input);
  font-size: 11.5px;
  outline: none;
}
.zoomctl__input:focus {
  border-color: var(--accent);
}
.zoomctl__unit {
  font-size: 11px;
  color: var(--fg-3);
}
.zoomctl__apply {
  height: 24px;
  padding: 0 7px;
  border-radius: 5px;
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  flex: 0 0 auto;
}
.st__path-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}
.rename-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rename-quick {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 4px;
}
.rename-quick__label {
  font-size: 12px;
  color: var(--fg-3);
}
.folder-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}
.folder-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg-sidebar);
  font-size: 12px;
  color: var(--fg-2);
}
.folder-chip.is-active {
  border-color: var(--accent);
  background: var(--accent-weak-2);
  color: var(--accent);
  font-weight: 600;
}
.boot {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--fg-3);
  font-size: 13px;
}
.boot__logo {
  width: 46px;
  height: 46px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #1677ff, #4a9bff);
  color: #fff;
  font-size: 22px;
  font-weight: 700;
  box-shadow: 0 6px 20px rgba(22, 119, 255, 0.32);
}
.boot__error {
  color: #d93025;
  max-width: 440px;
  text-align: center;
  line-height: 1.7;
}
/* 首屏阶段文案：主文案略深，提示语更淡，避免转圈时只剩一句笼统提示 */
.boot__phase {
  color: var(--fg-2);
  font-size: 13px;
}
.boot__tip {
  color: var(--fg-3);
  font-size: 11.5px;
}

/* ---------------- 启动骨架屏（1.1.8） ---------------- */
/*
 * 目标：让用户在 100ms 内看到「编辑器已经打开了」的版式，
 * 而不是一个居中的转圈文字。骨架用与真实布局同构的比例，
 * 内容就绪后原地替换，不产生布局跳动。
 */
.skel {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg);
  overflow: hidden;
}
.skel__bar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
.skel__dot {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--accent);
  opacity: 0.75;
  flex: 0 0 auto;
}
.skel__spacer { flex: 1 1 auto; }
.skel__body {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
}
.skel__side {
  width: 260px;
  flex: 0 0 260px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 14px 12px;
  border-right: 1px solid var(--border);
  background: var(--bg-sidebar);
}
.skel__search {
  height: 26px;
  border-radius: 6px;
  background: var(--bg-hover);
  margin-bottom: 4px;
}
.skel__row {
  height: 12px;
  border-radius: 4px;
  background: var(--bg-hover);
}
.skel__main {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 34px min(12vw, 160px);
  min-width: 0;
}
.skel__title {
  height: 26px;
  width: 46%;
  border-radius: 6px;
  background: var(--bg-hover);
  margin-bottom: 6px;
}
.skel__line {
  height: 12px;
  border-radius: 4px;
  background: var(--bg-hover);
}
.skel__line--w120 { width: 120px; }
.skel__line--w80 { width: 80px; }
.skel__line--w90 { width: 90%; }
.skel__line--w70 { width: 70%; }
.skel__line--w60 { width: 60%; }
.skel__line--w40 { width: 40%; }
/* 呼吸动画：让骨架看起来「在加载」而不是「卡住了」 */
.skel__row,
.skel__line,
.skel__title,
.skel__search {
  animation: skel-pulse 1.4s ease-in-out infinite;
}
@keyframes skel-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
/* 阶段文案固定在右下角，不遮挡骨架也不抢焦点 */
.skel__phase {
  position: absolute;
  right: 16px;
  bottom: 12px;
  margin: 0;
  font-size: 11.5px;
  color: var(--fg-3);
}
@media (max-width: 900px) {
  .skel__side { width: 180px; flex-basis: 180px; }
  .skel__main { padding: 24px 20px; }
}
/* 尊重系统「减少动态效果」偏好 */
@media (prefers-reduced-motion: reduce) {
  .skel__row,
  .skel__line,
  .skel__title,
  .skel__search {
    animation: none;
  }
}
/*
 * 正文加载占位（1.1.9）。
 *
 * 比整页骨架轻得多：只有标题行 + 三行正文的灰条，且**不覆盖**外壳。
 * 用户此时已经能点左侧文件、切标签、用工具栏，看到这几条灰条只说明「这篇还在读」。
 */
.docboot {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 40px 32px;
  min-height: 220px;
}
.docboot__title,
.docboot__line {
  height: 13px;
  border-radius: 5px;
  background: var(--bg-hover);
  animation: skel-pulse 1.4s ease-in-out infinite;
}
.docboot__title {
  height: 22px;
  width: 38%;
  margin-bottom: 10px;
  border-bottom: 1px solid var(--border);
}
.docboot__line {
  width: 100%;
}
.docboot__line--w90 { width: 90%; }
.docboot__line--w70 { width: 70%; }
.docboot__phase {
  margin: 10px 0 0;
  font-size: 11.5px;
  color: var(--fg-3);
}
@media (prefers-reduced-motion: reduce) {
  .docboot__title,
  .docboot__line {
    animation: none;
  }
}
.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--fg-3);
}
.empty__mark {
  width: 54px;
  height: 54px;
  border-radius: 14px;
  display: grid;
  place-items: center;
  background: var(--accent-weak);
  color: var(--accent);
  font-size: 24px;
  font-weight: 700;
}
.empty h2 {
  margin: 6px 0 0;
  font-size: 17px;
  color: var(--fg);
}
.empty p {
  margin: 0;
  font-size: 13px;
}
.empty__row {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}
.export {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.export__item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  text-align: left;
  color: var(--fg);
}
.export__item.is-active {
  border-color: var(--accent);
  background: var(--accent-weak-2);
}
.export__item div {
  display: flex;
  flex-direction: column;
  flex: 1;
}
.export__item strong {
  font-size: 13.5px;
}
.export__item span {
  font-size: 11.5px;
  color: var(--fg-3);
  margin-top: 2px;
}
.toast {
  position: fixed;
  bottom: 46px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9500;
  padding: 9px 16px;
  border-radius: 9px;
  font-size: 13px;
  background: var(--bg-elevated);
  color: var(--fg);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-3);
  max-width: min(560px, calc(100vw - 32px));
}
.toast--success { border-color: rgba(14,159,110,.4); color: #0e9f6e; }
.toast--error { border-color: rgba(217,48,37,.4); color: #d93025; }
.toast-enter-active, .toast-leave-active { transition: opacity .16s ease, transform .16s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translate(-50%, 8px); }
.is-narrow .shell__left, .is-narrow .shell__right { display: none; }
.editor-ctxmenu {
  position: fixed;
  z-index: 9200;
  min-width: 190px;
  padding: 5px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-3);
}
.editor-ctxmenu__item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--fg);
  text-align: left;
}
.editor-ctxmenu__item:hover {
  background: var(--bg-hover);
}
.editor-ctxmenu__kbd {
  margin-left: auto;
  padding-left: 12px;
  font-family: var(--font-ui);
  font-size: 10.5px;
  color: var(--fg-3);
}
.editor-ctxmenu__sep {
  height: 1px;
  background: var(--border);
  margin: 4px 2px;
}
</style>
