/**
 * 主题预设（1.0.2 起正文配色与界面外观融合为「一整套主题」）。
 *
 * 设计约定：
 * - 每套主题同时描述**正文纸张**（contentBg / contentFg）与**界面 chrome**
 *   （chromeBg / border / accent），因此切换主题时正文与侧栏、工具栏一起变化，
 *   不再出现「正文一片绿、侧栏还是灰」的割裂感；
 * - 内置主题只读，用户自定义主题存于 `AppearanceSettings.customThemes`；
 * - CSS 变量由 `themeVars()` 统一产出（`themes.css` 内的同名变量是同一套值的静态快照，
 *   用于 JS 执行前的首屏兜底，二者必须保持一致）。
 */
import type { AppearanceSettings, EditorColorScheme, ThemePreset } from './types';

/** 默认主题 id（新用户、旧数据兜底、非法 id 兜底都用它） */
export const DEFAULT_THEME_ID = 'daylight';

/** 旧版「正文配色方案」到主题 id 的兼容映射 */
export const LEGACY_SCHEME_THEME: Record<Exclude<EditorColorScheme, 'custom'>, string> = {
  white: 'daylight',
  gray: 'graphite',
  black: 'midnight',
  green: 'eyecare-green',
  lightblue: 'ocean-blue',
};

/** 旧版自定义配色的合成主题 id */
export const LEGACY_CUSTOM_THEME_ID = 'legacy-custom';

/**
 * 内置主题（10 套：6 浅色 + 4 深色）。
 *
 * 每套的 5 个颜色都是「设计值」，其余派生变量（hover / 边框透明度 / 阴影等）
 * 由 `themeVars()` 计算，保证 10 套主题的层次关系一致。
 */
export const BUILTIN_THEMES: ThemePreset[] = [
  {
    id: 'daylight',
    name: '日光白',
    mode: 'light',
    contentBg: '#ffffff',
    contentFg: '#1f2329',
    chromeBg: '#f2f4f7',
    border: '#e2e6ec',
    accent: '#1677ff',
    builtin: true,
  },
  {
    id: 'graphite',
    name: '石墨灰',
    mode: 'light',
    contentBg: '#f3f4f6',
    contentFg: '#1f2937',
    chromeBg: '#e7eaef',
    border: '#d6dbe3',
    accent: '#4b5563',
    builtin: true,
  },
  {
    id: 'midnight',
    name: '午夜黑',
    mode: 'dark',
    contentBg: '#14171c',
    contentFg: '#e5e7eb',
    chromeBg: '#1b1f26',
    border: '#2b313a',
    accent: '#4c8dff',
    builtin: true,
  },
  {
    id: 'eyecare-green',
    name: '护眼绿',
    mode: 'light',
    contentBg: '#e8f5e9',
    contentFg: '#1b3a24',
    chromeBg: '#d9efdb',
    border: '#c3e0c6',
    accent: '#2e7d32',
    builtin: true,
  },
  {
    id: 'ocean-blue',
    name: '静谧蓝',
    mode: 'light',
    contentBg: '#ebf5ff',
    contentFg: '#132a4a',
    chromeBg: '#dbeafb',
    border: '#c4dcf4',
    accent: '#1d6fd4',
    builtin: true,
  },
  {
    id: 'warm-paper',
    name: '暖纸黄',
    mode: 'light',
    contentBg: '#fdf6e3',
    contentFg: '#4a3f2a',
    chromeBg: '#f4ead2',
    border: '#e6d8b8',
    accent: '#b8860b',
    builtin: true,
  },
  {
    id: 'rose-pink',
    name: '玫瑰粉',
    mode: 'light',
    contentBg: '#fff5f7',
    contentFg: '#4a2530',
    chromeBg: '#fbe7ec',
    border: '#f0d2da',
    accent: '#d1477a',
    builtin: true,
  },
  {
    id: 'deep-sea',
    name: '深海青',
    mode: 'dark',
    contentBg: '#0f2027',
    contentFg: '#d7e6ea',
    chromeBg: '#13313a',
    border: '#22454f',
    accent: '#22b8cf',
    builtin: true,
  },
  {
    id: 'dusk-purple',
    name: '暮光紫',
    mode: 'dark',
    contentBg: '#1a1526',
    contentFg: '#e3ddf5',
    chromeBg: '#221b30',
    border: '#342b47',
    accent: '#9b7bf0',
    builtin: true,
  },
  {
    id: 'ink-black',
    name: '墨石黑',
    mode: 'dark',
    contentBg: '#1b1b1b',
    contentFg: '#e0e0e0',
    chromeBg: '#242424',
    border: '#343434',
    accent: '#e0a458',
    builtin: true,
  },
];

