/**
 * 图引擎：对齐、分布与吸附。
 *
 * 约定：所有函数都是**纯函数**，不修改入参，返回新的节点数组；
 * 未参与操作的节点原样保留（同一对象引用），方便 UI 层直接替换列表。
 */
import type { DiagramNode } from '@neomd/shared';
import { boundsOf, nodeCenter, type Point } from './geometry';

/** 对齐方式：6 种（水平 3 + 垂直 3） */
export type AlignMode = 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom';

/** 分布轴 */
export type DistributeAxis = 'horizontal' | 'vertical';

/** 对齐参考线的位置类型 */
export type AlignGuideKind = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom';

/** 拖动时的一条对齐参考线 */
export interface AlignGuide {
  /** 参考线方向：`x` 是竖线（x 固定），`y` 是横线（y 固定） */
  orientation: 'x' | 'y';
  /** 参考线的世界坐标（竖线取 x，横线取 y） */
  value: number;
  /** 是被拖动节点的哪条线对齐上去的 */
  kind: AlignGuideKind;
  /** 让被拖节点吸附到该参考线所需的位移（已含正负号） */
  delta: number;
  /** 贡献这条参考线的其它节点 id（同位置会合并） */
  peers: string[];
}

/** 按 id 挑出节点，保持传入 ids 的顺序 */
function pickNodes(nodes: DiagramNode[], ids: string[]): DiagramNode[] {
  const wanted = new Set(ids);
  return nodes.filter((n) => wanted.has(n.id));
}

/**
 * 对齐多个节点。
 *
 * 参考值取**选中节点的整体包围盒**（与 ProcessOn / Figma 一致）：
 * 例如 `left` 对齐到所有选中节点里最靠左的那条边，而不是某个"主节点"。
 *
 * @returns 新的完整节点数组；选中不足 2 个时返回原数组的浅拷贝
 */
export function alignNodes(nodes: DiagramNode[], ids: string[], mode: AlignMode): DiagramNode[] {
  const selected = pickNodes(nodes, ids);
  if (selected.length < 2) return nodes.slice();

  const box = boundsOf(selected);
  if (!box) return nodes.slice();
  // 提前取出标量，避免在闭包里反复做非空断言
  const boxLeft = box.x;
  const boxTop = box.y;
  const boxRight = box.x + box.w;
  const boxBottom = box.y + box.h;
  const centerX = box.x + box.w / 2;
  const centerY = box.y + box.h / 2;

  /** 计算某个节点对齐后的新坐标；不需要移动时返回 null */
  function nextPosition(node: DiagramNode): Point | null {
    switch (mode) {
      case 'left':
        return { x: boxLeft, y: node.y };
      case 'right':
        return { x: boxRight - node.w, y: node.y };
      case 'centerH':
        return { x: centerX - node.w / 2, y: node.y };
      case 'top':
        return { x: node.x, y: boxTop };
      case 'bottom':
        return { x: node.x, y: boxBottom - node.h };
      case 'centerV':
        return { x: node.x, y: centerY - node.h / 2 };
      default:
        return null;
    }
  }

  const selectedIds = new Set(selected.map((n) => n.id));
  return nodes.map((node) => {
    if (!selectedIds.has(node.id)) return node;
    const pos = nextPosition(node);
    if (!pos) return node;
    if (pos.x === node.x && pos.y === node.y) return node;
    return { ...node, x: pos.x, y: pos.y };
  });
}

/**
 * 等距分布多个节点。
 *
 * 语义是「相邻节点之间的**空隙相等**」（不是中心等距）：
 * 首节点左/上边界与末节点右/下边界固定不动，中间节点依次排开。
 * 节点尺寸不一致时，这种分布方式视觉上才是真的均匀。
 *
 * @returns 新的完整节点数组；选中不足 3 个时返回原数组的浅拷贝
 */
export function distributeNodes(nodes: DiagramNode[], ids: string[], axis: DistributeAxis): DiagramNode[] {
  const selected = pickNodes(nodes, ids);
  if (selected.length < 3) return nodes.slice();

  const horizontal = axis === 'horizontal';
  // 按起始边排序：水平看 x，垂直看 y
  const ordered = [...selected].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
  const first = ordered[0] as DiagramNode;
  const last = ordered[ordered.length - 1] as DiagramNode;

  const startEdge = horizontal ? first.x : first.y;
  const endEdge = horizontal ? last.x + last.w : last.y + last.h;
  const totalSize = ordered.reduce((sum, n) => sum + (horizontal ? n.w : n.h), 0);
  const gap = (endEdge - startEdge - totalSize) / (ordered.length - 1);

  /** 每个节点的新起始坐标 */
  const positions = new Map<string, number>();
  let cursor = startEdge;
  for (const node of ordered) {
    positions.set(node.id, cursor);
    cursor += (horizontal ? node.w : node.h) + gap;
  }

  return nodes.map((node) => {
    const next = positions.get(node.id);
    if (next === undefined) return node;
    const x = horizontal ? next : node.x;
    const y = horizontal ? node.y : next;
    if (x === node.x && y === node.y) return node;
    return { ...node, x, y };
  });
}

