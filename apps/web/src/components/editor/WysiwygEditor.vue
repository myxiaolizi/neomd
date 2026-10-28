<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import Placeholder from '@tiptap/extension-placeholder';
import CharacterCount from '@tiptap/extension-character-count';
import Image from '@tiptap/extension-image';
import { markdownToHtml, htmlToSource } from '@neomd/core';
import { useSettingsStore } from '@/stores/settings';

const props = defineProps<{
  modelValue: string;
  fontSize?: number;
  lineHeight?: number;
  placeholder?: string;
  readonly?: boolean;
  /**
   * 拼写检查开关。显式传入时以 prop 为准；不传时**回退到设置里
   * `appearance.spellcheck`**。
   *
   * 为什么组件内部直接读 store 而不强制宿主传参：
   * 本组件在同一个页面里会被实例化多次（主栏 + 分屏第二栏），宿主是
   * `EditorPage.vue`，而该文件由并行任务维护、不属于本次改动范围。
   * 直读 store 可以让每个实例各自响应设置变化，且不产生对宿主的耦合。
   */
  spellcheck?: boolean;
  /**
   * 当前文档标题（不含扩展名）。
   *
   * 用途：1.1.7 起正文顶部有独立的「标题行」显示文件名，而历史文档内容里
   * 往往还带着开头那句 `# 文件名`。两者同时显示会重复，因此这里在**纯展示层**
   * 把「与标题完全相同的第一块 H1」隐藏掉 —— 不修改内容、不改变 hash。
   */
  title?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [string];
  scroll: [number];
  ready: [Editor];
  wordCount: [{ chars: number; words: number }];
}>();

const host = ref<HTMLDivElement | null>(null);
const editor = shallowRef<Editor | null>(null);
let internal = false;
let lastEmittedSource = props.modelValue;

const settingsStore = useSettingsStore();

/**
 * 生效的拼写检查开关。
 *
 * 优先级：显式 prop > 设置项 `appearance.spellcheck` > 关闭。
 * 用 computed 而不是在 createEditor() 里读一次就固定：设置页里改开关后，
 * 页面上所有已挂载的实例（主栏 + 分屏第二栏）都要立刻跟随。
 */
const spellcheckEnabled = computed<boolean>(() => {
  if (typeof props.spellcheck === 'boolean') return props.spellcheck;
  return settingsStore.settings.appearance?.spellcheck === true;
});

/**
 * 内容开头是否带一句「与文件名相同的 H1」。
 *
 * 1.1.7 起正文顶部有独立标题行显示文件名；而历史文档（以及 `vault.create()` 的默认内容
 * `# 标题`）内容里往往还有一句同名 H1。两者同时显示就是同一个名字出现两次，
 * 因此这里**只在展示层**把那个重复的 H1 隐藏 —— 不修改内容、不改变 hash。
 */
