<script setup lang="ts">
/**
 * 流程图编辑器（1.1.0）—— 页面布局对齐 ProcessOn。
 *
 * 四段式结构：
 * ```
 * ┌──────────────────────────────────────────────────────┐
 * │ 顶部工具栏 48px（撤销/重做、缩放、网格、对齐、分布、导出）│
 * ├────────┬────────────────────────────┬───────────────┤
 * │图形库   │        画布                 │  属性面板       │
 * │200px    │     (DiagramCanvas)         │  280px         │
 * ├────────┴────────────────────────────┴───────────────┤
 * │ 底部状态栏 28px（坐标、缩放、节点数、小地图）            │
 * └──────────────────────────────────────────────────────┘
 * ```
 *
 * 文件格式：`.flow`（JSON，`DiagramDoc`）。
 * 组件对外是 `v-model:content`（字符串），便于直接接到标签页的 content 上。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NmIcon } from '@neomd/ui';
import type { DiagramDoc, DiagramNode, DiagramNodeShape, DiagramEdge, DiagramArrow, DiagramLineStyle } from '@neomd/shared';
import {
  alignNodes,
  createEmptyDoc,
  createEdge,
  createNode,
  distributeNodes,
  exportToPng,
  exportToSvg,
  parseDiagramDoc,
  serializeDiagramDoc,
} from '@neomd/core';
import DiagramCanvas from './DiagramCanvas.vue';
import { SHAPE_LIBRARY, DEFAULT_NODE_FILL, DEFAULT_NODE_STROKE, DEFAULT_EDGE_STROKE } from './shapes';

const props = defineProps<{ modelValue: string; title?: string }>();
const emit = defineEmits<{ 'update:modelValue': [string]; save: [] }>();

/* ------------------------------ 文档状态 ------------------------------ */

/** 解析外部内容；坏数据回落到空文档，避免编辑器打不开 */
function parse(raw: string): DiagramDoc {
  return parseDiagramDoc(raw, 'flowchart') ?? createEmptyDoc('flowchart', undefined, props.title ?? '未命名流程图');
}

const doc = ref<DiagramDoc>(parse(props.modelValue));
/** 来自画布的选择（存 id 列表，节点与连线共用） */
const selection = ref<string[]>([]);
const canvasRef = ref<InstanceType<typeof DiagramCanvas> | null>(null);
const zoomLabel = ref(100);
const pointer = ref({ x: 0, y: 0 });
const showMinimap = ref(true);
/** 右侧属性面板的页签 */
const propTab = ref<'style' | 'edge' | 'canvas'>('style');
const notice = ref('');

/* ------------------------------ 撤销重做 ------------------------------ */

/**
 * 本地历史栈。画布是受控组件，所有变更都经 `update:doc` 回来，
 * 因此在这里统一记录历史最可靠（不会漏记拖动/缩放等中间态由画布自行合并）。
 */
interface HistoryEntry { doc: DiagramDoc; at: number }
const history = ref<HistoryEntry[]>([]);
const future = ref<HistoryEntry[]>([]);
const MAX_HISTORY = 50;
/** 避免「应用历史」时再次入栈 */
let applyingHistory = false;

watch(
  () => doc.value,
  (next, prev) => {
    if (applyingHistory) return;
    if (!prev) return;
    // 仅在结构或坐标发生实质变化时入栈，避免 hover 之类的噪声
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    history.value = [...history.value.slice(-(MAX_HISTORY - 1)), { doc: prev, at: Date.now() }];
    future.value = [];
    scheduleSave();
  },
);

function undo(): void {
  const last = history.value[history.value.length - 1];
  if (!last) return;
  history.value = history.value.slice(0, -1);
  future.value = [{ doc: doc.value, at: Date.now() }, ...future.value];
  applyingHistory = true;
  doc.value = last.doc;
  applyingHistory = false;
  scheduleSave();
}

function redo(): void {
  const next = future.value[0];
  if (!next) return;
  future.value = future.value.slice(1);
  history.value = [...history.value, { doc: doc.value, at: Date.now() }];
  applyingHistory = true;
  doc.value = next.doc;
  applyingHistory = false;
  scheduleSave();
}

/* ------------------------------ 持久化 ------------------------------ */

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** 变更后 debounce 800ms 写回父组件（父组件负责落盘与同步） */
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    emit('update:modelValue', serializeDiagramDoc(doc.value));
  }, 800);
}