/* ------------------------------------------------------------------ */
/* 颜色工具（混色 / 透明度 / 对比度，供主题变量派生）                   */
/* ------------------------------------------------------------------ */

type Rgb = [number, number, number];

function parseHex(input: string): Rgb | null {
  const raw = input.trim();
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(raw);
  if (!m) return null;
  let hex = m[1] as string;
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

/** 解析任意 CSS 颜色（#rgb / #rrggbb / rgb() / rgba()）；失败返回 null */
function parseAnyColor(input: string): Rgb | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  const hex = parseHex(raw);
  if (hex) return hex;
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(raw);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function toHex([r, g, b]: Rgb): string {
  const part = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** 混合两种颜色：`weightOfA` 为 a 的占比（0-1），无法解析时原样返回 a */
export function mixColors(a: string, b: string, weightOfA: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  const t = Math.max(0, Math.min(1, weightOfA));
  return toHex([
    ca[0] * t + cb[0] * (1 - t),
    ca[1] * t + cb[1] * (1 - t),
    ca[2] * t + cb[2] * (1 - t),
  ]);
}

/** 给颜色加透明度；无法解析（如已是 rgba）时原样返回 */
export function withAlpha(color: string, alpha: number): string {
  const c = parseHex(color);
  if (!c) return color;
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Number(a.toFixed(3))})`;
}

/** 提亮（amount > 0）或压暗（amount < 0） */
export function shade(color: string, amount: number): string {
  const c = parseHex(color);
  if (!c) return color;
  return amount >= 0 ? mixColors('#ffffff', color, amount) : mixColors('#000000', color, -amount);
}

/** WCAG 相对亮度（sRGB → 线性化后按 0.2126/0.7152/0.0722 加权） */
export function relativeLuminance(color: string): number {
  const rgb = parseAnyColor(color);
  if (!rgb) return 0;
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/**
 * WCAG 对比度（1:1 - 21:1）。
 *
 * 需求 11 用它量化「分割线是否看得见」：`--border` 与背景的对比度必须 ≥ 1.2:1。
 * 注意这不是可读性对比度（正文要求 4.5:1），而是「一条 1px 细线能否在没有阴影的
 * 纯色背景上被分辨出来」的经验阈值 —— 1.0 表示完全同色（看不见），1.2 左右是
 * 肉眼刚能分辨的下限。
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * 把结构性颜色（分割线 / 边框）纠正到「对每个背景都 ≥ min」为止。
 *
 * ## 为什么必须做（需求 11 的根因）
 *
 * 内置主题里有一半的 `--border` 相对 `--bg` 只有 1.14-1.19 的对比度
 * （实测：日光白 1.14、石墨灰 1.15、护眼绿 1.17、静谧蓝 1.15、暖纸黄 1.18、玫瑰粉 1.19），
 * 用户调色后的自定义主题更是可能低到 1.05 —— 效果就是侧栏分隔线、表格线、
 * 标题下划线全部「消失」，界面层次彻底丢失。
 *
 * ## 方向选择：不穿越背景色
 *
 * 沿「当前颜色相对背景更亮还是更暗」的方向继续走（更亮就继续提亮、更暗就继续压暗），
 * 而不是无条件按明暗主题压暗/提亮 —— 否则深色主题的浅色边框会被压暗到
 * 穿过背景色，对比度先升后降，反而更糟。
 *
 * @param color       待纠正的颜色
 * @param backgrounds 它需要在其上可见的全部背景色
 * @param min         目标对比度（默认 1.2，取需求阈值）
 */
export function ensureContrast(color: string, backgrounds: string[], min = 1.2): string {
  const targets = backgrounds.filter((b) => parseAnyColor(b));
  if (!targets.length) return color;
  let current = color;
  for (let step = 0; step < 32; step += 1) {
    const worst = targets.reduce(
      (acc, bg) => {
        const ratio = contrastRatio(current, bg);
        return ratio < acc.ratio ? { ratio, bg } : acc;
      },
      { ratio: Number.POSITIVE_INFINITY, bg: targets[0] as string },
    );
    if (worst.ratio >= min) return current;
    const goLighter = relativeLuminance(current) >= relativeLuminance(worst.bg);
    // 每步向极端色靠 12%，32 步足以覆盖从纯白到纯黑的任意起点
    current = goLighter ? mixColors(current, '#ffffff', 0.88) : mixColors(current, '#000000', 0.88);
  }
  return current;
}

/* ------------------------------------------------------------------ */
/* 主题查询                                                            */
/* ------------------------------------------------------------------ */

/** 按 id 取内置主题；未命中返回 undefined */
export function getTheme(id?: string | null): ThemePreset | undefined {
  if (!id) return undefined;
  return BUILTIN_THEMES.find((t) => t.id === id);
}

/** 在内置 + 自定义主题中按 id 查找 */
export function findTheme(id?: string | null, customThemes?: ThemePreset[] | null): ThemePreset | undefined {
  const builtin = getTheme(id);
  if (builtin) return builtin;
  if (!id) return undefined;
  return (customThemes ?? []).find((t) => t.id === id);
}

/** 旧版自定义配色（customEditorBg / customEditorFg）合成一套主题 */
export function legacyCustomTheme(appearance?: Partial<AppearanceSettings> | null): ThemePreset {
  const bg = appearance?.customEditorBg?.trim() || '#ffffff';
  const fg = appearance?.customEditorFg?.trim() || '#1f2329';
  const bgRgb = parseHex(bg);
  const dark = bgRgb ? bgRgb[0] * 0.299 + bgRgb[1] * 0.587 + bgRgb[2] * 0.114 < 128 : false;
  return {
    id: LEGACY_CUSTOM_THEME_ID,
    name: '自定义（旧版配色）',
    mode: dark ? 'dark' : 'light',
    contentBg: bg,
    contentFg: fg,
    chromeBg: shade(bg, dark ? 0.12 : -0.04),
    border: withAlpha(fg, dark ? 0.16 : 0.12),
    accent: '#1677ff',
    builtin: false,
  };
}

/** 旧版正文配色方案映射到的主题 id */
export function legacyThemeId(scheme?: EditorColorScheme | null): string | undefined {
  if (!scheme || scheme === 'custom') return undefined;
  return LEGACY_SCHEME_THEME[scheme];
}

/**
 * 解析当前生效的主题。
 *
 * 优先级：
 * 1. `themePresetId` 命中的内置主题；
 * 2. `themePresetId` 命中的自定义主题；
 * 3. 旧版 `editorColorScheme` 的兼容映射（custom 用 customEditorBg/Fg 合成）；
 * 4. 兜底：按 `theme`（system/light/dark）选择对应明暗的基础主题，
 *    避免旧用户在升级后外观突变（dark → 午夜黑，其余 → 日光白）。
 *
 * 入参既可以是 `AppearanceSettings` 本身，也可以是 `{ appearance }` 形式的设置对象；
 * `options.prefersDark` 用于解析 `theme === 'system'`（纯函数，不读 window）。
 */
export function resolveTheme(
  input?: Partial<AppearanceSettings> | { appearance?: Partial<AppearanceSettings> } | null,
  options?: { prefersDark?: boolean },
): ThemePreset {
  const appearance: Partial<AppearanceSettings> | undefined =
    input && typeof input === 'object' && 'appearance' in input
      ? (input as { appearance?: Partial<AppearanceSettings> }).appearance
      : (input as Partial<AppearanceSettings> | undefined);

  const mode = appearance?.theme;
  const prefersDark = options?.prefersDark ?? false;
  const wantDark = mode === 'dark' || (mode === 'system' && prefersDark);

  const byId = findTheme(appearance?.themePresetId, appearance?.customThemes);
  if (byId) {
    // 若用户显式指定了 light / dark（或 system 跟随系统）且當前还是默认内置主题且明暗不符，回落到匹配明暗的默认主题
    if (
      (mode === 'dark' && byId.id === DEFAULT_THEME_ID) ||
      (mode === 'light' && byId.id === 'midnight') ||
      (mode === 'system' && byId.id === DEFAULT_THEME_ID && wantDark) ||
      (mode === 'system' && byId.id === 'midnight' && !wantDark)
    ) {
      return (getTheme(wantDark ? 'midnight' : DEFAULT_THEME_ID) ?? byId) as ThemePreset;
    }
    return byId;
  }

  const scheme = appearance?.editorColorScheme;
  if (scheme === 'custom') return legacyCustomTheme(appearance);
  if (scheme && scheme !== 'white') {
    const mapped = getTheme(legacyThemeId(scheme));
    if (mapped) return mapped;
  }

  return (getTheme(wantDark ? 'midnight' : DEFAULT_THEME_ID) ?? BUILTIN_THEMES[0]) as ThemePreset;
}

/** 该主题是否为内置主题（内置不可删除 / 不可编辑） */
export function isBuiltinTheme(id?: string | null): boolean {
  return Boolean(getTheme(id));
}

/* ------------------------------------------------------------------ */
/* CSS 变量                                                            */
/* ------------------------------------------------------------------ */

export type ThemeVarMap = Record<string, string>;

/* ------------------------------------------------------------------ */
/* 主题变量的语义分档（1.4.0，需求 11 / 12 的基础）                      */
/*                                                                     */
/* ## 为什么要分档                                                     */
/*                                                                     */
/* 1.4.0 观察到两个互相牵连的缺陷：                                     */
/*   a. 「颜色细化」调边框色时把分割线一起改了 → 界面层次丢失（需求11）； */
/*   b. 「仅正文」作用域仍然给整个界面染色（需求12）。                    */
/* 两者的共同根因是：变量只有「主题产出的 26 个」这一种分类，没有区分     */
/* 「用户可调的颜色」与「结构性颜色」，也没有区分「正文」与「界面」。     */
/*                                                                     */
/* ## 三档定义                                                        */
/*                                                                     */
/* - **正文档（CONTENT）**：正文纸张/文字，以及正文内部的结构底色。      */
/*   主题切换时它必须跟着变；选「仅界面」时应保持中性，否则正文还是被染色。*/
/* - **界面档（CHROME）**：侧栏/工具栏/标题栏的底色、文字、强调色、阴影。 */
/*   主题切换时跟着变；选「仅正文」时应保持中性。                       */
/* - **结构档（STRUCTURAL）**：分割线、边框、表格线 —— 它们**横跨两侧**， */
/*   是界面层次的载体。这一档的值可以由主题派生，但必须过对比度闸门       */
/*   （`ensureContrast`），且「颜色细化」不应直接把用户调的颜色塞进来。   */
/*                                                                     */
/* 结构档是界面档的子集（作用域上按界面处理），单独列出来是为了让          */
/* 审计脚本能逐项断言「它在任意主题下都可见」。                           */
/* ------------------------------------------------------------------ */

/** 主题「应用范围」：整体 / 仅正文 / 仅界面（本机偏好，存 localStorage，不进 settings） */
export type ThemeScope = 'all' | 'content' | 'chrome';

/** 正文专属变量：`themeScope === 'content'` 时**只**应用这些 */
export const CONTENT_THEME_VARS: readonly string[] = [
  '--content-bg',
  '--content-fg',
  '--code-block-bg',
  '--quote-bg',
  '--table-border',
] as const;

/**
 * 结构性颜色（分割线 / 边框 / 表格线）。
 *
 * 需求 11 的核心约定：这些值由主题派生并**经过对比度纠正**，
 * 而不是直接取用户「颜色细化」里填的边框色。
 */
export const STRUCTURAL_THEME_VARS: readonly string[] = [
  '--border',
  '--border-strong',
  '--table-border',
] as const;

/** 界面专属变量（含结构档）：`themeScope === 'chrome'` 时应用这些 */
export const CHROME_THEME_VARS: readonly string[] = [
  '--chrome-bg',
  '--bg',
  '--bg-elevated',
  '--bg-sidebar',
  '--bg-hover',
  '--bg-active',
  '--bg-input',
  '--fg',
  '--fg-2',
  '--fg-3',
  '--border',
  '--border-strong',
  '--accent',
  '--accent-hover',
  '--accent-weak',
  '--accent-weak-2',
  '--sky',
  '--sky-2',
  '--shadow-1',
  '--shadow-2',
  '--shadow-3',
] as const;

/**
 * 主题会产出的全部变量名（`themeVars()` 的键集合的静态清单）。
 *
 * 为什么列字面量而不是 `Object.keys(themeVars(someTheme))`：
 * 切换「应用范围」时必须**先清空上一轮写入的内联变量**，
 * 否则从「整体」切到「仅正文」后界面类变量会以旧值残留；
 * 这份清单要在模块加载期就固定，不受任何主题对象影响。
 */
export const ALL_THEME_VARS: readonly string[] = [
  ...CONTENT_THEME_VARS,
  ...CHROME_THEME_VARS,
] as const;

/** 该变量是否属于「正文档」 */
export function isContentThemeVar(key: string): boolean {
  return CONTENT_THEME_VARS.includes(key);
}

/**
 * 作用域下的「主题色是否允许写这个变量」。
 *
 * 保留了 1.1.1 起的同名 API（`stores/settings.ts` 与审计脚本都读它），
 * 但分类数据源改为上面三张权威表，避免再出现「白名单漏项」。
 */
export function themeVarAllowed(key: string, scope: ThemeScope): boolean {
  if (scope === 'all') return true;
  const content = isContentThemeVar(key);
  return scope === 'content' ? content : !content;
}

/* ------------------------------------------------------------------ */
/* 中性基线（作用域排除一侧时用它顶替，而不是 removeProperty）           */
/* ------------------------------------------------------------------ */

/**
 * 中性配色（= `index.css` 里 `:root` 与 `html[data-theme='dark']` 的取值）。
 *
 * ## 为什么必须有这份值（需求 12 的根因）
 *
 * 旧实现切到「仅正文」时对界面变量执行 `root.style.removeProperty(key)`，
 * 想借此让界面回到「没有主题」的状态。但 `themes.css` 里有
 * `:root[data-theme-preset='midnight'] { --bg: #1b1f26; … }` —— 删掉内联样式后，
 * 这条**静态主题规则**立刻接管，`--bg` 仍是主题的侧栏色，界面照旧被染色。
 * 实测（tools/re14-settings-probe.mjs）：scope=content 时内联 `--bg` 已清空，
 * 但 computed `--bg` 依旧是 `#1b1f26`。
 *
 * 所以正确做法是**显式写入中性值**（内联样式优先级高于样式表规则），
 * 而不是把决定权交回给 CSS 级联。
 */
export const NEUTRAL_THEME_VARS: Record<'light' | 'dark', ThemeVarMap> = {
  light: {
    '--content-bg': '#ffffff',
    '--content-fg': '#1a1d21',
    '--chrome-bg': '#f7f8fa',
    '--bg': '#f7f8fa',
    '--bg-elevated': '#ffffff',
    '--bg-sidebar': 'rgba(248, 250, 252, 0.86)',
    '--bg-hover': 'rgba(15, 23, 42, 0.045)',
    '--bg-active': 'rgba(22, 119, 255, 0.1)',
    '--bg-input': '#ffffff',
    '--fg': '#1a1d21',
    '--fg-2': '#4b5563',
    '--fg-3': '#8a919c',
    '--border': 'rgba(15, 23, 42, 0.14)',
    '--border-strong': 'rgba(15, 23, 42, 0.26)',
    '--accent': '#1677ff',
    '--accent-hover': '#0f62d6',
    '--accent-weak': 'rgba(22, 119, 255, 0.12)',
    '--accent-weak-2': 'rgba(22, 119, 255, 0.06)',
    '--sky': '#e8f2ff',
    '--sky-2': '#d3e6ff',
    '--code-block-bg': '#f5f5f5',
    '--quote-bg': 'rgba(22, 119, 255, 0.06)',
    '--table-border': 'rgba(15, 23, 42, 0.2)',
    '--shadow-1': '0 1px 2px rgba(15, 23, 42, 0.05), 0 1px 3px rgba(15, 23, 42, 0.06)',
    '--shadow-2': '0 4px 12px rgba(15, 23, 42, 0.08), 0 1px 3px rgba(15, 23, 42, 0.05)',
    '--shadow-3': '0 12px 32px rgba(15, 23, 42, 0.14), 0 2px 6px rgba(15, 23, 42, 0.06)',
  },
  dark: {
    '--content-bg': '#14171c',
    '--content-fg': '#e6e9ee',
    '--chrome-bg': '#14171c',
    '--bg': '#14171c',
    '--bg-elevated': '#1b1f26',
    '--bg-sidebar': 'rgba(27, 31, 38, 0.9)',
    '--bg-hover': 'rgba(255, 255, 255, 0.06)',
    '--bg-active': 'rgba(22, 119, 255, 0.2)',
    '--bg-input': '#232830',
    '--fg': '#e6e9ee',
    '--fg-2': '#a9b1bd',
    '--fg-3': '#6f7885',
    '--border': 'rgba(255, 255, 255, 0.16)',
    '--border-strong': 'rgba(255, 255, 255, 0.3)',
    '--accent': '#1677ff',
    '--accent-hover': '#0f62d6',
    '--accent-weak': 'rgba(22, 119, 255, 0.12)',
    '--accent-weak-2': 'rgba(22, 119, 255, 0.06)',
    '--sky': 'rgba(22, 119, 255, 0.14)',
    '--sky-2': 'rgba(22, 119, 255, 0.22)',
    '--code-block-bg': '#232830',
    '--quote-bg': 'rgba(22, 119, 255, 0.1)',
    '--table-border': 'rgba(255, 255, 255, 0.24)',
    '--shadow-1': '0 1px 2px rgba(0, 0, 0, 0.4)',
    '--shadow-2': '0 4px 14px rgba(0, 0, 0, 0.45)',
    '--shadow-3': '0 16px 40px rgba(0, 0, 0, 0.55)',
  },
};

/** 取中性基线里某一档的变量（`side` 为 'content' 时只返回正文档） */
export function neutralThemeVars(
  mode: 'light' | 'dark',
  side: 'content' | 'chrome',
): ThemeVarMap {
  const base = NEUTRAL_THEME_VARS[mode === 'dark' ? 'dark' : 'light'];
  const out: ThemeVarMap = {};
  for (const [key, value] of Object.entries(base)) {
    if (isContentThemeVar(key) === (side === 'content')) out[key] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 结构色保护                                                          */
/* ------------------------------------------------------------------ */

/** 需求 11 的对比度门槛：分割线对背景至少要比到 1.2:1 才「看得见」 */
export const BORDER_CONTRAST_MIN = 1.2;

/**
 * 对一套变量做结构性颜色纠正（分割线 / 边框 / 表格线）。
 *
 * 输入输出都是 `ThemeVarMap`，纯函数、不改入参，便于：
 * - `applyThemeVars()` 在写 `<html>` 之前调用（运行时保证）；
 * - `themes.css` 的生成脚本调用（静态快照保持一致，首屏不跳变）；
 * - 审计脚本直接断言（不依赖浏览器也能验）。
 *
 * 三处纠正：
 * 1. `--border` 必须同时对 `--bg`（侧栏/工具栏底）与 `--content-bg`（正文纸张）
 *    ≥ 1.2 —— 分割线在两侧都要看得见；
 * 2. `--border-strong` 必须比 `--border` 更强（否则层次倒挂，hover 边框反而消失）；
 * 3. `--table-border` 必须对 `--content-bg` ≥ 1.2 —— 表格线在正文里。
 */
export function protectStructuralColors(vars: ThemeVarMap, min = BORDER_CONTRAST_MIN): ThemeVarMap {
  const out: ThemeVarMap = { ...vars };
  const chromeBg = out['--bg'] ?? '#ffffff';
  const contentBg = out['--content-bg'] ?? '#ffffff';
  const hardTargets = [chromeBg, contentBg];

  const border = out['--border'];
  if (border) {
    out['--border'] = ensureContrast(border, hardTargets, min);
  }
  const strong = out['--border-strong'];
  if (strong) {
    // 先保证比 border 更强，再保证对背景达标
    const strongerFloor = border
      ? Math.max(min, contrastRatio(out['--border'] as string, chromeBg) * 1.25)
      : min;
    out['--border-strong'] = ensureContrast(strong, hardTargets, strongerFloor);
  }
  const tableBorder = out['--table-border'];
  if (tableBorder) {
    out['--table-border'] = ensureContrast(tableBorder, [contentBg], min);
  }
  return out;
}

/**
 * 产出主题对应的整套 CSS 变量。
 *
 * 正文与界面共用同一套变量：
 * - `--content-bg` / `--content-fg`：正文纸张（阅读视图、导出预览、正文容器）；
 * - `--bg` / `--bg-elevated` / `--bg-sidebar` / `--border` / `--accent`：界面 chrome；
 * - `--fg` 跟随正文文字色，保证「正文与侧栏同一套文字色」。
 *
 * 1.4.0 起返回值经过 `protectStructuralColors()`：
 * 结构色若与背景对比度不足 1.2 会被自动纠正（需求 11）。
 */
export function themeVars(theme: ThemePreset): ThemeVarMap {
  const dark = theme.mode === 'dark';
  const paper = theme.contentBg;
  const ink = theme.contentFg;
  const chrome = theme.chromeBg;
  const accent = theme.accent;
  const raw: ThemeVarMap = {
    /* 正文纸张 */
    '--content-bg': paper,
    '--content-fg': ink,
    /* 界面 chrome */
    '--chrome-bg': chrome,
    '--bg': chrome,
    '--bg-elevated': paper,
    '--bg-sidebar': withAlpha(chrome, 0.94),
    '--bg-hover': withAlpha(ink, dark ? 0.08 : 0.05),
    '--bg-active': withAlpha(accent, dark ? 0.2 : 0.12),
    '--bg-input': dark ? mixColors(paper, '#ffffff', 0.94) : mixColors(paper, '#ffffff', 0.4),
    /* 文字：正文与界面同色，弱化层级由混色派生 */
    '--fg': ink,
    '--fg-2': mixColors(ink, paper, 0.72),
    '--fg-3': mixColors(ink, paper, 0.5),
    /* 边框与强调色 */
    '--border': theme.border,
    '--border-strong': shade(theme.border, dark ? 0.2 : -0.16),
    '--accent': accent,
    '--accent-hover': shade(accent, dark ? 0.14 : -0.14),
    '--accent-weak': withAlpha(accent, dark ? 0.22 : 0.13),
    '--accent-weak-2': withAlpha(accent, dark ? 0.12 : 0.07),
    '--sky': mixColors(paper, accent, 0.86),
    '--sky-2': mixColors(paper, accent, 0.76),
    /* 正文内的结构性底色（1.1.1 新增：全部由主题派生，不再让用户单独配「正文配色」） */
    '--code-block-bg': mixColors(paper, ink, dark ? 0.9 : 0.955),
    '--quote-bg': withAlpha(accent, dark ? 0.1 : 0.06),
    '--table-border': shade(theme.border, dark ? 0.14 : -0.1),
    /* 阴影 */
    '--shadow-1': dark ? '0 1px 2px rgba(0, 0, 0, 0.4)' : '0 1px 2px rgba(15, 23, 42, 0.05), 0 1px 3px rgba(15, 23, 42, 0.06)',
    '--shadow-2': dark ? '0 4px 14px rgba(0, 0, 0, 0.45)' : '0 4px 12px rgba(15, 23, 42, 0.08), 0 1px 3px rgba(15, 23, 42, 0.05)',
    '--shadow-3': dark ? '0 16px 40px rgba(0, 0, 0, 0.55)' : '0 12px 32px rgba(15, 23, 42, 0.14), 0 2px 6px rgba(15, 23, 42, 0.06)',
  };
  return protectStructuralColors(raw);
}

/**
 * 按「应用范围」合成最终要写到 `<html>` 的变量表（需求 12 的唯一语义入口）。
 *
 * | scope     | 正文档          | 界面档（含结构档） |
 * |-----------|-----------------|--------------------|
 * | `all`     | 主题值          | 主题值             |
 * | `content` | 主题值          | **中性基线**       |
 * | `chrome`  | **中性基线**    | 主题值             |
 *
 * 两侧都写「实值」而不是删除键：删除后会回落到 `themes.css` 里同一套主题的
 * 静态规则，界面照样被染色（这就是「仅正文仍全局生效」的根因）。
 *
 * 最后统一跑一次结构色保护 —— 即使某一侧用了中性基线，也要保证它与
 * 另一侧的背景搭配后分割线仍然可见。
 */
export function scopedThemeVars(
  theme: ThemePreset,
  scope: ThemeScope,
): ThemeVarMap {
  const themed = themeVars(theme);
  const mode = theme.mode === 'dark' ? 'dark' : 'light';
  if (scope === 'all') return themed;

  const out: ThemeVarMap = {};
  if (scope === 'content') {
    // 正文跟主题，界面回中性
    for (const [key, value] of Object.entries(themed)) {
      if (isContentThemeVar(key)) out[key] = value;
    }
    Object.assign(out, neutralThemeVars(mode, 'chrome'));
  } else {
    // 界面跟主题，正文回中性
    for (const [key, value] of Object.entries(themed)) {
      if (!isContentThemeVar(key)) out[key] = value;
    }
    Object.assign(out, neutralThemeVars(mode, 'content'));
  }
  return protectStructuralColors(out);
}


/* ------------------------------------------------------------------ */
/* 自定义主题                                                          */
/* ------------------------------------------------------------------ */

/** 生成自定义主题 id（custom-<时间戳36>-<随机>） */
export function createThemeId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 是否是可编辑的自定义主题 */
export function isCustomTheme(theme: Pick<ThemePreset, 'id' | 'builtin'>): boolean {
  return theme.builtin !== true && !getTheme(theme.id);
}

/** 依据旧值 / 现有主题派生一套「空白自定义主题」的初值（新建时用） */
export function blankCustomTheme(base?: ThemePreset | null): ThemePreset {
  const source = base ?? resolveTheme(null);
  return {
    id: createThemeId(),
    name: `${source.name}（副本）`,
    mode: source.mode,
    contentBg: source.contentBg,
    contentFg: source.contentFg,
    chromeBg: source.chromeBg,
    border: source.border,
    accent: source.accent,
    builtin: false,
  };
}

const COLOR_RE = /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|rgba?\([\d\s.,%]+\))$/;

function pickColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && COLOR_RE.test(value.trim()) ? value.trim() : fallback;
}

/**
 * 把任意来源（导入的 JSON / localStorage 旧值 / 云端 payload）归一成合法的 ThemePreset。
 * 非法输入返回 null，由调用方给出可读错误，避免脏数据写进设置。
 */
export function normalizeTheme(input: unknown): ThemePreset | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 24) : '';
  if (!name) return null;
  const modeRaw = raw.mode;
  const mode = modeRaw === 'dark' ? 'dark' : 'light';
  const contentBg = pickColor(raw.contentBg, mode === 'dark' ? '#14171c' : '#ffffff');
  const contentFg = pickColor(raw.contentFg, mode === 'dark' ? '#e5e7eb' : '#1f2329');
  const idRaw = typeof raw.id === 'string' ? raw.id.trim() : '';
  const id = idRaw && !getTheme(idRaw) ? idRaw : createThemeId();
  return {
    id,
    name,
    mode,
    contentBg,
    contentFg,
    chromeBg: pickColor(raw.chromeBg, shade(contentBg, mode === 'dark' ? 0.1 : -0.04)),
    border: pickColor(raw.border, withAlpha(contentFg, mode === 'dark' ? 0.16 : 0.12)),
    accent: pickColor(raw.accent, '#1677ff'),
    builtin: false,
  };
}

/** 主题库（内置 + 自定义），供设置页展示与导出使用 */
export function allThemes(customThemes?: ThemePreset[] | null): ThemePreset[] {
  const custom = (customThemes ?? []).filter(
    (t): t is ThemePreset => Boolean(t) && typeof t.id === 'string' && !getTheme(t.id),
  );
  return [...BUILTIN_THEMES, ...custom];
}
