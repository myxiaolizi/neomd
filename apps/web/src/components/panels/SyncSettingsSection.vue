<script setup lang="ts">
/**
 * 同步设置区块（1.1.8 新增）。
 *
 * 用户原话：「解决仓库同步，数据同步等能力无法使用的问题」——
 * 之前同步对用户是**黑盒**：只有一个状态文字，失败时只看到
 * 「同步失败：Failed to fetch」，既不知道原因也不知道能做什么。
 *
 * 本区块把同步做成「可见、可控、可诊断」：
 *  - 手动同步 + 上次结果（含失败的具体原因）；
 *  - 自动同步间隔；
 *  - 同步方向与冲突策略；
 *  - 同步日志（失败原因原文）；
 *  - 全部仓库同步。
 *
 * 说明：本组件只依赖 `useAppStore` 暴露的同步 API，不直接碰 Vault/SyncEngine，
 * 便于其它页面（设置页、状态栏弹层）复用。
 */
import { computed, onMounted, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { useAppStore } from '@/stores/app';
import { useAuthStore } from '@/stores/auth';
import { useSettingsStore } from '@/stores/settings';

const props = defineProps<{ compact?: boolean }>();

const app = useAppStore();
const auth = useAuthStore();
const settingsStore = useSettingsStore();

/** 立即同步（当前仓库） */
const syncing = ref(false);

async function syncNow(): Promise<void> {
  if (syncing.value) return;
  syncing.value = true;
  try {
    await app.syncNow();
  } finally {
    syncing.value = false;
  }
}

/** 全部仓库同步 */
async function syncAll(): Promise<void> {
  if (syncing.value || app.syncAllState.running) return;
  syncing.value = true;
  try {
    await app.syncAllVaults();
  } finally {
    syncing.value = false;
  }
}

/**
 * 「全部同步」是否正在运行（1.1.9）。
 *
 * 为什么按钮必须置 disabled：`syncAllVaults()` 会串行遍历所有仓库，
 * 50 个仓库时可能持续数分钟。store 内部虽有防重入，但按钮一直可点会让用户
 * 反复点击且看不到任何反馈 —— 置灰 + 显示进度才是正确体验。
 */
const syncAllRunning = computed(() => app.syncAllState.running);

/** 进度文案（第几个 / 共几个 / 当前仓库名） */
const syncAllProgress = computed(() => {
  const s = app.syncAllState;
  if (!s.running || s.total === 0) return '';
  const idx = Math.min(s.done + 1, s.total);
  return `正在同步 ${idx}/${s.total}${s.current ? `：${s.current}` : ''}`;
});

/** 同步能力是否可用（未登录且未自配 S3 时不可用） */
const syncEnabled = computed(() => app.canSync());

/** 为什么不可用：给用户明确的一句话，而不是让按钮灰着不说话 */
const disabledReason = computed(() => {
  if (syncEnabled.value) return '';
  return '当前不可同步：请先登录账号（走平台存储），或在「对象存储」页签配置自己的 S3/OSS。';
});

/** 采用的通道说明 */
const channelLabel = computed(() => {
  if (auth.isLoggedIn) return '平台存储（经服务器安全转发，免配置密钥）';
  if (settingsStore.storageConfigured) return '对象存储直连（你配置的 S3/OSS）';
  return '不可用';
});

/** 上次同步结果文案 */
const lastResult = computed(() => {
  const s = app.lastSyncSummary;
  if (!s) return '';
  return `${s.ok ? '成功' : '失败'}：${s.message}`;
});

/** 上次同步时间格式化 */
function fmtTime(ms?: number | null): string {
  if (!ms) return '从未同步';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/* ------------------------------ 自动同步间隔 ------------------------------ */

const INTERVAL_OPTIONS: Array<{ label: string; ms: number }> = [
  { label: '关闭', ms: 0 },
  { label: '1 分钟', ms: 60_000 },
  { label: '5 分钟', ms: 5 * 60_000 },
  { label: '15 分钟', ms: 15 * 60_000 },
  { label: '30 分钟', ms: 30 * 60_000 },
];

function setInterval_(ms: number): void {
  app.updateSyncBehavior({ autoIntervalMs: ms });
}

/* ------------------------------ 同步方向 ------------------------------ */

const DIRECTIONS: Array<{ id: 'both' | 'upload' | 'download'; label: string; desc: string }> = [
  { id: 'both', label: '双向同步', desc: '拉取云端更新，同时把本地改动推送上去（推荐）' },
  { id: 'upload', label: '仅上传', desc: '只把本地改动推送到云端，不拉取云端内容（防止被覆盖）' },
  { id: 'download', label: '仅下载', desc: '只从云端拉取，不推送本地改动（只读副本 / 临时设备）' },
];

/* ------------------------------ 冲突策略 ------------------------------ */

const POLICIES: Array<{ id: 'newest' | 'local' | 'remote'; label: string; desc: string }> = [
  { id: 'newest', label: '保留最新', desc: '比较修改时间，较新的一方生效（推荐）' },
  { id: 'local', label: '保留本地', desc: '冲突时始终以本地为准，云端改动不会覆盖本地' },
  { id: 'remote', label: '保留云端', desc: '冲突时始终以云端为准，本地改动会被覆盖' },
];

/* ------------------------------ 日志 ------------------------------ */

/** 只展示最近 20 条，避免设置页被日志撑爆 */
const recentLogs = computed(() => app.syncLogs.slice(0, 20));

const LOG_LEVEL_STYLE: Record<string, { label: string; cls: string }> = {
  info: { label: '信息', cls: 'is-info' },
  warn: { label: '警告', cls: 'is-warn' },
  error: { label: '错误', cls: 'is-error' },
};

function fmtClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 清空本地同步日志（不影响云端） */
function clearLogs(): void {
  app.syncLogs = [];
}

onMounted(() => {
  // 进页面时按当前设置重建一次自动同步定时器，保证「改了间隔立刻生效」
  app.installAutoSyncTimer();
});
</script>

<template>
  <div class="syncset" :class="{ 'syncset--compact': props.compact }">
    <!-- 当前通道 -->
    <div class="syncset__head">
      <div>
        <h4 class="syncset__title">
          同步
          <span class="syncset__badge" :class="{ 'is-ok': syncEnabled }">
            {{ syncEnabled ? '已就绪' : '不可用' }}
          </span>
        </h4>
        <p class="nm-hint">
          数据通道：<strong>{{ channelLabel }}</strong>
          · 上次同步：{{ fmtTime(app.lastSyncAt) }}
        </p>
      </div>
      <div class="syncset__actions">
        <button
          type="button"
          class="nm-btn nm-btn--primary nm-btn--sm"
          :disabled="!syncEnabled || syncing || app.syncState === 'syncing'"
          :title="syncEnabled ? '立即同步当前仓库' : disabledReason"
          @click="syncNow"
        >
          <NmIcon name="sync" :size="12" />
          {{ syncing || app.syncState === 'syncing' ? '同步中…' : '立即同步' }}
        </button>
        <button
          type="button"
          class="nm-btn nm-btn--sm"
          :disabled="!syncEnabled || syncing || syncAllRunning"
          :title="syncAllRunning ? '全部同步正在进行中' : '依次同步本机所有启用状态的仓库'"
          @click="syncAll"
        >
          {{ syncAllRunning ? '同步中…' : '全部同步' }}
        </button>
      </div>
    </div>

    <!-- 全部同步的进度（仅在运行时显示，避免常驻占位） -->
    <p v-if="syncAllProgress" class="syncset__notice">
      <NmIcon name="sync" :size="13" />
      <span>{{ syncAllProgress }}</span>
    </p>

    <p v-if="!syncEnabled" class="syncset__notice">
      <NmIcon name="alert" :size="13" />
      <span>{{ disabledReason }}</span>
    </p>

    <!-- 上次结果 -->
    <p
      v-if="lastResult"
      class="syncset__result"
      :class="{ 'is-ok': app.lastSyncSummary?.ok, 'is-fail': !app.lastSyncSummary?.ok }"
    >
      <NmIcon :name="app.lastSyncSummary?.ok ? 'check' : 'alert'" :size="13" />
      <span>{{ lastResult }}</span>
    </p>

    <!-- 自动同步间隔 -->
    <div class="syncset__field">
      <label class="nm-label">自动同步间隔</label>
      <div class="syncset__seg">
        <button
          v-for="opt in INTERVAL_OPTIONS"
          :key="opt.ms"
          type="button"
          class="syncset__seg-item"
          :class="{ 'is-active': app.autoSyncIntervalMs === opt.ms }"
          :title="opt.ms === 0 ? '关闭自动同步' : `每 ${opt.label} 自动同步一次`"
          @click="setInterval_(opt.ms)"
        >
          {{ opt.label }}
        </button>
      </div>
      <p class="nm-hint">自动同步只在有未推送改动时产生网络请求；关闭后仍可手动同步。</p>
    </div>

    <!-- 同步方向 -->
    <div class="syncset__field">
      <label class="nm-label">同步方向</label>
      <div class="syncset__options">
        <button
          v-for="d in DIRECTIONS"
          :key="d.id"
          type="button"
          class="syncset__opt"
          :class="{ 'is-active': app.syncDirection === d.id }"
          :title="d.desc"
          @click="app.updateSyncBehavior({ direction: d.id })"
        >
          <span class="syncset__opt-name">{{ d.label }}</span>
          <span class="syncset__opt-desc">{{ d.desc }}</span>
        </button>
      </div>
    </div>

    <!-- 冲突策略 -->
    <div class="syncset__field">
      <label class="nm-label">冲突处理</label>
      <div class="syncset__options">
        <button
          v-for="p in POLICIES"
          :key="p.id"
          type="button"
          class="syncset__opt"
          :class="{ 'is-active': app.syncConflictPolicy === p.id }"
          :title="p.desc"
          @click="app.updateSyncBehavior({ conflictPolicy: p.id })"
        >
          <span class="syncset__opt-name">{{ p.label }}</span>
          <span class="syncset__opt-desc">{{ p.desc }}</span>
        </button>
      </div>
    </div>

    <!-- 同步日志 -->
    <div class="syncset__field">
      <div class="syncset__log-head">
        <label class="nm-label">同步日志（最近 20 条）</label>
        <button v-if="recentLogs.length" type="button" class="nm-btn nm-btn--sm" title="清空本地日志" @click="clearLogs">
          清空
        </button>
      </div>
      <p v-if="!recentLogs.length" class="nm-hint">暂无同步日志。点「立即同步」后会在这里显示每一步的结果。</p>
      <ul v-else class="syncset__logs">
        <li v-for="log in recentLogs" :key="log.id" class="syncset__log" :class="LOG_LEVEL_STYLE[log.level]?.cls">
          <span class="syncset__log-time">{{ fmtClock(log.at) }}</span>
          <span class="syncset__log-level">{{ LOG_LEVEL_STYLE[log.level]?.label ?? log.level }}</span>
          <span class="syncset__log-msg">{{ log.message }}</span>
          <span v-if="log.detail" class="syncset__log-detail">{{ log.detail }}</span>
        </li>
      </ul>
    </div>

    <!-- 冲突列表（有冲突时才出现） -->
    <div v-if="app.syncConflicts.length" class="syncset__field">
      <label class="nm-label">待处理冲突（{{ app.syncConflicts.length }}）</label>
      <ul class="syncset__conflicts">
        <li v-for="c in app.syncConflicts" :key="c.docId" class="syncset__conflict">
          <span class="syncset__conflict-path">{{ c.path }}</span>
          <span class="syncset__conflict-actions">
            <button type="button" class="nm-btn nm-btn--sm" @click="app.resolveConflict(c.docId, 'local')">保留本地</button>
            <button type="button" class="nm-btn nm-btn--sm" @click="app.resolveConflict(c.docId, 'remote')">采用云端</button>
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.syncset {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.syncset--compact {
  gap: 10px;
}
.syncset__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.syncset__title {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}
.syncset__badge {
  font-size: 11px;
  font-weight: 500;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--bg-elevated, #f1f2f4);
  color: var(--fg-3, #8a8f99);
  border: 1px solid var(--border, rgba(15, 23, 42, 0.1));
}
.syncset__badge.is-ok {
  background: color-mix(in srgb, #16a34a 14%, transparent);
  color: #15803d;
  border-color: color-mix(in srgb, #16a34a 35%, transparent);
}
.syncset__actions {
  display: flex;
  gap: 8px;
  flex: none;
}
.syncset__notice {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.55;
  border-radius: 7px;
  color: #8a6d3b;
  background: rgba(250, 173, 20, 0.1);
}
.syncset__result {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.55;
  border-radius: 7px;
  word-break: break-word;
}
.syncset__result.is-ok {
  color: #15803d;
  background: rgba(22, 163, 74, 0.09);
}
.syncset__result.is-fail {
  color: #b42318;
  background: rgba(220, 38, 38, 0.08);
}
.syncset__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.syncset__seg {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.syncset__seg-item {
  padding: 5px 11px;
  font-size: 12px;
  border-radius: 999px;
  border: 1px solid var(--border, rgba(15, 23, 42, 0.12));
  background: var(--bg, #fff);
  color: var(--fg-2, #4b5058);
  cursor: pointer;
  transition: all 0.14s ease;
}
.syncset__seg-item:hover {
  border-color: color-mix(in srgb, var(--accent, #1677ff) 45%, transparent);
}
.syncset__seg-item.is-active {
  border-color: var(--accent, #1677ff);
  background: color-mix(in srgb, var(--accent, #1677ff) 10%, transparent);
  color: var(--accent, #1677ff);
  font-weight: 600;
}
.syncset__options {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
}
.syncset__opt {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 11px;
  text-align: left;
  border-radius: 9px;
  border: 1px solid var(--border, rgba(15, 23, 42, 0.1));
  background: var(--bg, #fff);
  cursor: pointer;
  transition: border-color 0.14s ease, background 0.14s ease;
}
.syncset__opt:hover {
  border-color: color-mix(in srgb, var(--accent, #1677ff) 45%, transparent);
}
.syncset__opt.is-active {
  border-color: var(--accent, #1677ff);
  background: color-mix(in srgb, var(--accent, #1677ff) 7%, transparent);
}
.syncset__opt-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg, #1f2329);
}
.syncset__opt-desc {
  font-size: 11px;
  line-height: 1.45;
  color: var(--fg-3, #8a8f99);
}
.syncset__log-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.syncset__logs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--border, rgba(15, 23, 42, 0.08));
  border-radius: 8px;
  padding: 6px 8px;
  background: var(--bg-elevated, #fbfbfc);
}
.syncset__log {
  display: flex;
  align-items: baseline;
  gap: 7px;
  font-size: 11.5px;
  line-height: 1.6;
}
.syncset__log-time {
  font-variant-numeric: tabular-nums;
  color: var(--fg-3, #8a8f99);
  flex: none;
}
.syncset__log-level {
  flex: none;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10px;
  background: var(--bg, #fff);
  border: 1px solid var(--border, rgba(15, 23, 42, 0.1));
  color: var(--fg-3, #8a8f99);
}
.syncset__log.is-error .syncset__log-level {
  color: #b42318;
  border-color: rgba(220, 38, 38, 0.35);
  background: rgba(220, 38, 38, 0.07);
}
.syncset__log.is-warn .syncset__log-level {
  color: #8a6d3b;
  border-color: rgba(250, 173, 20, 0.4);
  background: rgba(250, 173, 20, 0.09);
}
.syncset__log-msg {
  color: var(--fg-2, #4b5058);
  word-break: break-word;
}
.syncset__log-detail {
  color: var(--fg-3, #8a8f99);
  font-size: 11px;
  word-break: break-all;
}
.syncset__conflicts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.syncset__conflict {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 10px;
  border-radius: 7px;
  background: rgba(250, 173, 20, 0.1);
  font-size: 12px;
}
.syncset__conflict-path {
  word-break: break-all;
  color: var(--fg-2, #4b5058);
}
.syncset__conflict-actions {
  display: flex;
  gap: 6px;
  flex: none;
}
@media (max-width: 720px) {
  .syncset__options {
    grid-template-columns: 1fr;
  }
  .syncset__head {
    flex-direction: column;
  }
}
</style>
