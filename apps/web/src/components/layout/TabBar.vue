<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NmIcon } from '@neomd/ui';
import { measureControlsInset, onTitlebarDblClick } from '@/composables/useDesktopWindow';

export interface TabView {
  id: string;
  title: string;
  dirty: boolean;
  locked?: boolean;
}

const props = defineProps<{
  tabs: TabView[];
  activeId: string;
  leftPanelOpen: boolean;
  /** 当前分屏方向（1.1.7） */
  splitDirection?: 'none' | 'v' | 'h';
}>();

const emit = defineEmits<{
  select: [string];
  close: [string];
  /** 新建/打开（1.1.7）：点击 + 号即「同时打开两篇」语义 */
  newTab: [];
  toggleLeft: [];
  context: [{ id: string; x: number; y: number }];
  /** 标签右键菜单选中的动作（close / close-others / close-right / lock / source / split / find / replace / rename / copy-path / window） */
  'tab-action': [{ id: string; action: string }];
  /** 切换分屏方向（1.1.7）：'none' | 'v' | 'h' */
  'set-split': ['none' | 'v' | 'h'];
}>();

const menu = ref<{ id: string; x: number; y: number } | null>(null);

/* ---------------- 桌面端标题栏：拖动 + 双击最大化 / 还原 ---------------- */

/** 右上角原生窗口按钮（最小化 / 最大化 / 关闭）占用的宽度，避免标签被压住 */
const wcoInset = ref(measureControlsInset());

function measureWcoInset(): void {
  wcoInset.value = measureControlsInset();
}

/** 标签是可点区域，双击标签本身应关闭标签，而不是最大化窗口 */
function onTitlebarDoubleClick(e: MouseEvent): void {
  onTitlebarDblClick(e, '.tab, .tabbar__add');
}

const MENU_ITEMS = computed(() => {
  const id = menu.value?.id;
  const tab = props.tabs.find((t) => t.id === id);
  return [
    { key: 'close', label: '关闭', icon: 'close' },
    { key: 'lock', label: tab?.locked ? '取消锁定阅读视图' : '锁定阅读视图', icon: 'lock' },
    { key: 'source', label: '源码模式', icon: 'code' },
    { sep: true },
    { key: 'window', label: '移动至新窗口', icon: 'external' },
    { key: 'split-v', label: '左右分屏', icon: 'columns' },
    { key: 'split-h', label: '上下分屏', icon: 'layout' },
    { sep: true },
    { key: 'find', label: '查找', icon: 'search' },
    { key: 'replace', label: '替换', icon: 'edit' },
    { key: 'rename', label: '重命名', icon: 'edit' },
    { key: 'copy-path', label: '复制路径', icon: 'copy' },
    { sep: true },
    { key: 'close-all', label: '关闭全部', icon: 'minus' },
    { key: 'close-others', label: '关闭其他', icon: 'minus' },
    { key: 'close-right', label: '关闭右侧', icon: 'chevronRight' },
  ] as Array<{ key?: string; label?: string; icon?: string; sep?: boolean }>;
});

function openMenu(e: MouseEvent, id: string): void {
  e.preventDefault();
  e.stopPropagation();
  // 延迟挂载，避免同一次事件冒泡到 window 上立即关闭菜单
  const x = e.clientX;
  const y = e.clientY;
  setTimeout(() => {
    menu.value = { id, x, y };
    emit('context', { id, x, y });
  }, 0);
}

function menuPos(m: { x: number; y: number }): { left: string; top: string } {
  const vw = typeof globalThis.innerWidth === 'number' ? globalThis.innerWidth : 1200;
  const vh = typeof globalThis.innerHeight === 'number' ? globalThis.innerHeight : 800;
  return {
    left: `${Math.min(m.x, Math.max(8, vw - 220))}px`,
    top: `${Math.min(m.y, Math.max(8, vh - 420))}px`,
  };
}

function choose(key: string): void {
  const id = menu.value?.id;
  menu.value = null;
  if (!id) return;
  emit('tab-action', { id, action: key });
}

