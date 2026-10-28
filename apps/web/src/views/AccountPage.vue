<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NmIcon } from '@neomd/ui';
import {
  AI_PRESETS,
  STORAGE_PRESETS,
  getStoragePreset,
  getAIPreset,
  formatCompactNumber,
  formatBytes,
  type ShareStyleSettings,
} from '@neomd/shared';
import { AIClient, defaultSettings } from '@neomd/core';
import { useAuthStore } from '@/stores/auth';
import { useAppStore } from '@/stores/app';
import { useSettingsStore } from '@/stores/settings';
import PluginCenter from '@/components/panels/PluginCenter.vue';
import {
  profileApi,
  creditsApi,
  shareApi,
  publishApi,
  uploadApi,
  aiApi,
  type ShareItemDto,
  type PublishItemDto,
  type ModelPriceRule,
  type OssProbeStepDto,
} from '@/api/client';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const app = useAppStore();
const settingsStore = useSettingsStore();

/** 兜底默认值：历史设置缺少子对象时避免访问嵌套属性抛错导致白屏 */
const FALLBACK = defaultSettings();

/** 插件中心独立模态（原「插件」页签已整体迁出到 PluginCenter.vue） */
const pluginCenterOpen = ref(false);

type Tab = 'profile' | 'credits' | 'storage' | 'ai' | 'shares' | 'backups';
const tab = ref<Tab>(((route.query.tab as string) === 'settings' ? 'storage' : (route.query.tab as Tab)) || 'profile');
const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'profile', label: '个人资料与安全', icon: 'user' },
  { id: 'credits', label: '平台积分', icon: 'zap' },
  { id: 'storage', label: '对象存储与同步', icon: 'cloud' },
  { id: 'ai', label: 'AI 服务配置', icon: 'sparkles' },
  { id: 'shares', label: '分享、发布与样式', icon: 'share' },
  { id: 'backups', label: '备份记录', icon: 'hdd' },
];

const loading = ref(true);
const message = ref('');
const errorText = ref('');
const profile = ref<{ nickname: string; avatarUrl: string; email: string; username: string; role: string; credits: number } | null>(null);
const oldPassword = ref('');
const newPassword = ref('');
const stats = ref<Record<string, number>>({});
const ledger = ref<Array<Record<string, unknown>>>([]);
const balance = ref(0);
const redeemCode = ref('');
const backups = ref<Array<{ id: number; vaultId: string; name: string; docCount: number; bytes: number; url: string; createdAt: string }>>([]);
const shares = ref<ShareItemDto[]>([]);
const publishes = ref<PublishItemDto[]>([]);
const expandedShareId = ref<number | null>(null);
const shareCommentsMap = ref<Record<number, Array<{ id: number; authorName: string; body: string; quote?: string; status: string; createdAt: string }>>>({});
const pricing = ref<{
  creditPerYuan: number;
  signupGrantCredits?: number;
  dailyGrantCredits?: number;
  modelPrices: Record<string, ModelPriceRule>;
  paymentMethods: Array<{ id: string; name: string; note: string; enabled: boolean }>;
} | null>(null);

/* -------- 对象存储与 AI -------- */
const storage = computed(() => settingsStore.settings.storage ?? FALLBACK.storage);
const ai = computed(() => settingsStore.settings.ai ?? FALLBACK.ai);
const sync = computed(() => settingsStore.settings.sync ?? FALLBACK.sync);
const shareStyle = computed<ShareStyleSettings>(() =>
  settingsStore.settings.shareStyle ?? {
    brandTitle: '',
    brandSubtitle: '',
    accentColor: '#1677FF',
    paperStyle: 'white',
    hideProductBrand: true,
  },
);
const storageRegions = computed(() => getStoragePreset(storage.value.provider).regions);
const aiPreset = computed(() => getAIPreset(ai.value.provider));

const probing = ref(false);
const probeResult = ref('');
const probeOk = ref(false);
const probeSteps = ref<OssProbeStepDto[]>([]);
const aiTesting = ref(false);
const aiTestResult = ref('');
const aiTestOk = ref(false);
const loadingModels = ref(false);
const modelList = ref<string[]>([]);
const modelSource = ref('');

/* -------- 插件中心入口（原「插件」页签已迁出） -------- */
function openPluginCenter(): void {
  pluginCenterOpen.value = true;
}

