<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NmIcon } from '@neomd/ui';

export interface GraphNode {
  id: string;
  label: string;
  group: string;
  degree: number;
}
export interface GraphEdge {
  source: string;
  target: string;
}

const props = defineProps<{ nodes: GraphNode[]; edges: GraphEdge[]; activeId?: string }>();
const emit = defineEmits<{ open: [string] }>();

const canvas = ref<HTMLCanvasElement | null>(null);
const localMode = ref(false);
const showLabels = ref(true);
const zoom = ref(1);
const hoverId = ref<string | null>(null);

interface Sim {
  id: string;
  label: string;
  group: string;
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

let sims: Sim[] = [];
let raf = 0;
let ctx: CanvasRenderingContext2D | null = null;

const visible = computed(() => {
  if (!localMode.value || !props.activeId) return props.nodes;
  const keep = new Set<string>([props.activeId]);
  for (const e of props.edges) {
    if (e.source === props.activeId) keep.add(e.target);
    if (e.target === props.activeId) keep.add(e.source);
  }
  return props.nodes.filter((n) => keep.has(n.id));
});

function rebuild(): void {
  const ids = new Set(visible.value.map((n) => n.id));
  const w = canvas.value?.clientWidth ?? 300;
  const h = canvas.value?.clientHeight ?? 400;
  sims = visible.value.map((n, i) => {
    const angle = (i / Math.max(1, visible.value.length)) * Math.PI * 2;
    const radius = Math.min(w, h) * 0.32;
    return {
      id: n.id,
      label: n.label,
      group: n.group,
      degree: n.degree,
      x: w / 2 + Math.cos(angle) * radius + (Math.random() - 0.5) * 12,
      y: h / 2 + Math.sin(angle) * radius + (Math.random() - 0.5) * 12,
      vx: 0,
      vy: 0,
    };
  });
  void ids;
}

function step(): void {
  const w = canvas.value?.clientWidth ?? 300;
  const h = canvas.value?.clientHeight ?? 400;
  const byId = new Map(sims.map((s) => [s.id, s]));
  // 斥力
  for (let i = 0; i < sims.length; i += 1) {
    for (let j = i + 1; j < sims.length; j += 1) {
      const a = sims[i]!;
      const b = sims[j]!;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        dx = Math.random() - 0.5;
        dy = Math.random() - 0.5;
        d2 = 1;
      }
      const dist = Math.sqrt(d2);
      const force = 900 / d2;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }
  // 引力
  for (const e of props.edges) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const force = (dist - 70) * 0.008;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }
  // 向心 + 阻尼
  for (const s of sims) {
    s.vx += (w / 2 - s.x) * 0.0022;
    s.vy += (h / 2 - s.y) * 0.0022;
    s.vx *= 0.82;
    s.vy *= 0.82;
    s.x += s.vx;
    s.y += s.vy;
    s.x = Math.max(18, Math.min(w - 18, s.x));
    s.y = Math.max(18, Math.min(h - 18, s.y));
  }
}

function draw(): void {
  const el = canvas.value;
  if (!el || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = el.clientWidth;
  const h = el.clientHeight;
  if (el.width !== w * dpr || el.height !== h * dpr) {
    el.width = w * dpr;
    el.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const byId = new Map(sims.map((s) => [s.id, s]));

  ctx.strokeStyle = 'rgba(140,150,165,0.28)';
  ctx.lineWidth = 1;
  for (const e of props.edges) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) continue;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  for (const s of sims) {
    const r = 4 + Math.min(8, s.degree * 1.1);
    const isActive = s.id === props.activeId;
    const isHover = s.id === hoverId.value;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fillStyle = isActive || isHover ? '#1677FF' : 'rgba(22,119,255,0.55)';
    ctx.fill();
    if (isActive) {
      ctx.strokeStyle = '#1677FF';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (showLabels.value && (isActive || isHover || s.degree > 1 || sims.length < 40)) {
      ctx.fillStyle = 'rgba(90,100,112,0.95)';
      ctx.font = '10.5px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const label = s.label.length > 12 ? `${s.label.slice(0, 12)}…` : s.label;
      ctx.fillText(label, s.x, s.y + r + 11);
    }
  }
}

function loop(): void {
  step();
  draw();
  raf = requestAnimationFrame(loop);
}

function onMove(e: MouseEvent): void {
  const el = canvas.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  let found: Sim | null = null;
  for (const s of sims) {
    if (Math.hypot(s.x - x, s.y - y) < 12) {
      found = s;
      break;
    }
  }
  hoverId.value = found?.id ?? null;
  el.style.cursor = found ? 'pointer' : 'default';
}

function onClick(): void {
  if (hoverId.value) emit('open', hoverId.value);
}

function zoomIn(): void {
  zoom.value = Math.min(2, zoom.value + 0.15);
}
function zoomOut(): void {
  zoom.value = Math.max(0.5, zoom.value - 0.15);
}

watch([() => props.nodes, () => props.edges, localMode], () => {
  rebuild();
});

onMounted(() => {
  if (canvas.value) ctx = canvas.value.getContext('2d');
  rebuild();
  raf = requestAnimationFrame(loop);
});

onBeforeUnmount(() => cancelAnimationFrame(raf));
</script>

<template>
  <div class="graph">
    <div class="graph__bar">
      <button class="gbtn" :class="{ 'is-on': localMode }" title="局部视图" @click="localMode = !localMode">
        <NmIcon name="filter" :size="13" />
      </button>
      <button class="gbtn" :class="{ 'is-on': showLabels }" title="显示标签" @click="showLabels = !showLabels">
        <NmIcon name="type" :size="13" />
      </button>
      <span class="graph__count">{{ visible.length }} 节点 · {{ edges.length }} 连线</span>
      <button class="gbtn" title="缩小" @click="zoomOut"><NmIcon name="minus" :size="13" /></button>
      <button class="gbtn" title="放大" @click="zoomIn"><NmIcon name="plus" :size="13" /></button>
    </div>
    <div class="graph__canvas-wrap" :style="{ transform: `scale(${zoom})` }">
      <canvas ref="canvas" class="graph__canvas" @mousemove="onMove" @click="onClick" />
    </div>
    <p v-if="!nodes.length" class="graph__empty">仓库里还没有笔记，创建几篇并用 [[双链]] 连接后会出现在这里。</p>
  </div>
</template>

<style scoped>
.graph {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.graph__bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
.gbtn {
  width: 24px;
  height: 24px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
}
.gbtn:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.gbtn.is-on {
  background: var(--accent-weak);
  color: var(--accent);
}
.graph__count {
  flex: 1;
  text-align: center;
  font-size: 10.5px;
  color: var(--fg-3);
}
.graph__canvas-wrap {
  flex: 1 1 auto;
  min-height: 0;
  transform-origin: center;
  transition: transform 0.16s ease;
}
.graph__canvas {
  width: 100%;
  height: 100%;
  display: block;
}
.graph__empty {
  padding: 16px 12px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--fg-3);
}
</style>