function closeMenu(): void {
  menu.value = null;
}

/* ---------------- 标签栏横向滚动：自动把活动标签滚进可视区 ---------------- */

/** 标签横向滚动容器 */
const scrollEl = ref<HTMLElement | null>(null);

/** 用户手动滚动的抑制截止时间戳（毫秒）。在此之前不做自动滚动，避免打断用户浏览 */
let suppressUntil = 0;
/** 正在进行的自动滚动动画句柄，新的滚动要打断上一次 */
let scrollRaf = 0;

/** 用户手动滚动后，自动滚动被抑制的时长 */
const SUPPRESS_MS = 1500;
/** 自动滚动动画时长 */
const SCROLL_MS = 180;
/** 标签与容器左右边缘保留的呼吸空间，避免活动标签紧贴边框 */
const REVEAL_PAD = 8;

/** 记录一次用户手动滚动，开启抑制窗口 */
function markUserScroll(): void {
  suppressUntil = Date.now() + SUPPRESS_MS;
}

/** 打断进行中的自动滚动动画 */
function cancelAutoScroll(): void {
  if (scrollRaf) {
    cancelAnimationFrame(scrollRaf);
    scrollRaf = 0;
  }
}

/** easeOutCubic：先快后慢，接近系统惯性滚动的手感 */
function easeOutCubic(t: number): number {
  const p = 1 - t;
  return 1 - p * p * p;
}

/**
 * 横向平滑滚动到目标位置。
 *
 * 用 rAF 自己实现而不是 CSS `scroll-behavior: smooth`：
 * 后者会让用户用滚轮滚动时也带上缓动，手感发飘。
 */
function animateScrollTo(el: HTMLElement, target: number): void {
  cancelAutoScroll();
  const start = el.scrollLeft;
  const distance = target - start;
  if (Math.abs(distance) < 1) return;
  const startedAt = performance.now();
  const step = (now: number): void => {
    const progress = Math.min(1, (now - startedAt) / SCROLL_MS);
    el.scrollLeft = start + distance * easeOutCubic(progress);
    if (progress < 1) scrollRaf = requestAnimationFrame(step);
    else scrollRaf = 0;
  };
  scrollRaf = requestAnimationFrame(step);
}

/**
 * 确保活动标签落在可视区内 —— 只动本容器的 scrollLeft，绝不滚动页面。
 *
 * 刻意不用 `scrollIntoView`：它会连带滚动所有可滚动祖先（包括整个页面），
 * 在桌面端自定义标题栏里会把整页顶偏一截，副作用很明显。
 *
 * 实现用**屏幕坐标增量法**：直接比较标签与容器内边距之间的屏幕距离，
 * 得到需要滚动的像素增量再加到 scrollLeft 上。相比「把 rect 换算到内容坐标系
 * 再反算 scrollLeft」，这种做法不会在 padding-left / padding-right 上出错
 * （踩过：用内容坐标算时，末尾标签会顶进 padding-right 区域而显示不全），
 * 且浏览器会自己 clamp scrollLeft，不会滚出边界。
 *
 * @param smooth 是否平滑滚动；首帧 / 容器尺寸变化时用瞬时滚动，避免页面一进来就"滑一下"
 */
function revealActiveTab(smooth = true): void {
  const el = scrollEl.value;
  if (!el) return;
  const active = el.querySelector<HTMLElement>('.tab.is-active');
  if (!active) return;
  // 用户刚手动滚过、正在浏览别的标签：这一轮不抢
  if (Date.now() < suppressUntil) return;

  const style = getComputedStyle(el);
  const padLeft = Number.parseFloat(style.paddingLeft) || 0;
  const padRight = Number.parseFloat(style.paddingRight) || 0;
  const containerRect = el.getBoundingClientRect();
  const activeRect = active.getBoundingClientRect();

  // 容器真正的可见内容区（扣掉左右内边距）
  const visibleLeft = containerRect.left + padLeft;
  const visibleRight = containerRect.right - padRight;

  let delta = 0;
  if (activeRect.left < visibleLeft + REVEAL_PAD) {
    // 标签左边被遮住（或贴得太紧）：向左滚，让它右边留出呼吸空间
    delta = activeRect.left - (visibleLeft + REVEAL_PAD);
  } else if (activeRect.right > visibleRight - REVEAL_PAD) {
    // 标签右边被遮住：向右滚
    delta = activeRect.right - (visibleRight - REVEAL_PAD);
  }
  if (Math.abs(delta) < 1) return;

  const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
  const target = Math.max(0, Math.min(el.scrollLeft + delta, maxScroll));

  if (smooth) animateScrollTo(el, target);
  else el.scrollLeft = target;
}

