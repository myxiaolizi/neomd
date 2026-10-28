<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NmIcon } from '@neomd/ui';
import type { EditorMode, PageWidth } from '@neomd/shared';
import { DEFAULT_TOOLBAR_ITEMS } from '@neomd/core';

const props = defineProps<{
  mode: EditorMode;
  pageWidth: PageWidth;
  dirty: boolean;
  autosaveEnabled: boolean;
  showFormatTools: boolean;
  toolbarItems?: string[];
  rightPanelOpen?: boolean;
}>();

const emit = defineEmits<{
  newDoc: [];
  save: [];
  toggleAutosave: [];
  openPalette: [];
  cmd: [string, string?];
  openHistory: [];
  setMode: [EditorMode];
  setPageWidth: [PageWidth];
  openShare: [];
  openExport: [];
  toggleRightPanel: [];
  /** 工具栏按钮顺序/内容变化（拖动排序、右键隐藏、恢复默认） */
  reorderTools: [string[]];
}>();

export interface ToolDef {
  id: string;
  icon: string;
  textIcon?: string;
  title: string;
  arg?: string;
}

const ALL_TOOLS: Record<string, ToolDef> = {
  undo: { id: 'undo', icon: 'restore', title: '撤销 Ctrl+Z' },
  redo: { id: 'redo', icon: 'refresh', title: '重做 Ctrl+Shift+Z' },
  h1: { id: 'h1', icon: 'heading', textIcon: 'H1', title: '一级标题 Ctrl+1', arg: '1' },
  h2: { id: 'h2', icon: 'heading', textIcon: 'H2', title: '二级标题 Ctrl+2', arg: '2' },
  h3: { id: 'h3', icon: 'heading', textIcon: 'H3', title: '三级标题 Ctrl+3', arg: '3' },
  bold: { id: 'bold', icon: 'bold', title: '加粗 Ctrl+B' },
  italic: { id: 'italic', icon: 'italic', title: '斜体 Ctrl+I' },
  underline: { id: 'underline', icon: 'underline', title: '下划线 Ctrl+U' },
  strike: { id: 'strike', icon: 'strike', title: '删除线 Ctrl+Shift+X' },
  highlight: { id: 'highlight', icon: 'highlighter', title: '高亮 Ctrl+Shift+H' },
  code: { id: 'code', icon: 'code', title: '行内代码' },
  ul: { id: 'ul', icon: 'list', title: '无序列表 Ctrl+Shift+8' },
  ol: { id: 'ol', icon: 'outline', title: '有序列表 Ctrl+Shift+9' },
  task: { id: 'task', icon: 'check', title: '任务列表 Ctrl+Shift+T' },
  quote: { id: 'quote', icon: 'quote', title: '引用 Ctrl+Shift+Q' },
  table: { id: 'table', icon: 'table', title: '插入表格 Ctrl+Shift+M' },
  link: { id: 'link', icon: 'link', title: '插入链接 Ctrl+K' },
  image: { id: 'image', icon: 'image', title: '插入图片' },
  codeblock: { id: 'codeblock', icon: 'codeBlock', title: '代码块 Ctrl+Shift+E' },
  hr: { id: 'hr', icon: 'hr', title: '分隔线 Ctrl+Shift+-' },
};

const MODES: Array<{ id: EditorMode; label: string; icon: string }> = [
  { id: 'wysiwyg', label: '所见即所得', icon: 'type' },
  { id: 'source', label: '源码模式', icon: 'code' },
  { id: 'compare', label: '对照模式', icon: 'columns' },
  { id: 'read', label: '阅读视图', icon: 'book' },
];

const WIDTHS: Array<{ id: PageWidth; label: string; hint: string }> = [
  { id: 'narrow', label: '窄', hint: '620px 舒适阅读' },
  { id: 'standard', label: '标准', hint: '760px 默认' },
  { id: 'wide', label: '宽', hint: '1080px' },
  { id: 'full', label: '铺满', hint: '占满可用宽度' },
];

const modeOpen = ref(false);
const widthOpen = ref(false);
const overflowOpen = ref(false);
const midEl = ref<HTMLElement | null>(null);
const maxVisibleCount = ref(20);

const currentMode = computed(() => MODES.find((m) => m.id === props.mode) ?? MODES[0]!);
const currentWidth = computed(() => WIDTHS.find((w) => w.id === props.pageWidth) ?? WIDTHS[1]!);

const activeTools = computed<ToolDef[]>(() => {
  const ids = props.toolbarItems && props.toolbarItems.length ? props.toolbarItems : DEFAULT_TOOLBAR_ITEMS;
  return ids.map((id) => ALL_TOOLS[id]).filter((x): x is ToolDef => Boolean(x));
});

