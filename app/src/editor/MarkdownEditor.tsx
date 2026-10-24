import { useEffect, useRef } from 'react';
import { EditorView, keymap, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, lineNumbers, placeholder as cmPlaceholder } from '@codemirror/view';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import type { LanguageDescription } from '@codemirror/language';
import { syntaxHighlighting, bracketMatching, indentOnInput, foldGutter, foldKeymap } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { livePreview } from './livepreview';
import { codeLanguages } from './languages';
import { editorTheme, typographyTheme, highlightExtension, autoPairEnabled } from './theme';
import {
  setHeading, toggleBold, toggleItalic, toggleStrike, toggleCode,
  toggleQuote, toggleBulletList, toggleOrderedList, toggleTaskList,
  insertCodeBlock, insertLink, insertHr, insertTable, insertHighlight,
  smartEnter, indentMore, indentLess,
} from './commands';
import type { EditorSettings } from '../core/types';

export interface EditorHandle {
  view: EditorView | null;
  focus: () => void;
  getContent: () => string;
  setContent: (text: string) => void;
  run: (fn: (v: EditorView) => boolean) => void;
  scrollToTop: () => void;
}

interface Props {
  content: string;
  onChange: (text: string) => void;
  onSave: () => void;
  onOpenLink: (href: string) => void;
  settings: EditorSettings;
  docKey: string;
  onSelectionChange?: (info: { line: number; col: number; selLen: number; chars: number }) => void;
  handleRef?: (h: EditorHandle) => void;
}

/** 格式命令注册表：供工具栏与快捷键共用 */
export const formatActions = {
  h1: setHeading,
  bold: toggleBold,
  italic: toggleItalic,
  strike: toggleStrike,
  code: toggleCode,
  quote: toggleQuote,
  ul: toggleBulletList,
  ol: toggleOrderedList,
  task: toggleTaskList,
  codeblock: insertCodeBlock,
  link: insertLink,
  hr: insertHr,
  table: insertTable,
  highlight: insertHighlight,
} as const;

