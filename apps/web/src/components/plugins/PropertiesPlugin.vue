<script setup lang="ts">
import { computed, ref } from 'vue';
import { NmIcon } from '@neomd/ui';

export interface PropertyGroup {
  key: string;
  kind: string;
  docs: number;
  values: string[];
}

const props = defineProps<{ properties: PropertyGroup[] }>();
const emit = defineEmits<{ open: [string]; openKey: [string] }>();

const view = ref<'flow' | 'table'>('flow');
const filter = ref('');

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return props.properties;
  return props.properties.filter((p) => p.key.toLowerCase().includes(q));
});
</script>

<template>
  <div class="props">
    <div class="props__bar">
      <div class="seg seg--sm">
        <button class="seg__item" :class="{ 'is-active': view === 'flow' }" @click="view = 'flow'">清单</button>
        <button class="seg__item" :class="{ 'is-active': view === 'table' }" @click="view = 'table'">表格</button>
      </div>
    </div>
    <div class="props__search">
      <NmIcon name="search" :size="13" />
      <input v-model="filter" placeholder="筛选属性" />
    </div>
    <p v-if="!filtered.length" class="props__empty">
      还没有 frontmatter 属性。在文档顶部用 <code>---</code> 包裹的 YAML 区块定义属性。
    </p>
    <table v-else-if="view === 'table'" class="props__table">
      <thead>
        <tr>
          <th>属性</th>
          <th>类型</th>
          <th>文档数</th>
          <th>示例值</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in filtered" :key="p.key" @click="emit('openKey', p.key)">
          <td class="mono">{{ p.key }}</td>
          <td>{{ p.kind }}</td>
          <td>{{ p.docs }}</td>
          <td class="props__values">{{ p.values.slice(0, 3).join(' · ') }}</td>
        </tr>
      </tbody>
    </table>
    <template v-else>
      <div v-for="p in filtered" :key="p.key" class="prop-card">
        <div class="prop-card__head">
          <span class="prop-card__key">{{ p.key }}</span>
          <span class="prop-card__kind">{{ p.kind }}</span>
          <span class="prop-card__docs">{{ p.docs }}</span>
        </div>
        <div class="prop-card__values">
          <span v-for="v in p.values.slice(0, 8)" :key="v" class="val">{{ v || '（空）' }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.props {
  padding: 6px 4px 20px;
}
.props__bar {
  padding: 2px 8px 8px;
}
.seg {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: 7px;
  background: var(--bg-hover);
  border: 1px solid var(--border);
}
.seg__item {
  padding: 4px 10px;
  border-radius: 5px;
  font-size: 11.5px;
  color: var(--fg-2);
}
.seg__item.is-active {
  background: var(--bg-elevated);
  color: var(--accent);
  font-weight: 600;
  box-shadow: var(--shadow-1);
}
.props__search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  margin: 0 8px 8px;
  padding: 0 8px;
  border-radius: 7px;
  background: var(--bg-hover);
  color: var(--fg-3);
}
.props__search input {
  flex: 1;
  border: none;
  background: none;
  outline: none;
  font-size: 12px;
  color: var(--fg);
  min-width: 0;
}
.props__empty {
  padding: 14px 12px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--fg-3);
}
.props__empty code {
  font-family: var(--font-mono);
  background: var(--bg-hover);
  padding: 1px 4px;
  border-radius: 3px;
}
.props__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
  margin: 0 8px;
  width: calc(100% - 16px);
}
.props__table th,
.props__table td {
  border-bottom: 1px solid var(--border);
  padding: 6px 6px;
  text-align: left;
  vertical-align: top;
}
.props__table th {
  color: var(--fg-3);
  font-weight: 600;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.props__table tbody tr {
  cursor: pointer;
}
.props__table tbody tr:hover {
  background: var(--bg-hover);
}
.mono {
  font-family: var(--font-mono);
  color: var(--accent);
}
.props__values {
  color: var(--fg-3);
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prop-card {
  margin: 0 8px 6px;
  padding: 9px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
}
.prop-card__head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.prop-card__key {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--accent);
  font-weight: 600;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prop-card__kind {
  font-size: 9.5px;
  color: var(--fg-3);
  background: var(--bg-hover);
  padding: 1px 5px;
  border-radius: 3px;
}
.prop-card__docs {
  font-size: 10px;
  color: var(--fg-3);
}
.prop-card__values {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.val {
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--accent-weak-2);
  color: var(--fg-2);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
