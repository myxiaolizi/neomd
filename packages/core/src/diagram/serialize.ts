/**
 * 图文档序列化、容错解析与导出（1.1.0）。
 *
 * 设计约定：
 * - 文件格式是 JSON（`.mind` / `.flow`），`schema` 字段用于将来迁移；
 * - 解析必须**容错**：文件损坏、字段缺失、旧版本 schema 都不能让编辑器崩掉，
 *   宁可退化成空文档并给出可读提示；
 * - 导出 SVG 要能**独立打开**（不依赖外部 CSS 变量与字体），因此全部用内联属性。
 */
import type {
  DiagramDoc,
  DiagramEdge,
  DiagramKind,
  DiagramNode,
  DiagramSettings,
  DiagramNodeShape,
} from '@neomd/shared';
import { boundsOf, type Rect } from './geometry';
import { edgePath } from './geometry';

/** 当前文档格式版本。加字段不升版；改语义才升。 */
export const DIAGRAM_SCHEMA = 1;

/** 默认画布配置 */
const DEFAULT_CANVAS: DiagramDoc['canvas'] = {
  background: '#ffffff',
  grid: 'dot',
  gridSize: 20,
  showGrid: true,
  snapToGrid: true,
};

/** 各形状的默认尺寸（拖入画布时用） */
export const SHAPE_DEFAULT_SIZE: Record<DiagramNodeShape, { w: number; h: number }> = {
  rect: { w: 140, h: 56 },
  roundRect: { w: 140, h: 56 },
  ellipse: { w: 140, h: 56 },
  diamond: { w: 130, h: 80 },
  parallelogram: { w: 150, h: 56 },
  hexagon: { w: 150, h: 60 },
  cylinder: { w: 130, h: 70 },
  document: { w: 140, h: 64 },
  circle: { w: 72, h: 72 },
  text: { w: 120, h: 32 },
};

