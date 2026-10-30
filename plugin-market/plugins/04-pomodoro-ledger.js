/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：04 | 分组：日常使用 · 时间与日志
 * id: pomodoro-ledger | 命令: time.pomodoroLedger
 * 说明：扫描全文番茄打卡记录，汇总为台账表格并统计次数。
 * 模式：section
 */
const BEGIN = '<!-- nm:pomodoro-ledger -->';
const END = '<!-- /nm:pomodoro-ledger -->';

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
  const lines = String(md || '').split(/\r?\n/);
  let fence = null;
  for (const line of lines) {
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

export default {
  id: 'pomodoro-ledger',
  name: '番茄钟台账',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'time.pomodoroLedger',
      title: '汇总全文番茄打卡为台账表',
      run() {
        const md = api.getMarkdown() || '';
        const records = [];
        for (const line of bodyLines(stripSection(md))) {
          if (!/🍅|番茄/.test(line)) continue;
          const time = /(\d{1,2}:\d{2})/.exec(line);
          const clean = line.replace(/^\s*[-*+>]\s*/, '').replace(/^\s*\[[xX ]\]\s*/, '').replace(/\s+/g, ' ').trim();
          if (clean.length < 2) continue;
          records.push({ time: time ? time[1] : '—', text: clean });
        }
        if (records.length === 0) {
          api.notify('未找到番茄打卡记录（可用「番茄专注」类插件先打卡）', 'info');
          return;
        }
        const cap = 50;
        const shown = records.slice(0, cap);
        const rows = [];
        rows.push('## 🍅 番茄钟台账');
        rows.push('');
        rows.push('| 序号 | 时间 | 记录 |');
        rows.push('| --- | --- | --- |');
        shown.forEach((r, i) => {
          rows.push('| ' + (i + 1) + ' | ' + escapeCell(r.time) + ' | ' + escapeCell(r.text) + ' |');
        });
        rows.push('');
        rows.push('- 打卡次数：' + records.length + ' 次');
        rows.push('- 折算专注时长：' + records.length * 25 + ' 分钟');
        if (records.length > cap) rows.push('- 超出 ' + cap + ' 条已截断，其余 ' + (records.length - cap) + ' 条未展示');
        api.setMarkdown(upsertSection(md, rows.join('\n')));
        api.notify('已汇总 ' + records.length + ' 次番茄打卡', 'success');
      }
    });
  }
};
