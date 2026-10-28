/**
 * 思维导图适配层 + 补充工具（task-12）
 *
 * 布局 / 折叠 / 增删节点 / 序列化 / SVG·PNG 导出**全部复用 `@neomd/core` 的 diagram 引擎**，
 * 本文件只做三件事：
 *   1. 把引擎的「多参数、返回数组」风格包成 UI 好用的「传 doc、返回 doc」风格；
 *   2. 补齐引擎不提供的产品能力：6 套主题配色、Markdown 大纲互转、删除子树、
 *      样式批量补丁、节点宽度测量、折叠计数；
 *   3. 统一常量（节点尺寸、形状列表），避免在组件里散落魔法数字。
 *
 * 为什么不直接在组件里调引擎：引擎的 `addChildNode` 是「纯构造」函数（返回新节点但不改 doc），
 * 调用方必须自己 push；本文件的 `appendChild` 内部**立即** push 并补边，从根上避免
 * 「先取多个再一起 push」导致的 id 冲突与布局重叠（引擎侧已加单调计数器兜底，这里是双保险）。
 */
import type { DiagramDoc, DiagramEdge, DiagramNode, DiagramNodeShape } from '@neomd/shared';
import {
  addChildNode as engineAddChild,
  addSiblingNode as engineAddSibling,
  autoLayoutMindmap,
  boundsOf,
  collapseSubtree,
  createEdge,
  createEmptyDoc,
  exportToSvg,
  nodeCenter,
  type MindmapDirection,
} from '@neomd/core';

export type { MindmapDirection };

/** 画布四周留白：自动排版时作为根节点原点 */
export const MINDMAP_ORIGIN = { x: 80, y: 80 };
/** 默认节点高度 */
export const MINDMAP_NODE_H = 44;
/** 默认字号 */
export const DEFAULT_FONT_SIZE = 14;

/* ------------------------------------------------------------------ */
/* 文本测量                                                            */
/* ------------------------------------------------------------------ */

/**
 * 按文本估算节点宽度。
 * 中日韩字符按 1 个字号宽、拉丁字符按 0.58 个字号宽，再留内边距，最后夹在 120~280 之间。
 */
export function measureNodeWidth(text: string, fontSize = DEFAULT_FONT_SIZE): number {
  const chars = [...(text || '')];
  let units = 0;
  for (const ch of chars) {
    units += /[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 1 : 0.58;
  }
  return Math.round(Math.min(280, Math.max(120, units * fontSize + 32)));
}

/* ------------------------------------------------------------------ */
/* 文档生命周期                                                        */
/* ------------------------------------------------------------------ */

/** 新建思维导图文档（引擎自带一个「中心主题」根节点，与 ProcessOn 一致） */
export function makeDefaultDoc(
  title = '未命名思维导图',
  layout: MindmapDirection = 'right',
): DiagramDoc {
  const doc = createEmptyDoc('mindmap', { mindmapLayout: layout }, title);
  return layoutDoc(doc, layout);
}

/** 自动排版：调引擎布局并把结果写回 doc */
export function layoutDoc(
  doc: DiagramDoc,
  direction: MindmapDirection = doc.mindmapLayout ?? 'right',
): DiagramDoc {
  const nodes = autoLayoutMindmap(doc.nodes, doc.edges, direction, {
    nodeGap: 22,
    levelGap: 76,
    origin: MINDMAP_ORIGIN,
  });
  return { ...doc, nodes, mindmapLayout: direction, updatedAt: Date.now() };
}

/* ------------------------------------------------------------------ */
/* 树结构查询                                                          */
/* ------------------------------------------------------------------ */

/** 父子映射：父 id → 子 id 列表 */
export function childrenMapOf(doc: DiagramDoc): Map<string, string[]> {
  const ids = new Set(doc.nodes.map((n) => n.id));
  const map = new Map<string, string[]>();
  for (const n of doc.nodes) map.set(n.id, []);
  for (const e of doc.edges) {
    if (!e.from || !e.to || e.from === e.to) continue;
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    map.get(e.from)?.push(e.to);
  }
  return map;
}

/** 根节点 id：优先 level===0，其次入度为 0，最后兜底第一个节点 */
export function findRootId(doc: DiagramDoc): string | null {
  if (!doc.nodes.length) return null;
  const byLevel = doc.nodes.find((n) => n.level === 0);
  if (byLevel) return byLevel.id;
  const hasParent = new Set(doc.edges.filter((e) => e.from && e.to).map((e) => e.to as string));
  return doc.nodes.find((n) => !hasParent.has(n.id))?.id ?? doc.nodes[0]!.id;
}

/** 父节点 id */
export function findParentId(doc: DiagramDoc, nodeId: string): string | null {
  return doc.edges.find((e) => e.to === nodeId && e.from)?.from ?? null;
}

/** 子树全部节点 id（含自身，深度优先） */
export function subtreeIds(doc: DiagramDoc, nodeId: string): string[] {
  const children = childrenMapOf(doc);
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    for (const c of children.get(id) ?? []) walk(c);
  };
  walk(nodeId);
  return out;
}

