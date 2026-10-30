/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：10 | 分组：日常使用 · 时间与日志
 * id: today-focus-brief | 命令: time.todayFocus
 * 说明：从全文未完成待办中提炼今日三项聚焦任务。
 * 模式：section
 */
const BEGIN = '<!-- nm:today-focus-brief -->';
const END = '<!-- /nm:today-focus-brief -->';

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

/** 优先级：P0 最高 */
function priorityOf(line) {
  if (/\bP0\b/.test(line) || /紧急/.test(line)) return 0;
  if (/\bP1\b/.test(line) || /重要/.test(line)) return 1;
  if (/\bP2\b/.test(line)) return 2;
  return 3;
}

function cleanTask(line) {
  return line
    .replace(/^\s*[-*+]\s+\[\s*\]\s*/, '')
    .replace(/\bP[0-2]\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export default {
  id: 'today-focus-brief',
  name: '今日聚焦简报',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'time.todayFocus',
      title: '从待办中提炼今日三项聚焦任务',
      run() {
        const md = api.getMarkdown() || '';
        const today = todayIso();
        const tasks = [];
        let idx = 0;
        for (const line of bodyLines(stripSection(md))) {
          idx += 1;
          if (!/^\s*[-*+]\s+\[\s*\]\s+/.test(line)) continue;
          const text = cleanTask(line);
          if (!text) continue;
          tasks.push({ text, pr: priorityOf(line), idx });
        }
        if (tasks.length === 0) {
          api.notify('当前文档没有未完成待办，未生成聚焦简报', 'info');
          return;
        }
        tasks.sort((a, b) => (a.pr - b.pr) || (a.idx - b.idx));
        const top = tasks.slice(0, 3);
        const rows = [];
        rows.push('## 🎯 今日聚焦简报 · ' + today);
        rows.push('');
        rows.push('> 只做三件最重要的事，其余延后。');
        rows.push('');
        top.forEach((t, i) => {
          const level = ['P0 最高', 'P1 重要', 'P2 常规', '未分级'][t.pr];
          rows.push('### ' + (i + 1) + '. ' + t.text);
          rows.push('');
          rows.push('- 优先级：' + level);
          rows.push('- 预计耗时：待评估');
          rows.push('- 完成标准：' + t.text + ' 已交付并可验证');
          rows.push('');
        });
        rows.push('- 待办总量：' + tasks.length + ' 项，其余 ' + Math.max(0, tasks.length - top.length) + ' 项顺延');
        api.setMarkdown(upsertSection(md, rows.join('\n').trim()));
        api.notify('已从 ' + tasks.length + ' 项待办中提炼 ' + top.length + ' 项今日聚焦', 'success');
      }
    });
  }
};
