/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：32 | 分组：协作 · 评审与复盘
 * id: pr-description | 命令: collab.prDescription
 * 说明：插入含背景、改动、影响、测试与回滚的变更说明模板。
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
  id: 'pr-description',
  name: '变更说明模板',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.prDescription',
      title: '生成含背景与测试的变更说明模板',
      run() {
        const md = api.getMarkdown() || '';
        const title = api.getTitle() || '（未命名变更）';
        const block = [
          '## 🔀 变更说明 · ' + title,
          '',
          '> 提交日期：' + todayIso(),
          '',
          '### 背景',
          '- 为什么要做这次改动：',
          '- 关联需求 / 缺陷：',
          '',
          '### 改动内容',
          '- [ ] ',
          '- [ ] ',
          '',
          '### 影响范围',
          '| 模块 | 影响 | 风险 |',
          '| --- | --- | --- |',
          '| 前端 |  | 低 |',
          '| 接口 |  | 低 |',
          '| 数据库 |  | 低 |',
          '',
          '### 测试方式',
          '- [ ] 单元测试：',
          '- [ ] 手工验证路径：',
          '- [ ] 回归范围：',
          '',
          '### 回滚方案',
          '- 回滚步骤：',
          '- 数据兼容性：',
          ''
        ].join('\n');
        api.setMarkdown(appendBlock(md, block));
        api.notify('已插入变更说明模板（5 个部分）', 'success');
      }
    });
  }
};