export function MarkdownEditor({
  content,
  onChange,
  onSave,
  onOpenLink,
  settings,
  docKey,
  onSelectionChange,
  handleRef,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onOpenLinkRef = useRef(onOpenLink);
  const onSelRef = useRef(onSelectionChange);
  const suppressRef = useRef(false);
  const settingsComp = useRef(new Compartment());
  const autoPairComp = useRef(new Compartment());

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onOpenLinkRef.current = onOpenLink;
  onSelRef.current = onSelectionChange;

  // 创建编辑器（仅一次）
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const saveKey = {
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        onSaveRef.current();
        return true;
      },
    };

    const formatKeymap = [
      { key: 'Mod-1', run: (v: EditorView) => setHeading(v, 1) },
      { key: 'Mod-2', run: (v: EditorView) => setHeading(v, 2) },
      { key: 'Mod-3', run: (v: EditorView) => setHeading(v, 3) },
      { key: 'Mod-4', run: (v: EditorView) => setHeading(v, 4) },
      { key: 'Mod-5', run: (v: EditorView) => setHeading(v, 5) },
      { key: 'Mod-6', run: (v: EditorView) => setHeading(v, 6) },
      { key: 'Mod-0', run: (v: EditorView) => setHeading(v, 0) },
      { key: 'Mod-b', run: toggleBold, preventDefault: true },
      { key: 'Mod-i', run: toggleItalic, preventDefault: true },
      { key: 'Mod-Shift-x', run: toggleStrike, preventDefault: true },
      { key: 'Mod-e', run: toggleCode, preventDefault: true },
      { key: 'Mod-Shift-e', run: insertCodeBlock, preventDefault: true },
      { key: 'Mod-Shift-.', run: toggleQuote, preventDefault: true },
      { key: 'Mod-Shift-8', run: toggleBulletList, preventDefault: true },
      { key: 'Mod-Shift-7', run: toggleOrderedList, preventDefault: true },
      { key: 'Mod-Shift-9', run: toggleTaskList, preventDefault: true },
      { key: 'Mod-k', run: insertLink, preventDefault: true },
      { key: 'Mod-Shift--', run: insertHr, preventDefault: true },
      { key: 'Mod-Shift-t', run: insertTable, preventDefault: true },
      { key: 'Enter', run: smartEnter },
      { key: 'Tab', run: indentMore, preventDefault: true },
      { key: 'Shift-Tab', run: indentLess, preventDefault: true },
    ];

    const extensions: Extension[] = [
      lineNumbersPlaceholder(),
      highlightSpecialChars(),
      history(),
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
      search({ top: false }),
      markdown({
        base: markdownLanguage,
        codeLanguages,
        addKeymap: true,
      }),
      editorTheme,
      typographyTheme,
      highlightExtension,
      autoPairComp.current.of(settings.autoPair ? autoPairEnabled() : []),
      livePreview({ onOpenLink: (href) => onOpenLinkRef.current(href) }),
      settingsComp.current.of([]),
      cmPlaceholder('开始输入…  支持 Markdown 语法，所见即所得'),
      keymap.of([
        saveKey,
        ...formatKeymap,
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !suppressRef.current) {
          onChangeRef.current(u.state.doc.toString());
        }
        if (u.selectionSet || u.docChanged) {
          const sel = u.state.selection.main;
          const line = u.state.doc.lineAt(sel.head);
          onSelRef.current?.({
            line: line.number,
            col: sel.head - line.from + 1,
            selLen: sel.to - sel.from,
            chars: u.state.doc.length,
          });
        }
      }),
      EditorView.contentAttributes.of({
        spellcheck: String(settings.spellcheck),
        autocorrect: 'off',
        autocapitalize: 'off',
      }),
    ];

    const view = new EditorView({
      state: EditorState.create({ doc: content, extensions }),
      parent: host,
    });
    viewRef.current = view;

    handleRef?.({
      view,
      focus: () => view.focus(),
      getContent: () => view.state.doc.toString(),
      setContent: (text: string) => {
        suppressRef.current = true;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: 0 },
        });
        suppressRef.current = false;
      },
      run: (fn) => {
        fn(view);
        view.focus();
      },
      scrollToTop: () => view.dispatch({ effects: EditorView.scrollIntoView(0) }),
    });

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 文档切换：整体替换内容
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === content) return;
    suppressRef.current = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      selection: { anchor: 0 },
      scrollIntoView: true,
    });
    suppressRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // 外部内容变化（如恢复历史版本）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === content) return;
    suppressRef.current = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
    });
    suppressRef.current = false;
  }, [content]);

  // 设置变更：字号、行高、宽度、拼写检查、自动配对
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        settingsComp.current.reconfigure([
          EditorView.contentAttributes.of({
            spellcheck: String(settings.spellcheck),
            autocorrect: 'off',
            autocapitalize: 'off',
          }),
        ]),
        autoPairComp.current.reconfigure(settings.autoPair ? autoPairEnabled() : []),
      ],
    });
    const root = view.dom;
    root.style.setProperty('--doc-font-size', `${settings.fontSize}px`);
    root.style.setProperty('--doc-line-height', String(settings.lineHeight));
    root.style.setProperty('--doc-max-width', `${settings.maxWidth}px`);
    root.style.setProperty('--doc-pad-x', settings.maxWidth > 0 ? '30px' : '24px');
    if (settings.fontFamily) root.style.setProperty('--font-read', settings.fontFamily);
  }, [settings]);

  return <div className="editor-host" ref={hostRef} />;
}

/** 预留：行号能力 */
function lineNumbersPlaceholder(): Extension {
  return [];
}

export { undo, redo, foldGutter, syntaxHighlighting, autoPairEnabled };
