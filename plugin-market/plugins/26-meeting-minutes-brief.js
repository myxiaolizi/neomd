/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：26 | 分组：日常任务 · 协作会议
 * id: meeting-minutes-brief | 命令: collab.meetingMinutes
 * 说明：在文末追加带日期的会议纪要模板，含参会人、议题、决议与行动项表格。
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
  id: 'meeting-minutes-brief',
  name: '会议纪要简报',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.meetingMinutes',
      title: '插入含决议与行动项纪要模板',
      run() {
        const md = api.getMarkdown() || '';
        const day = todayIso();
        const block = [
          '## 🗓 会议纪要（' + day + '）',
          '',
          '| 项 | 内容 |',
          '| --- | --- |',
          '| 会议主题 |  |',
          '| 时间 | ' + day + ' 14:00–15:00 |',
          '| 主持人 |  |',
          '| 记录人 |  |',
          '| 参会人 |  |',
          '',
          '### 一、议题',
          '',
          '1. 议题一：',
          '2. 议题二：',
          '',
          '### 二、核心决议',
          '',
          '- 决议：',
          '  - 依据：',
          '',
          '### 三、行动项',
          '',
          '| 行动项 | 负责人 | 截止 | 状态 |',
          '| --- | --- | --- | --- |',
          '|  |  |  | 待开始 |',
          '',
          '### 四、待确认问题',
          '',
          '- '
        ].join('\n');
        api.setMarkdown(appendBlock(md, block));
        api.notify('已插入 ' + day + ' 的会议纪要模板', 'success');
      }
    });
  }
};
