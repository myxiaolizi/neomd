<script setup lang="ts">
/**
 * 通用尺寸拖拽手柄（受控组件）。
 *
 * 两种形态：
 * - `direction="vertical"`：竖着的分隔条，用左右拖动改宽度（左右侧栏用）；
 * - `direction="horizontal"`：横着的分隔条，用上下拖动改高度（大纲区与文件列表之间用）。
 *
 * 组件本身**不负责持久化**，只把拖拽结果通过 `update` 抛给调用方；
 * 落盘由调用方决定（本项目统一走 `lib/local-layout.ts`，只存 localStorage、不进云同步）。
 *
 * 用法：
 * ```html
 * <ResizeHandle
 *   direction="vertical"
 *   :value="layout.leftWidth"
 *   :min="200"
 *   :max="600"
 *   :default-value="260"
 *   @update="(v: number) => update({ leftWidth: v })"
 * />
 * ```
 *
 * ## 单位模型（1.4.0 修「分屏拖动不跟手」）
 *
 * 默认 `unit="px"`：`value` 是像素值，鼠标位移 1px 就是 1px，直接相加（左右侧栏、
 * 右侧区块高度都用这个模型，一直是对的）。
 *
 * `unit="percent"`：调用方的 `value` 是**某个容器的百分比**（0..100）。这时
 * 鼠标位移（px）必须先除以容器在该轴上的像素尺寸，再换算成百分比增量：
 *
 * ```text
 * 比例增量(%) = 鼠标位移(px) / 容器尺寸(px) × 100
 * ```
 *
 * 改前这里**没有单位概念**：分屏把 0..100 的百分比直接传进来，1px 位移被当成 1%
 * 加进去，等于把灵敏度放大了「容器尺寸/100」倍（1300px 宽的分屏就是 13 倍）——
 * 鼠标才动 5px，比例就跳了 5%，分隔条飞出去几十像素。这是「不跟手」的第一层原因。
 */
import { computed, onBeforeUnmount, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    /** vertical：改宽度（左右拖动）；horizontal：改高度（上下拖动） */
    direction?: 'vertical' | 'horizontal';
    /** 当前值（受控） */
    value: number;
    /** 最小值 */
    min: number;
    /** 最大值 */
    max: number;
    /** 双击 / Enter 恢复的默认值，缺省取区间中点 */
    defaultValue?: number;
    /** 反向：向右（或向下）拖动时「减小」而不是「增大」。
     *  右侧栏的分隔条在栏的左侧，需要反向往外拖才变宽，所以传 true。 */
    invert?: boolean;
    /**
     * 值的单位（1.4.0）：
     * - `px`（默认）：value 就是像素，鼠标位移直接相加；
     * - `percent`：value 是宿主容器的百分比（0..100），鼠标位移需按容器尺寸换算。
     */
    unit?: 'px' | 'percent';
    /**
     * 保留的小数位数（默认 0 = 取整）。
     *
     * 百分比模式下**必须放开精度**：0..100 的整数只有 100 档，1300px 的分屏上
     * 1% = 13px，取整会让分隔条只能落在 13px 的格子上，拖动看起来一格一格地跳。
     */
    precision?: number;
    /** 无障碍名称 */
    label?: string;
    /** 禁用拖拽 */
    disabled?: boolean;
  }>(),
  {
    direction: 'vertical',
    defaultValue: undefined,
    invert: false,
    unit: 'px',
    precision: 0,
    label: '调整大小',
    disabled: false,
  },
);

const emit = defineEmits<{
  /** 拖动过程中持续抛出新值 */
  update: [value: number];
  /** 双击 / Enter 触发的复位（先发此事件，再发同值的 update） */
  reset: [value: number];
  /** 开始拖拽（调用方可借此加遮罩 / 暂停动画） */
  'drag-start': [];
  /** 结束拖拽 */
  'drag-end': [];
}>();

const isVertical = computed(() => props.direction === 'vertical');
const resetValue = computed(() =>
  props.defaultValue ?? Math.round((props.min + props.max) / 2),
);

