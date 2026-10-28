<script setup lang="ts">
/**
 * 思维导图编辑器（1.1.0）—— 页面布局对齐 ProcessOn 思维导图。
 *
 * 四段式结构：
 * ```
 * ┌──────────────────────────────────────────────────────┐
 * │ 顶部工具栏 48px（撤销/重做、布局方向、主题、自动排版、导出）│
 * ├────────┬────────────────────────────┬───────────────┤
 * │结构树   │       思维导图画布           │  样式面板       │
 * │200px    │    (DiagramCanvas)          │  280px         │
 * ├────────┴────────────────────────────┴───────────────┤
 * │ 底部状态栏 28px（节点数、层级、缩放、自动排版开关）       │
 * └──────────────────────────────────────────────────────┘
 * ```
 *
 * 与流程图的差别（思维导图特有）：
 * - 树形结构优先：Tab 加子节点、Enter 加同级、Delete 删整棵子树；
 * - 自动布局：`autoLayoutMindmap` 支持 右/左/双向/下 四种方向；
 * - 折叠展开：折叠后显示 `+N` 角标；
 * - 主题配色：一键给所有节点按层级上色；
 * - Markdown 大纲互转。
 *
 * 文件格式：`.mind`（JSON，`DiagramDoc`）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NmIcon } from '@neomd/ui';
import type { DiagramDoc, DiagramNode } from '@neomd/shared';
import { autoLayoutMindmap, createEmptyDoc, exportToPng, exportToSvg, parseDiagramDoc, serializeDiagramDoc } from '@neomd/core';
import DiagramCanvas from './DiagramCanvas.vue';
import { DEFAULT_EDGE_STROKE } from './shapes';

const props = defineProps<{ modelValue: string; title?: string }>();
const emit = defineEmits<{ 'update:modelValue': [string]; save: [] }>();

/** 布局方向 */
type Direction = 'right' | 'left' | 'both' | 'down';

/* ------------------------------ 文档 ------------------------------ */

function parse(raw: string): DiagramDoc {
  return parseDiagramDoc(raw, 'mindmap') ?? createEmptyDoc('mindmap', undefined, props.title ?? '未命名思维导图');
}

const doc = ref<DiagramDoc>(parse(props.modelValue));
const selection = ref<string[]>([]);
const canvasRef = ref<InstanceType<typeof DiagramCanvas> | null>(null);
const zoomLabel = ref(100);
const direction = ref<Direction>((doc.value.mindmapLayout as Direction) ?? 'right');
const autoLayout = ref(true);
const layoutOpen = ref(false);
const exportOpen = ref(false);
const outlineOpen = ref(false);
const outlineText = ref('');
const notice = ref('');
const exporting = ref(false);

/* ------------------------------ 历史 ------------------------------ */

const history = ref<DiagramDoc[]>([]);
const future = ref<DiagramDoc[]>([]);
let applying = false;

watch(
  () => doc.value,
  (next, prev) => {
    if (applying || !prev) return;
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    history.value = [...history.value.slice(-49), prev];
    future.value = [];
    scheduleSave();
  },
);

function undo(): void {
  const last = history.value[history.value.length - 1];
  if (!last) return;
  history.value = history.value.slice(0, -1);
  future.value = [doc.value, ...future.value];
  applying = true;
  doc.value = last;
  applying = false;
  scheduleSave();
}
function redo(): void {
  const next = future.value[0];
  if (!next) return;
  future.value = future.value.slice(1);
  history.value = [...history.value, doc.value];
  applying = true;
  doc.value = next;
  applying = false;
  scheduleSave();
}

/* ------------------------------ 保存 ------------------------------ */

let saveTimer: ReturnType<typeof setTimeout> | null = null;
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
    if (saveTimer) return;
    const next = parse(raw);
    if (serializeDiagramDoc(next) !== serializeDiagramDoc(doc.value)) {
      applying = true;
      doc.value = next;
      applying = false;
    }
  },
);

/* ------------------------------ 树结构 ------------------------------ */

/** 父子关系映射（由 edges 推导，思维导图的语义主轴） */
const childrenMap = computed(() => {
  const map = new Map<string, string[]>();
  for (const e of doc.value.edges) {
    if (!e.from || !e.to) continue;
    const list = map.get(e.from) ?? [];
    list.push(e.to);
    map.set(e.from, list);
  }
  return map;
});

const parentMap = computed(() => {
  const map = new Map<string, string>();
  for (const e of doc.value.edges) {
    if (e.from && e.to) map.set(e.to, e.from);
  }
  return map;
});

