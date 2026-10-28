/**
 * 流程图 / 思维导图共用：节点形状的 SVG 渲染描述 + 左侧图形库目录。
 *
 * 为什么单独抽一个 .ts 而不是写在组件里：
 * - `DiagramCanvas.vue`（画布）与 `FlowchartEditor.vue`（图形库缩略图）都要画同一套形状，
 *   抽出来保证两处外观完全一致；
 * - 形状用「元素描述对象」返回（tag + attrs），而不是返回字符串 HTML，
 *   这样画布可以用 Vue 模板绑定（可加事件、可响应 hover），导出仍走引擎的 `exportToSvg`。
 *
 * 坐标约定：全部使用节点自身的世界坐标（node.x / node.y / node.w / node.h），
 * 与 `packages/core/src/diagram/serialize.ts` 的 `renderNodeSvg()` 保持同一套几何，
 * 确保「编辑时看到的」与「导出的 SVG」视觉一致。
 */
import type { DiagramArrow, DiagramNode, DiagramNodeShape } from '@neomd/shared';

/** 一个 SVG 图元的描述（tag + 属性），由模板用 v-bind 绑定 */
export interface ShapeElement {
  tag: 'rect' | 'ellipse' | 'circle' | 'polygon' | 'path';
  attrs: Record<string, string | number>;
}

/** 节点配色 */
export interface NodePaint {
  fill: string;
  stroke: string;
  /** 描边宽度，默认 1.5 */
  strokeWidth?: number;
}

/** 默认配色（与主题呼应：浅蓝填充 + 蓝色描边 + 深色文字） */
export const DEFAULT_NODE_FILL = '#e8f2ff';
export const DEFAULT_NODE_STROKE = '#1677ff';
export const DEFAULT_NODE_COLOR = '#1a1d21';
export const DEFAULT_EDGE_STROKE = '#8a919c';

/** 保留两位小数，避免 SVG 属性出现超长浮点串 */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 把数字数组转成 polygon 的 points 串 */
function toPoints(pairs: Array<[number, number]>): string {
  return pairs.map(([x, y]) => `${round(x)},${round(y)}`).join(' ');
}

/**
 * 生成节点形状的 SVG 图元列表。
 *
 * - `rect` / `roundRect` → 1 个 rect（roundRect 带 rx/ry）
 * - `ellipse` → ellipse；`circle` → circle（按 min(w,h) 取半径，允许椭圆化拉伸）
 * - `diamond` / `parallelogram` / `hexagon` → polygon
 * - `cylinder` → path（柱体）+ ellipse（顶盖）
 * - `document` → path（底部波浪）
 * - `text` → 空数组（纯文字，无底无边）
 */
