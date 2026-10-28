<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { NmIcon, NmModal } from '@neomd/ui';
import {
  adminApi,
  adminApiV2,
  aiProvidersApi,
  type UserDto,
  type AdminStats,
  type ModelPriceRule,
  type CommunityPluginDto,
} from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { formatCompactNumber, formatBytes } from '@neomd/shared';
// 1.1.7 新增：数据看板 / 仓库管理 / 积分流水 / 配置中心（独立组件，本页只做装配）
import AdminDashboard from '@/components/admin/AdminDashboard.vue';
import AdminVaults from '@/components/admin/AdminVaults.vue';
import AdminLedger from '@/components/admin/AdminLedger.vue';
import AdminConfig from '@/components/admin/AdminConfig.vue';
import { adminApiV3, type AdminDashboard as AdminDashboardData } from '@/api/client';

const router = useRouter();
const auth = useAuthStore();

type Tab =
  | 'dashboard'
  | 'overview'
  | 'users'
  | 'vaults'
  | 'credits'
  | 'ledger'
  | 'ai'
  | 'billing'
  | 'config'
  | 'shares'
  | 'publishes'
  | 'plugins'
  | 'releases'
  | 'audit';

/**
 * 左侧导航分组（1.1.7「更大气」改造的一部分）。
 *
 * 分组后 14 个页签不再平铺，管理员能按「总览 / 内容与用户 / 商业化 / 系统」快速定位。
 * `group` 只影响渲染时的分隔标题，不改变页签 id。
 */
const TABS: Array<{ id: Tab; label: string; icon: string; group: string }> = [
  { id: 'dashboard', label: '数据看板', icon: 'layout', group: '总览' },
  { id: 'overview', label: '运营概览', icon: 'zap', group: '总览' },
  { id: 'users', label: '用户与配额', icon: 'users', group: '内容与用户' },
  { id: 'vaults', label: '仓库管理', icon: 'hdd', group: '内容与用户' },
  { id: 'shares', label: '分享与评价', icon: 'share', group: '内容与用户' },
  { id: 'publishes', label: '网页发布', icon: 'globe', group: '内容与用户' },
  { id: 'plugins', label: '插件市场', icon: 'layers', group: '内容与用户' },
  { id: 'credits', label: '积分与兑换码', icon: 'coins', group: '商业化' },
  { id: 'ledger', label: '积分流水', icon: 'bill', group: '商业化' },
  { id: 'ai', label: 'AI 供应商', icon: 'sparkles', group: '商业化' },
  { id: 'billing', label: '计费与赠送', icon: 'wallet', group: '商业化' },
  { id: 'config', label: '配置中心', icon: 'settings', group: '系统' },
  { id: 'audit', label: '审计日志', icon: 'shield', group: '系统' },
  { id: 'releases', label: '客户端分发', icon: 'download', group: '系统' },
];

/** 按 group 聚合出侧栏分组，保持 TABS 的定义顺序 */
const TAB_GROUPS = computed(() => {
  const out: Array<{ group: string; items: Array<{ id: Tab; label: string; icon: string; group: string }> }> = [];
  for (const t of TABS) {
    const last = out[out.length - 1];
    if (last && last.group === t.group) last.items.push(t);
    else out.push({ group: t.group, items: [t] });
  }
  return out;
});

const tab = ref<Tab>('dashboard');

/* ---------------- 1.1.7 数据看板状态 ---------------- */
const dashboard = ref<AdminDashboardData | null>(null);
const dashboardDays = ref(7);
const dashboardLoading = ref(false);

async function loadDashboard(): Promise<void> {
  dashboardLoading.value = true;
  errorText.value = '';
  try {
    dashboard.value = await adminApiV3.dashboard(dashboardDays.value);
  } catch (e) {
    errorText.value = (e as Error).message;
  } finally {
    dashboardLoading.value = false;
  }
}

async function onDashboardRange(days: number): Promise<void> {
  dashboardDays.value = days;
  await loadDashboard();
}

const loading = ref(false);
const errorText = ref('');
const notice = ref('');
const EMPTY_STATS: AdminStats & {
  credits?: { circulating: number; consumedToday: number; rechargedToday: number };
  backups?: { total: number; bytes: number };
  aiPlatform?: { enabledProviders: number };
} = {
  users: { total: 0, active: 0, disabled: 0, admins: 0, newToday: 0, newThisWeek: 0 },
  shares: { total: 0, active: 0, views: 0 },
  publishes: { total: 0, active: 0 },
  comments: { total: 0, hidden: 0 },
  storage: { bytes: 0, documents: 0, vaults: 0 },
  ai: { requests24h: 0, inTokens24h: 0, outTokens24h: 0 },
  signupsDaily: [],
  uptimeSeconds: 0,
};
const stats = ref(EMPTY_STATS);

const users = ref<UserDto[]>([]);
const userTotal = ref(0);
const userPage = ref(1);
const userSearch = ref('');
const userStatus = ref('');
const userSort = ref('created');
const pageSize = 20;

const shares = ref<Array<Record<string, unknown>>>([]);
const expandedShareId = ref<number | null>(null);
const shareCommentsMap = ref<Record<number, Array<{ id: number; shareId: number; authorName: string; body: string; quote?: string; status: 'visible' | 'hidden'; createdAt: string }>>>({});
const publishes = ref<Array<Record<string, unknown>>>([]);
const communityPlugins = ref<CommunityPluginDto[]>([]);
const pluginSearch = ref('');
const audit = ref<Array<Record<string, unknown>>>([]);

const codes = ref<Array<Record<string, unknown>>>([]);
const codeCount = ref(10);
const codeCredits = ref(1000);
const generatedCodes = ref<string[]>([]);

const aiProviders = ref<
  Array<{
    provider: string;
    name: string;
    baseUrl: string;
    enabled: boolean;
    priority?: number;
    apiKeySet: boolean;
    models: string[];
    updatedAt: string;
    // 1.1.7 展示元数据（后台可编辑）
    signupUrl?: string;
    docsUrl?: string;
    note?: string;
    sortOrder?: number;
  }>
>([]);
const aiEdit = ref<{
  provider: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  priority: number;
  modelsStr: string;
} | null>(null);

/* ---------------- AI 供应商展示配置（1.1.7） ---------------- */

/**
 * 「展示配置」编辑态：申请地址 / 文档地址 / 说明文案 / 排序。
 *
 * 与 aiEdit（密钥与优先级）分开维护的原因：
 *  - 密钥类改动风险高，需要单独确认；
 *  - 展示文案是运营高频调整项，做成行内编辑并支持批量保存更顺手。
 */
interface AiProviderMetaRow {
  provider: string;
  name: string;
  enabled: boolean;
  signupUrl: string;
  docsUrl: string;
  note: string;
  sortOrder: number;
  modelCount: number;
  apiKeySet: boolean;
  defaults: { signupUrl: string; docsUrl: string; note: string; sortOrder: number };
  dirty?: boolean;
}

const aiMetaRows = ref<AiProviderMetaRow[]>([]);
const aiMetaLoading = ref(false);
const aiMetaSaving = ref(false);
const aiMetaMessage = ref('');

/** 拉取展示配置（含默认值，供「恢复默认」使用） */
async function loadAiMeta(): Promise<void> {
  aiMetaLoading.value = true;
  aiMetaMessage.value = '';
  try {
    const res = await aiProvidersApi.meta();
    aiMetaRows.value = res.providers.map((item) => ({
      provider: item.provider,
      name: item.name,
      enabled: item.enabled,
      signupUrl: item.signupUrl ?? '',
      docsUrl: item.docsUrl ?? '',
      note: item.note ?? '',
      sortOrder: Number(item.sortOrder ?? 100),
      modelCount: Number(item.modelCount ?? 0),
      apiKeySet: Boolean(item.apiKeySet),
      defaults: item.defaults,
      dirty: false,
    }));
  } catch (e) {
    aiMetaMessage.value = `加载展示配置失败：${(e as Error).message}`;
  } finally {
    aiMetaLoading.value = false;
  }
}

/** 标记某行已修改 */
function markAiMetaDirty(row: AiProviderMetaRow): void {
  row.dirty = true;
}

/** 单行恢复默认值（仅改表单，仍需点保存） */
function resetAiMetaRow(row: AiProviderMetaRow): void {
  row.signupUrl = row.defaults.signupUrl;
  row.docsUrl = row.defaults.docsUrl;
  row.note = row.defaults.note;
  row.sortOrder = row.defaults.sortOrder;
  row.dirty = true;
}

