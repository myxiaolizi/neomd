import {
  EditorView,
  Decoration,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view';
import {
  StateEffect,
  StateField,
  RangeSetBuilder,
  type EditorState,
  type Extension,
} from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

/* ============================ Widgets ============================ */

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'md-image-wrap';
    const img = document.createElement('img');
    img.className = 'md-image';
    img.src = this.src;
    img.alt = this.alt;
    img.loading = 'lazy';
    img.onerror = () => {
      const span = document.createElement('span');
      span.className = 'md-image-loading';
      span.textContent = `图片无法显示 · ${this.alt || this.src}`;
      wrap.replaceChildren(span);
    };
    wrap.appendChild(img);
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('span');
    box.className = 'md-checkbox' + (this.checked ? ' checked' : '');
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(this.checked));
    box.setAttribute('aria-label', this.checked ? '标记为未完成' : '标记为已完成');

    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const from = this.pos;
      const to = Math.min(view.state.doc.length, from + 3);
      const text = view.state.doc.sliceString(from, to);
      const m = /\[([ xX])\]/.exec(text);
      if (!m) return;
      const replacement = m[1].toLowerCase() === 'x' ? '[ ]' : '[x]';
      view.dispatch({ changes: { from, to: from + 3, insert: replacement } });
    });
    return box;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class HrWidget extends WidgetType {
  toDOM(): HTMLElement {
    const hr = document.createElement('span');
    hr.className = 'md-hr';
    return hr;
  }
}

/** 表格渲染为真实 <table>，光标进入时还原源码以便编辑 */
class TableWidget extends WidgetType {
  constructor(readonly rows: string[][], readonly align: string[], readonly source: string) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'md-table-wrap';
    const table = document.createElement('table');
    table.className = 'md-table-el';

    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');

    this.rows.forEach((cells, rowIdx) => {
      const tr = document.createElement('tr');
      cells.forEach((cell, i) => {
        const tag = rowIdx === 0 ? 'th' : 'td';
        const el = document.createElement(tag);
        el.textContent = cell;
        const a = this.align[i];
        if (a === 'center') el.style.textAlign = 'center';
        else if (a === 'right') el.style.textAlign = 'right';
        tr.appendChild(el);
      });
      if (rowIdx === 0) thead.appendChild(tr);
      else tbody.appendChild(tr);
    });

    if (thead.childNodes.length) table.appendChild(thead);
    if (tbody.childNodes.length) table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }
}

/** 解析表格源码为行列 */
function parseTable(src: string): { rows: string[][]; align: string[] } | null {
  const lines = src.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;

  const splitRow = (line: string): string[] => {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  };

  const header = splitRow(lines[0]);
  const sep = splitRow(lines[1]);
  if (!/^:?-{2,}:?$/.test(sep[0] ?? '')) return null;

  const align = sep.map((c) => {
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    if (l && r) return 'center';
    if (r) return 'right';
    if (l) return 'left';
    return '';
  });

  const rows: string[][] = [header];
  for (let i = 2; i < lines.length; i++) {
    rows.push(splitRow(lines[i]));
  }
  return { rows, align };
}

/* ============================ 行级样式 ============================ */

const HEADING_CLASS: Record<string, string> = {
  ATXHeading1: 'md-h1',
  ATXHeading2: 'md-h2',
  ATXHeading3: 'md-h3',
  ATXHeading4: 'md-h4',
  ATXHeading5: 'md-h5',
  ATXHeading6: 'md-h6',
};

/* ============================ 工具 ============================ */

function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.from <= to && r.to >= from) return true;
  }
  return false;
}

interface DecoRange {
  from: number;
  to: number;
  deco: Decoration;
}

/** 隐藏成对的包裹标记；标记不匹配时不做任何改动 */
function hidePair(
  out: DecoRange[],
  doc: EditorState['doc'],
  from: number,
  to: number,
  marker: string,
): boolean {
  const len = marker.length;
  if (to - from < len * 2 + 1) return false;
  if (doc.sliceString(from, from + len) !== marker) return false;
  if (doc.sliceString(to - len, to) !== marker) return false;
  out.push({ from, to: from + len, deco: Decoration.replace({}) });
  out.push({ from: to - len, to, deco: Decoration.replace({}) });
  return true;
}

/* ============================ 装饰构建 ============================ */

function buildDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const ranges: DecoRange[] = [];
  const lineClasses = new Map<number, Set<string>>();
  const hidden = new Set<string>();

  const addLineClass = (pos: number, cls: string) => {
    const line = doc.lineAt(Math.min(Math.max(pos, 0), doc.length));
    let set = lineClasses.get(line.from);
    if (!set) {
      set = new Set();
      lineClasses.set(line.from, set);
    }
    set.add(cls);
  };

  const hide = (from: number, to: number) => {
    const key = `${from}:${to}`;
    if (hidden.has(key)) return;
    hidden.add(key);
    ranges.push({ from, to, deco: Decoration.replace({}) });
  };

  syntaxTree(state).iterate({
    enter: (node) => {
      const name = node.name;

      // ---------- 行级：标题 ----------
      const hCls = HEADING_CLASS[name];
      if (hCls) {
        addLineClass(node.from, hCls);
        // 标题标记：非编辑行隐藏，编辑行淡出
        const line = doc.lineAt(node.from);
        const active = state.selection.main.head >= line.from && state.selection.main.head <= line.to;
        const head = doc.sliceString(line.from, Math.min(line.to, line.from + 10));
        const m = /^(#{1,6}\s?)/.exec(head);
        if (m) {
          if (active) {
            ranges.push({
              from: line.from,
              to: line.from + m[0].length,
              deco: Decoration.mark({ class: 'md-mark md-mark-revealed' }),
            });
          } else {
            hide(line.from, line.from + m[0].length);
          }
        }
        return;
      }

      // ---------- 行级：引用 ----------
      if (name === 'Blockquote') {
        const start = doc.lineAt(node.from);
        const end = doc.lineAt(Math.min(node.to, doc.length));
        const count = Math.min(end.number - start.number, 500);
        for (let i = 0; i <= count; i++) addLineClass(doc.line(start.number + i).from, 'md-quote');
        return;
      }

      // ---------- 行级：代码块 ----------
      if (name === 'FencedCode' || name === 'CodeBlock') {
        const start = doc.lineAt(node.from);
        const end = doc.lineAt(Math.min(node.to, doc.length));
        const count = Math.min(end.number - start.number, 2000);
        for (let i = 0; i <= count; i++) {
          const ln = doc.line(start.number + i);
          addLineClass(ln.from, 'md-codeblock');
          if (i === 0) addLineClass(ln.from, 'md-codeblock-start');
          if (i === count) addLineClass(ln.from, 'md-codeblock-end');
        }
        return;
      }

      // ---------- 行级：表格 ----------
      if (name === 'Table') {
        const src = doc.sliceString(node.from, node.to);
        if (selectionTouches(state, node.from, node.to)) {
          // 编辑态：保留源码，仅做行级样式
          const start = doc.lineAt(node.from);
          const end = doc.lineAt(Math.min(node.to, doc.length));
          const count = Math.min(end.number - start.number, 200);
          for (let i = 0; i <= count; i++) {
            const ln = doc.line(start.number + i);
            addLineClass(ln.from, 'md-table');
            if (i === 0) addLineClass(ln.from, 'md-table-header');
          }
          return;
        }
        const parsed = parseTable(src);
        if (!parsed) {
          addLineClass(node.from, 'md-table');
          return;
        }
        ranges.push({
          from: node.from,
          to: node.to,
          deco: Decoration.replace({
            widget: new TableWidget(parsed.rows, parsed.align, src),
            block: true,
          }),
        });
        return;
      }

      // 表格节点内部结构不再单独处理
      if (name === 'TableHeader' || name === 'TableRow' ||
          name === 'TableDelimiter' || name === 'TableCell') {
        return;
      }

      // ---------- 行内：行内代码 ----------
      if (name === 'InlineCode') {
        if (!selectionTouches(state, node.from, node.to) &&
            hidePair(ranges, doc, node.from, node.to, '`')) {
          if (node.to - node.from > 2) {
            ranges.push({
              from: node.from + 1,
              to: node.to - 1,
              deco: Decoration.mark({ class: 'md-inline-code-span' }),
            });
          }
        } else {
          ranges.push({
            from: node.from,
            to: node.to,
            deco: Decoration.mark({ class: 'md-inline-code-span' }),
          });
        }
        return;
      }

      // ---------- 行内：加粗 ----------
      if (name === 'StrongEmphasis') {
        if (!selectionTouches(state, node.from, node.to) &&
            hidePair(ranges, doc, node.from, node.to, '**')) {
          if (node.to - node.from > 4) {
            ranges.push({
              from: node.from + 2,
              to: node.to - 2,
              deco: Decoration.mark({ class: 'md-strong' }),
            });
          }
        } else {
          ranges.push({
            from: node.from,
            to: node.to,
            deco: Decoration.mark({ class: 'md-strong' }),
          });
        }
        return;
      }

      // ---------- 行内：斜体 ----------
      if (name === 'Emphasis') {
        if (!selectionTouches(state, node.from, node.to) &&
            hidePair(ranges, doc, node.from, node.to, '*')) {
          if (node.to - node.from > 2) {
            ranges.push({
              from: node.from + 1,
              to: node.to - 1,
              deco: Decoration.mark({ class: 'md-em' }),
            });
          }
        } else {
          ranges.push({
            from: node.from,
            to: node.to,
            deco: Decoration.mark({ class: 'md-em' }),
          });
        }
        return;
      }

      // ---------- 行内：删除线 ----------
      if (name === 'Strikethrough') {
        if (!selectionTouches(state, node.from, node.to) &&
            hidePair(ranges, doc, node.from, node.to, '~~')) {
          if (node.to - node.from > 4) {
            ranges.push({
              from: node.from + 2,
              to: node.to - 2,
              deco: Decoration.mark({ class: 'md-strike' }),
            });
          }
        } else {
          ranges.push({
            from: node.from,
            to: node.to,
            deco: Decoration.mark({ class: 'md-strike' }),
          });
        }
        return;
      }

      // ---------- 任务标记：渲染为可点击勾选框 ----------
      if (name === 'TaskMarker') {
        const raw = doc.sliceString(node.from, node.to);
        const m = /^\[([ xX])\]$/.exec(raw);
        if (!m) return;
        if (selectionTouches(state, node.from, node.to)) {
          ranges.push({
            from: node.from,
            to: node.to,
            deco: Decoration.mark({ class: 'md-mark md-mark-revealed' }),
          });
          return;
        }
        // 同时隐藏其前面的列表符号与空格，避免与勾选框重复
        const line = doc.lineAt(node.from);
        const before = doc.sliceString(line.from, node.from);
        const lm = /^(\s*)([-*+])\s+$/.exec(before);
        if (lm) {
          const markFrom = line.from + lm[1].length;
          hide(markFrom, node.from);
        }
        ranges.push({
          from: node.from,
          to: node.to,
          deco: Decoration.replace({
            widget: new CheckboxWidget(m[1].toLowerCase() === 'x', node.from),
          }),
        });
        return;
      }

      // ---------- 引用标记 ----------
      if (name === 'QuoteMark') {
        const line = doc.lineAt(node.from);
        const active = state.selection.main.head >= line.from && state.selection.main.head <= line.to;
        if (active) {
          ranges.push({
            from: node.from,
            to: node.to,
            deco: Decoration.mark({ class: 'md-mark md-mark-revealed' }),
          });
        } else {
          hide(node.from, node.to);
          // 一并隐藏标记后的空格
          if (doc.sliceString(node.to, node.to + 1) === ' ') hide(node.to, node.to + 1);
        }
        return;
      }

      // ---------- 列表标记：渲染为项目符号 ----------
      if (name === 'ListMark') {
        const line = doc.lineAt(node.from);
        const active = state.selection.main.head >= line.from && state.selection.main.head <= line.to;
        addLineClass(line.from, 'md-list');
        const raw = doc.sliceString(node.from, node.to);
        // 任务项前面的 "-" 直接隐藏，交给勾选框表达
        const after = doc.sliceString(node.to, Math.min(node.to + 2, doc.length));
        const isTaskMark = /^\[[ xX]\]/.test(after.trimStart());
        if (active) {
          ranges.push({
            from: node.from,
            to: node.to,
            deco: Decoration.mark({ class: 'md-mark md-mark-revealed' }),
          });
        } else if (isTaskMark) {
          hide(node.from, node.to);
          // 一并隐藏紧随的空格
          if (doc.sliceString(node.to, node.to + 1) === ' ') hide(node.to, node.to + 1);
        } else {
          ranges.push({
            from: node.from,
            to: node.to,
            deco: Decoration.mark({ class: 'md-bullet' }),
          });
        }
        void raw;
        return;
      }

      // ---------- 代码围栏标记 ----------
      if (name === 'CodeMark') {
        const line = doc.lineAt(node.from);
        const active = state.selection.main.head >= line.from && state.selection.main.head <= line.to;
        const raw = doc.sliceString(node.from, node.to);
        if (/^(```|~~~)$/.test(raw) && !active) {
          hide(node.from, node.to);
        } else {
          ranges.push({
            from: node.from,
            to: node.to,
            deco: Decoration.mark({ class: 'md-fence-mark' }),
          });
        }
        return;
      }

      if (name === 'CodeInfo') {
        ranges.push({
          from: node.from,
          to: node.to,
          deco: Decoration.mark({ class: 'md-code-info' }),
        });
        return;
      }

      // ---------- 链接 ----------
      if (name === 'Link') {
        const text = doc.sliceString(node.from, node.to);
        const m = /^\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)$/.exec(text);
        if (!m) return;
        if (selectionTouches(state, node.from, node.to)) return;

        const labelFrom = node.from + 1;
        const labelTo = labelFrom + m[1].length;
        hide(node.from, labelFrom);
        if (labelTo < node.to) hide(labelTo, node.to);
        if (labelTo > labelFrom) {
          ranges.push({
            from: labelFrom,
            to: labelTo,
            deco: Decoration.mark({
              class: 'md-link',
              attributes: { 'data-href': m[2].trim(), title: m[2].trim(), role: 'link' },
            }),
          });
        }
        return;
      }

      // ---------- 图片 ----------
      if (name === 'Image') {
        const text = doc.sliceString(node.from, node.to);
        const m = /^!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)$/.exec(text);
        if (!m) return;
        if (selectionTouches(state, node.from, node.to)) return;
        ranges.push({
          from: node.from,
          to: node.to,
          deco: Decoration.replace({ widget: new ImageWidget(m[2].trim(), m[1]) }),
        });
        return;
      }

      // ---------- 分割线 ----------
      if (name === 'HorizontalRule') {
        if (selectionTouches(state, node.from, node.to)) return;
        ranges.push({
          from: node.from,
          to: node.to,
          deco: Decoration.replace({ widget: new HrWidget() }),
        });
      }
    },
  });

  // 行级装饰
  for (const [from, classes] of lineClasses) {
    ranges.push({
      from,
      to: from,
      deco: Decoration.line({ class: [...classes].join(' ') }),
    });
  }

  // 按位置排序：行装饰优先，其次长区间优先
  ranges.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    const aLine = a.to === a.from ? 0 : 1;
    const bLine = b.to === b.from ? 0 : 1;
    if (aLine !== bLine) return aLine - bLine;
    return b.to - a.to;
  });

  const builder = new RangeSetBuilder<Decoration>();
  let lastFrom = -1;
  let lastTo = -1;
  let lastLineFrom = -1;

  for (const r of ranges) {
    if (r.from < 0 || r.to > doc.length) continue;
    if (r.to === r.from) {
      // 同一行只允许一个 line 装饰
      if (r.from === lastLineFrom) continue;
      lastLineFrom = r.from;
    }
    if (r.from === lastFrom && r.to === lastTo) continue;
    try {
      builder.add(r.from, r.to, r.deco);
      lastFrom = r.from;
      lastTo = r.to;
    } catch {
      /* 忽略非法区间 */
    }
  }
  return builder.finish();
}

/* ============================ 扩展 ============================ */

const setDecorations = StateEffect.define<DecorationSet>();

const decorationField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setDecorations)) next = e.value;
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * 所见即所得预览：
 * 语法标记在非编辑位置隐藏，链接/图片/任务项渲染为可视元素；
 * 光标进入相应区间时还原原始标记，保证可直接编辑。
 */
export function livePreview(opts: { onOpenLink: (href: string) => void }): Extension {
  const rebuild = EditorView.updateListener.of((update) => {
    if (!update.docChanged && !update.selectionSet && !update.viewportChanged) return;
    update.view.dispatch({ effects: setDecorations.of(buildDecorations(update.state)) });
  });

  const clickHandler = EditorView.domEventHandlers({
    click(event) {
      const target = event.target as HTMLElement | null;
      if (!target) return false;
      const link = target.closest('.md-link') as HTMLElement | null;
      if (!link) return false;
      const href = link.dataset.href;
      if (!href) return false;
      if (event.ctrlKey || event.metaKey) return false;
      event.preventDefault();
      opts.onOpenLink(href);
      return true;
    },
  });

  return [decorationField, rebuild, clickHandler];
}
