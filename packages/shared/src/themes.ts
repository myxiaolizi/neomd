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
/* 颜色工具（十六进制混色 / 透明度，供主题变量派生）                    */
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

  const byId = findTheme(appearance?.themePresetId, appearance?.customThemes);
  if (byId) return byId;

  const scheme = appearance?.editorColorScheme;
  if (scheme === 'custom') return legacyCustomTheme(appearance);
  if (scheme && scheme !== 'white') {
    const mapped = getTheme(legacyThemeId(scheme));
    if (mapped) return mapped;
  }

  const mode = appearance?.theme;
  const prefersDark = options?.prefersDark ?? false;
  const dark = mode === 'dark' || (mode === 'system' && prefersDark);
  return (getTheme(dark ? 'midnight' : DEFAULT_THEME_ID) ?? BUILTIN_THEMES[0]) as ThemePreset;
}

/** 该主题是否为内置主题（内置不可删除 / 不可编辑） */
export function isBuiltinTheme(id?: string | null): boolean {
  return Boolean(getTheme(id));
}

/* ------------------------------------------------------------------ */
/* CSS 变量                                                            */
/* ------------------------------------------------------------------ */

export type ThemeVarMap = Record<string, string>;

/**
 * 产出主题对应的整套 CSS 变量。
 *
 * 正文与界面共用同一套变量：
 * - `--content-bg` / `--content-fg`：正文纸张（阅读视图、导出预览、正文容器）；
 * - `--bg` / `--bg-elevated` / `--bg-sidebar` / `--border` / `--accent`：界面 chrome；
 * - `--fg` 跟随正文文字色，保证「正文与侧栏同一套文字色」。
 */
export function themeVars(theme: ThemePreset): ThemeVarMap {
  const dark = theme.mode === 'dark';
  const paper = theme.contentBg;
  const ink = theme.contentFg;
  const chrome = theme.chromeBg;
  const accent = theme.accent;
  return {
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
