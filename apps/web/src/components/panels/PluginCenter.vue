<script setup lang="ts">
/**
 * 插件中心（独立模态）
 *
 * 从「设置面板」与「个人中心」迁出的统一插件入口，包含 5 个子页签：
 * - market  插件市场：浏览社区开发者发布的插件，一键安装 / 点赞
 * - my      我的插件：开发者中心，查看自己提交插件的安装量、获赞与状态
 * - publish 发布插件：新建或更新插件版本
 * - guide   开发指南：Host API 说明 + 可复制的 AI 生成提示词
 * - builtin 内置插件：官方内置插件开关（原设置面板「插件」页签）
 *
 * 所有网络请求与状态均在组件内部自管，不依赖父组件传参（仅 open 走 v-model:open）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { NmIcon, NmModal } from '@neomd/ui';
import { PLUGINS, formatCompactNumber, type PluginManifest } from '@neomd/shared';
import { pluginsApi, type CommunityPluginDto } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useSettingsStore } from '@/stores/settings';

const props = defineProps<{
  open?: boolean;
  /**
   * 嵌入式模式（1.0.2）：为 true 时不套 NmModal，直接铺满父容器。
   * 用于「功能区点击插件商店 → 在编辑器内新开标签页」的场景。
   */
  embedded?: boolean;
}>();
const emit = defineEmits<{ 'update:open': [boolean] }>();

const auth = useAuthStore();
const settingsStore = useSettingsStore();

type SubTab = 'market' | 'my' | 'publish' | 'guide' | 'builtin';

const SUB_TABS: Array<{ id: SubTab; label: string; icon: string }> = [
  { id: 'market', label: '插件市场', icon: 'globe' },
  { id: 'my', label: '我的插件', icon: 'layers' },
  { id: 'publish', label: '发布插件', icon: 'upload' },
  { id: 'guide', label: '开发指南', icon: 'book' },
  { id: 'builtin', label: '内置插件', icon: 'settings' },
];

const subTab = ref<SubTab>('market');

/* ------------------------------ 轻提示 ------------------------------ */

const notice = ref('');
const noticeIsError = ref(false);
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

/** 顶部轻提示（3.6 秒自动消失），失败用红色样式 */
function flash(msg: string, isError = false): void {
  notice.value = msg;
  noticeIsError.value = isError;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = '';
    noticeTimer = null;
  }, 3600);
}

onBeforeUnmount(() => {
  if (noticeTimer) clearTimeout(noticeTimer);
});

/* --------------------------- 已安装社区插件 --------------------------- */

const INSTALLED_KEY = 'neomd.communityPlugins.v1';

interface InstalledCommunityPlugin {
  pluginId: string;
  name: string;
  version: string;
  description: string;
  codeJs: string;
}

/** 读取本地已安装的社区插件清单（localStorage 损坏时降级为空列表） */
function loadInstalledCommunityIds(): string[] {
  try {
    const raw = localStorage.getItem(INSTALLED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x) => (x && typeof x === 'object' ? (x as { pluginId?: unknown }).pluginId : undefined))
      .filter((id): id is string => typeof id === 'string' && Boolean(id));
  } catch {
    return [];
  }
}

const installedCommunityIds = ref<string[]>(loadInstalledCommunityIds());

