/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：43 | 分组：协作 · 分派与交付
 * id: contact-card | 命令: collab.contactCard
 * 说明：插入团队成员联系人卡片模板。
 * 模式：append
 */
function appendBlock(md, block) {
  const text = String(md || '');
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const body = block.split('\n').join(eol) + eol;
  if (!text) return body;
  const sep = /\r?\n$/.test(text) ? eol : eol + eol;
  return text + sep + body;
}

export default {
  id: 'contact-card',
  name: '联系人卡片',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.contactCard',
      title: '插入团队成员联系人卡片',
      run() {
        const md = api.getMarkdown() || '';
        const block = [
          '## 📇 联系人卡片',
          '',
          '### 成员 A',
          '| 项 | 值 |',
          '| --- | --- |',
          '| 姓名 |  |',
          '| 角色 |  |',
          '| 职责范围 |  |',
          '| 联系渠道 | 邮箱 / IM |',
          '| 时区 | UTC+8 |',
          '| 协作偏好 | 异步优先 / 会议优先 |',
          '',
          '### 成员 B',
          '| 项 | 值 |',
          '| --- | --- |',
          '| 姓名 |  |',
          '| 角色 |  |',
          '| 职责范围 |  |',
          '| 联系渠道 | 邮箱 / IM |',
          '| 时区 | UTC+8 |',
          '| 协作偏好 | 异步优先 / 会议优先 |',
          '',
          '> 提示：跨时区协作时优先标注重叠工作时段，能显著减少往返等待。',
          ''
        ].join('\n');
        api.setMarkdown(appendBlock(md, block));
        api.notify('已插入 2 张联系人卡片', 'success');
      }
    });
  }
};
