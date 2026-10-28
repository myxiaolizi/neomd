<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NmIcon } from '@neomd/ui';
import { AIClient, generateContent, polishContent, formatContent, generateTitle } from '@neomd/core';
import {
  buildContext,
  indexVaultIntoShared,
  normalizeKnowledgeSettings,
  sharedKnowledgeBase,
} from '@neomd/core';
import { getAIPreset, formatBytes, type KnowledgeHit } from '@neomd/shared';
import { useSettingsStore } from '@/stores/settings';
import { useAppStore } from '@/stores/app';
import { aiApi, assertServerAllowed, isPrivacyModeError, resolveApiUrl } from '@/api/client';

const emit = defineEmits<{ close: []; fileOp: [string]; 'update:activeTab': ['ai' | 'file'] }>();
const settingsStore = useSettingsStore();
const app = useAppStore();

/**
 * 右侧栏可显示的功能区块（1.0.2 起扩展为 8 个）。
 *
 * AiPanel 本身只承载 ai 与 file 两个区块；其余区块（大纲/反链/标签/历史/统计/日历）
 * 由 `components/panels/right/*` 下的独立组件提供，挂在 EditorPage 的右侧栏里。
 * 这里不过滤配置，只保证「本组件负责的这两个区块」在其启用时才渲染。
 */
/**
 * 右侧栏「当前激活区块」（1.1.8 受控化）。
 *
 * 用户反馈：「打开 AI 和文件操作是标签切换，打开其他功能是上下窗口」——交互不一致。
 * 根因：AiPanel 自己内部有一套 ai/file 标签，而 EditorPage 把其它 RightSection
 * 全部**上下堆叠**渲染在它下面，于是同一个右侧栏里混了两种交互模型。
 *
 * 修法：把「当前显示哪个区块」上提到 EditorPage 统一管理（顶部图标条即标签栏），
 * 右侧栏一次只渲染一个区块。AiPanel 因此变成**受控组件**：
 * - 传入 `activeTab` 时完全听父级安排（父级切到别的区块时本组件会被 v-if 卸载）；
 * - 未传时退回内部状态，保持向后兼容（设置页等其它调用点不受影响）。
 */
const props = defineProps<{ activeTab?: 'ai' | 'file' }>();

const ownSections = computed<Array<'ai' | 'file'>>(() => {
  const s = settingsStore.settings.layout.rightPanelSections ?? [];
  const mine = s.filter((x): x is 'ai' | 'file' => x === 'ai' || x === 'file');
  return mine.length ? mine : ['ai', 'file'];
});

/** 内部状态：仅在父级未传 activeTab 时生效 */
const innerTab = ref<'ai' | 'file'>('ai');

/** 实际显示的区块：受控优先，否则用内部状态 */
const rightTab = computed<'ai' | 'file'>(() => props.activeTab ?? innerTab.value);

/** 切换区块：受控时通知父级，非受控时改内部状态 */
function setTab(tab: 'ai' | 'file'): void {
  innerTab.value = tab;
  emit('update:activeTab', tab);
}

watch(
  ownSections,
  (list) => {
    if (!list.includes(innerTab.value)) innerTab.value = list[0] ?? 'ai';
  },
  { immediate: true },
);

/**
 * 右侧栏「文件操作」卡片数据（1.0.2 卡片式布局）。
 *
 * 每张卡固定宽度 160px、高度 75px，含图标 + 名称（1 行）+ 描述（最多 2 行）。
 * 分组只用于视觉区隔，网格本身会按容器宽度自动排 2-8 张。
 */
interface FileOpCard {
  id: string;
  name: string;
  desc: string;
  icon: string;
}

const FILE_OPS_BASIC: FileOpCard[] = [
  { id: 'save', name: '保存文档', desc: '把当前编辑内容立即写入本地与云端', icon: 'save' },
  { id: 'rename', name: '重命名', desc: '修改文件名，支持日期模板与 AI 智能命名', icon: 'edit' },
  { id: 'move-path', name: '移动到', desc: '把当前文档移动到其他子文件夹', icon: 'folder' },
  { id: 'duplicate', name: '创建副本', desc: '复制一份当前文档的内容继续编辑', icon: 'copy' },
];

const FILE_OPS_CONTENT: FileOpCard[] = [
  { id: 'insert-toc', name: '生成目录', desc: '在文档顶部按标题层级插入 TOC', icon: 'outline' },
  { id: 'insert-frontmatter', name: '属性头', desc: '插入 YAML Frontmatter 元数据块', icon: 'tag' },
  { id: 'clean-blank', name: '清理空行', desc: '整理多余连续空行与行尾空格', icon: 'layout' },
  { id: 'copy-md', name: '复制源码', desc: '把全文 Markdown 源码复制到剪贴板', icon: 'code' },
];

