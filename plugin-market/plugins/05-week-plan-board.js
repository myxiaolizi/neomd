/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：05 | 分组：日常使用 · 时间与日志
 * id: week-plan-board | 命令: time.weekPlan
 * 说明：插入本周三项目标与周一至周日的每日关键安排看板。
 * 模式：append
 */
function isoWeekRange() {
  const d = new Date();
  const day = (d.getDay() + 6) % 7;
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  const fmt = (x) => String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  return fmt(start) + ' ~ ' + fmt(end);
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
  id: 'week-plan-board',
  name: '本周计划看板',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'time.weekPlan',
      title: '插入本周目标与每日安排看板',
      run() {
        const md = api.getMarkdown() || '';
        const span = isoWeekRange();
        const block = [
          '## 📅 本周计划看板 · ' + span,
          '',
          '### 本周三项目标',
          '1. ',
          '2. ',
          '3. ',
          '',
          '### 每日关键安排',
          '',
          '| 日期 | 关键安排 | 预计投入 | 完成 |',
          '| --- | --- | --- | --- |',
          '| 周一 |  |  | [ ] |',
          '| 周二 |  |  | [ ] |',
          '| 周三 |  |  | [ ] |',
          '| 周四 |  |  | [ ] |',
          '| 周五 |  |  | [ ] |',
          '| 周六 |  |  | [ ] |',
          '| 周日 |  |  | [ ] |',
          '',
          '> 复盘要点：周五收尾时回填完成情况，并把未完成项转入下周。',
          ''
        ].join('\n');
        api.setMarkdown(appendBlock(md, block));
        api.notify('已插入 ' + span + ' 的本周计划看板', 'success');
      }
    });
  }
};
