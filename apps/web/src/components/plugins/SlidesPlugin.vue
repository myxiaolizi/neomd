<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { parseDoc } from '@neomd/core';

const props = defineProps<{ content: string; title: string }>();

const slides = computed(() => {
  const parts = props.content.split(/^---$/m).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) return parts;
  // 没有分隔线时按二级标题切分
  const doc = parseDoc(props.content);
  const h2 = doc.headings.filter((h) => h.level === 2);
  if (!h2.length) return [props.content];
  const out: string[] = [];
  h2.forEach((h, i) => {
    const end = h2[i + 1]?.offset ?? props.content.length;
    out.push(props.content.slice(h.offset, end).trim());
  });
  return out;
});

const index = ref(0);
const fullscreen = ref(false);

function next(): void {
  index.value = Math.min(slides.value.length - 1, index.value + 1);
}
function prev(): void {
  index.value = Math.max(0, index.value - 1);
}

function renderSlide(md: string): string {
  // 轻量渲染：标题、列表、段落、代码
  const lines = md.split('\n');
  const html: string[] = [];
  let inCode = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      html.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      html.push(escape(line));
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      html.push(`<h${Math.min(4, h[1]!.length)}>${inline(h[2]!)}</h${Math.min(4, h[1]!.length)}>`);
      continue;
    }
    const li = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (li) {
      html.push(`<li>${inline(li[1]!)}</li>`);
      continue;
    }
    if (!line.trim()) continue;
    html.push(`<p>${inline(line)}</p>`);
  }
  let out = html.join('\n').replace(/(<li>[\s\S]*?<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  if (inCode) out += '</code></pre>';
  return out;
}

function inline(s: string): string {
  return escape(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowRight' || e.key === ' ') next();
  else if (e.key === 'ArrowLeft') prev();
  else if (e.key === 'Escape') fullscreen.value = false;
}

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="slides" :class="{ 'is-fullscreen': fullscreen }">
    <div class="slides__bar">
      <span class="slides__count">{{ index + 1 }} / {{ slides.length }}</span>
      <button class="tool" :class="{ 'is-on': fullscreen }" title="全屏演示" @click="fullscreen = !fullscreen">
        <NmIcon name="slides" :size="14" />
      </button>
    </div>
    <div class="slides__stage">
      <article class="slide" v-html="renderSlide(slides[index] ?? '')" />
    </div>
    <div class="slides__nav">
      <button class="nav" :disabled="index === 0" @click="prev"><NmIcon name="chevronLeft" :size="15" /></button>
      <div class="dots">
        <button
          v-for="(_, i) in slides"
          :key="i"
          class="dot"
          :class="{ 'is-on': i === index }"
          @click="index = i"
        />
      </div>
      <button class="nav" :disabled="index === slides.length - 1" @click="next">
        <NmIcon name="chevronRight" :size="15" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.slides {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.slides.is-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 9600;
  background: var(--bg-elevated);
  padding: 16px;
}
.slides__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
.slides__count {
  flex: 1;
  font-size: 11px;
  color: var(--fg-3);
  font-family: var(--font-mono);
}
.tool {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--fg-2);
}
.tool:hover {
  background: var(--bg-hover);
}
.tool.is-on {
  background: var(--accent-weak);
  color: var(--accent);
}
.slides__stage {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  place-items: center;
  padding: 18px;
  overflow: auto;
}
.slide {
  width: 100%;
  max-width: 720px;
  padding: 32px 34px;
  border-radius: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-2);
  font-size: 15px;
  line-height: 1.8;
  aspect-ratio: 16 / 9;
  overflow: auto;
}
.slide :deep(h1) {
  font-size: 26px;
  margin: 0 0 16px;
  border-bottom: 2px solid var(--accent);
  padding-bottom: 8px;
}
.slide :deep(h2) {
  font-size: 21px;
  margin: 0 0 14px;
}
.slide :deep(h3) {
  font-size: 17px;
  margin: 12px 0 10px;
}
.slide :deep(p) {
  margin: 0 0 10px;
  color: var(--fg-2);
}
.slide :deep(ul) {
  padding-left: 20px;
  color: var(--fg-2);
}
.slide :deep(li) {
  margin: 5px 0;
}
.slide :deep(code) {
  font-family: var(--font-mono);
  background: var(--bg-hover);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.92em;
}
.slide :deep(pre) {
  background: var(--bg-hover);
  padding: 12px 14px;
  border-radius: 8px;
  overflow: auto;
}
.slides__nav {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-top: 1px solid var(--border);
  flex: 0 0 auto;
}
.nav {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--fg-2);
}
.nav:hover:not(:disabled) {
  background: var(--bg-hover);
}
.nav:disabled {
  opacity: 0.35;
}
.dots {
  flex: 1;
  display: flex;
  gap: 4px;
  justify-content: center;
  flex-wrap: wrap;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--border-strong);
}
.dot.is-on {
  background: var(--accent);
  transform: scale(1.3);
}
</style>