/** 当前被折叠隐藏的节点 id 集合（引擎全量模式） */
export function hiddenIdsOf(doc: DiagramDoc): Set<string> {
  return collapseSubtree(doc.nodes, doc.edges);
}

/** 可见节点 id 集合 */
export function visibleIdsOf(doc: DiagramDoc): Set<string> {
  const hidden = hiddenIdsOf(doc);
  const out = new Set<string>();
  for (const n of doc.nodes) if (!hidden.has(n.id)) out.add(n.id);
  return out;
}

/** 某节点折叠时隐藏的后代数量（UI 上显示 `+N`） */
export function hiddenCountOf(doc: DiagramDoc, nodeId: string): number {
  return Math.max(0, subtreeIds(doc, nodeId).length - 1);
}

/** 节点最大层级（0 基），状态栏展示「层级」用 */
export function maxLevelOf(doc: DiagramDoc): number {
  let max = 0;
  for (const n of doc.nodes) max = Math.max(max, n.level ?? 0);
  return max;
}

/* ------------------------------------------------------------------ */
/* 增删节点（安全包装）                                                */
/* ------------------------------------------------------------------ */

/** 思维导图的父子连线：无箭头、细线、曲线（引擎默认带箭头，那是流程图语义） */
function makeChildEdge(childId: string, parentId: string): DiagramEdge {
  return {
    ...createEdge(parentId, childId),
    endArrow: 'none',
    startArrow: 'none',
    lineWidth: 2,
    curved: true,
  };
}

/**
 * 加子节点并**立即写回 doc**。
 *
 * 引擎的 `addChildNode` 只返回新节点（纯构造），这里立刻 push 节点 + push 边，
 * 确保连续调用也不会产生重复 id。
 * 父节点若处于折叠态会被自动展开，否则新节点「看不见」会让用户困惑。
 */
export function appendChild(
  doc: DiagramDoc,
  parentId: string,
  text?: string,
): { doc: DiagramDoc; nodeId: string } {
  const node = engineAddChild(doc, parentId, text);
  const nodes = doc.nodes.map((n) => (n.id === parentId ? { ...n, collapsed: false } : n));
  const next: DiagramDoc = {
    ...doc,
    nodes: [...nodes, node],
    edges: [...doc.edges, makeChildEdge(node.id, parentId)],
    updatedAt: Date.now(),
  };
  return { doc: next, nodeId: node.id };
}

/** 加同级节点并立即写回 doc；根节点无同级，退化为加子节点 */
export function appendSibling(
  doc: DiagramDoc,
  nodeId: string,
  text?: string,
): { doc: DiagramDoc; nodeId: string } {
  const parentId = findParentId(doc, nodeId);
  if (!parentId) return appendChild(doc, nodeId, text);
  const node = engineAddSibling(doc, nodeId, text);
  const next: DiagramDoc = {
    ...doc,
    nodes: [...doc.nodes, node],
    edges: [...doc.edges, makeChildEdge(node.id, parentId)],
    updatedAt: Date.now(),
  };
  return { doc: next, nodeId: node.id };
}

/** 删除整棵子树；根节点不可删 */
export function removeSubtree(doc: DiagramDoc, nodeId: string): DiagramDoc {
  if (nodeId === findRootId(doc)) return doc;
  const ids = new Set(subtreeIds(doc, nodeId));
  return {
    ...doc,
    nodes: doc.nodes.filter((n) => !ids.has(n.id)),
    edges: doc.edges.filter((e) => !ids.has(e.from ?? '') && !ids.has(e.to ?? '')),
    updatedAt: Date.now(),
  };
}

