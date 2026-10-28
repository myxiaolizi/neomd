<script setup lang="ts">
/**
 * 服务端连接与数据私有化设置（**独立组件**，由 SettingsModal 以标签页形式挂载）。
 *
 * 能力：
 * 1. 服务端模式切换（官方 / 自建）；
 * 2. 自建地址输入与校验（仅 http(s)，自动去尾斜杠与误填的 `/api`）；
 * 3. 「测试连接」——请求 `{base}/api/health`，展示 version / db / 耗时；
 * 4. 数据私有化开关（含风险说明与二次确认）。
 *
 * 约定：
 * - 仅在**桌面端**渲染（网页端与安卓端没有本地文件夹 + S3 的完整离线链路）；
 * - 所有配置都是严格本地项，不经云端同步；
 * - 应用商店（插件市场）永远走官方服务，界面上明确提示不可私有化。
 */
import { computed, ref } from 'vue';
import { NmIcon, NmToggle } from '@neomd/ui';
import { detectRuntime } from '@neomd/core';
import type { ServerSettings } from '@neomd/shared';
import { useSettingsStore } from '@/stores/settings';
import { OFFICIAL_SERVER_BASE, normalizeServerBase } from '@/lib/server-endpoint';

const props = defineProps<{
  /** 紧凑模式：由外层标签页提供标题时置 true，隐藏组件自带的大标题 */
  compact?: boolean;
}>();
const emit = defineEmits<{
  /** 任一项配置被修改（供外层做"已保存"提示） */
  changed: [ServerSettings];
}>();

const settingsStore = useSettingsStore();
const runtime = detectRuntime();
const isDesktop = computed(() => runtime.platform === 'desktop');

/** 当前服务端配置（store 层已做兜底，这里再兜一次防止旧数据缺失） */
const server = computed<ServerSettings>(
  () =>
    settingsStore.settings.server ?? {
      mode: 'official',
      customBaseUrl: '',
      privacyMode: false,
    },
);

/** 输入框草稿：避免用户输入过程中被规范化打断（失焦时才回写规范化结果） */
const draftBase = ref(server.value.customBaseUrl);