/** 批量保存展示配置：只提交有改动的行 */
async function saveAiMeta(): Promise<void> {
  const changed = aiMetaRows.value.filter((row) => row.dirty);
  if (changed.length === 0) {
    aiMetaMessage.value = '没有需要保存的修改';
    return;
  }
  aiMetaSaving.value = true;
  aiMetaMessage.value = '';
  try {
    await aiProvidersApi.saveMeta(
      changed.map((row) => ({
        provider: row.provider,
        enabled: row.enabled,
        signupUrl: row.signupUrl.trim(),
        docsUrl: row.docsUrl.trim(),
        note: row.note.trim(),
        sortOrder: Number(row.sortOrder) || 100,
      })),
    );
    aiMetaMessage.value = `已保存 ${changed.length} 个供应商的展示配置，前台设置页下次打开即生效`;
    // 重新拉一次，拿到服务端归一化后的值（空串会回落到默认值）
    await loadAiMeta();
    // 同步刷新上方的密钥/优先级表格，避免两处状态不一致
    aiProviders.value = (await adminApiV2.ai()).providers;
  } catch (e) {
    aiMetaMessage.value = `保存失败：${(e as Error).message}`;
  } finally {
    aiMetaSaving.value = false;
  }
}

interface EditableModelRule {
  model: string;
  mode: 'tokens' | 'request' | 'free';
  in: number;
  out: number;
  perCall: number;
  providersStr: string;
}

const billing = ref<{
  creditPerYuan: number;
  signupGrantCredits: number;
  dailyGrantCredits: number;
  modelPrices: Record<string, ModelPriceRule>;
  paymentMethods: Array<{ id: string; name: string; note: string; enabled: boolean }>;
} | null>(null);

const modelRules = ref<EditableModelRule[]>([]);
const newModelName = ref('');
const pricesText = ref('');
const methodsText = ref('');

const releases = ref<Array<{ key: string; size: number; lastModified: string; url: string }>>([]);

const detail = ref<Record<string, unknown> | null>(null);
const detailOpen = ref(false);
const creditAmount = ref(100);
const creditReason = ref('管理员调整');

async function loadStats(): Promise<void> {
  try {
    stats.value = (await adminApi.stats()) as never;
  } catch (e) {
    errorText.value = (e as Error).message;
  }
}

