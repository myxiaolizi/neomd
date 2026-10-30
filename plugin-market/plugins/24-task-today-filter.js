/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：24 | 分组：日常任务 · 协作会议
 * id: task-today-filter | 命令: task.todayFocus
 * 说明：从全文未完成待办中筛出今天到期与无日期条目，汇总为今日聚焦区块。
 * 模式：section
 */
const BEGIN = '<!-- nm:task-today-filter -->';
const END = '<!-- /nm:task-today-filter -->';
const OPEN_RE = /^\s*[-*+]\s+\[\s*\]\s+/;
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
  id: 'task-today-filter',
  name: '今日待办聚焦',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'task.todayFocus',
      title: '筛出今日到期与无日期待办',
      run() {
        const md = api.getMarkdown() || '';
        const today = todayIso();
        const dueToday = [];
        const noDate = [];
        scanOutsideFence(withoutSection(md), (line) => {
          if (!OPEN_RE.test(line)) return;
          const text = line.replace(OPEN_RE, '').trim();
          if (!text) return;
          const date = isoOf(text);
          if (!date) noDate.push(text);
          else if (date === today) dueToday.push(text);
        });
        const total = dueToday.length + noDate.length;
        if (total === 0) {
          api.notify('没有今日到期或无日期的待办，未生成聚焦区块', 'info');
          return;
        }
        const out = ['## 🎯 今日待办聚焦', '', '聚焦于 ' + today + ' · 今日到期 ' + dueToday.length + ' 项 · 无日期 ' + noDate.length + ' 项'];
        let used = 0;
        if (dueToday.length) {
          out.push('', '### 今日到期（' + dueToday.length + ' 项）');
          for (const item of dueToday) {
            if (used >= MAX_ITEMS) break;
            out.push('- ' + item);
            used += 1;
          }
        }
        if (noDate.length) {
          if (used < MAX_ITEMS) out.push('', '### 未标注日期（' + noDate.length + ' 项）');
          for (const item of noDate) {
            if (used >= MAX_ITEMS) break;
            out.push('- ' + item);
            used += 1;
          }
        }
        if (total > used) out.push('', '> 其余 ' + (total - used) + ' 项已截断');
        api.setMarkdown(upsertSection(md, out.join('\n')));
        api.notify('今日聚焦 ' + total + ' 项待办（到期 ' + dueToday.length + ' · 无日期 ' + noDate.length + '）', 'success');
      }
    });
  }
};
