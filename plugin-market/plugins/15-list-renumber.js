/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：15 | 分组：日常使用 · 写作与整理
 * id: list-renumber | 命令: writing.listRenumber
 * 说明：把连续有序列表的序号修正为从起始值递增的连续序列。
 * 模式：inplace
 */
function mapOutsideFence(md, visit) {
  const lines = String(md || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const out = new Array(lines.length);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out[i] = line;
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    } else if (m) {
      fence = m[1];
      out[i] = line;
    } else {
      out[i] = visit(line, i);
    }
  }
  return out.join('\n');
}

const OL_RE = /^(\s*)(\d+)([.)])(\s+)(.*)$/;

export default {
  id: 'list-renumber',
  name: '有序列表重编号',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'writing.listRenumber',
      title: '修正错乱的有序列表序号',
      run() {
        const md = api.getMarkdown() || '';
        // 按缩进层级维护计数器；遇到非列表行重置
        const counters = new Map();
        const lastIndent = { value: -1 };
        let fixed = 0;
        const next = mapOutsideFence(md, (line) => {
          const m = OL_RE.exec(line);
          if (!m) {
            if (line.trim() === '') {
              // 空行不打断列表（Markdown 松散列表允许）
              return line;
            }
            counters.clear();
            lastIndent.value = -1;
            return line;
          }
          const indent = m[1];
          const indentWidth = indent.replace(/\t/g, '    ').length;
          // 清理比当前更深的层级计数
          for (const key of [...counters.keys()]) {
            if (key > indentWidth) counters.delete(key);
          }
          // 该层级首个条目沿用原文序号作为起始值，后续条目逐条递增
          const value = counters.has(indentWidth) ? counters.get(indentWidth) + 1 : Number(m[2]);
          counters.set(indentWidth, value);
          lastIndent.value = indentWidth;
          const rebuilt = indent + value + m[3] + m[4] + m[5];
          if (rebuilt !== line) fixed += 1;
          return rebuilt;
        });
        if (fixed === 0) {
          api.notify('有序列表序号已连续，无需修改', 'info');
          return;
        }
        api.setMarkdown(next);
        api.notify('已修正 ' + fixed + ' 处有序列表序号', 'success');
      }
    });
  }
};
