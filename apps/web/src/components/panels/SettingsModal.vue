<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NmIcon, NmModal } from '@neomd/ui';
import { useSettingsStore } from '@/stores/settings';
import { useAuthStore } from '@/stores/auth';
import { useAppStore } from '@/stores/app';
import { AIClient, detectRuntime, getBridge, defaultSettings, DEFAULT_TOOLBAR_ITEMS, DEFAULT_AI_TITLE_PROMPT } from '@neomd/core';
import { AI_PRESETS, STORAGE_PRESETS, getStoragePreset, getAIPreset, type EditorColorScheme, type Settings } from '@neomd/shared';
import { settingsApi, profileApi, uploadApi, aiApi, type OssProbeStepDto } from '@/api/client';
import { SITE_URL } from '@/env';

const props = defineProps<{ modelValue: boolean; initialTab?: string }>();
const emit = defineEmits<{ 'update:modelValue': [boolean] }>();

const settingsStore = useSettingsStore();
const auth = useAuthStore();
const app = useAppStore();

/**
 * 兜底默认值：所有从 settings 读取的嵌套对象都经由下方 computed 兜底。
 * 历史数据（旧版 localStorage / 云端旧 payload）可能缺少某个子对象，
 * 直接访问 `settings.xxx.yyy` 会抛错导致整页白屏。
 */
const FALLBACK = defaultSettings();

type TabId =
  | 'general'
  | 'editor'
  | 'layout'
  | 'shortcuts'
  | 'storage'
  | 'ai'
  | 'sync'
  | 'account';
const tab = ref<TabId>('general');
const ALL_TABS: Array<{ id: TabId; label: string; icon: string; nativeOnly?: boolean }> = [
  { id: 'general', label: '通用', icon: 'settings' },
  { id: 'editor', label: '编辑器', icon: 'type' },
  { id: 'layout', label: '界面布局', icon: 'layout' },
  { id: 'shortcuts', label: '快捷键', icon: 'command' },
  { id: 'storage', label: '对象存储', icon: 'cloud', nativeOnly: true },
  { id: 'ai', label: 'AI', icon: 'sparkles', nativeOnly: true },
  { id: 'sync', label: '同步与版本', icon: 'sync' },
  { id: 'account', label: '账号', icon: 'user', nativeOnly: true },
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
const modalWidth = computed<number | string>(() => (isNarrow.value ? '100%' : 880));

let narrowQuery: MediaQueryList | null = null;
function onNarrowChange(e: MediaQueryListEvent): void {
  isNarrow.value = e.matches;
}

onBeforeUnmount(() => {
  if (savedHintTimer) clearTimeout(savedHintTimer);
  narrowQuery?.removeEventListener?.('change', onNarrowChange);
});

/* --------------------------- 设置对象兜底读取 --------------------------- */

const storage = computed(() => settingsStore.settings.storage ?? FALLBACK.storage);
const ai = computed(() => settingsStore.settings.ai ?? FALLBACK.ai);
const appearance = computed(() => settingsStore.settings.appearance ?? FALLBACK.appearance);
const naming = computed(() => settingsStore.settings.naming ?? FALLBACK.naming);
const autosave = computed(
  () => settingsStore.settings.autosave ?? FALLBACK.autosave ?? { enabled: true, versionMinutes: 5, versionChars: 300 },
);
const layout = computed(() => settingsStore.settings.layout ?? FALLBACK.layout);
const sync = computed(() => settingsStore.settings.sync ?? FALLBACK.sync);
const shortcuts = computed(() => settingsStore.settings.shortcuts ?? []);

/** 本地仓库落盘策略（仅 PC 端有效） */
const localVault = computed(() => settingsStore.settings.localVault ?? FALLBACK.localVault ?? { root: '', keepVersions: false });
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

const COLOR_SCHEMES: Array<{ id: EditorColorScheme; label: string; bg: string; fg: string }> = [
  { id: 'white', label: '白色', bg: '#ffffff', fg: '#1f2329' },
  { id: 'gray', label: '灰色', bg: '#f3f4f6', fg: '#1f2937' },
  { id: 'black', label: '黑色', bg: '#14171c', fg: '#e5e7eb' },
  { id: 'green', label: '绿色护眼', bg: '#e8f5e9', fg: '#1b3a24' },
  { id: 'lightblue', label: '浅蓝色', bg: '#ebf5ff', fg: '#132a4a' },
  { id: 'custom', label: '自定义配色', bg: '#ffffff', fg: '#1f2329' },
];

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
  settingsStore.updateLayout({ toolbarItems: next });
  flashSaved();
}

