<script setup lang="ts">
import { computed } from 'vue';
import { NmIcon } from '@neomd/ui';
import { parseDoc } from '@neomd/core';

const props = defineProps<{ content: string; title: string }>();
const emit = defineEmits<{ jump: [number] }>();

const headings = computed(() => parseDoc(props.content).headings);
const minLevel = computed(() => Math.min(...headings.value.map((h) => h.level), 6));
</script>

<template>
  <div class="outline">
    <div v-if="!headings.length" class="outline__empty">这篇文档还没有标题。用 Ctrl+1 到 Ctrl+6 快速设置层级。</div>
    <button
      v-for="(h, i) in headings"
      :key="`${h.offset}-${i}`"
      class="outline__item"
      :class="`lv${h.level}`"
      :style="{ paddingLeft: `${10 + (h.level - minLevel) * 14}px` }"
      @click="emit('jump', h.offset)"
    >
      <span class="outline__dot" />
      <span class="outline__text">{{ h.text || '（空标题）' }}</span>
    </button>
  </div>
</template>

<style scoped>
.outline {
  padding: 6px 4px 20px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.outline__item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--fg-2);
  text-align: left;
  line-height: 1.5;
}
.outline__item:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.outline__dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--fg-3);
  flex: 0 0 auto;
}
.outline__item.lv1 {
  font-weight: 650;
  color: var(--fg);
}
.outline__item.lv1 .outline__dot {
  width: 6px;
  height: 6px;
  background: var(--accent);
}
.outline__item.lv2 {
  font-weight: 550;
}
.outline__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.outline__empty {
  padding: 16px 12px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--fg-3);
}
</style>