const FILE_OPS_SYSTEM: FileOpCard[] = [
  { id: 'history', name: '历史版本', desc: '查看历次保存的内容并回滚到任意版本', icon: 'history' },
  { id: 'share', name: '分享发布', desc: '生成可设密码的分享链接或发布为网页', icon: 'share' },
  { id: 'export', name: '导出文档', desc: '导出为 PDF、Word 或单文件 HTML', icon: 'download' },
  { id: 'show-in-folder', name: '定位文件', desc: '在系统文件管理器中打开所在目录', icon: 'external' },
  { id: 'copy-path', name: '复制路径', desc: '复制该文档相对仓库的路径', icon: 'copy' },
  { id: 'delete', name: '删除文档', desc: '从仓库中删除该文档，可先备份', icon: 'trash' },
];

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  streaming?: boolean;
}

const messages = ref<Message[]>([]);
const input = ref('');
const busy = ref(false);
const errorText = ref('');
const listEl = ref<HTMLElement | null>(null);
const modelOpen = ref(false);
const includeDocContext = ref(true);
const creditInfo = ref<{ balance: number; tokensToday: number; costToday: number } | null>(null);
let controller: AbortController | null = null;

/* ---------------------- 知识库（1.1.0 需求二） ---------------------- */

/**
 * 本次对话是否使用仓库知识库。
 * 初值取用户在设置页的总开关；面板上的开关只影响当前会话，不写回设置
 * （避免用户在对话里临时关掉后，设置页的全局配置也被改掉）。
 */
const useKnowledge = ref(false);
/** 最近一次检索命中的片段（用于工具栏上的「命中 N 条」提示与来源展示） */
const kbHits = ref<KnowledgeHit[]>([]);
/** 知识库索引是否已就绪（未建索引时首次提问会先建一次） */
const kbIndexed = ref(false);

const kbSettings = computed(() => normalizeKnowledgeSettings(settingsStore.settings.knowledge));

/** 知识库是否可用（设置开启 + 仓库已加载） */
const kbAvailable = computed(() => kbSettings.value.enabled && Boolean(app.vault));

/** 确保索引可用：首次使用时按当前仓库建一次，之后由 KnowledgeBase 自己增量维护 */
async function ensureKnowledgeIndex(): Promise<void> {
  if (kbIndexed.value || !app.vault) return;
  await indexVaultIntoShared(app.vault, kbSettings.value);
  kbIndexed.value = true;
}

/**
 * 按当前提问检索知识库，返回拼装好的上下文与命中数。
 * 检索失败不阻断对话：退回空上下文并提示，保证 AI 仍能回答。
 */
async function knowledgeContext(query: string): Promise<{ context: string; chunkCount: number }> {
  if (!useKnowledge.value || !kbAvailable.value) return { context: '', chunkCount: 0 };
  try {
    await ensureKnowledgeIndex();
    const hits = sharedKnowledgeBase(kbSettings.value).search(query);
    kbHits.value = hits;
    return { context: buildContext(hits, kbSettings.value), chunkCount: hits.length };
  } catch (e) {
    errorText.value = `知识库检索失败：${(e as Error).message}`;
    kbHits.value = [];
    return { context: '', chunkCount: 0 };
  }
}

const ai = computed(() => settingsStore.settings.ai);
const preset = computed(() => getAIPreset(ai.value.provider));
/** 仅展示用户选择启用的模型；若用户尚未勾选则回退当前默认模型 */
const models = computed(() =>
  ai.value.models && ai.value.models.length ? ai.value.models : [ai.value.model || preset.value.defaultModel],
);
const currentModel = computed(() =>
  models.value.includes(ai.value.model) ? ai.value.model : (models.value[0] || preset.value.defaultModel),
);
const isPlatformMode = computed(() => Boolean(ai.value.usePlatform || ai.value.provider === 'platform'));
const ready = computed(() => Boolean(ai.value.apiKey) || isPlatformMode.value);

const quickActions = [
  { id: 'create', label: '创建文件', icon: 'plus' },
  { id: 'generate', label: '续写生成', icon: 'sparkles' },
  { id: 'polish', label: '全文润色', icon: 'edit' },
  { id: 'format', label: '智能排版', icon: 'layout' },
  { id: 'title', label: 'AI 命名', icon: 'type' },
];

const currentDocMeta = computed(() => (app.activeTab ? app.vault?.get(app.activeTab.docId) ?? null : null));

function systemPrompt(): string {
  return '你是 Neo MD 编辑器内的专业写作助手，输出使用标准 Markdown。回答准确精炼，不要输出无关寒暄。';
}

function docContext(): string {
  if (!includeDocContext.value) return '';
  const tab = app.activeTab;
  if (!tab) return '';
  return `当前文档《${tab.title}》正文内容：\n${tab.content.slice(0, 6000)}`;
}

async function scrollToEnd(): Promise<void> {
  await nextTick();
  if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight;
}

