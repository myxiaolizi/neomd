<script setup lang="ts">
/**
 * 后台管理端外壳（1.1.9 重建）。
 *
 * 这个文件**只做三件事**：
 *  1. 侧栏导航（按分组聚合）；
 *  2. 顶部面包屑与管理员身份；
 *  3. 用动态组件装配右侧内容区。
 *
 * 所有业务逻辑都搬进了 `components/admin/*`：每个模块自己取数、自己处理交互，
 * 父组件不再持有 users/codes/aiProviders 之类的业务状态。
 * 这样做的直接收益：14 个页签从 82KB 单文件里拆出来，改一个模块不会碰到另一个；
 * 而且模块之间没有共享的 mutable 状态，也就不存在「切页签后数据串了」这类问题。
 *
 * 拆分原则（刻意遵守）：**只搬 DOM 与取数，不改已工作的行为**。
 * 例如 AdminDashboard.vue 仍然靠 props 接收看板数据（它原本就是这样），
 * 由本文件的 `loadDashboard` 统一驱动，避免为了「统一架构」而引入回归。
 */
import { computed, onMounted, ref, shallowRef } from 'vue';
import { useRouter } from 'vue-router';
import { NmIcon } from '@neomd/ui';
import { adminApiV3, type AdminDashboard as AdminDashboardData } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

// 后台专用样式表：非 scoped，作用域限定在 .admin-shell 内，因此拆出去的子组件也能继承浅色变量
import '@/components/admin/admin-theme.css';

import AdminDashboard from '@/components/admin/AdminDashboard.vue';
import AdminOverview from '@/components/admin/AdminOverview.vue';
import AdminUsers from '@/components/admin/AdminUsers.vue';
import AdminVaults from '@/components/admin/AdminVaults.vue';
import AdminShare from '@/components/admin/AdminShare.vue';
import AdminRelease from '@/components/admin/AdminRelease.vue';
import AdminPlugins from '@/components/admin/AdminPlugins.vue';
import AdminCredits from '@/components/admin/AdminCredits.vue';
import AdminLedger from '@/components/admin/AdminLedger.vue';
import AdminAiProviders from '@/components/admin/AdminAiProviders.vue';
import AdminAiModels from '@/components/admin/AdminAiModels.vue';
import AdminAiUsage from '@/components/admin/AdminAiUsage.vue';
import AdminKnowledgeTokens from '@/components/admin/AdminKnowledgeTokens.vue';
import AdminBilling from '@/components/admin/AdminBilling.vue';
import AdminConfig from '@/components/admin/AdminConfig.vue';
import AdminAudit from '@/components/admin/AdminAudit.vue';

const router = useRouter();
const auth = useAuthStore();

type Tab =
  | 'dashboard'
  | 'overview'
  | 'users'
  | 'vaults'
  | 'shares'
  | 'releases'
  | 'plugins'
  | 'credits'
  | 'ledger'
  | 'aiProviders'
  | 'aiModels'
  | 'aiUsage'
  | 'knowledgeTokens'
  | 'billing'
  | 'config'
  | 'audit';

/**
 * 侧栏导航分组。
 *
 * 分组逻辑按「运营的思考顺序」而不是按数据库表：
 *  总览 → 用户与内容 → 商业化（积分/AI/计费） → 系统
 * 1.1.9 新增「AI 运营分析」「知识库令牌治理」，并把原来挤在一起的
 * 「AI 供应商 + 平台模型配置」拆成两个页签（改密钥与改模型参数的风险等级不同）。
 */
