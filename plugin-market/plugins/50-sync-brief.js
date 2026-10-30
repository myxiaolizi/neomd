/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：50 | 分组：协作 · 分派与交付
 * id: sync-brief | 命令: collab.syncBrief
 * 说明：统计文档规模与待办变化，生成跨端同步简报区块。
 * 模式：section
 */
const BEGIN = '<!-- nm:sync-brief -->';
const END = '<!-- /nm:sync-brief -->';

function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function stripSection(text) {
  const t = String(text || '');
  const b = t.indexOf(BEGIN);
  const e = t.indexOf(END);
  const base = b >= 0 && e > b ? t.slice(0, b) + t.slice(e + END.length) : t;
  // 统一裁掉尾部空白，保证首次与二次执行的统计口径一致（否则行数会差 1）
  return base.replace(/\s+$/, '');
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

export default {
  id: 'sync-brief',
  name: '同步简报',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.syncBrief',
      title: '生成跨端同步变更简报',
      run() {
        const md = api.getMarkdown() || '';
        const lines = bodyLines(stripSection(md));
        if (lines.filter((l) => l.trim()).length === 0) {
          api.notify('文档为空，未生成同步简报', 'info');
          return;
        }
        const title = api.getTitle() || '（未命名文档）';
        const total = lines.length;
        const nonBlank = lines.filter((l) => l.trim()).length;
        const chars = lines.join('').replace(/\s/g, '').length;
        const heads = lines.filter((l) => /^#{1,6}\s/.test(l)).length;
        const done = lines.filter((l) => /^\s*[-*+]\s+\[[xX]\]\s+/.test(l)).length;
        const open = lines.filter((l) => /^\s*[-*+]\s+\[\s*\]\s+/.test(l)).length;
        const tables = lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length;
        const rows = ['## 🔄 同步简报 · ' + title, ''];
        rows.push('| 项 | 值 |');
        rows.push('| --- | --- |');
        rows.push('| 生成日期 | ' + todayIso() + ' |');
        rows.push('| 总行数 | ' + total + ' |');
        rows.push('| 有效行 | ' + nonBlank + ' |');
        rows.push('| 非空白字符 | ' + chars + ' |');
        rows.push('| 标题数 | ' + heads + ' |');
        rows.push('| 表格行 | ' + tables + ' |');
        rows.push('| 待办（完成 / 未完成） | ' + done + ' / ' + open + ' |');
        rows.push('');
        rows.push('### 跨端对齐要点');
        rows.push('- 本文档已包含完整结构，可在 Web、Windows PC 与 Android 端打开；');
        rows.push('- 同步前请确认无未保存冲突，冲突时以最新修改为准；');
        rows.push(open > 0 ? '- 仍有 ' + open + ' 项待办未完成，跨端继续推进时优先处理' : '- 待办已全部完成，可归档');
        api.setMarkdown(upsertSection(md, rows.join('\n')));
        api.notify('已生成同步简报（' + chars + ' 字符，' + heads + ' 个标题）', 'success');
      }
    });
  }
};