function buildClient(): AIClient {
  return new AIClient(
    {
      ...ai.value,
      usePlatform: isPlatformMode.value,
      model: currentModel.value,
      apiKey: isPlatformMode.value ? 'platform' : ai.value.apiKey,
    },
    { signal: controller?.signal },
  );
}

async function send(): Promise<void> {
  const text = input.value.trim();
  if (!text || busy.value) return;
  if (!ready.value) {
    errorText.value = isPlatformMode.value
      ? '请先登录账号以使用平台积分 AI'
      : '请先在用户中心或设置中配置 AI 供应商与 API Key';
    return;
  }
  errorText.value = '';
  input.value = '';
  messages.value.push({ id: `u${Date.now()}`, role: 'user', text });
  const replyId = `a${Date.now()}`;
  messages.value.push({ id: replyId, role: 'assistant', text: '', streaming: true });
  await scrollToEnd();

  busy.value = true;
  controller = new AbortController();

  // 知识库优先：命中片段时走 /api/knowledge/chat（服务端把 context 注入系统提示并流式返回）
  const useKb = useKnowledge.value && kbAvailable.value;
  const kb = useKb ? await knowledgeContext(text) : { context: '', chunkCount: 0 };
  if (useKb) {
    await streamViaKnowledge(replyId, text, kb.context, kb.chunkCount);
    return;
  }

  if (isPlatformMode.value) {
    await streamViaPlatform(replyId, text);
    return;
  }

  const client = buildClient();
  const ctx = docContext();
  await client.chatStream(
    {
      messages: [
        { role: 'system', content: systemPrompt() },
        ...(ctx ? [{ role: 'system' as const, content: ctx }] : []),
        ...messages.value
          .filter((m) => !m.streaming && m.role !== 'error')
          .slice(-10)
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text })),
      ],
    },
    (event) => {
      const target = messages.value.find((m) => m.id === replyId);
      if (!target) return;
      if (event.type === 'delta' && event.text) {
        target.text += event.text;
        void scrollToEnd();
      } else if (event.type === 'error') {
        target.streaming = false;
        target.role = 'error';
        target.text = event.error ?? '请求失败';
        errorText.value = event.error ?? '请求失败';
      } else if (event.type === 'done') {
        target.streaming = false;
      }
    },
  );
  busy.value = false;
  controller = null;
}

/**
 * 把 SSE 的单个 `data:` 行应用到对应消息上（`/api/ai/chat` 与 `/api/knowledge/chat` 同格式）。
 * 抽出来是为了让知识库通道与平台通道共用同一套解析，行为完全一致。
 */
function applySseDataLine(line: string, replyId: string): void {
  const t = line.trim();
  if (!t.startsWith('data:')) return;
  const payload = t.slice(5).trim();
  if (!payload || payload === '[DONE]') return;
  try {
    const json = JSON.parse(payload) as {
      type?: string;
      text?: string;
      error?: string;
      choices?: Array<{ delta?: { content?: string } }>;
      billing?: { cost: number; balance: number };
      contextChars?: number;
      chunkCount?: number;
    };
    const target = messages.value.find((m) => m.id === replyId);
    // 服务端错误事件（如上游 401、积分不足）：直接落到气泡上，避免用户看到空回答
    if (json.type === 'error' && json.error) {
      if (target) {
        target.streaming = false;
        target.role = 'error';
        target.text = json.error;
      }
      errorText.value = json.error;
      return;
    }
    const delta = json.text ?? json.choices?.[0]?.delta?.content;
    if (delta && target) {
      target.text += delta;
      void scrollToEnd();
    }
    if (json.billing) {
      creditInfo.value = { ...(creditInfo.value ?? { tokensToday: 0, costToday: 0 }), balance: json.billing.balance };
      app.credits = json.billing.balance;
    }
  } catch {
    /* 非 JSON 行忽略 */
  }
}

/**
 * 知识库对话通道：把客户端检索出的 `context` 交给 `/api/knowledge/chat`，
 * 服务端注入系统提示后流式返回，并记录用量统计。
 *
 * BYOK 与平台积分两种模式都走这里——服务端的解析/故障切换/扣费逻辑与 `/api/ai/chat` 一致，
 * 差别只有「多了 context」这一件事。
 */
