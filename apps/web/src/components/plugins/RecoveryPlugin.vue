<script setup lang="ts">
import { computed } from 'vue';
import { NmIcon } from '@neomd/ui';
import { formatBytes, relativeTime } from '@neomd/shared';

export interface SnapshotItem {
  path: string;
  size: number;
  mtime: number;
}

const props = defineProps<{ snapshots: SnapshotItem[]; loading?: boolean }>();
const emit = defineEmits<{ restore: [string]; create: []; remove: [string] }>();

const total = computed(() => props.snapshots.reduce((s, x) => s + x.size, 0));
</script>

<template>
  <div class="recovery">
    <div class="recovery__head">
      <div class="recovery__title">
        <NmIcon name="restore" :size="14" />
        <span>仓库快照</span>
      </div>
      <button class="nm-btn nm-btn--sm" @click="emit('create')">
        <NmIcon name="plus" :size="12" />
        立即快照
      </button>
    </div>
    <p class="nm-hint">
      快照记录整个仓库的当前内容，可用于误删恢复或整体回滚。共 {{ snapshots.length }} 份，占用 {{ formatBytes(total) }}。
    </p>
    <p v-if="loading" class="recovery__empty">加载中…</p>
    <p v-else-if="!snapshots.length" class="recovery__empty">还没有快照。建议在对仓库做批量操作前先创建一份。</p>
    <div v-for="s in snapshots" :key="s.path" class="snap">
      <div class="snap__body">
        <span class="snap__time">{{ relativeTime(s.mtime) }}</span>
        <span class="snap__meta">{{ formatBytes(s.size) }}</span>
      </div>
      <button class="snap__btn" title="恢复此快照" @click="emit('restore', s.path)">
        <NmIcon name="restore" :size="12" />
      </button>
      <button class="snap__btn snap__btn--danger" title="删除" @click="emit('remove', s.path)">
        <NmIcon name="trash" :size="12" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.recovery {
  padding: 10px 10px 20px;
}
.recovery__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.recovery__title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 650;
  color: var(--fg);
}
.recovery__empty {
  font-size: 12px;
  line-height: 1.7;
  color: var(--fg-3);
  padding: 10px 2px;
}
.snap {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 7px 8px;
  border-radius: 7px;
  border: 1px solid var(--border);
  margin-bottom: 5px;
  background: var(--bg-elevated);
}
.snap__body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.snap__time {
  font-size: 12px;
  color: var(--fg);
}
.snap__meta {
  font-size: 10.5px;
  color: var(--fg-3);
}
.snap__btn {
  width: 24px;
  height: 24px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
}
.snap__btn:hover {
  background: var(--bg-hover);
  color: var(--accent);
}
.snap__btn--danger:hover {
  color: #d93025;
}
</style>