/** 折叠 / 展开单个节点（不传 collapsed 则取反） */
export function toggleCollapse(doc: DiagramDoc, nodeId: string, collapsed?: boolean): DiagramDoc {
  const target = doc.nodes.find((n) => n.id === nodeId);
  if (!target) return doc;
  const next = collapsed === undefined ? !target.collapsed : collapsed;
  return {
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === nodeId ? { ...n, collapsed: next } : n)),
    updatedAt: Date.now(),
  };
}

/** 全部折叠 / 全部展开（根节点始终保持展开，便于总览） */
export function setAllCollapsed(doc: DiagramDoc, collapsed: boolean): DiagramDoc {
  const children = childrenMapOf(doc);
  const rootId = findRootId(doc);
  return {
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.id === rootId) return { ...n, collapsed: false };
      const hasChild = (children.get(n.id)?.length ?? 0) > 0;
      return { ...n, collapsed: hasChild ? collapsed : false };
    }),
    updatedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* 样式补丁                                                            */
/* ------------------------------------------------------------------ */

/** 改节点文本（同步按新文本重算宽度，避免文字溢出或留白） */
export function setNodeText(doc: DiagramDoc, nodeId: string, text: string): DiagramDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((n) =>
      n.id === nodeId
        ? { ...n, text, w: measureNodeWidth(text, n.fontSize ?? DEFAULT_FONT_SIZE) }
        : n,
    ),
    updatedAt: Date.now(),
  };
}

/** 批量更新节点样式 */
export function patchNodes(
  doc: DiagramDoc,
  nodeIds: string[],
  patch: Partial<DiagramNode>,
): DiagramDoc {
  const ids = new Set(nodeIds);
  return {
    ...doc,
    nodes: doc.nodes.map((n) => (ids.has(n.id) ? { ...n, ...patch } : n)),
    updatedAt: Date.now(),
  };
}

