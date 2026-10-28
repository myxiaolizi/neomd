<script setup lang="ts">
/**
 * 图编辑画布（1.1.0）—— 流程图与思维导图共用。
 *
 * 为什么用 SVG 而不是 canvas：
 * 1. 文字渲染清晰（矢量、随缩放不失真）；
 * 2. 导出时可直接复用同一套形状描述，**编辑所见即导出所得**；
 * 3. 节点/连线可以用 Vue 模板绑定与事件委托，交互代码更直观。
 *
 * 交互能力（对齐 ProcessOn 的基本手感）：
 * - 滚轮缩放（10%-400%）、空格/中键拖拽平移、「适应画布」「100%」；
 * - 点选、Shift 加选、空白处框选、拖拽整体移动、8 个手柄缩放；
 * - 从节点四边锚点拖出连线、点选连线、Delete 删除；
 * - 双击节点进入文字编辑；
 * - 方向键微移（Shift 加速）、Ctrl+A 全选、Ctrl+Z/Y 撤销重做。
 *
 * 组件是**受控**的：不直接改 props.doc，全部通过 `update:doc` 抛给父组件，
 * 这样父组件能统一做历史栈与持久化。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DiagramDoc, DiagramEdge, DiagramNode, DiagramPort } from '@neomd/shared';
import { edgePath, boundsOf, hitHandle, hitTest, snapPoint, type ResizeHandleId } from '@neomd/core';
import { nodeShapeElement, nodeTextLines, dashArray, DEFAULT_NODE_FILL, DEFAULT_NODE_STROKE, DEFAULT_NODE_COLOR, DEFAULT_EDGE_STROKE } from './shapes';

const props = withDefaults(
  defineProps<{
    doc: DiagramDoc;
    readonly?: boolean;
    /** 是否吸附网格 */
    snap?: boolean;
    /** 是否显示网格 */
    showGrid?: boolean;
    /**
     * 折叠节点隐藏的后代数量（`nodeId -> 数量`），用于在画布上画 `+N` 角标。
     *
     * 为什么由父组件传入而不是画布自己算：折叠语义属于思维导图（树）而非通用画布，
     * 画布不该知道 `collapsed` 字段的树形含义。MindmapEditor 已经算好了
     * `collapsedCount`，此前只喂给了左侧树、没喂给画布，导致用户折叠一个节点后
     * 画布上**看不到任何「这里还藏着 N 个子节点」的提示**，观感上就是「子节点丢了」。
     */
    collapsedCount?: Map<string, number>;
  }>(),
  { readonly: false, snap: true, showGrid: true, collapsedCount: undefined },
);

const emit = defineEmits<{
  'update:doc': [DiagramDoc];
  selectionChange: [string[]];
  /** 视口变化（父组件用于显示缩放比例、更新小地图） */
  viewportChange: [{ zoom: number; offsetX: number; offsetY: number }];
  /** 点击折叠节点的 `+N` 角标（父组件负责展开） */
  expandNode: [string];
}>();

/* ------------------------------ 视图状态 ------------------------------ */

const host = ref<SVGSVGElement | null>(null);
const zoom = ref(1);
const offset = ref({ x: 0, y: 0 });
const selectedIds = ref<string[]>([]);
const hoverId = ref<string | null>(null);

/** 正在进行的拖拽操作 */
type DragKind = 'none' | 'move' | 'resize' | 'pan' | 'select' | 'connect';
interface DragState {
  kind: DragKind;
  startX: number;
  startY: number;
  /** 拖拽开始时的节点快照（move/resize 用） */
  snapshot: DiagramNode[];
  handle?: ResizeHandleId;
  /** connect 用：起点节点 */
  fromNode?: string;
  fromPort?: DiagramPort;
}
const drag = ref<DragState>({ kind: 'none', startX: 0, startY: 0, snapshot: [] });
/** connect 预览线的终点（世界坐标） */
const connectTo = ref<{ x: number; y: number } | null>(null);

/** 双击编辑中的节点 */
const editingId = ref<string | null>(null);
const editingText = ref('');
const editInput = ref<HTMLTextAreaElement | null>(null);

const GRID = computed(() => Math.max(4, props.doc.canvas?.gridSize || 20));

