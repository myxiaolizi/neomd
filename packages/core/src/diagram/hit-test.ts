/**
 * 图引擎：命中测试与操作手柄。
 *
 * 所有容差参数都以**屏幕像素**为单位，内部按 `scale` 换算成世界坐标，
 * 这样画布缩放到 25% 或 400% 时，点击手感保持一致。
 */
import type { DiagramEdge, DiagramNode } from '@neomd/shared';
import { edgeSamplePoints, pointInNode, rectsIntersect, type Point, type Rect, type ResizeHandleId } from './geometry';

/** 连线命中的默认容差（屏幕像素） */
export const EDGE_HIT_TOLERANCE = 6;
/** 缩放手柄命中的默认半径（屏幕像素） */
export const HANDLE_HIT_RADIUS = 5;

/** 命中节点 */
export interface HitNodeResult {
  kind: 'node';
  node: DiagramNode;
  /** 命中点是否落在节点内部的深层区域（UI 可据此区分「选中」与「进入编辑」） */
  inside: true;
}

/** 命中连线 */
export interface HitEdgeResult {
  kind: 'edge';
  edge: DiagramEdge;
  /** 命中点到连线的距离（世界坐标） */
  distance: number;
}

export type HitResult = HitNodeResult | HitEdgeResult | null;

/** 缩放手柄信息 */
export interface HandleInfo {
  id: ResizeHandleId;
  x: number;
  y: number;
}

/** 归一化缩放系数：非法值一律按 1 处理，避免除零 */
function safeScale(scale: number): number {
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** 点 p 到线段 a-b 的最短距离 */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSq = abx * abx + aby * aby;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  // 投影参数夹到 [0,1]，保证取的是线段上的最近点而不是无限长直线
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSq));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

/** 点到一条折线（点序列）的最短距离 */
export function distanceToPolyline(p: Point, points: Point[]): number {
  if (!points.length) return Number.POSITIVE_INFINITY;
  if (points.length === 1) {
    const only = points[0] as Point;
    return Math.hypot(p.x - only.x, p.y - only.y);
  }
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length - 1; i += 1) {
    min = Math.min(min, distanceToSegment(p, points[i] as Point, points[i + 1] as Point));
  }
  return min;
}

/**
 * 命中测试。
 *
 * 顺序：先节点后连线，且同类按数组逆序（后绘制的在上层，优先命中）。
 * 节点用形状判定（`pointInNode`），连线用「点到折线距离 < 6 屏幕像素」判定。
 */
export function hitTest(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  point: Point,
  scale = 1,
): HitResult {
  // 节点：后绘制的优先
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i] as DiagramNode;
    if (pointInNode(node, point)) {
      return { kind: 'node', node, inside: true };
    }
  }

  const tolerance = EDGE_HIT_TOLERANCE / safeScale(scale);
  let best: HitEdgeResult | null = null;
  for (let i = edges.length - 1; i >= 0; i -= 1) {
    const edge = edges[i] as DiagramEdge;
    const distance = distanceToPolyline(point, edgeSamplePoints(edge, nodes));
    if (distance <= tolerance && (!best || distance < best.distance)) {
      best = { kind: 'edge', edge, distance };
    }
  }
  return best;
}

/**
 * 8 个缩放手柄的坐标。
 *
 * 顺序固定为 `nw, n, ne, e, se, s, sw, w`（从左上顺时针），
 * UI 可以按索引直接画，不必再做映射。
 */
export function handlesOf(node: DiagramNode): HandleInfo[] {
  const left = node.x;
  const right = node.x + node.w;
  const top = node.y;
  const bottom = node.y + node.h;
  const midX = node.x + node.w / 2;
  const midY = node.y + node.h / 2;
  return [
    { id: 'nw', x: left, y: top },
    { id: 'n', x: midX, y: top },
    { id: 'ne', x: right, y: top },
    { id: 'e', x: right, y: midY },
    { id: 'se', x: right, y: bottom },
    { id: 's', x: midX, y: bottom },
    { id: 'sw', x: left, y: bottom },
    { id: 'w', x: left, y: midY },
  ];
}

/**
 * 命中缩放手柄。
 *
 * @param radius 命中半径（屏幕像素），默认 5。缩放到 25% 时世界半径会放大 4 倍，
 *               保证小手柄依然能点到。
 */
export function hitHandle(
  node: DiagramNode,
  point: Point,
  scale = 1,
  radius = HANDLE_HIT_RADIUS,
): ResizeHandleId | null {
  const worldRadius = radius / safeScale(scale);
  let best: ResizeHandleId | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const handle of handlesOf(node)) {
    const distance = Math.hypot(point.x - handle.x, point.y - handle.y);
    if (distance <= worldRadius && distance < bestDistance) {
      best = handle.id;
      bestDistance = distance;
    }
  }
  return best;
}

/** 把可能带负宽高的框选矩形归一化成左上角 + 正宽高 */
export function normalizeRect(rect: Rect): Rect {
  return {
    x: rect.w < 0 ? rect.x + rect.w : rect.x,
    y: rect.h < 0 ? rect.y + rect.h : rect.y,
    w: Math.abs(rect.w),
    h: Math.abs(rect.h),
  };
}

/**
 * 框选。
 *
 * - `contain`：节点必须完全被框住才算选中（默认，符合 ProcessOn / Figma 习惯）；
 * - `intersect`：只要与框有重叠就算选中。
 */
export function nodesInRect(
  nodes: DiagramNode[],
  rect: Rect,
  mode: 'contain' | 'intersect' = 'contain',
): DiagramNode[] {
  const box = normalizeRect(rect);
  const result: DiagramNode[] = [];
  for (const node of nodes) {
    const nr = { x: node.x, y: node.y, w: node.w, h: node.h };
    const hit =
      mode === 'intersect'
        ? rectsIntersect(nr, box)
        : nr.x >= box.x && nr.y >= box.y && nr.x + nr.w <= box.x + box.w && nr.y + nr.h <= box.y + box.h;
    if (hit) result.push(node);
  }
  return result;
}
