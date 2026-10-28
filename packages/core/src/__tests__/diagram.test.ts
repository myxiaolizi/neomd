/**
 * 图引擎冒烟测试（1.1.0）。
 *
 * 这是「对齐 ProcessOn」的地基验证：几何、命中、对齐、思维导图布局、
 * 序列化与导出必须先在算法层站得住，UI 才有意义。
 */
import { describe, expect, it } from 'vitest';
import { boundsOf, createNode as _createNode, edgePath, pointInNode } from '../diagram/geometry';
import { hitTest, nodesInRect } from '../diagram/hit-test';
import { alignNodes, distributeNodes, snapPoint } from '../diagram/align';
import { addChildNode, autoLayoutMindmap, collapseSubtree } from '../diagram/mindmap-layout';
import {
  createEdge,
  createEmptyDoc,
  createNode,
  exportToSvg,
  importFromMermaid,
  parseDiagramDoc,
  serializeDiagramDoc,
} from '../diagram/serialize';

describe('图引擎 · 文档创建', () => {
  it('流程图初始为空', () => {
    const doc = createEmptyDoc('flowchart', undefined, '测试流程');
    expect(doc.kind).toBe('flowchart');
    expect(doc.nodes).toHaveLength(0);
    expect(doc.title).toBe('测试流程');
  });

  it('思维导图预置根节点', () => {
    const doc = createEmptyDoc('mindmap');
    expect(doc.nodes).toHaveLength(1);
    expect(doc.nodes[0]!.text).toBe('中心主题');
    expect(doc.nodes[0]!.level).toBe(0);
  });

  it('按 DiagramSettings 应用画布默认值', () => {
    const doc = createEmptyDoc('flowchart', { gridSize: 32, grid: 'line', snapToGrid: false });
    expect(doc.canvas.gridSize).toBe(32);
    expect(doc.canvas.grid).toBe('line');
    expect(doc.canvas.snapToGrid).toBe(false);
  });
});

describe('图引擎 · 节点与连线', () => {
  it('各形状有合理默认尺寸', () => {
    expect(createNode('rect', 200, 100).w).toBe(140);
    expect(createNode('diamond', 200, 100).h).toBe(80);
    expect(createNode('circle', 200, 100).w).toBe(72);
  });

  it('节点以落点为中心放置', () => {
    const n = createNode('rect', 200, 100);
    expect(n.x).toBe(130);
    expect(n.y).toBe(72);
  });

  it('连线默认带终点箭头', () => {
    const a = createNode('rect', 0, 0);
    const b = createNode('rect', 300, 0);
    const e = createEdge(a.id, b.id);
    expect(e.from).toBe(a.id);
    expect(e.to).toBe(b.id);
    expect(e.endArrow).toBe('arrow');
    expect(e.startArrow).toBe('none');
  });
});

describe('图引擎 · 几何与命中', () => {
  const n = createNode('rect', 200, 100);

  it('中心点命中、外部点不命中', () => {
    expect(pointInNode(n, { x: n.x + n.w / 2, y: n.y + n.h / 2 })).toBe(true);
    expect(pointInNode(n, { x: n.x - 60, y: n.y - 60 })).toBe(false);
  });

  it('hitTest 能区分节点与空白', () => {
    const hit = hitTest([n], [], { x: n.x + n.w / 2, y: n.y + n.h / 2 }, 1);
    // 命中结果用 kind 区分节点/连线（HitNodeResult.kind === 'node'）
    expect(hit?.kind).toBe('node');
    expect(hitTest([n], [], { x: n.x - 500, y: n.y - 500 }, 1)).toBeNull();
  });

  it('框选 contain 只命中完全包含的节点', () => {
    const inside = createNode('rect', 100, 100);
    const outside = createNode('rect', 900, 900);
    const hitContain = nodesInRect([inside, outside], { x: 0, y: 0, w: 400, h: 400 }, 'contain');
    expect(hitContain).toHaveLength(1);
    expect(hitContain[0]!.id).toBe(inside.id);
  });

  it('edgePath 返回可用的 path 与端点', () => {
    const a = createNode('rect', 100, 100);
    const b = createNode('rect', 400, 100);
    const p = edgePath(createEdge(a.id, b.id), [a, b]);
    expect(p.d.length).toBeGreaterThan(0);
    expect(p.start).toBeTruthy();
    expect(p.end).toBeTruthy();
  });

  it('boundsOf 覆盖所有节点', () => {
    const a = createNode('rect', 100, 100);
    const b = createNode('rect', 500, 400);
    const box = boundsOf([a, b]);
    expect(box).not.toBeNull();
    expect(box!.w).toBeGreaterThan(300);
    expect(box!.h).toBeGreaterThan(200);
  });
});

