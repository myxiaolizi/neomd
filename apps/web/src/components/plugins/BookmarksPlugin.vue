<script setup lang="ts">
import { computed, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { relativeTime } from '@neomd/shared';

export interface BookmarkItem {
  id: string;
  docId: string | null;
  title: string;
  groupName: string;
  createdAt: number;
}

const props = defineProps<{ items: BookmarkItem[] }>();
const emit = defineEmits<{ open: [string]; remove: [string] }>();

const groups = computed(() => {
  const map = new Map<string, BookmarkItem[]>();
  for (const it of props.items) {
    const list = map.get(it.groupName) ?? [];
    list.push(it);
    map.set(it.groupName, list);
  }
  return [...map.entries()];
});

const collapsed = ref<Set<string>>(new Set());
function toggle(g: string): void {
  const next = new Set(collapsed.value);
  if (next.has(g)) next.delete(g);
  else next.add(g);
  collapsed.value = next;
}
</script>

<template>
  <div class="bm">
    <p v-if="!items.length" class="bm__empty">还没有书签。用命令面板中的「收藏当前文档」添加。</p>
    <div v-for="[group, list] in groups" :key="group">
      <button class="bm__group" @click="toggle(group)">
        <NmIcon :name="collapsed.has(group) ? 'chevronRight' : 'chevronDown'" :size="11" />
        <span>{{ group }}</span>
        <span class="bm__count">{{ list.length }}</span>
      </button>
      <template v-if="!collapsed.has(group)">
        <div v-for="b in list" :key="b.id" class="bm-row">
          <button class="bm-row__main" @click="b.docId && emit('open', b.docId)">
            <NmIcon name="bookmark" :size="12" />
            <span class="bm-row__title">{{ b.title }}</span>
            <span class="bm-row__time">{{ relativeTime(b.createdAt) }}</span>
          </button>
          <button class="bm-row__del" title="移除书签" @click="emit('remove', b.id)">
            <NmIcon name="close" :size="11" />
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.bm {
  padding: 6px 4px 20px;
}
.bm__empty {
  padding: 14px 12px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--fg-3);
}
.bm__group {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--fg-3);
  text-transform: uppercase;
  text-align: left;
}
.bm__count {
  margin-left: auto;
  background: var(--bg-hover);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 10px;
}
.bm-row {
  display: flex;
  align-items: center;
  border-radius: 6px;
}
.bm-row:hover {
  background: var(--bg-hover);
}
.bm-row__main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  padding: 5px 10px 5px 16px;
  font-size: 12.5px;
  color: var(--fg-2);
  text-align: left;
}
.bm-row__title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bm-row__time {
  font-size: 10px;
  color: var(--fg-3);
}
.bm-row__del {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
  margin-right: 6px;
}
.bm-row__del:hover {
  color: #d93025;
  background: var(--bg-hover);
}
</style>