/** 根节点：没有父节点的那个（优先 level 0） */
const rootNode = computed<DiagramNode | null>(() => {
  const roots = doc.value.nodes.filter((n) => !parentMap.value.has(n.id));
  if (!roots.length) return doc.value.nodes[0] ?? null;
  return roots.find((n) => (n.level ?? 0) === 0) ?? roots[0]!;
});

/** 折叠时应隐藏的节点集合（含后代） */
const hiddenIds = computed(() => {
  const hidden = new Set<string>();
  const walk = (id: string): void => {
    for (const child of childrenMap.value.get(id) ?? []) {
      if (hidden.has(child)) continue;
      hidden.add(child);
      walk(child);
    }
  };
  for (const n of doc.value.nodes) {
    if (n.collapsed) walk(n.id);
  }
  return hidden;
});

/** 折叠后每个节点隐藏了多少后代（用于 `+N` 角标） */
const collapsedCount = computed(() => {
  const counts = new Map<string, number>();
  for (const n of doc.value.nodes) {
    if (!n.collapsed) continue;
    let count = 0;
    const walk = (id: string): void => {
      for (const child of childrenMap.value.get(id) ?? []) {
        count += 1;
        walk(child);
      }
    };
    walk(n.id);
    counts.set(n.id, count);
  }
  return counts;
});

/** 传给画布的文档（过滤掉被折叠隐藏的节点，及其连线） */
const visibleDoc = computed<DiagramDoc>(() => {
  if (!hiddenIds.value.size) return doc.value;
  const nodes = doc.value.nodes.filter((n) => !hiddenIds.value.has(n.id));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = doc.value.edges.filter((e) => (!e.from || ids.has(e.from)) && (!e.to || ids.has(e.to)));
  return { ...doc.value, nodes, edges };
});

