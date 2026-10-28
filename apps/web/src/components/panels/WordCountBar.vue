<script setup lang="ts">
import { computed } from 'vue';
import { NmIcon } from '@neomd/ui';
import { formatCompactNumber, relativeTime } from '@neomd/shared';

const props = defineProps<{
  words: number;
  chars: number;
  path: string;
  docs: number;
  syncAt: number;
  outlineEnabled: boolean;
}>();

const emit = defineEmits<{ openOutline: []; openHistory: [] }>();

const readingMinutes = computed(() => Math.max(1, Math.round(props.words / 300)));
const syncLabel = computed(() => (props.syncAt ? relativeTime(props.syncAt) : '尚未同步'));
</script>

<template>
  <footer class="statusbar">
    <span class="statusbar__path" :title="path">{{ path || '未选择文档' }}</span>
    <span class="statusbar__spacer" />
    <button v-if="outlineEnabled" class="statusbar__btn" title="大纲" @click="emit('openOutline')">
      <NmIcon name="outline" :size="12" />
    </button>
    <span class="statusbar__item">
      <span class="statusbar__label">字数</span>
      <span class="statusbar__value">{{ formatCompactNumber(words) }}</span>
    </span>
    <span class="statusbar__item">
      <span class="statusbar__label">字符</span>
      <span class="statusbar__value">{{ formatCompactNumber(chars) }}</span>
    </span>
    <span class="statusbar__item">
      <span class="statusbar__label">阅读</span>
      <span class="statusbar__value">{{ readingMinutes }} 分钟</span>
    </span>
    <span class="statusbar__item statusbar__item--hide-sm">
      <span class="statusbar__label">仓库</span>
      <span class="statusbar__value">{{ formatCompactNumber(docs) }} 篇</span>
    </span>
    <button class="statusbar__btn statusbar__btn--sync" :title="`上次同步：${syncLabel}`" @click="emit('openHistory')">
      <NmIcon name="history" :size="12" />
      <span>{{ syncLabel }}</span>
    </button>
  </footer>
</template>

<style scoped>
.statusbar {
  display: flex;
  align-items: center;
  gap: 14px;
  height: var(--statusbar-h);
  padding: 0 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-sidebar);
  font-size: 11px;
  color: var(--fg-3);
  flex: 0 0 auto;
  overflow: hidden;
}
.statusbar__path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 38%;
}
.statusbar__spacer {
  flex: 1;
}
.statusbar__item {
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.statusbar__label {
  opacity: 0.8;
}
.statusbar__value {
  color: var(--fg-2);
  font-variant-numeric: tabular-nums;
}
.statusbar__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 6px;
  border-radius: 5px;
  color: var(--fg-3);
  white-space: nowrap;
}
.statusbar__btn:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
@media (max-width: 900px) {
  .statusbar__item--hide-sm {
    display: none;
  }
}
@media (max-width: 700px) {
  .statusbar__item:nth-of-type(n + 3) {
    display: none;
  }
  .statusbar__btn--sync span {
    display: none;
  }
}
</style>