/** 按 `precision` 取整（默认 0 = 整数，与原行为一致） */
function roundValue(raw: number): number {
  const p = Math.max(0, Math.min(4, Math.trunc(props.precision || 0)));
  if (p === 0) return Math.round(raw);
  const factor = 10 ** p;
  return Math.round(raw * factor) / factor;
}

function clampValue(raw: number): number {
  return roundValue(Math.min(props.max, Math.max(props.min, raw)));
}

/* ---------------- 百分比模式的容器尺寸 ---------------- */

/** 手柄自身的根元素，用来向上找宿主容器 */
const rootEl = ref<HTMLElement | null>(null);

/**
 * 读取宿主容器在拖拽轴上的像素尺寸。
 *
 * 为什么要向上找 `parentElement` 而不是让调用方传尺寸：
 * 手柄用负边距「骑」在两侧容器的交界线上（`width: 6px; margin: 0 -3px`），
 * 净占位是 0，所以它的父元素就是**真正被分割的那个容器**，它的
 * `clientWidth/clientHeight` 正好等于两侧 pane 之和 —— 不需要调用方维护一份
 * 容易过期的尺寸状态，窗口缩放 / 右侧栏开合后也自动是最新值。
 *
 * 读不到（未挂载、display:none、父元素为 null）时返回 0，调用方据此**放弃本次位移**
 * 而不是退回「1px 当 1%」的旧行为 —— 宁可这一帧拖不动，也不能让分隔条反向飞出去。
 */
function measureTrackSize(): number {
  const parent = rootEl.value?.parentElement;
  if (!parent) return 0;
  return isVertical.value ? parent.clientWidth : parent.clientHeight;
}

/* ---------------- 鼠标拖拽 ---------------- */

/** 是否正在拖拽（ref 以便模板切换样式类） */
const dragging = ref(false);
/** 按下时指针位置（垂直取 clientX，水平取 clientY） */
let startPos = 0;
/** 按下时的值，避免用历史中间值累积误差 */
let startValue = 0;
/**
 * 按下瞬间的容器像素尺寸（仅百分比模式使用）。
 *
 * 在 mousedown 时量一次、整段拖拽复用：mousemove 里每次读 `clientWidth` 都会强制
 * 同步 layout（一次拖拽上百个事件 → 上百次 reflow），手感会变滞。
 */
let startTrackSize = 0;

function onMouseDown(e: MouseEvent): void {
  if (props.disabled || e.button !== 0) return;
  // 阻止默认行为：不然拖动过程会选中文字、或触发宿主元素的拖拽
  e.preventDefault();
  e.stopPropagation();
  dragging.value = true;
  startPos = isVertical.value ? e.clientX : e.clientY;
  startValue = props.value;
  startTrackSize = props.unit === 'percent' ? measureTrackSize() : 0;
  document.body.classList.add('nm-resizing');
  document.body.classList.add(isVertical.value ? 'nm-resizing--v' : 'nm-resizing--h');
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  emit('drag-start');
}

function onMouseMove(e: MouseEvent): void {
  if (!dragging.value) return;
  const current = isVertical.value ? e.clientX : e.clientY;
  let delta = current - startPos;
  if (props.invert) delta = -delta;
  /*
   * 百分比模式：px → % 的换算就在这里。
   *
   * 量不到容器尺寸时直接返回（本帧不更新），绝不退化成「1px = 1%」——
   * 那正是 1.4.0 之前「拖动不跟手、甚至反向飞出去」的根因。
   */
  if (props.unit === 'percent') {
    if (!(startTrackSize > 0)) return;
    delta = (delta / startTrackSize) * 100;
  }
  const next = clampValue(startValue + delta);
  if (next !== props.value) emit('update', next);
}

function onMouseUp(): void {
  if (!dragging.value) return;
  dragging.value = false;
  stopTracking();
  emit('drag-end');
}

/** 移除全局监听与拖拽态样式 */
function stopTracking(): void {
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mouseup', onMouseUp);
  document.body.classList.remove('nm-resizing');
  document.body.classList.remove('nm-resizing--v');
  document.body.classList.remove('nm-resizing--h');
}