const TABS: Array<{ id: Tab; label: string; icon: string; group: string; hint: string }> = [
  { id: 'dashboard', label: '数据看板', icon: 'layout', group: '总览', hint: '时间窗口内的核心指标与实时状态' },
  { id: 'overview', label: '运营概览', icon: 'zap', group: '总览', hint: '全站累计指标与注册趋势' },
  { id: 'users', label: '用户与配额', icon: 'users', group: '用户与内容', hint: '账号、角色、状态、积分调整' },
  { id: 'vaults', label: '仓库管理', icon: 'hdd', group: '用户与内容', hint: '云端仓库注册表与启停' },
  { id: 'shares', label: '分享与评价', icon: 'share', group: '用户与内容', hint: '分享链接与访客评价审核' },
  { id: 'releases', label: '发布与分发', icon: 'download', group: '用户与内容', hint: '网页发布与客户端安装包' },
  { id: 'plugins', label: '插件市场', icon: 'layers', group: '用户与内容', hint: '社区插件审核上下架' },
  { id: 'credits', label: '积分与兑换码', icon: 'coins', group: '商业化', hint: '批量生成兑换码' },
  { id: 'ledger', label: '积分流水', icon: 'bill', group: '商业化', hint: '全部余额变更账本' },
  { id: 'billing', label: '计费与赠送', icon: 'wallet', group: '商业化', hint: '兑换比例、赠送、模型计费方式' },
  { id: 'aiProviders', label: 'AI 供应商', icon: 'sparkles', group: '商业化', hint: '连接凭证、调度优先级、客户端展示' },
  { id: 'aiModels', label: '平台模型配置', icon: 'key', group: '商业化', hint: '模型列表、参数上限、单价、系统提示词' },
  { id: 'aiUsage', label: 'AI 运营分析', icon: 'chart', group: '商业化', hint: '调用量、失败率、p95 延迟、成本' },
  { id: 'knowledgeTokens', label: '知识库令牌', icon: 'shield', group: '商业化', hint: '全局令牌治理与风险审计' },
  { id: 'config', label: '配置中心', icon: 'settings', group: '系统', hint: 'platform_config 键值参数' },
  { id: 'audit', label: '审计日志', icon: 'shield', group: '系统', hint: '管理写操作留痕' },
];

/** 按 group 聚合出侧栏分组，保持 TABS 定义顺序 */
const TAB_GROUPS = computed(() => {
  const out: Array<{ group: string; items: typeof TABS }> = [];
  for (const t of TABS) {
    const last = out[out.length - 1];
    if (last && last.group === t.group) last.items.push(t);
    else out.push({ group: t.group, items: [t] });
  }
  return out;
});

const tab = ref<Tab>('dashboard');

/**
 * 页签 ↔ URL query 同步（1.4.0）。
 *
 * ## 为什么必须做
 *
 * 1.4.0 给插件市场加了「每页 20 条 + 页码进 URL」，但如果页签本身不进 URL，
 * 刷新后会被 `tab = 'dashboard'` 重置回数据看板 —— 用户看到的是「我明明在第 2 页，
 * 刷新后却跳走了」，`?pluginPage=2` 也就成了死参数。
 *
 * 因此把当前页签写进 `?tab=<id>`，刷新/收藏/转发都能回到同一个模块；
 * 各模块自己的 query（如 `pluginPage`）因此才有意义。
 *
 * 只在非默认页签时写，保持默认入口的 URL 干净（`/admin`）。
 */
function syncTabToUrl(id: Tab): void {
  try {
    const url = new URL(window.location.href);
    if (id !== 'dashboard') url.searchParams.set('tab', id);
    else url.searchParams.delete('tab');
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    /* 非浏览器环境忽略 */
  }
}

/** 从 URL query 读取初始页签（非法值回落到 dashboard） */
function readTabFromUrl(): Tab {
  try {
    const raw = new URL(window.location.href).searchParams.get('tab');
    if (raw && TABS.some((t) => t.id === raw)) return raw as Tab;
    return 'dashboard';
  } catch {
    return 'dashboard';
  }
}

/**
 * 页签 → 组件映射。
 *
 * 只在这里维护一份映射，模板用一个 `<component :is>` 渲染，
 * 避免 16 个 v-else-if 分支继续膨胀（这正是原 82KB 单文件难读的主要原因）。
 */
const COMPONENTS: Record<Tab, unknown> = {
  dashboard: AdminDashboard,
  overview: AdminOverview,
  users: AdminUsers,
  vaults: AdminVaults,
  shares: AdminShare,
  releases: AdminRelease,
  plugins: AdminPlugins,
  credits: AdminCredits,
  ledger: AdminLedger,
  aiProviders: AdminAiProviders,
  aiModels: AdminAiModels,
  aiUsage: AdminAiUsage,
  knowledgeTokens: AdminKnowledgeTokens,
  billing: AdminBilling,
  config: AdminConfig,
  audit: AdminAudit,
};

/** 组件定义本身不需要深层响应式，用 shallowRef 避免 Vue 去遍历组件对象 */
const currentComponent = shallowRef<unknown>(AdminDashboard);

const currentTabMeta = computed(() => TABS.find((t) => t.id === tab.value));

/* ---------------- 全局提示 ---------------- */

const errorText = ref('');
const notice = ref('');

function showNotice(msg: string): void {
  notice.value = msg;
  errorText.value = '';
}
function showFail(msg: string): void {
  errorText.value = msg;
  notice.value = '';
}