watch(
  () => props.modelValue,
  (raw) => {
    if (saveTimer) return; // 本地有待写入的改动时，忽略外部回流，避免打断编辑
    const next = parse(raw);
    if (serializeDiagramDoc(next) !== serializeDiagramDoc(doc.value)) {
      applyingHistory = true;
      doc.value = next;
      applyingHistory = false;
    }
  },
);

/* ------------------------------ 选择与属性 ------------------------------ */

const selectedNode = computed<DiagramNode | null>(() => {
  if (selection.value.length !== 1) return null;
  return doc.value.nodes.find((n) => n.id === selection.value[0]) ?? null;
});
const selectedEdge = computed<DiagramEdge | null>(() => {
  if (selection.value.length !== 1) return null;
  return doc.value.edges.find((e) => e.id === selection.value[0]) ?? null;
});

/** 更新选中节点（多个时批量应用同一属性） */
function patchNode(patch: Partial<DiagramNode>): void {
  if (!selection.value.length) return;
  const ids = new Set(selection.value);
  doc.value = {
    ...doc.value,
    nodes: doc.value.nodes.map((n) => (ids.has(n.id) ? { ...n, ...patch } : n)),
    updatedAt: Date.now(),
  };
}

/** 更新选中连线 */
function patchEdge(patch: Partial<DiagramEdge>): void {
  const edge = selectedEdge.value;
  if (!edge) return;
  doc.value = {
    ...doc.value,
    edges: doc.value.edges.map((e) => (e.id === edge.id ? { ...e, ...patch } : e)),
    updatedAt: Date.now(),
  };
}

/* ------------------------------ 图形库 ------------------------------ */

const collapsedGroups = ref<Record<string, boolean>>({});

function toggleGroup(id: string): void {
  collapsedGroups.value = { ...collapsedGroups.value, [id]: !collapsedGroups.value[id] };
}

/** 拖拽图形库项到画布：用 HTML5 DnD 传形状类型 */
function onShapeDragStart(e: DragEvent, shape: DiagramNodeShape): void {
  e.dataTransfer?.setData('text/plain', `shape:${shape}`);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
}

/** 计算拖拽落点在画布内的世界坐标（近似：以画布中心为锚点时更稳，这里用落点相对画布的偏移） */
function onCanvasDrop(e: DragEvent): void {
  const raw = e.dataTransfer?.getData('text/plain') ?? '';
  if (!raw.startsWith('shape:')) return;
  const shape = raw.slice(6) as DiagramNodeShape;
  const canvasEl = (e.currentTarget as HTMLElement).querySelector('svg');
  const rect = canvasEl?.getBoundingClientRect();
  if (!rect) return;
  // 简化换算：把屏幕落点当作世界落点（画布初始 zoom=1、offset 由 fitView 决定，
  // 这里用画布当前视口反推，保证「拖到哪就落在哪」）
  const vp = canvasRef.value;
  // defineExpose 暴露的 ref 在父组件侧会被自动解包，因此直接读数值而不是 .value
  const z = vp?.zoom ?? 1;
  const off = vp?.offset ?? { x: 0, y: 0 };
  const wx = (e.clientX - rect.left - off.x) / z;
  const wy = (e.clientY - rect.top - off.y) / z;
  const node = createNode(shape, wx, wy, { nodeFill: DEFAULT_NODE_FILL, nodeStroke: DEFAULT_NODE_STROKE });
  doc.value = { ...doc.value, nodes: [...doc.value.nodes, node], updatedAt: Date.now() };
  selection.value = [node.id];
  flash(`已添加「${node.text}」节点`);
}

/** 点击图形库也能添加（拖不动时的兜底） */
function addShapeAtCenter(shape: DiagramNodeShape): void {
  const node = createNode(shape, 240, 160, { nodeFill: DEFAULT_NODE_FILL, nodeStroke: DEFAULT_NODE_STROKE });
  doc.value = { ...doc.value, nodes: [...doc.value.nodes, node], updatedAt: Date.now() };
  selection.value = [node.id];
  flash(`已添加「${node.text}」节点`);
}

/* ------------------------------ 工具栏动作 ------------------------------ */

function flash(msg: string): void {
  notice.value = msg;
  setTimeout(() => {
    if (notice.value === msg) notice.value = '';
  }, 2200);
}

