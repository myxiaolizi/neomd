/**
 * 图引擎：思维导图自动布局。
 *
 * 采用「子树跨度递归求和 + 居中排布」的简化 Reingold–Tilford：
 * 每个子树在垂直于展开方向上占用的跨度 = max(自身尺寸, 所有子跨度之和 + 间距)，
 * 父节点在跨度内垂直（或水平）居中，兄弟子树依次堆叠。
 *
 * 复杂度 O(n)，无重叠由「跨度不交叠」直接保证。
 */
import type { DiagramDoc, DiagramEdge, DiagramNode } from '@neomd/shared';
import type { Point, Rect } from './geometry';
import { nodeCenter } from './geometry';

/** 布局方向 */
export type MindmapDirection = 'right' | 'left' | 'both' | 'down';

/** 自动布局参数 */
export interface MindmapLayoutOptions {
  /** 同一层相邻兄弟子树之间的间距（px），默认 24 */
  nodeGap?: number;
  /** 相邻两层之间的间距（px），默认 72 */
  levelGap?: number;
  /** 根节点左上角目标位置；省略时保留根节点原坐标 */
  origin?: Point;
}

/** 生效后的布局参数 */
interface ResolvedOptions {
  nodeGap: number;
  levelGap: number;
}

const DEFAULT_NODE_GAP = 24;
const DEFAULT_LEVEL_GAP = 72;

/** 思维导图新节点的默认尺寸 */
const MINDMAP_NODE_W = 140;
const MINDMAP_NODE_H = 44;
/** 流程图新节点的默认尺寸 */
const FLOWCHART_NODE_W = 160;
const FLOWCHART_NODE_H = 60;

/* ------------------------------------------------------------------ */
/* 树结构构建                                                          */
/* ------------------------------------------------------------------ */

/** 布局用的树节点 */
interface TreeNode {
  node: DiagramNode;
  children: TreeNode[];
}

