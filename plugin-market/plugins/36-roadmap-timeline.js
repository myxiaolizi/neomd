/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：36 | 分组：协作 · 评审与复盘
 * id: roadmap-timeline | 命令: collab.roadmap
 * 说明：根据全文季度与阶段目标，生成按时间排序的路线图时间线。
 * 模式：section
 */
const BEGIN = '<!-- nm:roadmap-timeline -->';
const END = '<!-- /nm:roadmap-timeline -->';

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

/** 提取季度标记：2026Q1 / 2026 Q1 / Q1 2026 / 2026 年第一季度 */
function quarterOf(text) {
  let m = /(\d{4})\s*[-/]?\s*Q([1-4])/i.exec(text);
  if (m) return { year: Number(m[1]), q: Number(m[2]) };
  m = /Q([1-4])\s*[-/]?\s*(\d{4})/i.exec(text);
  if (m) return { year: Number(m[2]), q: Number(m[1]) };
  const cn = /(\d{4})\s*年\s*第?([一二三四1-4])\s*季度/.exec(text);
  if (cn) {
    const map = { 一: 1, 二: 2, 三: 3, 四: 4 };
    return { year: Number(cn[1]), q: map[cn[2]] || Number(cn[2]) };
  }
  return null;
}

function currentQuarter() {
  const d = new Date();
  return { year: d.getFullYear(), q: Math.floor(d.getMonth() / 3) + 1 };
}

export default {
  id: 'roadmap-timeline',
  name: '路线图时间线',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.roadmap',
      title: '按季度生成路线图时间线',
      run() {
        const md = api.getMarkdown() || '';
        const now = currentQuarter();
        const nowKey = now.year * 4 + (now.q - 1);
        const items = [];
        const seen = new Set();
        for (const line of bodyLines(stripSection(md))) {
          const q = quarterOf(line);
          if (!q) continue;
          const text = line
            .replace(/^\s*[-*+>]\s*/, '')
            .replace(/^\s*\[[xX ]\]\s*/, '')
            .replace(/\s+/g, ' ')
            .trim();
          if (text.length < 2) continue;
          const key = q.year + 'Q' + q.q + '|' + text;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({ year: q.year, q: q.q, text, order: q.year * 4 + (q.q - 1) });
        }
        if (items.length === 0) {
          api.notify('未找到季度标记（如 2026Q1、2026 年第一季度），未生成路线图', 'info');
          return;
        }
        items.sort((a, b) => (a.order - b.order) || (a.text < b.text ? -1 : 1));
        const rows = ['## 🗺️ 路线图时间线', ''];
        const cap = 40;
        for (const it of items.slice(0, cap)) {
          const isNow = it.order === nowKey;
          const isPast = it.order < nowKey;
          const mark = isNow ? ' ← 当前' : isPast ? ' · 已过' : '';
          rows.push('- **' + it.year + ' Q' + it.q + '** ' + it.text + mark);
        }
        rows.push('');
        rows.push('- 阶段数：' + items.length);
        rows.push('- 当前阶段：' + now.year + ' Q' + now.q);
        if (items.length > cap) rows.push('- 超出 ' + cap + ' 条已截断');
        api.setMarkdown(upsertSection(md, rows.join('\n')));
        api.notify('已生成 ' + items.length + ' 个阶段的路线图', 'success');
      }
    });
  }
};
