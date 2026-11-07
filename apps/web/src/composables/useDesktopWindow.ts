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

/**
 * 订阅一次窗口最大化状态，多个调用方共享同一份响应式状态。
 *
 * ## 为什么需要轮询兜底（2.1.0）
 *
 * 只有 Electron 与 Qt 的壳提供 `win.onStateChange` 主动推送。
 * WinUI3 / Tauri / Flutter 的桥里**没有**这个事件，于是：
 *   - 点「最大化」后窗口确实最大化了，
 *   - 但按钮图标仍显示「最大化」（应收敛为「还原」），
 *     用户会以为按钮没生效而反复点击。
 *
 * 桥里已有 `isMaximized()` 这个同步查询，因此这里加一条低频轮询：
 * 只在窗口尺寸变化时（resize 事件）以及每 600ms 主动校准一次。
 * 轮询成本极低（一次 JSON 往返），但彻底消除「状态不同步」的观感问题。
 */
let maximizePollTimer: ReturnType<typeof setInterval> | null = null;

function ensureMaximizeSubscription(): void {
  if (maximizeSubscribed || !isDesktopShell) return;
  const win = getWinBridge();
  if (!win) return;
  maximizeSubscribed = true;

  // 首选：壳能主动推送时直接用，零成本
  win.onStateChange?.((state) => {
    maximized.value = Boolean(state?.maximized);
  });

  // 兜底：轮询查询（没有 onStateChange 的壳靠这条保持同步）
  const sync = () => {
    const w = getWinBridge();
    if (!w?.isMaximized) return;
    void Promise.resolve(w.isMaximized())
      .then((v) => {
        if (typeof v === 'boolean') maximized.value = v;
      })
      .catch(() => undefined);
  };

  if (!win.onStateChange) {
    maximizePollTimer ??= setInterval(sync, 600);
    // 用户缩放/最大化窗口时立刻校准一次，避免等到下一个轮询周期
    globalThis.addEventListener?.('resize', sync, { passive: true });
  }
  sync();
}

/** 供测试/卸载时停止轮询，避免热更新后残留多个定时器 */
export function stopMaximizePolling(): void {
  if (maximizePollTimer) {
    clearInterval(maximizePollTimer);
    maximizePollTimer = null;
  }
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

/* ---------------- 拖拽区：非 Electron 壳的原生拖动回退 ---------------- */

/**
 * 该壳是否会自己把 `-webkit-app-region: drag` 翻译成窗口拖动。
 *
 * 只有 Electron 会。其余四个壳（Tauri/WebView2、Qt/WebEngine、
 * WinUI3/WebView2、Flutter/WebView2）用的都是普通浏览器控件，
 * 它们不认识这个 CSS 属性 —— 页面表现是「顶部能看见、能点，
 * 但按住拖不动窗口」。所以这些壳必须走 `win.startDrag()`。
 *
 * 判据用 electron 的存在性，而不是猜测壳名：Electron 一定注入
 * `window.electron` / `process.versions.electron`，其余壳不会。
 */
const usesNativeAppRegionDrag = (() => {
  if (!isDesktopShell) return false;
  const g = globalThis as unknown as {
    electron?: unknown;
    process?: { versions?: { electron?: string } };
  };
  return Boolean(g.electron || g.process?.versions?.electron);
})();

/**
 * 让标题栏拖拽区在「浏览器不认 app-region」的壳里也能拖动窗口。
 *
 * 做法：在文档捕获阶段监听 `mousedown`，如果按下的元素命中
 * `app-region: drag` 且不是交互元素，就请求原生侧发起窗口拖动。
 *
 * 用捕获阶段而不是给每个元素绑事件，是为了覆盖 TabBar 里
 * 动态生成的标签、空白填充区等所有拖拽区域，无需逐个改模板。
 * 拖动期间浏览器不会再送 mousemove 给页面（系统接管了鼠标捕获），
 * 因此只需处理 mousedown 这一次。
 */
export function installTitlebarDragFallback(): void {
  if (!isDesktopShell || usesNativeAppRegionDrag) return;
  const win = getWinBridge();
  if (!win?.startDrag) return;

  // 同一文档只装一次（HMR / 路由切换可能重复调用）
  const flag = '__neomdDragFallbackInstalled';
  const g = globalThis as unknown as Record<string, boolean>;
  if (g[flag]) return;
  g[flag] = true;

  document.addEventListener(
    'mousedown',
    (e) => {
      // 只处理鼠标左键
      if (e.button !== 0) return;
      const el = e.target as HTMLElement | null;
      if (!el) return;
      // 交互元素（按钮、标签页、输入框…）自己处理点击，不触发拖动
      if (el.closest(INTERACTIVE)) return;
      // 必须真的处在 drag 区域
      if (appRegionOf(el) !== 'drag') return;
      // 双击交给 onTitlebarDblClick 处理最大化，避免拖动与双击打架
      if (e.detail > 1) return;
      void win.startDrag?.();
    },
    true,
  );
}

/* ---------------- 自绘窗口按钮（无原生 WCO 的壳） ---------------- */

/**
 * 该壳是否自带右上角原生窗口按钮（最小化/最大化/关闭）覆盖层。
 *
 * Electron 用 `titleBarOverlay` 提供（对应 `navigator.windowControlsOverlay`）；
 * 其余四个壳是无边框窗口，系统不画按钮，必须由页面自己画。
 */
export function hasNativeWindowControls(): boolean {
  if (!isDesktopShell) return false;
  const wco = (navigator as Navigator & { windowControlsOverlay?: { visible?: boolean } })
    .windowControlsOverlay;
  return Boolean(wco?.visible);
}

/** 当前是否为「页面自绘窗口按钮」模式 */
export function needsCustomWindowControls(): boolean {
  return isDesktopShell && !hasNativeWindowControls() && Boolean(getWinBridge()?.minimize);
}

/** 窗口自绘按钮的宽度（3 个按钮 × 46px，与 Windows 原生按钮尺寸一致） */
export const CUSTOM_WCONTROLS_W = 138;

/** 自绘窗口按钮动作 */
export async function winControl(action: 'minimize' | 'maximize' | 'close'): Promise<void> {
  const win = getWinBridge();
  if (!win) return;
  if (action === 'minimize') await win.minimize?.();
  else if (action === 'maximize') await win.toggleMaximize?.();
  else await win.close?.();
}

/** 对外暴露最大化状态，供自绘按钮切换图标 */
export function useWindowMaximizedState(): Readonly<Ref<boolean>> {
  ensureMaximizeSubscription();
  return maximized;
}