let seq = 0;
/** 生成稳定的节点/连线 id（带时间戳前缀，避免跨会话重复） */
export function diagramId(prefix = 'n'): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`;
}

/**
 * 创建空图文档。
 *
 * @param kind mindmap | flowchart
 * @param settings 来自 `Settings.diagram` 的默认值；缺省时用内置兜底
 * @param title 标题
 */
export function createEmptyDoc(
  kind: DiagramKind,
  settings?: Partial<DiagramSettings>,
  title?: string,
): DiagramDoc {
  const now = Date.now();
  const doc: DiagramDoc = {
    schema: DIAGRAM_SCHEMA,
    kind,
    title: title ?? (kind === 'mindmap' ? '未命名思维导图' : '未命名流程图'),
    nodes: [],
    edges: [],
    canvas: {
      ...DEFAULT_CANVAS,
      grid: settings?.grid ?? DEFAULT_CANVAS.grid,
      gridSize: settings?.gridSize ?? DEFAULT_CANVAS.gridSize,
      snapToGrid: settings?.snapToGrid ?? DEFAULT_CANVAS.snapToGrid,
    },
    createdAt: now,
    updatedAt: now,
  };
  if (kind === 'mindmap') {
    doc.mindmapLayout = settings?.mindmapLayout ?? 'right';
    // 思维导图默认给一个根节点，用户打开即可编辑，符合 ProcessOn 的体验
    doc.nodes.push({
      id: diagramId(),
      shape: 'roundRect',
      x: 0,
      y: 0,
      w: 160,
      h: 52,
      text: '中心主题',
      level: 0,
      fill: settings?.nodeFill ?? '#e8f2ff',
      stroke: settings?.nodeStroke ?? '#1677FF',
      fontSize: 15,
      bold: true,
    });
  }
  return doc;
}

/** 创建一个指定形状的节点（拖入画布时用） */
export function createNode(
  shape: DiagramNodeShape,
  x: number,
  y: number,
  settings?: Partial<DiagramSettings>,
  text = '',
): DiagramNode {
  const size = SHAPE_DEFAULT_SIZE[shape] ?? SHAPE_DEFAULT_SIZE.rect;
  return {
    id: diagramId(),
    shape,
    // 以落点为中心放置，符合「拖到哪就在哪」的直觉
    x: Math.round(x - size.w / 2),
    y: Math.round(y - size.h / 2),
    w: size.w,
    h: size.h,
    text: text || defaultTextFor(shape),
    fill: settings?.nodeFill ?? '#e8f2ff',
    stroke: settings?.nodeStroke ?? '#1677FF',
    fontSize: 13,
  };
}

function defaultTextFor(shape: DiagramNodeShape): string {
  switch (shape) {
    case 'diamond':
      return '判断';
    case 'ellipse':
    case 'circle':
      return '开始';
    case 'cylinder':
      return '数据';
    case 'document':
      return '文档';
    case 'text':
      return '文字';
    default:
      return '节点';
  }
}

/** 创建一条连线 */
export function createEdge(
  from: string,
  to: string,
  settings?: Partial<DiagramSettings>,
): DiagramEdge {
  return {
    id: diagramId('e'),
    from,
    to,
    fromPort: 'auto',
    toPort: 'auto',
    endArrow: 'arrow',
    startArrow: 'none',
    lineStyle: 'solid',
    lineWidth: 1.5,
    stroke: settings?.edgeStroke ?? '#8a919c',
    curved: true,
  };
}

/**
 * 容错解析图文档。
 *
 * 面向真实使用场景：文件可能被手工编辑坏、可能来自更早的版本、
 * 甚至可能是空文件（新建后还没写入）。任何异常都返回 null 而不抛错，
 * 由调用方决定退化成空文档还是提示用户。
 */
export function parseDiagramDoc(raw: string, kind: DiagramKind = 'flowchart'): DiagramDoc | null {
  if (!raw || !raw.trim()) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const d = data as Partial<DiagramDoc>;
  if (!Array.isArray(d.nodes)) return null;

  const nodes: DiagramNode[] = d.nodes
    .filter((n): n is DiagramNode => Boolean(n) && typeof (n as DiagramNode).id === 'string')
    .map((n) => ({
      id: String(n.id),
      shape: (n.shape ?? 'rect') as DiagramNodeShape,
      x: num(n.x, 0),
      y: num(n.y, 0),
      w: Math.max(8, num(n.w, 120)),
      h: Math.max(8, num(n.h, 48)),
      text: typeof n.text === 'string' ? n.text : '',
      fill: n.fill,
      stroke: n.stroke,
      color: n.color,
      fontSize: n.fontSize,
      bold: Boolean(n.bold),
      italic: Boolean(n.italic),
      radius: n.radius,
      level: typeof n.level === 'number' ? n.level : undefined,
      collapsed: Boolean(n.collapsed),
      icon: n.icon,
      note: n.note,
      locked: Boolean(n.locked),
    }));

  const ids = new Set(nodes.map((n) => n.id));
  const edges: DiagramEdge[] = (Array.isArray(d.edges) ? d.edges : [])
    .filter((e): e is DiagramEdge => Boolean(e) && typeof (e as DiagramEdge).id === 'string')
    // 悬空连线（端点节点已被删）直接丢弃，避免渲染出幽灵线
    .filter((e) => (!e.from || ids.has(e.from)) && (!e.to || ids.has(e.to)))
    .map((e) => ({
      id: String(e.id),
      from: e.from,
      to: e.to,
      fromPort: e.fromPort ?? 'auto',
      toPort: e.toPort ?? 'auto',
      fromPoint: e.fromPoint,
      toPoint: e.toPoint,
      label: e.label,
      startArrow: e.startArrow ?? 'none',
      endArrow: e.endArrow ?? 'arrow',
      lineStyle: e.lineStyle ?? 'solid',
      lineWidth: num(e.lineWidth, 1.5),
      stroke: e.stroke,
      waypoints: Array.isArray(e.waypoints) ? e.waypoints : undefined,
      curved: typeof e.curved === 'boolean' ? e.curved : true,
    }));

  return {
    schema: num(d.schema, DIAGRAM_SCHEMA),
    kind: (d.kind === 'mindmap' || d.kind === 'flowchart' ? d.kind : kind) as DiagramKind,
    title: typeof d.title === 'string' ? d.title : '未命名图',
    nodes,
    edges,
    canvas: {
      background: d.canvas?.background ?? DEFAULT_CANVAS.background,
      grid: d.canvas?.grid ?? DEFAULT_CANVAS.grid,
      gridSize: num(d.canvas?.gridSize, DEFAULT_CANVAS.gridSize),
      showGrid: d.canvas?.showGrid !== false,
      snapToGrid: d.canvas?.snapToGrid !== false,
    },
    viewport: d.viewport,
    mindmapLayout: d.mindmapLayout,
    createdAt: num(d.createdAt, Date.now()),
    updatedAt: num(d.updatedAt, Date.now()),
  };
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 序列化为文件内容（紧凑 JSON，避免大图文件臃肿） */
export function serializeDiagramDoc(doc: DiagramDoc): string {
  return JSON.stringify({ ...doc, updatedAt: Date.now() });
}

/* ------------------------------------------------------------------ */
/* 导出 SVG                                                            */
/* ------------------------------------------------------------------ */

export interface SvgExportOptions {
  /** 四周留白（世界坐标单位） */
  padding?: number;
  /** 背景色；传 'transparent' 则不画背景 */
  background?: string;
  /** 是否绘制网格 */
  withGrid?: boolean;
  /** 标题（写入 <title> 便于无障碍与分享） */
  title?: string;
}

const FONT_STACK = "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif";

/**
 * 导出为可独立打开的 SVG。
 *
 * 要点：
 * - 用 `boundsOf()` 算出内容包围盒，自动加 padding，导出图不会被裁切；
 * - **不使用 CSS 变量**（外部打开时变量失效会变成黑块），颜色全部内联；
 * - 文字用 `dominant-baseline="middle"` 垂直居中，多行按 `\n` 拆 `tspan`。
 */
export function exportToSvg(doc: DiagramDoc, options: SvgExportOptions = {}): string {
  const padding = options.padding ?? 40;
  const bg = options.background ?? doc.canvas.background ?? '#ffffff';
  const box = boundsOf(doc.nodes) ?? ({ x: 0, y: 0, w: 400, h: 300 } as Rect);

  const minX = box.x - padding;
  const minY = box.y - padding;
  const width = Math.max(1, box.w + padding * 2);
  const height = Math.max(1, box.h + padding * 2);

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width)}" height="${round(height)}" viewBox="${round(minX)} ${round(minY)} ${round(width)} ${round(height)}" font-family="${escapeAttr(FONT_STACK)}">`,
  );
  if (options.title) parts.push(`<title>${escapeText(options.title)}</title>`);

  if (bg && bg !== 'transparent') {
    parts.push(`<rect x="${round(minX)}" y="${round(minY)}" width="${round(width)}" height="${round(height)}" fill="${escapeAttr(bg)}"/>`);
  }

  // 网格（可选）：仅在有意义时导出，默认关闭以保持图片干净
  if (options.withGrid && doc.canvas.showGrid) {
    parts.push(renderGrid(doc, minX, minY, width, height));
  }

  // 先画连线再画节点，避免线压住节点文字
  for (const edge of doc.edges) {
    parts.push(renderEdgeSvg(edge, doc.nodes));
  }
  for (const node of doc.nodes) {
    parts.push(renderNodeSvg(node));
  }

  parts.push('</svg>');
  return parts.join('\n');
}