/** 写入本地已安装列表并立即启用该插件 */
function saveInstalledCommunityPlugin(item: InstalledCommunityPlugin): void {
  try {
    const raw = localStorage.getItem(INSTALLED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(parsed) ? (parsed as InstalledCommunityPlugin[]) : [];
    const filtered = list.filter((x) => x?.pluginId !== item.pluginId);
    filtered.push(item);
    localStorage.setItem(INSTALLED_KEY, JSON.stringify(filtered));
    installedCommunityIds.value = filtered.map((x) => x.pluginId);
    settingsStore.togglePlugin(item.pluginId, true);
  } catch {
    flash('本地存储不可用，插件仅在本次会话内生效', true);
  }
}

/* ---------------------------- 市场 / 我的 ---------------------------- */

const marketPlugins = ref<CommunityPluginDto[]>([]);
const myPlugins = ref<CommunityPluginDto[]>([]);
const myPluginStats = ref({ publishedCount: 0, totalCount: 0, totalDownloads: 0, totalStars: 0 });
const marketLoading = ref(false);
const myLoading = ref(false);
const marketError = ref('');

/** 拉取社区插件市场（公开接口，未登录也可浏览） */
async function loadMarket(): Promise<void> {
  marketLoading.value = true;
  marketError.value = '';
  try {
    const res = await pluginsApi.market();
    marketPlugins.value = res.items ?? [];
  } catch (e) {
    marketError.value = `插件市场加载失败：${(e as Error).message}`;
  } finally {
    marketLoading.value = false;
  }
}

/** 拉取「我的插件」与统计（需要登录） */
async function loadMine(): Promise<void> {
  if (!auth.isLoggedIn) return;
  myLoading.value = true;
  try {
    const res = await pluginsApi.my();
    myPlugins.value = res.items ?? [];
    myPluginStats.value = res.stats ?? { publishedCount: 0, totalCount: 0, totalDownloads: 0, totalStars: 0 };
  } catch (e) {
    flash(`我的插件加载失败：${(e as Error).message}`, true);
  } finally {
    myLoading.value = false;
  }
}

/** 同时刷新市场与我的插件 */
async function loadPluginsData(): Promise<void> {
  await Promise.all([loadMarket(), loadMine()]);
}

/* ---------------------------- 发布 / 编辑 ---------------------------- */

interface PluginForm {
  pluginId: string;
  name: string;
  version: string;
  category: string;
  icon: string;
  description: string;
  readmeMd: string;
  codeJs: string;
}

const DEFAULT_PLUGIN_CODE = `export default {
  id: 'my-custom-plugin',
  name: '我的自定义插件',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'custom.hello',
      title: '插入当前日期与签名',
      run() {
        const now = new Date().toLocaleString('zh-CN');
        api.insertMarkdown('\\n> ✍️ 记录于 ' + now + '\\n');
        api.notify('已插入签名时间戳', 'success');
      }
    });
  }
};`;

const editingPluginId = ref<string | null>(null);
const submitting = ref(false);
const pForm = ref<PluginForm>({
  pluginId: '',
  name: '',
  version: '1.0.0',
  category: 'writing',
  icon: 'sparkles',
  description: '',
  readmeMd: '',
  codeJs: DEFAULT_PLUGIN_CODE,
});

/** 表单校验：不通过时按钮禁用并展示原因，避免发无效请求 */
const publishIssues = computed<string[]>(() => {
  const issues: string[] = [];
  const f = pForm.value;
  if (!editingPluginId.value) {
    if (!f.pluginId.trim()) issues.push('请填写插件唯一标识');
    else if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(f.pluginId.trim())) issues.push('插件标识仅允许小写字母、数字与短横线（2-64 位）');
  }
  if (!f.name.trim()) issues.push('请填写插件显示名称');
  if (!/^\d+\.\d+\.\d+$/.test(f.version.trim())) issues.push('版本号需为 x.y.z 形式');
  if (!f.description.trim()) issues.push('请填写一句话简介');
  if (!f.codeJs.trim()) issues.push('请粘贴插件 JavaScript 源码');
  return issues;
});

const publishDisabled = computed(() => submitting.value || publishIssues.value.length > 0);

function startEditPlugin(p: CommunityPluginDto): void {
  editingPluginId.value = p.pluginId;
  pForm.value = {
    pluginId: p.pluginId,
    name: p.name,
    version: p.version,
    category: p.category,
    icon: p.icon || 'sparkles',
    description: p.description,
    readmeMd: p.readmeMd || '',
    codeJs: p.codeJs || '',
  };
  subTab.value = 'publish';
}

function resetPluginForm(): void {
  editingPluginId.value = null;
  pForm.value = {
    pluginId: '',
    name: '',
    version: '1.0.0',
    category: 'writing',
    icon: 'sparkles',
    description: '',
    readmeMd: '',
    codeJs: pForm.value.codeJs || DEFAULT_PLUGIN_CODE,
  };
}

async function submitPlugin(): Promise<void> {
  if (publishDisabled.value) {
    flash(publishIssues.value[0] ?? '请先补全插件信息', true);
    return;
  }
  submitting.value = true;
  try {
    if (editingPluginId.value) {
      await pluginsApi.update(editingPluginId.value, {
        name: pForm.value.name.trim(),
        version: pForm.value.version.trim(),
        category: pForm.value.category,
        icon: pForm.value.icon,
        description: pForm.value.description.trim(),
        readmeMd: pForm.value.readmeMd,
        codeJs: pForm.value.codeJs,
      });
      flash(`插件「${pForm.value.name}」已更新到 v${pForm.value.version}`);
    } else {
      await pluginsApi.publish({
        pluginId: pForm.value.pluginId.trim(),
        name: pForm.value.name.trim(),
        version: pForm.value.version.trim(),
        category: pForm.value.category,
        icon: pForm.value.icon,
        description: pForm.value.description.trim(),
        readmeMd: pForm.value.readmeMd,
        codeJs: pForm.value.codeJs,
      });
      flash(`插件「${pForm.value.name}」已发布到插件市场`);
    }
    resetPluginForm();
    await loadPluginsData();
    subTab.value = 'my';
  } catch (e) {
    flash(`提交失败：${(e as Error).message}`, true);
  } finally {
    submitting.value = false;
  }
}

