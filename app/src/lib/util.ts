/** 通用工具函数 */

export const now = () => Date.now();

/** 简易稳定 ID */
export function uid(len = 12): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let s = '';
  for (let i = 0; i < len; i++) s += chars[buf[i] % chars.length];
  return s;
}

/** SHA-1 十六进制摘要（WebCrypto） */
/** 取底层 ArrayBuffer 副本，规避 ArrayBufferLike 的类型收窄问题 */
export function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

export async function sha1(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-1', toBuffer(data));
  return toHex(new Uint8Array(buf));
}

export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest('SHA-256', toBuffer(data));
  return new Uint8Array(buf);
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

export function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 人类可读字节 */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 数字按规范展示（>=10000 用万） */
export function fmtCount(n: number): string {
  if (n < 10000) return String(n);
  return `${(n / 10000).toFixed(1)}万`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** 2025年01月05日 14:30 */
export function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}年${pad(d.getMonth() + 1)}月${pad(d.getDate())}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 相对时间 */
export function fmtRelative(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day === 1) return '昨天';
  if (day < 7) return `${day} 天前`;
  if (day < 30) return `${Math.floor(day / 7)} 周前`;
  if (day < 365) return `${Math.floor(day / 30)} 个月前`;
  return `${Math.floor(day / 365)} 年前`;
}

/** 紧凑日期，用于列表右侧 */
export function fmtShortDate(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === today.getFullYear()) return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

/**
 * 生成默认文件名：YY年MM月DD日HHMM-【用户输入】
 */
export function buildDefaultName(userInput: string, at = Date.now()): string {
  const d = new Date(at);
  const stamp = `${String(d.getFullYear()).slice(2)}年${pad(d.getMonth() + 1)}月${pad(d.getDate())}日${pad(d.getHours())}${pad(d.getMinutes())}`;
  const label = sanitizeTitle(userInput) || '未命名';
  return `${stamp}-【${label}】`;
}

/** 清洗标题：去掉 Windows/Android 非法文件名字符 */
export function sanitizeTitle(raw: string): string {
  return raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/[【】]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** 清洗路径段 */
export function sanitizePathSegment(seg: string): string {
  return seg
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+$/, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'untitled';
}

/** 从 markdown 内容提取首个 H1 或首行，作为标题建议 */
export function extractTitleFromMarkdown(md: string): string {
  const lines = md.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const m = /^#{1,6}\s+(.+?)\s*#*$/.exec(t);
    if (m) return sanitizeTitle(m[1]);
    if (/^[-*_]{3,}$/.test(t)) continue;
    // 第一段有效文本
    const plain = t
      .replace(/^[>\s]*/, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]/g, '')
      .trim();
    if (plain) return sanitizeTitle(plain.slice(0, 60));
  }
  return '';
}

/** 从内容提取摘要（去 markdown 标记） */
export function extractExcerpt(md: string, max = 120): string {
  const plain = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[>\-*+]\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, max);
}

/** 统计字数（中英混合） */
export function countChars(text: string): number {
  return text.length;
}

/** 粗略统计"字"数：中文按字，英文按词 */
export function countWords(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fa5\u3040-\u30ff]/g) || []).length;
  const latin = (text.match(/[A-Za-z0-9]+(?:[''-][A-Za-z0-9]+)*/g) || []).length;
  return cjk + latin;
}

export function debounce<F extends (...args: never[]) => void>(fn: F, ms: number) {
  let t: ReturnType<typeof setTimeout> | null = null;
  const wrapped = ((...args: Parameters<F>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  }) as F & { cancel: () => void; flush: () => void };
  wrapped.cancel = () => { if (t) { clearTimeout(t); t = null; } };
  wrapped.flush = () => { if (t) { clearTimeout(t); t = null; fn(); } };
  return wrapped;
}

export function throttle<F extends (...args: never[]) => void>(fn: F, ms: number) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: Parameters<F>) => {
    const t = Date.now();
    const remain = ms - (t - last);
    if (remain <= 0) {
      last = t;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...args);
      }, remain);
    }
  }) as F;
}

/** 路径拼接（POSIX 风格，用于仓库内相对路径） */
export function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .join('/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '');
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function basename(p: string, stripExt = false): string {
  const i = p.lastIndexOf('/');
  let b = i < 0 ? p : p.slice(i + 1);
  if (stripExt) b = b.replace(/\.md$/i, '');
  return b;
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i).toLowerCase();
}

/** 深拷贝（仅纯数据） */
export function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** 简单对象合并（深） */
export function deepMerge<T>(base: T, patch: Partial<T>): T {
  if (Array.isArray(base) || Array.isArray(patch)) return (patch ?? base) as T;
  if (typeof base !== 'object' || base === null) return (patch ?? base) as T;
  const out = { ...(base as Record<string, unknown>) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    const cur = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = deepMerge(cur, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/** 是否在 Tauri 环境 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 是否支持 File System Access API */
export function hasFSA(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** 是否移动端 */
export function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
  return typeof window !== 'undefined' && window.matchMedia?.('(max-width: 860px)').matches;
}

/** 是否安卓 */
export function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}

/** 下载文本为文件（浏览器） */
export function downloadText(filename: string, text: string, mime = 'text/markdown;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** 复制文本 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch {
      return false;
    }
  }
}

/** 下一帧 */
export const nextTick = () => new Promise<void>((r) => setTimeout(r, 0));

/** 安全 JSON 解析 */
export function safeJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** 格式化快捷键显示 */
export function fmtKey(spec: string): string[] {
  return spec
    .split('+')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => {
      const low = k.toLowerCase();
      const map: Record<string, string> = {
        mod: isMac() ? '⌘' : 'Ctrl',
        ctrl: 'Ctrl',
        cmd: isMac() ? '⌘' : 'Ctrl',
        meta: isMac() ? '⌘' : 'Win',
        alt: isMac() ? '⌥' : 'Alt',
        shift: 'Shift',
        enter: 'Enter',
        esc: 'Esc',
        escape: 'Esc',
        space: 'Space',
        tab: 'Tab',
        backspace: '⌫',
        delete: 'Del',
        up: '↑',
        down: '↓',
        left: '←',
        right: '→',
        arrowup: '↑',
        arrowdown: '↓',
        arrowleft: '←',
        arrowright: '→',
        bslash: '\\',
        slash: '/',
        backquote: '`',
        minus: '-',
        equal: '=',
        comma: ',',
        period: '.',
      };
      return map[low] ?? k.toUpperCase();
    });
}

export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/** 从 KeyboardEvent 生成规范快捷键字符串 */
export function eventToSpec(e: KeyboardEvent | React.KeyboardEvent): string {
  const parts: string[] = [];
  const ev = e as KeyboardEvent;
  if (ev.ctrlKey) parts.push('Mod');
  else if (ev.metaKey) parts.push('Mod');
  if (ev.altKey) parts.push('Alt');
  if (ev.shiftKey) parts.push('Shift');

  let key = ev.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  else {
    const map: Record<string, string> = {
      Escape: 'Esc',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      Backspace: 'Backspace',
      Delete: 'Delete',
      Enter: 'Enter',
      Tab: 'Tab',
      '\\': 'Backslash',
    };
    key = map[key] ?? key;
  }
  parts.push(key);
  return parts.join('+');
}