function renderGrid(doc: DiagramDoc, minX: number, minY: number, w: number, h: number): string {
  const g = Math.max(4, doc.canvas.gridSize || 20);
  const color = 'rgba(15,23,42,0.08)';
  const x0 = Math.floor(minX / g) * g;
  const y0 = Math.floor(minY / g) * g;
  const segs: string[] = [];
  for (let x = x0; x <= minX + w; x += g) segs.push(`M${round(x)} ${round(minY)}V${round(minY + h)}`);
  for (let y = y0; y <= minY + h; y += g) segs.push(`M${round(minX)} ${round(y)}H${round(minX + w)}`);
  return `<path d="${segs.join('')}" stroke="${color}" stroke-width="1" fill="none"/>`;
}

function renderNodeSvg(node: DiagramNode): string {
  const fill = node.fill ?? '#e8f2ff';
  const stroke = node.stroke ?? '#1677FF';
  const color = node.color ?? '#1a1d21';
  const fs = node.fontSize ?? 13;
  const sw = 1.5;
  const { x, y, w, h } = node;

  let shape = '';
  switch (node.shape) {
    case 'ellipse':
      shape = `<ellipse cx="${round(x + w / 2)}" cy="${round(y + h / 2)}" rx="${round(w / 2)}" ry="${round(h / 2)}" fill="${escapeAttr(fill)}" stroke="${escapeAttr(stroke)}" stroke-width="${sw}"/>`;
      break;
    case 'circle': {
      const r = Math.min(w, h) / 2;
      shape = `<circle cx="${round(x + w / 2)}" cy="${round(y + h / 2)}" r="${round(r)}" fill="${escapeAttr(fill)}" stroke="${escapeAttr(stroke)}" stroke-width="${sw}"/>`;
      break;
    }
    case 'diamond': {
      const p = `${round(x + w / 2)},${round(y)} ${round(x + w)},${round(y + h / 2)} ${round(x + w / 2)},${round(y + h)} ${round(x)},${round(y + h / 2)}`;
      shape = `<polygon points="${p}" fill="${escapeAttr(fill)}" stroke="${escapeAttr(stroke)}" stroke-width="${sw}"/>`;
      break;
    }
    case 'parallelogram': {
      const off = Math.min(24, w * 0.2);
      const p = `${round(x + off)},${round(y)} ${round(x + w)},${round(y)} ${round(x + w - off)},${round(y + h)} ${round(x)},${round(y + h)}`;
      shape = `<polygon points="${p}" fill="${escapeAttr(fill)}" stroke="${escapeAttr(stroke)}" stroke-width="${sw}"/>`;
      break;
    }
    case 'hexagon': {
      const off = Math.min(22, w * 0.18);
      const p = [
        `${round(x + off)},${round(y)}`,
        `${round(x + w - off)},${round(y)}`,
        `${round(x + w)},${round(y + h / 2)}`,
        `${round(x + w - off)},${round(y + h)}`,
        `${round(x + off)},${round(y + h)}`,
        `${round(x)},${round(y + h / 2)}`,
      ].join(' ');
      shape = `<polygon points="${p}" fill="${escapeAttr(fill)}" stroke="${escapeAttr(stroke)}" stroke-width="${sw}"/>`;
      break;
    }
    case 'cylinder': {
      const ry = Math.min(12, h * 0.18);
      shape =
        `<path d="M${round(x)} ${round(y + ry)} A ${round(w / 2)} ${round(ry)} 0 0 1 ${round(x + w)} ${round(y + ry)} ` +
        `V${round(y + h - ry)} A ${round(w / 2)} ${round(ry)} 0 0 1 ${round(x)} ${round(y + h - ry)} Z" ` +
        `fill="${escapeAttr(fill)}" stroke="${escapeAttr(stroke)}" stroke-width="${sw}"/>` +
        `<ellipse cx="${round(x + w / 2)}" cy="${round(y + ry)}" rx="${round(w / 2)}" ry="${round(ry)}" fill="none" stroke="${escapeAttr(stroke)}" stroke-width="${sw}"/>`;
      break;
    }
    case 'document': {
      const wave = h * 0.12;
      shape =
        `<path d="M${round(x)} ${round(y)} H${round(x + w)} V${round(y + h - wave)} ` +
        `Q ${round(x + w * 0.75)} ${round(y + h + wave)} ${round(x + w / 2)} ${round(y + h - wave * 0.6)} ` +
        `Q ${round(x + w * 0.25)} ${round(y + h - wave * 2)} ${round(x)} ${round(y + h - wave)} Z" ` +
        `fill="${escapeAttr(fill)}" stroke="${escapeAttr(stroke)}" stroke-width="${sw}"/>`;
      break;
    }
    case 'text':
      // 纯文字：不画底
      shape = '';
      break;
    case 'roundRect':
      shape = `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" rx="${round(node.radius ?? 10)}" ry="${round(node.radius ?? 10)}" fill="${escapeAttr(fill)}" stroke="${escapeAttr(stroke)}" stroke-width="${sw}"/>`;
      break;
    default:
      shape = `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" rx="${round(node.radius ?? 2)}" ry="${round(node.radius ?? 2)}" fill="${escapeAttr(fill)}" stroke="${escapeAttr(stroke)}" stroke-width="${sw}"/>`;
  }

  const lines = String(node.text ?? '').split('\n');
  const lineH = fs * 1.35;
  const startY = y + h / 2 - ((lines.length - 1) * lineH) / 2;
  const tspans = lines
    .map(
      (line, i) =>
        `<tspan x="${round(x + w / 2)}" y="${round(startY + i * lineH)}">${escapeText(line)}</tspan>`,
    )
    .join('');
  const text =
    lines.length && lines.some((l) => l !== '')
      ? `<text text-anchor="middle" dominant-baseline="middle" font-size="${fs}" font-weight="${node.bold ? 700 : 400}" font-style="${node.italic ? 'italic' : 'normal'}" fill="${escapeAttr(color)}">${tspans}</text>`
      : '';

  return `<g>${shape}${text}</g>`;
}

