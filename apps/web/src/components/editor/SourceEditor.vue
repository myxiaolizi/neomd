<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, placeholder as cmPlaceholder } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput, foldGutter, foldKeymap } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { tags } from '@lezer/highlight';

const props = defineProps<{
  modelValue: string;
  showLineNumbers?: boolean;
  fontSize?: number;
  lineHeight?: number;
  readonly?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [string];
  scroll: [number];
  cursor: [number];
  save: [];
}>();

const host = ref<HTMLDivElement | null>(null);
/** 外层滚动容器：标题行插槽 + CodeMirror 都放在它里面，共享同一滚动上下文 */
const scrollerEl = ref<HTMLDivElement | null>(null);
let view: EditorView | null = null;
const themeCompartment = new Compartment();
const readOnlyCompartment = new Compartment();
const gutterCompartment = new Compartment();
let internalChange = false;

const nmHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.5em', fontWeight: '700', color: 'var(--fg)' },
  { tag: tags.heading2, fontSize: '1.28em', fontWeight: '700', color: 'var(--fg)' },
  { tag: tags.heading3, fontSize: '1.12em', fontWeight: '650', color: 'var(--fg)' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: '650', color: 'var(--fg)' },
  { tag: tags.strong, fontWeight: '700', color: 'var(--fg)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--accent)' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', color: 'var(--accent)' },
  { tag: tags.quote, color: 'var(--fg-2)', fontStyle: 'italic' },
  { tag: tags.list, color: 'var(--accent)' },
  { tag: tags.contentSeparator, color: 'var(--fg-3)' },
  { tag: [tags.meta, tags.processingInstruction], color: 'var(--fg-3)' },
  { tag: tags.comment, color: 'var(--fg-3)', fontStyle: 'italic' },
]);

function baseTheme(fontSize: number, lineHeight: number) {
  return EditorView.theme({
    '&': {
      fontSize: `${fontSize}px`,
      // 高度交给内容自适应：滚动由外层容器统一负责，标题行才能随正文滚走
      backgroundColor: 'transparent',
      color: 'var(--fg)',
    },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: String(lineHeight),
      // 有标题行插槽时，滚动由外层 `.source-editor__scroller` 统一负责，
      // CodeMirror 自身不再产生滚动条（否则标题行会「固定」在顶部，违背「次行不冻结」）。
      padding: '18px 0 120px',
      overflow: 'visible',
    },
    '.cm-content': { padding: '0 32px', caretColor: 'var(--accent)' },
    '.cm-line': { padding: '0 4px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      border: 'none',
      color: 'var(--fg-3)',
      paddingLeft: '12px',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(127,140,160,0.05)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--accent)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
      backgroundColor: 'var(--accent-weak) !important',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    '.cm-matchingBracket': { backgroundColor: 'var(--accent-weak)', outline: 'none' },
    '.cm-selectionMatch': { backgroundColor: 'var(--accent-weak-2)' },
    '.cm-placeholder': { color: 'var(--fg-3)' },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--bg-hover)',
      border: 'none',
      color: 'var(--fg-3)',
      borderRadius: '4px',
      padding: '0 6px',
    },
    '.cm-panels': {
      backgroundColor: 'var(--bg-elevated)',
      color: 'var(--fg)',
      borderTop: '1px solid var(--border)',
    },
    '.cm-textfield': {
      backgroundColor: 'var(--bg-input)',
      border: '1px solid var(--border)',
      borderRadius: '6px',
      color: 'var(--fg)',
    },
  });
}