/**
 * `distributeNodes` 的别名。
 *
 * 两套命名并存是为了 UI 层调用一致（对齐叫 `alignNodes`、分布叫 `nodeDistribute`），
 * 行为与 `distributeNodes` 完全相同。
 */
export const nodeDistribute: typeof distributeNodes = distributeNodes;

/** 把单个数值吸附到最近的网格线；`gridSize <= 0` 或非法值时原样返回 */
export function snapToGrid(value: number, gridSize: number): number {
  if (!Number.isFinite(gridSize) || gridSize <= 0) return value;
  return Math.round(value / gridSize) * gridSize;
}

/** 把坐标点吸附到最近的网格交点；`gridSize <= 0` 或非法值时原样返回 */
export function snapPoint(point: Point, gridSize: number): Point {
  if (!Number.isFinite(gridSize) || gridSize <= 0) return point;
  return { x: snapToGrid(point.x, gridSize), y: snapToGrid(point.y, gridSize) };
}

/** 数值保留 3 位小数，避免参考线坐标出现浮点噪声 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * 拖动时计算对齐参考线。
 *
 * 被拖节点的 6 条线（left / centerX / right / top / centerY / bottom）
 * 与其余节点的 6 条线两两比对，距离 ≤ `threshold` 即产生一条参考线；
 * 同一位置的多条参考线会合并（`peers` 收集所有贡献者）。
 *
 * UI 用法：
 * - 画辅助线：按 `orientation`（竖/横）与 `value` 画一条贯穿画布的细线；
 * - 吸附：把被拖节点平移 `{ x: 第一条竖线的 delta, y: 第一条横线的 delta }`。
 *
 * @returns 按 `|delta|` 升序排列的参考线（最容易吸附的在前）
 */
export function alignGuides(movingNode: DiagramNode, others: DiagramNode[], threshold = 6): AlignGuide[] {
  if (!others.length || !Number.isFinite(threshold) || threshold < 0) return [];

  const mc = nodeCenter(movingNode);
  const movingLines: Array<{ kind: AlignGuideKind; orientation: 'x' | 'y'; value: number }> = [
    { kind: 'left', orientation: 'x', value: movingNode.x },
    { kind: 'centerX', orientation: 'x', value: mc.x },
    { kind: 'right', orientation: 'x', value: movingNode.x + movingNode.w },
    { kind: 'top', orientation: 'y', value: movingNode.y },
    { kind: 'centerY', orientation: 'y', value: mc.y },
    { kind: 'bottom', orientation: 'y', value: movingNode.y + movingNode.h },
  ];

  const bucket = new Map<string, AlignGuide>();

  for (const other of others) {
    if (other.id === movingNode.id) continue;
    const oc = nodeCenter(other);
    const otherLines: Array<{ orientation: 'x' | 'y'; value: number; id: string }> = [
      { orientation: 'x', value: other.x, id: other.id },
      { orientation: 'x', value: oc.x, id: other.id },
      { orientation: 'x', value: other.x + other.w, id: other.id },
      { orientation: 'y', value: other.y, id: other.id },
      { orientation: 'y', value: oc.y, id: other.id },
      { orientation: 'y', value: other.y + other.h, id: other.id },
    ];

    for (const ml of movingLines) {
      for (const ol of otherLines) {
        if (ml.orientation !== ol.orientation) continue;
        const delta = ol.value - ml.value;
        if (Math.abs(delta) > threshold) continue;
        const key = `${ml.orientation}:${round3(ol.value)}:${ml.kind}`;
        const existing = bucket.get(key);
        if (!existing) {
          bucket.set(key, {
            orientation: ml.orientation,
            value: round3(ol.value),
            kind: ml.kind,
            delta: round3(delta),
            peers: [ol.id],
          });
        } else if (!existing.peers.includes(ol.id)) {
          existing.peers.push(ol.id);
        }
      }
    }
  }

  return [...bucket.values()].sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
}