async function streamViaKnowledge(
  replyId: string,
  text: string,
  context: string,
  chunkCount: number,
): Promise<void> {
  try {
    // 私有化模式下服务端不可用：与平台通道同样显式守卫
    assertServerAllowed();
    const token = localStorage.getItem('neomd.access');
    const res = await fetch(resolveApiUrl('/api/knowledge/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        query: text,
        context,
        chunkCount,
        model: currentModel.value,
        provider: isPlatformMode.value ? 'platform' : ai.value.provider,
        usePlatform: isPlatformMode.value,
        ...(isPlatformMode.value ? {} : { baseUrl: ai.value.baseUrl, apiKey: ai.value.apiKey }),
        temperature: ai.value.temperature,
        maxTokens: ai.value.maxTokens,
        // 关闭上下文时等价于普通问答，便于对比「知识库是否真的有用」
        useContext: true,
        // 最近 10 轮历史，便于基于知识库追问
        history: messages.value
          .filter((m) => !m.streaming && m.role !== 'error')
          .slice(-10)
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text })),
      }),
      signal: controller?.signal,
    });
    if (!res.ok || !res.body) {
      const err = await res.text().catch(() => '');
      let message = err.slice(0, 300) || `知识库对话失败 ${res.status}`;
      // 服务端统一返回 { ok:false, error:{ message } }，优先取中文 message
      try {
        const parsed = JSON.parse(err) as { error?: { message?: string } };
        if (parsed?.error?.message) message = parsed.error.message;
      } catch {
        /* 非 JSON 响应时用原文 */
      }
      throw new Error(message);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) applySseDataLine(line, replyId);
    }
    const target = messages.value.find((m) => m.id === replyId);
    if (target) target.streaming = false;
  } catch (e) {
    const target = messages.value.find((m) => m.id === replyId);
    const failText = isPrivacyModeError(e) ? '已开启数据私有化模式，知识库对话不可用' : (e as Error).message;
    if (target) {
      target.streaming = false;
      target.role = 'error';
      target.text = failText;
    }
    errorText.value = failText;
  } finally {
    busy.value = false;
    controller = null;
  }
}