function renderEdgeSvg(edge: DiagramEdge, nodes: DiagramNode[]): string {
  const path = edgePath(edge, nodes);
  const stroke = edge.stroke ?? '#8a919c';
  const lw = edge.lineWidth ?? 1.5;
  const dash =
    edge.lineStyle === 'dashed' ? ' stroke-dasharray="6 4"' : edge.lineStyle === 'dotted' ? ' stroke-dasharray="2 3"' : '';
  const d = `stroke="${escapeAttr(stroke)}" stroke-width="${lw}" fill="none"${dash} stroke-linecap="round"`;

  const parts: string[] = [`<path d="${path.d}" ${d}/>`];
  parts.push(renderArrow(path.end, path.start, edge.endArrow ?? 'arrow', stroke, lw));
  if (edge.startArrow && edge.startArrow !== 'none') {
    parts.push(renderArrow(path.start, path.end, edge.startArrow, stroke, lw));
  }
  if (edge.label) {
    const mx = (path.start.x + path.end.x) / 2;
    const my = (path.start.y + path.end.y) / 2;
    parts.push(
      `<text x="${round(mx)}" y="${round(my - 6)}" text-anchor="middle" font-size="11" fill="${escapeAttr(stroke)}">${escapeText(edge.label)}</text>`,
    );
  }
  return `<g>${parts.join('')}</g>`;
}