/** 删除选中（节点或连线） */
function deleteSelection(): void {
  const ids = new Set(selection.value);
  if (!ids.size) return;
  doc.value = {
    ...doc.value,
    nodes: doc.value.nodes.filter((n) => !ids.has(n.id)),
    edges: doc.value.edges.filter(
      (e) => !ids.has(e.id) && !(e.from && ids.has(e.from)) && !(e.to && ids.has(e.to)),
    ),
    updatedAt: Date.now(),
  };
  selection.value = [];
}

function doAlign(mode: 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom'): void {
  if (selection.value.length < 2) {
    flash('请先选中至少 2 个节点');
    return;
  }
  doc.value = {
    ...doc.value,
    nodes: alignNodes(doc.value.nodes, selection.value, mode),
    updatedAt: Date.now(),
  };
}

function doDistribute(axis: 'horizontal' | 'vertical'): void {
  if (selection.value.length < 3) {
    flash('等距分布需要至少 3 个节点');
    return;
  }
  doc.value = {
    ...doc.value,
    nodes: distributeNodes(doc.value.nodes, selection.value, axis),
    updatedAt: Date.now(),
  };
}

/** 层级调整：把选中节点移到数组末尾（置顶）或开头（置底） */
function changeOrder(mode: 'front' | 'back' | 'up' | 'down'): void {
  const ids = new Set(selection.value);
  if (!ids.size) return;
  const nodes = [...doc.value.nodes];
  const picked = nodes.filter((n) => ids.has(n.id));
  const rest = nodes.filter((n) => !ids.has(n.id));
  let next: DiagramNode[];
  if (mode === 'front') next = [...rest, ...picked];
  else if (mode === 'back') next = [...picked, ...rest];
  else {
    // up/down 在数组内相邻交换
    next = nodes;
    for (let i = 0; i < next.length; i += 1) {
      if (!ids.has(next[i]!.id)) continue;
      const j = mode === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= next.length || ids.has(next[j]!.id)) continue;
      [next[i], next[j]] = [next[j]!, next[i]!];
    }
  }
  doc.value = { ...doc.value, nodes: next, updatedAt: Date.now() };
}

function toggleGrid(): void {
  doc.value = {
    ...doc.value,
    canvas: { ...doc.value.canvas, showGrid: !doc.value.canvas.showGrid },
    updatedAt: Date.now(),
  };
}

function toggleSnap(): void {
  doc.value = {
    ...doc.value,
    canvas: { ...doc.value.canvas, snapToGrid: !doc.value.canvas.snapToGrid },
    updatedAt: Date.now(),
  };
}

function fitView(): void {
  canvasRef.value?.fitView();
}
function zoomIn(): void {
  canvasRef.value?.setZoom((canvasRef.value?.zoom ?? 1) * 1.2);
}
function zoomOut(): void {
  canvasRef.value?.setZoom((canvasRef.value?.zoom ?? 1) / 1.2);
}
function zoomReset(): void {
  canvasRef.value?.setZoom(1);
}

/* ------------------------------ 导出 ------------------------------ */

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const exportOpen = ref(false);
const exporting = ref(false);

async function doExport(kind: 'svg' | 'png' | 'json'): Promise<void> {
  exportOpen.value = false;
  const base = (props.title ?? doc.value.title ?? 'flowchart').replace(/\.(flow|mind)$/i, '');
  try {
    exporting.value = true;
    if (kind === 'svg') {
      download(new Blob([exportToSvg(doc.value, { padding: 40, title: base })], { type: 'image/svg+xml' }), `${base}.svg`);
      flash('已导出 SVG');
    } else if (kind === 'png') {
      // PNG 依赖浏览器 Image/canvas；失败时降级提示导出 SVG
      const blob = await exportToPng(doc.value, 2, { padding: 40 });
      download(blob, `${base}.png`);
      flash('已导出 PNG');
    } else {
      download(new Blob([JSON.stringify(doc.value, null, 2)], { type: 'application/json' }), `${base}.flow`);
      flash('已导出 JSON');
    }
  } catch (e) {
    flash(`导出失败：${(e as Error).message}（可改用 SVG）`);
  } finally {
    exporting.value = false;
  }
}

/* ------------------------------ 快捷键 ------------------------------ */

