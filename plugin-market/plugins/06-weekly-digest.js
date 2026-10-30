/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：06 | 分组：日常使用 · 时间与日志
 * id: weekly-digest | 命令: time.weeklyDigest
 * 说明：按标题结构与待办完成情况生成本周进展摘要区块。
 * 模式：section
 */
const BEGIN = '<!-- nm:weekly-digest -->';
const END = '<!-- /nm:weekly-digest -->';

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
  id: 'weekly-digest',
  name: '周报摘要',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'time.weeklyDigest',
      title: '按标题与待办生成本周进展摘要',
      run() {
        const md = api.getMarkdown() || '';
        const lines = bodyLines(stripSection(md));
        if (lines.filter((l) => l.trim()).length === 0) {
          api.notify('文档为空，未生成周报摘要', 'info');
          return;
        }
        let h2 = 0;
        let h3 = 0;
        let done = 0;
        let open = 0;
        let chars = 0;
        const topics = [];
        for (const line of lines) {
          if (/^##\s+/.test(line)) {
            h2 += 1;
            const t = line.replace(/^##\s+/, '').replace(/^[一二三四五六七八九十\d]+[、.]\s*/, '').trim();
            if (t) topics.push(t);
          } else if (/^###\s+/.test(line)) h3 += 1;
          if (/^\s*[-*+]\s+\[[xX]\]\s+/.test(line)) done += 1;
          else if (/^\s*[-*+]\s+\[\s*\]\s+/.test(line)) open += 1;
          chars += (line.replace(/[\s]/g, '') || '').length;
        }
        const total = done + open;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const rows = [];
        rows.push('## 📊 本周进展摘要');
        rows.push('');
        rows.push('| 指标 | 数值 |');
        rows.push('| --- | --- |');
        rows.push('| 二级章节 | ' + h2 + ' |');
        rows.push('| 三级小节 | ' + h3 + ' |');
        rows.push('| 待办完成 / 总数 | ' + done + ' / ' + total + ' |');
        rows.push('| 完成率 | ' + pct + '% |');
        rows.push('| 非空白字符 | ' + chars + ' |');
        rows.push('');
        rows.push('### 关键主题');
        if (topics.length === 0) rows.push('- 暂无二级标题，可先补充章节结构');
        else for (const t of topics.slice(0, 8)) rows.push('- ' + t);
        if (topics.length > 8) rows.push('- …等 ' + topics.length + ' 个主题');
        rows.push('');
        rows.push('### 下周建议');
        rows.push(open > 0 ? '- 优先清理 ' + open + ' 项未完成待办' : '- 待办已全部完成，可承接新目标');
        api.setMarkdown(upsertSection(md, rows.join('\n')));
        api.notify('已生成周报摘要（章节 ' + h2 + ' 个，待办完成率 ' + pct + '%）', 'success');
      }
    });
  }
};
