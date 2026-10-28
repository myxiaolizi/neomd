<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NmIcon } from '@neomd/ui';

/** 白板：无限画布，支持手绘、矩形、椭圆、文本、连线与图片，保存为 .board JSON */
export interface BoardShape {
  id: string;
  type: 'rect' | 'ellipse' | 'text' | 'draw' | 'line' | 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  text?: string;
  points?: Array<[number, number]>;
  src?: string;
}

const props = defineProps<{ modelValue: string; name: string }>();
const emit = defineEmits<{ 'update:modelValue': [string]; save: [] }>();

const host = ref<HTMLDivElement | null>(null);
const shapes = ref<BoardShape[]>([]);
const tool = ref<'select' | 'rect' | 'ellipse' | 'text' | 'draw' | 'line'>('select');
const color = ref('#1677FF');
const selectedId = ref<string | null>(null);
const scale = ref(1);
const offset = ref({ x: 0, y: 0 });

const drawing = ref<{ x: number; y: number; id: string } | null>(null);
const panning = ref<{ x: number; y: number; ox: number; oy: number } | null>(null);
const dragging = ref<{ id: string; px: number; py: number } | null>(null);

const COLORS = ['#1677FF', '#0E9F6E', '#FF8A3D', '#E5484D', '#7C4DFF', '#1A1D21'];

function load(raw: string): void {
  try {
    const data = JSON.parse(raw || '{}') as { shapes?: BoardShape[] };
    shapes.value = Array.isArray(data.shapes) ? data.shapes : [];
  } catch {
    shapes.value = [];
  }
}

function persist(): void {
  emit('update:modelValue', JSON.stringify({ version: 1, shapes: shapes.value }));
}

watch(() => props.modelValue, (v) => {
  if (!v) {
    shapes.value = [];
    return;
  }
  try {
    const cur = JSON.stringify({ version: 1, shapes: shapes.value });
    if (cur !== v) load(v);
  } catch {
    load(v);
  }
}, { immediate: true });

function localPoint(e: MouseEvent): { x: number; y: number } {
  const rect = host.value?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };
  return {
    x: (e.clientX - rect.left - offset.value.x) / scale.value,
    y: (e.clientY - rect.top - offset.value.y) / scale.value,
  };
}

const textInput = ref<{ open: boolean; x: number; y: number; value: string }>({ open: false, x: 0, y: 0, value: '' });
const textEl = ref<HTMLInputElement | null>(null);

async function commitText(): Promise<void> {
  const t = textInput.value.value.trim();
  if (!t) {
    textInput.value = { ...textInput.value, open: false };
    return;
  }
  const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  shapes.value.push({
    id,
    type: 'text',
    x: textInput.value.x,
    y: textInput.value.y,
    w: Math.max(80, t.length * 14),
    h: 28,
    color: color.value,
    text: t,
  });
  textInput.value = { ...textInput.value, open: false, value: '' };
  persist();
  emit('save');
}

function onDown(e: MouseEvent): void {
  if (e.button === 1 || (e.button === 0 && e.altKey)) {
    panning.value = { x: e.clientX, y: e.clientY, ox: offset.value.x, oy: offset.value.y };
    return;
  }
  const p = localPoint(e);
  const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  if (tool.value === 'select') {
    const hit = [...shapes.value].reverse().find(
      (s) => p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h,
    );
    selectedId.value = hit?.id ?? null;
    if (hit) dragging.value = { id: hit.id, px: p.x, py: p.y };
    return;
  }

  if (tool.value === 'text') {
    textInput.value = { open: true, x: p.x, y: p.y, value: '' };
    void nextTick(() => textEl.value?.focus());
    return;
  }

  if (tool.value === 'draw') {
    shapes.value.push({ id, type: 'draw', x: p.x, y: p.y, w: 0, h: 0, color: color.value, points: [[0, 0]] });
    drawing.value = { x: p.x, y: p.y, id };
    return;
  }

  shapes.value.push({
    id,
    type: tool.value,
    x: p.x,
    y: p.y,
    w: 0,
    h: 0,
    color: color.value,
  });
  drawing.value = { x: p.x, y: p.y, id };
}