/** 把屏幕坐标换算成画布世界坐标 */
function toWorld(clientX: number, clientY: number): { x: number; y: number } {
  const rect = host.value?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };
  return {
    x: (clientX - rect.left - offset.value.x) / zoom.value,
    y: (clientY - rect.top - offset.value.y) / zoom.value,
  };
}

/** 世界坐标 → 屏幕坐标（用于定位编辑框等 DOM 元素） */
function toScreen(x: number, y: number): { x: number; y: number } {
  return { x: x * zoom.value + offset.value.x, y: y * zoom.value + offset.value.y };
}

/**
 * 画布可视区尺寸（响应式）。
 *
 * 为什么必须是响应式 ref，而不是在 computed 里读 `getBoundingClientRect()`：
 * `computed` 只追踪响应式依赖，而 DOM 的 `getBoundingClientRect()` **不是**响应式源；
 * 且首次求值时组件尚未挂载、`host.value` 为 null，尺寸会永久停在兜底的 1200×700。
 * 而 `.dcanvas__svg` 的 CSS 尺寸是 `100% × 100%`（实际可能是 680×720）。
 *
 * 后果严重：SVG 按默认的 `preserveAspectRatio="xMidYMid meet"` 把 1200×700 的 viewBox
 * 等比缩放并居中到真实容器里，「鼠标屏幕坐标」与「SVG 内部坐标」就差了缩放系数 + 平移量。
 * 表现为拖入节点落点漂移、点选命中错位、框选框与鼠标不同步、双击编辑浮层偏离节点，
 * 也就是用户报的「流程图 / 思维导图页面错乱」。
 *
 * 修法：用 ResizeObserver 把真实尺寸同步进响应式 ref，再据此生成 viewBox。
 * viewBox 与 CSS 尺寸严格相等 → 缩放系数恒为 1 → 内部坐标即像素坐标，
 * 与 `toWorld()` 的 `(clientX - rect.left - offset) / zoom` 完全自洽。
 */
const viewportSize = ref({ w: 1200, h: 700 });
let viewportObserver: ResizeObserver | null = null;

/** 画布变换（把世界坐标映射到屏幕） */
const viewBox = computed(() => `0 0 ${viewportSize.value.w} ${viewportSize.value.h}`);

/** 同步可视区尺寸（首帧、resize 与父容器变化时都会调用） */
function syncViewportSize(): void {
  const el = host.value;
  if (!el) return;
  // clientWidth/Height 是内容盒尺寸，与 `width:100%;height:100%` 的 SVG 视口一致
  const rect = el.getBoundingClientRect();
  const w = Math.max(1, Math.round(el.clientWidth || rect.width || 1200));
  const h = Math.max(1, Math.round(el.clientHeight || rect.height || 700));
  if (w !== viewportSize.value.w || h !== viewportSize.value.h) {
    viewportSize.value = { w, h };
  }
}

/** 顶层 g 的 transform */
const canvasTransform = computed(
  () => `translate(${offset.value.x},${offset.value.y}) scale(${zoom.value})`,
);

/* ------------------------------ 网格 ------------------------------ */

const gridPath = computed(() => {
  if (!props.showGrid || props.doc.canvas?.grid === 'none') return '';
  // 用响应式尺寸而非 getBoundingClientRect()：网格只画可视区域，
  // 尺寸不响应会导致窗口变窄/变宽后网格覆盖范围与真实视口不符（露出空白或白画多余线段）
  const w = viewportSize.value.w;
  const h = viewportSize.value.h;
  // 只画可视区域内的网格，避免大画布生成上万个线段
  const x0 = Math.floor(-offset.value.x / zoom.value / GRID.value) * GRID.value;
  const y0 = Math.floor(-offset.value.y / zoom.value / GRID.value) * GRID.value;
  const x1 = x0 + w / zoom.value + GRID.value;
  const y1 = y0 + h / zoom.value + GRID.value;
  const segs: string[] = [];
  for (let x = x0; x <= x1; x += GRID.value) segs.push(`M${x} ${y0}V${y1}`);
  for (let y = y0; y <= y1; y += GRID.value) segs.push(`M${x0} ${y}H${x1}`);
  return segs.join('');
});

/* ------------------------------ 渲染数据 ------------------------------ */