async function streamViaPlatform(replyId: string, text: string): Promise<void> {  try {
    // 数据私有化模式下平台 AI 不可用：这里不走 api() 入口，需显式守卫
    assertServerAllowed();
    const token = localStorage.getItem('neomd.access');
    const ctx = docContext();
    const res = await fetch(resolveApiUrl('/api/ai/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        provider: ai.value.provider,
        model: currentModel.value,
        usePlatform: true,
        temperature: ai.value.temperature,
        maxTokens: ai.value.maxTokens,
        messages: [
          { role: 'system', content: systemPrompt() },
          ...(ctx ? [{ role: 'system', content: ctx }] : []),
          { role: 'user', content: text },
        ],
      }),
      signal: controller?.signal,
    });
    if (!res.ok || !res.body) {
      const err = await res.text().catch(() => '');
      throw new Error(err.slice(0, 300) || `平台 AI 请求失败 ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload) as {
            type?: string;
            text?: string;
            choices?: Array<{ delta?: { content?: string } }>;
            billing?: { cost: number; balance: number };
          };
          const delta = json.text ?? json.choices?.[0]?.delta?.content;
          const target = messages.value.find((m) => m.id === replyId);
          if (delta && target) {
            target.text += delta;
            void scrollToEnd();
          }
          if (json.billing) {
            creditInfo.value = { ...(creditInfo.value ?? { tokensToday: 0, costToday: 0 }), balance: json.billing.balance };
            app.credits = json.billing.balance;
          }
        } catch {
          /* ignore */
        }
      }
    }
    const target = messages.value.find((m) => m.id === replyId);
    if (target) target.streaming = false;
  } catch (e) {
    const target = messages.value.find((m) => m.id === replyId);
    // 私有化模式：静默降级为提示，不当作错误弹红
    const failText = isPrivacyModeError(e) ? '已开启数据私有化模式，平台 AI 不可用' : (e as Error).message;
    if (target) {
      target.streaming = false;
      target.role = 'error';
      target.text = failText;
    }
    errorText.value = failText;
  } finally {
    busy.value = false;
    controller = null;
  }
}

function stop(): void {
  controller?.abort();
  controller = null;
  busy.value = false;
  const last = messages.value[messages.value.length - 1];
  if (last) last.streaming = false;
}

/**
 * 复制文本到剪贴板。
 *
 * 注意：Vue 模板渲染代理白名单里没有 `navigator`（与 `window` 相同），
 * 直接在模板写 `navigator.clipboard...` 会报 `Property 'navigator' does not exist`，
 * 因此统一在 `<script setup>` 内封装成函数供模板调用。
 */
async function copyText(text: string, tip = '已复制'): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
    app.notify(tip, 'success', 1600);
  } catch {
    app.notify('复制失败，请手动选中后按 Ctrl+C', 'error', 2400);
  }
}

/** 复制当前文档的相对路径 */
async function copyDocPath(): Promise<void> {
  const path = app.activeTab?.path;
  if (!path) return;
  await copyText(path, '已复制文件路径');
}

async function runQuick(action: string): Promise<void> {
  const tab = app.activeTab;
  errorText.value = '';
  if (!ready.value) {
    errorText.value = '请先配置 AI 服务';
    return;
  }
  if (action === 'title') {
    if (!tab) return;
    busy.value = true;
    try {
      const title = await generateTitle(buildClient(), tab.content, settingsStore.settings.naming.aiPrompt);
      messages.value.push({ id: `sys${Date.now()}`, role: 'assistant', text: `建议标题：**${title}**` });
      emit('fileOp', 'rename');
    } catch (e) {
      errorText.value = (e as Error).message;
    } finally {
      busy.value = false;
    }
    return;
  }
  const client = buildClient();
  busy.value = true;
  try {
    if (action === 'create') {
      const instruction = input.value.trim() || '新建一篇结构化笔记';
      const content = await generateContent(client, { instruction, content: '' });
      const firstLine = content.split('\n').find((l) => l.trim().startsWith('#'));
      const title = firstLine ? firstLine.replace(/^#+\s*/, '').trim() : instruction.slice(0, 20);
      await app.createDoc({ title, content });
      messages.value.push({ id: `sys${Date.now()}`, role: 'assistant', text: `已创建文档《${title}》。` });
      return;
    }
    if (!tab) throw new Error('请先打开一篇文档');
    if (action === 'generate') {
      const generated = await generateContent(client, {
        instruction: input.value.trim() || '在当前内容之后继续写一段',
        content: includeDocContext.value ? tab.content : '',
      });
      app.updateTabContent(tab.id, `${tab.content}\n\n${generated}`);
      messages.value.push({ id: `sys${Date.now()}`, role: 'assistant', text: '已在文末追加生成内容。' });
      return;
    }
    const fn = action === 'polish' ? polishContent : formatContent;
    const next = await fn(client, { content: tab.content, instruction: '' });
    app.updateTabContent(tab.id, next);
    messages.value.push({
      id: `sys${Date.now()}`,
      role: 'assistant',
      text: action === 'polish' ? '已完成全文润色。' : '已完成智能排版。',
    });
  } catch (e) {
    errorText.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

function insertLast(): void {
  const last = [...messages.value].reverse().find((m) => m.role === 'assistant' && m.text.trim());
  const tab = app.activeTab;
  if (!last || !tab) return;
  app.updateTabContent(tab.id, `${tab.content}\n\n${last.text}`);
  app.notify('已插入到文档末尾', 'success');
}

function pickModel(id: string): void {
  settingsStore.update({ ai: { ...ai.value, model: id } });
  modelOpen.value = false;
}

async function loadCreditInfo(): Promise<void> {
  if (!isPlatformMode.value) return;
  try {
    const res = await aiApi.usage();
    creditInfo.value = { balance: res.balance, tokensToday: res.tokensToday, costToday: res.costToday };
    app.credits = res.balance;
  } catch {
    creditInfo.value = null;
  }
}

function onDocClick(e: MouseEvent): void {
  if (!(e.target as HTMLElement | null)?.closest('.modelpick')) modelOpen.value = false;
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick);
  void loadCreditInfo();
  // 首次进入时让面板开关跟随设置页的总开关（之后用户在面板上的切换只影响本次会话）
  useKnowledge.value = kbSettings.value.enabled && Boolean(app.vault);
});

// 设置页里开启/关闭知识库总开关后，面板开关跟着同步；索引状态一并重置
watch(
  () => kbSettings.value.enabled,
  (enabled) => {
    useKnowledge.value = enabled && Boolean(app.vault);
    if (!enabled) {
      kbIndexed.value = false;
      kbHits.value = [];
    }
  },
);

// 切换仓库后索引必须重建，否则会用上一个仓库的切片回答
watch(
  () => app.vaultLocation,
  () => {
    kbIndexed.value = false;
    kbHits.value = [];
  },
);

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick);
});

watch(isPlatformMode, () => void loadCreditInfo());
</script>

<template>
  <aside class="ai" :class="{ 'ai--section': Boolean(props.activeTab) }">
    <header class="ai__head" :class="{ 'ai__head--section': Boolean(props.activeTab) }">
      <!--
        受控时（父级传入 activeTab，即作为右侧栏独立操作区窗口渲染）不再渲染内嵌切换标签，
        而是渲染与 RightSection.vue 完全同构的区块标题栏（图标 + 名称），
        彻底解决「打开 AI 和文件操作是标签切换，打开其他功能是上下窗口」的不一致问题。
      -->
      <div v-if="!props.activeTab" class="ai__tabs">
        <button
          v-if="ownSections.includes('ai')"
          class="ai__tab"
          :class="{ 'is-active': rightTab === 'ai' }"
          @click="setTab('ai')"
        >
          <NmIcon name="sparkles" :size="14" />
          <span>AI 助手</span>
        </button>
        <button
          v-if="ownSections.includes('file')"
          class="ai__tab"
          :class="{ 'is-active': rightTab === 'file' }"
          @click="setTab('file')"
        >
          <NmIcon name="file" :size="14" />
          <span>文件操作</span>
        </button>
      </div>
      <div v-else class="ai__sectitle">
        <NmIcon :name="rightTab === 'file' ? 'folder' : 'sparkles'" :size="13" />
        <span>{{ rightTab === 'file' ? '文件操作' : 'AI 助手' }}</span>
      </div>
      <!--
        关闭按钮在两种形态下都要有（1.1.9 补）：
        受控栈模式下原来被 `v-if="!props.activeTab"` 藏掉了，用户只能关掉整个右侧栏，
        没法只关「文件操作」这一个子窗口。受控模式下这里 emit 的 close 由 EditorPage
        接到 `toggleRightSection(secId)`，语义正好是「只移除此子窗口」。
      -->
      <button
        class="ai__close"
        :title="props.activeTab ? '关闭此子窗口' : '关闭右侧边栏'"
        :aria-label="props.activeTab ? '关闭此子窗口' : '关闭右侧边栏'"
        @click="emit('close')"
      >
        <NmIcon name="close" :size="props.activeTab ? 13 : 15" />
      </button>
    </header>

    <!-- 右侧「文件操作」面板：提供丰富的文档操作与元数据能力 -->
    <div v-if="rightTab === 'file'" class="ai__fileops nm-scroll">
      <template v-if="app.activeTab">
        <div class="fop-card">
          <div class="fop-card__title">{{ app.activeTab.title }}</div>
          <div class="fop-card__path">{{ app.activeTab.path }}</div>
          <div v-if="currentDocMeta" class="fop-card__meta">
            <span>版本 v{{ currentDocMeta.rev }}</span>
            <span>大小 {{ formatBytes(currentDocMeta.size) }}</span>
          </div>
        </div>

        <div class="fop-group-title">基础与命名</div>
        <div class="fop-grid">
          <button
            v-for="a in FILE_OPS_BASIC"
            :key="a.id"
            class="fop-card-btn"
            :title="`${a.name}｜${a.desc}`"
            @click="a.id === 'copy-path' ? copyDocPath() : emit('fileOp', a.id)"
          >
            <NmIcon :name="a.icon" :size="15" class="fop-card-btn__icon" />
            <span class="fop-card-btn__name">{{ a.name }}</span>
            <span class="fop-card-btn__desc">{{ a.desc }}</span>
          </button>
        </div>

        <div class="fop-group-title">内容整理与插入</div>
        <div class="fop-grid">
          <button
            v-for="a in FILE_OPS_CONTENT"
            :key="a.id"
            class="fop-card-btn"
            :title="`${a.name}｜${a.desc}`"
            @click="emit('fileOp', a.id)"
          >
            <NmIcon :name="a.icon" :size="15" class="fop-card-btn__icon" />
            <span class="fop-card-btn__name">{{ a.name }}</span>
            <span class="fop-card-btn__desc">{{ a.desc }}</span>
          </button>
        </div>

        <div class="fop-group-title">版本、分享与系统</div>
        <div class="fop-grid">
          <button
            v-for="a in FILE_OPS_SYSTEM"
            :key="a.id"
            class="fop-card-btn"
            :class="{ 'fop-card-btn--danger': a.id === 'delete' }"
            :title="`${a.name}｜${a.desc}`"
            @click="a.id === 'copy-path' ? copyDocPath() : emit('fileOp', a.id)"
          >
            <NmIcon :name="a.icon" :size="15" class="fop-card-btn__icon" />
            <span class="fop-card-btn__name">{{ a.name }}</span>
            <span class="fop-card-btn__desc">{{ a.desc }}</span>
          </button>
        </div>
      </template>
      <div v-else class="ai__empty">
        <NmIcon name="file" :size="22" />
        <p>尚未打开文档</p>
        <span>打开文档后可在此执行全套文件操作。</span>
      </div>
    </div>

    <!-- 右侧「AI 助手」面板：模型选择器与「带正文内容」开关始终整合在底部输入框内 -->
    <template v-else>
      <div ref="listEl" class="ai__list nm-scroll">
        <div v-if="!ready" class="ai__hint">
          <p><strong>当前尚未配置个人 API Key</strong></p>
          <p class="ai__hint-sub">
            您可以前往「个人中心 → AI 服务配置」选择<strong>平台积分</strong>作为供应商（无需 Key），或填写您自己的 API Key。
          </p>
        </div>
        <div v-else-if="!messages.length" class="ai__hint">
          <p>向 AI 提问，或点击下方快捷动作处理当前文档。</p>
          <p class="ai__hint-sub">
            可在底部输入框内直接切换已启用的模型，并勾选是否附带当前文档正文。
          </p>
        </div>
        <div v-for="m in messages" :key="m.id" class="msg" :class="`msg--${m.role}`">
          <div class="msg__bubble">
            <pre class="msg__text">{{ m.text }}<span v-if="m.streaming" class="caret">▍</span></pre>
            <div v-if="m.role === 'assistant' && !m.streaming && m.text" class="msg__actions">
              <button class="mini" @click="insertLast">插入文档</button>
              <button class="mini" @click="copyText(m.text)">复制</button>
            </div>
          </div>
        </div>
        <p v-if="errorText" class="ai__error">{{ errorText }}</p>
      </div>

      <div class="ai__quick">
        <button v-for="q in quickActions" :key="q.id" class="quick" :disabled="busy" @click="runQuick(q.id)">
          <NmIcon :name="q.icon" :size="13" />
          <span>{{ q.label }}</span>
        </button>
      </div>

      <!-- 输入框容器：内嵌模型选择下拉 + 带正文内容开关 + 发送按钮 -->
      <div class="ai__compose">
        <div class="ai__box">
          <textarea
            v-model="input"
            class="ai__input"
            rows="3"
            placeholder="输入指令或问题…（Enter 发送，Shift+Enter 换行）"
            @keydown.enter.exact.prevent="send"
          />
          <div class="ai__box-bar">
            <!-- 输入框内模型选择 -->
            <div class="modelpick">
              <button type="button" class="modelpick__btn" title="切换 AI 模型" @click="modelOpen = !modelOpen">
                <NmIcon name="sparkles" :size="12" />
                <span class="modelpick__name">{{ currentModel }}</span>
                <NmIcon name="chevronDown" :size="11" />
              </button>
              <div v-if="modelOpen" class="modelpick__menu" @mousedown.stop>
                <div class="modelpick__head">已启用模型</div>
                <button
                  v-for="m in models"
                  :key="m"
                  type="button"
                  class="modelpick__item"
                  :class="{ 'is-active': m === currentModel }"
                  @click="pickModel(m)"
                >
                  <span>{{ m }}</span>
                  <NmIcon v-if="m === currentModel" name="check" :size="12" />
                </button>
              </div>
            </div>

            <!-- 是否带正文内容选项 -->
            <label class="ctx-toggle" title="勾选后将当前打开文档的正文作为上下文发送给 AI">
              <input v-model="includeDocContext" type="checkbox" />
              <span>带正文内容</span>
            </label>

            <!-- 知识库开关：设置页开启总开关后才会出现 -->
            <label
              v-if="kbAvailable"
              class="ctx-toggle ctx-toggle--kb"
              :class="{ 'is-on': useKnowledge }"
              :title="`使用仓库知识库检索（${kbSettings.granularity} 颗粒度，topK ${kbSettings.topK}）`"
            >
              <input v-model="useKnowledge" type="checkbox" />
              <span>{{ useKnowledge ? '知识库' : '用知识库' }}</span>
              <span v-if="useKnowledge && kbHits.length" class="ctx-toggle__count">{{ kbHits.length }}</span>
            </label>

            <button v-if="busy" type="button" class="nm-btn nm-btn--sm ai__send" @click="stop">停止</button>
            <button
              v-else
              type="button"
              class="nm-btn nm-btn--primary nm-btn--sm ai__send"
              :disabled="!input.trim()"
              @click="send"
            >
              发送
            </button>
          </div>
        </div>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.ai {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-sidebar);
}
.ai__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 38px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
.ai__tabs {
  display: flex;
  align-items: center;
  gap: 4px;
}
.ai__head--section {
  height: 28px;
  padding: 0 10px;
  border-bottom: none;
}
.ai__sectitle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--fg-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai__tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--fg-2);
}
.ai__tab.is-active {
  background: var(--bg-active);
  color: var(--accent);
  font-weight: 600;
}
.ai__close {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
}
.ai__close:hover {
  background: var(--bg-hover);
  color: var(--fg);
}

.ai__fileops {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
}
.fop-card {
  padding: 11px 12px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  margin-bottom: 12px;
}
.fop-card__title {
  font-size: 13.5px;
  font-weight: 650;
  color: var(--fg);
}
.fop-card__path {
  margin-top: 3px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-3);
  word-break: break-all;
}
.fop-card__meta {
  margin-top: 6px;
  display: flex;
  gap: 10px;
  font-size: 11px;
  color: var(--accent);
}
.fop-group-title {
  font-size: 10.5px;
  font-weight: 700;
  color: var(--fg-3);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin: 10px 4px 5px;
}
.fop-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.fop-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 7px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  font-size: 12.5px;
  color: var(--fg);
  text-align: left;
}
.fop-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.fop-btn--danger {
  color: #d93025;
}
.fop-btn--danger:hover {
  border-color: #d93025;
  color: #d93025;
}

/*
 * 文件操作卡片网格（1.0.2）。
 *
 * 规格：卡片严格 160×75、圆角 10px、名称 1 行 + 描述最多 2 行。
 * 列宽固定 160px（不用 1fr，否则窄容器会把单张卡拉成很宽、每排只剩 1 张），
 * 因此每排数量=容器能容纳的 160px 列数，随右侧栏宽度自适应，最多 8 张。
 * 右侧栏默认 400px → 可用约 384px → 每排 2 张；拖宽后递增到 8 张。
 */
.fop-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, 160px);
  justify-content: space-between;
  gap: 8px;
  /* 8 列上限：8*160 + 7*8 = 1336px，超出后不再增列 */
  max-width: 1336px;
}
.fop-card-btn {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 160px;
  height: 75px;
  padding: 9px 10px;
  border-radius: 10px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  text-align: left;
  overflow: hidden;
  transition: border-color 0.14s ease, background 0.14s ease, transform 0.08s ease;
}
.fop-card-btn:hover {
  border-color: var(--accent);
  background: var(--bg-hover);
}
.fop-card-btn:active {
  transform: scale(0.99);
}
.fop-card-btn__icon {
  color: var(--accent);
  flex: 0 0 auto;
}
.fop-card-btn__name {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fop-card-btn__desc {
  font-size: 10.5px;
  line-height: 1.45;
  color: var(--fg-3);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.fop-card-btn--danger .fop-card-btn__icon,
.fop-card-btn--danger .fop-card-btn__name {
  color: #d93025;
}
.fop-card-btn--danger:hover {
  border-color: #d93025;
}

/* 窄屏（右侧栏被拖很窄）时放宽到单列可读的最小宽度，仍保证每排 >= 1 张不溢出 */
@media (max-width: 420px) {
  .fop-grid {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  }
}

.ai__empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  color: var(--fg-3);
  font-size: 12.5px;
}
.ai__empty p {
  margin: 0;
  font-weight: 600;
  color: var(--fg-2);
}

.ai__list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ai__hint {
  padding: 14px;
  border-radius: 10px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  font-size: 12.5px;
  color: var(--fg-2);
}
.ai__hint p {
  margin: 0;
}
.ai__hint-sub {
  margin-top: 4px !important;
  font-size: 11.5px;
  color: var(--fg-3);
}
.msg {
  display: flex;
}
.msg--user {
  justify-content: flex-end;
}
.msg__bubble {
  max-width: 92%;
  padding: 9px 11px;
  border-radius: 10px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  font-size: 12.5px;
  line-height: 1.65;
}
.msg--user .msg__bubble {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.msg--error .msg__bubble {
  border-color: #d93025;
  color: #d93025;
}
.msg__text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
}
.msg__actions {
  margin-top: 6px;
  display: flex;
  gap: 6px;
}
.mini {
  padding: 2px 7px;
  border-radius: 5px;
  font-size: 11px;
  background: var(--bg-hover);
  color: var(--accent);
}
.ai__error {
  margin: 0;
  font-size: 12px;
  color: #d93025;
}

.ai__quick {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 6px 10px;
  border-top: 1px solid var(--border);
  flex: 0 0 auto;
}
.quick {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--fg-2);
}
.quick:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.ai__compose {
  padding: 8px 10px 10px;
  border-top: 1px solid var(--border);
  flex: 0 0 auto;
}
.ai__box {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-elevated);
  display: flex;
  flex-direction: column;
  transition: border-color 0.14s ease;
}
.ai__box:focus-within {
  border-color: var(--accent);
}
.ai__input {
  width: 100%;
  border: none;
  background: transparent;
  padding: 8px 10px 4px;
  font-size: 12.5px;
  color: var(--fg);
  resize: none;
  outline: none;
}
.ai__box-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 6px;
  border-top: 1px dashed var(--border);
  flex-wrap: wrap;
}
.modelpick {
  position: relative;
  min-width: 0;
}
.modelpick__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 7px;
  border-radius: 6px;
  background: var(--bg-hover);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-2);
  max-width: 135px;
}
.modelpick__btn:hover {
  color: var(--accent);
}
.modelpick__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.modelpick__menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  z-index: 700;
  min-width: 190px;
  max-height: 220px;
  overflow-y: auto;
  padding: 5px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-3);
}
.modelpick__head {
  padding: 4px 8px;
  font-size: 10.5px;
  font-weight: 700;
  color: var(--fg-3);
}
.modelpick__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--fg);
  text-align: left;
}
.modelpick__item:hover {
  background: var(--bg-hover);
}
.modelpick__item.is-active {
  color: var(--accent);
  font-weight: 600;
}
.ctx-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--fg-2);
  cursor: pointer;
  user-select: none;
}
.ctx-toggle input {
  accent-color: var(--accent);
}
/* 知识库开关：开启时高亮，并在右侧显示本次检索命中的片段数 */
.ctx-toggle--kb.is-on {
  color: var(--accent);
  font-weight: 600;
}
.ctx-toggle__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--accent);
}
.ai__send {
  margin-left: auto;
  height: 24px;
  padding: 0 10px;
  font-size: 11.5px;
}
</style>
