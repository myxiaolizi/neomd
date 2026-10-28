import { ref, type Ref } from 'vue';
import { detectRuntime, getBridge, type NativeBridge } from '@neomd/core';

/**
 * 桌面端自定义标题栏的窗口交互。
 *
 * 窗口拖动本身由 CSS 的 `-webkit-app-region: drag`（样式表里的 `.nm-drag`）交给系统处理，
 * 这里只补网页层需要的事：
 * 1. 双击标题栏空白处最大化 / 还原（与系统的 drag 区域双击互斥，避免双触发）；
 * 2. 订阅最大化状态，供标题栏 UI 响应式使用；
 * 3. 读出右上角原生窗口按钮的宽度，避免标签把按钮压住。
 */
export const isDesktopShell = detectRuntime().platform === 'desktop';

/** 这些元素不参与窗口拖动与双击，否则按钮点击会被吞掉 */
const INTERACTIVE = 'button, a, input, textarea, select, [role="button"], [contenteditable="true"]';

/**
 * 标题栏高度带的上限（px）。
 * 与 --titlebar-h（40px）留出余量：标签栏实际高度约 50px，
 * 命中元素 top 超过该值即视为正文，不再触发窗口最大化。
 */
const TITLEBAR_HIT_MAX_TOP = 64;

/** preload 暴露的窗口桥（`offStateChange` 为后加的取消订阅方法） */
type WinBridge = NonNullable<NativeBridge['win']> & {
  offStateChange?: (cb: (state: { maximized: boolean }) => void) => void;
};

function getWinBridge(): WinBridge | undefined {
  return getBridge()?.win as WinBridge | undefined;
}

/**
 * 读取元素实际生效的窗口拖拽行为。
 *
 * 注意：`-webkit-app-region` 在 Chromium 里是**可继承**的（子元素未显式声明时取祖先值），
 * 因此直接读计算样式即可判断该点是否属于系统拖拽区，无需逐级向上回溯。
 */
function appRegionOf(el: Element): string {
  try {
    return globalThis.getComputedStyle(el).getPropertyValue('-webkit-app-region').trim();
  } catch {
    return '';
  }
}

/* ---------------- 最大化状态（模块级单例） ---------------- */

const maximized = ref(false);
let maximizeSubscribed = false;

/** 订阅一次窗口最大化状态，多个调用方共享同一份响应式状态 */
function ensureMaximizeSubscription(): void {
  if (maximizeSubscribed || !isDesktopShell) return;
  const win = getWinBridge();
  if (!win) return;
  maximizeSubscribed = true;
  win.onStateChange?.((state) => {
    maximized.value = Boolean(state?.maximized);
  });
}

/**
 * 窗口是否处于最大化状态（只读响应式）。
 * 桌面端首次调用时订阅主进程推送的 `app:window-state`；网页端恒为 false。
 */
export function useWindowMaximized(): Readonly<Ref<boolean>> {
  ensureMaximizeSubscription();
  return maximized;
}

/* ---------------- 双击最大化 / 还原 ---------------- */

/**
 * 双击标题栏切换最大化 / 还原（确定性实现）。
 *
 * 与旧实现的区别：不再「先记状态、延迟 220ms 再比对」，而是按区域分流，两条路径互斥：
 * - 命中 `app-region: drag` 的空白区：双击由**系统**原生处理（Windows 的标题栏双击），
 *   这里直接返回，绝不重复调用 toggleMaximize，避免「系统已最大化 + 我们再还原」的闪烁；
 * - 命中 `no-drag` 区域（例如标题栏里没有交互元素的空白）：系统不会响应，
 *   此时主动调用一次 `toggleMaximize()`，状态由 `app:window-state` 事件回传。
 *
 * @param e 双击事件
 * @param extraIgnore 额外需要忽略的选择器（例如标签本身的双击要关闭标签）
 */
export function onTitlebarDblClick(e: MouseEvent, extraIgnore = ''): void {
  if (!isDesktopShell) return;
  const el = e.target as HTMLElement | null;
  if (!el) return;
  // 交互元素（以及调用方指定的例外区）自行处理双击，不能触发窗口最大化
  if (el.closest(extraIgnore ? `${INTERACTIVE}, ${extraIgnore}` : INTERACTIVE)) return;

  // drag 区域：交给系统原生双击处理，避免与系统行为叠加
  if (appRegionOf(el) === 'drag') return;

  // 只处理窗口顶部标题栏高度带内的 no-drag 空白，避免正文区域的双击被误当成标题栏双击
  const rect = el.getBoundingClientRect();
  if (rect.top > TITLEBAR_HIT_MAX_TOP) return;

  // no-drag 的标题栏空白区：系统不会响应，由这里主动切换
  void getWinBridge()?.toggleMaximize?.();
}

type WcoLike = { visible?: boolean; getTitlebarAreaRect?: () => { x: number; width: number } };

/**
 * 右上角原生窗口按钮（最小化 / 最大化 / 关闭）占用的像素宽度。
 * 仅在桌面端且窗口按钮覆盖层可见时返回非 0，供标题栏右侧留白使用。
 */
export function measureControlsInset(): number {
  if (!isDesktopShell) return 0;
  const wco = (navigator as Navigator & { windowControlsOverlay?: WcoLike }).windowControlsOverlay;
  if (!wco?.visible || typeof wco.getTitlebarAreaRect !== 'function') return 0;
  const rect = wco.getTitlebarAreaRect();
  const viewport = globalThis.innerWidth || 0;
  return Math.max(0, Math.round(viewport - rect.x - rect.width));
}
