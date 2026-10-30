/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：31 | 分组：协作 · 评审与复盘
 * id: review-checklist-code | 命令: collab.reviewChecklist
 * 说明：插入面向代码评审的检查清单。
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
  id: 'review-checklist-code',
  name: '代码评审清单',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.reviewChecklist',
      title: '插入代码评审检查清单',
      run() {
        const md = api.getMarkdown() || '';
        const block = [
          '## 🔍 代码评审清单 · ' + todayIso(),
          '',
          '### 正确性',
          '- [ ] 逻辑与需求一致，边界条件已处理',
          '- [ ] 异常路径有明确处理，不会静默失败',
          '- [ ] 并发与幂等性已考虑',
          '',
          '### 可读性',
          '- [ ] 命名清晰，函数职责单一',
          '- [ ] 复杂逻辑有注释说明「为什么」',
          '- [ ] 无重复代码与死代码',
          '',
          '### 测试',
          '- [ ] 新增逻辑有对应用例',
          '- [ ] 已有用例未被破坏',
          '- [ ] 失败路径有覆盖',
          '',
          '### 安全',
          '- [ ] 无敏感信息硬编码',
          '- [ ] 输入已校验，无注入风险',
          '- [ ] 权限校验未被绕过',
          '',
          '### 性能',
          '- [ ] 无 N+1 查询与无谓循环',
          '- [ ] 大对象/大数据量场景已评估',
          '',
          '### 评审结论',
          '- [ ] 通过',
          '- [ ] 需修改后重审',
          '- [ ] 需补充测试',
          ''
        ].join('\n');
        api.setMarkdown(appendBlock(md, block));
        api.notify('已插入代码评审检查清单（5 个维度）', 'success');
      }
    });
  }
};