export function nodeShapeElement(node: DiagramNode, paint: NodePaint): ShapeElement[] {
  const { x, y, w, h } = node;
  const fill = paint.fill;
  const stroke = paint.stroke;
  const sw = paint.strokeWidth ?? 1.5;
  const base = { fill, stroke, 'stroke-width': sw };

  switch (node.shape) {
    case 'text':
      return [];

    case 'roundRect': {
      const r = node.radius ?? 10;
      return [{ tag: 'rect', attrs: { x: round(x), y: round(y), width: round(w), height: round(h), rx: r, ry: r, ...base } }];
    }

    case 'ellipse':
      return [
        {
          tag: 'ellipse',
          attrs: { cx: round(x + w / 2), cy: round(y + h / 2), rx: round(w / 2), ry: round(h / 2), ...base },
        },
      ];

    case 'circle': {
      const r = Math.min(w, h) / 2;
      return [{ tag: 'circle', attrs: { cx: round(x + w / 2), cy: round(y + h / 2), r: round(r), ...base } }];
    }

    case 'diamond': {
      const pts = toPoints([
        [x + w / 2, y],
        [x + w, y + h / 2],
        [x + w / 2, y + h],
        [x, y + h / 2],
      ]);
      return [{ tag: 'polygon', attrs: { points: pts, ...base } }];
    }

    case 'parallelogram': {
      const off = Math.min(24, w * 0.2);
      const pts = toPoints([
        [x + off, y],
        [x + w, y],
        [x + w - off, y + h],
        [x, y + h],
      ]);
      return [{ tag: 'polygon', attrs: { points: pts, ...base } }];
    }

    case 'hexagon': {
      const off = Math.min(22, w * 0.18);
      const pts = toPoints([
        [x + off, y],
        [x + w - off, y],
        [x + w, y + h / 2],
        [x + w - off, y + h],
        [x + off, y + h],
        [x, y + h / 2],
      ]);
      return [{ tag: 'polygon', attrs: { points: pts, ...base } }];
    }

    case 'cylinder': {
      const ry = Math.min(12, h * 0.18);
      const body = `M${round(x)} ${round(y + ry)} A ${round(w / 2)} ${round(ry)} 0 0 1 ${round(x + w)} ${round(y + ry)} V${round(
        y + h - ry,
      )} A ${round(w / 2)} ${round(ry)} 0 0 1 ${round(x)} ${round(y + h - ry)} Z`;
      return [
        { tag: 'path', attrs: { d: body, ...base } },
        {
          tag: 'ellipse',
          attrs: {
            cx: round(x + w / 2),
            cy: round(y + ry),
            rx: round(w / 2),
            ry: round(ry),
            fill: 'none',
            stroke,
            'stroke-width': sw,
          },
        },
      ];
    }

    case 'document': {
      const wave = h * 0.12;
      const d = `M${round(x)} ${round(y)} H${round(x + w)} V${round(y + h - wave)} Q ${round(x + w * 0.75)} ${round(
        y + h + wave,
      )} ${round(x + w / 2)} ${round(y + h - wave * 0.6)} Q ${round(x + w * 0.25)} ${round(y + h - wave * 2)} ${round(
        x,
      )} ${round(y + h - wave)} Z`;
      return [{ tag: 'path', attrs: { d, ...base } }];
    }

    default: {
      const r = node.radius ?? 2;
      return [{ tag: 'rect', attrs: { x: round(x), y: round(y), width: round(w), height: round(h), rx: r, ry: r, ...base } }];
    }
  }
}

/**
 * 把节点文字按换行拆行，并给出每行的基线 y。
 *
 * 画布与导出一致：整体在节点垂直居中，行距 = 字号 × 1.35。
 */
export function nodeTextLines(node: DiagramNode): Array<{ text: string; x: number; y: number }> {
  const fs = node.fontSize ?? 13;
  const lines = String(node.text ?? '').split('\n');
  if (!lines.length || lines.every((l) => l === '')) return [];
  const lineH = fs * 1.35;
  const startY = node.y + node.h / 2 - ((lines.length - 1) * lineH) / 2;
  const cx = node.x + node.w / 2;
  return lines.map((text, i) => ({ text, x: round(cx), y: round(startY + i * lineH) }));
}

/* ------------------------------------------------------------------ */
/* 连线箭头                                                            */
/* ------------------------------------------------------------------ */

/**
 * 生成连线箭头图元。
 *
 * `at` 是箭头尖端（端点），`from` 是线上相邻点（用来算方向）。
 * 返回 null 表示不画（none / 未知类型）。
 */