/** 画箭头（三角/圆/菱形），角度按 from→to 方向计算 */
function renderArrow(
  at: { x: number; y: number },
  from: { x: number; y: number },
  kind: string,
  color: string,
  lw: number,
): string {
  if (!kind || kind === 'none') return '';
  const angle = Math.atan2(at.y - from.y, at.x - from.x);
  const size = Math.max(8, lw * 4);
  if (kind === 'arrow') {
    const a1 = angle + Math.PI * 0.85;
    const a2 = angle - Math.PI * 0.85;
    const p1 = `${round(at.x + Math.cos(a1) * size)},${round(at.y + Math.sin(a1) * size)}`;
    const p2 = `${round(at.x + Math.cos(a2) * size)},${round(at.y + Math.sin(a2) * size)}`;
    return `<polygon points="${round(at.x)},${round(at.y)} ${p1} ${p2}" fill="${escapeAttr(color)}"/>`;
  }
  if (kind === 'triangle') {
    const a1 = angle + Math.PI * 0.8;
    const a2 = angle - Math.PI * 0.8;
    const p1 = `${round(at.x + Math.cos(a1) * size * 1.4)},${round(at.y + Math.sin(a1) * size * 1.4)}`;
    const p2 = `${round(at.x + Math.cos(a2) * size * 1.4)},${round(at.y + Math.sin(a2) * size * 1.4)}`;
    return `<polygon points="${round(at.x)},${round(at.y)} ${p1} ${p2}" fill="${escapeAttr(color)}"/>`;
  }
  if (kind === 'circle') {
    return `<circle cx="${round(at.x)}" cy="${round(at.y)}" r="${round(size * 0.5)}" fill="${escapeAttr(color)}"/>`;
  }
  if (kind === 'diamond') {
    const s = size * 0.6;
    const p = `${round(at.x)},${round(at.y)} ${round(at.x - s)},${round(at.y - s)} ${round(at.x - s * 2)},${round(at.y)} ${round(at.x - s)},${round(at.y + s)}`;
    return `<polygon points="${p}" fill="${escapeAttr(color)}" transform="rotate(${round((angle * 180) / Math.PI)} ${round(at.x)} ${round(at.y)})"/>`;
  }
  return '';
}