/** 左侧结构树（深度优先，带缩进层级） */
const treeRows = computed(() => {
  const rows: Array<{ node: DiagramNode; depth: number; hasChildren: boolean; hidden: boolean }> = [];
  const root = rootNode.value;
  if (!root) return rows;
  const visit = (node: DiagramNode, depth: number): void => {
    const kids = childrenMap.value.get(node.id) ?? [];
    rows.push({ node, depth, hasChildren: kids.length > 0, hidden: Boolean(node.collapsed) });
    if (node.collapsed) return;
    for (const id of kids) {
      const child = doc.value.nodes.find((n) => n.id === id);
      if (child && !hiddenIds.value.has(child.id)) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return rows;
});

const selectedNode = computed<DiagramNode | null>(() => {
  if (selection.value.length !== 1) return null;
  return doc.value.nodes.find((n) => n.id === selection.value[0]) ?? null;
});

const maxDepth = computed(() => Math.max(0, ...doc.value.nodes.map((n) => n.level ?? 0)));

/* ------------------------------ 结构编辑 ------------------------------ */

function flash(msg: string): void {
  notice.value = msg;
  setTimeout(() => {
    if (notice.value === msg) notice.value = '';
  }, 2000);
}

let nodeSeq = 0;
function newId(): string {
  nodeSeq += 1;
  return `m${Date.now().toString(36)}${nodeSeq.toString(36)}`;
}

/** 加子节点：挂到选中节点下，并（可选）自动重排 */
function addChild(): void {
  const parent = selectedNode.value ?? rootNode.value;
  if (!parent) return;
  const node: DiagramNode = {
    id: newId(),
    shape: parent.shape === 'roundRect' ? 'roundRect' : 'rect',
    x: parent.x + 180,
    y: parent.y,
    w: 130,
    h: 44,
    text: '新主题',
    level: (parent.level ?? 0) + 1,
    fill: parent.fill,
    stroke: parent.stroke,
    fontSize: 13,
  };
  const edge = {
    id: `e${node.id}`,
    from: parent.id,
    to: node.id,
    fromPort: 'auto' as const,
    toPort: 'auto' as const,
    endArrow: 'none' as const,
    startArrow: 'none' as const,
    lineStyle: 'solid' as const,
    lineWidth: 2,
    stroke: DEFAULT_EDGE_STROKE,
    curved: true,
  };
  applying = true;
  doc.value = {
    ...doc.value,
    nodes: [...doc.value.nodes, node],
    edges: [...doc.value.edges, edge],
    updatedAt: Date.now(),
  };
  if (autoLayout.value) relayout(doc.value.nodes, doc.value.edges);
  applying = false;
  selection.value = [node.id];
}

/** 加同级节点 */
function addSibling(): void {
  const node = selectedNode.value;
  if (!node) {
    addChild();
    return;
  }
  const parentId = parentMap.value.get(node.id);
  if (!parentId) {
    addChild();
    return;
  }
  const parent = doc.value.nodes.find((n) => n.id === parentId);
  if (!parent) return;
  // 临时把选中切到父节点再加子节点，复用同一套逻辑
  selection.value = [parent.id];
  addChild();
}

/** 删除节点及其整棵子树 */
function deleteSubtree(): void {
  const id = selection.value[0];
  if (!id) return;
  const doomed = new Set<string>([id]);
  const walk = (nid: string): void => {
    for (const child of childrenMap.value.get(nid) ?? []) {
      if (doomed.has(child)) continue;
      doomed.add(child);
      walk(child);
    }
  };
  walk(id);
  // 根节点不允许删（否则导图失去主干）
  if (rootNode.value && doomed.has(rootNode.value.id)) {
    flash('根节点不可删除，可删除其子节点');
    return;
  }
  doc.value = {
    ...doc.value,
    nodes: doc.value.nodes.filter((n) => !doomed.has(n.id)),
    edges: doc.value.edges.filter((e) => !(e.from && doomed.has(e.from)) && !(e.to && doomed.has(e.to))),
    updatedAt: Date.now(),
  };
  selection.value = [];
  flash(`已删除 ${doomed.size} 个节点`);
}

/** 折叠/展开 */
function toggleCollapse(id?: string): void {
  const target = id ?? selection.value[0];
  if (!target) return;
  doc.value = {
    ...doc.value,
    nodes: doc.value.nodes.map((n) => (n.id === target ? { ...n, collapsed: !n.collapsed } : n)),
    updatedAt: Date.now(),
  };
}

/** 全部展开 */
function expandAll(): void {
  doc.value = { ...doc.value, nodes: doc.value.nodes.map((n) => ({ ...n, collapsed: false })), updatedAt: Date.now() };
  flash('已展开全部');
}

/* ------------------------------ 自动布局 ------------------------------ */

/** 按当前方向重排（内部复用引擎的 layout） */
function relayout(nodes = doc.value.nodes, edges = doc.value.edges): void {
  const laid = autoLayoutMindmap(nodes, edges, direction.value, { nodeGap: 22, levelGap: 76, origin: { x: 80, y: 80 } });
  doc.value = { ...doc.value, nodes: laid, edges, mindmapLayout: direction.value, updatedAt: Date.now() };
}

function setDirection(d: Direction): void {
  direction.value = d;
  layoutOpen.value = false;
  relayout();
  flash(`布局方向：${{ right: '向右', left: '向左', both: '双向', down: '向下' }[d]}`);
}

function doAutoLayout(): void {
  relayout();
  flash('已自动排版');
  requestAnimationFrame(() => canvasRef.value?.fitView());
}

/* ------------------------------ 主题配色 ------------------------------ */

/** 6 套主题：按层级递进色阶，一键上色 */
const THEMES: Array<{ id: string; label: string; palette: string[]; stroke: string; text: string }> = [
  { id: 'blue', label: '默认蓝', palette: ['#1677FF', '#4A9BFF', '#7FBAFF', '#B3D6FF', '#D6E9FF'], stroke: '#1677FF', text: '#1a1d21' },
  { id: 'green', label: '森系绿', palette: ['#0E9F6E', '#34B98A', '#6FD0AC', '#A7E3CB', '#D6F2E7'], stroke: '#0E9F6E', text: '#12352a' },
  { id: 'orange', label: '暖橙', palette: ['#FF8A3D', '#FFA76B', '#FFC49A', '#FFDCC4', '#FFEEE0'], stroke: '#E5793A', text: '#4a2a11' },
  { id: 'purple', label: '暗夜紫', palette: ['#7C4DFF', '#9A75FF', '#B79EFF', '#D3C4FF', '#EDE7FF'], stroke: '#7C4DFF', text: '#2a1b52' },
  { id: 'gray', label: '极简灰', palette: ['#5c6470', '#868e9c', '#b0b7c3', '#d4d8e0', '#ecedf1'], stroke: '#8a919c', text: '#1a1d21' },
  { id: 'red', label: '活力红', palette: ['#E5484D', '#F06B70', '#F79AA0', '#FBC4C7', '#FDE6E7'], stroke: '#E5484D', text: '#4a1416' },
];
const themeOpen = ref(false);

function applyTheme(theme: (typeof THEMES)[number]): void {
  themeOpen.value = false;
  doc.value = {
    ...doc.value,
    nodes: doc.value.nodes.map((n) => {
      const lv = Math.min(theme.palette.length - 1, n.level ?? 0);
      return { ...n, fill: theme.palette[lv]!, stroke: theme.stroke, color: theme.text };
    }),
    updatedAt: Date.now(),
  };
  flash(`已应用主题「${theme.label}」`);
}

/* ------------------------------ 节点样式 ------------------------------ */

function patchNode(patch: Partial<DiagramNode>): void {
  if (!selection.value.length) return;
  const ids = new Set(selection.value);
  doc.value = {
    ...doc.value,
    nodes: doc.value.nodes.map((n) => (ids.has(n.id) ? { ...n, ...patch } : n)),
    updatedAt: Date.now(),
  };
}

const SHAPES = [
  { id: 'rect', label: '矩形' },
  { id: 'roundRect', label: '圆角' },
  { id: 'ellipse', label: '椭圆' },
  { id: 'circle', label: '圆形' },
] as const;

/* ------------------------------ 大纲互转 ------------------------------ */

/** 从 Markdown 大纲生成思维导图（支持 `# 标题` 与 `- 列表` 两种写法） */
function fromOutline(): void {
  const lines = outlineText.value.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) {
    flash('请先粘贴大纲内容');
    return;
  }
  type Item = { text: string; depth: number };
  const items: Item[] = [];
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      items.push({ text: heading[2]!.trim(), depth: heading[1]!.length - 1 });
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const depth = Math.floor(bullet[1]!.replace(/\t/g, '  ').length / 2);
      items.push({ text: bullet[2]!.trim(), depth });
      continue;
    }
    items.push({ text: line.trim(), depth: 0 });
  }
  if (!items.length) {
    flash('未识别到有效大纲');
    return;
  }

  const nodes: DiagramNode[] = [];
  const edges: DiagramDoc['edges'] = [];
  /** depth → 最近一个该深度的节点 id */
  const lastAtDepth = new Map<number, string>();
  items.forEach((item, i) => {
    const depth = Math.max(0, item.depth);
    const id = newId();
    nodes.push({
      id,
      shape: depth === 0 ? 'roundRect' : 'rect',
      x: 0,
      y: 0,
      w: depth === 0 ? 160 : 136,
      h: depth === 0 ? 52 : 44,
      text: item.text || '未命名',
      level: depth,
      fill: THEMES[0]!.palette[Math.min(4, depth)],
      stroke: THEMES[0]!.stroke,
      fontSize: depth === 0 ? 15 : 13,
      bold: depth === 0,
    });
    if (depth > 0) {
      // 找最近的、深度恰好小一级的祖先
      let parentId: string | undefined;
      for (let d = depth - 1; d >= 0; d -= 1) {
        const candidate = lastAtDepth.get(d);
        if (candidate) {
          parentId = candidate;
          break;
        }
      }
      if (parentId) {
        edges.push({
          id: `e${id}`,
          from: parentId,
          to: id,
          fromPort: 'auto',
          toPort: 'auto',
          endArrow: 'none',
          startArrow: 'none',
          lineStyle: 'solid',
          lineWidth: 2,
          stroke: DEFAULT_EDGE_STROKE,
          curved: true,
        });
      }
    }
    lastAtDepth.set(depth, id);
    // 深度回退时清掉更深的记录，避免错挂
    for (const key of [...lastAtDepth.keys()]) if (key > depth) lastAtDepth.delete(key);
    if (i === 0) lastAtDepth.set(0, id);
  });

  applying = true;
  doc.value = { ...doc.value, nodes, edges, mindmapLayout: direction.value, updatedAt: Date.now() };
  relayout(doc.value.nodes, doc.value.edges);
  applying = false;
  outlineOpen.value = false;
  outlineText.value = '';
  selection.value = nodes[0] ? [nodes[0].id] : [];
  flash(`已从大纲生成 ${nodes.length} 个节点`);
  requestAnimationFrame(() => canvasRef.value?.fitView());
}

