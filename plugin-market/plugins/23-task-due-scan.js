/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：23 | 分组：日常任务 · 协作会议
 * id: task-due-scan | 命令: task.dueScan
 * 说明：扫描待办中的日期表达式，生成按到期时间排序、分四档的截止看板区块。
 * 模式：section
 */
const BEGIN = '<!-- nm:task-due-scan -->';
const END = '<!-- /nm:task-due-scan -->';
const TODO_RE = /^\s*[-*+]\s+\[[ xX]\]\s+/;
const DONE_RE = /\[[xX]\]/;
const MAX_ITEMS = 50;

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** 提取行内日期：优先 ISO，其次「11月2日」与「11-02」 */
function isoOf(text) {
  const src = String(text || '');
  const full = /(\d{4})-(\d{2})-(\d{2})/.exec(src);
  if (full) return full[1] + '-' + full[2] + '-' + full[3];
  const year = String(new Date().getFullYear());
  const cn = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(src);
  if (cn) return year + '-' + pad2(Number(cn[1])) + '-' + pad2(Number(cn[2]));
  const short = /(^|[^\d-])(\d{1,2})-(\d{1,2})(?![\d-])/.exec(src);
  if (short) return year + '-' + pad2(Number(short[2])) + '-' + pad2(Number(short[3]));
  return '';
}

/** 去掉行内日期，避免与看板日期列重复 */
function stripDate(text) {
  return String(text || '')
    .replace(/\d{4}-\d{2}-\d{2}/g, '')
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*日/g, '')
    .replace(/(^|[^\d-])\d{1,2}-\d{1,2}(?![\d-])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s·,，。;；:：\-–—]+/, '')
    .replace(/[\s·,，。;；:：\-–—]+$/, '')
    .trim();
}

function parseIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** 相差天数：到期日减今天 */
function diffDays(fromIso, toIso) {
  const a = parseIso(fromIso);
  const b = parseIso(toIso);
  if (a === null || b === null) return 0;
  return Math.round((b - a) / 86400000);
}

function withoutSection(md) {
  const text = String(md || '').replace(/^\uFEFF/, '');
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b >= 0 && e > b) return text.slice(0, b) + text.slice(e + END.length);
  return text;
}

function upsertSection(md, block) {
  const text = String(md || '').replace(/^\uFEFF/, '');
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b >= 0 && e > b) {
    return text.slice(0, b + BEGIN.length) + '\n' + block.trim() + '\n' + text.slice(e);
  }
  const trimmed = text.replace(/\s+$/, '');
  return (trimmed ? trimmed + '\n\n' : '') + BEGIN + '\n' + block.trim() + '\n' + END + '\n';
}

function scanOutsideFence(md, visit) {
  const lines = String(md || '').split(/\r?\n/);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    visit(line, i);
  }
}

export default {
  id: 'task-due-scan',
  name: '待办截止日扫描',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'task.dueScan',
      title: '提取待办中的日期生成截止看板',
      run() {
        const md = api.getMarkdown() || '';
        const today = todayIso();
        const items = [];
        scanOutsideFence(withoutSection(md), (line) => {
          if (!TODO_RE.test(line)) return;
          const text = line.replace(TODO_RE, '').trim();
          if (!text) return;
          const date = isoOf(text);
          if (!date) return;
          items.push({ date, text: stripDate(text) || text, done: DONE_RE.test(line.replace(TODO_RE, '')) });
        });
        if (items.length === 0) {
          api.notify('待办中没有找到日期，未生成截止看板', 'info');
          return;
        }
        items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        const buckets = [
          { name: '已过期', rows: [] },
          { name: '今天', rows: [] },
          { name: '本周', rows: [] },
          { name: '以后', rows: [] }
        ];
        for (const item of items) {
          const gap = diffDays(today, item.date);
          const bucket = gap < 0 ? buckets[0] : gap === 0 ? buckets[1] : gap <= 7 ? buckets[2] : buckets[3];
          bucket.rows.push(item);
        }
        const out = ['## ⏰ 待办截止看板', '', '统计于 ' + today + ' · 共 ' + items.length + ' 项带日期待办'];
        let used = 0;
        for (const bucket of buckets) {
          if (used >= MAX_ITEMS || bucket.rows.length === 0) continue;
          out.push('', '### ' + bucket.name + '（' + bucket.rows.length + ' 项）');
          for (const row of bucket.rows) {
            if (used >= MAX_ITEMS) break;
            out.push('- ' + row.date + ' · ' + row.text + (row.done ? '（已完成）' : ''));
            used += 1;
          }
        }
        if (items.length > used) out.push('', '> 其余 ' + (items.length - used) + ' 项已截断');
        api.setMarkdown(upsertSection(md, out.join('\n')));
        api.notify('已按截止日期汇总 ' + items.length + ' 项待办', 'success');
      }
    });
  }
};