function onKeyDown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
    return;
  }
  if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
    e.preventDefault();
    redo();
    return;
  }
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    emit('update:modelValue', serializeDiagramDoc(doc.value));
    emit('save');
    flash('已保存');
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    // 避免在输入框里删字符时误删节点
    const t = e.target as HTMLElement | null;
    if (t && /INPUT|TEXTAREA/.test(t.tagName)) return;
    if (selection.value.length) {
      e.preventDefault();
      deleteSelection();
    }
    return;
  }
  // Tab / Enter 快捷建节点（ProcessOn 习惯）
  if ((e.key === 'Tab' || e.key === 'Enter') && selectedNode.value) {
    const t = e.target as HTMLElement | null;
    if (t && /INPUT|TEXTAREA/.test(t.tagName)) return;
    e.preventDefault();
    const parent = selectedNode.value;
    const child = createNode('rect', parent.x + parent.w + 90, parent.y + parent.h / 2, {
      nodeFill: DEFAULT_NODE_FILL,
      nodeStroke: DEFAULT_NODE_STROKE,
    });
    doc.value = {
      ...doc.value,
      nodes: [...doc.value.nodes, child],
      edges: [...doc.value.edges, createEdge(parent.id, child.id)],
      updatedAt: Date.now(),
    };
    selection.value = [child.id];
  }
}

/* ------------------------------ 小地图 ------------------------------ */

const minimapBox = computed(() => {
  const nodes = doc.value.nodes;
  if (!nodes.length) return { w: 0, h: 0, items: [] as Array<{ x: number; y: number; w: number; h: number }> };
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.w));
  const maxY = Math.max(...nodes.map((n) => n.y + n.h));
  return {
    w: maxX - minX || 1,
    h: maxY - minY || 1,
    items: nodes.map((n) => ({ x: n.x - minX, y: n.y - minY, w: n.w, h: n.h })),
  };
});

const statusText = computed(() => {
  const kind = selection.value.length === 1 ? (selectedNode.value ? '节点' : selectedEdge.value ? '连线' : '') : '';
  return `节点 ${doc.value.nodes.length} · 连线 ${doc.value.edges.length}${kind ? ` · 选中${kind}` : ''}`;
});

onMounted(() => {
  window.addEventListener('keydown', onKeyDown);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown);
  if (saveTimer) clearTimeout(saveTimer);
});
</script>