/* ---------------- 双击 / 键盘复位 ---------------- */

function onDoubleClick(e: MouseEvent): void {
  if (props.disabled) return;
  e.preventDefault();
  e.stopPropagation();
  const fallback = clampValue(resetValue.value);
  emit('reset', fallback);
  emit('update', fallback);
}

function onKeyDown(e: KeyboardEvent): void {
  if (props.disabled) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    const fallback = clampValue(resetValue.value);
    emit('reset', fallback);
    emit('update', fallback);
    return;
  }
  const step = e.shiftKey ? 40 : 10;
  /*
   * 百分比模式的键盘步长必须换成「比例档位」，不能沿用像素步长：
   * 40px / 10px 当成 40% / 10% 会一按就到底或直接越过 clamp 边界。
   */
  const stepPercent = e.shiftKey ? 5 : 1;
  let delta = 0;
  if (isVertical.value) {
    if (e.key === 'ArrowLeft') delta = -step;
    else if (e.key === 'ArrowRight') delta = step;
  } else {
    if (e.key === 'ArrowUp') delta = -step;
    else if (e.key === 'ArrowDown') delta = step;
  }
  if (!delta) return;
  e.preventDefault();
  if (props.invert) delta = -delta;
  if (props.unit === 'percent') delta = Math.sign(delta) * stepPercent;
  emit('update', clampValue(props.value + delta));
}

onBeforeUnmount(stopTracking);
</script>

<template>
  <div
    ref="rootEl"
    class="resizer"
    :class="[
      isVertical ? 'resizer--vertical' : 'resizer--horizontal',
      { 'is-disabled': disabled, 'is-dragging': dragging },
    ]"
    role="separator"
    tabindex="0"
    :aria-orientation="isVertical ? 'vertical' : 'horizontal'"
    :aria-label="label"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-valuenow="roundValue(value)"
    :title="`${label}（拖动调整，双击恢复默认）`"
    @mousedown="onMouseDown"
    @dblclick="onDoubleClick"
    @keydown="onKeyDown"
  >
    <span class="resizer__grip" aria-hidden="true" />
  </div>
</template>

<style scoped>
.resizer {
  position: relative;
  flex: 0 0 auto;
  z-index: 30;
  background: transparent;
  touch-action: none;
  outline: none;
}
.resizer:focus-visible .resizer__grip {
  background: var(--accent);
  opacity: 1;
}
.resizer.is-disabled {
  pointer-events: none;
  opacity: 0.4;
}
/* 竖向手柄：6px 命中区，用负边距「骑」在两侧容器的交界线上，不改变原有布局尺寸 */
.resizer--vertical {
  width: 6px;
  margin: 0 -3px;
  cursor: col-resize;
}
/* 横向手柄：同理骑在上下交界线上 */
.resizer--horizontal {
  height: 6px;
  margin: -3px 0;
  cursor: row-resize;
}
.resizer__grip {
  position: absolute;
  background: transparent;
  border-radius: 999px;
  opacity: 0;
  transition: background 0.14s ease, opacity 0.14s ease;
}
.resizer--vertical .resizer__grip {
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  transform: translateX(-50%);
}
.resizer--horizontal .resizer__grip {
  left: 0;
  right: 0;
  top: 50%;
  height: 1px;
  transform: translateY(-50%);
}
.resizer:hover .resizer__grip,
.resizer.is-dragging .resizer__grip {
  background: var(--accent);
  opacity: 0.85;
}
.resizer--vertical.is-dragging .resizer__grip {
  width: 2px;
}
.resizer--horizontal.is-dragging .resizer__grip {
  height: 2px;
}
</style>

<style>
/* 拖拽期间的全局约束：禁止选中文本，光标在整窗保持一致（否则移出手柄就变回箭头） */
body.nm-resizing {
  user-select: none;
  -webkit-user-select: none;
}
body.nm-resizing--v,
body.nm-resizing--v * {
  cursor: col-resize !important;
}
body.nm-resizing--h,
body.nm-resizing--h * {
  cursor: row-resize !important;
}
</style>
