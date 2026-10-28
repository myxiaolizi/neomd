<script setup lang="ts">
import { computed } from 'vue';
import { NmIcon } from '@neomd/ui';

export interface CountItem {
  label: string;
  value: string;
}

defineProps<{ items: CountItem[]; path: string }>();
</script>

<template>
  <footer class="statusbar">
    <span class="statusbar__path" :title="path">{{ path || '未选择文档' }}</span>
    <span class="statusbar__spacer" />
    <span v-for="it in items" :key="it.label" class="statusbar__item">
      <span class="statusbar__label">{{ it.label }}</span>
      <span class="statusbar__value">{{ it.value }}</span>
    </span>
  </footer>
</template>

<style scoped>
.statusbar {
  display: flex;
  align-items: center;
  gap: 16px;
  height: var(--statusbar-h);
  padding: 0 14px;
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
  max-width: 40%;
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
@media (max-width: 760px) {
  .statusbar__item:nth-child(n + 3) {
    display: none;
  }
}
</style>
