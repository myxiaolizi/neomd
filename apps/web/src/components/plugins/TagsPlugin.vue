<script setup lang="ts">
import { computed, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { formatCompactNumber } from '@neomd/shared';

export interface TagGroup {
  tag: string;
  docs: Array<{ docId: string; title: string; path: string }>;
}

const props = defineProps<{ groups: TagGroup[] }>();
const emit = defineEmits<{ open: [string] }>();

const filter = ref('');
const expanded = ref<Set<string>>(new Set());

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return props.groups;
  return props.groups.filter((g) => g.tag.toLowerCase().includes(q));
});

const tree = computed(() => {
  const map = new Map<string, { name: string; full: string; count: number; children: string[] }>();
  for (const g of filtered.value) {
    const parts = g.tag.split('/');
    let acc = '';
    parts.forEach((p, i) => {
      acc = acc ? `${acc}/${p}` : p;
      const node = map.get(acc) ?? { name: p, full: acc, count: 0, children: [] };
      if (i === parts.length - 1) node.count = g.docs.length;
      map.set(acc, node);
    });
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
});

function toggle(tag: string): void {
  const next = new Set(expanded.value);
  if (next.has(tag)) next.delete(tag);
  else next.add(tag);
  expanded.value = next;
}

function docsOf(tag: string): Array<{ docId: string; title: string; path: string }> {
  return props.groups.find((g) => g.tag === tag)?.docs ?? [];
}
</script>

<template>
  <div class="tags">
    <div class="tags__search">
      <NmIcon name="search" :size="13" />
      <input v-model="filter" placeholder="筛选标签" />
    </div>
    <p v-if="!tree.length" class="tags__empty">还没有标签。在正文里输入 #标签 即可自动收录。</p>
    <div v-for="t in tree" :key="t.full">
      <button class="tag-row" @click="toggle(t.full)">
        <NmIcon :name="expanded.has(t.full) ? 'chevronDown' : 'chevronRight'" :size="11" />
        <NmIcon name="tag" :size="12" />
        <span class="tag-row__name">{{ t.name }}</span>
        <span class="tag-row__count">{{ formatCompactNumber(t.count) }}</span>
      </button>
      <template v-if="expanded.has(t.full)">
        <button v-for="d in docsOf(t.full)" :key="d.docId" class="tag-doc" @click="emit('open', d.docId)">
          <NmIcon name="file" :size="12" />
          <span>{{ d.title }}</span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tags {
  padding: 4px 4px 20px;
}
.tags__search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  margin: 4px 6px 8px;
  padding: 0 8px;
  border-radius: 7px;
  background: var(--bg-hover);
  color: var(--fg-3);
}
.tags__search input {
  flex: 1;
  border: none;
  background: none;
  outline: none;
  font-size: 12px;
  color: var(--fg);
  min-width: 0;
}
.tags__empty {
  padding: 14px 12px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--fg-3);
}
.tag-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--fg-2);
  text-align: left;
}
.tag-row:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.tag-row__name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag-row__count {
  font-size: 10.5px;
  color: var(--fg-3);
  background: var(--bg-hover);
  padding: 1px 5px;
  border-radius: 4px;
}
.tag-doc {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 10px 4px 30px;
  font-size: 12px;
  color: var(--fg-3);
  text-align: left;
}
.tag-doc:hover {
  color: var(--accent);
}
.tag-doc span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