/* ---------------- 数据看板（唯一由外壳驱动的模块） ---------------- */

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

/* ---------------- 页签切换 ---------------- */

function switchTab(id: Tab): void {
  if (tab.value === id) return;
  tab.value = id;
  syncTabToUrl(id);
  // 清掉上一页残留的提示，避免「保存成功的绿条」跑到另一个模块上
  notice.value = '';
  errorText.value = '';
  currentComponent.value = COMPONENTS[id];
  // 看板数据由外壳持有（AdminDashboard 是纯展示组件），切回来时重新拉一次保证新鲜
  if (id === 'dashboard') void loadDashboard();
}

/** 子组件的统一事件绑定：16 个模块共用同一套 notify/fail 语义 */
const moduleEvents = {
  notify: showNotice,
  fail: showFail,
};

onMounted(async () => {
  await auth.restore();
  if (!auth.isAdmin) {
    void router.push('/login?redirect=/admin');
    return;
  }
  // 从 URL 恢复页签（刷新/转发不丢），并同步组件映射
  const initial = readTabFromUrl();
  if (initial !== 'dashboard') {
    tab.value = initial;
    currentComponent.value = COMPONENTS[initial];
  }
  await loadDashboard();
});
</script>

<template>
  <div class="admin-shell">
    <aside class="adm-nav">
      <div class="adm-brand">
        <span class="mark">N</span>
        <div>
          <strong>Neo MD</strong>
          <span>运营管理后台</span>
        </div>
      </div>

      <nav class="adm-nav-list" data-testid="admin-nav">
        <div v-for="g in TAB_GROUPS" :key="g.group" class="nav-group">
          <p class="nav-group__title">{{ g.group }}</p>
          <button
            v-for="t in g.items"
            :key="t.id"
            class="nav-item"
            :class="{ 'is-active': tab === t.id }"
            :title="t.hint"
            :data-tab="t.id"
            data-testid="admin-nav-item"
            @click="switchTab(t.id)"
          >
            <NmIcon :name="t.icon" :size="16" />
            <span>{{ t.label }}</span>
          </button>
        </div>
      </nav>

      <div class="adm-nav-foot">
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

    <main class="adm-main">
      <header class="adm-header">
        <div class="adm-crumb">
          <span class="adm-crumb__root">管理后台</span>
          <NmIcon name="chevronRight" :size="13" />
          <span class="adm-crumb__group">{{ currentTabMeta?.group }}</span>
          <NmIcon name="chevronRight" :size="13" />
          <h1>{{ currentTabMeta?.label }}</h1>
        </div>
        <div class="adm-user">
          <span class="adm-user__who">{{ auth.user?.username }}</span>
          <span class="adm-user__chip">管理员</span>
        </div>
      </header>

      <p v-if="errorText" class="adm-banner adm-banner--err">{{ errorText }}</p>
      <p v-if="notice" class="adm-banner adm-banner--ok">{{ notice }}</p>

      <div class="adm-body">
        <!--
          数据看板特殊处理：它是唯一靠 props 接收数据的模块（保持原有行为不变），
          其余模块自取数据，只需要透传 notify/fail。
        -->
        <AdminDashboard
          v-if="tab === 'dashboard'"
          :data="dashboard"
          :loading="dashboardLoading"
          @range-change="onDashboardRange"
          @refresh="loadDashboard"
        />
        <component :is="currentComponent" v-else v-on="moduleEvents" />
      </div>
    </main>
  </div>
</template>

<style scoped>
/*
 * 外壳布局（浅色主题）。
 * 设计令牌与通用组件样式放在 components/admin/admin-theme.css（非 scoped，挂在 .admin-shell 下），
 * 这样拆出去的子组件也能继承同一套浅色变量；这里只写「外壳骨架」自己的布局。
 */
.admin-shell {
  display: flex;
  height: 100%;
  min-height: 0;
  background: var(--adm-bg);
  color: var(--adm-fg);
}