async function deleteMyPlugin(pluginId: string): Promise<void> {
  if (!window.confirm(`确认从插件市场删除插件「${pluginId}」？此操作不可恢复。`)) return;
  try {
    await pluginsApi.remove(pluginId);
    await loadPluginsData();
    flash('已删除插件');
  } catch (e) {
    flash(`删除失败：${(e as Error).message}`, true);
  }
}

/* ------------------------------ 安装 / 点赞 ------------------------------ */

async function installMarketPlugin(p: CommunityPluginDto): Promise<void> {
  try {
    const res = await pluginsApi.download(p.pluginId);
    saveInstalledCommunityPlugin({
      pluginId: res.plugin.pluginId,
      name: res.plugin.name,
      version: res.plugin.version,
      description: res.plugin.description,
      codeJs: res.plugin.codeJs || p.codeJs || '',
    });
    await loadPluginsData();
    flash(`已安装并启用插件「${p.name}」`);
  } catch (e) {
    flash(`安装失败：${(e as Error).message}`, true);
  }
}

async function starMarketPlugin(p: CommunityPluginDto): Promise<void> {
  try {
    const res = await pluginsApi.star(p.pluginId);
    p.stars = res.stars;
  } catch (e) {
    flash(`点赞失败：${(e as Error).message}`, true);
  }
}

/* ----------------------------- 本地导入 ----------------------------- */

const importModalOpen = ref(false);
const importCodeText = ref('');

function onImportFile(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    flash('插件脚本不能超过 2MB', true);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    importCodeText.value = String(reader.result ?? '');
  };
  reader.onerror = () => flash('文件读取失败，请改为直接粘贴代码', true);
  reader.readAsText(file, 'utf-8');
}

/** 从脚本源码中粗略提取 id / name / version，缺省时给出兜底值 */
function confirmImportPlugin(): void {
  const raw = importCodeText.value.trim();
  if (!raw) {
    flash('请粘贴插件代码或选择插件文件', true);
    return;
  }
  const idMatch = /id\s*:\s*['"]([^'"]+)['"]/.exec(raw);
  const nameMatch = /name\s*:\s*['"]([^'"]+)['"]/.exec(raw);
  const verMatch = /version\s*:\s*['"]([^'"]+)['"]/.exec(raw);
  const pid = idMatch?.[1] || `custom-${Date.now()}`;
  const pname = nameMatch?.[1] || '本地导入插件';
  const pver = verMatch?.[1] || '1.0.0';
  saveInstalledCommunityPlugin({
    pluginId: pid,
    name: pname,
    version: pver,
    description: '通过本地脚本导入的扩展插件',
    codeJs: raw,
  });
  importModalOpen.value = false;
  importCodeText.value = '';
  flash(`已导入并启用插件「${pname}」，可在工作台命令面板中使用`);
}

/* ----------------------------- 内置插件 ----------------------------- */

const builtinKeyword = ref('');
const builtinCategory = ref<'all' | PluginManifest['category']>('all');

const BUILTIN_CATEGORIES: Array<{ id: 'all' | PluginManifest['category']; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'core', label: '核心扩展' },
  { id: 'writing', label: '写作增效' },
  { id: 'navigation', label: '导航检索' },
  { id: 'visual', label: '可视视图' },
  { id: 'data', label: '数据整理' },
  { id: 'collab', label: '协同发布' },
];

const builtinPlugins = computed(() => {
  const kw = builtinKeyword.value.trim().toLowerCase();
  return PLUGINS.filter((p) => {
    if (builtinCategory.value !== 'all' && p.category !== builtinCategory.value) return false;
    if (!kw) return true;
    return p.name.toLowerCase().includes(kw) || p.description.toLowerCase().includes(kw) || p.id.toLowerCase().includes(kw);
  });
});

const enabledBuiltinCount = computed(() => PLUGINS.filter((p) => settingsStore.pluginOn(p.id)).length);

function toggleBuiltin(id: string, name: string): void {
  const next = !settingsStore.pluginOn(id);
  settingsStore.togglePlugin(id, next);
  flash(next ? `已开启「${name}」` : `已关闭「${name}」`);
}

