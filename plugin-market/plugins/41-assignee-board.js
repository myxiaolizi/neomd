/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：41 | 分组：协作 · 分派与交付
 * id: assignee-board | 命令: collab.assigneeBoard
 * 说明：按 @负责人 汇总任务，生成负责人看板区块。
 * 模式：section
 */
const BEGIN = '<!-- nm:assignee-board -->';
const END = '<!-- /nm:assignee-board -->';

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

/** 提取 @姓名（中文/英文/数字/下划线/短横线） */
function mentions(line) {
  const out = [];
  const re = /@([\u4e00-\u9fffA-Za-z0-9_-]{1,20})/g;
  let m = re.exec(line);
  while (m) {
    out.push(m[1]);
    m = re.exec(line);
  }
  return out;
}

export default {
  id: 'assignee-board',
  name: '负责人看板',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.assigneeBoard',
      title: '按负责人汇总任务看板',
      run() {
        const md = api.getMarkdown() || '';
        const people = new Map();
        for (const line of bodyLines(stripSection(md))) {
          const names = mentions(line);
          if (names.length === 0) continue;
          const isTask = /^\s*[-*+]\s+\[[xX ]\]\s+/.test(line);
          const isDone = /^\s*[-*+]\s+\[[xX]\]\s+/.test(line);
          const text = line
            .replace(/^\s*[-*+>]\s*/, '')
            .replace(/^\s*\[[xX ]\]\s*/, '')
            .replace(/\s+/g, ' ')
            .trim();
          for (const name of names) {
            if (!people.has(name)) people.set(name, { total: 0, open: 0, done: 0, samples: [] });
            const p = people.get(name);
            p.total += 1;
            if (isDone) p.done += 1;
            else if (isTask) p.open += 1;
            if (p.samples.length < 3 && text) p.samples.push(text);
          }
        }
        if (people.size === 0) {
          api.notify('未找到 @负责人 标记，未生成看板', 'info');
          return;
        }
        const names = [...people.keys()].sort((a, b) => people.get(b).total - people.get(a).total);
        const rows = ['## 👥 负责人看板', ''];
        rows.push('| 负责人 | 条目 | 未完成 | 已完成 |');
        rows.push('| --- | --- | --- | --- |');
        for (const n of names) {
          const p = people.get(n);
          rows.push('| @' + escapeCell(n) + ' | ' + p.total + ' | ' + p.open + ' | ' + p.done + ' |');
        }
        rows.push('');
        rows.push('### 每人前三条');
        for (const n of names.slice(0, 8)) {
          rows.push('- **@' + n + '**');
          for (const s of people.get(n).samples) rows.push('  - ' + escapeCell(s));
        }
        api.setMarkdown(upsertSection(md, rows.join('\n')));
        api.notify('已汇总 ' + people.size + ' 位负责人的任务', 'success');
      }
    });
  }
};
