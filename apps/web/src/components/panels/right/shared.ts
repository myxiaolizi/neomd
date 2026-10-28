/**
 * 右侧栏附加功能区块（1.0.2）。
 *
 * 设计：不依赖 Pinia，全部数据通过 props 传入，便于单独测试与复用。
 * 六个区块分别是大纲、反向链接、标签、历史版本、文档统计、日历。
 */
import { computed, ref } from 'vue';

/** 大纲条目 */
export interface OutlineItem {
  level: number;
  text: string;
  id?: string;
}

/** 反向链接条目 */
export interface BacklinkItem {
  docId: string;
  title: string;
  snippet: string;
}

export interface RightSectionProps {
  docId?: string;
  title?: string;
  content?: string;
  outline?: OutlineItem[];
  backlinks?: BacklinkItem[];
  tags?: string[];
  stats?: { chars: number; words: number; paragraphs: number; readingMinutes: number };
  versions?: Array<{ id: string; rev: number; createdAt: number; label?: string }>;
}

/** 从正文里提取 #标签（排除代码块、frontmatter） */
export function extractTags(content: string): string[] {
  const body = String(content ?? '')
    .replace(/^---[\s\S]*?---/, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '');
  const out = new Set<string>();
  const re = /(^|\s)#([\p{L}\p{N}_/-]{1,40})/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const tag = m[2];
    if (tag) out.add(tag);
  }
  return [...out].sort((a, b) => a.localeCompare(b, 'zh'));
}

/** 计算文档统计 */
export function computeStats(content: string): { chars: number; words: number; paragraphs: number; readingMinutes: number } {
  const text = String(content ?? '');
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (text.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9_-]+/g) ?? []).length;
  const words = cjk + latin;
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim()).length;
  return { chars: text.length, words, paragraphs, readingMinutes: Math.max(1, Math.round(words / 300)) };
}

/** 生成当月日历网格（周一为每周第一天） */
export function buildMonthGrid(year: number, month: number): Array<{ day: number; inMonth: boolean; date: string }> {
  const first = new Date(year, month, 1);
  const startWeekday = (first.getDay() + 6) % 7; // 周一=0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevDays = new Date(year, month, 0).getDate();
  const cells: Array<{ day: number; inMonth: boolean; date: string }> = [];
  const fmt = (y: number, m: number, d: number): string =>
    `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  for (let i = startWeekday - 1; i >= 0; i -= 1) {
    cells.push({ day: prevDays - i, inMonth: false, date: fmt(month === 0 ? year - 1 : year, month === 0 ? 11 : month - 1, prevDays - i) });
  }
  for (let d = 1; d <= daysInMonth; d += 1) {
    cells.push({ day: d, inMonth: true, date: fmt(year, month, d) });
  }
  while (cells.length % 7 !== 0) {
    const d = cells.length - (startWeekday + daysInMonth) + 1;
    const nextMonth = month === 11 ? 0 : month + 1;
    const nextYear = month === 11 ? year + 1 : year;
    cells.push({ day: d, inMonth: false, date: fmt(nextYear, nextMonth, d) });
  }
  return cells;
}

/** 供组件复用的工具集合 */
export function useRightSection() {
  const collapsed = ref(false);
  const toggle = (): void => {
    collapsed.value = !collapsed.value;
  };
  return { collapsed, toggle };
}

/** 把大纲压平成可渲染的行（带缩进层级） */
export function flattenOutline(items: OutlineItem[]): Array<{ text: string; level: number }> {
  return items.map((i) => ({ text: i.text, level: Math.min(6, Math.max(1, i.level)) }));
}

/** 统计某个日期是否有对应日记文件（文件名以 YYYY-MM-DD 开头或包含） */
export function hasDailyNote(docs: Array<{ path: string; title: string }>, date: string): boolean {
  return docs.some((d) => d.title.startsWith(date) || d.path.startsWith(date));
}

export const RIGHT_SECTION_LABELS: Record<string, string> = {
  ai: 'AI 助手',
  file: '文件操作',
  outline: '大纲',
  backlinks: '反向链接',
  tags: '标签',
  history: '历史版本',
  stats: '统计',
  calendar: '日历',
};

export const RIGHT_SECTION_ICONS: Record<string, string> = {
  ai: 'sparkles',
  file: 'folder',
  outline: 'outline',
  backlinks: 'link',
  tags: 'tag',
  history: 'history',
  stats: 'chart',
  calendar: 'calendar',
};

export { computed };