/* ----------------------------- 开发指南 ----------------------------- */

const AI_PLUGIN_PROMPT_TEMPLATE = `请为我编写一个 Neo MD 编辑器插件（单文件 JavaScript 模块），需求如下：
【在此填写你的插件需求，例如：统计当前文档所有二级标题并生成带编号的摘要清单】

请严格遵循 Neo MD Plugin SDK 规范输出代码：
\`\`\`js
export default {
  id: 'my-plugin-id',        // 唯一小写英文标识
  name: '插件中文名称',
  version: '1.0.0',
  setup(api) {
    // 注册一个可在命令面板与功能区调用的命令
    api.registerCommand({
      id: 'myPlugin.run',
      title: '命令显示名称',
      run() {
        const md = api.getMarkdown();          // 获取当前文档 Markdown 正文
        // 处理文本...
        api.insertMarkdown('\\n追加的内容\\n'); // 或使用 api.setMarkdown(newMd) 替换全文
        api.notify('执行成功', 'success');
      }
    });
  }
};
\`\`\``;

async function copyGuidePrompt(): Promise<void> {
  try {
    await navigator.clipboard?.writeText(AI_PLUGIN_PROMPT_TEMPLATE);
    flash('已复制 AI 插件生成提示词模板');
  } catch {
    flash('复制失败，请手动选中下方文本复制', true);
  }
}

/* ------------------------------ 生命周期 ------------------------------ */

/** 首次打开时按需加载数据，避免未进入插件中心就发请求 */
watch(
  () => props.open,
  (open) => {
    if (!open) {
      notice.value = '';
      return;
    }
    void loadMarket();
    if (auth.isLoggedIn) void loadMine();
  },
  { immediate: true },
);

watch(subTab, (t) => {
  if (t === 'my' && auth.isLoggedIn && !myPlugins.value.length && !myLoading.value) void loadMine();
});

function close(): void {
  emit('update:open', false);
}

/* --------------------- 外壳适配（模态 vs 嵌入标签页） --------------------- */

/** 嵌入模式下用普通 div，否则用 NmModal */
const shellTag = computed(() => (props.embedded ? 'div' : NmModal));

/** 对应的外壳属性：嵌入模式加一个铺满容器的 class，模态模式传 v-model 与标题 */
const shellProps = computed(() =>
  props.embedded
    ? { class: 'plugincenter-shell' }
    : {
        modelValue: Boolean(props.open),
        title: '插件中心',
        width: 'min(1100px, 92vw)',
        'onUpdate:modelValue': (v: boolean) => emit('update:open', v),
      },
);
</script>