async function loadAll(): Promise<void> {
  loading.value = true;
  errorText.value = '';
  try {
    if (!auth.isLoggedIn) {
      await auth.restore();
    }
    if (!auth.isLoggedIn) {
      void router.push('/login?redirect=/account');
      return;
    }
    await settingsStore.pullCloudSettings();
    const p = await profileApi.get();
    profile.value = {
      nickname: p.user.nickname ?? '',
      avatarUrl: p.user.avatarUrl ?? '',
      email: p.user.email,
      username: p.user.username,
      role: p.user.role,
      credits: p.user.credits ?? 0,
    };
    stats.value = p.stats;
    const c = await creditsApi.balance();
    balance.value = c.balance;
    ledger.value = c.ledger;
    pricing.value = await creditsApi.pricing().catch(() => null);
    backups.value = (await profileApi.backups()).items;
    shares.value = await shareApi.list();
    publishes.value = await publishApi.list();
  } catch (e) {
    errorText.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

function flash(msg: string, isErr = false): void {
  if (isErr) {
    errorText.value = msg;
    message.value = '';
  } else {
    message.value = msg;
    errorText.value = '';
  }
  setTimeout(() => {
    if (message.value === msg) message.value = '';
  }, 3600);
}

async function saveProfile(): Promise<void> {
  if (!profile.value) return;
  try {
    await profileApi.update({ nickname: profile.value.nickname, avatarUrl: profile.value.avatarUrl });
    if (auth.user) auth.user = { ...auth.user, nickname: profile.value.nickname, avatarUrl: profile.value.avatarUrl };
    flash('个人资料已保存');
  } catch (e) {
    flash((e as Error).message, true);
  }
}

async function uploadAvatar(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    flash('头像图片不能超过 2MB', true);
    return;
  }
  const form = new FormData();
  form.append('file', file);
  try {
    const res = await profileApi.uploadAvatar(form);
    if (profile.value) profile.value.avatarUrl = res.url;
    if (auth.user) auth.user = { ...auth.user, avatarUrl: res.url };
    flash('头像上传成功');
  } catch (err) {
    flash((err as Error).message, true);
  } finally {
    input.value = '';
  }
}

async function changePassword(): Promise<void> {
  if (newPassword.value.length < 4) {
    flash('新密码至少 4 位字符', true);
    return;
  }
  try {
    await profileApi.changePassword({ oldPassword: oldPassword.value, newPassword: newPassword.value });
    oldPassword.value = '';
    newPassword.value = '';
    flash('密码已修改（管理员后台密码同步更新）');
  } catch (e) {
    flash((e as Error).message, true);
  }
}

async function redeem(): Promise<void> {
  if (!redeemCode.value.trim()) return;
  try {
    const res = await creditsApi.redeem(redeemCode.value.trim());
    balance.value = res.balance;
    redeemCode.value = '';
    flash(`兑换成功，增加 ${res.added} 积分`);
    app.credits = res.balance;
    const c = await creditsApi.balance();
    ledger.value = c.ledger;
  } catch (e) {
    flash((e as Error).message, true);
  }
}

/* -------- 对象存储与 AI 方法 -------- */
function onStorageProviderChange(id: string): void {
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
}

function onRegionChange(region: string): void {
  const preset = getStoragePreset(storage.value.provider);
  settingsStore.update({ storage: { ...storage.value, region, endpoint: preset.endpointFor(region) } });
}

/** endpoint 允许省略协议（自动补 https://），非法地址返回 null */
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

/** 提交前的本地校验：缺项直接提示，不发请求 */
const storageConfigIssues = computed<string[]>(() => {
  const list: string[] = [];
  const raw = storage.value.endpoint?.trim() ?? '';
  if (!raw) list.push('请填写 Endpoint 地址');
  else if (!normalizeEndpoint(raw)) list.push('Endpoint 需为合法地址（可省略协议，将自动补 https://）');
  const bucket = storage.value.bucket?.trim() ?? '';
  if (!bucket) list.push('请填写 Bucket 名称');
  else if (bucket.includes('/')) list.push('Bucket 名称不能包含「/」');
  if (!storage.value.accessKeyId?.trim()) list.push('请填写 AccessKey ID');
  if (!storage.value.accessKeySecret?.trim()) list.push('请填写 AccessKey Secret');
  return list;
});

const aiConfigIssues = computed<string[]>(() => {
  if (ai.value.provider === 'platform' || ai.value.usePlatform) return [];
  const list: string[] = [];
  if (!ai.value.baseUrl?.trim()) list.push('请填写 Base URL');
  else if (!normalizeEndpoint(ai.value.baseUrl)) list.push('Base URL 需为合法地址（可省略协议，将自动补 https://）');
  if (!ai.value.apiKey?.trim()) list.push('请填写 API Key');
  return list;
});

/** 把后端步骤名映射为中文（列举 / 写入 / 读取 / 删除） */
const STEP_LABELS: Record<OssProbeStepDto['name'], string> = {
  list: '列举',
  put: '写入',
  get: '读取',
  delete: '删除',
};

interface ProbeStepRow {
  name: OssProbeStepDto['name'];
  ok: boolean;
  latencyMs: number;
  message: string;
  missing: boolean;
}

/** 固定顺序展示 4 个步骤，缺失步骤补占位行 */
const orderedSteps = computed<ProbeStepRow[]>(() => {
  const ORDER: OssProbeStepDto['name'][] = ['list', 'put', 'get', 'delete'];
  if (!probeSteps.value.length) return [];
  return ORDER.map((name) => {
    const hit = probeSteps.value.find((s) => s.name === name);
    if (!hit) return { name, ok: false, latencyMs: 0, message: '未执行', missing: true };
    return { name, ok: Boolean(hit.ok), latencyMs: Number(hit.latencyMs ?? 0), message: hit.message ?? '', missing: false };
  });
});

/**
 * 任务 1：对象存储检测改走服务端 `/api/oss/probe`。
 * 浏览器直连 OSS 不返回 CORS 头，必然 Failed to fetch，必须服务端代探。
 */
async function testStorage(): Promise<void> {
  probeResult.value = '';
  probeOk.value = false;
  probeSteps.value = [];

  if (!auth.isLoggedIn) {
    probeResult.value = '请先登录后再测试对象存储连接（检测需要服务端代探以绕过浏览器跨域限制）';
    return;
  }
  if (storageConfigIssues.value.length) {
    probeResult.value = '请先填写完整配置';
    return;
  }

  probing.value = true;
  try {
    const cfg = { ...storage.value };
    const normalized = normalizeEndpoint(cfg.endpoint);
    if (normalized) cfg.endpoint = normalized;
    const res = await uploadApi.probe({ storage: cfg, prefix: `${cfg.basePrefix || ''}probe/` });
    probeOk.value = res.ok;
    probeSteps.value = res.steps ?? [];
    probeResult.value = res.ok ? `连接正常（总耗时 ${res.latencyMs} ms）` : `检测失败：${res.message}`;
  } catch (e) {
    probeOk.value = false;
    probeResult.value = `检测失败：${(e as Error).message}`;
  } finally {
    probing.value = false;
  }
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
  if (isPlatform) void fetchModels();
}

/** 应用模型列表：保留已勾选，未勾选时只默认勾选当前默认模型 */
function applyModelList(models: string[], message: string): void {
  modelList.value = models;
  modelSource.value = message;
  const kept = ai.value.models.filter((m) => models.includes(m));
  const defaultM = models.includes(ai.value.model) ? ai.value.model : (models[0] ?? ai.value.model);
  settingsStore.update({ ai: { ...ai.value, models: kept.length ? kept : defaultM ? [defaultM] : [], model: defaultM } });
}

async function fetchModels(): Promise<void> {
  loadingModels.value = true;
  modelSource.value = '';
  try {
    if (ai.value.provider === 'platform' || ai.value.usePlatform) {
      const res = await aiApi.models('platform');
      if (res && res.models.length) {
        const ids = res.models.map((m) => m.id);
        applyModelList(ids, res.message || `平台已开放 ${ids.length} 个模型，请点击选择要启用的模型`);
        return;
      }
      modelList.value = [...aiPreset.value.models];
      modelSource.value = '平台暂未返回模型列表，已使用内置列表';
      return;
    }

    // 自带 Key：优先由服务端代拉，避免浏览器直连第三方被跨域拦截
    const test = await aiApi.test({
      provider: ai.value.provider,
      baseUrl: ai.value.baseUrl,
      apiKey: ai.value.apiKey,
      model: ai.value.model,
    });
    if (test.ok && test.models?.length) {
      applyModelList(test.models, `服务端已代拉 ${test.models.length} 个模型，请点击勾选要使用的模型（${test.latencyMs} ms）`);
      return;
    }

    try {
      const client = new AIClient(ai.value);
      const res = await client.listModels();
      applyModelList(
        res.models,
        res.source === 'upstream'
          ? `已从接口获取 ${res.models.length} 个模型，请点击勾选要使用的模型`
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

function toggleModel(m: string): void {
  const cur = ai.value.models.length ? ai.value.models : [ai.value.model];
  const next = cur.includes(m) ? (cur.length > 1 ? cur.filter((x) => x !== m) : cur) : [...cur, m];
  const defaultM = next.includes(ai.value.model) ? ai.value.model : next[0]!;
  settingsStore.update({ ai: { ...ai.value, models: next, model: defaultM } });
}

/**
 * 任务 2：AI 测试改走服务端 `/api/ai/test`。
 * 平台模式与自带 Key 均不直连第三方；失败为 HTTP 200 + data.ok=false，需看 ok 而非 catch。
 */
async function testAI(): Promise<void> {
  aiTestResult.value = '';
  aiTestOk.value = false;

  if (!auth.isLoggedIn) {
    aiTestResult.value = '请先登录后测试 AI 服务';
    return;
  }

  const isPlatform = ai.value.provider === 'platform' || ai.value.usePlatform;
  if (!isPlatform && aiConfigIssues.value.length) {
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
      aiTestResult.value = res.message;
    }
  } catch (e) {
    aiTestOk.value = false;
    aiTestResult.value = (e as Error).message;
  } finally {
    aiTesting.value = false;
  }
}

function updateShareStyle(patch: Partial<ShareStyleSettings>): void {
  settingsStore.update({ shareStyle: { ...shareStyle.value, ...patch } });
  flash('分享页面样式已保存并自动同步');
}

/* -------- 分享与评论 -------- */
async function toggleShareComments(s: ShareItemDto): Promise<void> {
  if (expandedShareId.value === s.id) {
    expandedShareId.value = null;
    return;
  }
  expandedShareId.value = s.id;
  if (!shareCommentsMap.value[s.id]) {
    try {
      const res = await shareApi.comments(s.id);
      shareCommentsMap.value = { ...shareCommentsMap.value, [s.id]: res.items };
    } catch {
      shareCommentsMap.value = { ...shareCommentsMap.value, [s.id]: [] };
    }
  }
}

async function revokeShare(id: number): Promise<void> {
  try {
    await shareApi.revoke(id);
    shares.value = await shareApi.list();
    flash('已撤销分享');
  } catch (e) {
    flash((e as Error).message, true);
  }
}

async function revokePublish(id: number): Promise<void> {
  try {
    await publishApi.revoke(id);
    publishes.value = await publishApi.list();
    flash('已下线发布');
  } catch (e) {
    flash((e as Error).message, true);
  }
}

async function removeBackup(id: number): Promise<void> {
  if (!window.confirm('删除这条备份记录？云端对象也会被删除。')) return;
  try {
    await profileApi.deleteBackup(id);
    backups.value = backups.value.filter((b) => b.id !== id);
    flash('已删除备份');
  } catch (e) {
    flash((e as Error).message, true);
  }
}

const shareUrl = (token: string): string => `https://md.zhengl.vip/s/${token}`;
const publishUrl = (slug: string): string => `https://md.zhengl.vip/p/${slug}`;

const monthlyCost = computed(() => {
  const map = pricing.value?.modelPrices ?? {};
  return Object.entries(map);
});

watch(
  () => route.query.tab,
  (q) => {
    if (typeof q === 'string' && q) {
      tab.value = (q === 'settings' ? 'storage' : q) as Tab;
    }
  },
);

onMounted(loadAll);
</script>

<template>
  <div class="account">
    <header class="account__nav">
      <div class="account__nav-left">
        <button class="brand" @click="router.push('/')">
          <span class="mark">N</span>
          <span>Neo MD · 个人中心</span>
        </button>
      </div>
      <div class="account__nav-right">
        <button class="nm-btn nm-btn--ghost nm-btn--sm" @click="router.push('/')">返回首页</button>
        <button class="nm-btn nm-btn--primary nm-btn--sm" @click="router.push('/app')">
          进入编辑器工作台
          <NmIcon name="chevronRight" :size="14" />
        </button>
      </div>
    </header>

    <main class="account__main">
      <nav class="account__tabs">
        <button
          v-for="t in TABS"
          :key="t.id"
          type="button"
          class="account__tab"
          :class="{ 'is-active': tab === t.id }"
          :title="t.label"
          @click="tab = t.id"
        >
          <NmIcon :name="t.icon" :size="15" />
          <span>{{ t.label }}</span>
        </button>
        <!-- 插件中心已从页签迁出为独立模态 -->
        <button
          type="button"
          class="account__tab account__tab--plugin"
          title="打开插件中心（插件市场 / 我的插件 / 发布插件 / 开发指南 / 内置插件）"
          aria-label="打开插件中心"
          @click="openPluginCenter"
        >
          <NmIcon name="layers" :size="15" />
          <span>插件中心</span>
          <NmIcon name="external" :size="12" />
        </button>
      </nav>

      <p v-if="errorText" class="err">{{ errorText }}</p>
      <p v-if="message" class="ok">{{ message }}</p>

      <div v-if="loading" class="panel">加载中…</div>

      <template v-else>
        <!-- 1. 个人资料与安全（支持上传头像，不显示头像链接输入框） -->
        <section v-if="tab === 'profile'" class="panel">
          <h2>个人资料</h2>
          <div class="avatar-row">
            <div class="avatar">
              <img v-if="profile?.avatarUrl" :src="profile.avatarUrl" alt="avatar" />
              <span v-else>{{ (profile?.nickname || profile?.username || '?').slice(0, 1).toUpperCase() }}</span>
            </div>
            <div class="avatar-actions">
              <label class="nm-btn nm-btn--primary nm-btn--sm" style="cursor: pointer;">
                <NmIcon name="upload" :size="13" />
                上传头像
                <input type="file" accept="image/*" hidden @change="uploadAvatar" />
              </label>
              <p class="nm-hint">支持 PNG / JPG / WebP / GIF 格式图片，大小不超过 2MB，上传后全端自动同步。</p>
            </div>
          </div>

          <div class="grid2">
            <div class="field">
              <label class="nm-label">显示昵称</label>
              <!--
                `v-model="profile!.nickname"` 是运行时报错的来源（1.1.9 修复）。
                `profile` 初值为 null（要等 `GET /api/profile` 回来才填充），而 `profile!`
                只是**编译期**非空断言，Vue 运行时依然会对 null 取 `.nickname`，
                于是首帧渲染直接抛 `Cannot read properties of null (reading 'nickname')`。
                表现就是「个人中心」页白屏（后台模块巡检里 len=0 的那个）。

                修法：给整个表单加 `v-if="profile"`，数据未就绪时渲染占位，
                既不报错也不会让用户看到空表单。
              -->
              <input
                v-if="profile"
                v-model="profile.nickname"
                class="nm-input"
                maxlength="64"
                placeholder="输入您的显示昵称"
              />
              <input v-else class="nm-input" value="" placeholder="加载中…" disabled />
            </div>
            <div class="field">
              <label class="nm-label">用户名（个人云仓库标识）</label>
              <input class="nm-input" :value="profile?.username" readonly />
            </div>
          </div>
          <div class="field">
            <label class="nm-label">注册邮箱</label>
            <input class="nm-input" :value="profile?.email" readonly />
          </div>
          <button class="nm-btn nm-btn--primary" @click="saveProfile">保存个人资料</button>

          <div class="nm-divider" />
          <h3>修改登录密码</h3>
          <p class="nm-hint">修改密码后其他已登录设备需重新验证；若您是管理员，管理后台密码跟随此账号密码。</p>
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
          <button class="nm-btn" @click="changePassword">更新密码</button>

          <div class="nm-divider" />
          <h3>账户资产概览</h3>
          <div class="stats">
            <div class="stat"><span>{{ formatCompactNumber(balance) }}</span><em>可用积分</em></div>
            <div class="stat"><span>{{ formatCompactNumber(stats.shares ?? shares.length) }}</span><em>分享文档</em></div>
            <div class="stat"><span>{{ formatCompactNumber(stats.shareViews ?? 0) }}</span><em>分享阅读量</em></div>
            <div class="stat"><span>{{ formatCompactNumber(stats.publishes ?? publishes.length) }}</span><em>已发布网页</em></div>
            <div class="stat"><span>{{ formatCompactNumber(stats.backups ?? backups.length) }}</span><em>云端备份</em></div>
          </div>

          <div class="nm-divider" />
          <button class="nm-btn nm-btn--danger" @click="auth.logout().then(() => router.push('/'))">退出当前账号</button>
        </section>

        <!-- 2. 平台积分 -->
        <section v-else-if="tab === 'credits'" class="panel">
          <h2>平台积分与兑换</h2>
          <div class="balance">
            <NmIcon name="zap" :size="20" />
            <strong>{{ formatCompactNumber(balance) }}</strong>
            <span>当前可用积分</span>
            <span v-if="pricing?.dailyGrantCredits" class="grant-tag">
              每日登录自动赠送 +{{ pricing.dailyGrantCredits }} 积分
            </span>
          </div>

          <div class="redeem">
            <input v-model="redeemCode" class="nm-input" placeholder="输入兑换码（如 NEOMD-XXXX-XXXX-XXXX）" @keyup.enter="redeem" />
            <button class="nm-btn nm-btn--primary" @click="redeem">立即兑换</button>
          </div>

          <h3>充值获取方式</h3>
          <div v-if="pricing" class="pay-list">
            <div v-for="m in pricing.paymentMethods.filter((x) => x.enabled)" :key="m.id" class="pay">
              <NmIcon name="wallet" :size="15" />
              <div>
                <strong>{{ m.name }}</strong>
                <span>{{ m.note }}</span>
              </div>
            </div>
            <p class="nm-hint">
              兑换比例：1 元 = {{ pricing.creditPerYuan }} 积分
              <template v-if="pricing.signupGrantCredits"> · 新用户注册赠送 {{ pricing.signupGrantCredits }} 积分</template>
            </p>
          </div>

          <h3>平台积分 AI 模型计费标准</h3>
          <table class="price-table">
            <thead>
              <tr><th>模型名称</th><th>计费方式</th><th>计费标准</th></tr>
            </thead>
            <tbody>
              <tr v-for="[model, price] in monthlyCost" :key="model">
                <td><code>{{ model }}</code></td>
                <td>
                  {{ price.mode === 'free' ? '免费开放' : price.mode === 'request' ? '按次计费' : '按 Tokens 计费' }}
                </td>
                <td>
                  <template v-if="price.mode === 'free'">0 积分</template>
                  <template v-else-if="price.mode === 'request'">{{ price.perCall ?? 2 }} 积分 / 次</template>
                  <template v-else>输入 {{ price.in }} / 输出 {{ price.out }}（积分 / 千 tokens）</template>
                </td>
              </tr>
            </tbody>
          </table>

          <h3>积分变动流水</h3>
          <table class="ledger">
            <thead>
              <tr><th>时间</th><th>类型</th><th>变动</th><th>余额</th><th>说明</th></tr>
            </thead>
            <tbody>
              <tr v-for="(l, i) in ledger" :key="i">
                <td>{{ l.createdAt }}</td>
                <td>{{ l.kind === 'recharge' ? '兑换充值' : l.kind === 'grant' ? '系统赠送' : l.kind === 'consume' ? 'AI 消耗' : l.kind }}</td>
                <td :class="Number(l.delta) > 0 ? 'plus' : 'minus'">{{ Number(l.delta) > 0 ? '+' : '' }}{{ l.delta }}</td>
                <td>{{ l.balanceAfter }}</td>
                <td>{{ l.ref ?? '' }}</td>
              </tr>
              <tr v-if="!ledger.length"><td colspan="5" class="empty">暂无积分流水</td></tr>
            </tbody>
          </table>
        </section>

        <!-- 3. 对象存储与自动同步 -->
        <section v-else-if="tab === 'storage'" class="panel">
          <h2>对象存储与跨端自动同步</h2>
          <p class="nm-hint">
            在此配置您的 S3 兼容对象存储（阿里云 OSS、腾讯云 COS 等）。配置完成后，网页端与各平台客户端登录同一账号将自动实时同步所有文档与版本，无需手动点击同步。
          </p>
          <div class="field">
            <label class="nm-label">云存储服务商</label>
            <div class="providers">
              <button
                v-for="p in STORAGE_PRESETS"
                :key="p.id"
                type="button"
                class="provider"
                :class="{ 'is-active': storage.provider === p.id }"
                @click="onStorageProviderChange(p.id)"
              >
                {{ p.name }}
              </button>
            </div>
          </div>
          <div class="grid2">
            <div class="field">
              <label class="nm-label">地域（Region）</label>
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
              <label class="nm-label">存储桶（Bucket）</label>
              <input
                class="nm-input"
                :class="{ 'is-invalid': storageConfigIssues.some((i) => i.includes('Bucket')) }"
                :value="storage.bucket"
                placeholder="例如：neomd-bucket"
                @input="settingsStore.update({ storage: { ...storage, bucket: ($event.target as HTMLInputElement).value } })"
              />
            </div>
          </div>
          <div class="field">
            <label class="nm-label">Endpoint 地址</label>
            <input
              class="nm-input"
              :class="{ 'is-invalid': storageConfigIssues.some((i) => i.includes('Endpoint')) }"
              :value="storage.endpoint"
              placeholder="https://s3.oss-cn-hangzhou.aliyuncs.com"
              @input="settingsStore.update({ storage: { ...storage, endpoint: ($event.target as HTMLInputElement).value } })"
            />
            <p v-if="storage.endpoint && !/^https?:\/\//i.test(storage.endpoint.trim())" class="nm-hint">
              提交时将自动补全为 https://{{ storage.endpoint.trim() }}
            </p>
          </div>
          <div class="grid2">
            <div class="field">
              <label class="nm-label">AccessKey ID</label>
              <input
                class="nm-input"
                :value="storage.accessKeyId"
                autocomplete="off"
                @input="settingsStore.setStorageKeyId(($event.target as HTMLInputElement).value)"
              />
            </div>
            <div class="field">
              <label class="nm-label">AccessKey Secret</label>
              <input
                class="nm-input"
                type="password"
                :value="storage.accessKeySecret"
                autocomplete="off"
                @input="settingsStore.setSecret('storage', ($event.target as HTMLInputElement).value)"
              />
            </div>
          </div>
          <div class="grid2">
            <div class="field">
              <label class="nm-label">对象键根前缀</label>
              <input class="nm-input" :value="sync.rootPrefix" @input="settingsStore.update({ sync: { ...sync, rootPrefix: ($event.target as HTMLInputElement).value } })" />
            </div>
            <div class="field">
              <label class="nm-label">历史版本保留天数</label>
              <input class="nm-input" type="number" min="1" :value="sync.versionRetentionDays" @input="settingsStore.update({ sync: { ...sync, versionRetentionDays: Number(($event.target as HTMLInputElement).value) } })" />
            </div>
          </div>
          <div class="actions-row">
            <button
              class="nm-btn nm-btn--primary"
              :disabled="probing || !auth.isLoggedIn"
              :title="
                !auth.isLoggedIn
                  ? '请先登录后再测试对象存储连接（检测需要服务端代探以绕过浏览器跨域限制）'
                  : storageConfigIssues.length
                    ? storageConfigIssues[0]
                    : '由服务端代探对象存储连通性'
              "
              @click="testStorage"
            >
              {{ probing ? '检测中…' : '测试连接并保存' }}
            </button>
            <span v-if="!auth.isLoggedIn" class="nm-hint">未登录无法检测</span>
            <span v-else-if="storageConfigIssues.length" class="nm-hint">{{ storageConfigIssues[0] }}</span>
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

        <!-- 4. AI 服务配置（含「平台积分」作为第一供应商） -->
        <section v-else-if="tab === 'ai'" class="panel">
          <h2>AI 服务与模型配置</h2>
          <p class="nm-hint">
            选择「平台积分」即可直接使用管理员后台配置的模型（按后台设定的计费方式扣减积分，无需个人 Key）；或选择任意第三方供应商填写自己的 API Key。
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
                @click="onAIProviderChange(p.id)"
              >
                <NmIcon v-if="p.id === 'platform'" name="zap" :size="13" />
                {{ p.name }}
              </button>
            </div>
          </div>

          <template v-if="ai.provider === 'platform' || ai.usePlatform">
            <div class="platform-banner">
              <div>
                <strong>已选择「平台积分」作为 AI 供应商</strong>
                <p>当前可用积分：<strong>{{ formatCompactNumber(balance) }}</strong>。调用 AI 助手或自动命名时将自动按后台模型策略计费并优先路由高优先级渠道。</p>
              </div>
              <button class="nm-btn nm-btn--sm" @click="tab = 'credits'">去充值/兑换</button>
            </div>
          </template>
          <template v-else>
            <div class="field">
              <div class="row-between">
                <label class="nm-label">API 地址（Base URL）</label>
                <a class="link-btn" :href="aiPreset.console" target="_blank" rel="noopener">
                  <NmIcon name="external" :size="12" />前往 {{ aiPreset.name }} 控制台获取 API Key
                </a>
              </div>
              <input
                class="nm-input"
                :class="{ 'is-invalid': aiConfigIssues.some((i) => i.includes('Base URL')) }"
                :value="ai.baseUrl"
                placeholder="https://api.deepseek.com/v1"
                @input="settingsStore.update({ ai: { ...ai, baseUrl: ($event.target as HTMLInputElement).value } })"
              />
              <p v-if="ai.baseUrl && !/^https?:\/\//i.test(ai.baseUrl.trim())" class="nm-hint">
                提交时将自动补全为 https://{{ ai.baseUrl.trim() }}
              </p>
            </div>
            <div class="field">
              <label class="nm-label">API Key</label>
              <input
                class="nm-input"
                type="password"
                :value="ai.apiKey"
                placeholder="sk-..."
                autocomplete="off"
                @input="settingsStore.setSecret('ai', ($event.target as HTMLInputElement).value)"
              />
            </div>
          </template>

          <div class="field">
            <div class="row-between">
              <label class="nm-label">拉取并勾选要启用的模型（仅勾选的模型会出现在 AI 助手输入框中）</label>
              <button
                class="nm-btn nm-btn--sm"
                :disabled="loadingModels || !auth.isLoggedIn"
                :title="!auth.isLoggedIn ? '请先登录后测试 AI 服务' : '由服务端代拉可用模型列表'"
                @click="fetchModels"
              >
                <NmIcon name="refresh" :size="12" />
                {{ loadingModels ? '获取中…' : '获取可用模型列表' }}
              </button>
            </div>
            <p v-if="modelSource" class="nm-hint">{{ modelSource }}</p>
            <div class="model-list">
              <button
                v-for="m in (modelList.length ? modelList : aiPreset.models)"
                :key="m"
                type="button"
                class="model-chip"
                :class="{ 'is-on': (ai.models.length ? ai.models : [ai.model]).includes(m) }"
                :title="`启用 / 停用模型 ${m}`"
                @click="toggleModel(m)"
              >
                {{ (ai.models.length ? ai.models : [ai.model]).includes(m) ? '✓ ' : '' }}{{ m }}
              </button>
            </div>
          </div>

          <div class="grid2">
            <div class="field">
              <label class="nm-label">默认模型（用于 AI 自动命名等任务）</label>
              <select class="nm-input" :value="ai.model" aria-label="默认模型" @change="settingsStore.update({ ai: { ...ai, model: ($event.target as HTMLSelectElement).value } })">
                <option v-for="m in (ai.models.length ? ai.models : aiPreset.models)" :key="m" :value="m">{{ m }}</option>
              </select>
            </div>
            <div class="field">
              <label class="nm-label">Temperature</label>
              <input class="nm-input" type="number" step="0.1" min="0" max="2" :value="ai.temperature" aria-label="Temperature" @input="settingsStore.update({ ai: { ...ai, temperature: Number(($event.target as HTMLInputElement).value) } })" />
            </div>
          </div>

          <div class="actions-row">
            <button
              class="nm-btn nm-btn--primary"
              :disabled="aiTesting || !auth.isLoggedIn"
              :title="
                !auth.isLoggedIn ? '请先登录后测试 AI 服务' : aiConfigIssues.length ? aiConfigIssues[0] : '由服务端代测 AI 连通性'
              "
              @click="testAI"
            >
              {{ aiTesting ? '测试中…' : '测试连接' }}
            </button>
            <span v-if="!auth.isLoggedIn" class="nm-hint">未登录无法测试</span>
            <span v-else-if="aiConfigIssues.length" class="nm-hint">{{ aiConfigIssues[0] }}</span>
          </div>

          <div v-if="aiTestResult" class="probe-box" :class="{ 'is-ok': aiTestOk }" role="status" aria-live="polite">
            <p class="probe-box__head">
              <NmIcon :name="aiTestOk ? 'check' : 'alert'" :size="14" />
              <span>{{ aiTestResult }}</span>
            </p>
          </div>
        </section>

        <!-- 5. 分享、发布与自定义分享页样式 -->
        <section v-else-if="tab === 'shares'" class="panel">
          <h2>分享页面个性化样式设置</h2>
          <p class="nm-hint">自定义您分享出去的页面顶部品牌名称、主题色与纸张风格，不再统一显示默认产品名称。</p>
          <div class="grid2">
            <div class="field">
              <label class="nm-label">分享页顶部展示名称（留空则显示您的昵称）</label>
              <input
                class="nm-input"
                :value="shareStyle.brandTitle"
                placeholder="例如：张工的技术专栏 / 产品研发知识库"
                @change="updateShareStyle({ brandTitle: ($event.target as HTMLInputElement).value })"
              />
            </div>
            <div class="field">
              <label class="nm-label">分享页副标题 / 签名</label>
              <input
                class="nm-input"
                :value="shareStyle.brandSubtitle"
                placeholder="例如：专注云原生与架构设计"
                @change="updateShareStyle({ brandSubtitle: ($event.target as HTMLInputElement).value })"
              />
            </div>
          </div>
          <div class="grid2">
            <div class="field">
              <label class="nm-label">分享页阅读纸张风格</label>
              <div class="seg">
                <button
                  v-for="ps in ([
                    { id: 'white', label: '纯白商务' },
                    { id: 'warm', label: '暖米书刊' },
                    { id: 'green', label: '绿色护眼' },
                    { id: 'dark', label: '深邃暗色' },
                  ] as const)"
                  :key="ps.id"
                  type="button"
                  class="seg__item"
                  :class="{ 'is-active': shareStyle.paperStyle === ps.id }"
                  @click="updateShareStyle({ paperStyle: ps.id })"
                >
                  {{ ps.label }}
                </button>
              </div>
            </div>
            <div class="field">
              <label class="nm-label">隐藏分享页底部默认产品标识</label>
              <div>
                <button
                  type="button"
                  class="nm-btn nm-btn--sm"
                  :class="{ 'nm-btn--primary': shareStyle.hideProductBrand }"
                  @click="updateShareStyle({ hideProductBrand: !shareStyle.hideProductBrand })"
                >
                  {{ shareStyle.hideProductBrand ? '已隐藏产品标识' : '显示产品标识' }}
                </button>
              </div>
            </div>
          </div>

          <div class="nm-divider" />
          <h3>我的分享链接（{{ shares.length }}）</h3>
          <table class="ledger">
            <thead>
              <tr><th>文档名称</th><th>密码保护</th><th>浏览 / 评论</th><th>状态</th><th>操作</th></tr>
            </thead>
            <tbody>
              <template v-for="s in shares" :key="s.id">
                <tr>
                  <td><strong>{{ s.title }}</strong></td>
                  <td>{{ s.hasPassword ? '已设密码' : '公开免密' }}</td>
                  <td>{{ s.viewCount }} 次浏览 · {{ s.commentCount ?? 0 }} 条评论</td>
                  <td>{{ s.revokedAt ? '已撤销' : '有效' }}</td>
                  <td class="ops">
                    <a v-if="!s.revokedAt" :href="shareUrl(s.token)" target="_blank" rel="noopener">打开链接</a>
                    <button type="button" @click="toggleShareComments(s)">
                      {{ expandedShareId === s.id ? '收起评论' : `查看评论(${s.commentCount ?? 0})` }}
                    </button>
                    <button v-if="!s.revokedAt" type="button" class="danger-link" @click="revokeShare(s.id)">撤销</button>
                  </td>
                </tr>
                <tr v-if="expandedShareId === s.id">
                  <td colspan="5" class="comment-subrow">
                    <div v-if="(shareCommentsMap[s.id] ?? []).length" class="sub-comments">
                      <div v-for="c in shareCommentsMap[s.id]" :key="c.id" class="sub-comment">
                        <div class="sub-comment__head">
                          <strong>{{ c.authorName }}</strong>
                          <span>{{ c.createdAt }}</span>
                        </div>
                        <blockquote v-if="c.quote" class="sub-comment__quote">「{{ c.quote }}」</blockquote>
                        <p class="sub-comment__body">{{ c.body }}</p>
                      </div>
                    </div>
                    <p v-else class="nm-hint" style="margin: 0;">该分享暂无访客评论。</p>
                  </td>
                </tr>
              </template>
              <tr v-if="!shares.length"><td colspan="5" class="empty">暂无分享记录，可在编辑器右上角点击「分享与发布」创建</td></tr>
            </tbody>
          </table>

          <h3>已发布静态网页（{{ publishes.length }}）</h3>
          <table class="ledger">
            <thead>
              <tr><th>标题</th><th>标识 (Slug)</th><th>状态</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="p in publishes" :key="p.id">
                <td><strong>{{ p.title }}</strong></td>
                <td class="mono">{{ p.slug }}</td>
                <td>{{ p.revokedAt ? '已下线' : '在线' }}</td>
                <td class="ops">
                  <a v-if="!p.revokedAt" :href="p.url || publishUrl(p.slug)" target="_blank" rel="noopener">打开网页</a>
                  <button v-if="!p.revokedAt" type="button" class="danger-link" @click="revokePublish(p.id)">下线</button>
                </td>
              </tr>
              <tr v-if="!publishes.length"><td colspan="4" class="empty">暂无发布记录</td></tr>
            </tbody>
          </table>
        </section>

        <!-- 7. 备份记录 -->
        <section v-else-if="tab === 'backups'" class="panel">
          <h2>云端备份记录</h2>
          <p class="nm-hint">备份保存在您的对象存储中，可随时下载恢复。</p>
          <table class="ledger">
            <thead>
              <tr><th>名称</th><th>文档数</th><th>大小</th><th>时间</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="b in backups" :key="b.id">
                <td>{{ b.name }}</td>
                <td>{{ b.docCount }}</td>
                <td>{{ formatBytes(b.bytes) }}</td>
                <td>{{ b.createdAt }}</td>
                <td class="ops">
                  <a :href="b.url" target="_blank" rel="noopener">下载</a>
                  <button class="danger-link" @click="removeBackup(b.id)">删除</button>
                </td>
              </tr>
              <tr v-if="!backups.length"><td colspan="5" class="empty">还没有备份记录</td></tr>
            </tbody>
          </table>
        </section>
      </template>
    </main>

    <!-- 插件中心（原「插件」页签内容，独立模态自管开关） -->
    <PluginCenter v-model:open="pluginCenterOpen" />
  </div>
</template>

<style scoped>
.account { min-height: 100%; height: 100%; overflow-y: auto; background: var(--bg); }
.account__nav {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 24px; border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(14px);
}
.account__nav-right { display: flex; align-items: center; gap: 8px; }
.brand { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 700; color: var(--fg); }
.mark {
  width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center;
  background: linear-gradient(135deg, #1677ff, #4a9bff); color: #fff; font-size: 13px; font-weight: 700;
}
.account__main { max-width: 1020px; margin: 0 auto; padding: 24px 20px 64px; }
.account__tabs { display: flex; gap: 4px; overflow-x: auto; margin-bottom: 18px; padding-bottom: 4px; scrollbar-width: none; }
.account__tabs::-webkit-scrollbar { display: none; }
.account__tab {
  display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px;
  border-radius: 8px; font-size: 13px; color: var(--fg-2); white-space: nowrap;
}
.account__tab:hover { background: var(--bg-hover); }
.account__tab.is-active { background: var(--bg-active); color: var(--accent); font-weight: 600; }
/* 插件中心入口：与普通页签区分（打开模态而非切换页签） */
.account__tab--plugin {
  margin-left: auto;
  border: 1px dashed color-mix(in srgb, var(--accent) 45%, var(--border));
  color: var(--accent);
}
.account__tab--plugin:hover { background: var(--accent-weak-2); }

.panel { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 14px; padding: 24px; }
.panel h2 { margin: 0 0 16px; font-size: 18px; letter-spacing: -0.01em; }
.panel h3 { margin: 22px 0 10px; font-size: 14px; font-weight: 650; }
.field { margin-bottom: 14px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.row-between { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
.actions-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

.avatar-row { display: flex; align-items: center; gap: 16px; margin-bottom: 18px; }
.avatar {
  width: 68px; height: 68px; border-radius: 50%; overflow: hidden; display: grid; place-items: center;
  background: linear-gradient(135deg, #1677ff, #4a9bff); color: #fff; font-size: 24px; font-weight: 700; flex: 0 0 auto;
}
.avatar img { width: 100%; height: 100%; object-fit: cover; }
.avatar-actions { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
.stat { padding: 14px; border-radius: 10px; background: var(--bg-sidebar); border: 1px solid var(--border); text-align: center; }
.stat span { display: block; font-size: 20px; font-weight: 700; color: var(--accent); }
.stat em { font-style: normal; font-size: 11.5px; color: var(--fg-3); }

.balance {
  display: flex; align-items: baseline; gap: 10px; padding: 18px 20px; border-radius: 12px;
  background: linear-gradient(135deg, rgba(22,119,255,.12), rgba(22,119,255,.03));
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border)); margin-bottom: 14px; flex-wrap: wrap;
}
.balance strong { font-size: 28px; color: var(--accent); letter-spacing: -0.02em; }
.balance span { font-size: 12.5px; color: var(--fg-3); }
.grant-tag { margin-left: auto; padding: 3px 10px; border-radius: 999px; background: var(--accent-weak); color: var(--accent) !important; font-weight: 600; }

.redeem { display: flex; gap: 8px; margin-bottom: 10px; }
.redeem input { flex: 1; }
.pay-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
.pay { display: flex; align-items: center; gap: 10px; padding: 11px 13px; border-radius: 9px; border: 1px solid var(--border); }
.pay div { display: flex; flex-direction: column; }
.pay strong { font-size: 13px; }
.pay span { font-size: 11.5px; color: var(--fg-3); }

.providers { display: flex; flex-wrap: wrap; gap: 6px; }
.provider { padding: 7px 12px; border-radius: 8px; border: 1px solid var(--border); font-size: 12.5px; color: var(--fg-2); display: inline-flex; align-items: center; gap: 5px; }
.provider.is-active { border-color: var(--accent); background: var(--accent-weak-2); color: var(--accent); font-weight: 600; }
.platform-banner {
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  padding: 14px 16px; border-radius: 10px; background: var(--accent-weak-2);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border)); margin-bottom: 14px;
}
.platform-banner p { margin: 4px 0 0; font-size: 12.5px; color: var(--fg-2); }
.link-btn { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--accent); }
.model-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.model-chip { padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border); font-size: 12px; font-family: var(--font-mono); color: var(--fg-2); }
.model-chip.is-on { border-color: var(--accent); background: var(--accent-weak); color: var(--accent); font-weight: 600; }
.nm-input.is-invalid { border-color: #d93025; }

/* 检测结果（含逐步明细） */
.probe-box { margin-top: 14px; padding: 10px 12px; border-radius: 9px; border: 1px solid rgba(217, 48, 37, 0.28); background: rgba(217, 48, 37, 0.06); font-size: 12.5px; color: #d93025; line-height: 1.6; }
.probe-box.is-ok { border-color: rgba(22, 163, 74, 0.3); background: rgba(22, 163, 74, 0.07); color: #16a34a; }
.probe-box__head { display: flex; align-items: center; gap: 7px; margin: 0; font-weight: 600; }
.probe-steps { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 4px; }
.probe-step { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 6px; background: var(--bg-elevated); border: 1px solid var(--border); color: var(--fg-2); font-size: 12px; }
.probe-step.is-ok .probe-step__icon { color: #16a34a; }
.probe-step.is-bad { border-color: rgba(217, 48, 37, 0.4); }
.probe-step.is-bad .probe-step__icon { color: #d93025; }
.probe-step__icon { width: 14px; text-align: center; font-weight: 700; flex: 0 0 auto; }
.probe-step__name { min-width: 42px; font-weight: 600; color: var(--fg); flex: 0 0 auto; }
.probe-step__time { font-family: var(--font-mono); font-size: 11px; color: var(--fg-3); flex: 0 0 auto; }
.probe-step__msg { margin-left: auto; font-size: 11.5px; color: #d93025; text-align: right; word-break: break-word; }

.seg { display: inline-flex; padding: 3px; gap: 2px; border-radius: 8px; background: var(--bg-hover); border: 1px solid var(--border); flex-wrap: wrap; }
.seg__item { padding: 6px 12px; border-radius: 6px; font-size: 12.5px; color: var(--fg-2); }
.seg__item.is-active { background: var(--bg-elevated); color: var(--accent); font-weight: 600; box-shadow: var(--shadow-1); }

.price-table, .ledger { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.price-table th, .price-table td, .ledger th, .ledger td { padding: 9px 10px; border-bottom: 1px solid var(--border); text-align: left; }
.price-table th, .ledger th { color: var(--fg-3); font-weight: 600; font-size: 11.5px; }
.plus { color: #16a34a; font-weight: 600; }
.minus { color: #d93025; }
.empty { text-align: center !important; color: var(--fg-3); padding: 20px !important; }
.ops { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.ops a, .ops button { color: var(--accent); font-size: 12px; }
.danger-link { color: #d93025 !important; }
.mono { font-family: var(--font-mono); }

.comment-subrow { background: var(--bg-sidebar); padding: 12px 16px !important; }
.sub-comments { display: grid; gap: 8px; }
.sub-comment { padding: 8px 12px; border-radius: 8px; background: var(--bg-elevated); border: 1px solid var(--border); }
.sub-comment__head { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--fg-3); margin-bottom: 4px; }
.sub-comment__quote { margin: 4px 0; padding: 4px 8px; border-left: 3px solid var(--accent); background: var(--accent-weak-2); font-size: 12px; color: var(--fg-2); }
.sub-comment__body { margin: 4px 0 0; font-size: 12.5px; color: var(--fg); }

.err { padding: 10px 14px; border-radius: 8px; background: rgba(217, 48, 37, 0.1); color: #d93025; font-size: 13px; margin-bottom: 12px; }
.ok { padding: 10px 14px; border-radius: 8px; background: rgba(22, 163, 74, 0.1); color: #16a34a; font-size: 13px; margin-bottom: 12px; }
@media (max-width: 640px) {
  .grid2 { grid-template-columns: 1fr; }
}
</style>