/**
 * 当前显示连线锚点的节点（仅单选时）。
 *
 * 抽成 computed 是为了让锚点渲染在独立图层（见模板 `.dcanvas__anchors` 的注释）：
 * 独立图层需要知道「锚点属于哪个节点」，而原来锚点是跟着每个节点自己渲染的。
 */
const anchorNode = computed<DiagramNode | null>(() => {
  if (selectedIds.value.length !== 1) return null;
  const id = selectedIds.value[0];
  return props.doc.nodes.find((n) => n.id === id) ?? null;
});

/** 节点渲染描述（形状 + 文字），预先算好避免模板里反复计算 */
const renderedNodes = computed(() => props.doc.nodes.map((node) => ({
    node,
    shapes: nodeShapeElement(node, {
      fill: node.fill ?? DEFAULT_NODE_FILL,
      stroke: node.stroke ?? DEFAULT_NODE_STROKE,
    }),
    lines: nodeTextLines(node),
    color: node.color ?? DEFAULT_NODE_COLOR,
  })),
);

/** 连线渲染描述 */
const renderedEdges = computed(() =>
  props.doc.edges.map((edge) => {
    const p = edgePath(edge, props.doc.nodes);
    return {
      edge,
      d: p.d,
      start: p.start,
      end: p.end,
      stroke: edge.stroke ?? DEFAULT_EDGE_STROKE,
      width: edge.lineWidth ?? 1.5,
      dash: dashArray(edge.lineStyle),
      selected: selectedIds.value.includes(edge.id),
    };
  }),
);

/** 选中节点的缩放手柄 */
const handles = computed(() => {
  if (props.readonly || selectedIds.value.length !== 1) return [];
  const node = props.doc.nodes.find((n) => n.id === selectedIds.value[0]);
  if (!node) return [];
  const ids: ResizeHandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  return ids.map((id) => ({ id, ...handlePosition(node, id) }));
});

function handlePosition(node: DiagramNode, id: ResizeHandleId): { x: number; y: number } {
  const { x, y, w, h } = node;
  const map: Record<ResizeHandleId, { x: number; y: number }> = {
    nw: { x, y },
    n: { x: x + w / 2, y },
    ne: { x: x + w, y },
    e: { x: x + w, y: y + h / 2 },
    se: { x: x + w, y: y + h },
    s: { x: x + w / 2, y: y + h },
    sw: { x, y: y + h },
    w: { x, y: y + h / 2 },
  };
  return map[id];
}

/** 连线预览（拖拽中） */
const connectPreview = computed(() => {
  if (drag.value.kind !== 'connect' || !connectTo.value || !drag.value.fromNode) return null;
  const from = props.doc.nodes.find((n) => n.id === drag.value.fromNode);
  if (!from) return null;
  const p = edgePath(
    { id: '__preview', from: from.id, to: undefined, fromPort: drag.value.fromPort ?? 'auto', toPoint: connectTo.value } as DiagramEdge,
    props.doc.nodes,
  );
  return p.d;
});

/* ------------------------------ 文档更新 ------------------------------ */

/** 统一出口：所有变更都经过这里，保证 updatedAt 与不可变性 */
function commit(nodes: DiagramNode[], edges: DiagramEdge[] = props.doc.edges): void {
  emit('update:doc', { ...props.doc, nodes, edges, updatedAt: Date.now() });
}

function updateNode(id: string, patch: Partial<DiagramNode>): void {
  commit(props.doc.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)));
}

function setSelection(ids: string[]): void {
  selectedIds.value = ids;
  emit('selectionChange', ids);
}

/* ------------------------------ 指针交互 ------------------------------ */