const baseError = computed(() => {
  if (server.value.mode !== 'custom') return '';
  const text = draftBase.value.trim();
  if (!text) return '请填写自建服务器地址，例如 https://neomd.example.com';
  if (!/^https?:\/\//i.test(text)) return '地址必须以 http:// 或 https:// 开头';
  if (!normalizeServerBase(text)) return '地址格式不正确，请检查域名与端口';
  return '';
});

const baseValid = computed(() => Boolean(normalizeServerBase(draftBase.value)));

/* ---------------- 连接测试 ---------------- */

interface HealthInfo {
  version: string;
  db: boolean;
  env?: string;
  latencyMs: number;
}

const testing = ref(false);
const testResult = ref<HealthInfo | null>(null);
const testError = ref('');

/** 本次要探测的地址：自建模式用草稿里的地址，官方模式用官方地址 */
const probeBase = computed(() =>
  server.value.mode === 'custom' ? normalizeServerBase(draftBase.value) : OFFICIAL_SERVER_BASE,
);

async function testConnection(): Promise<void> {
  if (testing.value) return;
  const base = probeBase.value;
  if (!base) {
    testError.value = '请先填写合法的自建服务器地址';
    return;
  }
  testing.value = true;
  testResult.value = null;
  testError.value = '';
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // 直接 fetch 而不是走 api()：健康检查需要打用户输入的地址，且不受私有化拦截影响
    const res = await fetch(`${base}/api/health`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    const latencyMs = Math.round(performance.now() - started);
    let body: { ok?: boolean; db?: boolean; version?: string; env?: string } | null = null;
    try {
      body = (await res.json()) as { ok?: boolean; db?: boolean; version?: string; env?: string };
    } catch {
      body = null;
    }
    if (!res.ok || !body) {
      testError.value = `连接失败：HTTP ${res.status}${body ? '' : '（返回内容不是 JSON，可能不是 Neo MD 服务端）'}`;
      return;
    }
    testResult.value = {
      version: body.version ?? '未知',
      db: body.db === true,
      env: body.env,
      latencyMs,
    };
    if (!body.ok) testError.value = '服务端可达，但数据库自检未通过，请检查服务端配置';
  } catch (e) {
    const err = e as Error;
    testError.value =
      err.name === 'AbortError' ? '连接超时（8 秒），请检查地址与网络' : `无法连接：${err.message}`;
  } finally {
    clearTimeout(timer);
    testing.value = false;
  }
}

/* ---------------- 修改配置 ---------------- */

function onModeChange(mode: 'official' | 'custom'): void {
  if (server.value.mode === mode) return;
  settingsStore.updateServer({ mode });
  testResult.value = null;
  testError.value = '';
  emit('changed', { ...server.value, mode });
}

function onBaseInput(e: Event): void {
  draftBase.value = (e.target as HTMLInputElement).value;
}

function commitBase(): void {
  const normalized = normalizeServerBase(draftBase.value);
  if (normalized) {
    draftBase.value = normalized;
    settingsStore.updateServer({ customBaseUrl: normalized });
    emit('changed', { ...server.value, customBaseUrl: normalized });
  } else if (!draftBase.value.trim()) {
    // 清空即视为未配置，回写空串
    settingsStore.updateServer({ customBaseUrl: '' });
  }
}

/* ---------------- 数据私有化（二次确认） ---------------- */

const confirmPrivacy = ref(false);

function togglePrivacy(next: boolean): void {
  if (next) {
    // 开启是高影响操作：先进入二次确认，确认后才真正落盘
    confirmPrivacy.value = true;
    return;
  }
  applyPrivacy(false);
}

function applyPrivacy(value: boolean): void {
  confirmPrivacy.value = false;
  settingsStore.updateServer({ privacyMode: value });
  emit('changed', { ...server.value, privacyMode: value });
}

function cancelPrivacy(): void {
  confirmPrivacy.value = false;
}

const currentBase = computed(() => normalizeServerBase(draftBase.value));
</script>

<template>
  <div v-if="isDesktop" class="srv">
    <template v-if="!props.compact">
      <h3 class="pane__title">服务端连接</h3>
      <p class="nm-hint">
        默认连接官方服务端。若你已在自有服务器上部署 Neo MD，可改为自建地址；
        应用商店（插件市场）始终使用官方统一服务，不随此处设置变化。
      </p>
    </template>

    <!-- 模式切换 -->
    <div class="field">
      <label class="nm-label">服务端模式</label>
      <div class="seg" role="radiogroup" aria-label="服务端模式">
        <button
          type="button"
          class="seg__item"
          role="radio"
          :aria-checked="server.mode === 'official'"
          :class="{ 'is-active': server.mode === 'official' }"
          @click="onModeChange('official')"
        >
          <NmIcon name="globe" :size="13" />官方服务器
        </button>
        <button
          type="button"
          class="seg__item"
          role="radio"
          :aria-checked="server.mode === 'custom'"
          :class="{ 'is-active': server.mode === 'custom' }"
          @click="onModeChange('custom')"
        >
          <NmIcon name="server" :size="13" />自建服务器
        </button>
      </div>
      <p class="nm-hint">
        {{
          server.mode === 'official'
            ? `当前使用官方服务端 ${OFFICIAL_SERVER_BASE}`
            : '当前使用自建服务端，请确保地址可从本机访问'
        }}
      </p>
    </div>

    <!-- 自建地址 -->
    <div v-if="server.mode === 'custom'" class="field">
      <label class="nm-label" for="srv-custom-base">自建服务器地址</label>
      <input
        id="srv-custom-base"
        class="nm-input"
        :value="draftBase"
        placeholder="https://neomd.example.com"
        spellcheck="false"
        autocomplete="off"
        @input="onBaseInput"
        @blur="commitBase"
        @keyup.enter="commitBase"
      />
      <p v-if="baseError" class="srv__err">{{ baseError }}</p>
      <p v-else class="nm-hint">
        只填服务端根地址（不含 <code>/api</code>），必须使用 http 或 https；保存时会自动去掉末尾斜杠。
      </p>
    </div>

    <!-- 测试连接 -->
    <div class="field">
      <div class="row-between">
        <label class="nm-label">连接测试</label>
        <button
          type="button"
          class="nm-btn nm-btn--sm"
          :disabled="testing || (server.mode === 'custom' && !baseValid)"
          @click="testConnection"
        >
          <NmIcon name="wifi" :size="13" />{{ testing ? '测试中…' : '测试连接' }}
        </button>
      </div>
      <div v-if="testResult" class="srv__result" :class="{ 'is-bad': !testResult.db }">
        <span class="srv__badge">
          <NmIcon :name="testResult.db ? 'check' : 'alert'" :size="12" />
          {{ testResult.db ? '连接成功' : '数据库异常' }}
        </span>
        <span>版本 {{ testResult.version }}</span>
        <span>数据库 {{ testResult.db ? '正常' : '不可用' }}</span>
        <span>耗时 {{ testResult.latencyMs }} ms</span>
        <span class="srv__target">{{ probeBase }}/api/health</span>
      </div>
      <p v-if="testError" class="srv__err">{{ testError }}</p>
      <p v-if="!testResult && !testError" class="nm-hint">
        请求 <code>{{ probeBase }}/api/health</code>，只读取版本与数据库状态，不会写入任何数据。
      </p>
    </div>

    <h3 v-if="!props.compact" class="pane__title">数据私有化</h3>

    <!-- 隐私模式开关 -->
    <div class="field">
      <div class="srv__row">
        <div class="srv__row-text">
          <strong>数据私有化模式</strong>
          <span>开启后编辑器完全不连接服务器，仅使用本地文件夹与对象存储同步</span>
        </div>
        <NmToggle
          :model-value="server.privacyMode"
          label="数据私有化模式"
          @update:model-value="togglePrivacy"
        />
      </div>

      <div v-if="confirmPrivacy" class="srv__warn">
        <p class="srv__warn-title">
          <NmIcon name="alert" :size="14" />确认开启数据私有化模式？
        </p>
        <ul class="srv__warn-list">
          <li>不再请求账号、云端设置、AI、个人资料、上传、分享、发布与积分接口；</li>
          <li>登录状态、积分、在线分享与网页发布将不可用；</li>
          <li>协作数据只保留本地文件夹与对象存储（S3）中的内容；</li>
          <li>插件市场（应用商店）仍会连接官方服务，这是产品默认行为。</li>
        </ul>
        <div class="srv__warn-actions">
          <button type="button" class="nm-btn nm-btn--sm" @click="cancelPrivacy">取消</button>
          <button type="button" class="nm-btn nm-btn--sm nm-btn--danger" @click="applyPrivacy(true)">
            确认开启
          </button>
        </div>
      </div>

      <p v-if="server.privacyMode" class="nm-hint srv__on">
        <NmIcon name="shield" :size="13" />已开启：编辑器不再与服务端通信，本地写作与 S3 同步不受影响。
      </p>
    </div>
  </div>
</template>

<style scoped>
.srv {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pane__title {
  margin: 18px 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
}
.pane__title:first-child {
  margin-top: 0;
}
.field {
  margin-bottom: 14px;
}
.row-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.seg {
  display: inline-flex;
  padding: 2px;
  border-radius: 8px;
  background: var(--bg-hover);
  border: 1px solid var(--border);
  gap: 2px;
}
.seg__item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--fg-2);
}
.seg__item.is-active {
  background: var(--bg-elevated);
  color: var(--accent);
  box-shadow: var(--shadow-1, 0 1px 2px rgba(0, 0, 0, 0.08));
}
.srv__row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-elevated);
}
.srv__row-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.srv__row-text strong {
  font-size: 12.5px;
}
.srv__row-text span {
  font-size: 11.5px;
  color: var(--fg-3);
  line-height: 1.5;
}
.srv__err {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: #d93025;
}
.srv__result {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgba(14, 159, 110, 0.35);
  background: rgba(14, 159, 110, 0.07);
  font-size: 11.5px;
  color: var(--fg-2);
}
.srv__result.is-bad {
  border-color: rgba(217, 48, 37, 0.35);
  background: rgba(217, 48, 37, 0.07);
}
.srv__badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 600;
  color: #0e9f6e;
}
.srv__result.is-bad .srv__badge {
  color: #d93025;
}
.srv__target {
  margin-left: auto;
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  color: var(--fg-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.srv__warn {
  margin-top: 10px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid rgba(217, 48, 37, 0.32);
  background: rgba(217, 48, 37, 0.06);
}
.srv__warn-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: #d93025;
}
.srv__warn-list {
  margin: 0 0 10px;
  padding-left: 18px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--fg-2);
}
.srv__warn-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.srv__on {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  color: #0e9f6e;
}
code {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  padding: 0 3px;
  border-radius: 3px;
  background: var(--bg-hover);
}
</style>