<template>
  <div class="flow">
    <!-- ============ 顶部工具栏 48px ============ -->
    <header class="flow__toolbar">
      <div class="flow__tool-group">
        <button class="flow__tool" :disabled="!history.length" title="撤销 Ctrl+Z" @click="undo">
          <NmIcon name="restore" :size="15" />
        </button>
        <button class="flow__tool" :disabled="!future.length" title="重做 Ctrl+Shift+Z" @click="redo">
          <NmIcon name="refresh" :size="15" />
        </button>
      </div>

      <span class="flow__sep" />

      <div class="flow__tool-group">
        <button class="flow__tool" title="缩小" @click="zoomOut"><NmIcon name="minus" :size="15" /></button>
        <span class="flow__zoom">{{ zoomLabel }}%</span>
        <button class="flow__tool" title="放大" @click="zoomIn"><NmIcon name="plus" :size="15" /></button>
        <button class="flow__tool flow__tool--text" title="适应画布" @click="fitView">适应</button>
        <button class="flow__tool flow__tool--text" title="恢复 100%" @click="zoomReset">100%</button>
      </div>

      <span class="flow__sep" />

      <div class="flow__tool-group">
        <button class="flow__tool" :class="{ 'is-on': doc.canvas.showGrid }" title="显示/隐藏网格" @click="toggleGrid">
          <NmIcon name="layout" :size="15" />
        </button>
        <button class="flow__tool" :class="{ 'is-on': doc.canvas.snapToGrid }" title="吸附网格" @click="toggleSnap">
          <NmIcon name="check" :size="15" />
        </button>
      </div>

      <span class="flow__sep" />

      <div class="flow__tool-group">
        <button class="flow__tool" title="左对齐" @click="doAlign('left')"><NmIcon name="sidebar" :size="15" /></button>
        <button class="flow__tool" title="水平居中" @click="doAlign('centerH')"><NmIcon name="minus" :size="15" /></button>
        <button class="flow__tool" title="右对齐" @click="doAlign('right')"><NmIcon name="sidebar" :size="15" /></button>
        <button class="flow__tool" title="顶对齐" @click="doAlign('top')"><NmIcon name="layout" :size="15" /></button>
        <button class="flow__tool" title="垂直居中" @click="doAlign('centerV')"><NmIcon name="menu" :size="15" /></button>
        <button class="flow__tool" title="底对齐" @click="doAlign('bottom')"><NmIcon name="layout" :size="15" /></button>
      </div>

      <span class="flow__sep" />

      <div class="flow__tool-group">
        <button class="flow__tool flow__tool--text" title="水平等距分布" @click="doDistribute('horizontal')">水平分布</button>
        <button class="flow__tool flow__tool--text" title="垂直等距分布" @click="doDistribute('vertical')">垂直分布</button>
      </div>

      <span class="flow__sep" />

      <div class="flow__tool-group">
        <button class="flow__tool flow__tool--text" title="置顶" @click="changeOrder('front')">置顶</button>
        <button class="flow__tool flow__tool--text" title="置底" @click="changeOrder('back')">置底</button>
      </div>

      <div class="flow__spacer" />

      <button class="flow__tool" title="删除选中 Delete" @click="deleteSelection">
        <NmIcon name="trash" :size="15" />
      </button>

      <div class="flow__dropdown">
        <button class="flow__tool flow__tool--text flow__tool--primary" :disabled="exporting" @click="exportOpen = !exportOpen">
          <NmIcon name="download" :size="14" />
          {{ exporting ? '导出中…' : '导出' }}
        </button>
        <div v-if="exportOpen" class="flow__menu" @mousedown.stop>
          <button class="flow__menu-item" @click="doExport('svg')">导出 SVG（矢量，推荐）</button>
          <button class="flow__menu-item" @click="doExport('png')">导出 PNG（2 倍图）</button>
          <button class="flow__menu-item" @click="doExport('json')">导出 JSON（.flow 源文件）</button>
        </div>
      </div>
    </header>

    <div class="flow__body">
      <!-- ============ 左侧图形库 200px ============ -->
      <aside class="flow__lib">
        <div v-for="g in SHAPE_LIBRARY" :key="g.id" class="lib-group">
          <button class="lib-group__head" @click="toggleGroup(g.id)">
            <NmIcon :name="collapsedGroups[g.id] ? 'chevronRight' : 'chevronDown'" :size="12" />
            <span>{{ g.label }}</span>
          </button>
          <div v-if="!collapsedGroups[g.id]" class="lib-group__grid">
            <button
              v-for="item in g.items"
              :key="item.shape"
              class="lib-item"
              :title="`${item.label}（拖到画布，或点击直接添加）`"
              draggable="true"
              @dragstart="onShapeDragStart($event, item.shape)"
              @click="addShapeAtCenter(item.shape)"
            >
              <svg viewBox="0 0 44 30" class="lib-item__preview">
                <rect x="2" y="4" width="40" height="22" rx="3" fill="none" stroke="currentColor" stroke-width="1.2" />
                <text x="22" y="19" text-anchor="middle" font-size="10" fill="currentColor">{{ item.label.slice(0, 2) }}</text>
              </svg>
              <span class="lib-item__label">{{ item.label }}</span>
            </button>
          </div>
        </div>
      </aside>

      <!-- ============ 画布 ============ -->
      <div class="flow__canvas" @dragover.prevent @drop.prevent="onCanvasDrop">
        <DiagramCanvas
          ref="canvasRef"
          :doc="doc"
          @update:doc="(d) => (doc = d)"
          @selection-change="(ids) => (selection = ids)"
          @viewport-change="(v) => (zoomLabel = Math.round(v.zoom * 100))"
        />

        <!-- 小地图 -->
        <div v-if="showMinimap && minimapBox.items.length" class="flow__minimap" title="小地图（点击可切换显示）">
          <svg :viewBox="`-4 -4 ${minimapBox.w + 8} ${minimapBox.h + 8}`">
            <rect
              v-for="(it, i) in minimapBox.items"
              :key="i"
              :x="it.x"
              :y="it.y"
              :width="it.w"
              :height="it.h"
              rx="2"
              fill="rgba(22,119,255,.35)"
              stroke="#1677ff"
              stroke-width="1"
            />
          </svg>
        </div>

        <div v-if="notice" class="flow__notice">{{ notice }}</div>
      </div>

      <!-- ============ 右侧属性面板 280px ============ -->
      <aside class="flow__props">
        <nav class="props__tabs">
          <button class="props__tab" :class="{ 'is-on': propTab === 'style' }" @click="propTab = 'style'">样式</button>
          <button class="props__tab" :class="{ 'is-on': propTab === 'edge' }" @click="propTab = 'edge'">连线</button>
          <button class="props__tab" :class="{ 'is-on': propTab === 'canvas' }" @click="propTab = 'canvas'">画布</button>
        </nav>

        <!-- 样式：选中节点时 -->
        <div v-if="propTab === 'style'" class="props__body nm-scroll">
          <template v-if="selectedNode">
            <div class="props__title">节点样式</div>
            <div class="props__row2">
              <label>X<input class="nm-input" type="number" :value="Math.round(selectedNode.x)" @change="patchNode({ x: Number(($event.target as HTMLInputElement).value) })" /></label>
              <label>Y<input class="nm-input" type="number" :value="Math.round(selectedNode.y)" @change="patchNode({ y: Number(($event.target as HTMLInputElement).value) })" /></label>
            </div>
            <div class="props__row2">
              <label>宽<input class="nm-input" type="number" min="24" :value="Math.round(selectedNode.w)" @change="patchNode({ w: Number(($event.target as HTMLInputElement).value) })" /></label>
              <label>高<input class="nm-input" type="number" min="24" :value="Math.round(selectedNode.h)" @change="patchNode({ h: Number(($event.target as HTMLInputElement).value) })" /></label>
            </div>
            <div class="props__row2">
              <label>填充<input class="nm-input nm-input--color" type="color" :value="selectedNode.fill ?? DEFAULT_NODE_FILL" @input="patchNode({ fill: ($event.target as HTMLInputElement).value })" /></label>
              <label>描边<input class="nm-input nm-input--color" type="color" :value="selectedNode.stroke ?? DEFAULT_NODE_STROKE" @input="patchNode({ stroke: ($event.target as HTMLInputElement).value })" /></label>
            </div>
            <div class="props__row2">
              <label>文字<input class="nm-input nm-input--color" type="color" :value="selectedNode.color ?? '#1a1d21'" @input="patchNode({ color: ($event.target as HTMLInputElement).value })" /></label>
              <label>字号<input class="nm-input" type="number" min="8" max="48" :value="selectedNode.fontSize ?? 13" @change="patchNode({ fontSize: Number(($event.target as HTMLInputElement).value) })" /></label>
            </div>
            <div class="props__row">
              <button class="props__toggle" :class="{ 'is-on': selectedNode.bold }" @click="patchNode({ bold: !selectedNode.bold })">加粗</button>
              <button class="props__toggle" :class="{ 'is-on': selectedNode.italic }" @click="patchNode({ italic: !selectedNode.italic })">斜体</button>
            </div>
            <div class="props__title">文本</div>
            <textarea
              class="nm-input props__text"
              rows="3"
              :value="selectedNode.text"
              placeholder="节点文字（支持换行）"
              @input="patchNode({ text: ($event.target as HTMLTextAreaElement).value })"
            />
          </template>
          <p v-else class="props__empty">选中一个节点以编辑样式</p>
        </div>

        <!-- 连线：选中连线时 -->
        <div v-else-if="propTab === 'edge'" class="props__body nm-scroll">
          <template v-if="selectedEdge">
            <div class="props__title">连线样式</div>
            <label class="props__field">标签
              <input class="nm-input" :value="selectedEdge.label ?? ''" placeholder="例如：是 / 否" @input="patchEdge({ label: ($event.target as HTMLInputElement).value })" />
            </label>
            <div class="props__row2">
              <label>起点箭头
                <select class="nm-input" :value="selectedEdge.startArrow ?? 'none'" @change="patchEdge({ startArrow: ($event.target as HTMLSelectElement).value as DiagramArrow })">
                  <option value="none">无</option><option value="arrow">箭头</option><option value="triangle">三角</option><option value="circle">圆点</option><option value="diamond">菱形</option>
                </select>
              </label>
              <label>终点箭头
                <select class="nm-input" :value="selectedEdge.endArrow ?? 'arrow'" @change="patchEdge({ endArrow: ($event.target as HTMLSelectElement).value as DiagramArrow })">
                  <option value="none">无</option><option value="arrow">箭头</option><option value="triangle">三角</option><option value="circle">圆点</option><option value="diamond">菱形</option>
                </select>
              </label>
            </div>
            <div class="props__row2">
              <label>线型
                <select class="nm-input" :value="selectedEdge.lineStyle ?? 'solid'" @change="patchEdge({ lineStyle: ($event.target as HTMLSelectElement).value as DiagramLineStyle })">
                  <option value="solid">实线</option><option value="dashed">虚线</option><option value="dotted">点线</option>
                </select>
              </label>
              <label>线宽<input class="nm-input" type="number" min="1" max="8" step="0.5" :value="selectedEdge.lineWidth ?? 1.5" @change="patchEdge({ lineWidth: Number(($event.target as HTMLInputElement).value) })" /></label>
            </div>
            <div class="props__row2">
              <label>颜色<input class="nm-input nm-input--color" type="color" :value="selectedEdge.stroke ?? DEFAULT_EDGE_STROKE" @input="patchEdge({ stroke: ($event.target as HTMLInputElement).value })" /></label>
              <label>曲线<button class="props__toggle" :class="{ 'is-on': selectedEdge.curved !== false }" @click="patchEdge({ curved: selectedEdge.curved === false })">{{ selectedEdge.curved === false ? '折线' : '曲线' }}</button></label>
            </div>
          </template>
          <p v-else class="props__empty">选中一条连线以编辑样式</p>
        </div>

        <!-- 画布设置 -->
        <div v-else class="props__body nm-scroll">
          <div class="props__title">画布</div>
          <label class="props__field">背景色
            <input class="nm-input nm-input--color" type="color" :value="doc.canvas.background" @input="doc = { ...doc, canvas: { ...doc.canvas, background: ($event.target as HTMLInputElement).value } }" />
          </label>
          <label class="props__field">网格样式
            <select class="nm-input" :value="doc.canvas.grid" @change="doc = { ...doc, canvas: { ...doc.canvas, grid: ($event.target as HTMLSelectElement).value as 'none' | 'dot' | 'line' } }">
              <option value="none">无</option><option value="dot">点阵</option><option value="line">线格</option>
            </select>
          </label>
          <label class="props__field">网格大小
            <input class="nm-input" type="number" min="4" max="100" :value="doc.canvas.gridSize" @change="doc = { ...doc, canvas: { ...doc.canvas, gridSize: Number(($event.target as HTMLInputElement).value) } }" />
          </label>
          <div class="props__row">
            <button class="props__toggle" :class="{ 'is-on': doc.canvas.showGrid }" @click="toggleGrid">显示网格</button>
            <button class="props__toggle" :class="{ 'is-on': doc.canvas.snapToGrid }" @click="toggleSnap">吸附网格</button>
          </div>
          <div class="props__row">
            <button class="props__toggle" :class="{ 'is-on': showMinimap }" @click="showMinimap = !showMinimap">小地图</button>
          </div>
        </div>
      </aside>
    </div>

    <!-- ============ 底部状态栏 28px ============ -->
    <footer class="flow__status">
      <span>坐标 {{ pointer.x }}, {{ pointer.y }}</span>
      <span>缩放 {{ zoomLabel }}%</span>
      <span>{{ statusText }}</span>
      <span class="flow__status-spacer" />
      <span>{{ doc.canvas.snapToGrid ? '已吸附网格' : '自由摆放' }}</span>
      <span>快捷键：Tab 加子节点 · Enter 加同级 · Delete 删除 · Ctrl+Z 撤销</span>
    </footer>
  </div>