function onPointerDown(e: PointerEvent): void {
  if (props.readonly) return;
  // 中键或按住空格 → 平移
  if (e.button === 1 || spaceDown.value) {
    startPan(e);
    return;
  }
  if (e.button !== 0) return;

  const world = toWorld(e.clientX, e.clientY);
  const target = e.target as SVGElement;

  // 0) 当前选中的节点（锚点与缩放手柄都挂在它身上）
  const node = props.doc.nodes.find((n) => n.id === selectedIds.value[0]);

  // 1) 连线锚点优先（1.1.9 修复）
  /*
   * 顺序很重要：锚点必须**先于**缩放手柄判断。
   *
   * 缩放手柄是画在节点四边中点的 8×8 方块，而连线锚点也在四边中点 ——
   * 两者位置完全重合。原实现先判 `hitHandle()`，于是「拖右锚点」永远被识别成
   * 「向右缩放宽高」，连线一条也画不出来。而锚点只有在单选节点时才渲染，
   * 是比手柄更强的显式意图（用户特意选中了节点再去拖那个小圆点），
   * 因此让锚点优先；手柄仍可通过拖节点角/边（稍偏离中点）命中。
   */
  if (node && target.dataset.anchor) {
    drag.value = {
      kind: 'connect',
      startX: e.clientX,
      startY: e.clientY,
      snapshot: [],
      fromNode: node.id,
      fromPort: target.dataset.anchor as DiagramPort,
    };
    connectTo.value = world;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return;
  }

  // 2) 手柄缩放
  if (node) {
    const hid = hitHandle(node, world, zoom.value);
    if (hid) {
      startDrag(e, 'resize', { handle: hid });
      return;
    }
  }

  // 3) 命中节点 / 连线
  const hit = hitTest(props.doc.nodes, props.doc.edges, world, zoom.value);
  if (hit?.kind === 'node') {
    const id = hit.node.id;
    let nextSel: string[];
    if (e.shiftKey) {
      nextSel = selectedIds.value.includes(id)
        ? selectedIds.value.filter((x) => x !== id)
        : [...selectedIds.value, id];
    } else {
      nextSel = selectedIds.value.includes(id) ? selectedIds.value : [id];
    }
    setSelection(nextSel);
    startDrag(e, 'move');
    return;
  }
  if (hit?.kind === 'edge') {
    setSelection([hit.edge.id]);
    return;
  }

  // 4) 空白 → 框选
  if (!e.shiftKey) setSelection([]);
  drag.value = { kind: 'select', startX: e.clientX, startY: e.clientY, snapshot: [] };
  boxRect.value = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
}

function startPan(e: PointerEvent): void {
  drag.value = { kind: 'pan', startX: e.clientX, startY: e.clientY, snapshot: [], };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
}

function startDrag(e: PointerEvent, kind: 'move' | 'resize', extra: { handle?: ResizeHandleId } = {}): void {
  drag.value = {
    kind,
    startX: e.clientX,
    startY: e.clientY,
    // 快照选中节点的原始位置，拖动时基于快照计算，避免累积误差
    snapshot: props.doc.nodes.filter((n) => selectedIds.value.includes(n.id)).map((n) => ({ ...n })),
    handle: extra.handle,
  };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
}

/** 框选矩形（屏幕坐标） */
const boxRect = ref<{ x: number; y: number; w: number; h: number } | null>(null);
const spaceDown = ref(false);

function onPointerMove(e: PointerEvent): void {
  const d = drag.value;
  if (d.kind === 'none') return;

  if (d.kind === 'pan') {
    offset.value = {
      x: offset.value.x + (e.clientX - d.startX),
      y: offset.value.y + (e.clientY - d.startY),
    };
    drag.value = { ...d, startX: e.clientX, startY: e.clientY };
    emitViewport();
    return;
  }

  if (d.kind === 'connect') {
    connectTo.value = toWorld(e.clientX, e.clientY);
    return;
  }

  if (d.kind === 'select') {
    boxRect.value = {
      x: Math.min(d.startX, e.clientX),
      y: Math.min(d.startY, e.clientY),
      w: Math.abs(e.clientX - d.startX),
      h: Math.abs(e.clientY - d.startY),
    };
    return;
  }

  // move / resize：按世界坐标增量应用
  const dx = (e.clientX - d.startX) / zoom.value;
  const dy = (e.clientY - d.startY) / zoom.value;

  if (d.kind === 'move') {
    const moved = d.snapshot.map((n) => {
      let nx = n.x + dx;
      let ny = n.y + dy;
      if (props.snap && props.doc.canvas?.snapToGrid) {
        nx = snapPoint({ x: nx, y: ny }, GRID.value).x;
        ny = snapPoint({ x: nx, y: ny }, GRID.value).y;
      }
      return { ...n, x: nx, y: ny };
    });
    const map = new Map(moved.map((n) => [n.id, n]));
    commit(props.doc.nodes.map((n) => map.get(n.id) ?? n));
    return;
  }

  if (d.kind === 'resize' && d.handle && d.snapshot.length === 1) {
    const orig = d.snapshot[0]!;
    const resized = applyResize(orig, d.handle, dx, dy);
    updateNode(orig.id, resized);
  }
}