/** 把扁平节点 + 边整理成父子映射（忽略自环、重复边与悬空引用） */
function buildChildrenMap(nodes: DiagramNode[], edges: DiagramEdge[]): Map<string, string[]> {
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const edge of edges) {
    if (!edge.from || !edge.to) continue;
    if (edge.from === edge.to) continue;
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    const pair = `${edge.from}->${edge.to}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    const list = children.get(edge.from);
    if (list) list.push(edge.to);
    else children.set(edge.from, [edge.to]);
  }
  return children;
}

/**
 * 选根节点。
 *
 * 优先级：`level === 0` → 没有任何父节点的节点（入度为 0）→ 数组第一个节点。
 */
function findRoot(nodes: DiagramNode[], children: Map<string, string[]>): DiagramNode | null {
  if (!nodes.length) return null;
  const hasParent = new Set<string>();
  for (const kids of children.values()) for (const kid of kids) hasParent.add(kid);

  const byLevel = nodes.find((n) => n.level === 0);
  if (byLevel) return byLevel;
  const rootless = nodes.find((n) => !hasParent.has(n.id));
  return rootless ?? nodes[0] ?? null;
}

/**
 * 递归建树；用 `path` 集合阻断环（脏数据里可能出现互为父子的情况）。
 */
function buildTree(
  node: DiagramNode,
  childrenMap: Map<string, string[]>,
  byId: Map<string, DiagramNode>,
  path: Set<string>,
): TreeNode {
  const nextPath = new Set(path);
  nextPath.add(node.id);
  const kids: TreeNode[] = [];
  for (const childId of childrenMap.get(node.id) ?? []) {
    if (nextPath.has(childId)) continue; // 环：跳过
    const child = byId.get(childId);
    if (!child) continue;
    kids.push(buildTree(child, childrenMap, byId, nextPath));
  }
  return { node, children: kids };
}

/* ------------------------------------------------------------------ */
/* 跨度与排布                                                          */
/* ------------------------------------------------------------------ */

/** 沿垂直方向（right / left）或水平方向（down）的跨度 */
function subtreeSpan(treeNode: TreeNode, vertical: boolean, gap: number): number {
  const own = vertical ? treeNode.node.h : treeNode.node.w;
  if (!treeNode.children.length) return own;
  let sum = 0;
  for (const child of treeNode.children) sum += subtreeSpan(child, vertical, gap);
  sum += gap * (treeNode.children.length - 1);
  return Math.max(own, sum);
}

/** 子节点跨度之和（不含间距） */
function childrenSpan(treeNode: TreeNode, vertical: boolean, gap: number): number {
  if (!treeNode.children.length) return 0;
  let sum = 0;
  for (const child of treeNode.children) sum += subtreeSpan(child, vertical, gap);
  return sum + gap * (treeNode.children.length - 1);
}

/**
 * 递归排布一棵子树。
 *
 * @param treeNode   当前子树
 * @param parentRect 父节点矩形（根传 null）
 * @param direction  展开方向
 * @param centerAlong 当前节点在「排布轴」上的中心坐标（垂直布局指 y，水平布局指 x）
 * @param origin    根节点的左上角坐标（仅根使用）
 * @param opts      间距参数
 * @param out       结果写入 `id → {x, y}`
 * @param levels    结果写入 `id → 层级`
 * @param depth     当前层级
 */
function placeTree(
  treeNode: TreeNode,
  parentRect: Rect | null,
  direction: Exclude<MindmapDirection, 'both'>,
  centerAlong: number,
  origin: Point | null,
  opts: ResolvedOptions,
  out: Map<string, Point>,
  levels: Map<string, number>,
  depth: number,
): void {
  const { node } = treeNode;
  let x = node.x;
  let y = node.y;

  if (direction === 'down') {
    y = parentRect ? parentRect.y + parentRect.h + opts.levelGap : origin ? origin.y : node.y;
    x = centerAlong - node.w / 2;
  } else if (direction === 'left') {
    x = parentRect ? parentRect.x - opts.levelGap - node.w : origin ? origin.x : node.x;
    y = centerAlong - node.h / 2;
  } else {
    // right
    x = parentRect ? parentRect.x + parentRect.w + opts.levelGap : origin ? origin.x : node.x;
    y = centerAlong - node.h / 2;
  }

  out.set(node.id, { x, y });
  levels.set(node.id, depth);

  if (!treeNode.children.length) return;

  const vertical = direction !== 'down';
  const total = childrenSpan(treeNode, vertical, opts.nodeGap);
  let cursor = centerAlong - total / 2;
  const selfRect: Rect = { x, y, w: node.w, h: node.h };

  for (const child of treeNode.children) {
    const span = subtreeSpan(child, vertical, opts.nodeGap);
    const childCenter = cursor + span / 2;
    placeTree(child, selfRect, direction, childCenter, null, opts, out, levels, depth + 1);
    cursor += span + opts.nodeGap;
  }
}

/* ------------------------------------------------------------------ */
/* 对外 API                                                            */
/* ------------------------------------------------------------------ */

/**
 * 思维导图自动布局。
 *
 * @param nodes     全部节点
 * @param edges     全部连线（用 `from → to` 表示父子关系）
 * @param direction `right` 向右展开 / `left` 向左 / `both` 根居中左右分叉 / `down` 向下
 * @param options   间距与根位置（`nodeGap` 默认 24、`levelGap` 默认 72）
 * @returns 新的完整节点数组（含更新后的 `x` / `y` / `level`）；不修改入参
 *
 * 说明：
 * - 根节点按 `level === 0` → 入度为 0 → 数组首元素 的顺序挑选；
 * - 根不可达的孤立节点保留原坐标，不会被拉回画布原点；
 * - `both` 模式下根的直接子树按索引奇偶分到右侧 / 左侧，两侧各自垂直居中于根。
 */
export function autoLayoutMindmap(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  direction: MindmapDirection,
  options: MindmapLayoutOptions = {},
): DiagramNode[] {
  if (!nodes.length) return [];

  const opts: ResolvedOptions = {
    nodeGap: Number.isFinite(options.nodeGap) ? Math.max(0, options.nodeGap as number) : DEFAULT_NODE_GAP,
    levelGap: Number.isFinite(options.levelGap) ? Math.max(0, options.levelGap as number) : DEFAULT_LEVEL_GAP,
  };

  const byId = new Map<string, DiagramNode>();
  for (const node of nodes) byId.set(node.id, node);

  const childrenMap = buildChildrenMap(nodes, edges);
  const rootNode = findRoot(nodes, childrenMap);
  if (!rootNode) return nodes.slice();

  const root = buildTree(rootNode, childrenMap, byId, new Set());
  const positions = new Map<string, Point>();
  const levels = new Map<string, number>();
  const origin: Point | null = options.origin ? { x: options.origin.x, y: options.origin.y } : null;

  const rootCenter = nodeCenter(rootNode);

  if (direction === 'both') {
    /* 根居中：直接子树按奇偶分左右两组，各自垂直居中于根 */
    const rootX = origin ? origin.x : rootNode.x;
    const rootY = origin ? origin.y : rootNode.y;
    positions.set(rootNode.id, { x: rootX, y: rootY });
    levels.set(rootNode.id, 0);

    const rootRect: Rect = { x: rootX, y: rootY, w: rootNode.w, h: rootNode.h };
    const rootCenterY = rootY + rootNode.h / 2;

    const rightKids: TreeNode[] = [];
    const leftKids: TreeNode[] = [];
    root.children.forEach((child, index) => {
      if (index % 2 === 0) rightKids.push(child);
      else leftKids.push(child);
    });

    const layoutSide = (kids: TreeNode[], side: 'left' | 'right'): void => {
      if (!kids.length) return;
      const spans = kids.map((k) => subtreeSpan(k, true, opts.nodeGap));
      const total = spans.reduce((a, b) => a + b, 0) + opts.nodeGap * (kids.length - 1);
      let cursor = rootCenterY - total / 2;
      kids.forEach((kid, i) => {
        const span = spans[i] as number;
        placeTree(kid, rootRect, side, cursor + span / 2, null, opts, positions, levels, 1);
        cursor += span + opts.nodeGap;
      });
    };

    layoutSide(rightKids, 'right');
    layoutSide(leftKids, 'left');
  } else {
    // 单侧布局：根没有父矩形，纵向中心取自身中心，横向按 origin 或原位
    placeTree(
      root,
      null,
      direction,
      direction === 'down' ? rootCenter.x : rootCenter.y,
      origin,
      opts,
      positions,
      levels,
      0,
    );
  }

  return nodes.map((node) => {
    const pos = positions.get(node.id);
    const level = levels.get(node.id);
    if (!pos) return node;
    return {
      ...node,
      x: pos.x,
      y: pos.y,
      level: level === undefined ? node.level : level,
    };
  });
}

/**
 * 计算折叠时应隐藏的节点 id 集合。
 *
 * 两种用法：
 * 1. **全量模式**（不传 `rootId`）：遍历文档中所有 `collapsed === true` 的节点，
 *    取它们全部后代的并集 —— UI 每次重绘直接用它过滤即可；
 * 2. **预览模式**（传 `rootId` + `collapsed`）：只看这一次折叠/展开动作，
 *    `collapsed === false` 时返回空集合，`true` 时返回该子树的全部后代。
 *
 * 注意返回集合**不包含** `rootId` 本身 —— 被折叠的节点自己仍要显示（带展开按钮）。
 */
export function collapseSubtree(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  rootId?: string,
  collapsed?: boolean,
): Set<string> {
  const childrenMap = buildChildrenMap(nodes, edges);
  const hidden = new Set<string>();

  /** 收集某节点的所有后代（不含自身） */
  function collectDescendants(id: string, visited: Set<string>): void {
    for (const childId of childrenMap.get(id) ?? []) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      hidden.add(childId);
      collectDescendants(childId, visited);
    }
  }

  if (rootId) {
    if (collapsed === false) return hidden;
    collectDescendants(rootId, new Set([rootId]));
    return hidden;
  }

  for (const node of nodes) {
    if (!node.collapsed) continue;
    collectDescendants(node.id, new Set([node.id]));
  }
  return hidden;
}

/** 生成下一个可用节点 id（`n1`、`n2`…；跳过已占用的） */
/**
 * 生成新节点 id。
 *
 * 为什么不能只靠 `nodes` 里的最大值：
 * `addChildNode()` 是「纯构造」——它返回新节点但不修改传入的 doc，
 * 调用方需要自己 push。于是「连续两次 addChildNode 再一起 push」这种很自然的
 * 写法会让两次调用看到同一份 nodes，从而算出**相同的 id**，导致两个兄弟节点
 * 变成同一个节点（布局重叠、拖动联动）。
 *
 * 因此这里额外挂一个模块级单调计数器做兜底：只要同一进程内调用过，
 * 就不可能重复；同时仍保留「扫描现有 id 取 max+1」以便与旧文件里的
 * 顺序 id 风格保持一致（新 id 形如 n12、n13…）。
 */
let idCounter = 0;

function nextNodeId(nodes: DiagramNode[]): string {
  const used = new Set(nodes.map((n) => n.id));
  let max = idCounter;
  for (const id of used) {
    const match = /^n(\d+)$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  let counter = max + 1;
  let candidate = `n${counter}`;
  while (used.has(candidate)) {
    counter += 1;
    candidate = `n${counter}`;
  }
  // 记住已发出的序号，防止「未 push 就再次调用」时重复
  idCounter = counter;
  return candidate;
}

/** 某节点的直接子节点（按 edges 顺序） */
function childNodesOf(doc: DiagramDoc, parentId: string): DiagramNode[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const result: DiagramNode[] = [];
  for (const edge of doc.edges) {
    if (edge.from !== parentId || !edge.to) continue;
    const child = byId.get(edge.to);
    if (child) result.push(child);
  }
  return result;
}

/** 某节点的父节点 id（取第一条指向它的边） */
function parentIdOf(doc: DiagramDoc, nodeId: string): string | undefined {
  for (const edge of doc.edges) {
    if (edge.to === nodeId && edge.from) return edge.from;
  }
  return undefined;
}

/** 构造新节点骨架（尺寸与形状随图类型变化） */
function makeNode(doc: DiagramDoc, id: string, text: string, level: number): DiagramNode {
  const isMindmap = doc.kind === 'mindmap';
  return {
    id,
    shape: isMindmap ? 'roundRect' : 'rect',
    x: 0,
    y: 0,
    w: isMindmap ? MINDMAP_NODE_W : FLOWCHART_NODE_W,
    h: isMindmap ? MINDMAP_NODE_H : FLOWCHART_NODE_H,
    text,
    level,
    ...(isMindmap ? { radius: 10 } : {}),
  };
}

/**
 * 在父节点下新增一个子节点，返回新节点（**不修改 doc**）。
 *
 * 坐标按「父节点右侧、与已有兄弟垂直排开」做局部布局；
 * 若需要整张图重新规整，调用 `autoLayoutMindmap` 再整体排版。
 *
 * @throws 父节点不存在时抛错（宁可报错，也不要静默生成一个游离节点）
 */
export function addChildNode(doc: DiagramDoc, parentId: string, text?: string): DiagramNode {
  const parent = doc.nodes.find((n) => n.id === parentId);
  if (!parent) throw new Error(`addChildNode：父节点 ${parentId} 不存在`);

  const siblings = childNodesOf(doc, parentId);
  const level = (parent.level ?? 0) + 1;
  const node = makeNode(doc, nextNodeId(doc.nodes), text?.trim() || (doc.kind === 'mindmap' ? '新主题' : '新节点'), level);

  if (doc.kind === 'mindmap') {
    node.x = parent.x + parent.w + DEFAULT_LEVEL_GAP;
    node.y = siblings.length
      ? Math.max(...siblings.map((s) => s.y + s.h)) + DEFAULT_NODE_GAP
      : parent.y + (parent.h - node.h) / 2;
  } else {
    node.x = parent.x + parent.w + 80;
    node.y = siblings.length
      ? Math.max(...siblings.map((s) => s.y + s.h)) + 24
      : parent.y + (parent.h - node.h) / 2;
  }
  return node;
}

/**
 * 在某个节点的同级新增一个兄弟节点，返回新节点（**不修改 doc**）。
 *
 * 与 `addChildNode` 的区别：层级与参考节点相同、排在同一列（`x` 对齐），
 * 纵向接在同层最下方的节点之后。
 * 若参考节点本身就是根（没有父节点），则作为并列的第二个根放在其下方。
 */
export function addSiblingNode(doc: DiagramDoc, nodeId: string, text?: string): DiagramNode {
  const anchor = doc.nodes.find((n) => n.id === nodeId);
  if (!anchor) throw new Error(`addSiblingNode：节点 ${nodeId} 不存在`);

  const parentId = parentIdOf(doc, nodeId);
  const siblings = parentId ? childNodesOf(doc, parentId) : [anchor];
  const level = anchor.level ?? 0;

  const node = makeNode(doc, nextNodeId(doc.nodes), text?.trim() || (doc.kind === 'mindmap' ? '新主题' : '新节点'), level);
  node.x = anchor.x;
  node.y = Math.max(...siblings.map((s) => s.y + s.h)) + DEFAULT_NODE_GAP;
  return node;
}
