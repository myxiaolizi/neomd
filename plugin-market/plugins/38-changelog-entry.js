/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：38 | 分组：协作 · 评审与复盘
 * id: changelog-entry | 命令: collab.changelogEntry
 * 说明：把全文新增、修复、优化类条目整理成标准更新日志区块。
 * 模式：section
 */
const BEGIN = '<!-- nm:changelog-entry -->';
const END = '<!-- /nm:changelog-entry -->';

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

const CATS = [
  { key: 'Added', re: /新增|添加|新功能|feature/i },
  { key: 'Fixed', re: /修复|修正|fix|bug/i },
  { key: 'Changed', re: /优化|调整|重构|改进|change|refactor/i },
  { key: 'Docs', re: /文档|说明|docs?/i }
];

export default {
  id: 'changelog-entry',
  name: '更新日志条目',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.changelogEntry',
      title: '按提交项生成版本变更条目',
      run() {
        const md = api.getMarkdown() || '';
        const title = api.getTitle() || '';
        const versionMatch = /(\d+\.\d+\.\d+)/.exec(title) || /(\d+\.\d+\.\d+)/.exec(md);
        const version = versionMatch ? versionMatch[1] : '未指定版本';
        const buckets = { Added: [], Fixed: [], Changed: [], Docs: [] };
        const seen = new Set();
        for (const line of bodyLines(stripSection(md))) {
          const isBullet = /^\s*[-*+]\s+/.test(line);
          if (!isBullet) continue;
          const text = line
            .replace(/^\s*[-*+]\s+/, '')
            .replace(/^\s*\[[xX ]\]\s*/, '')
            .replace(/\s+/g, ' ')
            .trim();
          if (text.length < 2) continue;
          if (seen.has(text)) continue;
          let placed = false;
          for (const c of CATS) {
            if (c.re.test(text)) {
              buckets[c.key].push(text);
              seen.add(text);
              placed = true;
              break;
            }
          }
          if (!placed) {
            buckets.Changed.push(text);
            seen.add(text);
          }
        }
        const total = CATS.reduce((s, c) => s + buckets[c.key].length, 0);
        if (total === 0) {
          api.notify('未找到可归类的条目，未生成更新日志区块', 'info');
          return;
        }
        const rows = ['## 📦 更新日志 · ' + version, ''];
        const cap = 15;
        for (const c of CATS) {
          const list = buckets[c.key];
          if (list.length === 0) continue;
          rows.push('### ' + c.key);
          rows.push('');
          for (const t of list.slice(0, cap)) rows.push('- ' + t);
          if (list.length > cap) rows.push('- …等 ' + list.length + ' 条');
          rows.push('');
        }
        rows.push('- 合计 ' + total + ' 条变更');
        api.setMarkdown(upsertSection(md, rows.join('\n').trim()));
        api.notify('已整理 ' + total + ' 条变更（版本 ' + version + '）', 'success');
      }
    });
  }
};
