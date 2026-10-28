import type { NamingSettings } from './types';

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * 新建文档的默认命名模板。
 *
 * 产品约定（1.0.2）：新建文件默认名为 `YYMMDD日HHMM-`（例：`261026日2130-`）。
 * 模板里保留 `{input}` 占位，用户不填时该位置为空，于是天然得到末尾带 `-` 的时间戳名；
 * 后续 AI 生成 4-10 字内容缩写时就填进这个位置（`261026日2130-知识库搭建`）。
 */
export const DEFAULT_NAMING_TEMPLATE = 'YYMMDD日HHMM-{input}';

/** AI 内容缩写的长度区间（汉字/字符数） */
export const AI_SUMMARY_MIN = 4;
export const AI_SUMMARY_MAX = 10;

/** 日记文件名后缀，与日期之间用空格分隔（`2026-10-27 日记`） */
export const DIARY_SUFFIX = '日记';

/**
 * 生成日记标题／文件名（**不含 `.md`**）。
 *
 * 产品约定（1.1.7）：点「今日日记」得到的名字是 `YYYY-MM-DD 日记`，
 * 例如 `2026-10-27 日记`；该文档正文第一行的标题行也是同一个字符串。
 *
 * 与 `buildDatetimeName()` 的关系：
 * - **刻意不复用它**。`buildDatetimeName` 走用户可自定义的 `naming.template`
 *   （默认 `YYMMDD日HHMM-{input}`），日记是固定格式的产品行为，不应受模板影响；
 *   两者独立，改日记格式不会影响新建普通文档的命名规则。
 *
 * @param date 目标日期；缺省为今天。可用 `Date` 或 `YYYY-MM-DD` 字符串。
 */
export function buildDiaryName(date: Date | string = new Date()): string {
  let y: number;
  let m: number;
  let d: number;
  if (typeof date === 'string') {
    // 传入字符串时按本地日期解析，避免 `new Date('2026-10-27')` 被当成 UTC 而跨日
    const matched = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date.trim());
    if (matched) {
      y = Number(matched[1]);
      m = Number(matched[2]);
      d = Number(matched[3]);
    } else {
      const parsed = new Date(date);
      y = parsed.getFullYear();
      m = parsed.getMonth() + 1;
      d = parsed.getDate();
    }
  } else {
    y = date.getFullYear();
    m = date.getMonth() + 1;
    d = date.getDate();
  }
  return `${y}-${pad(m)}-${pad(d)} ${DIARY_SUFFIX}`;
}

/**
 * 判断某个标题是不是日记（用于「已存在当日日记就打开」的去重判定）。
 * 同时兼容 1.1.7 之前的旧格式 `YYYY-MM-DD`（无「日记」后缀），
 * 避免升级后同一天出现两篇日记。
 */
export function isDiaryTitle(title: string, date?: Date | string): boolean {
  const text = String(title ?? '').trim();
  const target = buildDiaryName(date);
  if (text === target) return true;
  // 旧格式：同一天、无后缀
  if (text === target.slice(0, target.length - DIARY_SUFFIX.length).trim()) return true;
  return false;
}

/**
 * 按模板生成文件名（含 `.md`）。
 *
 * - 支持 `{YY}` 与裸写 `YY` 两种占位符；`{input}` / `input` 等价。
 * - **input 为空时不回退成「无标题」**：占位符直接替换为空串，
 *   从而得到 `261026日2130-` 这种纯时间戳名字；只有「整个结果为空」时才用 fallback。
 * - 模板里 `HHMM` 是「小时+分钟」的常见写法，因此紧跟 `HH` 的 `MM` 视为分钟。
 */
