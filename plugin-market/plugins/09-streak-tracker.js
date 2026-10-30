/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：09 | 分组：日常使用 · 时间与日志
 * id: streak-tracker | 命令: time.streak
 * 说明：从全文提取日期打卡记录，计算连续天数并生成打卡热力条。
 * 模式：section
 */
const BEGIN = '<!-- nm:streak-tracker -->';
const END = '<!-- /nm:streak-tracker -->';

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

function dayNumber(iso) {
  return Math.floor(Date.parse(iso + 'T00:00:00Z') / 86400000);
}

export default {
  id: 'streak-tracker',
  name: '连续打卡追踪',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'time.streak',
      title: '统计全文日期打卡并计算连续天数',
      run() {
        const md = api.getMarkdown() || '';
        const set = new Set();
        for (const line of bodyLines(stripSection(md))) {
          const dates = line.match(/\d{4}-\d{2}-\d{2}/g);
          if (!dates) continue;
          for (const d of dates) {
            const t = Date.parse(d + 'T00:00:00Z');
            if (!Number.isNaN(t)) set.add(d);
          }
        }
        if (set.size === 0) {
          api.notify('未找到 YYYY-MM-DD 格式的打卡日期，未生成区块', 'info');
          return;
        }
        const days = [...set].sort();
        const nums = days.map(dayNumber);
        let longest = 1;
        let run = 1;
        for (let i = 1; i < nums.length; i++) {
          if (nums[i] === nums[i - 1] + 1) {
            run += 1;
            if (run > longest) longest = run;
          } else if (nums[i] !== nums[i - 1]) {
            run = 1;
          }
        }
        // 当前连续：从最近日期往前数
        const last = nums[nums.length - 1];
        const numSet = new Set(nums);
        let current = 0;
        let cursor = last;
        while (numSet.has(cursor)) {
          current += 1;
          cursor -= 1;
        }
        const heat = [];
        for (let i = 6; i >= 0; i--) {
          heat.push(numSet.has(last - i) ? '■' : '□');
        }
        const rows = [];
        rows.push('## 🔥 连续打卡追踪');
        rows.push('');
        rows.push('- 打卡天数：' + days.length + ' 天');
        rows.push('- 当前连续：' + current + ' 天');
        rows.push('- 最长连续：' + longest + ' 天');
        rows.push('- 最近打卡：' + days[days.length - 1]);
        rows.push('- 近七天：' + heat.join(' ') + '（■ 已打卡 / □ 未打卡）');
        api.setMarkdown(upsertSection(md, rows.join('\n')));
        api.notify('已统计 ' + days.length + ' 天打卡，当前连续 ' + current + ' 天', 'success');
      }
    });
  }
};