function moveToolbarItem(id: string, dir: -1 | 1): void {
  const cur = [...toolbarItems.value];
  const idx = cur.indexOf(id);
  if (idx === -1) return;
  const target = idx + dir;
  if (target < 0 || target >= cur.length) return;
  const tmp = cur[idx]!;
  cur[idx] = cur[target]!;
  cur[target] = tmp;
  settingsStore.updateLayout({ toolbarItems: cur });
  flashSaved();
}

function updateAutosave(patch: Partial<{ enabled: boolean; versionMinutes: number; versionChars: number }>): void {
  settingsStore.update({ autosave: { ...autosave.value, ...patch } });
  flashSaved();
}

/** 统一的外观改动入口：写入 + 即时反馈 */
function patchAppearance(patch: Partial<typeof appearance.value>): void {
  settingsStore.updateAppearance(patch);
  flashSaved();
}

/** 统一的布局改动入口：写入 + 即时反馈 */
function patchLayout(patch: Partial<typeof layout.value>): void {
  settingsStore.updateLayout(patch);
  flashSaved();
}

/** 统一的设置改动入口：写入 + 即时反馈 */
function patchSettings(patch: Parameters<typeof settingsStore.update>[0]): void {
  settingsStore.update(patch);
  flashSaved();
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
  settingsStore.update({
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
  flashSaved('已切换服务商');
}

function onRegionChange(region: string): void {
  const preset = getStoragePreset(storage.value.provider);
  settingsStore.update({ storage: { ...storage.value, region, endpoint: preset.endpointFor(region) } });
  flashSaved();
}

function onAIProviderChange(id: string): void {
  const preset = getAIPreset(id as typeof ai.value.provider);
  const isPlatform = id === 'platform';
  settingsStore.update({
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
  flashSaved('已切换供应商');
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
  settingsStore.update({ ai: { ...ai.value, models: nextSelected, model: defaultM } });
}

function toggleModel(m: string): void {
  const cur = ai.value.models ?? [];
  const list = cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m];
  settingsStore.update({ ai: { ...ai.value, models: list } });
  flashSaved();
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
  settingsStore.updateLayout({ ribbonItems: items });
  flashSaved();
}

function toggleRightSection(sec: 'ai' | 'file'): void {
  const cur = rightPanelSections.value;
  const next = cur.includes(sec)
    ? cur.length > 1
      ? cur.filter((x) => x !== sec)
      : cur
    : [...cur, sec];
  settingsStore.updateLayout({ rightPanelSections: next });
  flashSaved();
}

/* --------------------------- 危险操作（需确认） --------------------------- */

/** 清空对象存储密钥 */
function clearStorageSecrets(): void {
  askConfirm({
    title: '清空对象存储密钥',
    message: '将清空已保存的 AccessKey ID 与 AccessKey Secret，云端同步的密钥也会被覆盖。确定继续？',
    confirmText: '清空密钥',
    action: () => {
      settingsStore.setStorageKeyId('');
      settingsStore.setSecret('storage', '');
      resetProbe();
      flashSaved('已清空存储密钥');
    },
  });
}

/** 清空 AI API Key */
function clearAiKey(): void {
  askConfirm({
    title: '清空 AI API Key',
    message: '将清空已保存的 AI API Key，之后无法再调用第三方 AI 服务（平台积分模式不受影响）。确定继续？',
    confirmText: '清空 Key',
    action: () => {
      settingsStore.setSecret('ai', '');
      resetAiTest();
      flashSaved('已清空 AI Key');
    },
  });
}

/** 重置全部快捷键 */
function resetShortcuts(): void {
  askConfirm({
    title: '重置快捷键',
    message: '将清空所有自定义快捷键绑定，恢复为默认组合键。此操作不可撤销。',
    confirmText: '重置快捷键',
    action: () => {
      settingsStore.update({ shortcuts: FALLBACK.shortcuts });
      flashSaved('已重置快捷键');
    },
  });
}

/** 恢复全部设置为默认值（保留账号与密钥） */
function resetAllSettings(): void {
  askConfirm({
    title: '恢复默认设置',
    message: '将把外观、命名、布局、快捷键、插件开关等全部恢复为默认值；对象存储与 AI 的账号密钥不会被清除。确定继续？',
    confirmText: '恢复默认',
    action: () => {
      settingsStore.update({
        appearance: FALLBACK.appearance,
        naming: FALLBACK.naming,
        autosave: FALLBACK.autosave,
        layout: FALLBACK.layout,
        shortcuts: FALLBACK.shortcuts,
        enabledPlugins: { ...FALLBACK.enabledPlugins },
        sync: { ...sync.value },
      });
      flashSaved('已恢复默认设置');
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
  settingsStore.update({
    shortcuts: shortcuts.value.map((s) => (s.command === command ? { ...s, keys: [combo] } : s)),
  });
  captureCommand.value = null;
  flashSaved('快捷键已更新');
}

/** 打开设置时初始化：重置检测态、同步账号字段、按当前宽度决定弹窗尺寸 */
watch(
  () => props.modelValue,
  (v) => {
    if (!v) return;
    const requested = (props.initialTab as TabId) ?? 'general';
    if (runtime.platform === 'web' && (requested === 'storage' || requested === 'ai' || requested === 'account')) {
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
    // 窄屏判定统一在这里同步一次，避免首次打开闪一下宽弹窗
    isNarrow.value = typeof window !== 'undefined' ? window.matchMedia('(max-width: 760px)').matches : false;
  },
);

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

void app;
</script>
<template>
  <NmModal
    :model-value="modelValue"
    title="设置"
    :width="modalWidth"
    @update:model-value="emit('update:modelValue', $event)"
  >
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
          <h3 class="pane__title">外观</h3>
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
          </div>
          <div class="field">
            <label class="nm-label">主色调</label>
            <div class="swatches">
              <button
                v-for="c in ['#1677FF', '#0E9F6E', '#7C4DFF', '#FF8A3D', '#E5484D']"
                :key="c"
                type="button"
                class="swatch"
                :class="{ 'is-active': appearance.accent === c }"
                :style="{ background: c }"
                :title="`主色调 ${c}`"
                :aria-label="`主色调 ${c}`"
                @click="patchAppearance({ accent: c })"
              />
            </div>
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
        <section v-else-if="tab === 'editor'" class="pane">
          <h3 class="pane__title">排版与行号</h3>
          <div class="field field--row">
            <div>
              <label class="nm-label">编辑器字号</label>
              <p class="nm-hint">影响正文与源码视图</p>
            </div>
            <input
              class="nm-input nm-input--num"
              type="number"
              min="12"
              max="24"
              :value="appearance.fontSize"
              aria-label="编辑器字号"
              @input="patchAppearance({ fontSize: Number(($event.target as HTMLInputElement).value) })"
            />
          </div>
          <div class="field field--row">
            <div>
              <label class="nm-label">行高</label>
              <p class="nm-hint">建议 1.6 – 1.9</p>
            </div>
            <input
              class="nm-input nm-input--num"
              type="number"
              step="0.05"
              min="1.2"
              max="2.4"
              :value="appearance.lineHeight"
              aria-label="行高"
              @input="patchAppearance({ lineHeight: Number(($event.target as HTMLInputElement).value) })"
            />
          </div>
          <div class="field field--row">
            <div>
              <label class="nm-label">显示正文行号</label>
              <p class="nm-hint">开启后在正文与源码编辑器左侧显示行号</p>
            </div>
            <button
              type="button"
              class="toggle-btn"
              :class="{ 'is-on': appearance.showLineNumbers }"
              :title="appearance.showLineNumbers ? '关闭正文行号' : '开启正文行号'"
              :aria-pressed="appearance.showLineNumbers"
              @click="patchAppearance({ showLineNumbers: !appearance.showLineNumbers })"
            >
              {{ appearance.showLineNumbers ? '开' : '关' }}
            </button>
          </div>
          <div class="field">
            <label class="nm-label">默认页宽</label>
            <div class="seg">
              <button
                v-for="w in (['narrow', 'standard', 'wide', 'full'] as const)"
                :key="w"
                type="button"
                class="seg__item"
                :class="{ 'is-active': appearance.pageWidth === w }"
                @click="patchAppearance({ pageWidth: w })"
              >
                {{ w === 'narrow' ? '窄' : w === 'standard' ? '标准' : w === 'wide' ? '宽' : '铺满' }}
              </button>
            </div>
          </div>

          <h3 class="pane__title">正文配色方案</h3>
          <div class="field">
            <div class="scheme-grid">
              <button
                v-for="sc in COLOR_SCHEMES"
                :key="sc.id"
                type="button"
                class="scheme-card"
                :class="{ 'is-active': (appearance.editorColorScheme ?? 'white') === sc.id }"
                :title="`正文配色：${sc.label}`"
                @click="patchAppearance({ editorColorScheme: sc.id })"
              >
                <span
                  class="scheme-preview"
                  :style="{
                    background: sc.id === 'custom' ? (appearance.customEditorBg || '#ffffff') : sc.bg,
                    color: sc.id === 'custom' ? (appearance.customEditorFg || '#1f2329') : sc.fg,
                  }"
                >Aa</span>
                <span>{{ sc.label }}</span>
              </button>
            </div>
          </div>
          <div v-if="appearance.editorColorScheme === 'custom'" class="grid2">
            <div class="field">
              <label class="nm-label">自定义正文背景色</label>
              <input
                type="color"
                class="nm-input"
                :value="appearance.customEditorBg || '#ffffff'"
                aria-label="自定义正文背景色"
                @input="patchAppearance({ customEditorBg: ($event.target as HTMLInputElement).value })"
              />
            </div>
            <div class="field">
              <label class="nm-label">自定义正文文字色</label>
              <input
                type="color"
                class="nm-input"
                :value="appearance.customEditorFg || '#1f2329'"
                aria-label="自定义正文文字色"
                @input="patchAppearance({ customEditorFg: ($event.target as HTMLInputElement).value })"
              />
            </div>
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
            <label class="nm-label">工具栏按钮显隐与排序</label>
            <div class="tb-config-list">
              <div v-for="item in orderedToolbarDefs" :key="item.id" class="tb-config-row">
                <button
                  type="button"
                  class="model-chip"
                  :class="{ 'is-on': item.enabled }"
                  :title="item.enabled ? `隐藏「${item.label}」` : `显示「${item.label}」`"
                  @click="toggleToolbarItem(item.id)"
                >
                  {{ item.enabled ? '✓ ' : '' }}{{ item.label }}
                </button>
                <div v-if="item.enabled" class="tb-config-Read">
                  <button
                    type="button"
                    class="nm-btn nm-btn--sm"
                    title="前移"
                    aria-label="前移"
                    @click="moveToolbarItem(item.id, -1)"
                  >↑</button>
                  <button
                    type="button"
                    class="nm-btn nm-btn--sm"
                    title="后移"
                    aria-label="后移"
                    @click="moveToolbarItem(item.id, 1)"
                  >↓</button>
                </div>
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
              <label class="nm-label">面板宽度</label>
            </div>
            <input
              class="nm-input nm-input--num"
              type="number"
              min="180"
              max="480"
              :value="layout.leftPanelWidth"
              aria-label="左侧面板宽度"
              @input="patchLayout({ leftPanelWidth: Number(($event.target as HTMLInputElement).value) })"
            />
          </div>

          <h3 class="pane__title">右侧面板</h3>
          <div class="field">
            <label class="nm-label">允许在右侧边栏显示的功能</label>
            <div class="seg">
              <button
                type="button"
                class="seg__item"
                :class="{ 'is-active': rightPanelSections.includes('ai') }"
                @click="toggleRightSection('ai')"
              >
                AI 助手
              </button>
              <button
                type="button"
                class="seg__item"
                :class="{ 'is-active': rightPanelSections.includes('file') }"
                @click="toggleRightSection('file')"
              >
                文件操作
              </button>
            </div>
            <p class="nm-hint">搜索与大纲统一放在左侧边栏，右侧边栏仅展示 AI 与文件操作相关功能。</p>
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

          <div class="field">
            <label class="nm-label">选择 AI 供应商</label>
            <div class="providers">
              <button
                v-for="p in AI_PRESETS"
                :key="p.id"
                type="button"
                class="provider"
                :class="{ 'is-active': (ai.usePlatform ? 'platform' : ai.provider) === p.id }"
                :title="p.name"
                @click="onAIProviderChange(p.id)"
              >
                {{ p.name }}
              </button>
            </div>
          </div>

          <template v-if="ai.provider === 'platform' || ai.usePlatform">
            <p class="nm-hint">已启用「平台积分」作为 AI 供应商，按管理员后台配置的模型与计费方式扣积分调用。</p>
          </template>
          <template v-else>
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
          </template>

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

        <!-- 同步 -->
        <section v-else-if="tab === 'sync'" class="pane">
          <h3 class="pane__title">同步与版本</h3>
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
          <h3 class="pane__title">手动同步</h3>
          <p class="nm-hint">日常无需手动操作；以下按钮用于排查多端不一致问题。</p>
          <div class="actions-row">
            <button
              type="button"
              class="nm-btn nm-btn--sm"
              :disabled="saving || !auth.isLoggedIn"
              :title="!auth.isLoggedIn ? '请先登录后再同步设置' : '把当前设置上传到云端'"
              @click="syncToCloud"
            >
              {{ saving ? '处理中…' : '上传设置到云端' }}
            </button>
            <button
              type="button"
              class="nm-btn nm-btn--sm"
              :disabled="saving || !auth.isLoggedIn"
              :title="!auth.isLoggedIn ? '请先登录后再恢复设置' : '用云端设置覆盖本机'"
              @click="pullFromCloud"
            >
              {{ saving ? '处理中…' : '从云端恢复设置' }}
            </button>
          </div>
          <p v-if="saveMessage" class="probe-box" :class="{ 'is-ok': saveMessageOk }" role="status" aria-live="polite">
            <span>{{ saveMessage }}</span>
          </p>
        </section>

        <!-- 账号 -->
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
            <button class="nm-btn nm-btn--primary" @click="emit('update:modelValue', false); $router.push('/login')">前往登录</button>
          </template>
        </section>
      </div>
    </div>

    <template #footer>
      <span class="settings__foot-hint">设置改动即时生效并自动同步；对象存储与 AI 检测均由服务端代探。</span>
      <button type="button" class="nm-btn" title="关闭设置" @click="emit('update:modelValue', false)">关闭</button>
    </template>
  </NmModal>

  <!-- 危险操作二次确认 -->
  <NmModal v-model="confirmDialog.open" :title="confirmDialog.title" :width="440">
    <p class="confirm-text">{{ confirmDialog.message }}</p>
    <template #footer>
      <button type="button" class="nm-btn" @click="confirmDialog.open = false">取消</button>
      <button type="button" class="nm-btn nm-btn--danger" @click="runConfirm">{{ confirmDialog.confirmText }}</button>
    </template>
  </NmModal>
</template>

<style scoped>
.settings {
  display: grid;
  grid-template-columns: 176px 1fr;
  margin: -4px -20px -18px;
  height: 68vh;
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

.scheme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
  gap: 8px;
}
.scheme-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  font-size: 12px;
  color: var(--fg-2);
}
.scheme-card.is-active {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
  background: var(--accent-weak-2);
}
.scheme-preview {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: 1px solid var(--border);
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 700;
  flex: 0 0 auto;
}
.tb-config-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(185px, 1fr));
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.tb-config-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}
.tb-config-Read {
  display: inline-flex;
  gap: 2px;
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

/* 窄屏 / 移动端：弹窗近似全屏、页签横向滚动，禁止横向溢出 */
@media (max-width: 760px) {
  .settings {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
    height: calc(100vh - 150px);
    min-height: 420px;
    margin: -4px -14px -14px;
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
</style>
