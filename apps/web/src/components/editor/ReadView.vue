<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { markdownToHtml } from '@neomd/core';

const props = defineProps<{
  modelValue: string;
  title?: string;
  fontSize?: number;
  lineHeight?: number;
}>();
const emit = defineEmits<{ ready: [] }>();

const host = ref<HTMLDivElement | null>(null);
const html = computed(() => markdownToHtml(props.modelValue, { externalTarget: '_blank', interactiveLinks: true }));

function paint(): void {
  if (host.value) host.value.innerHTML = html.value;
}

watch(html, paint);
onMounted(paint);

function scrollToRatio(ratio: number): void {
  const el = host.value?.parentElement;
  if (!el) return;
  const max = el.scrollHeight - el.clientHeight;
  if (max > 0) el.scrollTop = max * Math.max(0, Math.min(1, ratio));
}

function onClick(e: MouseEvent): void {
  const anchor = (e.target as HTMLElement | null)?.closest('a');
  if (!anchor) return;
  const href = anchor.getAttribute('href') ?? '';
  if (href.startsWith('neomd://wiki/')) {
    e.preventDefault();
    const rest = href.slice('neomd://wiki/'.length);
    const target = decodeURIComponent(rest.split('?')[0]?.split('#')[0] ?? '');
    window.dispatchEvent(new CustomEvent('neomd:open-wiki', { detail: target }));
    return;
  }
  if (/^https?:/.test(href)) {
    e.preventDefault();
    window.open(href, '_blank', 'noopener');
  }
}

defineExpose({ scrollToRatio });
emit('ready');
</script>

<template>
  <div
    class="read-view"
    :style="{
      ...(fontSize ? { '--content-font-size': `${fontSize}px` } : {}),
      ...(lineHeight ? { '--content-line-height': String(lineHeight) } : {}),
    }"
  >
    <slot name="title" />
    <article ref="host" class="nm-content read-view__body" @click="onClick" />
  </div>
</template>

<style scoped>
.read-view {
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.read-view__body {
  padding: 24px 0 160px;
  min-height: 100%;
}
.read-view:has(> .nm-titleline) .read-view__body {
  padding-top: 4px;
}
</style>
