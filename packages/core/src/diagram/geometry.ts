/**
 * 图引擎：几何与连线路径。
 *
 * 坐标系统一使用「画布世界坐标」：缩放与平移只作用于视图矩阵，
 * 因此所有几何计算、命中测试、导出都直接使用节点的 `x/y/w/h`，不需要换算屏幕坐标。
 */
import type { DiagramEdge, DiagramNode, DiagramPort } from '@neomd/shared';

/** 二维点 */
export interface Point {
  x: number;
  y: number;
}

/** 轴对齐矩形（左上角 + 宽高） */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 8 个缩放手柄的方向标识 */
export type ResizeHandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** 连线路径计算结果 */
export interface EdgePath {
  /** SVG path 的 d 属性（已含箭头回退） */
  d: string;
  /** 起点（回退后，用于绘制起点箭头） */
  start: Point;
  /** 终点（回退后，用于绘制终点箭头） */
  end: Point;
}

/** 平行四边形左右斜边的水平偏移比例（相对节点宽度） */
const PARALLELOGRAM_SKEW_RATIO = 0.22;
/** 六边形左右尖角的水平内缩比例（相对节点宽度） */
const HEXAGON_INSET_RATIO = 0.25;
/** 曲线控制点的最小外推距离（px），保证短连线也有明显弧度 */
const CURVE_MIN_PULL = 40;
/** 曲线采样段数 */
const CURVE_SAMPLES = 24;

/* ------------------------------------------------------------------ */
/* 基础矩形与锚点                                                      */
/* ------------------------------------------------------------------ */

/** 节点的包围盒矩形 */
export function nodeRect(node: DiagramNode): Rect {
  return { x: node.x, y: node.y, w: node.w, h: node.h };
}

/** 节点中心点 */
export function nodeCenter(node: DiagramNode): Point {
  return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
}

/**
 * 端口坐标。
 *
 * - `top` / `right` / `bottom` / `left`：四边中点；
 * - `center`：节点中心；
 * - `auto`：没有第二个节点可参考时退化为 `center`（真正的自动选择在 `edgePath` 里做）。
 */
export function portPoint(node: DiagramNode, port: DiagramPort): Point {
  const { x, y, w, h } = node;
  switch (port) {
    case 'top':
      return { x: x + w / 2, y };
    case 'right':
      return { x: x + w, y: y + h / 2 };
    case 'bottom':
      return { x: x + w / 2, y: y + h };
    case 'left':
      return { x, y: y + h / 2 };
    case 'center':
    case 'auto':
    default:
      return { x: x + w / 2, y: y + h / 2 };
  }
}

/**
 * 判断点是否落在节点形状内部（含边界）。
 *
 * 不同形状的判定规则：
 * - `rect` / `roundRect` / `text` / `cylinder` / `document`：按矩形判定
 *   （圆角、圆柱顶面、文档波浪底的视觉差异只在渲染层，命中用外接矩形，手感更稳）；
 * - `ellipse` / `circle`：椭圆方程；
 * - `diamond`：菱形四边，用 |dx|/rx + |dy|/ry <= 1；
 * - `parallelogram`：上下边平移，按 y 线性插值求该行的左右边界；
 * - `hexagon`：左右尖角，按 |dy| 求该行的水平内缩量。
 */
export function pointInNode(node: DiagramNode, point: Point): boolean {
  const { x, y, w, h } = node;
  if (w <= 0 || h <= 0) return false;
  const center = nodeCenter(node);
  const rx = w / 2;
  const ry = h / 2;
  const dx = point.x - center.x;
  const dy = point.y - center.y;

  switch (node.shape) {
    case 'ellipse':
    case 'circle':
      return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;

    case 'diamond':
      return Math.abs(dx) / rx + Math.abs(dy) / ry <= 1;

    case 'parallelogram': {
      // 纵向相对位置：0 = 顶边，1 = 底边
      const t = (point.y - y) / h;
      if (t < 0 || t > 1) return false;
      const skew = w * PARALLELOGRAM_SKEW_RATIO;
      const left = x + skew * (1 - t);
      const right = x + w - skew * t;
      return point.x >= left && point.x <= right;
    }

    case 'hexagon': {
      // 上下边完整、左右各收一个尖角；越靠近垂直中线，可用宽度越大
      const inset = Math.min(w * HEXAGON_INSET_RATIO, h / 2);
      const t = Math.abs(dy) / ry; // 0 = 垂直中线，1 = 顶/底
      if (t > 1) return false;
      const pad = inset * t;
      return point.x >= x + pad && point.x <= x + w - pad;
    }

    case 'rect':
    case 'roundRect':
    case 'cylinder':
    case 'document':
    case 'text':
    default:
      return point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h;
  }
}