const visibleTools = computed(() => activeTools.value.slice(0, maxVisibleCount.value));
const overflowTools = computed(() => activeTools.value.slice(maxVisibleCount.value));

function measureOverflow(): void {
  const el = midEl.value;
  if (!el) return;
  const avail = el.clientWidth;
  if (avail <= 0) return;
  const perBtn = 30;
  const fit = Math.max(1, Math.floor((avail - 34) / perBtn));
  maxVisibleCount.value = fit >= activeTools.value.length ? activeTools.value.length : Math.max(1, fit);
}

function toggleWidth(): void {
  widthOpen.value = !widthOpen.value;
  modeOpen.value = false;
  overflowOpen.value = false;
}

function toggleMode(): void {
  modeOpen.value = !modeOpen.value;
  widthOpen.value = false;
  overflowOpen.value = false;
}

let ro: ResizeObserver | null = null;

function chooseMode(m: EditorMode): void {
  emit('setMode', m);
  modeOpen.value = false;
}

function chooseWidth(w: PageWidth): void {
  emit('setPageWidth', w);
  widthOpen.value = false;
}

function onDocClick(e: MouseEvent): void {
  const t = e.target as HTMLElement | null;
  if (!t?.closest('.viewswitch')) modeOpen.value = false;
  if (!t?.closest('.widthswitch')) widthOpen.value = false;
  if (!t?.closest('.overflow-wrap')) overflowOpen.value = false;
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick);
  if (typeof ResizeObserver !== 'undefined' && midEl.value) {
    ro = new ResizeObserver(() => measureOverflow());
    ro.observe(midEl.value);
  }
  setTimeout(measureOverflow, 60);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick);
  ro?.disconnect();
});

watch(() => props.toolbarItems, () => setTimeout(measureOverflow, 30), { deep: true });

/* ---------------- 正文工具栏：拖动排序 + 右键隐藏（1.0.2） ---------------- */

/** 正在拖动的按钮 id */
const dragId = ref('');
/** 当前悬停的落点按钮 id */
const dropId = ref('');
/**
 * 落点位置：`before` 插到目标按钮左侧，`after` 插到右侧。
 * 由鼠标在目标按钮的左半 / 右半决定 —— 只有这样才能实现「拖到某个按钮右半边 = 放到它后面」，
 * 否则永远只能插到目标前面，跨位拖动的手感会很别扭。
 */
const dropSide = ref<'before' | 'after'>('before');

/** 工具栏右键菜单状态 */
const toolMenu = ref<{ open: boolean; x: number; y: number; id: string; label: string }>({
  open: false,
  x: 0,
  y: 0,
  id: '',
  label: '',
});