describe('图引擎 · 对齐与吸附', () => {
  const base = createNode('rect', 0, 0);
  const mk = (id: string, x: number, y: number) => ({ ...base, id, x, y });

  it('左对齐把 x 统一到最小值', () => {
    const out = alignNodes([mk('a', 10, 10), mk('b', 100, 50), mk('c', 200, 90)], ['a', 'b', 'c'], 'left');
    expect(out.every((n) => n.x === 10)).toBe(true);
  });

  it('顶部对齐把 y 统一到最小值', () => {
    const out = alignNodes([mk('a', 10, 10), mk('b', 100, 50)], ['a', 'b'], 'top');
    expect(out.every((n) => n.y === 10)).toBe(true);
  });

  it('水平分布产生等距间隔', () => {
    const out = distributeNodes([mk('a', 0, 0), mk('b', 50, 0), mk('c', 500, 0)], ['a', 'b', 'c'], 'horizontal');
    const xs = out.map((n) => n.x).sort((p, q) => p - q);
    const gap1 = xs[1]! - xs[0]!;
    const gap2 = xs[2]! - xs[1]!;
    expect(Math.abs(gap1 - gap2)).toBeLessThan(2);
  });

  it('吸附到网格', () => {
    expect(snapPoint({ x: 13, y: 27 }, 20)).toEqual({ x: 20, y: 20 });
    expect(snapPoint({ x: 31, y: 9 }, 20)).toEqual({ x: 40, y: 0 });
  });
});

describe('图引擎 · 思维导图布局', () => {
  /**
   * 布局函数是「纯坐标计算」：入参是 nodes/edges 数组，返回排好序的 nodes 数组，
   * 不负责修改整个 DiagramDoc（这样更便于单测与复用）。
   */
  function buildTree(): { doc: ReturnType<typeof createEmptyDoc>; rootId: string; childId: string; grandId: string } {
    const doc = createEmptyDoc('mindmap');
    const rootId = doc.nodes[0]!.id;
    const child = addChildNode(doc, rootId, '子节点');
    doc.nodes.push(child);
    const grand = addChildNode(doc, child.id, '孙节点');
    doc.nodes.push(grand);
    doc.edges.push({ id: 'e1', from: rootId, to: child.id });
    doc.edges.push({ id: 'e2', from: child.id, to: grand.id });
    return { doc, rootId, childId: child.id, grandId: grand.id };
  }

  it('right 布局子节点在父节点右侧', () => {
    const { doc, rootId, childId } = buildTree();
    const laid = autoLayoutMindmap(doc.nodes, doc.edges, 'right');
    const root = laid.find((n) => n.id === rootId)!;
    const child = laid.find((n) => n.id === childId)!;
    expect(child.x).toBeGreaterThan(root.x);
  });

  it('right 布局孙节点比子节点更靠右（层级递进）', () => {
    const { doc, childId, grandId } = buildTree();
    const laid = autoLayoutMindmap(doc.nodes, doc.edges, 'right');
    const child = laid.find((n) => n.id === childId)!;
    const grand = laid.find((n) => n.id === grandId)!;
    expect(grand.x).toBeGreaterThan(child.x);
  });

  it('down 布局子节点在父节点下方', () => {
    const { doc, rootId, childId } = buildTree();
    const laid = autoLayoutMindmap(doc.nodes, doc.edges, 'down');
    const root = laid.find((n) => n.id === rootId)!;
    const child = laid.find((n) => n.id === childId)!;
    expect(child.y).toBeGreaterThan(root.y);
  });

  it('同级兄弟节点纵向不重叠', () => {
    const doc = createEmptyDoc('mindmap');
    const rootId = doc.nodes[0]!.id;
    const a = addChildNode(doc, rootId, 'A');
    const b = addChildNode(doc, rootId, 'B');
    doc.nodes.push(a, b);
    doc.edges.push({ id: 'ea', from: rootId, to: a.id }, { id: 'eb', from: rootId, to: b.id });
    const laid = autoLayoutMindmap(doc.nodes, doc.edges, 'right');
    const na = laid.find((n) => n.id === a.id)!;
    const nb = laid.find((n) => n.id === b.id)!;
    const overlap = na.y < nb.y + nb.h && nb.y < na.y + na.h;
    expect(overlap).toBe(false);
  });

  it('连续 addChildNode 未及时 push 也不会产生重复 id（真实缺陷回归）', () => {
    // 这是很自然的调用顺序：先拿两个子节点，再一起 push。
    // 早期实现只扫描 nodes 取 max+1，两次调用看到同一份 nodes → 生成相同 id，
    // 两个兄弟节点会变成同一节点（布局重叠、拖动联动）。
    const doc = createEmptyDoc('mindmap');
    const rootId = doc.nodes[0]!.id;
    const a = addChildNode(doc, rootId, 'A');
    const b = addChildNode(doc, rootId, 'B');
    expect(a.id).not.toBe(b.id);
    doc.nodes.push(a, b);
    doc.edges.push({ id: 'ea', from: rootId, to: a.id }, { id: 'eb', from: rootId, to: b.id });
    const laid = autoLayoutMindmap(doc.nodes, doc.edges, 'right');
    const na = laid.find((n) => n.id === a.id)!;
    const nb = laid.find((n) => n.id === b.id)!;
    // 两个兄弟必须占不同位置
    expect(na.y !== nb.y || na.x !== nb.x).toBe(true);
  });

  it('折叠子树返回被隐藏的节点集合', () => {    const { doc, rootId, childId, grandId } = buildTree();
    const hidden = collapseSubtree(doc.nodes, doc.edges, rootId, true);
    // 折叠根节点时，其所有后代都应被隐藏
    expect(hidden.has(childId)).toBe(true);
    expect(hidden.has(grandId)).toBe(true);
    expect(hidden.has(rootId)).toBe(false);
  });

  it('展开时隐藏集合为空', () => {
    const { doc, rootId } = buildTree();
    const hidden = collapseSubtree(doc.nodes, doc.edges, rootId, false);
    expect(hidden.size).toBe(0);
  });
});

