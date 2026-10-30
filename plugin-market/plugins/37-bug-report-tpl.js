/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：37 | 分组：协作 · 评审与复盘
 * id: bug-report-tpl | 命令: collab.bugReport
 * 说明：插入含复现步骤的缺陷报告模板。
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
  id: 'bug-report-tpl',
  name: '缺陷报告模板',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.bugReport',
      title: '插入含复现步骤缺陷报告模板',
      run() {
        const md = api.getMarkdown() || '';
        const block = [
          '## 🐞 缺陷报告 · ' + todayIso(),
          '',
          '### 基本信息',
          '| 项 | 值 |',
          '| --- | --- |',
          '| 缺陷标题 |  |',
          '| 严重程度 | 阻塞 / 严重 / 一般 / 轻微 |',
          '| 复现概率 | 必现 / 偶现 |',
          '| 发现版本 |  |',
          '| 环境 | Web / Windows PC / Android |',
          '',
          '### 复现步骤',
          '1. ',
          '2. ',
          '3. ',
          '',
          '### 预期结果',
          '- ',
          '',
          '### 实际结果',
          '- ',
          '',
          '### 附件与日志',
          '- 截图：',
          '- 日志片段：',
          '',
          '```text',
          '（粘贴关键错误日志）',
          '```',
          '',
          '### 初步定位',
          '- 可疑改动：',
          '- 关联提交 / 需求：',
          ''
        ].join('\n');
        api.setMarkdown(appendBlock(md, block));
        api.notify('已插入缺陷报告模板', 'success');
      }
    });
  }
};