function onDragStart(e: DragEvent, id: string): void {
  dragId.value = id;
  dropId.value = '';
  // 必须设置 dataTransfer，否则部分浏览器不触发 drop
  e.dataTransfer?.setData('text/plain', id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}

function onDragOver(e: DragEvent, id: string): void {
  if (!dragId.value) return;
  dropId.value = id;
  // 用鼠标相对按钮中线的位置判断插入到左侧还是右侧
  const rect = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect();
  if (rect) dropSide.value = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
}

function onDragLeave(id: string): void {
  if (dropId.value === id) dropId.value = '';
}

function onDrop(_e: DragEvent, targetId: string): void {
  const from = dragId.value;
  const side = dropSide.value;
  dragId.value = '';
  dropId.value = '';
  if (!from || from === targetId) return;
  const list = [...(props.toolbarItems && props.toolbarItems.length ? props.toolbarItems : DEFAULT_TOOLBAR_ITEMS)];
  const i = list.indexOf(from);
  const j = list.indexOf(targetId);
  if (i < 0 || j < 0) return;
  // 先摘除源，再按「目标当前索引 ± 侧别」插入。
  // 注意摘除后目标索引可能前移一位，所以 after 情形要重新算一次。
  list.splice(i, 1);
  const targetIdx = list.indexOf(targetId);
  const insertAt = side === 'after' ? targetIdx + 1 : targetIdx;
  list.splice(insertAt < 0 ? list.length : insertAt, 0, from);
  emit('reorderTools', list);
}

function onDragEnd(): void {
  dragId.value = '';
  dropId.value = '';
  dropSide.value = 'before';
}

function openToolMenu(e: MouseEvent, id: string): void {
  const def = ALL_TOOLS[id];
  toolMenu.value = { open: true, x: e.clientX, y: e.clientY, id, label: def?.title?.replace(/\s+Ctrl.*$/, '') ?? id };
}

function closeToolMenu(): void {
  toolMenu.value = { ...toolMenu.value, open: false };
}

/** 隐藏某个工具栏按钮（从 toolbarItems 中移除） */
function hideTool(id: string): void {
  const list = [...(props.toolbarItems && props.toolbarItems.length ? props.toolbarItems : DEFAULT_TOOLBAR_ITEMS)];
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
  emit('reorderTools', list);
  closeToolMenu();
}

/** 恢复默认工具栏顺序与内容 */
function resetTools(): void {
  emit('reorderTools', [...DEFAULT_TOOLBAR_ITEMS]);
  closeToolMenu();
}

/** 工具栏右键菜单的定位（贴边翻转） */
const toolMenuStyle = computed(() => {
  const vw = typeof globalThis !== 'undefined' ? globalThis.innerWidth || 1280 : 1280;
  const vh = typeof globalThis !== 'undefined' ? globalThis.innerHeight || 800 : 800;
  return {
    left: `${Math.min(toolMenu.value.x, Math.max(8, vw - 200))}px`,
    top: `${Math.min(toolMenu.value.y, Math.max(8, vh - 130))}px`,
  };
});
</script>

<template>
  <div class="editorbar">
    <!-- 1. 文件操作栏（左对齐）：新建、保存、自动保存（开关）、命令 -->
    <div class="editorbar__group editorbar__group--left">
      <button class="tbtn" title="新建文档 Ctrl+N" @click="emit('newDoc')">
        <NmIcon name="plus" :size="15" />
      </button>
      <button class="tbtn" :class="{ 'is-dirty': dirty }" title="保存文档 Ctrl+S" @click="emit('save')">
        <NmIcon name="save" :size="15" />
      </button>
      <button
        class="autosave"
        :class="{ 'is-on': autosaveEnabled }"
        role="switch"
        :aria-checked="autosaveEnabled"
        aria-label="自动保存"
        :title="autosaveEnabled ? '自动保存已开启，点击关闭' : '自动保存已关闭，点击开启'"
        @click="emit('toggleAutosave')"
      >
        <span class="autosave__dot" aria-hidden="true" />
      </button>
      <button class="tbtn" title="正文编辑命令面板 Ctrl+P" @click="emit('openPalette')">
        <NmIcon name="command" :size="15" />
      </button>
    </div>

    <span v-if="showFormatTools && mode !== 'read'" class="editorbar__sep" />

    <!-- 2. 正文工具栏（自适应宽度，窄屏将多余按钮折叠到下拉中）
         1.0.2：支持拖动排序与右键隐藏 -->
    <div
      v-if="showFormatTools && mode !== 'read'"
      ref="midEl"
      class="editorbar__mid"
      :class="{ 'is-reordering': Boolean(dragId) }"
    >
      <button
        v-for="b in visibleTools"
        :key="b.id"
        class="tbtn"
        :class="{
          'is-dragging': dragId === b.id,
          'is-drop-before': dropId === b.id && dropSide === 'before' && dragId !== b.id,
          'is-drop-after': dropId === b.id && dropSide === 'after' && dragId !== b.id,
        }"
        :title="`${b.title}（可拖动排序，右键可隐藏）`"
        draggable="true"
        @mousedown.prevent="emit('cmd', b.id, b.arg)"
        @dragstart="onDragStart($event, b.id)"
        @dragover.prevent="onDragOver($event, b.id)"
        @dragleave="onDragLeave(b.id)"
        @drop.prevent="onDrop($event, b.id)"
        @dragend="onDragEnd"
        @contextmenu.prevent="openToolMenu($event, b.id)"
      >
        <span v-if="b.textIcon" class="tbtn__h">{{ b.textIcon }}</span>
        <NmIcon v-else :name="b.icon" :size="15" />
      </button>

      <div v-if="overflowTools.length" class="overflow-wrap">
        <button class="tbtn" title="更多编辑工具" @mousedown.prevent="overflowOpen = !overflowOpen">
          <NmIcon name="more" :size="15" />
        </button>
        <div v-if="overflowOpen" class="overflow-menu" @mousedown.stop>
          <button
            v-for="b in overflowTools"
            :key="b.id"
            class="overflow-item"
            :title="b.title"
            @mousedown.prevent="overflowOpen = false; emit('cmd', b.id, b.arg)"
          >
            <span v-if="b.textIcon" class="tbtn__h">{{ b.textIcon }}</span>
            <NmIcon v-else :name="b.icon" :size="14" />
            <span>{{ b.title.replace(/\s+Ctrl.*$/, '') }}</span>
          </button>
        </div>
      </div>
    </div>
    <div v-else class="editorbar__spacer" />

    <span class="editorbar__sep" />

    <!-- 3. 其他操作栏（靠右对齐）：历史版本、页宽、编辑模式下拉、分享与发布、导出 -->
    <div class="editorbar__group editorbar__group--right">
      <button class="tbtn" title="历史版本（查看与恢复本文档历史）" @click="emit('openHistory')">
        <NmIcon name="history" :size="15" />
      </button>

      <div class="widthswitch viewswitch">
        <button
          class="tbtn viewswitch__btn"
          :title="`页宽：${currentWidth.label}（点击切换）`"
          @click="toggleWidth"
        >
          <NmIcon name="width" :size="15" />
          <NmIcon name="chevronDown" :size="11" />
        </button>
        <div v-if="widthOpen" class="viewswitch__menu" @mousedown.stop>
          <button
            v-for="w in WIDTHS"
            :key="w.id"
            class="viewswitch__item"
            :class="{ 'is-active': w.id === pageWidth }"
            :title="w.hint"
            @click="chooseWidth(w.id)"
          >
            <NmIcon name="width" :size="14" />
            <span>{{ w.label }}</span>
            <NmIcon v-if="w.id === pageWidth" name="check" :size="13" class="viewswitch__check" />
          </button>
        </div>
      </div>

      <div class="viewswitch">
        <button
          class="tbtn viewswitch__btn"
          :title="`编辑模式：${currentMode.label}（Ctrl+E 切换）`"
          @click="toggleMode"
        >
          <NmIcon :name="currentMode.icon" :size="15" />
          <NmIcon name="chevronDown" :size="11" />
        </button>
        <div v-if="modeOpen" class="viewswitch__menu" @mousedown.stop>
          <button
            v-for="m in MODES"
            :key="m.id"
            class="viewswitch__item"
            :class="{ 'is-active': m.id === mode }"
            @click="chooseMode(m.id)"
          >
            <NmIcon :name="m.icon" :size="14" />
            <span>{{ m.label }}</span>
            <NmIcon v-if="m.id === mode" name="check" :size="13" class="viewswitch__check" />
          </button>
        </div>
      </div>

      <button class="tbtn" title="分享与发布" @click="emit('openShare')">
        <NmIcon name="share" :size="15" />
      </button>

      <button class="tbtn" title="导出文档（PDF / Word / HTML）" @click="emit('openExport')">
        <NmIcon name="download" :size="15" />
      </button>

      <button
        class="tbtn"
        :class="{ 'is-on': rightPanelOpen }"
        title="切换右侧边栏（AI 助手与文件操作）Ctrl+Shift+A"
        @click="emit('toggleRightPanel')"
      >
        <NmIcon name="panelRight" :size="15" />
      </button>
    </div>

    <!-- 工具栏按钮右键菜单（1.0.2：隐藏 / 恢复默认） -->
    <Teleport to="body">
      <div v-if="toolMenu.open" class="toolmenu__mask" @mousedown="closeToolMenu" />
      <div v-if="toolMenu.open" class="toolmenu" :style="toolMenuStyle" role="menu" @mousedown.stop>
        <div class="toolmenu__title">{{ toolMenu.label }}</div>
        <button class="toolmenu__item" role="menuitem" @click="hideTool(toolMenu.id)">
          <NmIcon name="close" :size="13" /><span>隐藏此按钮</span>
        </button>
        <div class="toolmenu__sep" />
        <button class="toolmenu__item" role="menuitem" @click="resetTools">
          <NmIcon name="restore" :size="13" /><span>恢复默认工具栏</span>
        </button>
        <p class="toolmenu__hint">提示：按钮可直接拖动排序</p>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/*
 * 拖动排序视觉反馈（1.1.8 重做）。
 *
 * 用户原话：「工具栏按钮的顺序可以支持拖动调整，而不是点击箭头调整」。
 * 拖拽本身 1.0.2 就有了，但没有**插入位置指示线** —— 用户只能看到目标按钮被框住，
 * 无法预判松手后插到目标左边还是右边，手感是"猜"的。
 * 现在按鼠标在目标按钮的左半 / 右半，在对应侧画一条 2px 竖线。
 */