describe('图引擎 · 序列化与容错', () => {
  it('round-trip 保留节点与连线', () => {
    const a = createNode('rect', 100, 100);
    const b = createNode('ellipse', 400, 100);
    const doc = { ...createEmptyDoc('flowchart'), nodes: [a, b], edges: [createEdge(a.id, b.id)] };
    const back = parseDiagramDoc(serializeDiagramDoc(doc), 'flowchart');
    expect(back).not.toBeNull();
    expect(back!.nodes).toHaveLength(2);
    expect(back!.edges).toHaveLength(1);
    expect(back!.nodes[0]!.shape).toBe('rect');
  });

  it('空内容与坏 JSON 返回 null 而不抛错', () => {
    expect(parseDiagramDoc('')).toBeNull();
    expect(parseDiagramDoc('   ')).toBeNull();
    expect(parseDiagramDoc('{坏JSON')).toBeNull();
    expect(parseDiagramDoc('null')).toBeNull();
    expect(parseDiagramDoc('{"foo":1}')).toBeNull();
  });

  it('丢弃悬空连线（端点节点已删）', () => {
    const raw = JSON.stringify({
      schema: 1,
      kind: 'flowchart',
      title: 't',
      nodes: [{ id: 'a', shape: 'rect', x: 0, y: 0, w: 100, h: 50, text: 'A' }],
      edges: [
        { id: 'e1', from: 'a', to: 'ghost' },
        { id: 'e2', from: 'a', to: 'a' },
      ],
      canvas: { background: '#fff', grid: 'dot', gridSize: 20, showGrid: true, snapToGrid: true },
      createdAt: 1,
      updatedAt: 1,
    });
    const doc = parseDiagramDoc(raw);
    expect(doc).not.toBeNull();
    // to='ghost' 的连线被丢弃，只剩自环那条
    expect(doc!.edges).toHaveLength(1);
    expect(doc!.edges[0]!.id).toBe('e2');
  });
});

describe('图引擎 · 导出', () => {
  it('导出 SVG 含结构且不依赖 CSS 变量', () => {
    const a = createNode('rect', 100, 100);
    const b = createNode('diamond', 400, 100);
    const doc = { ...createEmptyDoc('flowchart'), nodes: [a, b], edges: [createEdge(a.id, b.id)] };
    const svg = exportToSvg(doc);
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('<path');
    // 独立打开时必须自带颜色，不能引用 var(--x)
    expect(svg).not.toContain('var(--');
  });

  it('导出 SVG 包含节点文字', () => {
    const n = createNode('rect', 100, 100);
    n.text = '唯一文本标记';
    const doc = { ...createEmptyDoc('flowchart'), nodes: [n], edges: [] };
    expect(exportToSvg(doc)).toContain('唯一文本标记');
  });
});

describe('图引擎 · Mermaid 导入', () => {
  it('解析 graph TD 的节点与连线', () => {
    const doc = importFromMermaid('graph TD\nA[开始] --> B{判断}\nB --> C[结束]');
    expect(doc).not.toBeNull();
    expect(doc!.nodes).toHaveLength(3);
    expect(doc!.edges).toHaveLength(2);
  });

  it('非 Mermaid 文本返回 null', () => {
    expect(importFromMermaid('随便一段话')).toBeNull();
    expect(importFromMermaid('')).toBeNull();
  });

  it('解析流程图节点文本', () => {
    const doc = importFromMermaid('flowchart LR\nS[开始节点] --> E[结束节点]');
    expect(doc).not.toBeNull();
    const texts = doc!.nodes.map((n) => n.text);
    expect(texts).toContain('开始节点');
    expect(texts).toContain('结束节点');
  });
});