/** 导出为 Markdown 大纲文本 */
function toOutlineText(): string {
  const lines: string[] = [];
  const root = rootNode.value;
  if (!root) return '';
  const visit = (node: DiagramNode, depth: number): void => {
    lines.push(`${'  '.repeat(depth)}- ${node.text}`);
    for (const id of childrenMap.value.get(node.id) ?? []) {
      const child = doc.value.nodes.find((n) => n.id === id);
      if (child) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return lines.join('\n');
}

function downloadOutline(): void {
  const text = toOutlineText();
  if (!text) {
    flash('导图为空');
    return;
  }
  download(new Blob([text], { type: 'text/markdown' }), `${baseName()}.md`);
  flash('已导出 Markdown 大纲');
}

/* ------------------------------ 导出 ------------------------------ */

function baseName(): string {
  return (props.title ?? doc.value.title ?? 'mindmap').replace(/\.(flow|mind)$/i, '');
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function doExport(kind: 'svg' | 'png' | 'json' | 'outline'): Promise<void> {
  exportOpen.value = false;
  if (kind === 'outline') {
    downloadOutline();
    return;
  }
  try {
    exporting.value = true;
    if (kind === 'svg') {
      download(new Blob([exportToSvg(doc.value, { padding: 48, title: baseName() })], { type: 'image/svg+xml' }), `${baseName()}.svg`);
      flash('已导出 SVG');
    } else if (kind === 'png') {
      const blob = await exportToPng(doc.value, 2, { padding: 48 });
      download(blob, `${baseName()}.png`);
      flash('已导出 PNG');
    } else {
      download(new Blob([JSON.stringify(doc.value, null, 2)], { type: 'application/json' }), `${baseName()}.mind`);
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
  const t = e.target as HTMLElement | null;
  const inInput = Boolean(t && /INPUT|TEXTAREA|SELECT/.test(t.tagName));
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
  if (inInput) return;

  // Tab 加子节点、Enter 加同级、Delete 删子树 —— ProcessOn 的经典手感
  if (e.key === 'Tab') {
    e.preventDefault();
    addChild();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    addSibling();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selection.value.length) {
      e.preventDefault();
      deleteSubtree();
    }
    return;
  }
  if (e.code === 'Space' && selection.value.length) {
    e.preventDefault();
    toggleCollapse();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown);
  // 首次进入且节点尚未排布（都在 0,0）时自动排版一次
  const allZero = doc.value.nodes.length > 1 && doc.value.nodes.every((n) => n.x === 0 && n.y === 0);
  if (allZero) relayout();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown);
  if (saveTimer) clearTimeout(saveTimer);
});
</script>

<template>
  <div class="mind">
    <!-- ============ 顶部工具栏 48px ============ -->
    <header class="mind__toolbar">
      <div class="mind__group">
        <button class="mind__tool" :disabled="!history.length" title="撤销 Ctrl+Z" @click="undo"><NmIcon name="restore" :size="15" /></button>
        <button class="mind__tool" :disabled="!future.length" title="重做 Ctrl+Shift+Z" @click="redo"><NmIcon name="refresh" :size="15" /></button>
      </div>

      <span class="mind__sep" />

      <div class="mind__dropdown">
        <button class="mind__tool mind__tool--text" title="布局方向" @click="layoutOpen = !layoutOpen; themeOpen = false">
          <NmIcon name="layout" :size="14" />
          布局：{{ { right: '向右', left: '向左', both: '双向', down: '向下' }[direction] }}
        </button>
        <div v-if="layoutOpen" class="mind__menu" @mousedown.stop>
          <button v-for="d in (['right', 'left', 'both', 'down'] as Direction[])" :key="d" class="mind__menu-item" :class="{ 'is-on': direction === d }" @click="setDirection(d)">
            {{ { right: '向右（默认）', left: '向左', both: '双向（根居中）', down: '向下' }[d] }}
          </button>
        </div>
      </div>

      <div class="mind__dropdown">
        <button class="mind__tool mind__tool--text" title="一键配色" @click="themeOpen = !themeOpen; layoutOpen = false">
          <NmIcon name="palette" :size="14" />
          主题
        </button>
        <div v-if="themeOpen" class="mind__menu" @mousedown.stop>
          <button v-for="t in THEMES" :key="t.id" class="mind__menu-item mind__menu-item--theme" @click="applyTheme(t)">
            <span class="theme-dots">
              <span v-for="(c, i) in t.palette.slice(0, 4)" :key="i" :style="{ background: c }" />
            </span>
            {{ t.label }}
          </button>
        </div>
      </div>

      <span class="mind__sep" />

      <div class="mind__group">
        <button class="mind__tool mind__tool--text" title="重新自动排版" @click="doAutoLayout">自动排版</button>
        <button class="mind__tool mind__tool--text" title="展开全部节点" @click="expandAll">展开全部</button>
        <button class="mind__tool" :class="{ 'is-on': autoLayout }" title="新增节点后是否自动重排" @click="autoLayout = !autoLayout">
          <NmIcon name="sync" :size="15" />
        </button>
      </div>

      <span class="mind__sep" />

      <div class="mind__group">
        <button class="mind__tool" title="缩小" @click="canvasRef?.setZoom((canvasRef?.zoom ?? 1) / 1.2)"><NmIcon name="minus" :size="15" /></button>
        <span class="mind__zoom">{{ zoomLabel }}%</span>
        <button class="mind__tool" title="放大" @click="canvasRef?.setZoom((canvasRef?.zoom ?? 1) * 1.2)"><NmIcon name="plus" :size="15" /></button>
        <button class="mind__tool mind__tool--text" title="适应画布" @click="canvasRef?.fitView()">适应</button>
      </div>

      <div class="mind__spacer" />

      <button class="mind__tool mind__tool--text" title="从 Markdown 大纲生成 / 导出大纲" @click="outlineOpen = true">
        <NmIcon name="outline" :size="14" />
        大纲
      </button>

      <div class="mind__dropdown">
        <button class="mind__tool mind__tool--text mind__tool--primary" :disabled="exporting" @click="exportOpen = !exportOpen">
          <NmIcon name="download" :size="14" />
          {{ exporting ? '导出中…' : '导出' }}
        </button>
        <div v-if="exportOpen" class="mind__menu" @mousedown.stop>
          <button class="mind__menu-item" @click="doExport('svg')">导出 SVG（矢量，推荐）</button>
          <button class="mind__menu-item" @click="doExport('png')">导出 PNG（2 倍图）</button>
          <button class="mind__menu-item" @click="doExport('outline')">导出 Markdown 大纲</button>
          <button class="mind__menu-item" @click="doExport('json')">导出 JSON（.mind 源文件）</button>
        </div>
      </div>
    </header>

    <div class="mind__body">
      <!-- ============ 左侧结构树 200px ============ -->
      <aside class="mind__tree">
        <div class="tree__head">
          <span>结构树</span>
          <button class="tree__add" title="给选中节点加子节点 Tab" @click="addChild"><NmIcon name="plus" :size="13" /></button>
        </div>
        <div class="tree__list nm-scroll">
          <div
            v-for="row in treeRows"
            :key="row.node.id"
            class="tree__row"
            :class="{ 'is-active': selection.includes(row.node.id) }"
            :style="{ paddingLeft: `${6 + row.depth * 12}px` }"
            @click="selection = [row.node.id]"
          >
            <button
              v-if="row.hasChildren"
              class="tree__toggle"
              :title="row.hidden ? '展开' : '折叠'"
              @click.stop="toggleCollapse(row.node.id)"
            >
              <NmIcon :name="row.hidden ? 'chevronRight' : 'chevronDown'" :size="11" />
            </button>
            <span v-else class="tree__dot" />
            <span class="tree__text" :title="row.node.text">{{ row.node.text }}</span>
            <span v-if="row.hidden && collapsedCount.get(row.node.id)" class="tree__badge">+{{ collapsedCount.get(row.node.id) }}</span>
          </div>
          <p v-if="!treeRows.length" class="tree__empty">还没有节点</p>
        </div>
      </aside>

      <!-- ============ 画布 ============ -->
      <div class="mind__canvas">
        <DiagramCanvas
          ref="canvasRef"
          :doc="visibleDoc"
          @update:doc="(d) => (doc = d)"
          @selection-change="(ids) => (selection = ids)"
          @viewport-change="(v) => (zoomLabel = Math.round(v.zoom * 100))"
        />
        <div v-if="notice" class="mind__notice">{{ notice }}</div>
      </div>

      <!-- ============ 右侧样式面板 280px ============ -->
      <aside class="mind__props">
        <div class="props__head">样式</div>
        <div class="props__body nm-scroll">
          <template v-if="selectedNode">
            <div class="props__label">节点形状</div>
            <div class="props__shapes">
              <button
                v-for="s in SHAPES"
                :key="s.id"
                class="props__shape"
                :class="{ 'is-on': (selectedNode.shape ?? 'rect') === s.id }"
                @click="patchNode({ shape: s.id as DiagramNode['shape'] })"
              >
                {{ s.label }}
              </button>
            </div>

            <div class="props__label">配色</div>
            <div class="props__row2">
              <label>填充<input class="nm-input nm-input--color" type="color" :value="selectedNode.fill ?? '#e8f2ff'" @input="patchNode({ fill: ($event.target as HTMLInputElement).value })" /></label>
              <label>描边<input class="nm-input nm-input--color" type="color" :value="selectedNode.stroke ?? '#1677FF'" @input="patchNode({ stroke: ($event.target as HTMLInputElement).value })" /></label>
            </div>

            <div class="props__label">文字</div>
            <div class="props__row2">
              <label>颜色<input class="nm-input nm-input--color" type="color" :value="selectedNode.color ?? '#1a1d21'" @input="patchNode({ color: ($event.target as HTMLInputElement).value })" /></label>
              <label>字号<input class="nm-input" type="number" min="9" max="40" :value="selectedNode.fontSize ?? 13" @change="patchNode({ fontSize: Number(($event.target as HTMLInputElement).value) })" /></label>
            </div>
            <div class="props__row">
              <button class="props__toggle" :class="{ 'is-on': selectedNode.bold }" @click="patchNode({ bold: !selectedNode.bold })">加粗</button>
              <button class="props__toggle" :class="{ 'is-on': selectedNode.italic }" @click="patchNode({ italic: !selectedNode.italic })">斜体</button>
            </div>

            <div class="props__label">Emoji 图标</div>
            <div class="props__icons">
              <button
                v-for="ic in ['', '💡', '⭐', '✅', '📌', '🔥', '📚', '🎯', '⚙️', '📝']"
                :key="ic"
                class="props__icon"
                :class="{ 'is-on': (selectedNode.icon ?? '') === ic }"
                @click="patchNode({ icon: ic || undefined })"
              >{{ ic || '无' }}</button>
            </div>

            <div class="props__label">文本</div>
            <textarea
              class="nm-input props__text"
              rows="3"
              :value="selectedNode.text"
              placeholder="节点文字（支持换行）"
              @input="patchNode({ text: ($event.target as HTMLTextAreaElement).value })"
            />

            <div class="props__label">结构</div>
            <div class="props__row">
              <button class="props__toggle" title="Tab" @click="addChild">加子节点</button>
              <button class="props__toggle" title="Enter" @click="addSibling">加同级</button>
            </div>
            <div class="props__row">
              <button class="props__toggle" @click="toggleCollapse()">{{ selectedNode.collapsed ? '展开' : '折叠' }}子树</button>
              <button class="props__toggle props__toggle--danger" title="Delete" @click="deleteSubtree">删除子树</button>
            </div>
          </template>
          <p v-else class="props__empty">选中一个节点以编辑样式<br />快捷键：Tab 加子节点 · Enter 加同级 · Space 折叠 · Delete 删除</p>
        </div>
      </aside>
    </div>

    <!-- ============ 底部状态栏 28px ============ -->
    <footer class="mind__status">
      <span>节点 {{ doc.nodes.length }}</span>
      <span>层级 {{ maxDepth + 1 }}</span>
      <span>缩放 {{ zoomLabel }}%</span>
      <span>{{ autoLayout ? '新增自动重排' : '手动摆放' }}</span>
      <span class="mind__status-spacer" />
      <span>方向 {{ { right: '向右', left: '向左', both: '双向', down: '向下' }[direction] }}</span>
      <span>Tab 子节点 · Enter 同级 · Space 折叠 · Delete 删除 · Ctrl+Z 撤销</span>
    </footer>

    <!-- 大纲互转弹层 -->
    <div v-if="outlineOpen" class="mind__modal" @mousedown.self="outlineOpen = false">
      <div class="modal__card">
        <div class="modal__head">
          <span>Markdown 大纲互转</span>
          <button class="modal__close" @click="outlineOpen = false"><NmIcon name="close" :size="14" /></button>
        </div>
        <p class="modal__hint">
          支持两种写法：`# 一级 / ## 二级` 标题，或 `- 一级 / &nbsp;&nbsp;- 二级`（每 2 空格一层）列表。
          粘贴后点「生成思维导图」即可；也可以把当前导图导出为大纲。
        </p>
        <textarea v-model="outlineText" class="nm-input modal__text" rows="10" placeholder="# 产品规划&#10;## 需求调研&#10;## 技术选型&#10;# 执行计划" />
        <div class="modal__foot">
          <button class="mind__tool mind__tool--text" @click="outlineText = toOutlineText()">载入当前导图</button>
          <span class="modal__spacer" />
          <button class="mind__tool mind__tool--text" @click="downloadOutline">导出 .md</button>
          <button class="mind__tool mind__tool--text mind__tool--primary" @click="fromOutline">生成思维导图</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 四段式：顶部 48 / 中间（200 + flex + 280）/ 底部 28 —— 对齐 ProcessOn */
.mind {
  display: flex;
  flex-direction: column;
  /* 关键：作为 .shell__panes 的 flex 子项，必须显式声明可伸缩 + min-width:0。
     否则 flex 子项默认 min-width:auto 会被内部工具栏的最小内容宽度撑开，
     在窄视口下把整页顶出横向滚动条（表现为「页面错乱」）。 */
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 0;
  background: var(--bg);
}
.mind__toolbar {
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
.mind__toolbar::-webkit-scrollbar {
  display: none;
}
.mind__group {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}
.mind__tool {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-2);
  flex: 0 0 auto;
}
.mind__tool:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--accent);
}
.mind__tool:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.mind__tool--text {
  width: auto;
  padding: 0 9px;
  font-size: 12px;
  gap: 4px;
}
.mind__tool--primary {
  background: var(--accent);
  color: #fff;
}
.mind__tool--primary:hover:not(:disabled) {
  background: var(--accent-hover);
  color: #fff;
}
.mind__tool.is-on {
  background: var(--bg-active);
  color: var(--accent);
}
.mind__sep {
  width: 1px;
  height: 20px;
  background: var(--border);
  margin: 0 5px;
  flex: 0 0 auto;
}
.mind__spacer {
  flex: 1 1 auto;
}
.mind__zoom {
  min-width: 42px;
  text-align: center;
  font-size: 12px;
  color: var(--fg-2);
  font-variant-numeric: tabular-nums;
}
.mind__dropdown {
  position: relative;
  flex: 0 0 auto;
}
.mind__menu {
  position: absolute;
  left: 0;
  top: calc(100% + 6px);
  z-index: 700;
  min-width: 180px;
  padding: 5px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-3);
}
.mind__menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--fg);
  text-align: left;
}
.mind__menu-item:hover,
.mind__menu-item.is-on {
  background: var(--bg-hover);
  color: var(--accent);
}
.theme-dots {
  display: inline-flex;
  gap: 2px;
}
.theme-dots span {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  display: inline-block;
}