function onMove(e: MouseEvent): void {
  if (panning.value) {
    offset.value = {
      x: panning.value.ox + (e.clientX - panning.value.x),
      y: panning.value.oy + (e.clientY - panning.value.y),
    };
    return;
  }
  if (dragging.value) {
    const p = localPoint(e);
    const s = shapes.value.find((x) => x.id === dragging.value!.id);
    if (s) {
      s.x += p.x - dragging.value.px;
      s.y += p.y - dragging.value.py;
      dragging.value.px = p.x;
      dragging.value.py = p.y;
    }
    return;
  }
  if (!drawing.value) return;
  const s = shapes.value.find((x) => x.id === drawing.value!.id);
  if (!s) return;
  const p = localPoint(e);
  if (s.type === 'draw') {
    s.points = s.points ?? [];
    s.points.push([p.x - drawing.value.x, p.y - drawing.value.y]);
    s.w = Math.max(s.w, p.x - s.x);
    s.h = Math.max(s.h, p.y - s.y);
  } else {
    s.w = p.x - s.x;
    s.h = p.y - s.y;
  }
}

function onUp(): void {
  if (drawing.value) {
    const s = shapes.value.find((x) => x.id === drawing.value!.id);
    if (s && (s.type === 'rect' || s.type === 'ellipse' || s.type === 'line')) {
      if (s.w < 4 && s.h < 4) shapes.value = shapes.value.filter((x) => x.id !== s.id);
      else {
        if (s.w < 0) {
          s.x += s.w;
          s.w = Math.abs(s.w);
        }
        if (s.h < 0) {
          s.y += s.h;
          s.h = Math.abs(s.h);
        }
      }
    }
    drawing.value = null;
    persist();
    emit('save');
  }
  dragging.value = null;
  panning.value = null;
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  const next = e.deltaY > 0 ? scale.value / 1.1 : scale.value * 1.1;
  scale.value = Math.max(0.3, Math.min(3, next));
}

function onKey(e: KeyboardEvent): void {
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId.value) {
    shapes.value = shapes.value.filter((s) => s.id !== selectedId.value);
    selectedId.value = null;
    persist();
    emit('save');
  }
}

function removeSelected(): void {
  if (!selectedId.value) return;
  shapes.value = shapes.value.filter((s) => s.id !== selectedId.value);
  selectedId.value = null;
  persist();
  emit('save');
}