/**
 * 鼠标滚轮转横向滚动。
 *
 * 只在容器确实溢出时接管 —— 标签不多时把滚轮事件原样放行，不白吞事件；
 * `Ctrl + 滚轮` 留给页面/画布缩放，也不拦。
 */
function onTabbarWheel(e: WheelEvent): void {
  const el = scrollEl.value;
  if (!el || e.ctrlKey) return;
  if (el.scrollWidth <= el.clientWidth + 1) return;
  // 触摸板横向滑动已经直接产生 deltaX，优先用它
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (!delta) return;
  e.preventDefault();
  // 用户开始操作：立刻停掉进行中的自动滚动动画，否则动画会持续覆盖手动滚动
  cancelAutoScroll();
  el.scrollLeft += delta;
  markUserScroll();
}

/** 触摸板横向滑动也要计入「用户正在浏览」 */
function onTabbarTouchStart(): void {
  markUserScroll();
}

/* ---------------- 右侧：标签跳转下拉 + 分屏按钮（1.1.7） ---------------- */

/** 标签跳转下拉是否展开 */
const switcherOpen = ref(false);
/** 分屏菜单是否展开 */
const splitMenuOpen = ref(false);

/** 当前分屏状态，缺省视为不分屏 */
const currentSplit = computed<'none' | 'v' | 'h'>(() => props.splitDirection ?? 'none');

/**
 * 打开标签跳转下拉。
 *
 * 用户原话：「在这个按钮的前方设置一个下拉箭头，点击下拉可以快速跳转到当前打开的所有标签页」。
 * 这个箭头放在分屏按钮**前方**（左侧），点开列出所有打开的标签，点选即切换。
 */
function toggleSwitcher(): void {
  switcherOpen.value = !switcherOpen.value;
  if (switcherOpen.value) splitMenuOpen.value = false;
}

/** 从下拉里选中一个标签并关闭下拉 */
function chooseFromSwitcher(id: string): void {
  switcherOpen.value = false;
  onTabClick(id);
}

/** 切换分屏菜单 */
function toggleSplitMenu(): void {
  splitMenuOpen.value = !splitMenuOpen.value;
  if (splitMenuOpen.value) switcherOpen.value = false;
}

/**
 * 设置分屏方向。
 *
 * 点同一个方向按钮两次 = 关闭分屏（与右键菜单里的「左右分屏 / 上下分屏」行为一致），
 * 这样单个按钮就能完成「开 / 关」两种操作，不用额外再找一个关闭入口。
 */
function chooseSplit(dir: 'v' | 'h'): void {
  splitMenuOpen.value = false;
  emit('set-split', currentSplit.value === dir ? 'none' : dir);
}

/** 点击外部关闭两个下拉 */
function onDocMouseDown(e: MouseEvent): void {
  const target = e.target as HTMLElement | null;
  if (!target?.closest('.tabbar__switcher')) switcherOpen.value = false;
  if (!target?.closest('.tabbar__split')) splitMenuOpen.value = false;
  closeMenu();
}

/** 分屏按钮的提示文案 */
const splitTitle = computed(() => {
  if (currentSplit.value === 'v') return '当前为左右分屏（点击切换/关闭）';
  if (currentSplit.value === 'h') return '当前为上下分屏（点击切换/关闭）';
  return '分屏：同时查看两篇文章';
});

