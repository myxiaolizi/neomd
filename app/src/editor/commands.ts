import { EditorSelection, type ChangeSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/** 选区覆盖的整行范围 */
function lineRange(view: EditorView): { from: number; to: number; lines: string[] } {
  const { state } = view;
  const sel = state.selection.main;
  const startLine = state.doc.lineAt(sel.from);
  const endLine = state.doc.lineAt(sel.to);
  const lines: string[] = [];
  for (let n = startLine.number; n <= endLine.number; n++) {
    lines.push(state.doc.line(n).text);
  }
  return { from: startLine.from, to: endLine.to, lines };
}

/** 应用行前缀变更，自动去除已有同类前缀 */
function applyLinePrefix(
  view: EditorView,
  matcher: RegExp,
  makePrefix: (index: number) => string,
): void {
  const { from, to, lines } = lineRange(view);
  const allHave = lines.every((l) => matcher.test(l) || l.trim() === '');
  const next = lines
    .map((line, i) => {
      if (allHave) return line.replace(matcher, '');
      if (line.trim() === '') return line;
      const stripped = line.replace(matcher, '');
      return makePrefix(i) + stripped;
    })
    .join('\n');

  view.dispatch({
    changes: { from, to, insert: next },
    selection: EditorSelection.range(from, from + next.length),
    scrollIntoView: true,
  });
}

/** 设置标题级别，level=0 表示正文 */
export function setHeading(view: EditorView, level: number): boolean {
  const { from, to, lines } = lineRange(view);
  const next = lines
    .map((line) => {
      const stripped = line.replace(/^#{1,6}\s+/, '');
      if (level === 0) return stripped;
      return '#'.repeat(level) + ' ' + stripped;
    })
    .join('\n');

  view.dispatch({
    changes: { from, to, insert: next },
    selection: EditorSelection.cursor(from + (level > 0 ? level + 1 : 0)),
    scrollIntoView: true,
  });
  return true;
}

/** 包裹或取消包裹选中文本 */
export function wrapSelection(
  view: EditorView,
  before: string,
  after = before,
  placeholder = '文本',
): boolean {
  const sel = view.state.selection.main;
  const selected = view.state.sliceDoc(sel.from, sel.to);

  // 已包裹 → 取消
  const outerFrom = sel.from - before.length;
  const outerTo = sel.to + after.length;
  if (
    outerFrom >= 0 &&
    outerTo <= view.state.doc.length &&
    view.state.sliceDoc(outerFrom, sel.from) === before &&
    view.state.sliceDoc(sel.to, outerTo) === after
  ) {
    view.dispatch({
      changes: [
        { from: outerFrom, to: sel.from, insert: '' },
        { from: sel.to, to: outerTo, insert: '' },
      ],
      selection: EditorSelection.range(outerFrom, outerFrom + selected.length),
    });
    return true;
  }

  if (selected.length === 0) {
    const insert = before + placeholder + after;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      selection: EditorSelection.range(sel.from + before.length, sel.from + before.length + placeholder.length),
    });
    return true;
  }

  // 选中文本自身已含标记 → 剥离
  if (selected.startsWith(before) && selected.endsWith(after) && selected.length >= before.length + after.length) {
    const inner = selected.slice(before.length, selected.length - after.length);
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: inner },
      selection: EditorSelection.range(sel.from, sel.from + inner.length),
    });
    return true;
  }

  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: before + selected + after },
    selection: EditorSelection.range(sel.from + before.length, sel.to + before.length),
  });
  return true;
}

export const toggleBold = (v: EditorView) => wrapSelection(v, '**', '**', '粗体');
export const toggleItalic = (v: EditorView) => wrapSelection(v, '*', '*', '斜体');
export const toggleStrike = (v: EditorView) => wrapSelection(v, '~~', '~~', '删除线');
export const toggleCode = (v: EditorView) => wrapSelection(v, '`', '`', 'code');

/** 引用 */
export function toggleQuote(view: EditorView): boolean {
  applyLinePrefix(view, /^>\s?/, () => '> ');
  return true;
}

/** 无序列表 */
export function toggleBulletList(view: EditorView): boolean {
  applyLinePrefix(view, /^[-*+]\s+(?!\[[ xX]\])/, () => '- ');
  return true;
}

/** 有序列表 */
export function toggleOrderedList(view: EditorView): boolean {
  let i = 0;
  applyLinePrefix(view, /^\d+\.\s+/, () => `${++i}. `);
  return true;
}

/** 任务列表 */
export function toggleTaskList(view: EditorView): boolean {
  const { from, to, lines } = lineRange(view);
  const allTask = lines.every((l) => /^\s*[-*+]\s+\[[ xX]\]\s+/.test(l) || l.trim() === '');
  const next = lines
    .map((line) => {
      if (line.trim() === '') return line;
      const cleaned = line.replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, '');
      return allTask ? '- ' + cleaned : '- [ ] ' + cleaned;
    })
    .join('\n');
  view.dispatch({
    changes: { from, to, insert: next },
    selection: EditorSelection.range(from, from + next.length),
  });
  return true;
}

