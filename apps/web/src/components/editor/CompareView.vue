<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { markdownToHtml } from '@neomd/core';
import SourceEditor from './SourceEditor.vue';

const props = defineProps<{
  modelValue: string;
  fontSize?: number;
  lineHeight?: number;
  showLineNumbers?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [string] }>();

/** 源码栏实例：用于被预览栏滚动驱动（组件暴露了 scrollToRatio） */
const sourceEl = ref<InstanceType<typeof SourceEditor> | null>(null);
/** 预览栏的滚动容器（标题行与正文都在它里面，共享同一滚动上下文） */
const previewScrollEl = ref<HTMLDivElement | null>(null);
/** 预览栏正文容器：markdown 渲染结果写它的 innerHTML */
const previewEl = ref<HTMLDivElement | null>(null);

const html = computed(() => markdownToHtml(props.modelValue, { externalTarget: '_blank', interactiveLinks: true }));

/**
 * 预览栏的排版变量（1.2.1 缺陷3）。
 *
 * 只写「调用方真的传了」的那几项：`fontSize` / `lineHeight` 是可选的，
 * 不传时必须保持**不声明**，让 `.nm-content` 回落到 <html> 上的全局变量
 * （那个值已经按 zoom 换算过）。若这里无条件写 `${fontSize ?? 16}px`，
 * 反而会遮蔽全局缩放值 —— WysiwygEditor 的历史写法就踩过这个坑
 * （见 EditorPage.vue 里 effectiveFontSize 的注释）。
 */
const previewVars = computed<Record<string, string>>(() => {
  const vars: Record<string, string> = {};
  if (typeof props.fontSize === 'number' && props.fontSize > 0) {
    vars['--content-font-size'] = `${props.fontSize}px`;
  }
  if (typeof props.lineHeight === 'number' && props.lineHeight > 0) {
    vars['--content-line-height'] = String(props.lineHeight);
  }
  return vars;
});

function paint(): void {
  if (previewEl.value) previewEl.value.innerHTML = html.value;
}

watch(html, paint);
onMounted(paint);

/**
 * 双向滚动同步的防回环锁。
 *
 * 两栏互相驱动滚动时，A 设置 B 的 scrollTop 会再次触发 B 的 scroll 事件、
 * 又把 A 拉过去，出现肉眼可见的抖动。60ms 足够覆盖一次事件派发，
 * 又短到用户拖动时感觉不到延迟。
 */
let lock = false;
function withSyncLock(fn: () => void): void {
  if (lock) return;
  lock = true;
  fn();
  setTimeout(() => {
    lock = false;
  }, 60);
}

function ratioOf(el: HTMLElement): number {
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? el.scrollTop / max : 0;
}

/** 预览栏滚动 → 驱动源码栏跟到相同进度 */
function onPreviewScroll(e: Event): void {
  const el = e.target as HTMLElement;
  const ratio = ratioOf(el);
  withSyncLock(() => sourceEl.value?.scrollToRatio(ratio));
}

/** 源码栏滚动（SourceEditor 已把 ratio 算好 emit 出来）→ 驱动预览栏 */
function onSourceScroll(ratio: number): void {
  withSyncLock(() => {
    const el = previewScrollEl.value;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max > 0) el.scrollTop = max * Math.max(0, Math.min(1, ratio));
  });
}

function scrollToRatio(ratio: number): void {
  const el = previewScrollEl.value;
  if (!el) return;
  const max = el.scrollHeight - el.clientHeight;
  el.scrollTop = max * Math.max(0, Math.min(1, ratio));
}

defineExpose({ scrollToRatio });
</script>

<template>
  <div class="compare">
    <section class="compare__pane">
      <header class="compare__head">源码</header>
      <div class="compare__body">
        <SourceEditor
          ref="sourceEl"
          :model-value="modelValue"
          :font-size="fontSize"
          :line-height="lineHeight"
          :show-line-numbers="showLineNumbers"
          @update:model-value="emit('update:modelValue', $event)"
          @scroll="onSourceScroll"
        >
          <template #title>
            <slot name="title" />
          </template>
        </SourceEditor>
      </div>
    </section>
    <section class="compare__pane">
      <header class="compare__head">预览</header>
      <!--
        预览栏同样要有「正文第一行 = 文件名」（1.1.9 补）。
        改前右侧只剩渲染出来的 HTML：左边第一行是文件名、右边第一行直接是正文，
        对照阅读时视线永远错开一行。

        结构上必须「滚动容器 > 标题行 + 正文」：标题行放在 markdown 渲染目标**之外**，
        否则 `previewEl.innerHTML = html` 会把标题行一起冲掉。
      -->
      <div ref="previewScrollEl" class="compare__body compare__body--preview" @scroll="onPreviewScroll">
        <slot name="preview-title" />
        <!--
          右侧预览也必须跟随「字号 / 行高」设置（1.2.1 缺陷3）。
          改前 `fontSize` / `lineHeight` 两个 prop 只传给了左侧 SourceEditor，
          预览栏完全没绑 —— 用户在设置里把正文调到 20px，右栏还是 16px，
          两栏对照时字号行高都对不上。这里把同一组变量写到预览容器上，
          `.nm-content` 会照常消费它们（与 WysiwygEditor 的写法一致）。
        -->
        <div ref="previewEl" class="compare__preview nm-content" :style="previewVars" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.compare {
  display: grid;
  grid-template-columns: 1fr 1fr;
  height: 100%;
  min-height: 0;
}
.compare__pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--border);
}
.compare__pane:last-child {
  border-right: none;
}
.compare__head {
  height: 30px;
  display: flex;
  align-items: center;
  padding: 0 14px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fg-3);
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
  flex: 0 0 auto;
}
.compare__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
/*
 * 预览栏滚动容器：左右内边距下沉到内容层（`.compare__preview`），
 * 这样标题行与正文的左缘才能靠 DocTitleLine 的 paddingLeft 精确对齐。
 */
.compare__body--preview {
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 0 120px;
  /*
   * 预览栏 = 纸张（1.2.1 缺陷3）。
   *
   * 为什么必须显式上色：改前这一栏完全透明，透出来的是祖先 `.shell__main` 的
   * `background: var(--bg-elevated)`。浅色主题下两者恰好都是白色，看不出问题；
   * 一旦换成深色主题或护眼绿这类「chrome 色 ≠ 纸张色」的主题，
   * 左右两栏就成了两种底色，用户看到的就是「右侧预览颜色不对」。
   *
   * 取 `--content-bg`（正文纸张）而不是 `--bg-elevated`：
   * `--bg-elevated` 是「界面抬升层」的语义，主题的「应用范围」选「仅正文」时
   * 它不会跟着正文主题走；`--content-bg` 才是正文纸张的权威变量。
   * 文字色取 `--content-fg`，与主编辑器 `.nm-content` 保持同一套。
   */
  background: var(--content-bg, var(--bg-elevated));
  color: var(--content-fg, var(--fg));
}
.compare__preview {
  padding: 0 28px;
}
@media (max-width: 900px) {
  .compare {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
  }
  .compare__pane {
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
}
</style>
