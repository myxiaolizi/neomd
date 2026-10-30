/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：30 | 分组：日常任务 · 协作会议
 * id: retro-board | 命令: collab.retroBoard
 * 说明：在文末追加复盘四象限模板，含做得好、待改进、值得尝试与下一步行动。
 * 模式：append
 */
function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** 仅在文末追加，原文逐字保留；保证与上文之间隔一个空行 */
function appendBlock(raw, block) {
  const text = String(raw || '');
  if (!text.replace(/\s+$/, '')) return block;
  const trimmed = text.replace(/\s+$/, '');
  const tail = text.slice(trimmed.length);
  const blank = /\r?\n[ \t]*\r?\n/.test(tail);
  if (blank) return text + block;
  const nl = tail.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  return text + (tail.indexOf('\n') >= 0 ? nl : nl + nl) + block;
}

export default {
  id: 'retro-board',
  name: '复盘四象限',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.retroBoard',
      title: '插入做得好与待改进复盘四象限',
      run() {
        const md = api.getMarkdown() || '';
        const block = [
          '## 🔁 迭代复盘（' + todayIso() + '）',
          '',
          '- 复盘范围：',
          '- 参与人：',
          '',
          '### ✅ 做得好',
          '',
          '- ',
          '',
          '### ⚠️ 待改进',
          '',
          '- ',
          '',
          '### 💡 值得尝试',
          '',
          '- ',
          '',
          '### 🚀 下一步行动',
          '',
          '| 行动 | 负责人 | 截止 |',
          '| --- | --- | --- |',
          '|  |  |  |'
        ].join('\n');
        api.setMarkdown(appendBlock(md, block));
        api.notify('已插入 ' + todayIso() + ' 的复盘四象限模板', 'success');
      }
    });
  }
};