/** 按手柄方向调整尺寸，保证最小尺寸且不出现负宽高 */
function applyResize(node: DiagramNode, handle: ResizeHandleId, dx: number, dy: number): Partial<DiagramNode> {
  const MIN = 24;
  let { x, y, w, h } = node;
  if (handle.includes('w')) {
    const nx = Math.min(x + dx, x + w - MIN);
    w = w + (x - nx);
    x = nx;
  }
  if (handle.includes('e')) w = Math.max(MIN, w + dx);
  if (handle.includes('n')) {
    const ny = Math.min(y + dy, y + h - MIN);
    h = h + (y - ny);
    y = ny;
  }
  if (handle.includes('s')) h = Math.max(MIN, h + dy);
  return { x, y, w, h };
}

function onPointerUp(e: PointerEvent): void {
  const d = drag.value;
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);

  if (d.kind === 'select' && boxRect.value) {
    // 框选：把屏幕矩形换算成世界矩形后命中
    const p1 = toWorld(boxRect.value.x, boxRect.value.y);
    const p2 = toWorld(boxRect.value.x + boxRect.value.w, boxRect.value.y + boxRect.value.h);
    const rect = { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y) };
    if (rect.w > 4 && rect.h > 4) {
      const inside = props.doc.nodes
        .filter((n) => n.x + n.w > rect.x && n.x < rect.x + rect.w && n.y + n.h > rect.y && n.y < rect.y + rect.h)
        .map((n) => n.id);
      setSelection(inside);
    }
  }

  if (d.kind === 'connect' && d.fromNode && connectTo.value) {
    // 落点若有节点则建连线，否则创建自由端点连线
    const hit = hitTest(props.doc.nodes, [], connectTo.value, zoom.value);
    const toId = hit?.kind === 'node' && hit.node.id !== d.fromNode ? hit.node.id : undefined;
    if (toId || true) {
      const edge: DiagramEdge = {
        id: `e${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
        from: d.fromNode,
        to: toId,
        fromPort: d.fromPort ?? 'auto',
        toPort: 'auto',
        toPoint: toId ? undefined : connectTo.value,
        endArrow: 'arrow',
        startArrow: 'none',
        lineStyle: 'solid',
        lineWidth: 1.5,
        stroke: DEFAULT_EDGE_STROKE,
        curved: true,
      };
      commit(props.doc.nodes, [...props.doc.edges, edge]);
    }
  }

  drag.value = { kind: 'none', startX: 0, startY: 0, snapshot: [] };
  boxRect.value = null;
  connectTo.value = null;
}

/* ------------------------------ 缩放与视口 ------------------------------ */

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  // 以鼠标位置为锚点缩放，符合作图工具的直觉
  const rect = host.value?.getBoundingClientRect();
  if (!rect) return;
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const before = toWorld(e.clientX, e.clientY);
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const next = Math.min(4, Math.max(0.1, zoom.value * factor));
  zoom.value = next;
  offset.value = { x: mx - before.x * next, y: my - before.y * next };
  emitViewport();
}

function emitViewport(): void {
  emit('viewportChange', { zoom: zoom.value, offsetX: offset.value.x, offsetY: offset.value.y });
}

/** 适应画布：把全部内容居中并缩放到合适大小 */
function fitView(padding = 60): void {
  const rect = host.value?.getBoundingClientRect();
  const box = boundsOf(props.doc.nodes);
  if (!rect || !box || box.w <= 0 || box.h <= 0) {
    zoom.value = 1;
    offset.value = { x: 0, y: 0 };
    emitViewport();
    return;
  }
  const z = Math.min(4, Math.max(0.1, Math.min((rect.width - padding * 2) / box.w, (rect.height - padding * 2) / box.h)));
  zoom.value = z;
  offset.value = {
    x: rect.width / 2 - (box.x + box.w / 2) * z,
    y: rect.height / 2 - (box.y + box.h / 2) * z,
  };
  emitViewport();
}

function setZoom(next: number): void {
  const rect = host.value?.getBoundingClientRect();
  if (!rect) return;
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const before = { x: (cx - offset.value.x) / zoom.value, y: (cy - offset.value.y) / zoom.value };
  zoom.value = Math.min(4, Math.max(0.1, next));
  offset.value = { x: cx - before.x * zoom.value, y: cy - before.y * zoom.value };
  emitViewport();
}

/* ------------------------------ 文字编辑 ------------------------------ */

function onDblClick(e: MouseEvent): void {
  if (props.readonly) return;
  const world = toWorld(e.clientX, e.clientY);
  const hit = hitTest(props.doc.nodes, [], world, zoom.value);
  if (hit?.kind === 'node') {
    editingId.value = hit.node.id;
    editingText.value = hit.node.text;
    setSelection([hit.node.id]);
    requestAnimationFrame(() => editInput.value?.focus());
  }
}

function commitEdit(): void {
  const id = editingId.value;
  if (!id) return;
  const text = editingText.value;
  editingId.value = null;
  const node = props.doc.nodes.find((n) => n.id === id);
  if (node && node.text !== text) updateNode(id, { text });
}

/* ------------------------------ 键盘 ------------------------------ */

function onKeyDown(e: KeyboardEvent): void {
  if (editingId.value) return;
  if (e.code === 'Space') spaceDown.value = true;
  if (props.readonly) return;

  const step = e.shiftKey ? GRID.value : 1;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && selectedIds.value.length) {
    e.preventDefault();
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    const map = new Map(
      props.doc.nodes
        .filter((n) => selectedIds.value.includes(n.id))
        .map((n) => [n.id, { ...n, x: n.x + dx, y: n.y + dy }]),
    );
    commit(props.doc.nodes.map((n) => map.get(n.id) ?? n));
    return;
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (!selectedIds.value.length) return;
    e.preventDefault();
    deleteSelection();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    setSelection(props.doc.nodes.map((n) => n.id));
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.code === 'Space') spaceDown.value = false;
}

/** 删除选中项（节点连同其连线一起删，避免留下悬空边） */
function deleteSelection(): void {
  const ids = new Set(selectedIds.value);
  const nodes = props.doc.nodes.filter((n) => !ids.has(n.id));
  const edges = props.doc.edges.filter(
    (e) => !ids.has(e.id) && !(e.from && ids.has(e.from)) && !(e.to && ids.has(e.to)),
  );
  commit(nodes, edges);
  setSelection([]);
}

/* ------------------------------ 生命周期 ------------------------------ */

function onGlobalKeyDown(e: KeyboardEvent): void {
  onKeyDown(e);
}
function onGlobalKeyUp(e: KeyboardEvent): void {
  onKeyUp(e);
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeyDown);
  window.addEventListener('keyup', onGlobalKeyUp);
  // 先同步一次真实尺寸，否则首帧 viewBox 仍是兜底的 1200×700（坐标会整体偏移）
  syncViewportSize();
  // 容器尺寸变化（侧栏折叠、窗口缩放、分屏比例调整）都必须让 viewBox 跟着变，
  // 否则缩放系数重新偏离 1，坐标又错位——这正是 1.1.9 之前画布错乱的根因
  if (typeof ResizeObserver !== 'undefined' && host.value) {
    viewportObserver = new ResizeObserver(() => syncViewportSize());
    viewportObserver.observe(host.value);
  }
  // 首次加载自动适应画布，避免内容跑到视口外（等尺寸就绪后再算，否则 fitView 用的是错尺寸）
  requestAnimationFrame(() => {
    syncViewportSize();
    fitView();
  });
});

onBeforeUnmount(() => {
  viewportObserver?.disconnect();
  viewportObserver = null;
  window.removeEventListener('keydown', onGlobalKeyDown);
  window.removeEventListener('keyup', onGlobalKeyUp);
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
});

// 外部换文档（切换标签页）时重置选择并重新适应
watch(
  () => props.doc.kind + '|' + props.doc.nodes.length,
  () => {
    setSelection([]);
    requestAnimationFrame(() => fitView());
  },
);

/** 供父组件调用：适应画布 / 设置缩放 / 删除选中 / 复制选中 */
defineExpose({
  fitView,
  setZoom,
  zoom,
  offset,
  selectedIds,
  deleteSelection,
  selectAll: () => setSelection(props.doc.nodes.map((n) => n.id)),
  getSelection: () => [...selectedIds.value],
});
</script>

<template>
  <div class="dcanvas" :class="{ 'is-panning': drag.kind === 'pan' }">
    <svg
      ref="host"
      class="dcanvas__svg"
      :viewBox="viewBox"
      @pointerdown="onPointerDown"
      @wheel="onWheel"
      @dblclick="onDblClick"
      @contextmenu.prevent
    >
      <!-- 背景 -->
      <rect x="-100000" y="-100000" width="200000" height="200000" :fill="doc.canvas?.background || '#ffffff'" />

      <g :transform="canvasTransform">
        <!-- 网格 -->
        <path v-if="gridPath" :d="gridPath" stroke="rgba(15,23,42,0.08)" stroke-width="1" fill="none" />

        <!-- 连线（先画，避免压住节点） -->
        <g class="dcanvas__edges">
          <g v-for="e in renderedEdges" :key="e.edge.id">
            <path
              :d="e.d"
              :stroke="e.selected ? '#1677ff' : e.stroke"
              :stroke-width="e.selected ? e.width + 0.8 : e.width"
              :stroke-dasharray="e.dash"
              fill="none"
              stroke-linecap="round"
            />
            <!-- 加粗透明命中区：细线也能点中 -->
            <path :d="e.d" stroke="transparent" :stroke-width="Math.max(10, e.width * 4)" fill="none" style="cursor: pointer" />
            <text
              v-if="e.edge.label"
              :x="(e.start.x + e.end.x) / 2"
              :y="(e.start.y + e.end.y) / 2 - 6"
              text-anchor="middle"
              font-size="11"
              :fill="e.stroke"
            >{{ e.edge.label }}</text>
          </g>
        </g>

        <!-- 连线预览 -->
        <path v-if="connectPreview" :d="connectPreview" stroke="#1677ff" stroke-width="1.6" stroke-dasharray="5 4" fill="none" />

        <!-- 节点 -->
        <g class="dcanvas__nodes">
          <g
            v-for="r in renderedNodes"
            :key="r.node.id"
            :class="{ 'is-selected': selectedIds.includes(r.node.id), 'is-hover': hoverId === r.node.id }"
            style="cursor: move"
            @pointerenter="hoverId = r.node.id"
            @pointerleave="hoverId = null"
          >
            <component
              :is="s.tag"
              v-for="(s, i) in r.shapes"
              :key="i"
              v-bind="s.attrs"
            />
            <!-- 选中描边（不改变节点自身样式） -->
            <rect
              v-if="selectedIds.includes(r.node.id)"
              :x="r.node.x - 3"
              :y="r.node.y - 3"
              :width="r.node.w + 6"
              :height="r.node.h + 6"
              fill="none"
              stroke="#1677ff"
              stroke-width="1.5"
              stroke-dasharray="4 3"
              rx="4"
            />
            <text
              v-for="(l, i) in r.lines"
              :key="`t${i}`"
              :x="l.x"
              :y="l.y"
              text-anchor="middle"
              dominant-baseline="middle"
              :font-size="r.node.fontSize ?? 13"
              :font-weight="r.node.bold ? 700 : 400"
              :font-style="r.node.italic ? 'italic' : 'normal'"
              :fill="r.color"
              style="pointer-events: none; user-select: none"
            >{{ l.text }}</text>

            <!-- 折叠角标 +N：点击展开（1.1.9） -->
            <g
              v-if="props.collapsedCount?.get(r.node.id)"
              :transform="`translate(${r.node.x + r.node.w + 2},${r.node.y + r.node.h / 2})`"
              style="cursor: pointer"
              @pointerdown.stop
              @click.stop="emit('expandNode', r.node.id)"
            >
              <circle r="9" fill="#1677ff" stroke="#fff" stroke-width="1.5" />
              <text
                text-anchor="middle"
                dominant-baseline="central"
                font-size="9"
                font-weight="600"
                fill="#fff"
                style="pointer-events: none; user-select: none"
              >+{{ props.collapsedCount.get(r.node.id) }}</text>
            </g>

          </g>
        </g>

        <!--
          连线锚点（1.1.9 修复「从锚点拖不出连线」）。

          ## 两个真实的层叠/命中缺陷
          1. **原位置在节点 `<g>` 内部**：SVG 无 z-index，绘制顺序即层叠顺序，
             `<g class="dcanvas__nodes">` 里后渲染的节点会盖住先渲染节点的锚点。
             实测「选中节点 A 拖右锚点」时 `elementFromPoint` 返回的是**邻居节点的 rect**，
             pointerdown 因此走「拖动节点」分支 —— 用户看到「锚点点了没反应」。
          2. **被缩放手柄盖住**：缩放手柄是 8×8 的 `<rect>`，正好画在节点四边中点，
             与四个锚点**位置重合**；而手柄在锚点之后渲染，于是完全遮住锚点。
             这一条更隐蔽：即使把锚点提到节点层之后，只要手柄仍在后面就依然点不中。

          修法：锚点放在**缩放手柄之后**（即整个画布最上层），并：
           - 只遍历「当前选中的那一个节点」，渲染量更小；
           - 命中区域用透明 r=10 圆（直径 20px），符合最小可点区域常识；
           - 可见的 r=4 圆 `pointer-events:none` 只负责外观，不抢事件。
        -->
        <!-- 缩放手柄 -->
        <rect
          v-for="h in handles"
          :key="h.id"
          :x="h.x - 4"
          :y="h.y - 4"
          width="8"
          height="8"
          fill="#fff"
          stroke="#1677ff"
          stroke-width="1.4"
          :style="{ cursor: `${h.id}-resize` }"
        />

        <g v-if="anchorNode" class="dcanvas__anchors">
          <g
            v-for="a in ([['top', anchorNode.x + anchorNode.w / 2, anchorNode.y], ['right', anchorNode.x + anchorNode.w, anchorNode.y + anchorNode.h / 2], ['bottom', anchorNode.x + anchorNode.w / 2, anchorNode.y + anchorNode.h], ['left', anchorNode.x, anchorNode.y + anchorNode.h / 2]] as const)"
            :key="a[0]"
          >
            <circle
              :cx="a[1]"
              :cy="a[2]"
              r="10"
              fill="transparent"
              :data-anchor="a[0]"
              style="cursor: crosshair"
            />
            <circle
              :cx="a[1]"
              :cy="a[2]"
              r="4"
              fill="#fff"
              stroke="#1677ff"
              stroke-width="1.4"
              style="pointer-events: none"
            />
          </g>
        </g>
      </g>
    </svg>

    <!-- 框选矩形（屏幕坐标覆盖层） -->
    <div
      v-if="boxRect"
      class="dcanvas__box"
      :style="{ left: `${boxRect.x - (host?.getBoundingClientRect().left ?? 0)}px`, top: `${boxRect.y - (host?.getBoundingClientRect().top ?? 0)}px`, width: `${boxRect.w}px`, height: `${boxRect.h}px` }"
    />

    <!-- 双击编辑浮层 -->
    <textarea
      v-if="editingId"
      ref="editInput"
      v-model="editingText"
      class="dcanvas__edit"
      :style="(() => {
        const n = doc.nodes.find((x) => x.id === editingId);
        if (!n) return {};
        const p = toScreen(n.x, n.y);
        return { left: `${p.x}px`, top: `${p.y}px`, width: `${n.w * zoom}px`, height: `${n.h * zoom}px`, fontSize: `${(n.fontSize ?? 13) * zoom}px` };
      })()"
      @blur="commitEdit"
      @keydown.enter.exact.prevent="commitEdit"
      @keydown.esc.prevent="editingId = null"
    />
  </div>
</template>

<style scoped>
.dcanvas {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--bg-elevated);
  touch-action: none;
}
.dcanvas.is-panning {
  cursor: grabbing;
}
.dcanvas__svg {
  width: 100%;
  height: 100%;
  display: block;
  user-select: none;
}
.dcanvas__box {
  position: absolute;
  border: 1px solid var(--accent);
  background: var(--accent-weak);
  pointer-events: none;
}
.dcanvas__edit {
  position: absolute;
  z-index: 10;
  border: 1px solid var(--accent);
  border-radius: 4px;
  background: var(--bg-elevated);
  color: var(--fg);
  padding: 4px 6px;
  outline: none;
  resize: none;
  text-align: center;
  line-height: 1.3;
  box-shadow: var(--shadow-2);
}
</style>
