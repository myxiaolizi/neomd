/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：34 | 分组：协作 · 评审与复盘
 * id: qa-test-plan | 命令: collab.testPlan
 * 说明：插入含测试范围、环境与用例表的测试计划模板。
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
  id: 'qa-test-plan',
  name: '测试计划模板',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.testPlan',
      title: '插入含用例与范围测试计划模板',
      run() {
        const md = api.getMarkdown() || '';
        const title = api.getTitle() || '（未命名需求）';
        const block = [
          '## 🧪 测试计划 · ' + title,
          '',
          '> 编制日期：' + todayIso(),
          '',
          '### 测试范围',
          '- 覆盖功能：',
          '- 不覆盖范围：',
          '- 回归范围：',
          '',
          '### 测试环境',
          '| 项 | 值 |',
          '| --- | --- |',
          '| 环境 | 测试 / 预发 |',
          '| 端 | Web / Windows PC / Android |',
          '| 数据 | 脱敏测试数据 |',
          '',
          '### 测试用例',
          '| 编号 | 场景 | 步骤 | 预期结果 | 结果 |',
          '| --- | --- | --- | --- | --- |',
          '| TC-01 |  |  |  | 未执行 |',
          '| TC-02 |  |  |  | 未执行 |',
          '| TC-03 |  |  |  | 未执行 |',
          '',
          '### 通过标准',
          '- [ ] 阻塞级缺陷为 0',
          '- [ ] 严重级缺陷为 0',
          '- [ ] 一般级缺陷有明确排期',
          '',
          '### 结论',
          '- 测试负责人：',
          '- 结论：待填写',
          ''
        ].join('\n');
        api.setMarkdown(appendBlock(md, block));
        api.notify('已插入测试计划模板（含 3 条用例位）', 'success');
      }
    });
  }
};
