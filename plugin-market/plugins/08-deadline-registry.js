/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：08 | 分组：日常使用 · 时间与日志
 * id: deadline-registry | 命令: time.deadlines
 * 说明：扫描全文日期与截止条目，生成按日期排序的截止事项登记表。
 * 模式：section
 */
const BEGIN = '<!-- nm:deadline-registry -->';
const END = '<!-- /nm:deadline-registry -->';

function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function stripSection(text) {
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b < 0 || e <= b) return text;
  return (text.slice(0, b) + text.slice(e + END.length)).replace(/\n{3,}/g, '\n\n');
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

function bodyLines(md) {
  const out = [];
  let fence = null;
  for (const line of String(md || '').split(/\r?\n/)) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    out.push(line);
  }
  return out;
}

function escapeCell(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function daysBetween(a, b) {
  const ms = Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z');
  return Math.round(ms / 86400000);
}

export default {
  id: 'deadline-registry',
  name: '截止日期登记表',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'time.deadlines',
      title: '扫描全文日期与截止项生成登记表',
      run() {
        const md = api.getMarkdown() || '';
        const today = todayIso();
        const found = [];
        const seen = new Set();
        for (const line of bodyLines(stripSection(md))) {
          const dates = line.match(/\d{4}-\d{2}-\d{2}/g);
          if (!dates) continue;
          const text = line
            .replace(/^\s*[-*+>]\s*/, '')
            .replace(/^\s*\[[xX ]\]\s*/, '')
            .replace(/\d{4}-\d{2}-\d{2}/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          if (!text) continue;
          for (const d of dates) {
            const key = d + '|' + text;
            if (seen.has(key)) continue;
            seen.add(key);
            found.push({ date: d, text });
          }
        }
        if (found.length === 0) {
          api.notify('未找到含日期（YYYY-MM-DD）的条目，未生成登记表', 'info');
          return;
        }
        found.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        const cap = 50;
        const shown = found.slice(0, cap);
        let overdue = 0;
        let soon = 0;
        const rows = [];
        rows.push('## ⏳ 截止日期登记表');
        rows.push('');
        rows.push('| 日期 | 剩余 | 事项 |');
        rows.push('| --- | --- | --- |');
        for (const f of shown) {
          const diff = daysBetween(today, f.date);
          let label;
          if (diff < 0) {
            label = '已过期 ' + Math.abs(diff) + ' 天';
            overdue += 1;
          } else if (diff === 0) {
            label = '今天';
            soon += 1;
          } else {
            label = '剩 ' + diff + ' 天';
            if (diff <= 7) soon += 1;
          }
          rows.push('| ' + f.date + ' | ' + label + ' | ' + escapeCell(f.text) + ' |');
        }
        rows.push('');
        rows.push('- 合计：' + found.length + ' 项');
        rows.push('- 已过期：' + overdue + ' 项');
        rows.push('- 七天内到期：' + soon + ' 项');
        if (found.length > cap) rows.push('- 超出 ' + cap + ' 条已截断');
        api.setMarkdown(upsertSection(md, rows.join('\n')));
        api.notify('已登记 ' + found.length + ' 项截止事项（过期 ' + overdue + ' 项）', 'success');
      }
    });
  }
};