</template>

<style scoped>
/*
 * 四段式布局：顶部 48 / 中间 flex / 底部 28。
 * 中间再横向分成 200 / flex / 280 —— 与 ProcessOn 的经典三段列一致。
 */
.flow {
  display: flex;
  flex-direction: column;
  /* 关键：作为 .shell__panes 的 flex 子项，必须显式声明可伸缩 + min-width:0。
     否则 flex 子项默认 min-width:auto 会被内部工具栏的最小内容宽度撑开，
     在 1280 / 900 等窄视口下把整页顶出横向滚动条（表现为「页面错乱」）。
     对照 EditorPage 的 .shell__content / .shell__doc 都写了同样的组合。 */
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 0;
  background: var(--bg);
}

/* ---------- 顶部工具栏 ---------- */
.flow__toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 48px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
  flex: 0 0 auto;
  overflow-x: auto;
  scrollbar-width: none;
}
.flow__toolbar::-webkit-scrollbar {
  display: none;
}
.flow__tool-group {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}
.flow__tool {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-2);
  flex: 0 0 auto;
}
.flow__tool:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--accent);
}
.flow__tool:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.flow__tool--text {
  width: auto;
  padding: 0 8px;
  font-size: 12px;
  gap: 4px;
}
.flow__tool--primary {
  background: var(--accent);
  color: #fff;
}
.flow__tool--primary:hover:not(:disabled) {
  background: var(--accent-hover);
  color: #fff;
}
.flow__tool.is-on {
  background: var(--bg-active);
  color: var(--accent);
}
.flow__sep {
  width: 1px;
  height: 20px;
  background: var(--border);
  margin: 0 5px;
  flex: 0 0 auto;
}
.flow__spacer {
  flex: 1 1 auto;
}
.flow__zoom {
  min-width: 42px;
  text-align: center;
  font-size: 12px;
  color: var(--fg-2);
  font-variant-numeric: tabular-nums;
}
.flow__dropdown {
  position: relative;
  flex: 0 0 auto;
}
.flow__menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 700;
  min-width: 200px;
  padding: 5px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-3);
}
.flow__menu-item {
  display: block;
  width: 100%;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--fg);
  text-align: left;
}
.flow__menu-item:hover {
  background: var(--bg-hover);
  color: var(--accent);
}