/** 容器尺寸变化（侧栏收放、窗口缩放）后重新对齐活动标签 */
let tabResizeObserver: ResizeObserver | null = null;

/**
 * 点击标签：选中并把该标签滚进视野。
 *
 * 为什么要处理点击：如果这个标签**已经是活动标签**，`activeId` 不变、
 * `watch` 不会触发，而它可能因为用户此前手动横向滚动而落在视野外 ——
 * 此时用户点它，理应把它拉回来。点击是明确的意图，因此这里直接抢滚动，
 * 不受「用户正在浏览」的抑制窗口限制。
 */
function onTabClick(id: string): void {
  emit('select', id);
  // 用户点了就在看它：清掉抑制窗口，允许立即对齐
  suppressUntil = 0;
  scheduleReveal(true);
}

/** 等 DOM 更新与布局稳定后，再把活动标签滚进视野 */
function scheduleReveal(smooth = true): void {
  void nextTick(() => {
    // 双 rAF：第一帧让 v-for 新增的标签完成布局，第二帧测量才准
    requestAnimationFrame(() => requestAnimationFrame(() => revealActiveTab(smooth)));
  });
}

// 切换标签（含新建标签后自动激活、关闭标签后切到相邻标签）都要保证可见
watch(
  () => props.activeId,
  () => scheduleReveal(true),
);

// 标签数量变化：即使 activeId 没变，标签宽度重排也可能让活动标签贴边
watch(
  () => props.tabs.length,
  () => scheduleReveal(true),
);

onMounted(() => {
  // 用 mousedown 关闭：右键不会触发，左键才关闭（同时关掉右侧两个下拉）
  window.addEventListener('mousedown', onDocMouseDown);
  measureWcoInset();
  window.addEventListener('resize', measureWcoInset);
  const wco = (navigator as Navigator & { windowControlsOverlay?: EventTarget }).windowControlsOverlay;
  wco?.addEventListener?.('geometrychange', measureWcoInset);

  // 标签横向滚动相关监听：滚轮转横向、触摸标记、尺寸变化后重新对齐
  const el = scrollEl.value;
  if (el) {
    el.addEventListener('wheel', onTabbarWheel, { passive: false });
    el.addEventListener('touchstart', onTabbarTouchStart, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      tabResizeObserver = new ResizeObserver(() => revealActiveTab(false));
      tabResizeObserver.observe(el);
    }
  }
  // 首帧对齐：恢复大量标签时，活动标签可能落在视野外
  scheduleReveal(false);
});

onBeforeUnmount(() => {
  window.removeEventListener('mousedown', onDocMouseDown);
  window.removeEventListener('resize', measureWcoInset);
  const wco = (navigator as Navigator & { windowControlsOverlay?: EventTarget }).windowControlsOverlay;
  wco?.removeEventListener?.('geometrychange', measureWcoInset);

  cancelAutoScroll();
  const el = scrollEl.value;
  if (el) {
    el.removeEventListener('wheel', onTabbarWheel);
    el.removeEventListener('touchstart', onTabbarTouchStart);
  }
  tabResizeObserver?.disconnect();
  tabResizeObserver = null;
});
</script>

