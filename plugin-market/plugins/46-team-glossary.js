/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：46 | 分组：协作 · 分派与交付
 * id: team-glossary | 命令: collab.glossary
 * 说明：扫描「术语：定义」条目，去重排序生成团队术语表区块。
 * 模式：section
 */
const BEGIN = '<!-- nm:team-glossary -->';
const END = '<!-- /nm:team-glossary -->';

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

export default {
  id: 'team-glossary',
  name: '团队术语表',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.glossary',
      title: '汇总术语定义生成团队术语表',
      run() {
        const md = api.getMarkdown() || '';
        const map = new Map();
        for (const line of bodyLines(stripSection(md))) {
          if (/^#{1,6}\s/.test(line)) continue;
          const text = line.replace(/^\s*[-*+>]\s*/, '').replace(/^\s*\[[xX ]\]\s*/, '').trim();
          const m = /^([^：:|]{1,30})[：:]\s*(.{2,200})$/.exec(text);
          if (!m) continue;
          const term = m[1].trim();
          const def = m[2].trim();
          if (!term || !def) continue;
          if (map.has(term)) continue;
          map.set(term, def);
        }
        if (map.size === 0) {
          api.notify('未找到「术语：定义」形式的条目，未生成术语表', 'info');
          return;
        }
        const terms = [...map.keys()].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
        const cap = 50;
        const rows = ['## 📖 团队术语表', '', '| 术语 | 定义 |', '| --- | --- |'];
        for (const t of terms.slice(0, cap)) {
          rows.push('| ' + escapeCell(t) + ' | ' + escapeCell(map.get(t)) + ' |');
        }
        rows.push('');
        rows.push('- 共 ' + terms.length + ' 条术语');
        if (terms.length > cap) rows.push('- 超出 ' + cap + ' 条已截断');
        api.setMarkdown(upsertSection(md, rows.join('\n')));
        api.notify('已汇总 ' + terms.length + ' 条团队术语', 'success');
      }
    });
  }
};