/** 代码块 */
export function insertCodeBlock(view: EditorView): boolean {
  const sel = view.state.selection.main;
  const selected = view.state.sliceDoc(sel.from, sel.to);
  const body = selected || '代码';
  const insert = '```\n' + body + '\n```';
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: EditorSelection.range(
      sel.from + 4,
      sel.from + 4 + body.length,
    ),
  });
  return true;
}

/** 插入链接 */
export function insertLink(view: EditorView): boolean {
  const sel = view.state.selection.main;
  const selected = view.state.sliceDoc(sel.from, sel.to) || '链接文本';
  const insert = `[${selected}](url)`;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: EditorSelection.range(
      sel.from + selected.length + 3,
      sel.from + selected.length + 6,
    ),
  });
  return true;
}

/** 插入分割线 */
export function insertHr(view: EditorView): boolean {
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.head);
  const needsLeading = line.text.trim().length > 0;
  const insert = (needsLeading ? '\n\n' : '') + '---\n\n';
  view.dispatch({
    changes: { from: sel.to, to: sel.to, insert },
    selection: EditorSelection.cursor(sel.to + insert.length),
  });
  return true;
}

/** 插入表格 */
export function insertTable(view: EditorView): boolean {
  const sel = view.state.selection.main;
  const table = ['| 列 1 | 列 2 | 列 3 |', '| --- | --- | --- |', '| 内容 | 内容 | 内容 |'].join('\n');
  const line = view.state.doc.lineAt(sel.head);
  const needsLeading = line.text.trim().length > 0;
  const insert = (needsLeading ? '\n\n' : '') + table + '\n';
  view.dispatch({
    changes: { from: sel.to, to: sel.to, insert },
    selection: EditorSelection.cursor(sel.to + insert.length),
  });
  return true;
}

/** 插入行内公式/高亮等扩展 */
export function insertHighlight(view: EditorView): boolean {
  return wrapSelection(view, '==', '==', '高亮');
}

/** 在光标处插入文本 */
export function insertAtCursor(view: EditorView, text: string): boolean {
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: EditorSelection.cursor(sel.from + text.length),
  });
  return true;
}

/** 缩进/反缩进 */
export function indentMore(view: EditorView): boolean {
  const { from, to, lines } = lineRange(view);
  const next = lines.map((l) => (l.trim() ? '  ' + l : l)).join('\n');
  view.dispatch({ changes: { from, to, insert: next } });
  return true;
}

export function indentLess(view: EditorView): boolean {
  const { from, to, lines } = lineRange(view);
  const next = lines.map((l) => l.replace(/^(\t| {1,2})/, '')).join('\n');
  view.dispatch({ changes: { from, to, insert: next } });
  return true;
}

/** 智能回车：延续列表 / 引用 */
export function smartEnter(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const line = view.state.doc.lineAt(sel.head);
  const text = line.text;
  const before = text.slice(0, sel.head - line.from);

  // 列表项
  const listMatch = /^(\s*)([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/.exec(before);
  if (listMatch) {
    const indent = listMatch[1];
    const marker = listMatch[2];
    const rest = before.slice(listMatch[0].length);
    if (rest.trim() === '') {
      // 空列表项 → 退出列表
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: EditorSelection.cursor(line.from),
      });
      return true;
    }
    let nextMarker = marker;
    if (/^\d+\.$/.test(marker)) {
      nextMarker = `${parseInt(marker, 10) + 1}.`;
    }
    const taskPrefix = listMatch[3] ? '[ ] ' : '';
    const insert = '\n' + indent + nextMarker + ' ' + taskPrefix;
    view.dispatch({
      changes: { from: sel.head, to: sel.head, insert },
      selection: EditorSelection.cursor(sel.head + insert.length),
    });
    return true;
  }

  // 引用
  const quoteMatch = /^(\s*>\s?)+/.exec(before);
  if (quoteMatch) {
    const rest = before.slice(quoteMatch[0].length);
    if (rest.trim() === '') {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: EditorSelection.cursor(line.from),
      });
      return true;
    }
    const insert = '\n' + quoteMatch[0];
    view.dispatch({
      changes: { from: sel.head, to: sel.head, insert },
      selection: EditorSelection.cursor(sel.head + insert.length),
    });
    return true;
  }

  return false;
}

/** 插入图片语法 */
export function insertImage(view: EditorView, src: string, alt = ''): boolean {
  return insertAtCursor(view, `![${alt}](${src})`);
}

/** 取得当前选区文本 */
export function getSelection(view: EditorView): string {
  const sel = view.state.selection.main;
  return view.state.sliceDoc(sel.from, sel.to);
}

/** 替换整个文档内容（保留撤销栈） */
export function replaceDoc(view: EditorView, text: string): void {
  const changes: ChangeSpec = { from: 0, to: view.state.doc.length, insert: text };
  view.dispatch({ changes, selection: EditorSelection.cursor(0) });
}