export function arrowShapeElement(
  at: { x: number; y: number },
  from: { x: number; y: number },
  kind: DiagramArrow,
  color: string,
  lineWidth: number,
): ShapeElement | null {
  if (!kind || kind === 'none') return null;
  const angle = Math.atan2(at.y - from.y, at.x - from.x);
  const size = Math.max(8, lineWidth * 4);

  if (kind === 'arrow' || kind === 'triangle') {
    const spread = kind === 'arrow' ? Math.PI * 0.85 : Math.PI * 0.78;
    const a1 = angle + spread;
    const a2 = angle - spread;
    const pts = toPoints([
      [at.x, at.y],
      [at.x + Math.cos(a1) * size, at.y + Math.sin(a1) * size],
      [at.x + Math.cos(a2) * size, at.y + Math.sin(a2) * size],
    ]);
    return { tag: 'polygon', attrs: { points: pts, fill: color } };
  }

  if (kind === 'circle') {
    return { tag: 'circle', attrs: { cx: round(at.x), cy: round(at.y), r: round(size * 0.42), fill: color } };
  }

  // diamond：以尖端为顶点、沿反方向展开的菱形
  const back = { x: at.x - Math.cos(angle) * size, y: at.y - Math.sin(angle) * size };
  const perp = { x: Math.cos(angle + Math.PI / 2), y: Math.sin(angle + Math.PI / 2) };
  const mid = { x: at.x - Math.cos(angle) * size * 0.5, y: at.y - Math.sin(angle) * size * 0.5 };
  const pts = toPoints([
    [at.x, at.y],
    [mid.x + perp.x * size * 0.4, mid.y + perp.y * size * 0.4],
    [back.x, back.y],
    [mid.x - perp.x * size * 0.4, mid.y - perp.y * size * 0.4],
  ]);
  return { tag: 'polygon', attrs: { points: pts, fill: color } };
}

/** 连线虚线样式 → stroke-dasharray */
export function dashArray(style?: string): string | undefined {
  if (style === 'dashed') return '6 4';
  if (style === 'dotted') return '2 3';
  return undefined;
}

/* ------------------------------------------------------------------ */
/* 左侧图形库目录                                                      */
/* ------------------------------------------------------------------ */

export interface ShapeLibraryItem {
  shape: DiagramNodeShape;
  /** 中文名（鼠标悬停提示 + 无障碍名称） */
  label: string;
  /** 拖到画布时的默认文字（空字符串表示不带文字） */
  text: string;
}

export interface ShapeLibraryGroup {
  id: string;
  /** 分组名（可折叠） */
  label: string;
  items: ShapeLibraryItem[];
}

/**
 * 图形库（对齐 ProcessOn 左侧面板的四组：基础图形 / 流程图 / 箭头 / 标注）。
 *
 * 箭头组不是节点形状，而是「连线工具」：拖到画布后进入连线模式，
 * 因此 shape 字段仍写成一个占位形状，由 FlowchartEditor 用 `tool` 字段区分。
 */
export const SHAPE_LIBRARY: ShapeLibraryGroup[] = [
  {
    id: 'basic',
    label: '基础图形',
    items: [
      { shape: 'rect', label: '矩形', text: '矩形' },
      { shape: 'roundRect', label: '圆角矩形', text: '圆角矩形' },
      { shape: 'ellipse', label: '椭圆', text: '椭圆' },
      { shape: 'circle', label: '圆形', text: '圆' },
      { shape: 'diamond', label: '菱形', text: '判断' },
      { shape: 'text', label: '文字', text: '文字' },
    ],
  },
  {
    id: 'flowchart',
    label: '流程图',
    items: [
      { shape: 'rect', label: '处理', text: '处理' },
      { shape: 'diamond', label: '判断', text: '条件？' },
      { shape: 'parallelogram', label: '数据', text: '数据' },
      { shape: 'hexagon', label: '准备', text: '准备' },
      { shape: 'cylinder', label: '数据库', text: '数据库' },
      { shape: 'document', label: '文档', text: '文档' },
      { shape: 'roundRect', label: '开始/结束', text: '开始' },
      { shape: 'ellipse', label: '连接', text: '连接' },
    ],
  },
  {
    id: 'arrow',
    label: '箭头',
    items: [
      { shape: 'rect', label: '直线箭头', text: '' },
      { shape: 'rect', label: '虚线箭头', text: '' },
      { shape: 'rect', label: '双向箭头', text: '' },
      { shape: 'rect', label: '曲线箭头', text: '' },
    ],
  },
  {
    id: 'annotation',
    label: '标注',
    items: [
      { shape: 'document', label: '便签', text: '备注' },
      { shape: 'hexagon', label: '标签', text: '标签' },
      { shape: 'parallelogram', label: '输入输出', text: '输入' },
      { shape: 'text', label: '标题文字', text: '标题' },
    ],
  },
];

/** 箭头组的下标（FlowchartEditor 用它判断「拖出来的是连线工具」） */
export const ARROW_GROUP_ID = 'arrow';