.mind__body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}

/* 左侧结构树 */
.mind__tree {
  width: 200px;
  flex: 0 0 200px;
  border-right: 1px solid var(--border);
  background: var(--bg-sidebar);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.tree__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 30px;
  padding: 0 8px;
  border-bottom: 1px solid var(--border);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--fg-3);
  flex: 0 0 auto;
}
.tree__add {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
}
.tree__add:hover {
  background: var(--bg-hover);
  color: var(--accent);
}
.tree__list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 4px 12px;
}
.tree__row {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 4px 6px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12px;
  color: var(--fg-2);
}
.tree__row:hover {
  background: var(--bg-hover);
}
.tree__row.is-active {
  background: var(--accent-weak);
  color: var(--accent);
  font-weight: 600;
}
.tree__toggle {
  width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
  flex: 0 0 auto;
}
.tree__dot {
  width: 16px;
  flex: 0 0 auto;
}
.tree__text {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tree__badge {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--bg-active);
  color: var(--accent);
  flex: 0 0 auto;
}
.tree__empty {
  margin: 12px 8px;
  font-size: 11.5px;
  color: var(--fg-3);
}

/* 画布 */
.mind__canvas {
  flex: 1 1 auto;
  min-width: 0;
  position: relative;
}
.mind__notice {
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

/* 右侧样式面板 */
.mind__props {
  width: 280px;
  flex: 0 0 280px;
  border-left: 1px solid var(--border);
  background: var(--bg-sidebar);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.props__head {
  height: 30px;
  display: flex;
  align-items: center;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--fg-3);
  flex: 0 0 auto;
}
.props__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
}
.props__label {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--fg-3);
  margin: 10px 0 6px;
}
.props__label:first-child {
  margin-top: 0;
}
.props__row2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.props__row2 label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11.5px;
  color: var(--fg-3);
}
.props__row {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.props__shapes {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 5px;
}
.props__shape {
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  font-size: 11.5px;
  color: var(--fg-2);
}
.props__shape.is-on {
  border-color: var(--accent);
  background: var(--accent-weak);
  color: var(--accent);
  font-weight: 600;
}
.props__toggle {
  flex: 1;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  font-size: 11.5px;
  color: var(--fg-2);
}
.props__toggle.is-on {
  border-color: var(--accent);
  background: var(--accent-weak);
  color: var(--accent);
  font-weight: 600;
}
.props__toggle--danger {
  color: #d93025;
  border-color: rgba(217, 48, 37, 0.35);
}
.props__icons {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 4px;
}
.props__icon {
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  font-size: 13px;
}
.props__icon.is-on {
  border-color: var(--accent);
  background: var(--accent-weak);
}
.props__text {
  height: auto;
  resize: vertical;
  line-height: 1.5;
}
.nm-input--color {
  height: 28px;
  padding: 2px;
}
.props__empty {
  margin: 16px 4px;
  font-size: 11.5px;
  color: var(--fg-3);
  line-height: 1.8;
}

/* 底部状态栏 */
.mind__status {
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
.mind__status::-webkit-scrollbar {
  display: none;
}
.mind__status-spacer {
  flex: 1 1 auto;
}

/* 大纲弹层 */
.mind__modal {
  position: fixed;
  inset: 0;
  z-index: 9400;
  background: rgba(15, 23, 42, 0.35);
  display: grid;
  place-items: center;
}
.modal__card {
  width: min(560px, 92vw);
  padding: 14px 16px 16px;
  border-radius: 12px;
  background: var(--bg-elevated);
  box-shadow: var(--shadow-3);
}
.modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13.5px;
  font-weight: 650;
  color: var(--fg);
}
.modal__close {
  width: 24px;
  height: 24px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
}
.modal__close:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.modal__hint {
  margin: 8px 0 10px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--fg-3);
}
.modal__text {
  height: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  resize: vertical;
}
.modal__foot {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
}
.modal__spacer {
  flex: 1 1 auto;
}
</style>
