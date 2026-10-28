<script setup lang="ts">
/**
 * 文档标题行（正文第一行的「文件名」）
 *
 * 产品约定（1.1.7 用户原话）：
 *   「正文的第一行显示文件名称，修改此行同步修改文件名；次行不冻结，不占行号数」
 *
 * 设计要点（**关键：不往 markdown 内容里插一行**）：
 * - 这是**独立的 UI 层**，值绑定文档 `title`，不写进 `modelValue`。
 *   因此不会改变内容 hash —— 同步去重、历史版本、导出、分享全部不受影响。
 * - **不冻结**：它是滚动容器内的普通块（非 sticky/fixed），随正文一起滚走。
 * - **不占行号**：真实行号由 content.css 的 `.nm-show-linenos` 计数，作用域是
 *   `.ProseMirror > *`（正文块）。标题行在 ProseMirror 之外，天然不参与计数，
 *   所以正文第一块的行号从 1 开始。
 * - 双向同步：`title` prop 变化 → 输入框内容跟随（外部改名，如左侧文件列表改名）；
 *   用户提交（回车/失焦）→ emit `rename` 交上层执行 `vault.rename`。
 *
 * 样式上与正文首行保持一致（同字号、同左右内边距、同字体），视觉上就像正文的第一行；
 * 但它是 `<input>`，因此可直接点进去编辑，且不会污染文档内容。
 */
import { computed, nextTick, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    /** 当前文档标题（不含 `.md` 后缀） */
    modelValue: string;
    /** 正文编辑区的左内边距（px），用于与正文对齐 */
    paddingLeft?: number;
    paddingRight?: number;
    /** 字号（px），与正文一致 */
    fontSize?: number;
    /** 是否只读（阅读模式） */
    readonly?: boolean;
    /** 占位文案 */
    placeholder?: string;
  }>(),
  {
    paddingLeft: 32,
    paddingRight: 32,
    fontSize: 16,
    readonly: false,
    placeholder: '未命名文档',
  },
);

const emit = defineEmits<{
  /** 提交新标题（已 trim，且与旧值不同才会触发） */
  rename: [string];
  /** 聚焦/失焦，供上层做轻量状态展示 */
  focus: [];
  blur: [];
}>();

const inputEl = ref<HTMLInputElement | null>(null);
/** 输入框内的临时值（编辑期不直接改外部状态，避免每次按键触发重命名） */
const draft = ref(props.modelValue);

/** 外部标题变化（含左侧文件列表改名、AI 改名）→ 同步到输入框 */
watch(
  () => props.modelValue,
  (next) => {
    // 正在输入时不要用外部值覆盖用户正在敲的内容
    if (inputEl.value && document.activeElement === inputEl.value) return;
    draft.value = next;
  },
);

const displayValue = computed(() => draft.value);

/** 提交：trim 后与原值比较，有变化才 emit */
function commit(): void {
  const next = draft.value.trim();
  if (!next) {
    // 不允许空标题：回退到原值，避免把文件名清空
    draft.value = props.modelValue;
    return;
  }
  if (next === props.modelValue) {
    draft.value = next;
    return;
  }
  draft.value = next;
  emit('rename', next);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    commit();
    // 回车后把焦点交给正文，符合「改完标题直接写正文」的直觉
    inputEl.value?.blur();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    draft.value = props.modelValue;
    inputEl.value?.blur();
  }
}

function onFocus(): void {
  emit('focus');
}

function onBlur(): void {
  commit();
  emit('blur');
}

/** 供上层（如「重命名」命令）把焦点移到标题行 */
async function startEdit(): Promise<void> {
  await nextTick();
  const el = inputEl.value;
  if (!el) return;
  el.focus();
  el.select();
}

defineExpose({ startEdit });
</script>

<template>
  <div
    class="nm-titleline"
    :style="{
      paddingLeft: `${paddingLeft}px`,
      paddingRight: `${paddingRight}px`,
      /* 分割线的左右内缩量与容器 padding 保持一致，线正好从文字左缘画到右缘 */
      '--nm-titleline-pad-left': `${paddingLeft}px`,
      '--nm-titleline-pad-right': `${paddingRight}px`,
    }"
  >
    <input
      ref="inputEl"
      class="nm-titleline__input"
      type="text"
      :value="displayValue"
      :readonly="readonly"
      :placeholder="placeholder"
      :style="{ fontSize: `${fontSize}px` }"
      :title="readonly ? modelValue : '点击修改文件名（回车确认，Esc 取消）'"
      aria-label="文档文件名"
      data-testid="doc-title-line"
      @input="draft = ($event.target as HTMLInputElement).value"
      @keydown="onKeydown"
      @focus="onFocus"
      @blur="onBlur"
    />
  </div>
</template>

<style scoped>
/*
 * 文件名标题行（1.1.8 补分割线）。
 *
 * 行为要求（用户原话）：
 * - 首行显示文件名、可直接编辑、改完同步重命名文件；
 * - **不冻结**：随内容滚走（不设 position: sticky / fixed）；
 * - **不占行号**：行号由正文 CSS counter 计数，这一层在 ProseMirror 之外，天然不计数。
 */
.nm-titleline {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  padding-top: 24px;
  /* 底部留白给分割线一点呼吸，避免线紧贴文字下缘 */
  padding-bottom: 12px;
  /* 为下方绝对定位的分割线提供定位上下文 */
  position: relative;
}

/*
 * 分割线（1.1.8 新增，用户要求「需要有分割线区分」）。
 *
 * 为什么用 ::after 而不是给容器加 border-bottom：
 * 容器左右有 padding，border 会横贯到 padding 外侧、与正文排版对不齐；
 * 伪元素可以按调用方传入的左右 padding 精确对齐正文内容区。
 * 左右内缩量通过 CSS 变量注入（见模板 style），默认 32px 与 WYSIWYG 正文对齐。
 */
.nm-titleline::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: var(--nm-titleline-pad-left, 32px);
  right: var(--nm-titleline-pad-right, 32px);
  height: 0;
  border-bottom: 1px solid var(--border-strong, var(--border));
  pointer-events: none;
}

.nm-titleline__input {
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  border: none;
  outline: none;
  background: transparent;
  color: var(--fg);
  font-family: var(--font-content, var(--font-ui));
  font-weight: 700;
  line-height: 1.35;
  padding: 0;
  margin: 0;
}

.nm-titleline__input::placeholder {
  color: var(--fg-3);
  font-weight: 400;
}

/* 悬停时给一点点提示，但不做边框跳动，避免视觉噪声 */
.nm-titleline__input:hover {
  background: var(--bg-hover);
  border-radius: 4px;
}

.nm-titleline__input:focus {
  background: var(--accent-weak-2);
  border-radius: 4px;
  box-shadow: 0 0 0 2px var(--accent-weak);
}
</style>