function exportPng(): void {
  const el = host.value;
  if (!el) return;
  const svg = renderSvg();
  const img = new Image();
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = 1000;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((b) => {
        if (!b) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = `${props.name}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      });
    }
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

function renderSvg(): string {
  const parts: string[] = [];
  for (const s of shapes.value) {
    if (s.type === 'rect') {
      parts.push(
        `<rect x="${s.x}" y="${s.y}" width="${Math.abs(s.w)}" height="${Math.abs(s.h)}" rx="6" fill="none" stroke="${s.color}" stroke-width="2"/>`,
      );
    } else if (s.type === 'ellipse') {
      parts.push(
        `<ellipse cx="${s.x + s.w / 2}" cy="${s.y + s.h / 2}" rx="${Math.abs(s.w / 2)}" ry="${Math.abs(s.h / 2)}" fill="none" stroke="${s.color}" stroke-width="2"/>`,
      );
    } else if (s.type === 'text') {
      parts.push(
        `<text x="${s.x}" y="${s.y + 18}" font-family="system-ui" font-size="16" fill="${s.color}">${escapeXml(s.text ?? '')}</text>`,
      );
    } else if (s.type === 'draw' && s.points?.length) {
      const d = s.points.map(([dx, dy], i) => `${i === 0 ? 'M' : 'L'}${s.x + dx},${s.y + dy}`).join(' ');
      parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linecap="round"/>`);
    } else if (s.type === 'line') {
      parts.push(
        `<line x1="${s.x}" y1="${s.y}" x2="${s.x + s.w}" y2="${s.y + s.h}" stroke="${s.color}" stroke-width="2"/>`,
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000"><rect width="1600" height="1000" fill="#ffffff"/>${parts.join('')}</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const shapeCount = computed(() => shapes.value.length);

onMounted(() => {
  window.addEventListener('keydown', onKey);
  void nextTick();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="board">
    <div class="board__tools">
      <button
        v-for="t in (['select', 'rect', 'ellipse', 'line', 'draw', 'text'] as const)"
        :key="t"
        class="tool"
        :class="{ 'is-on': tool === t }"
        :title="t === 'select' ? '选择' : t === 'rect' ? '矩形' : t === 'ellipse' ? '椭圆' : t === 'line' ? '连线' : t === 'draw' ? '画笔' : '文本'"
        @click="tool = t"
      >
        <NmIcon
          :name="t === 'select' ? 'drag' : t === 'rect' ? 'layout' : t === 'ellipse' ? 'globe' : t === 'line' ? 'link' : t === 'draw' ? 'edit' : 'type'"
          :size="14"
        />
      </button>
      <span class="board__sep" />
      <button v-for="c in COLORS" :key="c" class="swatch" :style="{ background: c }" :class="{ 'is-on': color === c }" @click="color = c" />
      <span class="board__sep" />
      <button class="tool" title="删除选中" @click="removeSelected"><NmIcon name="trash" :size="14" /></button>
      <button class="tool" title="导出 PNG" @click="exportPng"><NmIcon name="download" :size="14" /></button>
      <span class="board__count">{{ shapeCount }} 个元素</span>
    </div>
    <div
      ref="host"
      class="board__canvas"
      @mousedown="onDown"
      @mousemove="onMove"
      @mouseup="onUp"
      @mouseleave="onUp"
      @wheel="onWheel"
    >
      <div v-if="textInput.open" class="board__text-input" :style="{ left: `${textInput.x * scale + offset.x}px`, top: `${textInput.y * scale + offset.y}px` }">
        <input
          ref="textEl"
          v-model="textInput.value"
          placeholder="输入文本后回车"
          @keydown.enter.prevent="commitText"
          @keydown.esc.prevent="textInput.open = false"
          @blur="commitText"
        />
      </div>
      <div class="board__layer" :style="{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }">
        <svg class="board__svg">
          <g v-for="s in shapes" :key="s.id">
            <rect
              v-if="s.type === 'rect'"
              :x="s.x"
              :y="s.y"
              :width="Math.abs(s.w)"
              :height="Math.abs(s.h)"
              rx="6"
              fill="none"
              :stroke="s.color"
              stroke-width="2"
              :class="{ 'is-selected': selectedId === s.id }"
            />
            <ellipse
              v-else-if="s.type === 'ellipse'"
              :cx="s.x + s.w / 2"
              :cy="s.y + s.h / 2"
              :rx="Math.abs(s.w / 2)"
              :ry="Math.abs(s.h / 2)"
              fill="none"
              :stroke="s.color"
              stroke-width="2"
              :class="{ 'is-selected': selectedId === s.id }"
            />
            <path
              v-else-if="s.type === 'draw' && s.points"
              :d="s.points.map(([dx, dy], i) => `${i === 0 ? 'M' : 'L'}${s.x + dx},${s.y + dy}`).join(' ')"
              fill="none"
              :stroke="s.color"
              stroke-width="2"
              stroke-linecap="round"
            />
            <line
              v-else-if="s.type === 'line'"
              :x1="s.x"
              :y1="s.y"
              :x2="s.x + s.w"
              :y2="s.y + s.h"
              :stroke="s.color"
              stroke-width="2"
            />
            <text
              v-else-if="s.type === 'text'"
              :x="s.x"
              :y="s.y + 18"
              font-size="16"
              :fill="s.color"
              class="board__text"
            >
              {{ s.text }}
            </text>
          </g>
        </svg>
      </div>
    </div>
  </div>
</template>

<style scoped>
.board {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.board__tools {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
  flex-wrap: wrap;
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
  color: var(--fg);
}
.tool.is-on {
  background: var(--accent-weak);
  color: var(--accent);
}
.swatch {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid transparent;
}
.swatch.is-on {
  border-color: var(--fg);
}
.board__sep {
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 4px;
}
.board__count {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--fg-3);
}
.board__canvas {
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
  overflow: hidden;
  background:
    radial-gradient(circle, rgba(140, 150, 165, 0.22) 1px, transparent 1px) 0 0 / 20px 20px,
    var(--bg);
  cursor: crosshair;
}
.board__layer {
  position: absolute;
  inset: 0;
  transform-origin: 0 0;
}
.board__svg {
  width: 100%;
  height: 100%;
  overflow: visible;
}
.board__text {
  font-family: system-ui, sans-serif;
  user-select: none;
}
.is-selected {
  stroke-dasharray: 5 4;
  stroke-width: 2.5;
}
.board__text-input {
  position: absolute;
  z-index: 5;
  transform: translateY(-4px);
}
.board__text-input input {
  min-width: 160px;
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--accent);
  background: var(--bg-elevated);
  color: var(--fg);
  font-size: 13px;
  outline: none;
  box-shadow: var(--shadow-2);
}
</style>
