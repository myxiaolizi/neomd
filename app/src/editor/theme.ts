import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

/** 编辑器外观主题，颜色全部走 CSS 变量以适配明暗 */
export const editorTheme: Extension = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--c-text)',
    height: '100%',
  },
  '.cm-content': {
    caretColor: 'var(--c-primary)',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--c-text-3)',
    border: 'none',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--c-text-2)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--c-surface-3)',
    border: '1px solid var(--c-line-strong)',
    color: 'var(--c-text-3)',
    borderRadius: '4px',
    padding: '0 5px',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'color-mix(in srgb, var(--c-primary) 16%, transparent)',
  },
});

/** 代码块与行内语法的着色 */
export const mdHighlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: '700', color: 'var(--c-text)' },
  { tag: t.strong, fontWeight: '680', color: 'var(--c-text)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--c-text-3)' },
  { tag: t.link, color: 'var(--c-primary)' },
  { tag: t.url, color: 'var(--c-primary)', textDecoration: 'underline' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)' },
  { tag: t.quote, color: 'var(--c-text-2)' },
  { tag: t.list, color: 'var(--c-text)' },
  { tag: t.processingInstruction, color: 'var(--c-text-3)' },
  { tag: t.meta, color: 'var(--c-text-3)' },
  { tag: t.keyword, color: 'var(--c-primary)', fontWeight: '600' },
  { tag: t.string, color: '#c9741f' },
  { tag: t.number, color: '#c9741f' },
  { tag: t.comment, color: 'var(--c-text-3)', fontStyle: 'italic' },
  { tag: t.function(t.variableName), color: 'var(--c-primary)' },
  { tag: t.typeName, color: 'var(--c-primary)' },
  { tag: t.operator, color: 'var(--c-text-2)' },
  { tag: t.punctuation, color: 'var(--c-text-3)' },
  { tag: t.contentSeparator, color: 'var(--c-text-3)' },
]);

export const highlightExtension = syntaxHighlighting(mdHighlight);

/** 自动配对括号与 markdown 符号 */
export function autoPairEnabled(): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    const pairs: Record<string, string> = {
      '(': ')',
      '[': ']',
      '{': '}',
      '`': '`',
      '*': '*',
      _: '_',
      '~': '~',
      '"': '"',
      "'": "'",
      '“': '”',
      '‘': '’',
      '（': '）',
      '【': '】',
    };
    const close = pairs[text];
    if (!close) return false;

    const sel = view.state.sliceDoc(from, to);

    // 选中文本时包裹
    if (sel.length > 0) {
      view.dispatch({
        changes: { from, to, insert: text + sel + close },
        selection: { anchor: from + 1, head: to + 1 },
      });
      return true;
    }

    // 已存在配对的右符号 → 跳过
    const next = view.state.sliceDoc(to, to + 1);
    if (next === close) {
      view.dispatch({ selection: { anchor: to + 1 } });
      return true;
    }

    // 单词中间的符号不配对
    const prevChar = from > 0 ? view.state.sliceDoc(from - 1, from) : '';
    if (prevChar && /[A-Za-z0-9]/.test(prevChar) && /[*_~`]/.test(text)) return false;

    view.dispatch({
      changes: { from, to, insert: text + close },
      selection: { anchor: from + 1 },
    });
    return true;
  });
}

/** 段落间距与排版微调 */
export const typographyTheme: Extension = EditorView.theme({
  '.cm-line': {
    paddingTop: '1.5px',
    paddingBottom: '1.5px',
    paddingLeft: 'var(--doc-pad-x, 30px)',
    paddingRight: 'var(--doc-pad-x, 30px)',
  },
});
