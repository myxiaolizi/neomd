/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：25 | 分组：日常任务 · 协作会议
 * id: checklist-template | 命令: task.checklistTpl
 * 说明：在文末追加一份带日期的发布前检查清单，覆盖校对、链接、格式与权限。
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
  id: 'checklist-template',
  name: '检查清单模板',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'task.checklistTpl',
      title: '插入发布前检查清单模板',
      run() {
        const md = api.getMarkdown() || '';
        const title = String(api.getTitle() || '').trim();
        const block = [
          '## ✅ 发布前检查清单（' + todayIso() + '）',
          '',
          title ? '> 适用文档：' + title : '> 适用文档：当前文档',
          '',
          '### 一、内容校对',
          '',
          '- [ ] 标题与正文无错别字、无占位符',
          '- [ ] 数字、日期与版本号已核对',
          '- [ ] 前后结论与数据一致',
          '',
          '### 二、链接检查',
          '',
          '- [ ] 所有外链可正常打开',
          '- [ ] 站内链接指向正确文档',
          '- [ ] 图片与附件引用未失效',
          '',
          '### 三、附件与格式',
          '',
          '- [ ] 附件已上传且协作者可读',
          '- [ ] 表格、代码块渲染正常',
          '- [ ] 标题层级与目录一致',
          '',
          '### 四、权限与分享',
          '',
          '- [ ] 分享范围符合预期',
          '- [ ] 敏感信息已脱敏',
          '- [ ] 协作者已确认可见'
        ].join('\n');
        api.setMarkdown(appendBlock(md, block));
        api.notify('已插入发布前检查清单模板', 'success');
      }
    });
  }
};