.tbtn.is-dragging {
  opacity: 0.35;
  cursor: grabbing;
}
.tbtn.is-drop-before {
  box-shadow: inset 2px 0 0 var(--accent);
  border-radius: 6px;
}
.tbtn.is-drop-after {
  box-shadow: inset -2px 0 0 var(--accent);
  border-radius: 6px;
}
/* 拖动过程中统一抓取光标，明确"正在搬运"的语义 */
.editorbar__mid.is-reordering .tbtn {
  cursor: grabbing;
}

/* 工具栏按钮右键菜单 */
.toolmenu__mask {
  position: fixed;
  inset: 0;
  z-index: 9300;
}
.toolmenu {
  position: fixed;
  z-index: 9301;
  width: 190px;
  padding: 5px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-3);
}
.toolmenu__title {
  padding: 4px 9px 5px;
  font-size: 11px;
  font-weight: 600;
  color: var(--fg-3);
}
.toolmenu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--fg);
  text-align: left;
}
.toolmenu__item:hover {
  background: var(--bg-hover);
}
.toolmenu__sep {
  height: 1px;
  background: var(--border);
  margin: 4px 2px;
}
.toolmenu__hint {
  margin: 2px 9px 4px;
  font-size: 10.5px;
  color: var(--fg-3);
}
.editorbar {
  display: flex;
  align-items: center;
  gap: 4px;
  /*
   * 工具栏高度写死 38px，**不再引用 --tabbar-h**。
   *
   * 原因：`--tabbar-h` 的语义是「标签栏内容高度」，1.1.1 为了让标签卡与窗口
   * 上沿留出 3px 空隙，它已经从 38px 变成 37px。若工具栏继续绑这个变量，
   * 会被连带矮 1px（实测：改前 38px，把变量改成 37px 后工具栏立刻变 37px）。
   * 用户这次只要求标签卡上移 3px，工具栏没有任何变化需求，所以显式锁 38px。
   * 28px 的按钮在这个高度里上下各留 5px，视觉重心与改动前完全一致。
   */
  height: 38px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
  flex: 0 0 auto;
  min-width: 0;
}
.editorbar__group {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}
.editorbar__mid {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  overflow: visible;
}
.editorbar__spacer {
  flex: 1 1 auto;
}
.editorbar__sep {
  width: 1px;
  height: 16px;
  background: var(--border);
  margin: 0 4px;
  flex: 0 0 auto;
}
.tbtn {
  position: relative;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  color: var(--fg-2);
  flex: 0 0 auto;
}
.tbtn:hover {
  background: var(--bg-hover);
  color: var(--accent);
}
.tbtn.is-on {
  background: var(--bg-active);
  color: var(--accent);
}
.tbtn.is-dirty {
  color: var(--accent);
}
.tbtn__h {
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1;
}
/*
 * 自动保存状态点（PC 端不显示文字，只有状态点）：
 * 旧版「状态点 + 短文字」的胶囊在窄一点的窗口里会挤占工具栏空间，用户要求去掉文字。
 * 现在是一个 24×24 的圆点按钮：
 *   - 开启：实心强调色圆点 + 淡强调色底，一眼看出会自动落盘；
 *   - 关闭：空心灰点 + 透明底，代表已暂停。
 * 文字信息改由 title / aria-label 承载，可访问性不受影响。
 */
