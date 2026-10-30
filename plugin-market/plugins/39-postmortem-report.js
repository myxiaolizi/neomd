/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：39 | 分组：协作 · 评审与复盘
 * id: postmortem-report | 命令: collab.postmortem
 * 说明：插入含时间线、根因与改进措施的故障复盘模板。
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
  id: 'postmortem-report',
  name: '故障复盘报告',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.postmortem',
      title: '插入含时间线根因复盘报告模板',
      run() {
        const md = api.getMarkdown() || '';
        const block = [
          '## 🧯 故障复盘报告 · ' + todayIso(),
          '',
          '### 故障概述',
          '| 项 | 值 |',
          '| --- | --- |',
          '| 故障等级 | P0 / P1 / P2 |',
          '| 影响时长 |  |',
          '| 影响范围 |  |',
          '| 发现方式 | 监控告警 / 用户反馈 |',
          '',
          '### 时间线',
          '| 时间 | 事件 |',
          '| --- | --- |',
          '| --:-- | 故障发生 |',
          '| --:-- | 监控告警 |',
          '| --:-- | 开始处理 |',
          '| --:-- | 恢复服务 |',
          '',
          '### 根因分析',
          '- 直接原因：',
          '- 根本原因：',
          '- 为何未被提前发现：',
          '',
          '### 影响范围',
          '- 受影响用户：',
          '- 受影响功能：',
          '- 数据影响：',
          '',
          '### 改进措施',
          '| 措施 | 负责人 | 期限 |',
          '| --- | --- | --- |',
          '|  |  |  |',
          '|  |  |  |',
          '',
          '### 经验沉淀',
          '- 做得好：',
          '- 待改进：',
          ''
        ].join('\n');
        api.setMarkdown(appendBlock(md, block));
        api.notify('已插入故障复盘模板（5 个部分）', 'success');
      }
    });
  }
};