const hasDuplicateLeadingH1 = computed(() => {
  const title = (props.title ?? '').trim();
  if (!title) return false;
  const first = /^\s*(?:---\n[\s\S]*?\n---\n)?\s*#\s+(.+)$/.exec(props.modelValue ?? '');
  if (!first) return false;
  const headingText = (first[1] ?? '').trim().replace(/[*_`~]/g, '');
  return headingText === title;
});

/** 以纯文本方式插入剪贴板内容（Ctrl+Shift+V / 右键「粘贴为纯文本」） */
function insertPlainClipboard(editor: Editor): void {
  const read = navigator.clipboard?.readText?.();
  if (!read) return;
  void read
    .then((text) => {
      if (!text) return;
      editor.commands.focus();
      // ProseMirror 的 pasteText 会把换行拆成段落，且不解析任何 HTML / Markdown 标记
      editor.view.pasteText(text);
    })
    .catch(() => undefined);
}

/** 拦截 Mod+Shift+V：无论处于何种选择状态都按纯文本粘贴 */
const PlainTextPaste = Extension.create({
  name: 'nmPlainTextPaste',
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-v': () => {
        insertPlainClipboard(this.editor);
        return true;
      },
    };
  },
});

function createEditor(): void {
  if (!host.value) return;
  const instance = new Editor({
    element: host.value,
    content: markdownToHtml(props.modelValue),
    editable: !props.readonly,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        codeBlock: { HTMLAttributes: { class: 'nm-code-block' } },
      }),
      TableKit.configure({ table: { resizable: false, allowTableNodeSelection: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Highlight.configure({ multicolor: false }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Image.configure({ inline: false, allowBase64: false }),
      Placeholder.configure({ placeholder: props.placeholder ?? '开始写作…' }),
      CharacterCount.configure({ limit: null }),
      PlainTextPaste,
    ],
    editorProps: {
      attributes: {
        class: 'nm-content ProseMirror',
        // 拼写检查跟随设置（1.1.9 接线）。此前这里硬编码 String(false)，
        // 设置里的开关改了也没有任何可观测效果 —— 典型的「假开关」。
        spellcheck: String(spellcheckEnabled.value),
      },
      handleClick: (_view, _pos, event) => {
        const target = event.target as HTMLElement | null;
        const anchor = target?.closest('a');
        if (!anchor) return false;
        const href = anchor.getAttribute('href') ?? '';
        if (href.startsWith('neomd://wiki/')) {
          event.preventDefault();
          const rest = href.slice('neomd://wiki/'.length);
          const target = decodeURIComponent(rest.split('?')[0]?.split('#')[0] ?? '');
          window.dispatchEvent(new CustomEvent('neomd:open-wiki', { detail: target }));
          return true;
        }
        if (/^https?:/.test(href)) {
          window.open(href, '_blank', 'noopener');
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (internal) return;
      const source = htmlToSource(ed.getHTML(), props.modelValue);
      lastEmittedSource = source;
      queueMicrotask(() => {
        emit('update:modelValue', source);
        emit('wordCount', {
          chars: ed.storage.characterCount.characters(),
          words: ed.storage.characterCount.words(),
        });
      });
    },
  });
  editor.value = instance;
  // 挂载后补一次 spellcheck：上面的 watch 是 immediate 的，但它在 setup 阶段
  // 执行时 editor 还是 null，所以真正挂到 DOM 上之后要再落一次（见 watch 注释）。
  instance.view.dom.setAttribute('spellcheck', String(spellcheckEnabled.value));
  emit('ready', instance);
  emit('wordCount', {
    chars: instance.storage.characterCount.characters(),
    words: instance.storage.characterCount.words(),
  });

  // 滚动同步
  instance.on('transaction', () => {
    /* noop */
  });
  const scroller = host.value.querySelector('.tiptap, .ProseMirror') as HTMLElement | null;
  if (scroller) {
    scroller.addEventListener('scroll', () => {
      const max = scroller.scrollHeight - scroller.clientHeight;
      emit('scroll', max > 0 ? scroller.scrollTop / max : 0);
    });
  }
}

watch(
  () => props.modelValue,
  (next) => {
    const ed = editor.value;
    if (!ed) return;
    if (next === lastEmittedSource) return;
    // 用户正在聚焦编辑时不因外部响应式回流重置 DOM 与选区
    if (ed.isFocused) {
      lastEmittedSource = next;
      return;
    }
    const currentMd = htmlToSource(ed.getHTML(), props.modelValue);
    if (currentMd === next) {
      lastEmittedSource = next;
      return;
    }
    const nextHtml = markdownToHtml(next);
    if (ed.getHTML() === nextHtml) {
      lastEmittedSource = next;
      return;
    }
    internal = true;
    ed.commands.setContent(nextHtml, { emitUpdate: false });
    internal = false;
    lastEmittedSource = next;
  },
);

watch(
  () => props.readonly,
  (v) => editor.value?.setEditable(!v),
);

/**
 * 拼写检查开关实时生效（1.1.9）。
 *
 * 为什么要「setOptions + 直接写 DOM」双保险：
 * Tiptap 的 `setOptions({ editorProps })` 只保证后续渲染用新 editorProps，
 * 对**已经挂到文档里的** DOM 属性并不总是立刻重写（ProseMirror 只在
 * 属性 diff 时才写回）。而 `spellcheck` 是纯 DOM 属性、没有对应装饰层，
 * 所以这里补一次显式 setAttribute —— 无论 Tiptap 内部怎么处理，
 * 挂载后的 `.ProseMirror` 上的值一定是准的。
 */
watch(
  spellcheckEnabled,
  (v) => {
    const enabled = Boolean(v);
    const ed = editor.value;
    if (ed) {
      ed.setOptions({
        editorProps: {
          attributes: { class: 'nm-content ProseMirror', spellcheck: String(enabled) },
        },
      });
      ed.view.dom.setAttribute('spellcheck', String(enabled));
    }
  },
  { immediate: true, flush: 'post' },
);

onMounted(createEditor);
onBeforeUnmount(() => {
  editor.value?.destroy();
  editor.value = null;
});

function focus(): void {
  editor.value?.commands.focus();
}

function scrollToRatio(ratio: number): void {
  const el = host.value?.querySelector('.tiptap, .ProseMirror') as HTMLElement | null;
  if (!el) return;
  const max = el.scrollHeight - el.clientHeight;
  if (max > 0) el.scrollTop = max * Math.max(0, Math.min(1, ratio));
}

function runCommand(fn: (ed: Editor) => void): void {
  if (editor.value) fn(editor.value);
}

function getHTML(): string {
  return editor.value?.getHTML() ?? '';
}

function getSelectionText(): string {
  const ed = editor.value;
  if (!ed) return '';
  const { from, to } = ed.state.selection;
  return ed.state.doc.textBetween(from, to, '\n');
}

function replaceSelection(text: string): void {
  editor.value?.chain().focus().deleteSelection().insertContent(text).run();
}

/** 插入纯文本：不解析 HTML / Markdown，保留换行分段 */
function pastePlainText(text?: string): void {
  const ed = editor.value;
  if (!ed) return;
  const run = (value: string): void => {
    if (!value) return;
    ed.commands.focus();
    (ed.view as unknown as { pasteText(value: string): void }).pasteText(value);
  };
  if (typeof text === 'string') {
    run(text);
    return;
  }
  void navigator.clipboard
    ?.readText?.()
    .then(run)
    .catch(() => undefined);
}

function insertMarkdownBlock(md: string): void {
  const ed = editor.value;
  if (!ed) return;
  ed.chain().focus().insertContent(markdownToHtml(md)).run();
}

function setHeading(level: 1 | 2 | 3 | 4 | 5 | 6): void {
  const ed = editor.value;
  if (!ed) return;
  if (ed.isActive('heading', { level })) {
    ed.commands.setParagraph();
  } else {
    ed.commands.setNode('heading', { level });
  }
}

defineExpose({ focus, scrollToRatio, runCommand, getHTML, getSelectionText, replaceSelection, pastePlainText, insertMarkdownBlock, setHeading, editor });
</script>

<template>
  <div
    class="wysiwyg"
    :class="{ 'wysiwyg--hide-leading-h1': hasDuplicateLeadingH1 }"
    :style="{ '--content-font-size': `${fontSize ?? 16}px`, '--content-line-height': String(lineHeight ?? 1.75) }"
  >
    <!--
      标题行插槽：放在滚动容器 `.wysiwyg` 内部（不是外层），因此会随正文一起滚走，
      满足「次行不冻结」；且它在 ProseMirror 之外，行号 CSS 不会给它编号。
    -->
    <slot name="title" />
    <div ref="host" class="wysiwyg__host nm-content" />
  </div>
</template>

<style scoped>
.wysiwyg {
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.wysiwyg__host {
  min-height: 100%;
  padding: 24px 0 160px;
}
/* 有标题行时压缩正文顶部留白，避免「标题行 + 大留白」显得脱节 */
.wysiwyg:has(> .nm-titleline) .wysiwyg__host {
  padding-top: 4px;
}

/* 内容开头的 H1 与标题行重复时隐藏它（纯展示层，内容与 hash 均不变）。
   用 visibility/height 而非 display:none，避免 ProseMirror 因节点不可见而产生
   选区异常；对用户而言这一行已经由顶部标题行承担，不可见不影响编辑其他内容。 */
.wysiwyg--hide-leading-h1 :deep(.ProseMirror > h1:first-child) {
  display: none;
}
:deep(.ProseMirror) {
  outline: none;
  min-height: 320px;
}
</style>
