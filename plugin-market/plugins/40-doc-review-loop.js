/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：40 | 分组：协作 · 评审与复盘
 * id: doc-review-loop | 命令: collab.docReview
 * 说明：为当前文档生成评审轮次与意见表区块。
 * 模式：section
 */
const BEGIN = '<!-- nm:doc-review-loop -->';
const END = '<!-- /nm:doc-review-loop -->';

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
  id: 'doc-review-loop',
  name: '文档评审轮次',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.docReview',
      title: '生成文档评审轮次与意见表',
      run() {
        const md = api.getMarkdown() || '';
        const title = api.getTitle() || '（未命名文档）';
        const lines = bodyLines(stripSection(md));
        if (lines.filter((l) => l.trim()).length === 0) {
          api.notify('文档为空，未生成评审表', 'info');
          return;
        }
        const heads = lines.filter((l) => /^##\s+/.test(l)).map((l) => l.replace(/^##\s+/, '').trim());
        const todos = lines.filter((l) => /^\s*[-*+]\s+\[\s*\]\s+/.test(l)).length;
        const chars = lines.join('').replace(/\s/g, '').length;
        const rows = ['## 🧾 文档评审轮次 · ' + title, ''];
        rows.push('| 项 | 值 |');
        rows.push('| --- | --- |');
        rows.push('| 评审对象 | ' + title + ' |');
        rows.push('| 二级章节 | ' + heads.length + ' 个 |');
        rows.push('| 未完成待办 | ' + todos + ' 项 |');
        rows.push('| 非空白字符 | ' + chars + ' |');
        rows.push('');
        rows.push('### 评审轮次');
        rows.push('');
        rows.push('| 轮次 | 评审人 | 意见摘要 | 结论 |');
        rows.push('| --- | --- | --- | --- |');
        rows.push('| 第 1 轮 |  |  | 待评审 |');
        rows.push('| 第 2 轮 |  |  | 待评审 |');
        rows.push('');
        rows.push('### 待确认章节');
        if (heads.length === 0) rows.push('- 文档暂无二级章节，建议先补齐结构');
        else for (const h of heads.slice(0, 8)) rows.push('- [ ] ' + h);
        api.setMarkdown(upsertSection(md, rows.join('\n')));
        api.notify('已生成评审表（' + heads.length + ' 个章节待评审）', 'success');
      }
    });
  }
};