.autosave {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  margin: 0 2px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--fg-3);
  line-height: 1;
  flex: 0 0 auto;
  transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
}
.autosave:hover {
  background: var(--bg-hover);
  color: var(--fg-2);
}
.autosave.is-on {
  color: var(--accent);
  background: var(--accent-weak);
}
.autosave__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: transparent;
  box-shadow: inset 0 0 0 1.5px currentColor;
  opacity: 0.55;
  transition: background 0.16s ease, box-shadow 0.16s ease, opacity 0.16s ease;
}
.autosave.is-on .autosave__dot {
  background: currentColor;
  box-shadow: none;
  opacity: 1;
}
.viewswitch {
  position: relative;
}
.viewswitch__btn {
  width: auto;
  padding: 0 6px;
}
.viewswitch__menu {
  position: absolute;
  right: 0;
  top: calc(100% + 5px);
  z-index: 650;
  min-width: 156px;
  padding: 5px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-3);
}
.viewswitch__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--fg);
  text-align: left;
}
.viewswitch__item:hover {
  background: var(--bg-hover);
}
.viewswitch__item.is-active {
  color: var(--accent);
  font-weight: 600;
}
.viewswitch__check {
  margin-left: auto;
}
.overflow-wrap {
  position: relative;
}
.overflow-menu {
  position: absolute;
  left: 0;
  top: calc(100% + 5px);
  z-index: 650;
  min-width: 170px;
  padding: 5px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-3);
}
.overflow-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--fg);
  text-align: left;
}
.overflow-item:hover {
  background: var(--bg-hover);
  color: var(--accent);
}
</style>
