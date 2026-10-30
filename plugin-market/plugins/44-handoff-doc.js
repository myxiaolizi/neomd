/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：44 | 分组：协作 · 分派与交付
 * id: handoff-doc | 命令: collab.handoff
 * 说明：插入含状态、背景、进行中事项与后续待办的交接文档模板。
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
  id: 'handoff-doc',
  name: '交接文档模板',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.handoff',
      title: '插入含状态与待办交接文档',
      run() {
        const md = api.getMarkdown() || '';
        const title = api.getTitle() || '（未命名工作项）';
        const block = [
          '## 🤝 工作交接 · ' + title,
          '',
          '> 交接日期：' + todayIso(),
          '',
          '### 当前状态',
          '| 项 | 值 |',
          '| --- | --- |',
          '| 整体进度 | % |',
          '| 下一里程碑 |  |',
          '| 风险等级 | 低 / 中 / 高 |',
          '',
          '### 关键背景',
          '- 这件事为什么重要：',
          '- 历史决策与原因：',
          '- 相关文档与链接：',
          '',
          '### 进行中事项',
          '- [ ] ',
          '- [ ] ',
          '',
          '### 后续待办',
          '- [ ] ',
          '- [ ] ',
          '',
          '### 注意事项',
          '- 容易踩坑的地方：',
          '- 需要提前沟通的人：',
          '- 不要做的事：',
          '',
          '### 交接确认',
          '- 交出人：',
          '- 接收人：',
          '- 确认时间：',
          ''
        ].join('\n');
        api.setMarkdown(appendBlock(md, block));
        api.notify('已插入交接文档模板', 'success');
      }
    });
  }
};