async function loadUsers(): Promise<void> {
  loading.value = true;
  try {
    const res = await adminApi.users({ page: userPage.value, size: pageSize, search: userSearch.value });
    users.value = res.items;
    userTotal.value = res.total;
  } catch (e) {
    errorText.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

function syncRulesToPricesText(): void {
  const obj: Record<string, ModelPriceRule> = {};
  for (const r of modelRules.value) {
    const name = r.model.trim();
    if (!name) continue;
    obj[name] = {
      mode: r.mode,
      in: Number(r.in) || 0,
      out: Number(r.out) || 0,
      perCall: Number(r.perCall) || 0,
      providers: r.providersStr
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }
  pricesText.value = JSON.stringify(obj, null, 2);
}

async function loadTab(): Promise<void> {
  errorText.value = '';
  notice.value = '';
  loading.value = true;
  try {
    // 1.1.7：数据看板走独立接口；仓库 / 流水 / 配置由子组件自取，这里只需渲染
    if (tab.value === 'dashboard') await loadDashboard();
    else if (tab.value === 'vaults' || tab.value === 'ledger' || tab.value === 'config') {
      // 子组件 onMounted 自行拉取；切换到已挂载过的页签时由组件内部缓存，不重复请求
    } else if (tab.value === 'overview') await loadStats();
    else if (tab.value === 'users') await loadUsers();
    else if (tab.value === 'shares') shares.value = (await adminApi.shares({ page: 1, size: pageSize })).items;
    else if (tab.value === 'publishes') publishes.value = (await adminApi.publishes({ page: 1, size: pageSize })).items;
    else if (tab.value === 'plugins') communityPlugins.value = (await adminApiV2.plugins(1, 50, pluginSearch.value)).items;
    else if (tab.value === 'audit') audit.value = (await adminApi.audit({ page: 1, size: 40 })).items;
    else if (tab.value === 'credits') codes.value = (await adminApiV2.redeemCodes()).items;
    else if (tab.value === 'ai') {
      aiProviders.value = (await adminApiV2.ai()).providers;
      // 1.1.7：同时加载展示配置（申请地址 / 说明 / 排序），失败不影响密钥表格
      void loadAiMeta();
    }
    else if (tab.value === 'billing') {
      const b = await adminApiV2.billing();
      billing.value = {
        creditPerYuan: b.creditPerYuan,
        signupGrantCredits: b.signupGrantCredits ?? 200,
        dailyGrantCredits: b.dailyGrantCredits ?? 20,
        modelPrices: b.modelPrices ?? {},
        paymentMethods: b.paymentMethods ?? [],
      };
      modelRules.value = Object.entries(b.modelPrices ?? {}).map(([m, rule]) => ({
        model: m,
        mode: rule.mode ?? 'tokens',
        in: Number(rule.in ?? 1),
        out: Number(rule.out ?? 2),
        perCall: Number(rule.perCall ?? 2),
        providersStr: (rule.providers ?? []).join(', '),
      }));
      pricesText.value = JSON.stringify(b.modelPrices, null, 2);
      methodsText.value = JSON.stringify(b.paymentMethods, null, 2);
    } else if (tab.value === 'releases') releases.value = (await adminApiV2.releases()).files;
  } catch (e) {
    errorText.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function switchTab(id: Tab): Promise<void> {
  tab.value = id;
  await loadTab();
}

async function toggleStatus(u: UserDto): Promise<void> {
  try {
    await adminApi.updateUser(u.id, { status: u.status === 'active' ? 'disabled' : 'active' });
    await loadUsers();
  } catch (e) {
    errorText.value = (e as Error).message;
  }
}

async function toggleRole(u: UserDto): Promise<void> {
  if (!window.confirm(`${u.username}：${u.role === 'admin' ? '撤销管理员' : '设为管理员'}？`)) return;
  try {
    await adminApi.updateUser(u.id, { role: u.role === 'admin' ? 'user' : 'admin' });
    await loadUsers();
  } catch (e) {
    errorText.value = (e as Error).message;
  }
}

async function resetPassword(u: UserDto): Promise<void> {
  if (!window.confirm(`重置 ${u.username} 的密码？新密码只显示一次。`)) return;
  try {
    const res = await adminApi.resetPassword(u.id);
    notice.value = `${u.username} 的新密码：${res.password}`;
  } catch (e) {
    errorText.value = (e as Error).message;
  }
}

async function removeUser(u: UserDto): Promise<void> {
  if (!window.confirm(`删除用户 ${u.username}？不可撤销。`)) return;
  try {
    await adminApi.deleteUser(u.id);
    await loadUsers();
  } catch (e) {
    errorText.value = (e as Error).message;
  }
}

async function openDetail(u: UserDto): Promise<void> {
  try {
    detail.value = await adminApiV2.userDetail(u.id);
    detailOpen.value = true;
  } catch (e) {
    errorText.value = (e as Error).message;
  }
}

async function adjustCredits(): Promise<void> {
  const u = detail.value?.user as { id?: number } | undefined;
  if (!u?.id) return;
  try {
    await adminApiV2.adjustCredits(u.id, { amount: creditAmount.value, reason: creditReason.value });
    notice.value = '积分已调整';
    detail.value = await adminApiV2.userDetail(u.id);
    await loadStats();
  } catch (e) {
    errorText.value = (e as Error).message;
  }
}

/** 修复点击生成兑换码后因为 res.codes 为 undefined 导致页面报错空白的问题 */
async function generateCodes(): Promise<void> {
  errorText.value = '';
  try {
    const res = await adminApiV2.createCodes({ count: codeCount.value, credits: codeCredits.value });
    const list = Array.isArray(res.codes)
      ? res.codes
      : Array.isArray(res.items)
        ? res.items.map((x) => x.code)
        : [];
    generatedCodes.value = list;
    codes.value = (await adminApiV2.redeemCodes()).items;
    notice.value = `已成功生成 ${list.length} 个兑换码`;
  } catch (e) {
    errorText.value = (e as Error).message;
  }
}

async function deleteCode(id: number): Promise<void> {
  try {
    await adminApiV2.deleteCode(id);
    codes.value = (await adminApiV2.redeemCodes()).items;
  } catch (e) {
    errorText.value = (e as Error).message;
  }
}

function openAiEditModal(p: (typeof aiProviders.value)[number]): void {
  aiEdit.value = {
    provider: p.provider,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: '',
    enabled: p.enabled,
    priority: p.priority ?? 100,
    modelsStr: (p.models ?? []).join(', '),
  };
}

async function saveAi(): Promise<void> {
  if (!aiEdit.value) return;
  const models = aiEdit.value.modelsStr
    .split(/[,，\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const body: { baseUrl?: string; enabled?: boolean; priority?: number; models?: string[]; apiKey?: string } = {
    baseUrl: aiEdit.value.baseUrl,
    enabled: aiEdit.value.enabled,
    priority: Number(aiEdit.value.priority) || 100,
    models,
  };
  if (aiEdit.value.apiKey) body.apiKey = aiEdit.value.apiKey;
  try {
    await adminApiV2.saveAi(aiEdit.value.provider, body);
    aiEdit.value = null;
    aiProviders.value = (await adminApiV2.ai()).providers;
    notice.value = 'AI 供应商与优先级配置已保存';
  } catch (e) {
    errorText.value = (e as Error).message;
  }
}

function addModelRule(): void {
  const m = newModelName.value.trim();
  if (!m) return;
  if (modelRules.value.some((x) => x.model === m)) return;
  modelRules.value.push({
    model: m,
    mode: 'tokens',
    in: 1,
    out: 2,
    perCall: 2,
    providersStr: 'deepseek',
  });
  newModelName.value = '';
  syncRulesToPricesText();
}

function removeModelRule(idx: number): void {
  modelRules.value.splice(idx, 1);
  syncRulesToPricesText();
}

async function saveBilling(): Promise<void> {
  if (!billing.value) return;
  try {
    syncRulesToPricesText();
    const modelPrices = JSON.parse(pricesText.value) as Record<string, ModelPriceRule>;
    const paymentMethods = JSON.parse(methodsText.value) as Array<{ id: string; name: string; note: string; enabled: boolean }>;
    await adminApiV2.saveBilling({
      creditPerYuan: billing.value.creditPerYuan,
      signupGrantCredits: billing.value.signupGrantCredits,
      dailyGrantCredits: billing.value.dailyGrantCredits,
      modelPrices,
      paymentMethods,
    });
    notice.value = '计费规则、模型供应商优先级与积分赠送配置已保存';
    await loadTab();
  } catch (e) {
    errorText.value = `保存失败：${(e as Error).message}`;
  }
}

async function revokeShare(id: number): Promise<void> {
  try {
    await adminApi.revokeShare(id);
    shares.value = (await adminApi.shares({ page: 1, size: pageSize })).items;
  } catch (e) {
    errorText.value = (e as Error).message;
  }
}

/** 评价跟随分享内容：展开某条分享查看并管理其下所有评论 */
async function toggleShareComments(shareId: number): Promise<void> {
  if (expandedShareId.value === shareId) {
    expandedShareId.value = null;
    return;
  }
  expandedShareId.value = shareId;
  try {
    const res = await adminApiV2.shareComments(shareId);
    shareCommentsMap.value = { ...shareCommentsMap.value, [shareId]: res.items };
  } catch (e) {
    errorText.value = (e as Error).message;
  }
}

async function toggleCommentInShare(shareId: number, commentId: number, currentStatus: string): Promise<void> {
  try {
    const next = currentStatus === 'visible' ? 'hidden' : 'visible';
    await adminApi.setCommentStatus(commentId, next);
    const res = await adminApiV2.shareComments(shareId);
    shareCommentsMap.value = { ...shareCommentsMap.value, [shareId]: res.items };
  } catch (e) {
    errorText.value = (e as Error).message;
  }
}

async function revokePublish(id: number): Promise<void> {
  try {
    await adminApi.revokePublish(id);
    publishes.value = (await adminApi.publishes({ page: 1, size: pageSize })).items;
  } catch (e) {
    errorText.value = (e as Error).message;
  }
}

async function setPluginStatus(id: number, status: 'published' | 'pending' | 'rejected' | 'disabled'): Promise<void> {
  try {
    await adminApiV2.setPluginStatus(id, status);
    communityPlugins.value = (await adminApiV2.plugins(1, 50, pluginSearch.value)).items;
    notice.value = '插件状态已更新';
  } catch (e) {
    errorText.value = (e as Error).message;
  }
}

function fmtTime(v: unknown): string {
  if (!v) return '—';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(
    d.getHours(),
  ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const totalPages = computed(() => Math.max(1, Math.ceil(userTotal.value / pageSize)));
function maxDaily(): number {
  return Math.max(1, ...stats.value.signupsDaily.map((d) => d.count));
}

async function gotoPage(p: number): Promise<void> {
  userPage.value = Math.min(totalPages.value, Math.max(1, p));
  await loadUsers();
}

async function searchUsers(): Promise<void> {
  userPage.value = 1;
  await loadUsers();
}

function copyCodes(): void {
  void navigator.clipboard?.writeText(generatedCodes.value.join('\n'));
  notice.value = '兑换码已复制到剪贴板';
}

onMounted(async () => {
  await auth.restore();
  if (!auth.isAdmin) {
    void router.push('/login?redirect=/admin');
    return;
  }
  // 默认落在数据看板（1.1.7），同时预取运营概览的旧接口数据，切页签时无需再等
  await Promise.all([loadDashboard(), loadStats()]);
});
</script>

<template>
  <div class="admin">
    <aside class="admin__nav">
      <div class="admin__brand">
        <span class="mark">N</span>
        <div>
          <strong>Neo MD</strong>
          <span>运营管理后台</span>
        </div>
      </div>
      <!-- 分组导航（1.1.7）：每组一个小标题，避免 14 个页签平铺难找 -->
      <nav class="admin__nav-list">
        <div v-for="g in TAB_GROUPS" :key="g.group" class="nav-group">
          <p class="nav-group__title">{{ g.group }}</p>
          <button
            v-for="t in g.items"
            :key="t.id"
            class="nav-item"
            :class="{ 'is-active': tab === t.id }"
            @click="switchTab(t.id)"
          >
            <NmIcon :name="t.icon" :size="16" />
            <span>{{ t.label }}</span>
          </button>
        </div>
      </nav>
      <div class="admin__nav-foot">
        <button class="nav-item" @click="router.push('/account')">
          <NmIcon name="user" :size="16" />
          <span>个人中心</span>
        </button>
        <button class="nav-item" @click="router.push('/app')">
          <NmIcon name="chevronLeft" :size="16" />
          <span>返回编辑器</span>
        </button>
      </div>
    </aside>

    <main class="admin__main">
      <header class="admin__header">
        <div class="admin__crumb">
          <span class="admin__crumb-root">管理后台</span>
          <NmIcon name="chevronRight" :size="13" />
          <span class="admin__crumb-group">{{ TABS.find((t) => t.id === tab)?.group }}</span>
          <NmIcon name="chevronRight" :size="13" />
          <h1>{{ TABS.find((t) => t.id === tab)?.label }}</h1>
        </div>
        <div class="admin__user">
          <span class="admin__who">{{ auth.user?.username }}</span>
          <span class="admin__chip">管理员</span>
        </div>
      </header>

      <p v-if="errorText" class="banner banner--err">{{ errorText }}</p>
      <p v-if="notice" class="banner banner--ok">{{ notice }}</p>

      <div class="admin__body nm-scroll">
        <!-- 0. 数据看板（1.1.7 新增，默认页） -->
        <AdminDashboard
          v-if="tab === 'dashboard'"
          :data="dashboard"
          :loading="dashboardLoading"
          @range-change="onDashboardRange"
          @refresh="loadDashboard"
        />

        <!-- 0.1 仓库管理（1.1.7） -->
        <AdminVaults
          v-else-if="tab === 'vaults'"
          @notify="(m: string) => (notice = m)"
          @fail="(m: string) => (errorText = m)"
        />

        <!-- 0.2 积分流水（1.1.7） -->
        <AdminLedger
          v-else-if="tab === 'ledger'"
          @notify="(m: string) => (notice = m)"
          @fail="(m: string) => (errorText = m)"
        />

        <!-- 0.3 配置中心（1.1.7） -->
        <AdminConfig
          v-else-if="tab === 'config'"
          @notify="(m: string) => (notice = m)"
          @fail="(m: string) => (errorText = m)"
        />

        <!-- 1. 运营概览（不含独立改密框，密码跟随用户账号） -->
        <template v-else-if="tab === 'overview'">
          <div class="stat-grid">
            <article class="stat-card">
              <span class="label">用户总数</span>
              <span class="value">{{ formatCompactNumber(stats.users.total) }}</span>
              <span class="sub">今日新增 {{ stats.users.newToday }} · 禁用 {{ stats.users.disabled }}</span>
            </article>
            <article class="stat-card">
              <span class="label">分享链接</span>
              <span class="value">{{ formatCompactNumber(stats.shares.total) }}</span>
              <span class="sub">有效 {{ stats.shares.active }} · 浏览 {{ formatCompactNumber(stats.shares.views) }}</span>
            </article>
            <article class="stat-card">
              <span class="label">发布页面</span>
              <span class="value">{{ formatCompactNumber(stats.publishes.total) }}</span>
              <span class="sub">在线 {{ stats.publishes.active }}</span>
            </article>
            <article class="stat-card">
              <span class="label">内容评价</span>
              <span class="value">{{ formatCompactNumber(stats.comments.total) }}</span>
              <span class="sub">已隐藏 {{ stats.comments.hidden }}</span>
            </article>
            <article class="stat-card">
              <span class="label">流通积分</span>
              <span class="value">{{ formatCompactNumber(stats.credits?.circulating ?? 0) }}</span>
              <span class="sub">今日消耗 {{ stats.credits?.consumedToday ?? 0 }}</span>
            </article>
            <article class="stat-card">
              <span class="label">云端备份</span>
              <span class="value">{{ formatCompactNumber(stats.backups?.total ?? 0) }}</span>
              <span class="sub">{{ formatBytes(stats.backups?.bytes ?? 0) }}</span>
            </article>
            <article class="stat-card">
              <span class="label">平台 AI 渠道</span>
              <span class="value">{{ stats.aiPlatform?.enabledProviders ?? 0 }}</span>
              <span class="sub">已启用供应商</span>
            </article>
            <article class="stat-card">
              <span class="label">存储占用</span>
              <span class="value">{{ formatBytes(stats.storage.bytes) }}</span>
              <span class="sub">{{ formatCompactNumber(stats.storage.documents) }} 篇</span>
            </article>
            <article class="stat-card stat-card--wide">
              <span class="label">近 14 天注册趋势</span>
              <div class="spark">
                <span
                  v-for="d in stats.signupsDaily"
                  :key="d.date"
                  class="spark__bar"
                  :style="{ height: `${Math.max(4, (d.count / maxDaily()) * 100)}%` }"
                  :title="`${d.date}：${d.count}`"
                />
              </div>
            </article>
          </div>
        </template>

        <!-- 2. 用户 -->
        <template v-else-if="tab === 'users'">
          <div class="toolbar-row">
            <input v-model="userSearch" class="nm-input toolbar-row__search" placeholder="搜索用户名或邮箱" @keyup.enter="searchUsers" />
            <select v-model="userStatus" class="nm-input toolbar-row__sel" @change="searchUsers">
              <option value="">全部状态</option>
              <option value="active">正常</option>
              <option value="disabled">已禁用</option>
            </select>
            <select v-model="userSort" class="nm-input toolbar-row__sel" @change="searchUsers">
              <option value="created">按注册时间</option>
              <option value="lastLogin">按最近登录</option>
              <option value="credits">按积分</option>
              <option value="documents">按文档数</option>
            </select>
            <button class="nm-btn nm-btn--sm" @click="searchUsers">搜索</button>
            <span class="toolbar-row__count">共 {{ userTotal }} 位</span>
          </div>
          <table class="table">
            <thead>
              <tr><th>用户</th><th>邮箱</th><th>角色</th><th>状态</th><th>积分</th><th>注册</th><th class="right">操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="u in users" :key="u.id">
                <td class="strong">{{ u.username }}</td>
                <td class="muted">{{ u.email }}</td>
                <td><button class="tag" :class="{ 'tag--accent': u.role === 'admin' }" @click="toggleRole(u)">{{ u.role === 'admin' ? '管理员' : '普通' }}</button></td>
                <td><button class="tag" :class="{ 'tag--warn': u.status !== 'active' }" @click="toggleStatus(u)">{{ u.status === 'active' ? '正常' : '已禁用' }}</button></td>
                <td class="muted">{{ formatCompactNumber(u.credits ?? 0) }}</td>
                <td class="muted">{{ fmtTime(u.createdAt) }}</td>
                <td class="right">
                  <button class="row-btn" @click="openDetail(u)">详情/调积分</button>
                  <button class="row-btn" @click="resetPassword(u)">重置密码</button>
                  <button class="row-btn row-btn--danger" @click="removeUser(u)">删除</button>
                </td>
              </tr>
              <tr v-if="!users.length"><td colspan="7" class="empty">没有匹配的用户</td></tr>
            </tbody>
          </table>
          <div class="pager">
            <button class="nm-btn nm-btn--sm" :disabled="userPage <= 1" @click="gotoPage(userPage - 1)">上一页</button>
            <span>{{ userPage }} / {{ totalPages }}</span>
            <button class="nm-btn nm-btn--sm" :disabled="userPage >= totalPages" @click="gotoPage(userPage + 1)">下一页</button>
          </div>
        </template>

        <!-- 3. 积分与兑换码 -->
        <template v-else-if="tab === 'credits'">
          <div class="inline-form">
            <input v-model.number="codeCount" class="nm-input nm-input--num" type="number" min="1" max="100" />
            <span class="muted">个兑换码，每个</span>
            <input v-model.number="codeCredits" class="nm-input nm-input--num" type="number" min="1" />
            <span class="muted">积分</span>
            <button class="nm-btn nm-btn--primary nm-btn--sm" @click="generateCodes">生成</button>
            <button v-if="generatedCodes.length" class="nm-btn nm-btn--sm" @click="copyCodes">复制全部</button>
          </div>
          <pre v-if="generatedCodes.length" class="codes">{{ generatedCodes.join('\n') }}</pre>
          <table class="table">
            <thead>
              <tr><th>兑换码</th><th>积分</th><th>状态</th><th>使用者</th><th>创建时间</th><th class="right">操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="c in codes" :key="String(c.id)">
                <td class="mono">{{ c.code }}</td>
                <td>{{ c.credits }}</td>
                <td><span class="tag" :class="{ 'tag--warn': c.usedBy || c.used_by }">{{ c.usedBy || c.used_by ? '已使用' : '未使用' }}</span></td>
                <td class="muted">{{ c.usedByUsername || '—' }}</td>
                <td class="muted">{{ fmtTime(c.created_at ?? c.createdAt) }}</td>
                <td class="right">
                  <button v-if="!(c.usedBy || c.used_by)" class="row-btn row-btn--danger" @click="deleteCode(Number(c.id))">删除</button>
                </td>
              </tr>
              <tr v-if="!codes.length"><td colspan="6" class="empty">还没有兑换码</td></tr>
            </tbody>
          </table>
        </template>

        <!-- 4. AI 供应商与优先级 -->
        <template v-else-if="tab === 'ai'">
          <p class="hint">
            配置平台统一 API Key 与供应商优先级（数字越小优先级越高，如 10 优先于 100）。当同一个模型有多个供应商支持时，系统自动按顺序路由并在故障时自动切换备用供应商。
          </p>
          <table class="table">
            <thead>
              <tr><th>供应商</th><th>优先级</th><th>Base URL</th><th>Key 状态</th><th>启用状态</th><th>支持模型</th><th class="right">操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="p in aiProviders" :key="p.provider">
                <td class="strong">{{ p.name }} <span class="muted">({{ p.provider }})</span></td>
                <td><span class="tag tag--accent">优先级 {{ p.priority ?? 100 }}</span></td>
                <td class="mono">{{ p.baseUrl }}</td>
                <td><span class="tag" :class="{ 'tag--ok': p.apiKeySet }">{{ p.apiKeySet ? '已配置' : '未配置' }}</span></td>
                <td><span class="tag" :class="{ 'tag--accent': p.enabled }">{{ p.enabled ? '已启用' : '未启用' }}</span></td>
                <td class="muted">{{ (p.models ?? []).slice(0, 4).join(', ') || '—' }}</td>
                <td class="right">
                  <button class="row-btn" @click="openAiEditModal(p)">配置密钥与优先级</button>
                </td>
              </tr>
            </tbody>
          </table>

          <!-- 1.1.7：供应商展示配置（前台设置页只读消费） -->
          <h3 class="section-title">供应商展示配置（前台设置页展示）</h3>
          <p class="hint">
            这里配置的是用户在「设置 → AI」看到的<strong>申请链接、说明文案、展示顺序与开通状态</strong>。
            改动保存后，前台设置页下次打开即生效，<strong>无需发版</strong>。
            申请地址留空表示恢复内置默认值。
          </p>

          <p v-if="aiMetaMessage" class="hint mono">{{ aiMetaMessage }}</p>
          <p v-if="aiMetaLoading" class="hint">正在加载展示配置…</p>

          <table v-else class="table">
            <thead>
              <tr>
                <th style="width: 130px;">供应商</th>
                <th style="width: 84px;">前台开通</th>
                <th>申请地址（signupUrl）</th>
                <th>说明文案（note）</th>
                <th style="width: 84px;">排序</th>
                <th class="right" style="width: 130px;">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in aiMetaRows" :key="row.provider">
                <td class="strong">
                  {{ row.name }}
                  <div class="muted mono" style="font-size: 11px;">{{ row.provider }}</div>
                  <div class="muted" style="font-size: 11px;">{{ row.modelCount }} 个模型</div>
                </td>
                <td>
                  <button
                    class="toggle-btn"
                    :class="{ 'is-on': row.enabled }"
                    :title="row.enabled ? '点击关闭该供应商的前台「已开通」标记' : '点击开启该供应商的前台「已开通」标记'"
                    @click="row.enabled = !row.enabled; markAiMetaDirty(row)"
                  >
                    {{ row.enabled ? '已开通' : '未开通' }}
                  </button>
                  <div v-if="!row.apiKeySet" class="muted" style="font-size: 11px; margin-top: 2px;">
                    未配置密钥
                  </div>
                </td>
                <td>
                  <input
                    v-model="row.signupUrl"
                    class="nm-input mono"
                    :placeholder="row.defaults.signupUrl || 'https://…'"
                    aria-label="申请 Key 地址"
                    @input="markAiMetaDirty(row)"
                  />
                  <div class="muted" style="font-size: 11px; margin-top: 2px;">
                    默认：{{ row.defaults.signupUrl || '（无）' }}
                  </div>
                </td>
                <td>
                  <input
                    v-model="row.note"
                    class="nm-input"
                    :placeholder="row.defaults.note || '（使用内置说明）'"
                    aria-label="说明文案"
                    @input="markAiMetaDirty(row)"
                  />
                </td>
                <td>
                  <input
                    v-model.number="row.sortOrder"
                    class="nm-input mono"
                    type="number"
                    min="1"
                    max="9999"
                    aria-label="展示排序"
                    @input="markAiMetaDirty(row)"
                  />
                </td>
                <td class="right">
                  <button class="row-btn" title="恢复该行的内置默认值（仍需点保存）" @click="resetAiMetaRow(row)">
                    恢复默认
                  </button>
                </td>
              </tr>
            </tbody>
          </table>

          <div v-if="!aiMetaLoading" style="margin-top: 12px;">
            <button
              class="nm-btn nm-btn--primary"
              :disabled="aiMetaSaving"
              title="保存全部有改动的展示配置"
              @click="saveAiMeta"
            >
              {{ aiMetaSaving ? '保存中…' : '保存展示配置' }}
            </button>
          </div>

          <!-- 1.1.8：平台付费侧的模型治理（模型列表 / 每模型设置 / 系统提示词） -->
          <h3 class="section-title">平台模型配置（用户扣积分调用）</h3>
          <p class="hint">
            这里配置的是<strong>平台代付</strong>那条线：用户在前台「平台 AI 服务」区块只看到模型名与价格，
            看不到供应商地址与密钥。模型列表决定「开放哪些模型」，每模型设置决定温度上限 / 最大 token / 单价，
            系统提示词会在用户调用时注入（用户可在客户端临时覆盖）。
          </p>

          <p v-if="aiModelsMessage" class="hint mono">{{ aiModelsMessage }}</p>
          <p v-if="aiModelsLoading" class="hint">正在加载模型配置…</p>

          <template v-else>
            <div v-for="p in aiModelProviders" :key="p.provider" class="model-cfg">
              <div class="model-cfg__head">
                <strong>{{ p.name }}</strong>
                <span class="muted mono">({{ p.provider }})</span>
                <span class="tag" :class="p.apiKeySet ? 'tag--ok' : ''">
                  {{ p.apiKeySet ? '密钥已配' : '未配密钥' }}
                </span>
                <span class="tag" :class="{ 'tag--accent': p.enabled }">
                  {{ p.enabled ? '前台可见' : '前台不可见' }}
                </span>
              </div>

              <div class="model-cfg__row">
                <div class="field-box">
                  <label class="nm-label">开放模型（逗号分隔）</label>
                  <input
                    :value="(p.models ?? []).join(', ')"
                    class="nm-input mono"
                    placeholder="deepseek-chat, deepseek-reasoner"
                    aria-label="开放模型列表"
                    @input="updateModelList(p, ($event.target as HTMLInputElement).value)"
                  />
                </div>
                <div class="field-box">
                  <label class="nm-label">默认模型</label>
                  <select v-model="p.defaultModel" class="nm-input" aria-label="默认模型">
                    <option value="">（不设默认）</option>
                    <option v-for="m in p.models" :key="m" :value="m">{{ m }}</option>
                  </select>
                </div>
                <div class="field-box">
                  <label class="nm-label">供应商级系统提示词（模型未配时兜底）</label>
                  <input
                    v-model="p.systemPrompt"
                    class="nm-input"
                    placeholder="你是 Neo MD 的写作助手…"
                    aria-label="供应商级系统提示词"
                  />
                </div>
              </div>

              <!-- 每模型设置 -->
              <table class="table table--tight">
                <thead>
                  <tr>
                    <th>模型</th>
                    <th style="width: 86px;">温度上限</th>
                    <th style="width: 96px;">最大 tokens</th>
                    <th style="width: 92px;">单价(入)</th>
                    <th style="width: 92px;">单价(出)</th>
                    <th>模型级系统提示词</th>
                    <th style="width: 84px;">提示词来源</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="m in p.models" :key="m">
                    <td class="mono">{{ m }}</td>
                    <td>
                      <input
                        v-model.number="modelSettingOf(p, m).temperature"
                        class="nm-input nm-input--num"
                        type="number"
                        step="0.1"
                        min="0"
                        max="2"
                        aria-label="温度上限"
                      />
                    </td>
                    <td>
                      <input
                        v-model.number="modelSettingOf(p, m).maxTokens"
                        class="nm-input nm-input--num"
                        type="number"
                        min="1"
                        max="32768"
                        aria-label="最大 tokens"
                      />
                    </td>
                    <td>
                      <input
                        v-model.number="modelSettingOf(p, m).priceIn"
                        class="nm-input nm-input--num"
                        type="number"
                        min="0"
                        aria-label="输入单价"
                      />
                    </td>
                    <td>
                      <input
                        v-model.number="modelSettingOf(p, m).priceOut"
                        class="nm-input nm-input--num"
                        type="number"
                        min="0"
                        aria-label="输出单价"
                      />
                    </td>
                    <td>
                      <input
                        v-model="modelSettingOf(p, m).systemPrompt"
                        class="nm-input"
                        placeholder="留空则用供应商兜底"
                        aria-label="模型级系统提示词"
                      />
                    </td>
                    <td class="muted">
                      {{ resolvedSource(p, m) === 'model' ? '模型级' : resolvedSource(p, m) === 'provider' ? '供应商' : '未配置' }}
                    </td>
                  </tr>
                  <tr v-if="!p.models.length">
                    <td colspan="7" class="empty">该供应商还没有开放模型</td>
                  </tr>
                </tbody>
              </table>

              <button
                class="nm-btn nm-btn--primary nm-btn--sm"
                :disabled="aiModelsSaving === p.provider"
                title="保存该供应商的模型治理配置"
                @click="saveAiModelProvider(p)"
              >
                {{ aiModelsSaving === p.provider ? '保存中…' : `保存 ${p.name} 配置` }}
              </button>
            </div>
          </template>
        </template>
        <template v-else-if="tab === 'billing'">
          <div v-if="billing" class="billing">
            <h3 class="section-title" style="margin-top: 0;">积分兑换与自动赠送规则</h3>
            <div class="grant-grid">
              <div class="field-box">
                <label class="nm-label">充值兑换比例（1 元人民币兑换积分数）</label>
                <input v-model.number="billing.creditPerYuan" class="nm-input" type="number" min="1" />
              </div>
              <div class="field-box">
                <label class="nm-label">新用户注册默认赠送积分（0 为不赠送）</label>
                <input v-model.number="billing.signupGrantCredits" class="nm-input" type="number" min="0" />
              </div>
              <div class="field-box">
                <label class="nm-label">每日首次登录自动赠送积分（0 为不赠送）</label>
                <input v-model.number="billing.dailyGrantCredits" class="nm-input" type="number" min="0" />
              </div>
            </div>

            <h3 class="section-title">不同模型计费方式与多供应商优先级排序</h3>
            <p class="hint">
              支持为每个模型单独设置计费方式（<strong>按 Tokens 计费</strong> / <strong>按次固定计费</strong> / <strong>免费开放</strong>），并指定支持该模型的供应商优先级队列（用逗号分隔供应商 ID，排在前面的优先调用）。
            </p>
            <table class="table" style="margin-bottom: 12px;">
              <thead>
                <tr>
                  <th>模型标识</th>
                  <th>计费方式</th>
                  <th>输入单价(千tokens)</th>
                  <th>输出单价(千tokens)</th>
                  <th>按次扣费(积分/次)</th>
                  <th>供应商优先级队列（逗号分隔）</th>
                  <th class="right">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, idx) in modelRules" :key="r.model">
                  <td class="mono strong">{{ r.model }}</td>
                  <td>
                    <select v-model="r.mode" class="nm-input" style="min-width: 120px;" @change="syncRulesToPricesText">
                      <option value="tokens">按 Tokens 计费</option>
                      <option value="request">按次固定计费</option>
                      <option value="free">免费开放 (0积分)</option>
                    </select>
                  </td>
                  <td>
                    <input v-model.number="r.in" class="nm-input nm-input--num" type="number" min="0" :disabled="r.mode !== 'tokens'" @input="syncRulesToPricesText" />
                  </td>
                  <td>
                    <input v-model.number="r.out" class="nm-input nm-input--num" type="number" min="0" :disabled="r.mode !== 'tokens'" @input="syncRulesToPricesText" />
                  </td>
                  <td>
                    <input v-model.number="r.perCall" class="nm-input nm-input--num" type="number" min="0" :disabled="r.mode !== 'request'" @input="syncRulesToPricesText" />
                  </td>
                  <td>
                    <input
                      v-model="r.providersStr"
                      class="nm-input"
                      placeholder="如 xiaomi-mimo, deepseek"
                      @input="syncRulesToPricesText"
                    />
                  </td>
                  <td class="right">
                    <button class="row-btn row-btn--danger" @click="removeModelRule(idx)">移除</button>
                  </td>
                </tr>
              </tbody>
            </table>

            <div class="inline-form">
              <input v-model="newModelName" class="nm-input" placeholder="新增模型名（如 deepseek-v3）" @keyup.enter="addModelRule" />
              <button class="nm-btn nm-btn--sm" @click="addModelRule">添加模型计费规则</button>
            </div>

            <label class="nm-label">模型计费配置 JSON（高级编辑，与上方表格实时联动）</label>
            <textarea v-model="pricesText" class="nm-input mono-area" rows="6" />

            <label class="nm-label">充值与支付方式说明（JSON）</label>
            <textarea v-model="methodsText" class="nm-input mono-area" rows="6" />

            <button class="nm-btn nm-btn--primary nm-btn--sm" @click="saveBilling">保存全部计费与赠送配置</button>
          </div>
        </template>

        <!-- 6. 分享与跟随内容的评价管理 -->
        <template v-else-if="tab === 'shares'">
          <p class="hint">点击「查看/管理评价」即可直接在该分享内容下方查看访客评论与划词标注，并进行隐藏或恢复。</p>
          <table class="table">
            <thead>
              <tr><th>分享文档标题</th><th>所属用户</th><th>浏览量</th><th>评价数</th><th>创建时间</th><th>状态</th><th class="right">操作</th></tr>
            </thead>
            <tbody>
              <template v-for="s in shares" :key="String(s.id)">
                <tr>
                  <td class="strong">{{ s.title }}</td>
                  <td class="muted">{{ s.username ?? s.userId }}</td>
                  <td class="muted">{{ s.viewCount }}</td>
                  <td>
                    <span class="tag tag--accent">{{ s.commentCount ?? 0 }} 条评价</span>
                  </td>
                  <td class="muted">{{ fmtTime(s.createdAt) }}</td>
                  <td><span class="tag" :class="{ 'tag--warn': s.revokedAt }">{{ s.revokedAt ? '已撤销' : '有效' }}</span></td>
                  <td class="right">
                    <a v-if="!s.revokedAt" class="row-btn" :href="String(s.url ?? `/s/${s.token}`)" target="_blank" rel="noopener">打开链接</a>
                    <button class="row-btn" @click="toggleShareComments(Number(s.id))">
                      {{ expandedShareId === Number(s.id) ? '收起评价' : `查看/管理评价(${s.commentCount ?? 0})` }}
                    </button>
                    <button v-if="!s.revokedAt" class="row-btn row-btn--danger" @click="revokeShare(Number(s.id))">撤销</button>
                  </td>
                </tr>
                <tr v-if="expandedShareId === Number(s.id)">
                  <td colspan="7" class="share-comments-cell">
                    <div v-if="(shareCommentsMap[Number(s.id)] ?? []).length" class="inline-comments">
                      <div v-for="c in shareCommentsMap[Number(s.id)]" :key="c.id" class="inline-comment">
                        <div class="inline-comment__main">
                          <strong>{{ c.authorName }}</strong>
                          <span class="muted">{{ fmtTime(c.createdAt) }}</span>
                          <span class="tag" :class="{ 'tag--warn': c.status !== 'visible' }">
                            {{ c.status === 'visible' ? '显示中' : '已隐藏' }}
                          </span>
                          <blockquote v-if="c.quote" class="inline-comment__quote">划词：「{{ c.quote }}」</blockquote>
                          <p class="inline-comment__body">{{ c.body }}</p>
                        </div>
                        <button
                          class="row-btn"
                          @click="toggleCommentInShare(Number(s.id), c.id, c.status)"
                        >
                          {{ c.status === 'visible' ? '隐藏该评价' : '恢复显示' }}
                        </button>
                      </div>
                    </div>
                    <p v-else class="muted" style="margin: 0;">该分享内容下暂无访客评价。</p>
                  </td>
                </tr>
              </template>
              <tr v-if="!shares.length"><td colspan="7" class="empty">暂无分享</td></tr>
            </tbody>
          </table>
        </template>

        <!-- 7. 发布 -->
        <template v-else-if="tab === 'publishes'">
          <table class="table">
            <thead><tr><th>标题</th><th>Slug</th><th>创建</th><th>状态</th><th class="right">操作</th></tr></thead>
            <tbody>
              <tr v-for="p in publishes" :key="String(p.id)">
                <td class="strong">{{ p.title }}</td>
                <td class="mono">{{ p.slug }}</td>
                <td class="muted">{{ fmtTime(p.createdAt) }}</td>
                <td><span class="tag" :class="{ 'tag--warn': p.revokedAt }">{{ p.revokedAt ? '已下线' : '在线' }}</span></td>
                <td class="right">
                  <a v-if="!p.revokedAt" class="row-btn" :href="String(p.url ?? `/p/${p.slug}`)" target="_blank" rel="noopener">打开链接</a>
                  <button v-if="!p.revokedAt" class="row-btn row-btn--danger" @click="revokePublish(Number(p.id))">下线</button>
                </td>
              </tr>
              <tr v-if="!publishes.length"><td colspan="5" class="empty">暂无发布</td></tr>
            </tbody>
          </table>
        </template>

        <!-- 8. 插件市场管理 -->
        <template v-else-if="tab === 'plugins'">
          <p class="hint">管理社区开发者在插件开放平台发布的扩展插件，支持审核上下架。</p>
          <table class="table">
            <thead>
              <tr><th>插件名称</th><th>标识 (ID)</th><th>作者</th><th>版本</th><th>安装 / 获赞</th><th>状态</th><th class="right">操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="pl in communityPlugins" :key="pl.id">
                <td class="strong">{{ pl.name }}</td>
                <td class="mono">{{ pl.pluginId }}</td>
                <td class="muted">{{ pl.authorName }}</td>
                <td>v{{ pl.version }}</td>
                <td class="muted">{{ formatCompactNumber(pl.downloads) }} / ★ {{ formatCompactNumber(pl.stars) }}</td>
                <td>
                  <span class="tag" :class="{ 'tag--ok': pl.status === 'published', 'tag--warn': pl.status !== 'published' }">
                    {{ pl.status === 'published' ? '已上架' : '已下架' }}
                  </span>
                </td>
                <td class="right">
                  <button
                    v-if="pl.status !== 'published'"
                    class="row-btn"
                    @click="setPluginStatus(pl.id, 'published')"
                  >
                    上架
                  </button>
                  <button
                    v-else
                    class="row-btn row-btn--danger"
                    @click="setPluginStatus(pl.id, 'disabled')"
                  >
                    下架
                  </button>
                </td>
              </tr>
              <tr v-if="!communityPlugins.length"><td colspan="7" class="empty">暂无社区插件</td></tr>
            </tbody>
          </table>
        </template>

        <!-- 9. 客户端分发 -->
        <template v-else-if="tab === 'releases'">
          <p class="hint">安装包存放在对象存储的 <code>mdadmin/releases/</code>，通过预签名地址对外分发。</p>
          <table class="table">
            <thead><tr><th>文件</th><th>大小</th><th>更新时间</th><th class="right">操作</th></tr></thead>
            <tbody>
              <tr v-for="f in releases" :key="f.key">
                <td class="mono">{{ f.key.replace('mdadmin/releases/', '') }}</td>
                <td class="muted">{{ formatBytes(f.size) }}</td>
                <td class="muted">{{ fmtTime(f.lastModified) }}</td>
                <td class="right"><a class="row-btn" :href="f.url" target="_blank" rel="noopener">下载</a></td>
              </tr>
              <tr v-if="!releases.length"><td colspan="4" class="empty">暂无发布文件</td></tr>
            </tbody>
          </table>
        </template>

        <!-- 10. 审计 -->
        <template v-else>
          <table class="table table--compact">
            <thead><tr><th>时间</th><th>动作</th><th>目标</th><th>用户</th><th>IP</th></tr></thead>
            <tbody>
              <tr v-for="(a, i) in audit" :key="i">
                <td class="muted">{{ fmtTime(a.created_at ?? a.createdAt) }}</td>
                <td class="mono">{{ a.action }}</td>
                <td class="muted">{{ a.target ?? '—' }}</td>
                <td class="muted">{{ a.username ?? a.user_id ?? a.userId ?? '—' }}</td>
                <td class="muted">{{ a.ip ?? '—' }}</td>
              </tr>
              <tr v-if="!audit.length"><td colspan="5" class="empty">暂无日志</td></tr>
            </tbody>
          </table>
        </template>
      </div>
    </main>

    <NmModal v-model="detailOpen" title="用户详情与积分调整" :width="680">
      <div v-if="detail" class="detail">
        <pre class="detail__json">{{ JSON.stringify(detail.user, null, 2) }}</pre>
        <h4>手动增加 / 扣减积分</h4>
        <div class="inline-form">
          <input v-model.number="creditAmount" class="nm-input nm-input--num" type="number" />
          <input v-model="creditReason" class="nm-input" placeholder="调整原因" />
          <button class="nm-btn nm-btn--primary nm-btn--sm" @click="adjustCredits">执行</button>
        </div>
      </div>
      <template #footer>
        <button class="nm-btn" @click="detailOpen = false">关闭</button>
      </template>
    </NmModal>

    <NmModal :model-value="Boolean(aiEdit)" :title="`配置供应商：${aiEdit?.name ?? ''}`" :width="540" @update:model-value="aiEdit = null">
      <div v-if="aiEdit">
        <label class="nm-label">Base URL</label>
        <input v-model="aiEdit.baseUrl" class="nm-input" />
        <label class="nm-label mt">API Key（留空保持原密钥不变）</label>
        <input v-model="aiEdit.apiKey" class="nm-input" type="password" placeholder="sk-…" />
        <label class="nm-label mt">调度优先级（整数，数值越小优先级越高，默认 100）</label>
        <input v-model.number="aiEdit.priority" class="nm-input" type="number" min="1" max="9999" />
        <label class="nm-label mt">该供应商支持的模型列表（逗号分隔）</label>
        <input v-model="aiEdit.modelsStr" class="nm-input" placeholder="deepseek-chat, mimo-v2.6-flash" />
        <label class="nm-label mt">启用平台代付</label>
        <button class="toggle-btn" :class="{ 'is-on': aiEdit.enabled }" @click="aiEdit.enabled = !aiEdit.enabled">
          {{ aiEdit.enabled ? '已启用' : '未启用' }}
        </button>
      </div>
      <template #footer>
        <button class="nm-btn" @click="aiEdit = null">取消</button>
        <button class="nm-btn nm-btn--primary" @click="saveAi">保存</button>
      </template>
    </NmModal>
  </div>
</template>

<style scoped>
/*
 * 后台外壳（1.1.7「更大气」改造）。
 *
 * 视觉取向（1.1.8 改版）：**浅色侧栏 + 浅色内容区**。
 * 用户明确要求「采用浅色主题」，因此侧栏由 1.1.7 的深色 `#131a26` 改为浅灰 `#f7f8fa`，
 * 与主应用的浅色观感统一；层次感改由「底色差 + 1px 描边 + 轻微阴影」承担，
 * 不再依赖深浅对比。字号层次与留白同时放大，以体现「更大气」。
 * 所有文字色都按 WCAG AA 校验（正文对比度 ≥ 4.5:1，见各色值注释）。
 */
.admin { display: flex; height: 100%; min-height: 0; background: var(--bg); }

/* ---------------- 浅色侧栏 ---------------- */
.admin__nav {
  width: 244px;
  flex: 0 0 244px;
  display: flex;
  flex-direction: column;
  padding: 22px 14px 16px;
  /* 浅灰底：与内容区 #fff/var(--bg-elevated) 形成轻微层次，又足够「轻」 */
  background: #f7f8fa;
  border-right: 1px solid #e8eaee;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #d3d7de transparent;
}
.admin__nav::-webkit-scrollbar { width: 6px; }
.admin__nav::-webkit-scrollbar-thumb { background: #d3d7de; border-radius: 3px; }
.admin__brand { display: flex; align-items: center; gap: 11px; padding: 0 8px 20px; }
.admin__brand div { display: flex; flex-direction: column; gap: 2px; }
/* #1f2329 on #f7f8fa ≈ 14.6:1 */
.admin__brand strong { font-size: 14.5px; font-weight: 650; color: #1f2329; letter-spacing: 0.01em; }
/* #6b7280 on #f7f8fa ≈ 4.9:1 */
.admin__brand span:last-child { font-size: 11.5px; color: #6b7280; }
.mark {
  width: 32px;
  height: 32px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #1677ff, #4a9bff);
  color: #fff;
  font-size: 16px;
  font-weight: 700;
  box-shadow: 0 4px 12px rgba(22, 119, 255, 0.28);
}

.admin__nav-list { display: flex; flex-direction: column; gap: 3px; }
.nav-group { display: flex; flex-direction: column; gap: 3px; }
/* 分组标题：小号大写字距，弱对比度，只做视觉分隔不抢焦点
   #8a9099 on #f7f8fa ≈ 3.2:1（属于非正文的装饰性标签，字号 10px 加粗） */
.nav-group__title {
  margin: 18px 0 6px;
  padding: 0 12px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #8a9099;
}
.nav-group:first-child .nav-group__title { margin-top: 0; }

.nav-item {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 12px;
  border-radius: 9px;
  font-size: 13.5px;
  /* #3f4652 on #f7f8fa ≈ 9.4:1 */
  color: #3f4652;
  text-align: left;
  transition: background 0.14s ease, color 0.14s ease;
}
.nav-item:hover { background: #eceef2; color: #1f2329; }
/* 选中态：白底卡片 + 蓝色左侧标记 + 淡阴影，浅色下靠「浮起」而非「变色」突出。
   文字色用加深的 `#0b5ed7`：`#1677ff` 在白底上只有 4.10:1，不满足 AA 的 4.5:1；
   加深后 5.84:1，同时左侧标记仍用品牌蓝 `#1677ff` 保持视觉一致性。 */
.nav-item.is-active {
  background: #ffffff;
  color: #0b5ed7;
  font-weight: 600;
  position: relative;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06), 0 1px 3px rgba(16, 24, 40, 0.08);
}
.nav-item.is-active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 18px;
  border-radius: 0 3px 3px 0;
  background: #1677ff;
}
.admin__nav-foot {
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid #e4e7ec;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

/* ---------------- 浅色内容区 ---------------- */
.admin__main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; background: var(--bg); }
.admin__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 28px;
  height: 56px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elevated);
  flex: 0 0 auto;
}
/* 面包屑：根 → 分组 → 当前页 */
.admin__crumb {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  color: var(--fg-3);
  font-size: 12px;
}
.admin__crumb-root { color: var(--fg-3); }
.admin__crumb-group { color: var(--fg-2); }
.admin__crumb h1 {
  margin: 0;
  font-size: 15.5px;
  font-weight: 650;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.admin__user { display: flex; align-items: center; gap: 9px; font-size: 12.5px; color: var(--fg-2); flex: 0 0 auto; }
.admin__who { font-weight: 550; }
.admin__chip {
  font-size: 10.5px;
  padding: 2px 8px;
  border-radius: 9px;
  background: var(--accent-weak);
  color: var(--accent);
  font-weight: 600;
}

.banner { margin: 18px 36px 0; padding: 11px 15px; border-radius: 10px; font-size: 13px; }
.banner--err { background: rgba(217,48,37,.08); color: #d93025; }
.banner--ok { background: rgba(14,159,110,.1); color: #0e9f6e; }
/* 内容区留白放大（1.1.8「更大气」）：36px 左右边距 + 56px 底部呼吸空间 */
.admin__body { flex: 1; min-height: 0; overflow-y: auto; padding: 32px 36px 56px; }
/* 指标卡栅格：最小宽度 200px，卡片间距 16px，1920 下自然铺成多列 */
.stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; }
.stat-card {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  /* 轻微阴影制造「浮起」层次，替代深色主题靠明暗对比的做法 */
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 1px 3px rgba(16, 24, 40, 0.06);
  transition: box-shadow 0.16s ease, transform 0.16s ease;
}
.stat-card:hover { box-shadow: 0 4px 10px rgba(16, 24, 40, 0.08), 0 2px 4px rgba(16, 24, 40, 0.06); }
.stat-card--wide { grid-column: span 2; }
/* 字号层次：label 12px / value 28px / sub 11.5px，拉开层级差 */
.stat-card .label { font-size: 12px; font-weight: 500; color: var(--fg-2); }
.stat-card .value { font-size: 28px; font-weight: 700; letter-spacing: -0.025em; color: var(--fg); line-height: 1.15; }
.stat-card .sub { font-size: 11.5px; color: var(--fg-3); }
.spark { display: flex; align-items: flex-end; gap: 3px; height: 54px; margin-top: 6px; }
.spark__bar { flex: 1; min-width: 3px; border-radius: 2px 2px 0 0; background: linear-gradient(180deg, var(--accent), rgba(22,119,255,.35)); }
.section-title { margin: 32px 0 14px; font-size: 15px; font-weight: 700; letter-spacing: -0.01em; }
.inline-form { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
.inline-form .nm-input { max-width: 220px; }
.nm-input--num { width: 92px; flex: 0 0 auto; max-width: 92px !important; }
.toolbar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; flex-wrap: wrap; }
.toolbar-row__search { max-width: 260px; }
.toolbar-row__sel { max-width: 150px; }
.toolbar-row__count { margin-left: auto; font-size: 12px; color: var(--fg-3); }
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
}
.table th { text-align: left; padding: 12px 16px; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--fg-2); background: var(--bg-hover); border-bottom: 1px solid var(--border); white-space: nowrap; }
.table td { padding: 12px 16px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.table tbody tr:last-child td { border-bottom: none; }
.table tbody tr:hover { background: var(--bg-hover); }
.table--compact td, .table--compact th { padding: 8px 12px; }
.right { text-align: right; }
.strong { font-weight: 600; }
.muted { color: var(--fg-3); }
.mono { font-family: var(--font-mono); font-size: 11.5px; color: var(--accent); }
.empty { text-align: center; color: var(--fg-3); padding: 26px 12px; }
.tag { font-size: 10.5px; padding: 2px 8px; border-radius: 9px; background: var(--bg-hover); color: var(--fg-2); }
.tag--accent { background: var(--accent-weak); color: var(--accent); }
.tag--ok { background: rgba(14,159,110,.12); color: #0e9f6e; }
.tag--warn { background: var(--orange-weak); color: #b5540f; }
.row-btn { font-size: 11.5px; padding: 3px 8px; border-radius: 5px; color: var(--accent); margin-left: 4px; }
.row-btn:hover { background: var(--accent-weak); }
.row-btn--danger { color: #d93025; }
.pager { display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 14px; font-size: 12px; color: var(--fg-3); }
.codes { background: var(--bg-hover); border-radius: 8px; padding: 12px; font-family: var(--font-mono); font-size: 12px; line-height: 1.8; max-height: 180px; overflow: auto; margin-bottom: 14px; }
.mono-area { font-family: var(--font-mono); font-size: 12px; margin-bottom: 14px; }
.billing { max-width: 960px; }
.grant-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 18px; }
.field-box { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
.share-comments-cell { background: var(--bg-sidebar); padding: 12px 16px !important; }
.inline-comments { display: grid; gap: 8px; }
.inline-comment { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 10px 12px; border-radius: 8px; background: var(--bg-elevated); border: 1px solid var(--border); }
.inline-comment__main { display: flex; flex-direction: column; gap: 4px; }
.inline-comment__quote { margin: 2px 0; padding: 4px 8px; border-left: 3px solid var(--accent); background: var(--accent-weak-2); font-size: 12px; color: var(--fg-2); }
.inline-comment__body { margin: 0; font-size: 12.5px; color: var(--fg); }
.hint { font-size: 12.5px; color: var(--fg-3); margin: 0 0 12px; line-height: 1.7; }
.hint code { font-family: var(--font-mono); background: var(--bg-hover); padding: 1px 5px; border-radius: 4px; }
.mt { margin-top: 14px; }
.toggle-btn { min-width: 70px; height: 28px; padding: 0 12px; border-radius: 14px; font-size: 12px; font-weight: 600; background: var(--bg-hover); color: var(--fg-3); border: 1px solid var(--border); }
.toggle-btn.is-on { background: var(--accent); border-color: var(--accent); color: #fff; }
.detail__json { background: var(--bg-hover); border-radius: 8px; padding: 12px; font-family: var(--font-mono); font-size: 11.5px; line-height: 1.6; max-height: 240px; overflow: auto; }
.detail h4 { margin: 16px 0 8px; font-size: 13px; }
/* ---------------- 响应式 ---------------- */
/* 1280 及以下：收窄侧栏，给内容区更多横向空间 */
@media (max-width: 1280px) {
  .admin__nav { width: 212px; flex-basis: 212px; }
  .admin__header { padding: 0 24px; }
  .admin__body { padding: 24px 24px 44px; }
  .banner { margin: 14px 24px 0; }
}
/* <1000：侧栏改为顶部横向滚动条，分组标题隐藏（横向排列下无意义） */
@media (max-width: 1000px) {
  .admin { flex-direction: column; }
  .admin__nav {
    width: 100%;
    flex: 0 0 auto;
    flex-direction: row;
    align-items: center;
    gap: 6px;
    overflow-x: auto;
    overflow-y: hidden;
    border-right: none;
    border-bottom: 1px solid #e8eaee;
    padding: 8px 10px;
    scrollbar-width: none;
  }
  .admin__nav::-webkit-scrollbar { display: none; }
  .admin__brand { display: none; }
  .admin__nav-list { flex-direction: row; gap: 4px; }
  .nav-group { flex-direction: row; gap: 4px; }
  .nav-group__title { display: none; }
  .nav-item { white-space: nowrap; padding: 7px 11px; font-size: 12.5px; }
  .nav-item.is-active::before { display: none; }
  .admin__nav-foot { margin-top: 0; margin-left: auto; padding-top: 0; border-top: none; padding-left: 8px; border-left: 1px solid #e8eaee; flex-direction: row; gap: 4px; }
  .admin__header { padding: 0 16px; height: 52px; }
  .admin__crumb-group { display: none; }
  .admin__body { padding: 16px 14px 32px; }
  .banner { margin: 12px 14px 0; }
  .stat-card--wide { grid-column: span 1; }
  .grant-grid { grid-template-columns: 1fr; }
  .table { display: block; overflow-x: auto; }
}
/* <760：进一步压缩顶栏，隐藏用户名只留角色徽标 */
@media (max-width: 760px) {
  .admin__who { display: none; }
  .admin__header h1 { font-size: 14.5px; }
}
</style>
