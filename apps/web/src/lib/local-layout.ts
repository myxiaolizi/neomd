/**
 * 本地窗口布局（localStorage）。
 *
 * 为什么单独一个文件、而不是写进 settings：
 * 侧栏宽度、大纲区高度这类值只对「当前这台设备的这个窗口」有意义，用户明确要求
 * 只在本机保存、不同步上传。而 `stores/settings.ts` 里的 `layout.*` 是云同步 payload
 * 的一部分（会跟着账号在设备间同步），因此这些可拖拽尺寸绝不能写进 settings。
 *
 * 存储键：`neomd.localLayout`，值是 JSON。
 */
import { ref, watch, type Ref } from 'vue';
import type { RightPanelSection } from '@neomd/shared';

/** localStorage 键名 */
export const LOCAL_LAYOUT_KEY = 'neomd.localLayout';

/**
 * 「打开新文件」的行为（1.1.7，用户要求做成设置项）。
 *
 * - `replace`：单文档模式 —— 关掉当前标签（先自动保存）再打开新文件；
 * - `keep`：多标签模式 —— 保留当前标签，新文件另开一个标签（点标签栏的 + 号即此模式）。
 *
 * 用户原话：「只有点击 + 号打开其他文件才视为同时打开 2 篇文件，否则打开新文件的时候
 * 自动保存并关闭当前文件；（当前的打开方式作为设置项，允许用户调整）」
 * 因此默认值是 `replace`。
 */
export type OpenMode = 'replace' | 'keep';

/** 本地布局数据结构 */
export interface LocalLayout {
  /** 左侧栏宽度（px） */
  leftWidth: number;
  /** 右侧栏宽度（px） */
  rightWidth: number;
  /** 「大纲 + 文件列表」模式下大纲区高度（px） */
  outlineHeight: number;
  /** 打开新文件的行为（1.1.7） */
  openMode: OpenMode;
  /** 分屏方向（1.1.7）：none 不分屏 / v 左右 / h 上下 */
  splitDirection: 'none' | 'v' | 'h';
  /** 分屏比例（0.2–0.8）：第一栏占可用空间的比例，拖动分隔条时更新 */
  splitRatio: number;
  /**
   * 右侧栏各功能区块的独立高度（1.1.7 需求 H，px）。
   *
   * 键 = `RightPanelSection` 的值（`ai` / `outline` / `backlinks` / `tags` /
   * `history` / `stats` / `calendar` / `file`），值 = 该区块的高度。
   * 只记「用户拖动过」的区块，未记录的按内容自适应（flex 自动分配）。
   */
  rightSectionHeights: Record<string, number>;
  /**
   * 右侧栏当前激活的区块（1.1.8，单选标签）。
   *
   * 空串表示「未指定」，由 EditorPage 回落到已启用区块的第一个。
   * 只存本机：换设备后右侧栏该显示什么，跟屏幕尺寸和使用习惯强相关。
   */
  rightTab: string;
  /**
   * 分屏第二栏的标签 id（1.1.8 真分屏）。
   *
   * 空串表示第二栏跟随活动标签；一旦用户在分屏里选了别的文件，就记在这里。
   * 存 id 而不是 docId，因为分屏要能容纳「设置」「插件商店」这类虚拟标签。
   */
  splitTabId: string;
}

/** 默认值：与 settings 里 layout.leftPanelWidth / rightPanelWidth 的默认保持一致，避免首屏跳动 */
export const DEFAULT_LOCAL_LAYOUT: LocalLayout = {
  leftWidth: 260,
  rightWidth: 400,
  outlineHeight: 320,
  openMode: 'replace',
  splitDirection: 'none',
  splitRatio: 0.5,
  rightSectionHeights: {},
  rightTab: '',
  splitTabId: '',
};

/** 右侧区块高度的可拖拽范围（px）：低于 80 内容全被裁掉，高于 900 单个区块就吃掉整屏 */
export const RIGHT_SECTION_HEIGHT_MIN = 80;
export const RIGHT_SECTION_HEIGHT_MAX = 900;

/**
 * 右侧区块高度的边界别名（供 `loadLocalLayout` 内部校验使用）。
 * 与上面的 MIN/MAX 是同一组值，集中一处避免两处硬编码漂移。
 */
const SECTION_HEIGHT_BOUNDS = {
  min: RIGHT_SECTION_HEIGHT_MIN,
  max: RIGHT_SECTION_HEIGHT_MAX,
};

/** 各尺寸的可拖拽范围（min / max / 默认值） */
export const LOCAL_LAYOUT_BOUNDS: Record<
  'leftWidth' | 'rightWidth' | 'outlineHeight',
  { min: number; max: number; defaultValue: number }