<template>
  <!--
    标题栏总高 40px = 顶部 3px 空隙 + 标签栏 37px。
    3px 空隙露出标题栏底色，让标签卡不贴着窗口上沿（1.1.1 用户要求）。
    标签栏底部不再有分隔线 / 阴影，视觉上与下方内容区连成一片（参考 Obsidian）。
  -->
  <div
    class="titlebar nm-drag"
    :style="wcoInset ? { paddingRight: `${wcoInset}px` } : undefined"
    @dblclick="onTitlebarDoubleClick"
  >
    <div class="tabbar">
      <button
        class="tabbar__toggle"
        :title="leftPanelOpen ? '收起侧边栏' : '展开侧边栏'"
        @click="emit('toggleLeft')"
      >
        <NmIcon name="sidebar" :size="16" />
      </button>

      <div ref="scrollEl" class="tabbar__scroll">
        <div
          v-for="tab in tabs"
          :key="tab.id"
          class="tab"
          :class="{ 'is-active': tab.id === activeId }"
          role="tab"
          :aria-selected="tab.id === activeId"
          @click="onTabClick(tab.id)"
          @dblclick="emit('close', tab.id)"
          @auxclick="(e: MouseEvent) => e.button === 1 && emit('close', tab.id)"
          @contextmenu="openMenu($event, tab.id)"
        >
          <span v-if="tab.dirty" class="tab__dot" title="未保存" />
          <NmIcon v-else :name="tab.locked ? 'lock' : 'file'" :size="13" />
          <span class="tab__title">{{ tab.title }}</span>
          <button class="tab__close" title="关闭 Ctrl+W" @click.stop="emit('close', tab.id)">
            <NmIcon name="close" :size="12" />
          </button>
        </div>
        <button class="tabbar__add" title="新建标签页（同时打开另一篇）Ctrl+N" @click="emit('newTab')">
          <NmIcon name="plus" :size="15" />
        </button>
      </div>

      <!--
        1.1.7 右侧控制区（从右往左）：分屏按钮 → 分屏下拉箭头（在按钮前方）。
        用户原话：「在最小化按钮的前方设置一个窗口切分按钮 … 在这个按钮的前方设置一个下拉箭头，
        点击下拉可以快速跳转到当前打开的所有标签页」。
        这里的两个按钮都紧贴原生窗口按钮（最小化/最大化/关闭）左侧，
        因为原生按钮由 titleBarOverlay 绘制在右上角，`.titlebar` 已用 paddingRight 让出位置。
      -->
      <div class="tabbar__actions">
        <!-- ① 标签跳转下拉：列出所有打开的标签，点选即跳转 -->
        <div class="tabbar__switcher">
          <button
            class="tabbar__act"
            :class="{ 'is-on': switcherOpen }"
            :title="`快速跳转标签页（${tabs.length} 个）`"
            aria-haspopup="menu"
            :aria-expanded="switcherOpen"
            aria-label="快速跳转标签页"
            @click="toggleSwitcher"
          >
            <NmIcon name="chevronDown" :size="14" />
          </button>
          <div v-if="switcherOpen" class="switchmenu" role="menu" @mousedown.stop>
            <div class="switchmenu__title">已打开的标签</div>
            <button
              v-for="tab in tabs"
              :key="`sw-${tab.id}`"
              class="switchmenu__item"
              :class="{ 'is-active': tab.id === activeId }"
              role="menuitemradio"
              :aria-checked="tab.id === activeId"
              @click="chooseFromSwitcher(tab.id)"
            >
              <NmIcon :name="tab.locked ? 'lock' : 'file'" :size="13" />
              <span class="switchmenu__text">{{ tab.title }}</span>
              <span v-if="tab.dirty" class="switchmenu__dot" title="未保存" />
              <NmIcon v-if="tab.id === activeId" name="check" :size="12" />
            </button>
            <p v-if="!tabs.length" class="switchmenu__empty">还没有打开任何标签</p>
          </div>
        </div>

        <!-- ② 窗口切分按钮：点开选左右 / 上下分屏；已分屏时再点同方向即关闭 -->
        <div class="tabbar__split">
          <button
            class="tabbar__act"
            :class="{ 'is-on': splitMenuOpen || currentSplit !== 'none' }"
            :title="splitTitle"
            aria-haspopup="menu"
            :aria-expanded="splitMenuOpen"
            aria-label="窗口分屏"
            @click="toggleSplitMenu"
          >
            <NmIcon :name="currentSplit === 'h' ? 'layout' : 'columns'" :size="15" />
          </button>
          <div v-if="splitMenuOpen" class="splitmenu" role="menu" @mousedown.stop>
            <div class="splitmenu__title">窗口分屏</div>
            <button
              class="splitmenu__item"
              :class="{ 'is-active': currentSplit === 'v' }"
              role="menuitemradio"
              :aria-checked="currentSplit === 'v'"
              @click="chooseSplit('v')"
            >
              <NmIcon name="columns" :size="14" />
              <span class="splitmenu__text">左右分屏</span>
              <NmIcon v-if="currentSplit === 'v'" name="check" :size="12" />
            </button>
            <button
              class="splitmenu__item"
              :class="{ 'is-active': currentSplit === 'h' }"
              role="menuitemradio"
              :aria-checked="currentSplit === 'h'"
              @click="chooseSplit('h')"
            >
              <NmIcon name="layout" :size="14" />
              <span class="splitmenu__text">上下分屏</span>
              <NmIcon v-if="currentSplit === 'h'" name="check" :size="12" />
            </button>
            <div class="splitmenu__sep" />
            <button
              class="splitmenu__item"
              :class="{ 'is-disabled': currentSplit === 'none' }"
              :disabled="currentSplit === 'none'"
              @click="splitMenuOpen = false; emit('set-split', 'none')"
            >
              <NmIcon name="close" :size="14" />
              <span class="splitmenu__text">取消分屏</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="menu"
        class="tabmenu"
        :style="menuPos(menu)"
        @mousedown.stop
        @click.stop
      >
        <template v-for="(item, i) in MENU_ITEMS" :key="i">
          <div v-if="item.sep" class="tabmenu__sep" />
          <button v-else class="tabmenu__item" @click="choose(item.key!)">
            <NmIcon :name="item.icon ?? 'more'" :size="13" />
            <span>{{ item.label }}</span>
          </button>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/*
 * 标题栏：总高 40px。
 * 用 padding-top: 3px 让标签卡与窗口上沿之间留出可见空隙，
 * 标签栏内容区因此只有 37px（3 + 37 = 40），总高不变，
 * 桌面端窗口对齐与 --titlebar-h 都不受影响。
 * 这 3px 露的是标题栏底色（--bg-sidebar），不是标签色。
 *
 * 注意：这里写死 40px 而不是 var(--titlebar-h)。全局样式在 ≤820px 时把
 * --titlebar-h 覆盖成 0px（那是给移动端隐藏标题栏用的），若绑变量会让
 * 窄屏标签栏塌成 3px、标签完全不可见。标签栏在窄屏同样需要 40px。
 */