/** 两个矩形是否相交（必须有正面积重叠；仅相切不算） */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 一组节点的整体包围盒；空数组返回 null */
export function boundsOf(nodes: DiagramNode[]): Rect | null {
  if (!nodes.length) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.w);
    maxY = Math.max(maxY, node.y + node.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/* ------------------------------------------------------------------ */
/* 连线路径                                                            */
/* ------------------------------------------------------------------ */

/** 沿端口法线向外偏移 `k` 像素（曲线的控制点用） */
function offsetAlongPort(point: Point, port: DiagramPort, k: number): Point {
  switch (port) {
    case 'top':
      return { x: point.x, y: point.y - k };
    case 'bottom':
      return { x: point.x, y: point.y + k };
    case 'left':
      return { x: point.x - k, y: point.y };
    case 'right':
      return { x: point.x + k, y: point.y };
    case 'center':
    case 'auto':
    default:
      return { x: point.x, y: point.y };
  }
}

/**
 * 自动端口：选朝向参考点的那条边。
 *
 * `from` 端参考「目标」、`to` 端参考「源」，两端公式一致 ——
 * 都是「哪条边朝着对方就选哪条」，因此连线不会绕到节点背面。
 */
function portFacing(node: DiagramNode, ref: Point): DiagramPort {
  const center = nodeCenter(node);
  const dx = ref.x - center.x;
  const dy = ref.y - center.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

/** 端点解析结果 */
interface ResolvedEnd {
  point: Point;
  /** 实际生效的端口（auto 会被替换成具体边） */
  port: DiagramPort;
  node: DiagramNode | null;
}

/** 另一端的参考点：节点取中心，自由端点取其坐标 */
function referencePoint(edge: DiagramEdge, nodes: Map<string, DiagramNode>, role: 'from' | 'to'): Point {
  const nodeId = role === 'from' ? edge.from : edge.to;
  const freePoint = role === 'from' ? edge.fromPoint : edge.toPoint;
  const node = nodeId ? nodes.get(nodeId) ?? null : null;
  return node ? nodeCenter(node) : freePoint ?? { x: 0, y: 0 };
}

/** 把「节点 + 端口」或「自由坐标」解析成具体锚点；auto 留给 finalizePort 处理 */
function resolveEnd(edge: DiagramEdge, nodes: Map<string, DiagramNode>, role: 'from' | 'to'): ResolvedEnd {
  const nodeId = role === 'from' ? edge.from : edge.to;
  const freePoint = role === 'from' ? edge.fromPoint : edge.toPoint;
  const rawPort = (role === 'from' ? edge.fromPort : edge.toPort) ?? 'auto';
  const node = nodeId ? nodes.get(nodeId) ?? null : null;

  if (!node) {
    return { point: freePoint ?? { x: 0, y: 0 }, port: rawPort === 'auto' ? 'center' : rawPort, node: null };
  }
  if (rawPort === 'auto') {
    // auto 先用中心点占位，随后由 finalizePort 用对侧参考点改写
    return { point: nodeCenter(node), port: 'auto', node };
  }
  return { point: portPoint(node, rawPort), port: rawPort, node };
}

/** 用对侧参考点落实 auto 端口 */
function finalizePort(end: ResolvedEnd, ref: Point): ResolvedEnd {
  if (!end.node || end.port !== 'auto') return end;
  const port = portFacing(end.node, ref);
  return { point: portPoint(end.node, port), port, node: end.node };
}

/** 数值保留 3 位小数，避免 d 字符串过长 */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 单位向量：a → b（零长度返回 {0,0}） */
function direction(a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: 0, y: 0 };
  return { x: dx / len, y: dy / len };
}

/** 由点序列生成 polyline 的 d */
function polylineD(points: Point[]): string {
  if (!points.length) return '';
  const head = points[0] as Point;
  return [`M ${round(head.x)} ${round(head.y)}`, ...points.slice(1).map((p) => `L ${round(p.x)} ${round(p.y)}`)].join(' ');
}

/** 连线内部计算结果（比对外暴露的 EdgePath 多带采样点，供命中测试与箭头绘制复用） */
interface ComputedEdge extends EdgePath {
  /** 用于命中测试的点序列（直线/折线为顶点，曲线为 24 段采样） */
  points: Point[];
  /** 是否需要按曲线绘制 */
  kind: 'line' | 'polyline' | 'curve';
}

/**
 * 计算连线的完整几何信息（内部实现）。
 *
 * 三种形态的优先级：`waypoints`（正交折线）→ `curved`（贝塞尔）→ 直线。
 */
function computeEdge(edge: DiagramEdge, nodes: DiagramNode[]): ComputedEdge {
  const map = new Map<string, DiagramNode>();
  for (const node of nodes) map.set(node.id, node);

  const startEnd = finalizePort(resolveEnd(edge, map, 'from'), referencePoint(edge, map, 'to'));
  const endEnd = finalizePort(resolveEnd(edge, map, 'to'), referencePoint(edge, map, 'from'));

  const waypoints = edge.waypoints ?? [];
  const isCurve = Boolean(edge.curved) && waypoints.length === 0;

  const lineWidth = edge.lineWidth ?? 1.5;
  const hasStartArrow = Boolean(edge.startArrow) && edge.startArrow !== 'none';
  const hasEndArrow = Boolean(edge.endArrow) && edge.endArrow !== 'none';
  const back = lineWidth * 2;

  const rawStart = startEnd.point;
  const rawEnd = endEnd.point;
  const span = Math.hypot(rawEnd.x - rawStart.x, rawEnd.y - rawStart.y);
  const maxBack = span * 0.3;

  if (isCurve) {
    const ddx = rawEnd.x - rawStart.x;
    const ddy = rawEnd.y - rawStart.y;
    const pull = Math.max(CURVE_MIN_PULL, span * 0.4);
    const horizontal = Math.abs(ddx) >= Math.abs(ddy);
    // center 端口没有法线方向：按主轴拉出控制点，避免垂直相对的连线被扭成 S 形
    const c1 =
      startEnd.port === 'center' || startEnd.port === 'auto'
        ? horizontal
          ? { x: rawStart.x + ddx * 0.4, y: rawStart.y }
          : { x: rawStart.x, y: rawStart.y + ddy * 0.4 }
        : offsetAlongPort(rawStart, startEnd.port, pull);
    const c2 =
      endEnd.port === 'center' || endEnd.port === 'auto'
        ? horizontal
          ? { x: rawEnd.x - ddx * 0.4, y: rawEnd.y }
          : { x: rawEnd.x, y: rawEnd.y - ddy * 0.4 }
        : offsetAlongPort(rawEnd, endEnd.port, pull);

    let start = rawStart;
    let end = rawEnd;
    if (span > 0) {
      if (hasStartArrow) {
        const dir = direction(c1, start);
        const amount = Math.min(back, maxBack);
        start = { x: start.x + dir.x * amount, y: start.y + dir.y * amount };
      }
      if (hasEndArrow) {
        const dir = direction(c2, end);
        const amount = Math.min(back, maxBack);
        end = { x: end.x + dir.x * amount, y: end.y + dir.y * amount };
      }
    }

    // 采样点用未回退的原始贝塞尔，命中测试不应受箭头回退影响
    const points: Point[] = [];
    for (let i = 0; i <= CURVE_SAMPLES; i += 1) {
      const t = i / CURVE_SAMPLES;
      const mt = 1 - t;
      points.push({
        x: mt * mt * mt * rawStart.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * rawEnd.x,
        y: mt * mt * mt * rawStart.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * rawEnd.y,
      });
    }

    const d = [
      `M ${round(start.x)} ${round(start.y)}`,
      `C ${round(c1.x)} ${round(c1.y)}`,
      `${round(c2.x)} ${round(c2.y)}`,
      `${round(end.x)} ${round(end.y)}`,
    ].join(' ');
    return { d, start, end, points, kind: 'curve' };
  }

  /* 折线 / 直线：先拼点序列，再对首尾做回退 */
  const points: Point[] = [rawStart, ...waypoints.map((p) => ({ x: p.x, y: p.y })), rawEnd];
  let start = rawStart;
  let end = rawEnd;

  if (hasStartArrow && points.length >= 2) {
    const dir = direction(points[1] as Point, start);
    const amount = Math.min(back, maxBack);
    start = { x: start.x + dir.x * amount, y: start.y + dir.y * amount };
    points[0] = start;
  }
  if (hasEndArrow && points.length >= 2) {
    const dir = direction(points[points.length - 2] as Point, end);
    const amount = Math.min(back, maxBack);
    end = { x: end.x + dir.x * amount, y: end.y + dir.y * amount };
    points[points.length - 1] = end;
  }

  return {
    d: polylineD(points),
    start,
    end,
    points,
    kind: waypoints.length ? 'polyline' : 'line',
  };
}

/**
 * 计算连线的 SVG 路径，返回 `{ d, start, end }`。
 *
 * - `start` / `end` 是**箭头回退后**的锚点，UI 直接在这两点上画箭头即可，
 *   不会出现箭头尖端被节点描边压住的问题；回退量 = `lineWidth * 2`，
 *   且不超过线段长度的 30%（超短连线不会被回退成零长度）。
 * - 两端都是 `auto` 端口时，会自动选择朝向对方的那条边。
 */
export function edgePath(edge: DiagramEdge, nodes: DiagramNode[]): EdgePath {
  const computed = computeEdge(edge, nodes);
  return { d: computed.d, start: computed.start, end: computed.end };
}

/**
 * 连线的采样点序列（命中测试与导出箭头用）。
 *
 * - 直线/折线：返回顶点（未回退的原始锚点）；
 * - 曲线：返回 24 段贝塞尔采样。
 */
export function edgeSamplePoints(edge: DiagramEdge, nodes: DiagramNode[]): Point[] {
  return computeEdge(edge, nodes).points;
}

/** 连线的绘制形态：直线 / 正交折线 / 曲线 */
export function edgeKind(edge: DiagramEdge): 'line' | 'polyline' | 'curve' {
  if (edge.curved && (!edge.waypoints || edge.waypoints.length === 0)) return 'curve';
  return edge.waypoints && edge.waypoints.length ? 'polyline' : 'line';
}