<template>
  <!--
    嵌入式（1.0.2）：`embedded=true` 时不套 NmModal，直接铺满父容器。
    用于「功能区 → 插件商店」在编辑器内新开标签页的场景。
    用 `<component :is>` 复用同一份内容，避免把几百行模板复制两遍。
  -->
  <component :is="shellTag" v-bind="shellProps">
    <div class="pc" :class="{ 'pc--embedded': embedded }">
      <nav class="pc__nav" role="tablist" aria-label="插件中心分页">
        <button
          v-for="t in SUB_TABS"
          :key="t.id"
          type="button"
          class="pc__nav-item"
          role="tab"
          :aria-selected="subTab === t.id"
          :title="t.label"
          @click="subTab = t.id"
        >
          <NmIcon :name="t.icon" :size="15" />
          <span>{{ t.label }}</span>
        </button>
        <div class="pc__nav-foot">
          <button
            type="button"
            class="nm-btn nm-btn--sm"
            title="导入本地插件脚本"
            aria-label="导入本地插件脚本"
            @click="importModalOpen = true"
          >
            <NmIcon name="upload" :size="13" />
            导入本地
          </button>
          <button
            type="button"
            class="nm-btn nm-btn--primary nm-btn--sm"
            title="发布新插件"
            aria-label="发布新插件"
            @click="resetPluginForm(); subTab = 'publish'"
          >
            <NmIcon name="plus" :size="13" />
            发布插件
          </button>
        </div>
      </nav>

      <div class="pc__body nm-scroll">
        <p v-if="notice" class="pc__notice" :class="{ 'is-err': noticeIsError }">{{ notice }}</p>

        <!-- 插件市场 -->
        <section v-if="subTab === 'market'" class="pane">
          <header class="pane__head">
            <h3 class="pane__title">社区开发者精选插件</h3>
            <button
              type="button"
              class="nm-btn nm-btn--sm"
              :disabled="marketLoading"
              title="刷新插件市场"
              aria-label="刷新插件市场"
              @click="loadMarket"
            >
              <NmIcon name="refresh" :size="12" />
              {{ marketLoading ? '加载中…' : '刷新' }}
            </button>
          </header>
          <p v-if="marketError" class="pc__error">{{ marketError }}</p>
          <div v-if="marketLoading && !marketPlugins.length" class="pc__placeholder">正在加载插件市场…</div>
          <div v-else-if="!marketPlugins.length && !marketError" class="pc__placeholder">
            插件市场暂无上架插件，欢迎成为第一位发布者。
          </div>
          <div v-else class="plugin-grid">
            <div v-for="cp in marketPlugins" :key="cp.pluginId" class="pcard">
              <div class="pcard__head">
                <strong>{{ cp.name }}</strong>
                <span class="pcard__ver">v{{ cp.version }}</span>
              </div>
              <p class="pcard__desc">{{ cp.description }}</p>
              <div class="pcard__meta">
                <span>作者：{{ cp.authorName }}</span>
                <span>安装 {{ formatCompactNumber(cp.downloads) }}</span>
                <button
                  type="button"
                  class="star-btn"
                  title="点赞该插件"
                  aria-label="点赞该插件"
                  @click="starMarketPlugin(cp)"
                >
                  ★ {{ formatCompactNumber(cp.stars) }}
                </button>
              </div>
              <div class="pcard__foot">
                <button
                  type="button"
                  class="nm-btn nm-btn--sm"
                  :class="{ 'nm-btn--primary': !installedCommunityIds.includes(cp.pluginId) }"
                  :title="installedCommunityIds.includes(cp.pluginId) ? '重新下载并更新本地插件' : '一键安装并启用该插件'"
                  @click="installMarketPlugin(cp)"
                >
                  {{ installedCommunityIds.includes(cp.pluginId) ? '已安装（点击更新）' : '一键安装并启用' }}
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- 我的插件 -->
        <section v-else-if="subTab === 'my'" class="pane">
          <template v-if="!auth.isLoggedIn">
            <div class="pc__placeholder">开发者中心需要登录后使用，请先在个人中心完成登录。</div>
          </template>
          <template v-else>
            <header class="pane__head">
              <h3 class="pane__title">开发者中心</h3>
              <button
                type="button"
                class="nm-btn nm-btn--sm"
                :disabled="myLoading"
                title="刷新我的插件"
                aria-label="刷新我的插件"
                @click="loadMine"
              >
                <NmIcon name="refresh" :size="12" />
                {{ myLoading ? '加载中…' : '刷新' }}
              </button>
            </header>
            <div class="stats">
              <div class="stat"><span>{{ myPluginStats.totalCount }}</span><em>已提交插件</em></div>
              <div class="stat"><span>{{ myPluginStats.publishedCount }}</span><em>已上架插件</em></div>
              <div class="stat"><span>{{ formatCompactNumber(myPluginStats.totalDownloads) }}</span><em>累计安装量</em></div>
              <div class="stat"><span>{{ formatCompactNumber(myPluginStats.totalStars) }}</span><em>累计获赞</em></div>
            </div>

            <table class="ledger">
              <thead>
                <tr><th>插件名称 / ID</th><th>版本</th><th>状态</th><th>安装量</th><th>获赞</th><th>更新时间</th><th>操作</th></tr>
              </thead>
              <tbody>
                <tr v-for="mp in myPlugins" :key="mp.pluginId">
                  <td>
                    <strong>{{ mp.name }}</strong>
                    <div class="mono subtle">{{ mp.pluginId }}</div>
                  </td>
                  <td>v{{ mp.version }}</td>
                  <td>{{ mp.status === 'published' ? '已上架' : mp.status }}</td>
                  <td>{{ formatCompactNumber(mp.downloads) }}</td>
                  <td>{{ formatCompactNumber(mp.stars) }}</td>
                  <td>{{ mp.updatedAt }}</td>
                  <td class="ops">
                    <button type="button" title="更新该插件版本" @click="startEditPlugin(mp)">更新版本</button>
                    <button type="button" class="danger-link" title="从插件市场删除" @click="deleteMyPlugin(mp.pluginId)">删除</button>
                  </td>
                </tr>
                <tr v-if="!myPlugins.length && !myLoading">
                  <td colspan="7" class="empty">您还没有发布过插件，点击左侧「发布插件」或参考「开发指南」立即开始。</td>
                </tr>
              </tbody>
            </table>
          </template>
        </section>

        <!-- 发布 / 更新插件 -->
        <section v-else-if="subTab === 'publish'" class="pane">
          <template v-if="!auth.isLoggedIn">
            <div class="pc__placeholder">发布插件需要登录账号，请先在个人中心完成登录。</div>
          </template>
          <template v-else>
            <h3 class="pane__title">{{ editingPluginId ? `更新插件：${editingPluginId}` : '发布新插件到开放平台' }}</h3>
            <div class="grid2">
              <div class="field">
                <label class="nm-label">插件唯一标识（英文小写与短横线）</label>
                <input
                  v-model="pForm.pluginId"
                  class="nm-input"
                  :readonly="Boolean(editingPluginId)"
                  placeholder="例如：auto-toc-builder"
                />
              </div>
              <div class="field">
                <label class="nm-label">插件显示名称</label>
                <input v-model="pForm.name" class="nm-input" placeholder="例如：智能目录生成器" />
              </div>
            </div>
            <div class="grid2">
              <div class="field">
                <label class="nm-label">版本号</label>
                <input v-model="pForm.version" class="nm-input" placeholder="1.0.0" />
              </div>
              <div class="field">
                <label class="nm-label">分类</label>
                <select v-model="pForm.category" class="nm-input">
                  <option value="writing">写作增效 (writing)</option>
                  <option value="navigation">导航检索 (navigation)</option>
                  <option value="visual">可视视图 (visual)</option>
                  <option value="data">数据整理 (data)</option>
                  <option value="collab">协同发布 (collab)</option>
                  <option value="core">核心扩展 (core)</option>
                </select>
              </div>
            </div>
            <div class="field">
              <label class="nm-label">一句话简介</label>
              <input v-model="pForm.description" class="nm-input" maxlength="500" placeholder="简明描述该插件解决什么问题" />
            </div>
            <div class="field">
              <label class="nm-label">插件 JavaScript 源码（遵循 Neo MD Plugin SDK）</label>
              <textarea v-model="pForm.codeJs" class="nm-input mono" rows="10" />
            </div>
            <div class="field">
              <label class="nm-label">使用说明（Markdown，可选）</label>
              <textarea v-model="pForm.readmeMd" class="nm-input" rows="4" placeholder="# 插件说明…" />
            </div>
            <p v-if="publishIssues.length" class="pc__error">请先修正：{{ publishIssues.join('；') }}</p>
            <div class="actions-row">
              <button
                type="button"
                class="nm-btn nm-btn--primary"
                :disabled="publishDisabled"
                :title="publishDisabled ? publishIssues[0] ?? '提交中…' : '提交插件'"
                @click="submitPlugin"
              >
                {{ submitting ? '提交中…' : editingPluginId ? '保存并发布新版本' : '立即发布插件' }}
              </button>
              <button v-if="editingPluginId" type="button" class="nm-btn" title="取消编辑" @click="resetPluginForm">
                取消编辑
              </button>
            </div>
          </template>
        </section>

        <!-- 开发指南 -->
        <section v-else-if="subTab === 'guide'" class="pane">
          <div class="row-between">
            <h3 class="pane__title">Neo MD 插件开发指南（支持自己编写或一键交给 AI 生成）</h3>
            <button
              type="button"
              class="nm-btn nm-btn--primary nm-btn--sm"
              title="复制 AI 插件开发提示词"
              aria-label="复制 AI 插件开发提示词"
              @click="copyGuidePrompt"
            >
              <NmIcon name="copy" :size="13" />复制 AI 提示词
            </button>
          </div>
          <p class="nm-hint">
            Neo MD 采用轻量免编译的插件架构，任何插件只需导出一个包含 <code>id</code>、<code>name</code>、<code>version</code> 和
            <code>setup(api)</code> 的对象即可在网页端与 Windows 客户端运行。
          </p>
          <h4>一、宿主 API（<code>setup(api)</code> 参数）一览</h4>
          <ul class="guide-list">
            <li><code>api.getMarkdown(): string</code> —— 读取当前活动文档的完整 Markdown 文本。</li>
            <li><code>api.setMarkdown(next: string): void</code> —— 替换当前活动文档的 Markdown 正文。</li>
            <li><code>api.insertMarkdown(snippet: string): void</code> —— 在当前文档末尾或光标处追加 Markdown 片段。</li>
            <li><code>api.getTitle(): string</code> —— 获取当前活动文档的标题。</li>
            <li><code>api.registerCommand({ id, title, run })</code> —— 注册命令，可在命令面板（<code>Ctrl+P</code>）与功能区触发。</li>
            <li><code>api.notify(message, type)</code> —— 弹出顶部通知（<code>'info' | 'success' | 'error'</code>）。</li>
          </ul>
          <h4>二、如何用 AI 在 30 秒内生成并运行插件？</h4>
          <ol class="guide-list">
            <li>点击右上角「复制 AI 提示词」，粘贴给工作台右侧的「AI 助手」或任意大模型，填上你的功能想法。</li>
            <li>复制 AI 生成的 JavaScript 代码，点击左侧「导入本地」粘贴保存（也可保存为 <code>.js</code> 文件上传导入）。</li>
            <li>进入编辑器工作台，按 <code>Ctrl+P</code> 打开命令面板或点击功能区即可执行插件；满意后可在「发布插件」中分享给全平台用户。</li>
          </ol>
          <pre class="guide-pre">{{ AI_PLUGIN_PROMPT_TEMPLATE }}</pre>
        </section>

        <!-- 内置插件 -->
        <section v-else class="pane">
          <div class="row-between">
            <h3 class="pane__title">官方内置插件（{{ PLUGINS.length }} 款，已开启 {{ enabledBuiltinCount }} 款）</h3>
            <input
              v-model="builtinKeyword"
              class="nm-input pc__search"
              type="search"
              placeholder="搜索插件名称或功能…"
              aria-label="搜索内置插件"
            />
          </div>
          <p class="nm-hint">关闭的插件不会加载对应代码；开启后相关入口会出现在编辑器功能区与侧边栏。</p>
          <div class="seg pc__cats">
            <button
              v-for="c in BUILTIN_CATEGORIES"
              :key="c.id"
              type="button"
              class="seg__item"
              :class="{ 'is-active': builtinCategory === c.id }"
              @click="builtinCategory = c.id"
            >
              {{ c.label }}
            </button>
          </div>
          <div v-if="!builtinPlugins.length" class="pc__placeholder">没有匹配的插件，试试其它关键词或分类。</div>
          <div v-else class="plugin-grid">
            <div v-for="bp in builtinPlugins" :key="bp.id" class="pcard">
              <div class="pcard__head">
                <strong>{{ bp.name }}</strong>
                <span class="pcard__ver">{{ BUILTIN_CATEGORIES.find((c) => c.id === bp.category)?.label ?? '内置' }}</span>
              </div>
              <p class="pcard__desc">{{ bp.description }}</p>
              <div class="pcard__foot">
                <button
                  type="button"
                  class="nm-btn nm-btn--sm"
                  :class="{ 'nm-btn--primary': settingsStore.pluginOn(bp.id) }"
                  :title="settingsStore.pluginOn(bp.id) ? `关闭「${bp.name}」` : `开启「${bp.name}」`"
                  :aria-pressed="settingsStore.pluginOn(bp.id)"
                  @click="toggleBuiltin(bp.id, bp.name)"
                >
                  {{ settingsStore.pluginOn(bp.id) ? '已开启（点击关闭）' : '未开启（点击开启）' }}
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- 模态模式才有 footer；嵌入到标签页时不需要「关闭」按钮（直接关标签） -->
    <template v-if="!embedded" #footer>
      <span class="pc__foot-hint">插件开关会即时生效并同步到云端设置。</span>
      <button type="button" class="nm-btn" title="关闭插件中心" @click="close">关闭</button>
    </template>
  </component>

  <!-- 导入本地插件脚本 -->
  <NmModal v-model="importModalOpen" title="导入本地插件脚本" :width="560">
    <div class="field">
      <label class="nm-label">方式一：选择本地 .js 插件文件</label>
      <input type="file" accept=".js,.mjs,.txt" class="nm-input" @change="onImportFile" />
    </div>
    <div class="field">
      <label class="nm-label">方式二：直接粘贴插件代码（或 AI 生成的代码）</label>
      <textarea
        v-model="importCodeText"
        class="nm-input mono"
        rows="10"
        placeholder="export default { id: '...', name: '...', setup(api) { ... } }"
      />
    </div>
    <template #footer>
      <button type="button" class="nm-btn" @click="importModalOpen = false">取消</button>
      <button type="button" class="nm-btn nm-btn--primary" @click="confirmImportPlugin">导入并启用</button>
    </template>
  </NmModal>