.titlebar {
  display: flex;
  align-items: stretch;
  height: 40px;
  min-height: 40px;
  padding-top: 3px;
  padding-left: 4px;
  background: var(--bg-sidebar);
  flex: 0 0 auto;
  min-width: 0;
}
/*
 * 标签栏：高 37px（--tabbar-h）。
 * 刻意不设 border-bottom / box-shadow —— 标签底边直接融入正文，不留任何分隔线。
 */
.tabbar {
  display: flex;
  align-items: center;
  /* 高度与 index.css 的 --tabbar-h（37px）保持一致；两处必须同步修改 */
  height: var(--tabbar-h, 37px);
  min-height: var(--tabbar-h, 37px);
  flex: 1 1 auto;
  min-width: 0;
  background: transparent;
}
.tabbar__toggle {
  width: 34px;
  height: 30px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
  flex: 0 0 auto;
  margin-right: 2px;
}
.tabbar__toggle:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.tabbar__scroll {
  display: flex;
  align-items: center;
  gap: 3px;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0 6px;
  flex: 1;
  min-width: 0;
  height: 100%;
  scrollbar-width: none;
}
.tabbar__scroll::-webkit-scrollbar {
  display: none;
}
/*
 * 单个标签：撑满标签栏高度，只保留上方圆角、底部直角，
 * 激活时与正文同色并彻底去掉边框与阴影，形成「标签底边融进正文」的效果。
 *
 * 1.1.7「标签过多时缩窄」：
 * 原来是 `flex: 0 0 auto; min-width: 110px` —— 宽度固定、不会收缩，
 * 标签一多就直接溢出到滚动区外面。改成可收缩的弹性尺寸：
 *   - `flex: 0 1 auto`：内容短就窄（不强行撑到 110px），需要时可以让出空间；
 *   - `min-width: 72px`：收缩下限，保证「关闭按钮 + 一两个汉字」还能看清；
 *   - `max-width: 220px`：上限不变，标题过长仍走省略号。
 * 收缩到 72px 之后仍放不下，就落到 `.tabbar__scroll` 的横向滚动（revealActiveTab 负责跟到活动标签）。
 */
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 10px;
  min-width: 72px;
  max-width: 220px;
  height: 100%;
  align-self: stretch;
  font-size: 13px;
  color: var(--fg-2);
  cursor: pointer;
  border-radius: 8px 8px 0 0;
  position: relative;
  user-select: none;
  flex: 0 1 auto;
  border: none;
  box-shadow: none;
  /* 收缩时允许子元素（标题）跟着变窄，否则文字的最小内容宽度会顶住不缩 */
  overflow: hidden;
}
.tab:hover {
  background: var(--bg-hover);
}
.tab.is-active {
  background: var(--bg-elevated);
  color: var(--fg);
  font-weight: 550;
}
.tab__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tab__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  flex: 0 0 auto;
}
.tab__close {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
  opacity: 0;
  flex: 0 0 auto;
}
.tab:hover .tab__close,
.tab.is-active .tab__close {
  opacity: 1;
}
.tab__close:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.tabbar__add {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
  flex: 0 0 auto;
  border-radius: 6px;
  margin-left: 2px;
}
.tabbar__add:hover {
  background: var(--bg-hover);
  color: var(--fg);
}