> = {
  leftWidth: { min: 200, max: 600, defaultValue: DEFAULT_LOCAL_LAYOUT.leftWidth },
  rightWidth: { min: 260, max: 720, defaultValue: DEFAULT_LOCAL_LAYOUT.rightWidth },
  outlineHeight: { min: 150, max: 800, defaultValue: DEFAULT_LOCAL_LAYOUT.outlineHeight },
};

/**
 * 分屏比例的可拖拽范围（1.4.0 从 0.2–0.8 放宽到 0.15–0.85）。
 *
 * 为什么放宽：用户经常想要「主栏写、副栏只留一条窄条看大纲」，20% 下限在
 * 1300px 宽的分屏上还占着 260px，仍然太宽；15% ≈ 195px 更贴近实际需求。
 * 上下限仍然保留，因为拖到 0 会让某一栏彻底不可见、也再抓不回手柄。
 */
export const SPLIT_RATIO_MIN = 0.15;
export const SPLIT_RATIO_MAX = 0.85;

/**
 * 右侧栏**最多同时显示**的区块数（1.4.0 需求：上限 3）。
 *
 * 为什么要有上限：改前是无上限多选，实测能开满 8 个，`.rightstack` 溢出 1010px，
 * 末位区块被压死在 80px（扣掉 28px 标题栏只剩 52px 可见），等于开了也用不了。
 *
 * **淘汰规则**：开启第 4 个时，自动关闭「最上方一个」（即当前顺序里的第 0 项），
 * 新块追加到列表末尾。语义集中在 `toggleRightSectionWithLimit()` 一处，
 * EditorPage 的右侧栏开关条与 SettingsPage 的区块开关都应当调用它，
 * 避免用户从设置页绕过限制。
 */
export const RIGHT_SECTION_LIMIT = 3;

/** `toggleRightSectionWithLimit()` 的返回结果 */
export interface RightSectionToggleResult {
  /** 新的区块列表（顺序 = 上下堆叠顺序） */
  list: RightPanelSection[];
  /** 本次因超出上限而被自动关闭的最上方区块；没有关闭则 null */
  evicted: RightPanelSection | null;
}

/**
 * 切换右侧栏某个区块的开启状态，并强制「最多 `limit` 个、超出时挤掉最上方一个」。
 *
 * 纯函数，不碰 store / 不改入参，便于单测与复用：
 * - 目标已开启 → 关闭它（保持其余元素相对顺序），`evicted` 为 null；
 * - 目标未开启 → **追加到末尾**（新开的总在最下面，与改前 `list.push()` 的观感一致），
 *   若此时长度超过 `limit`，从**头部**（最上方）移除一个，并把它作为 `evicted` 返回，
 *   供调用方弹提示「已关闭 XXX 以腾出位置」。
 *
 * 之所以从头部淘汰而不是从尾部：用户刚点的那个区块必须真的出现，
 * 而「最上方」是视觉上最先被顶出视野、也最容易被误认为最不重要的那个。
 */
export function toggleRightSectionWithLimit(
  current: readonly RightPanelSection[] | undefined,
  id: RightPanelSection,
  limit: number = RIGHT_SECTION_LIMIT,
): RightSectionToggleResult {
  const list = [...(current ?? [])];
  const idx = list.indexOf(id);
  if (idx >= 0) {
    list.splice(idx, 1);
    return { list, evicted: null };
  }
  list.push(id);
  let evicted: RightPanelSection | null = null;
  // 用 while 而不是 if：容错老数据里本来就超限（例如改前存了 6–8 个）的情况，
  // 用户下一次开新块时应当一次收敛到上限内，而不是只挤出 1 个仍然溢出。
  while (list.length > Math.max(1, limit)) {
    evicted = list.shift() ?? null;
  }
  return { list, evicted };
}

/** 把任意输入夹到 [min, max] 区间的整数；非法值回落到默认值 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 把任意输入夹到 [min, max] 区间的浮点数；非法值回落到默认值 */
function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 读取本地布局。
 * 容错：localStorage 不可用、内容不是合法 JSON、字段缺失或越界，都不会抛错，一律回落到默认值。
 */