</template>

<style scoped>
.pc {
  display: grid;
  grid-template-columns: 168px 1fr;
  margin: -4px -20px -18px;
  height: min(76vh, calc(100vh - 190px));
  min-height: 0;
  overflow: hidden;
}
.pc__nav {
  border-right: 1px solid var(--border);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--bg-sidebar);
  min-height: 0;
  overflow-y: auto;
}
.pc__nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  border-radius: 7px;
  font-size: 13px;
  color: var(--fg-2);
  text-align: left;
}
.pc__nav-item:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.pc__nav-item.is-active,
.pc__nav-item[aria-selected='true'] {
  background: var(--bg-active);
  color: var(--accent);
  font-weight: 600;
}
.pc__nav-foot {
  margin-top: auto;
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: 1px solid var(--border);
}
.pc__body {
  padding: 16px 20px 24px;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.pc__notice {
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--accent-weak-2);
  color: var(--accent);
  font-size: 12.5px;
}
.pc__notice.is-err {
  background: rgba(217, 48, 37, 0.1);
  color: #d93025;
}
.pc__error {
  margin: 0 0 10px;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(217, 48, 37, 0.08);
  color: #d93025;
  font-size: 12.5px;
  line-height: 1.6;
}
.pc__placeholder {
  padding: 28px 16px;
  text-align: center;
  color: var(--fg-3);
  font-size: 13px;
}
.pc__search {
  max-width: 240px;
  flex: 0 0 auto;
}
.pc__cats {
  margin-bottom: 14px;
}
.pc__foot-hint {
  margin-right: auto;
  font-size: 11.5px;
  color: var(--fg-3);
}

