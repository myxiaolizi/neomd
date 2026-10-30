/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：02 | 分组：日常使用 · 时间与日志
 * id: daily-review-sheet | 命令: daily.endReview
 * 说明：汇总待办完成情况，生成今日完成、遗留与明日计划三块复盘区块。
 * 模式：section
 */
const BEGIN = '<!-- nm:daily-review-sheet -->';
const END = '<!-- /nm:daily-review-sheet -->';

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

/** 跳过围栏代码块，收集行 */
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

function taskText(line) {
  return line.replace(/^\s*[-*+]\s+\[[xX ]\]\s*/, '').replace(/\s+/g, ' ').trim();
}

export default {
  id: 'daily-review-sheet',
  name: '日终复盘',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'daily.endReview',
      title: '生成今日完成与明日计划复盘',
      run() {
        const md = api.getMarkdown() || '';
        const lines = bodyLines(stripSection(md));
        const done = [];
        const open = [];
        for (const line of lines) {
          if (/^\s*[-*+]\s+\[[xX]\]\s+/.test(line)) done.push(taskText(line));
          else if (/^\s*[-*+]\s+\[\s*\]\s+/.test(line)) open.push(taskText(line));
        }
        if (done.length + open.length === 0) {
          api.notify('当前文档没有待办项，未生成复盘区块', 'info');
          return;
        }
        const cap = 8;
        const rows = [];
        rows.push('## 🧭 日终复盘 · ' + todayIso());
        rows.push('');
        rows.push('### 今日完成（' + done.length + ' 项）');
        if (done.length === 0) rows.push('- 暂无已完成事项');
        else for (const t of done.slice(0, cap)) rows.push('- ' + t);
        if (done.length > cap) rows.push('- …等 ' + done.length + ' 项');
        rows.push('');
        rows.push('### 遗留事项（' + open.length + ' 项）');
        if (open.length === 0) rows.push('- 无遗留，全部完成');
        else for (const t of open.slice(0, cap)) rows.push('- ' + t);
        if (open.length > cap) rows.push('- …等 ' + open.length + ' 项');
        rows.push('');
        rows.push('### 明日计划');
        rows.push('- 优先推进：' + (open[0] || '（待补充）'));
        rows.push('- 预计投入：待评估');
        const pct = done.length + open.length > 0 ? Math.round((done.length / (done.length + open.length)) * 100) : 0;
        api.setMarkdown(upsertSection(md, rows.join('\n')));
        api.notify('已完成 ' + done.length + ' 项，遗留 ' + open.length + ' 项（完成率 ' + pct + '%）', 'success');
      }
    });
  }
};
