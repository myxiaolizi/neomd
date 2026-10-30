/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：47 | 分组：协作 · 分派与交付
 * id: kickoff-brief | 命令: collab.kickoff
 * 说明：插入含目标、范围、里程碑与分工的项目启动简报模板。
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
  id: 'kickoff-brief',
  name: '项目启动简报',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.kickoff',
      title: '插入目标范围与里程碑启动简报',
      run() {
        const md = api.getMarkdown() || '';
        const title = api.getTitle() || '（未命名项目）';
        const block = [
          '## 🚩 项目启动简报 · ' + title,
          '',
          '> 启动日期：' + todayIso(),
          '',
          '### 背景与目标',
          '- 业务背景：',
          '- 成功标准（可度量）：',
          '',
          '### 范围边界',
          '| 类型 | 内容 |',
          '| --- | --- |',
          '| 本次要做 |  |',
          '| 本次不做 |  |',
          '| 依赖前提 |  |',
          '',
          '### 里程碑',
          '| 阶段 | 交付物 | 目标日期 |',
          '| --- | --- | --- |',
          '| 方案确定 |  |  |',
          '| 开发完成 |  |  |',
          '| 验收通过 |  |  |',
          '| 正式上线 |  |  |',
          '',
          '### 角色分工',
          '| 角色 | 人员 | 职责 |',
          '| --- | --- | --- |',
          '| 项目负责人 |  | 整体推进 |',
          '| 研发 |  | 实现与自测 |',
          '| 测试 |  | 质量把关 |',
          '',
          '### 沟通机制',
          '- 例行同步：每周一次',
          '- 决策记录：见决策记录区块',
          '- 风险升级：阻塞超过一天即升级',
          ''
        ].join('\n');
        api.setMarkdown(appendBlock(md, block));
        api.notify('已插入项目启动简报模板', 'success');
      }
    });
  }
};
