/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：42 | 分组：协作 · 分派与交付
 * id: raci-matrix | 命令: collab.raci
 * 说明：插入 RACI 责任分工矩阵模板。
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
  id: 'raci-matrix',
  name: 'RACI 责任矩阵',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.raci',
      title: '插入 RACI 责任分工矩阵',
      run() {
        const md = api.getMarkdown() || '';
        const block = [
          '## 🧩 RACI 责任矩阵 · ' + todayIso(),
          '',
          '> R 负责执行 · A 最终批准 · C 需要咨询 · I 需要知会（每行有且仅有一个 A）',
          '',
          '| 工作项 | 产品 | 研发 | 测试 | 运维 |',
          '| --- | --- | --- | --- | --- |',
          '| 需求定义 | A/R | C | I | I |',
          '| 方案设计 | C | A/R | C | I |',
          '| 开发实现 | I | A/R | I | I |',
          '| 测试验收 | I | C | A/R | I |',
          '| 发布上线 | I | C | C | A/R |',
          '| 故障响应 | I | R | C | A |',
          '',
          '### 填写说明',
          '- 每个工作项必须有且仅有一个 A（最终批准人）；',
          '- R 可以多人，但要明确主责；',
          '- C 与 I 数量过多说明沟通成本偏高，需要收敛。',
          ''
        ].join('\n');
        api.setMarkdown(appendBlock(md, block));
        api.notify('已插入 RACI 责任矩阵（6 个工作项）', 'success');
      }
    });
  }
};