export function buildDatetimeName(
  input: string,
  settings: Pick<NamingSettings, 'template' | 'fallback'>,
  now: Date = new Date(),
): string {
  const safe = sanitizeTitle(input.trim());
  const values: Record<string, string> = {
    YYYY: String(now.getFullYear()),
    YY: pad(now.getFullYear() % 100),
    MM: pad(now.getMonth() + 1),
    DD: pad(now.getDate()),
    HH: pad(now.getHours()),
    mm: pad(now.getMinutes()),
    ss: pad(now.getSeconds()),
    input: safe,
  };
  const tpl = settings.template?.trim() || DEFAULT_NAMING_TEMPLATE;
  // 单次扫描替换，避免替换结果被二次替换；长键优先（YYYY 先于 YY）。
  const pattern = /\{?(YYYY|YY|MM|DD|HH|mm|ss|input)\}?/g;
  let lastKey = '';
  const replaced = tpl.replace(pattern, (m: string, key: string) => {
    let value = values[key];
    if (key === 'MM' && lastKey === 'HH') value = values.mm;
    lastKey = key;
    return value === undefined ? m : value;
  });
  // 模板本身可能只剩时间戳（input 为空），此时也接受结果；
  // 只有当替换后彻底为空（例如用户把模板删光了）才退回 fallback。
  const stem = sanitizeTitle(replaced);
  if (!stem) {
    const fallback = sanitizeTitle(settings.fallback || '无标题') || '无标题';
    return `${fallback}.md`;
  }
  return `${stem}.md`;
}

/**
 * 把 AI 给出的内容概括裁成 4-10 字的「文件名缩写」。
 *
 * 规则：
 * - 去掉标点、空白、引号与 Markdown 标记；
 * - 截到 `AI_SUMMARY_MAX` 个字符；
 * - 不足 `AI_SUMMARY_MIN` 字时返回空串（宁可不加，也不要在文件名里塞半截词）；
 * - AI 不可用（调用失败/返回空）时调用方直接传空串，最终名字保持 `YYMMDD日HHMM-`。
 */
export function toNameSummary(raw: string): string {
  const cleaned = String(raw ?? '')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_`~>[\]()#]/g, '')
    .replace(/[，。；：、！？,.;:!?"'「」『』《》【】…—－-]/g, '')
    .replace(/\s+/g, '')
    .trim();
  if (!cleaned) return '';
  const clipped = clippedByChars(cleaned, AI_SUMMARY_MAX);
  return clipped.length >= AI_SUMMARY_MIN ? clipped : '';
}

/** 按「字符（码点）」截断，避免把 emoji / 生僻字截成半个 */
function clippedByChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/**
 * 生成「时间戳 + 内容缩写」的最终文件名。
 *
 * @param summary AI 生成的内容缩写；AI 不可用时传空串。
 */
export function buildDocName(
  summary: string,
  settings: Pick<NamingSettings, 'template' | 'fallback'>,
  now: Date = new Date(),
): string {
  return buildDatetimeName(toNameSummary(summary), settings, now);
}

/** 文件名安全化：去掉 Windows/Android 非法字符，限制长度 */
export function sanitizeTitle(raw: string): string {
  let s = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^\.+/, '');
  if (s.length > 120) s = s.slice(0, 120).trim();
  return s;
}

/** 由文件名推导展示标题（去扩展名） */
export function titleFromPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

/** 保证仓库内路径唯一，重名追加 (2)(3)… */
export function uniquePath(path: string, taken: Set<string>): string {
  if (!taken.has(path.toLowerCase())) return path;
  const dot = path.lastIndexOf('.');
  const stem = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : '';
  for (let i = 2; i < 10000; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}

/** 相对路径规范化：统一 POSIX，去掉 ./ 与多余斜杠 */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/$/, '');
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join('/'));
}

export function dirname(path: string): string {
  const p = normalizePath(path);
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function basename(path: string): string {
  const p = normalizePath(path);
  return p.split('/').pop() ?? p;
}

/** Wikilink 解析：[[目标#锚点|别名]] */
export function parseWikilink(text: string): { target: string; anchor: string; alias: string } | null {
  const m = /^\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]$/.exec(text.trim());
  if (!m) return null;
  return { target: (m[1] ?? '').trim(), anchor: (m[2] ?? '').trim(), alias: (m[3] ?? '').trim() };
}

/** 数字按「万」显示，保留 1 位小数（仅超过 10000 时） */
export function formatCompactNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) < 10000) return String(n);
  const v = n / 10000;
  return `${v.toFixed(1)}万`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatDate(ts: number, withTime = true): string {
  const d = new Date(ts);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
}

export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return formatDate(ts, false);
}

/** 稳定的短哈希（FNV-1a 32bit），用于本地 id */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function uid(prefix = ''): string {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `${prefix}${Date.now().toString(36)}${rnd}`;
}
