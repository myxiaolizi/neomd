/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：45 | 分组：协作 · 分派与交付
 * id: status-report | 命令: collab.statusReport
 * 说明：基于待办与章节统计生成项目状态周报区块。
 * 模式：section
 */
const BEGIN = '<!-- nm:status-report -->';
const END = '<!-- /nm:status-report -->';

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

export default {
  id: 'status-report',
  name: '项目状态周报',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.statusReport',
      title: '生成进度风险与下一步状态周报',
      run() {
        const md = api.getMarkdown() || '';
        const lines = bodyLines(stripSection(md));
        if (lines.filter((l) => l.trim()).length === 0) {
          api.notify('文档为空，未生成状态周报', 'info');
          return;
        }
        const title = api.getTitle() || '项目';
        let done = 0;
        let open = 0;
        let risk = 0;
        const openItems = [];
        for (const line of lines) {
          if (/^\s*[-*+]\s+\[[xX]\]\s+/.test(line)) done += 1;
          else if (/^\s*[-*+]\s+\[\s*\]\s+/.test(line)) {
            open += 1;
            if (openItems.length < 5) {
              openItems.push(line.replace(/^\s*[-*+]\s+\[\s*\]\s+/, '').replace(/\s+/g, ' ').trim());
            }
          }
          if (/风险|阻塞|隐患/.test(line) && !/^#{1,6}\s/.test(line)) risk += 1;
        }
        const total = done + open;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const rows = ['## 📈 项目状态周报 · ' + title, ''];
        rows.push('> 生成日期：' + todayIso());
        rows.push('');
        rows.push('| 指标 | 数值 |');
        rows.push('| --- | --- |');
        rows.push('| 整体进度 | ' + pct + '%（' + done + '/' + total + '） |');
        rows.push('| 未完成待办 | ' + open + ' 项 |');
        rows.push('| 风险条目 | ' + risk + ' 项 |');
        rows.push('| 状态判定 | ' + (risk > 3 || pct < 30 ? '🔴 需关注' : pct >= 70 ? '🟢 正常' : '🟡 平稳') + ' |');
        rows.push('');
        rows.push('### 关键风险');
        if (risk === 0) rows.push('- 暂未识别到风险条目');
        else rows.push('- 文档中识别到 ' + risk + ' 条风险相关内容，详见风险登记表');
        rows.push('');
        rows.push('### 下一步计划');
        if (openItems.length === 0) rows.push('- 无未完成待办，可承接新目标');
        else for (const t of openItems) rows.push('- [ ] ' + t);
        api.setMarkdown(upsertSection(md, rows.join('\n')));
        api.notify('已生成状态周报（进度 ' + pct + '%，风险 ' + risk + ' 项）', 'success');
      }
    });
  }
};
