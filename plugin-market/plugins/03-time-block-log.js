/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：03 | 分组：日常使用 · 时间与日志
 * id: time-block-log | 命令: time.blockLog
 * 说明：插入按小时划分的今日时间块规划表。
 * 模式：append
 */
function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function appendBlock(md, block) {
  const text = String(md || '');
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const body = block.split('\n').join(eol) + eol;
  if (!text) return body;
  const sep = /\r?\n$/.test(text) ? eol : eol + eol;
  return text + sep + body;
}

export default {
  id: 'time-block-log',
  name: '时间块规划',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'time.blockLog',
      title: '插入今日分时段时间块规划表',
      run() {
        const md = api.getMarkdown() || '';
        const today = todayIso();
        const rows = [
          '## ⏱️ 时间块规划 · ' + today,
          '',
          '| 时间段 | 计划事项 | 专注 | 完成 |',
          '| --- | --- | --- | --- |',
          '| 09:00 - 10:00 | 深度工作（第一块） | ⭐ | [ ] |',
          '| 10:00 - 11:00 | 深度工作（第二块） | ⭐ | [ ] |',
          '| 11:00 - 12:00 | 沟通与邮件处理 |  | [ ] |',
          '| 14:00 - 15:00 | 会议与协作 |  | [ ] |',
          '| 15:00 - 16:30 | 深度工作（第三块） | ⭐ | [ ] |',
          '| 16:30 - 18:00 | 收尾与明日计划 |  | [ ] |',
          '',
          '> 原则：深度工作块内关闭通知，单块不超过 90 分钟。',
          ''
        ].join('\n');
        api.setMarkdown(appendBlock(md, rows));
        api.notify('已插入 ' + today + ' 的 6 段时间块规划', 'success');
      }
    });
  }
};
