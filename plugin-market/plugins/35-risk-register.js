/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：35 | 分组：协作 · 评审与复盘
 * id: risk-register | 命令: collab.riskRegister
 * 说明：扫描全文风险条目，生成含等级与应对措施的风险登记表。
 * 模式：section
 */
const BEGIN = '<!-- nm:risk-register -->';
const END = '<!-- /nm:risk-register -->';

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

function levelOf(text) {
  if (/高|严重|阻塞|P0/.test(text)) return 0;
  if (/中|P1/.test(text)) return 1;
  return 2;
}

export default {
  id: 'risk-register',
  name: '风险登记表',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.riskRegister',
      title: '汇总风险条目生成登记表',
      run() {
        const md = api.getMarkdown() || '';
        const found = [];
        const seen = new Set();
        for (const line of bodyLines(stripSection(md))) {
          if (!/风险|隐患|阻塞/.test(line)) continue;
          if (/^#{1,6}\s/.test(line)) continue;
          const text = line
            .replace(/^\s*[-*+>]\s*/, '')
            .replace(/^\s*\[[xX ]\]\s*/, '')
            .replace(/\s+/g, ' ')
            .trim();
          if (text.length < 3) continue;
          if (seen.has(text)) continue;
          seen.add(text);
          found.push({ text, level: levelOf(text) });
        }
        if (found.length === 0) {
          api.notify('未找到风险相关条目，未生成登记表', 'info');
          return;
        }
        found.sort((a, b) => a.level - b.level);
        const cap = 40;
        const levelName = ['高', '中', '低'];
        const rows = ['## ⚠️ 风险登记表', '', '| 等级 | 风险描述 | 影响 | 应对措施 | 负责人 |', '| --- | --- | --- | --- | --- |'];
        for (const f of found.slice(0, cap)) {
          rows.push('| ' + levelName[f.level] + ' | ' + escapeCell(f.text) + ' | 待评估 | 待制定 | 待指派 |');
        }
        rows.push('');
        rows.push('- 合计：' + found.length + ' 项');
        rows.push('- 高等级：' + found.filter((x) => x.level === 0).length + ' 项');
        if (found.length > cap) rows.push('- 超出 ' + cap + ' 条已截断');
        api.setMarkdown(upsertSection(md, rows.join('\n')));
        api.notify('已登记 ' + found.length + ' 项风险', 'success');
      }
    });
  }
};
