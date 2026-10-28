<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { markdownToHtml } from '@neomd/core';
import SourceEditor from './SourceEditor.vue';

const props = defineProps<{ modelValue: string; fontSize?: number; lineHeight?: number }>();
const emit = defineEmits<{ 'update:modelValue': [string] }>();

const source = ref<HTMLDivElement | null>(null);
const preview = ref<HTMLDivElement | null>(null);
const html = computed(() => markdownToHtml(props.modelValue, { externalTarget: '_blank', interactiveLinks: true }));

function paint(): void {
  if (preview.value) preview.value.innerHTML = html.value;
}

watch(html, paint);
onMounted(paint);

let lock = false;
function syncFrom(src: HTMLElement, dst: HTMLElement | null): void {
  if (lock || !dst) return;
  const fromMax = src.scrollHeight - src.clientHeight;
  const toMax = dst.scrollHeight - dst.clientHeight;
  if (fromMax <= 0 || toMax <= 0) return;
  lock = true;
  dst.scrollTop = (src.scrollTop / fromMax) * toMax;
  setTimeout(() => {
    lock = false;
  }, 60);
}

function onPreviewScroll(e: Event): void {
  syncFrom(e.target as HTMLElement, source.value);
}

function scrollToRatio(ratio: number): void {
  if (!preview.value) return;
  const max = preview.value.scrollHeight - preview.value.clientHeight;
  preview.value.scrollTop = max * Math.max(0, Math.min(1, ratio));
}

defineExpose({ scrollToRatio });
</script>

<template>
  <div class="compare">
    <section class="compare__pane">
      <header class="compare__head">源码</header>
      <div class="compare__body">
        <SourceEditor
          :model-value="modelValue"
          :font-size="fontSize"
          :line-height="lineHeight"
          @update:model-value="emit('update:modelValue', $event)"
        />
      </div>
    </section>
    <section class="compare__pane">
      <header class="compare__head">预览</header>
      <div ref="preview" class="compare__body compare__body--preview nm-content" @scroll="onPreviewScroll" />
    </section>
  </div>
</template>

<style scoped>
.compare {
  display: grid;
  grid-template-columns: 1fr 1fr;
  height: 100%;
  min-height: 0;
}
.compare__pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--border);
}
.compare__pane:last-child {
  border-right: none;
}
.compare__head {
  height: 30px;
  display: flex;
  align-items: center;
  padding: 0 14px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fg-3);
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
  flex: 0 0 auto;
}
.compare__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
.compare__body--preview {
  overflow-y: auto;
  padding: 22px 28px 120px;
}
@media (max-width: 900px) {
  .compare {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
  }
  .compare__pane {
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
}
</style>