export function loadLocalLayout(): LocalLayout {
  const fallback: LocalLayout = { ...DEFAULT_LOCAL_LAYOUT };
  try {
    const raw = globalThis.localStorage?.getItem(LOCAL_LAYOUT_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Record<keyof LocalLayout, unknown>>;
    if (!parsed || typeof parsed !== 'object') return fallback;
    return {
      leftWidth: clampNumber(
        parsed.leftWidth,
        LOCAL_LAYOUT_BOUNDS.leftWidth.min,
        LOCAL_LAYOUT_BOUNDS.leftWidth.max,
        fallback.leftWidth,
      ),
      rightWidth: clampNumber(
        parsed.rightWidth,
        LOCAL_LAYOUT_BOUNDS.rightWidth.min,
        LOCAL_LAYOUT_BOUNDS.rightWidth.max,
        fallback.rightWidth,
      ),
      outlineHeight: clampNumber(
        parsed.outlineHeight,
        LOCAL_LAYOUT_BOUNDS.outlineHeight.min,
        LOCAL_LAYOUT_BOUNDS.outlineHeight.max,
        fallback.outlineHeight,
      ),
      openMode: parsed.openMode === 'keep' || parsed.openMode === 'replace' ? parsed.openMode : fallback.openMode,
      splitDirection:
        parsed.splitDirection === 'v' || parsed.splitDirection === 'h' || parsed.splitDirection === 'none'
          ? parsed.splitDirection
          : fallback.splitDirection,
      splitRatio: clampFloat(parsed.splitRatio, SPLIT_RATIO_MIN, SPLIT_RATIO_MAX, fallback.splitRatio),
      /**
       * 右侧各区块高度（1.1.7）。
       *
       * 容错要点：只接受「正数 + 在合理区间内」的值，非法值直接丢弃，
       * 而不是回落到 0 —— 高度为 0 会让区块不可见，比「用自适应高度」糟糕得多。
       */
      rightSectionHeights: (() => {
        const raw = parsed.rightSectionHeights;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...fallback.rightSectionHeights };
        const out: Record<string, number> = {};
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          const n = typeof value === 'number' ? value : Number(value);
          if (!Number.isFinite(n)) continue;
          const clamped = Math.round(n);
          if (clamped < SECTION_HEIGHT_BOUNDS.min || clamped > SECTION_HEIGHT_BOUNDS.max) continue;
          out[key] = clamped;
        }
        return out;
      })(),
      // 右侧激活区块：只接受字符串，其余回落默认（由调用方再做「是否在启用列表」校验）
      rightTab: typeof parsed.rightTab === 'string' ? parsed.rightTab : fallback.rightTab,
      // 分屏第二栏标签 id：同上
      splitTabId: typeof parsed.splitTabId === 'string' ? parsed.splitTabId : fallback.splitTabId,
    };
  } catch {
    return fallback;
  }
}

/** 写入本地布局（整体覆盖）；写入失败（隐私模式 / 配额满）静默忽略，不影响拖拽手感 */
export function saveLocalLayout(layout: LocalLayout): void {
  try {
    globalThis.localStorage?.setItem(LOCAL_LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* 忽略：本地存储不可用时只是无法记住尺寸，不影响本次使用 */
  }
}

/** 进程内共享的响应式布局状态：多个组件（EditorPage / LeftPanel）必须看到同一份值 */
let sharedLayout: Ref<LocalLayout> | null = null;
/** 写盘节流句柄：拖拽时 mousemove 高频触发，合并成一次落盘 */
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 使用本地布局（组合式函数，全局单例）。
 *
 * 首次调用时从 localStorage 载入；之后任何 `update()` 都会先在内存里同步生效，
 * 再节流写回 localStorage。因此左右侧栏宽度、大纲区高度、分屏比例都是「本机记忆」。
 */
export function useLocalLayout(): {
  layout: Ref<LocalLayout>;
  update: (patch: Partial<LocalLayout>) => void;
  reset: () => void;
  bounds: typeof LOCAL_LAYOUT_BOUNDS;
  defaults: LocalLayout;
} {
  if (!sharedLayout) {
    sharedLayout = ref<LocalLayout>(loadLocalLayout());
    watch(
      sharedLayout,
      (value) => {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(() => {
          flushTimer = null;
          saveLocalLayout(value);
        }, 120);
      },
      { deep: true },
    );
  }

  const layout = sharedLayout;

  /** 局部更新：只传要改的字段 */
  function update(patch: Partial<LocalLayout>): void {
    layout.value = { ...layout.value, ...patch };
  }

  /** 恢复全部默认尺寸（ResizeHandle 双击复位时使用） */
  function reset(): void {
    layout.value = { ...DEFAULT_LOCAL_LAYOUT };
  }

  return { layout, update, reset, bounds: LOCAL_LAYOUT_BOUNDS, defaults: DEFAULT_LOCAL_LAYOUT };
}