/* ---------------- 浅色侧栏 ---------------- */
.adm-nav {
  width: 252px;
  flex: 0 0 252px;
  display: flex;
  flex-direction: column;
  padding: 22px 14px 16px;
  background: var(--adm-sidebar);
  border-right: 1px solid #e8eaee;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #d3d7de transparent;
}
.adm-nav::-webkit-scrollbar { width: 6px; }
.adm-nav::-webkit-scrollbar-thumb { background: #d3d7de; border-radius: 3px; }

.adm-brand { display: flex; align-items: center; gap: 11px; padding: 0 8px 20px; }
.adm-brand div { display: flex; flex-direction: column; gap: 2px; }
.adm-brand strong { font-size: 14.5px; font-weight: 650; color: #1f2329; letter-spacing: 0.01em; }
.adm-brand span:last-child { font-size: 11.5px; color: #6b7280; }
.mark {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #1677ff, #4a9bff);
  color: #fff;
  font-size: 17px;
  font-weight: 700;
  box-shadow: 0 4px 12px rgba(22, 119, 255, 0.28);
}

.adm-nav-list { display: flex; flex-direction: column; gap: 3px; }
.nav-group { display: flex; flex-direction: column; gap: 3px; }
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
  color: #3f4652;
  text-align: left;
  transition: background 0.14s ease, color 0.14s ease;
}
.nav-item:hover { background: #eceef2; color: #1f2329; }
/* 选中态：白底卡片 + 蓝色左侧标记 + 淡阴影（浅色下靠「浮起」而非「变色」）
   文字用加深的 #0b5ed7：品牌蓝 #1677ff 在白底只有 4.10:1，不满足 AA 的 4.5:1 */
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
.adm-nav-foot {
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid #e4e7ec;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

/* ---------------- 内容区 ---------------- */
.adm-main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.adm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 32px;
  height: 58px;
  border-bottom: 1px solid var(--adm-border);
  background: var(--adm-card);
  flex: 0 0 auto;
}
.adm-crumb { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: 12px; color: var(--adm-fg-3); }
.adm-crumb__root { color: var(--adm-fg-3); }
.adm-crumb__group { color: var(--adm-fg-2); }
.adm-crumb h1 {
  margin: 0;
  font-size: 15.5px;
  font-weight: 650;
  color: var(--adm-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.adm-user { display: flex; align-items: center; gap: 9px; font-size: 12.5px; color: var(--adm-fg-2); flex: 0 0 auto; }
.adm-user__who { font-weight: 550; }
.adm-user__chip {
  font-size: 10.5px;
  padding: 2px 8px;
  border-radius: 9px;
  background: var(--adm-accent-weak);
  color: var(--adm-accent-deep);
  font-weight: 600;
}

.adm-banner { margin: 18px 32px 0; padding: 11px 15px; border-radius: 10px; font-size: 13px; }
.adm-banner--err { background: rgba(217, 48, 37, 0.08); color: #d93025; }
.adm-banner--ok { background: rgba(14, 159, 110, 0.1); color: #0e9f6e; }

/* 内容区留白放大（「更大气」）：32px 左右边距 + 56px 底部呼吸空间。
   显式声明背景而不是依赖透传：.admin-shell 的浅色底在窄屏/flex 布局下可能被子元素盖住，
   而「浅色主题」是硬要求，这里必须自己能给出确定值。 */
.adm-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 30px 32px 56px;
  background: var(--adm-bg);
}

/* ---------------- 响应式 ---------------- */
@media (max-width: 1280px) {
  .adm-nav { width: 220px; flex-basis: 220px; }
  .adm-header { padding: 0 24px; }
  .adm-body { padding: 24px 24px 44px; }
  .adm-banner { margin: 14px 24px 0; }
}
/* <1000：侧栏改为顶部横向滚动条，分组标题隐藏 */
@media (max-width: 1000px) {
  .admin-shell { flex-direction: column; }
  .adm-nav {
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
  .adm-nav::-webkit-scrollbar { display: none; }
  .adm-brand { display: none; }
  .adm-nav-list { flex-direction: row; gap: 4px; }
  .nav-group { flex-direction: row; gap: 4px; }
  .nav-group__title { display: none; }
  .nav-item { white-space: nowrap; padding: 7px 11px; font-size: 12.5px; }
  .nav-item.is-active::before { display: none; }
  .adm-nav-foot {
    margin-top: 0;
    margin-left: auto;
    padding-top: 0;
    border-top: none;
    padding-left: 8px;
    border-left: 1px solid #e8eaee;
    flex-direction: row;
    gap: 4px;
  }
  .adm-header { padding: 0 16px; height: 52px; }
  .adm-crumb__group { display: none; }
  .adm-body { padding: 16px 14px 32px; }
  .adm-banner { margin: 12px 14px 0; }
}
@media (max-width: 760px) {
  .adm-user__who { display: none; }
  .adm-crumb h1 { font-size: 14.5px; }
}
</style>