/* ---------- 中部三列 ---------- */
.flow__body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}

/* 左侧图形库 */
.flow__lib {
  width: 200px;
  flex: 0 0 200px;
  border-right: 1px solid var(--border);
  background: var(--bg-sidebar);
  overflow-y: auto;
  padding: 6px;
}
.lib-group__head {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 6px 6px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-2);
  text-align: left;
}
.lib-group__head:hover {
  background: var(--bg-hover);
}
.lib-group__grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 5px;
  padding: 2px 0 8px;
}
.lib-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 2px 5px;
  border-radius: 7px;
  border: 1px solid transparent;
  color: var(--fg-2);
  cursor: grab;
  transition: border-color 0.12s ease, background 0.12s ease;
}
.lib-item:hover {
  background: var(--bg-elevated);
  border-color: var(--accent);
  color: var(--accent);
}
.lib-item:active {
  cursor: grabbing;
}
.lib-item__preview {
  width: 100%;
  height: 30px;
}
.lib-item__label {
  font-size: 10.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

/* 画布 */
.flow__canvas {
  flex: 1 1 auto;
  min-width: 0;
  position: relative;
}
.flow__minimap {
  position: absolute;
  right: 12px;
  bottom: 12px;
  width: 160px;
  height: 110px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-2);
  overflow: hidden;
  opacity: 0.92;
}
.flow__minimap svg {
  width: 100%;
  height: 100%;
}
.flow__notice {
  position: absolute;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  padding: 6px 14px;
  border-radius: 999px;
  background: rgba(26, 29, 33, 0.88);
  color: #fff;
  font-size: 12px;
  pointer-events: none;
  z-index: 20;
}

