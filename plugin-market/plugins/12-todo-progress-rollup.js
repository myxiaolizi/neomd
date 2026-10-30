/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：12 | 分组：日常使用 · 写作与整理
 * id: todo-progress-rollup | 命令: writing.todoProgress
 * 说明：统计全文待办完成情况并生成完成率进度条区块。
 * 模式：section
 */
const BEGIN = '<!-- nm:todo-progress-rollup -->';
const END = '<!-- /nm:todo-progress-rollup -->';

/** 有则替换区块内容，无则追加到文末 */
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

/** 跳过围栏代码块，逐行回调 */
function scanOutsideFence(md, visit) {
  const lines = String(md || '').split(/\r?\n/);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    visit(line, i);
  }
}

export default {
  id: 'todo-progress-rollup',
  name: '待办进度条',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'writing.todoProgress',
      title: '统计待办完成率并生成进度条',
      run() {
        const md = api.getMarkdown() || '';
        let done = 0;
        let open = 0;
        scanOutsideFence(md, (line) => {
          if (/^\s*[-*+]\s+\[[xX]\]\s+/.test(line)) done += 1;
          else if (/^\s*[-*+]\s+\[\s*\]\s+/.test(line)) open += 1;
        });
        const total = done + open;
        if (total === 0) {
          api.notify('当前文档没有待办项，未生成进度区块', 'info');
          return;
        }
        const width = 12;
        const filled = Math.round((done / total) * width);
        const pct = Math.round((done / total) * 100);
        const block = [
          '## ✅ 待办进度',
          '',
          '`' + '█'.repeat(filled) + '░'.repeat(width - filled) + '` ' + pct + '%',
          '',
          '- 已完成：' + done,
          '- 未完成：' + open,
          '- 合计：' + total
        ].join('\n');
        api.setMarkdown(upsertSection(md, block));
        api.notify('待办完成率 ' + pct + '%（' + done + '/' + total + '）', 'success');
      }
    });
  }
};
