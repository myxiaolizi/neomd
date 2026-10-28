<script setup lang="ts">
/**
 * 后台 · 运营概览（1.1.9 从 AdminPage.vue 拆出）。
 *
 * 只做「一眼看全站」的指标卡与注册趋势，不做任何写操作。
 * 数据自取（`/api/admin/stats`），不依赖父组件传参 —— 拆分后每个模块
 * 都能独立挂载/刷新，父组件只负责装配，避免一个大 loadTab switch 继续膨胀。
 */
import { computed, onMounted, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { adminApi, type AdminStats } from '@/api/client';
import { formatBytes, formatCompactNumber } from '@neomd/shared';

const emit = defineEmits<{ fail: [string] }>();

/** 后端 /api/admin/stats 在 AdminStats 之外还多回几块可选字段 */
type StatsPayload = AdminStats & {
  credits?: { circulating: number; consumedToday: number; rechargedToday: number };
  backups?: { total: number; bytes: number };
  aiPlatform?: { enabledProviders: number };
};

const EMPTY: StatsPayload = {
  users: { total: 0, active: 0, disabled: 0, admins: 0, newToday: 0, newThisWeek: 0 },
  shares: { total: 0, active: 0, views: 0 },
  publishes: { total: 0, active: 0 },
  comments: { total: 0, hidden: 0 },
  storage: { bytes: 0, documents: 0, vaults: 0 },
  ai: { requests24h: 0, inTokens24h: 0, outTokens24h: 0 },
  signupsDaily: [],
  uptimeSeconds: 0,
};

const stats = ref<StatsPayload>(EMPTY);
const loading = ref(false);

/** 注册趋势柱状图的最大值（至少为 1，避免除零） */
const maxDaily = computed(() => Math.max(1, ...stats.value.signupsDaily.map((d) => d.count)));

async function load(): Promise<void> {
  loading.value = true;
  try {
    stats.value = (await adminApi.stats()) as StatsPayload;
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
defineExpose({ reload: load });
</script>

<template>
  <div class="ov">
    <header class="adm-page-head">
      <div>
        <h2>运营概览</h2>
        <p>全站累计指标与近 14 天注册趋势。需要更细的 AI 与成本分析请到「AI 运营分析」，需要时间窗口对比请到「数据看板」。</p>
      </div>
      <div class="adm-page-actions">
        <button class="nm-btn nm-btn--sm" :disabled="loading" @click="load">
          <NmIcon name="refresh" :size="13" />{{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </header>

    <div class="adm-metric-grid">
      <article class="adm-metric">
        <span class="adm-metric__label">用户总数</span>
        <span class="adm-metric__value">{{ formatCompactNumber(stats.users.total) }}</span>
        <span class="adm-metric__sub">今日新增 <b>{{ stats.users.newToday }}</b> · 禁用 <b>{{ stats.users.disabled }}</b></span>
      </article>
      <article class="adm-metric">
        <span class="adm-metric__label">分享链接</span>
        <span class="adm-metric__value">{{ formatCompactNumber(stats.shares.total) }}</span>
        <span class="adm-metric__sub">有效 <b>{{ stats.shares.active }}</b> · 浏览 {{ formatCompactNumber(stats.shares.views) }}</span>
      </article>
      <article class="adm-metric">
        <span class="adm-metric__label">发布页面</span>
        <span class="adm-metric__value">{{ formatCompactNumber(stats.publishes.total) }}</span>
        <span class="adm-metric__sub">在线 <b>{{ stats.publishes.active }}</b></span>
      </article>
      <article class="adm-metric">
        <span class="adm-metric__label">内容评价</span>
        <span class="adm-metric__value">{{ formatCompactNumber(stats.comments.total) }}</span>
        <span class="adm-metric__sub">已隐藏 <b>{{ stats.comments.hidden }}</b></span>
      </article>
      <article class="adm-metric">
        <span class="adm-metric__label">流通积分</span>
        <span class="adm-metric__value">{{ formatCompactNumber(stats.credits?.circulating ?? 0) }}</span>
        <span class="adm-metric__sub">今日消耗 <b>{{ stats.credits?.consumedToday ?? 0 }}</b></span>
      </article>
      <article class="adm-metric">
        <span class="adm-metric__label">云端备份</span>
        <span class="adm-metric__value">{{ formatCompactNumber(stats.backups?.total ?? 0) }}</span>
        <span class="adm-metric__sub">{{ formatBytes(stats.backups?.bytes ?? 0) }}</span>
      </article>
      <article class="adm-metric">
        <span class="adm-metric__label">平台 AI 渠道</span>
        <span class="adm-metric__value">{{ stats.aiPlatform?.enabledProviders ?? 0 }}</span>
        <span class="adm-metric__sub">已启用代付的供应商</span>
      </article>
      <article class="adm-metric">
        <span class="adm-metric__label">存储占用</span>
        <span class="adm-metric__value">{{ formatBytes(stats.storage.bytes) }}</span>
        <span class="adm-metric__sub">{{ formatCompactNumber(stats.storage.documents) }} 篇文档</span>
      </article>
    </div>

    <section class="adm-card" style="margin-top: 22px;">
      <div class="adm-card__head">
        <div>
          <h3 class="adm-card__title">近 14 天注册趋势</h3>
          <p class="adm-card__sub">柱高按当日新增用户数归一化</p>
        </div>
        <span class="adm-badge adm-badge--accent">本周新增 {{ stats.users.newThisWeek }}</span>
      </div>
      <div class="adm-card__body">
        <div class="spark">
          <span
            v-for="d in stats.signupsDaily"
            :key="d.date"
            class="spark__bar"
            :style="{ height: `${Math.max(4, (d.count / maxDaily) * 100)}%` }"
            :title="`${d.date}：${d.count} 人`"
          />
        </div>
        <div class="spark__axis">
          <span v-if="stats.signupsDaily.length">{{ stats.signupsDaily[0]?.date }}</span>
          <span v-if="stats.signupsDaily.length">{{ stats.signupsDaily[stats.signupsDaily.length - 1]?.date }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.spark {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 120px;
  margin-top: 4px;
}
.spark__bar {
  flex: 1;
  min-width: 4px;
  border-radius: 3px 3px 0 0;
  background: linear-gradient(180deg, #1677ff, rgba(22, 119, 255, 0.3));
  transition: opacity 0.14s ease;
}
.spark__bar:hover { opacity: 0.75; }
.spark__axis {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 11px;
  color: #9aa1ab;
  font-family: var(--font-mono, ui-monospace, Consolas, monospace);
}
</style>