/* ---------------- 右侧控制区：标签跳转下拉 + 分屏按钮（1.1.7） ---------------- */

/*
 * 这一组固定贴在标签栏最右端（原生窗口按钮的左侧），不参与标签区的横向滚动，
 * 因此无论标签有多少、滚到哪里，这两个按钮始终可见。
 */
.tabbar__actions {
  display: flex;
  align-items: center;
  gap: 1px;
  flex: 0 0 auto;
  padding-left: 4px;
  margin-left: 2px;
  border-left: 1px solid var(--border);
}
.tabbar__switcher,
.tabbar__split {
  position: relative;
  display: flex;
  align-items: center;
}
.tabbar__act {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--fg-3);
  flex: 0 0 auto;
}
.tabbar__act:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.tabbar__act.is-on {
  background: var(--bg-active);
  color: var(--accent);
}

/* 两个下拉菜单（fixed 定位到按钮下方，避免被标签滚动区裁掉） */
.switchmenu,
.splitmenu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 9200;
  min-width: 190px;
  max-height: 60vh;
  overflow-y: auto;
  padding: 5px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-3);
}
.splitmenu {
  min-width: 152px;
}
.switchmenu__title,
.splitmenu__title {
  padding: 4px 8px 6px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--fg-3);
}
.switchmenu__item,
.splitmenu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 9px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--fg);
  text-align: left;
}
.switchmenu__item:hover,
.splitmenu__item:hover {
  background: var(--bg-hover);
}
.switchmenu__item.is-active,
.splitmenu__item.is-active {
  color: var(--accent);
  font-weight: 600;
}
.splitmenu__item.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.splitmenu__item.is-disabled:hover {
  background: transparent;
}
.switchmenu__text,
.splitmenu__text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.switchmenu__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex: 0 0 auto;
}
.switchmenu__empty {
  margin: 6px 9px 8px;
  font-size: 12px;
  color: var(--fg-3);
}
.splitmenu__sep {
  height: 1px;
  background: var(--border);
  margin: 4px 2px;
}

.tabmenu {
  position: fixed;
  z-index: 9200;
  min-width: 200px;
  padding: 5px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-3);
}
.tabmenu__item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--fg);
  text-align: left;
}
.tabmenu__item:hover {
  background: var(--bg-hover);
}
.tabmenu__sep {
  height: 1px;
  background: var(--border);
  margin: 4px 2px;
}
</style>