/**
 * 导出 PNG（仅浏览器环境）。
 *
 * 做法：把 SVG 转成 data URL → 载入 Image → 画到 canvas → toBlob。
 * Node / 测试环境没有 Image/canvas，明确抛错而不是静默返回空。
 */
export async function exportToPng(doc: DiagramDoc, scale = 2, options: SvgExportOptions = {}): Promise<Blob> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    throw new Error('exportToPng 仅在浏览器环境可用（Node 环境请使用 exportToSvg）');
  }
  const svg = exportToSvg(doc, options);
  const box = boundsOf(doc.nodes) ?? ({ x: 0, y: 0, w: 400, h: 300 } as Rect);
  const padding = options.padding ?? 40;
  const w = Math.max(1, Math.round((box.w + padding * 2) * scale));
  const h = Math.max(1, Math.round((box.h + padding * 2) * scale));

  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const img = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 canvas 上下文');
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG 导出失败');
  return blob;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('SVG 转图片失败'));
    img.src = src;
  });
}

/* ------------------------------------------------------------------ */
/* Mermaid 子集导入                                                     */
/* ------------------------------------------------------------------ */

/**
 * 从 Mermaid 的 `graph TD/LR` 与 `mindmap` 语法还原图文档。
 *
 * 只支持最小子集（节点定义 `A[文本]`、`A(文本)`、`A{文本}`，连线 `A --> B`、
 * `A --- B`、`A -.-> B`）——目的是让用户能把旧 Mermaid 图搬进来重新编辑，
 * 不是完整实现 Mermaid。解析失败返回 null，由 UI 提示可手动绘制。
 */