.pane__title {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 700;
}
.pane__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.pane__head .pane__title {
  margin: 0;
}
.field {
  margin-bottom: 14px;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.row-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.actions-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 12px;
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

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}
.stat {
  padding: 14px;
  border-radius: 10px;
  background: var(--bg-sidebar);
  border: 1px solid var(--border);
  text-align: center;
}
.stat span {
  display: block;
  font-size: 20px;
  font-weight: 700;
  color: var(--accent);
}
.stat em {
  font-style: normal;
  font-size: 11.5px;
  color: var(--fg-3);
}

.ledger {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.ledger th,
.ledger td {
  padding: 9px 10px;
  border-bottom: 1px solid var(--border);
  text-align: left;
}
.ledger th {
  color: var(--fg-3);
  font-weight: 600;
  font-size: 11.5px;
}
.empty {
  text-align: center !important;
  color: var(--fg-3);
  padding: 20px !important;
}
.ops {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.ops button {
  color: var(--accent);
  font-size: 12px;
}
.danger-link {
  color: #d93025 !important;
}
.mono {
  font-family: var(--font-mono);
}
.subtle {
  font-size: 11px;
  color: var(--fg-3);
}

.plugin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(270px, 1fr));
  gap: 12px;
}
.pcard {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 16px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-sidebar);
}
.pcard__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.pcard__head strong {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.pcard__ver {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--accent);
  background: var(--accent-weak);
  padding: 2px 6px;
  border-radius: 4px;
  flex: 0 0 auto;
}
.pcard__desc {
  margin: 8px 0 12px;
  font-size: 12.5px;
  color: var(--fg-2);
  line-height: 1.6;
  flex: 1;
}
.pcard__meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11.5px;
  color: var(--fg-3);
  margin-bottom: 10px;
}
.star-btn {
  margin-left: auto;
  color: #f59e0b;
  font-weight: 600;
}
.pcard__foot {
  display: flex;
  justify-content: flex-end;
}

.guide-list {
  margin: 0 0 12px;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--fg-2);
}
.pane h4 {
  margin: 16px 0 8px;
  font-size: 13.5px;
}
.guide-pre {
  padding: 14px;
  border-radius: 10px;
  background: var(--bg-sidebar);
  border: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
  white-space: pre-wrap;
}
code {
  font-family: var(--font-mono);
  background: var(--bg-hover);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.92em;
}

@media (max-width: 860px) {
  .pc {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
    height: min(78vh, calc(100vh - 170px));
  }
  .pc__nav {
    flex-direction: row;
    overflow-x: auto;
    overflow-y: hidden;
    border-right: none;
    border-bottom: 1px solid var(--border);
    gap: 4px;
  }
  .pc__nav-item {
    white-space: nowrap;
  }
  .pc__nav-foot {
    margin-top: 0;
    margin-left: auto;
    padding-top: 0;
    padding-left: 8px;
    border-top: none;
    border-left: 1px solid var(--border);
    flex-direction: row;
    flex: 0 0 auto;
  }
  .grid2 {
    grid-template-columns: 1fr;
  }
  .pc__search {
    max-width: 150px;
  }
}
</style>