/** 批量更新全部连线样式（思维导图连线样式全局统一，符合 ProcessOn 行为） */
export function patchEdges(doc: DiagramDoc, patch: Partial<DiagramEdge>): DiagramDoc {
  return {
    ...doc,
    edges: doc.edges.map((e) => ({ ...e, ...patch })),
    updatedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* 主题配色（6 套，按层级递进色阶）                                     */
/* ------------------------------------------------------------------ */

export interface MindmapTheme {
  id: string;
  name: string;
  background: string;
  /** 层级 0 / 1 / 2 / 3+ 的填充色 */
  fills: string[];
  /** 层级 0 / 1 / 2 / 3+ 的文字色 */
  colors: string[];
  /** 连线色 */
  stroke: string;
  /** 节点描边色 */
  border: string;
}

/** 6 套预设：默认蓝 / 森系绿 / 暖橙 / 暗夜紫 / 极简灰 / 活力红 */
export const MINDMAP_THEMES: MindmapTheme[] = [
  {
    id: 'blue',
    name: '默认蓝',
    background: '#ffffff',
    fills: ['#1677FF', '#E8F1FF', '#F5F9FF', '#FFFFFF'],
    colors: ['#ffffff', '#0B4FBF', '#1F5FB8', '#2C4A72'],
    stroke: '#9DBEF2',
    border: '#4A90E2',
  },
  {
    id: 'green',
    name: '森系绿',
    background: '#FBFDF9',
    fills: ['#2E7D5B', '#E3F3EA', '#F1F9F4', '#FFFFFF'],
    colors: ['#ffffff', '#1F5B41', '#2C6B4F', '#33544A'],
    stroke: '#9CCDB2',
    border: '#57A47C',
  },
  {
    id: 'orange',
    name: '暖橙',
    background: '#FFFCF7',
    fills: ['#E8762C', '#FDEBDC', '#FEF6EF', '#FFFFFF'],
    colors: ['#ffffff', '#9C4413', '#B45A22', '#6B4A32'],
    stroke: '#F0BE94',
    border: '#E09A5F',
  },
  {
    id: 'purple',
    name: '暗夜紫',
    background: '#1A1526',
    fills: ['#7C4DFF', '#332749', '#271F3B', '#211A32'],
    colors: ['#ffffff', '#D9CCFF', '#C4B4F0', '#B6A8DE'],
    stroke: '#6A5794',
    border: '#8B6FD4',
  },
  {
    id: 'gray',
    name: '极简灰',
    background: '#FAFAFA',
    fills: ['#4A4A4A', '#EFEFEF', '#F6F6F6', '#FFFFFF'],
    colors: ['#ffffff', '#2B2B2B', '#3C3C3C', '#4F4F4F'],
    stroke: '#C2C2C2',
    border: '#9E9E9E',
  },
  {
    id: 'red',
    name: '活力红',
    background: '#FFF9F9',
    fills: ['#D9363E', '#FCE4E6', '#FEF2F3', '#FFFFFF'],
    colors: ['#ffffff', '#97171D', '#B02A31', '#6E3A3C'],
    stroke: '#EEA3A8',
    border: '#DE6A72',
  },
];

export function getTheme(id: string): MindmapTheme {
  return MINDMAP_THEMES.find((t) => t.id === id) ?? MINDMAP_THEMES[0]!;
}

/** 层级取填充色（超出预设长度取最后一档） */
export function themeFill(theme: MindmapTheme, level = 0): string {
  return theme.fills[Math.min(level, theme.fills.length - 1)] ?? theme.fills[0]!;
}

/** 层级取文字色 */
export function themeColor(theme: MindmapTheme, level = 0): string {
  return theme.colors[Math.min(level, theme.colors.length - 1)] ?? theme.colors[0]!;
}

/** 一键应用主题：按层级递进色阶刷到所有节点，连线与画布底色一并更新 */
export function applyThemeToDoc(doc: DiagramDoc, themeId: string): DiagramDoc {
  const theme = getTheme(themeId);
  return {
    ...doc,
    canvas: { ...doc.canvas, background: theme.background },
    nodes: doc.nodes.map((n) => ({
      ...n,
      fill: themeFill(theme, n.level ?? 0),
      color: themeColor(theme, n.level ?? 0),
      stroke: theme.border,
    })),
    edges: doc.edges.map((e) => ({ ...e, stroke: theme.stroke })),
    updatedAt: Date.now(),
  };
}

/** 推断文档当前更像哪套主题（打开文件时高亮主题卡用） */
export function guessThemeId(doc: DiagramDoc): string {
  const root = doc.nodes.find((n) => (n.level ?? 0) === 0);
  const fill = (root?.fill ?? '').toUpperCase();
  for (const theme of MINDMAP_THEMES) {
    if (theme.fills.some((f) => f.toUpperCase() === fill)) return theme.id;
  }
  return 'blue';
}

/* ------------------------------------------------------------------ */
/* Markdown 大纲互转                                                   */
/* ------------------------------------------------------------------ */

interface OutlineItem {
  text: string;
  depth: number;
}

/**
 * 解析 Markdown 大纲。
 * 支持两种写法：`# 一级 / ## 二级` 标题层级，以及 `- 一级 /   - 二级` 列表缩进。
 * 标题优先（混用时以标题为准）。
 */
export function parseOutline(markdown: string): OutlineItem[] {
  const lines = (markdown ?? '').split(/\r?\n/);
  const headings: OutlineItem[] = [];
  const listRaw: Array<{ text: string; indent: number }> = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const text = stripInline(heading[2]!.trim());
      if (text) headings.push({ text, depth: heading[1]!.length - 1 });
      continue;
    }
    const list = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (list) {
      const text = stripInline(list[2]!.trim());
      if (text) listRaw.push({ text, indent: (list[1] ?? '').replace(/\t/g, '  ').length });
    }
  }

  if (headings.length) return headings;
  if (!listRaw.length) return [];

  // 列表：把实际出现过的缩进量化成层级，避免 2/3/4 空格混用时层级乱跳
  const indents = [...new Set(listRaw.map((i) => i.indent))].sort((a, b) => a - b);
  return listRaw.map((i) => ({ text: i.text, depth: Math.max(0, indents.indexOf(i.indent)) }));
}

/** 去掉行内 markdown 装饰，只留纯文本 */
function stripInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim();
}

/**
 * 从 Markdown 大纲生成思维导图。
 * 层级跳级（如 `#` 直接到 `###`）时挂到最近的合法父级，不丢节点。
 */