function buildState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      history(),
      gutterCompartment.of(props.showLineNumbers ? [lineNumbers(), foldGutter()] : []),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      rectangularSelection(),
      crosshairCursor(),
      highlightSelectionMatches(),
      search({ top: true }),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(nmHighlight),
      cmPlaceholder('开始写作… 输入 / 唤起命令，或按 Ctrl+P 打开命令面板'),
      EditorView.lineWrapping,
      themeCompartment.of(baseTheme(props.fontSize ?? 16, props.lineHeight ?? 1.75)),
      readOnlyCompartment.of(EditorState.readOnly.of(Boolean(props.readonly))),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            emit('save');
            return true;
          },
        },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !internalChange) {
          emit('update:modelValue', u.state.doc.toString());
        }
        if (u.selectionSet || u.docChanged) {
          emit('cursor', u.state.selection.main.head);
        }
      }),
      EditorView.domEventHandlers({
        // 滚动容器已上移到外层 `.source-editor__scroller`（为了让标题行一起滚走），
        // 这里只保留监听，真正的 scroll 事件在外层绑定。
        scroll: () => false,
      }),
    ],
  });
}

onMounted(() => {
  if (!host.value) return;
  view = new EditorView({ state: buildState(props.modelValue), parent: host.value });
});

watch(
  () => props.modelValue,
  (next) => {
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === next) return;
    internalChange = true;
    view.dispatch({ changes: { from: 0, to: current.length, insert: next } });
    internalChange = false;
  },
);

watch(
  () => [props.fontSize, props.lineHeight],
  () => {
    view?.dispatch({
      effects: themeCompartment.reconfigure(baseTheme(props.fontSize ?? 16, props.lineHeight ?? 1.75)),
    });
  },
);

watch(
  () => props.readonly,
  (v) => {
    view?.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(Boolean(v))) });
  },
);

watch(
  () => props.showLineNumbers,
  (v) => {
    view?.dispatch({ effects: gutterCompartment.reconfigure(v ? [lineNumbers(), foldGutter()] : []) });
  },
);

/**
 * 滚动到文档进度（对照模式同步用）。
 *
 * 注意：真正的滚动容器是本组件外层的 `.source-editor__scroller`，
 * 不是 CodeMirror 的 `scrollDOM`（后者已被设为 `overflow: visible`，
 * 目的是让标题行与正文共享同一滚动上下文 → 标题行能随正文滚走）。
 */
function scrollToRatio(ratio: number): void {
  const scroller = scrollerEl.value;
  if (!scroller) return;
  const max = scroller.scrollHeight - scroller.clientHeight;
  if (max > 0) scroller.scrollTop = max * Math.max(0, Math.min(1, ratio));
}

/** 在光标处插入/包裹文本 */
function insertText(text: string, cursorOffset?: number): void {
  if (!view) return;
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + (cursorOffset ?? text.length) },
  });
  view.focus();
}

function wrapSelection(before: string, after = before, placeholder = ''): void {
  if (!view) return;
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to) || placeholder;
  view.dispatch({
    changes: { from, to, insert: `${before}${selected}${after}` },
    selection: { anchor: from + before.length, head: from + before.length + selected.length },
  });
  view.focus();
}

function getSelection(): { from: number; to: number; text: string } {
  if (!view) return { from: 0, to: 0, text: '' };
  const { from, to } = view.state.selection.main;
  return { from, to, text: view.state.sliceDoc(from, to) };
}

function focus(): void {
  view?.focus();
}

/** 外层滚动容器的滚动进度（0-1），供对照模式同步 */
function onScrollerScroll(): void {
  const scroller = scrollerEl.value;
  if (!scroller) return;
  const max = scroller.scrollHeight - scroller.clientHeight;
  emit('scroll', max > 0 ? scroller.scrollTop / max : 0);
}

defineExpose({ scrollToRatio, insertText, wrapSelection, getSelection, focus });

onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});
</script>

<template>
  <!--
    滚动容器：标题行插槽（`#title`）与正文编辑器同处一个可滚动区域，
    因此标题行会随正文一起滚走（非 sticky），满足「次行不冻结」。
  -->
  <div ref="scrollerEl" class="source-editor__scroller" @scroll="onScrollerScroll">
    <slot name="title" />
    <div ref="host" class="source-editor" />
  </div>
</template>

<style scoped>
.source-editor__scroller {
  height: 100%;
  width: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.source-editor {
  width: 100%;
  /* 高度由内容撑开（CodeMirror 自身已设为 overflow: visible），滚动交给外层容器 */
}
:deep(.cm-editor) {
  height: auto;
}
</style>