export function importFromMermaid(text: string, settings?: Partial<DiagramSettings>): DiagramDoc | null {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('%%'));

  if (!lines.length) return null;

  const head = lines[0]!;
  const isMindmap = /^mindmap\b/i.test(head);
  const flowMatch = /^(?:graph|flowchart)\s+(TD|TB|BT|LR|RL)?/i.exec(head);
  if (!isMindmap && !flowMatch) return null;

  const doc = createEmptyDoc(isMindmap ? 'mindmap' : 'flowchart', settings);
  // 清掉 createEmptyDoc 给思维导图预置的根节点，完全由 Mermaid 内容决定
  doc.nodes = [];
  doc.edges = [];

  const labelMap = new Map<string, string>();
  const shapeMap = new Map<string, DiagramNodeShape>();
  const order: string[] = [];

  const ensureNode = (raw: string): string => {
    const token = raw.trim();
    // 形如 A[文本] / A(文本) / A{文本} / A((文本)) / A>文本]
    const m = /^([A-Za-z0-9_\u4e00-\u9fa5-]+)\s*(\(\(|\[|\(|\{|>)([\s\S]*?)(\)\)|\]|\)|\})?$/.exec(token);
    if (!m) {
      const id = token;
      if (!labelMap.has(id)) {
        labelMap.set(id, id);
        shapeMap.set(id, 'rect');
        order.push(id);
      }
      return id;
    }
    const id = m[1]!;
    const label = (m[3] ?? '').replace(/^["']|["']$/g, '').trim() || id;
    if (!labelMap.has(id)) order.push(id);
    labelMap.set(id, label);
    const open = m[2]!;
    shapeMap.set(
      id,
      open === '{' ? 'diamond' : open === '(( ' || open === '((' ? 'circle' : open === '>' ? 'document' : open === '(' ? 'roundRect' : 'rect',
    );
    return id;
  };

  const edgesRaw: Array<{ from: string; to: string; dashed: boolean; arrow: boolean; label?: string }> = [];

  for (const line of lines.slice(isMindmap || flowMatch ? 1 : 0)) {
    if (isMindmap) {
      // mindmap 用缩进表示层级，这里按缩进宽度算 level
      const indent = (line.match(/^\s*/)?.[0] ?? '').length;
      if (indent === 0) {
        ensureNode(line.replace(/^root\s*/, '').replace(/^[()\[\]{}]+|[()\[\]{}]+$/g, ''));
      }
      continue;
    }
    // 连线：A --> B / A --- B / A -.-> B / A ==> B（可带 |标签|）
    const lm =
      /^(.+?)\s*(-{2,3}>|-{3}|-\.->|={2,3}>)\s*(?:\|([^|]*)\|\s*)?(.+)$/.exec(line);
    if (lm) {
      const from = ensureNode(lm[1]!);
      const to = ensureNode(lm[4]!);
      const op = lm[2]!;
      edgesRaw.push({
        from,
        to,
        dashed: op.includes('.'),
        arrow: op.includes('>'),
        label: lm[3]?.trim() || undefined,
      });
      continue;
    }
    ensureNode(line);
  }

  // 排布：按顺序从左到右、每 4 个换行，足够看清即可（导入后用户可重新自动布局）
  const cols = 4;
  const gapX = 200;
  const gapY = 110;
  order.forEach((id, i) => {
    doc.nodes.push({
      id,
      shape: shapeMap.get(id) ?? 'rect',
      x: (i % cols) * gapX,
      y: Math.floor(i / cols) * gapY,
      w: 140,
      h: 56,
      text: labelMap.get(id) ?? id,
      fill: settings?.nodeFill ?? '#e8f2ff',
      stroke: settings?.nodeStroke ?? '#1677FF',
      fontSize: 13,
    });
  });

  for (const e of edgesRaw) {
    doc.edges.push({
      id: diagramId('e'),
      from: e.from,
      to: e.to,
      fromPort: 'auto',
      toPort: 'auto',
      endArrow: e.arrow ? 'arrow' : 'none',
      startArrow: 'none',
      lineStyle: e.dashed ? 'dashed' : 'solid',
      lineWidth: 1.5,
      stroke: settings?.edgeStroke ?? '#8a919c',
      label: e.label,
      curved: true,
    });
  }

  // 方向提示：TD/TB 时纵向排列更贴合原始语义
  const dir = flowMatch?.[1]?.toUpperCase();
  if (dir === 'TD' || dir === 'TB' || dir === 'BT') {
    order.forEach((id, i) => {
      const n = doc.nodes.find((x) => x.id === id);
      if (n) {
        n.x = Math.floor(i / cols) * gapX;
        n.y = (i % cols) * gapY;
      }
    });
  }

  return doc.nodes.length ? doc : null;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function escapeText(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}