export function outlineToDoc(markdown: string, layout: MindmapDirection = 'right'): DiagramDoc {
  const items = parseOutline(markdown);
  const base = createEmptyDoc('mindmap', { mindmapLayout: layout }, items[0]?.text ?? '思维导图');
  if (!items.length) return layoutDoc(base, layout);

  const rootItem = items[0]!;
  const rootNode = base.nodes[0]!;
  const rootId = rootNode.id;
  const nodes: DiagramNode[] = [
    { ...rootNode, text: rootItem.text, w: measureNodeWidth(rootItem.text, 15), level: 0 },
  ];
  const edges: DiagramEdge[] = [];
  // 栈：stack[d] = 最近一个 depth=d 的节点 id（null 表示该层已回退）
  const stack: Array<string | null> = [rootId];
  const baseDepth = rootItem.depth;

  for (let i = 1; i < items.length; i += 1) {
    const item = items[i]!;
    const depth = Math.max(0, item.depth - baseDepth);
    const fontSize = depth <= 1 ? 14 : 13;
    // 用引擎的 diagramId 之外自造 id：这里需要一次性生成多个，故带序号与随机后缀防撞
    const node: DiagramNode = {
      id: `n${Date.now().toString(36)}${i}${Math.random().toString(36).slice(2, 6)}`,
      shape: depth <= 1 ? 'roundRect' : 'rect',
      x: 0,
      y: 0,
      w: measureNodeWidth(item.text, fontSize),
      h: depth === 0 ? 52 : MINDMAP_NODE_H,
      text: item.text,
      level: depth,
      fontSize,
      radius: depth <= 1 ? 10 : 4,
    };
    nodes.push(node);
    // 找最近的已存在父级
    let parentDepth = depth - 1;
    while (parentDepth > 0 && !stack[parentDepth]) parentDepth -= 1;
    const parentId = stack[parentDepth] ?? rootId;
    edges.push({
      ...createEdge(parentId, node.id),
      endArrow: 'none',
      startArrow: 'none',
      lineWidth: 2,
      curved: true,
    });
    stack[depth] = node.id;
    // 回退时清掉更深的栈，避免后续节点挂到旧的深层节点下
    for (let d = depth + 1; d < stack.length; d += 1) stack[d] = null;
  }

  const doc: DiagramDoc = {
    ...base,
    title: rootItem.text || '思维导图',
    nodes,
    edges,
    updatedAt: Date.now(),
  };
  return layoutDoc(applyThemeToDoc(doc, 'blue'), layout);
}

/** 导出为 Markdown 大纲（`#` 标题形式；折叠的子节点也会导出，避免丢数据） */
export function docToOutline(doc: DiagramDoc): string {
  const children = childrenMapOf(doc);
  const rootId = findRootId(doc);
  if (!rootId) return '';
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const lines: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string, depth: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = byId.get(id);
    if (!node) return;
    const hashes = '#'.repeat(Math.min(6, depth + 1));
    lines.push(`${hashes} ${node.text?.trim() || '（空）'}`);
    for (const c of children.get(id) ?? []) walk(c, depth + 1);
  };
  walk(rootId, 0);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

/**
 * 导出 SVG。
 * 引擎的 `exportToSvg` 会导出**全部**节点，这里先按折叠状态过滤，
 * 保证「所见即所得」——画布上被折叠隐藏的子树不会出现在导出图里。
 */
export function exportVisibleSvg(doc: DiagramDoc, background?: string): string {
  const hidden = hiddenIdsOf(doc);
  const visible = doc.nodes.filter((n) => !hidden.has(n.id));
  const ids = new Set(visible.map((n) => n.id));
  const edges = doc.edges.filter((e) => ids.has(e.from ?? '') && ids.has(e.to ?? ''));
  return exportToSvg(
    { ...doc, nodes: visible, edges },
    { padding: 48, background: background ?? doc.canvas.background, title: doc.title },
  );
}

/* ------------------------------------------------------------------ */
/* 画布渲染辅助                                                        */
/* ------------------------------------------------------------------ */

/** 节点几何（转发引擎，组件里少引一个模块） */
export { nodeCenter, boundsOf };

/** 右侧样式面板的形状选项（思维导图只需这 4 种，与 task-12 要求一致） */
export const NODE_SHAPES: Array<{ id: DiagramNodeShape; label: string }> = [
  { id: 'rect', label: '矩形' },
  { id: 'roundRect', label: '圆角' },
  { id: 'ellipse', label: '椭圆' },
  { id: 'circle', label: '圆形' },
];
