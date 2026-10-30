/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：07 | 分组：日常使用 · 时间与日志
 * id: month-archive | 命令: time.monthArchive
 * 说明：插入本月归档与清理检查清单。
 * 模式：append
 */
function monthLabel() {
  const d = new Date();
  return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月';
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
  id: 'month-archive',
  name: '月度归档清单',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'time.monthArchive',
      title: '插入本月归档与清理检查清单',
      run() {
        const md = api.getMarkdown() || '';
        const block = [
          '## 🗂️ 月度归档清单 · ' + monthLabel(),
          '',
          '### 一、备份',
          '- [ ] 导出本月全部笔记为 Markdown 压缩包',
          '- [ ] 确认云端同步已完成且无冲突',
          '- [ ] 备份关键附件与图片目录',
          '',
          '### 二、归档',
          '- [ ] 已完结项目笔记移入归档目录',
          '- [ ] 更新项目索引与目录页',
          '- [ ] 关闭本月已完成的长期任务',
          '',
          '### 三、清理',
          '- [ ] 删除临时草稿与重复笔记',
          '- [ ] 合并碎片化笔记',
          '- [ ] 统一标签命名',
          '',
          '### 四、复盘',
          '- [ ] 填写本月完成率与关键产出',
          '- [ ] 记录三个做得好的地方',
          '- [ ] 记录三个需要改进的地方',
          '',
          '### 五、下月目标',
          '- [ ] 明确下月三件最重要的事',
          '',
          '> 归档完成后请更新仓库根目录的月度索引，避免下次找不到。',
          ''
        ].join('\n');
        api.setMarkdown(appendBlock(md, block));
        api.notify('已插入 ' + monthLabel() + ' 的归档检查清单', 'success');
      }
    });
  }
};