/* 右侧属性面板 */
.flow__props {
  width: 280px;
  flex: 0 0 280px;
  border-left: 1px solid var(--border);
  background: var(--bg-sidebar);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.props__tabs {
  display: flex;
  gap: 2px;
  padding: 6px 6px 0;
  flex: 0 0 auto;
}
.props__tab {
  flex: 1;
  height: 28px;
  border-radius: 6px 6px 0 0;
  font-size: 12px;
  color: var(--fg-3);
}
.props__tab.is-on {
  background: var(--bg-elevated);
  color: var(--accent);
  font-weight: 600;
  box-shadow: inset 0 -2px 0 var(--accent);
}
.props__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
}
.props__title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--fg-3);
  margin: 6px 0 8px;
}
.props__title:first-child {
  margin-top: 0;
}
.props__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11.5px;
  color: var(--fg-3);
  margin-bottom: 10px;
}
.props__row2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 10px;
}
.props__row2 label,
.props__row label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11.5px;
  color: var(--fg-3);
}
.props__row {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
  align-items: flex-end;
}
.props__toggle {
  height: 30px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  font-size: 12px;
  color: var(--fg-2);
}
.props__toggle.is-on {
  border-color: var(--accent);
  background: var(--accent-weak);
  color: var(--accent);
  font-weight: 600;
}
.props__text {
  height: auto;
  resize: vertical;
  line-height: 1.5;
}
.nm-input--color {
  height: 30px;
  padding: 2px;
}
.props__empty {
  margin: 20px 4px;
  font-size: 12px;
  color: var(--fg-3);
  line-height: 1.7;
}

/* ---------- 底部状态栏 ---------- */
.flow__status {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 28px;
  padding: 0 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-sidebar);
  font-size: 11px;
  color: var(--fg-3);
  flex: 0 0 auto;
  overflow-x: auto;
  white-space: nowrap;
  scrollbar-width: none;
}
.flow__status::-webkit-scrollbar {
  display: none;
}
.flow__status-spacer {
  flex: 1 1 auto;
}

@media (max-width: 1200px) {
  .flow__lib {
    width: 164px;
    flex: 0 0 164px;
  }
  .flow__props {
    width: 240px;
    flex: 0 0 240px;
  }
}
</style>
