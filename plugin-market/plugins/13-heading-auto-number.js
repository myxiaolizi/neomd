/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：13 | 分组：日常使用 · 写作与整理
 * id: heading-auto-number | 命令: writing.headingNumber
 * 说明：为二级与三级标题补全或纠正多级序号（1. / 1.1）。
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

/** 去掉已有的多级序号前缀：1. / 1.1 / 1.1.1 / 一、 等 */
function stripNumber(text) {
  return text
    .replace(/^\s*\d+(?:\.\d+)*[.、]?\s+/, '')
    .replace(/^\s*[一二三四五六七八九十]+[、.]\s*/, '')
    .trim();
}

export default {
  id: 'heading-auto-number',
  name: '标题自动编号',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'writing.headingNumber',
      title: '为二三级标题添加多级序号',
      run() {
        const md = api.getMarkdown() || '';
        let h2 = 0;
        let h3 = 0;
        let changed = 0;
        const next = mapOutsideFence(md, (line) => {
          if (/^##\s+/.test(line) && !/^###\s+/.test(line)) {
            h2 += 1;
            h3 = 0;
            const clean = stripNumber(line.replace(/^##\s+/, ''));
            const out = '## ' + h2 + '. ' + clean;
            if (out !== line) changed += 1;
            return out;
          }
          if (/^###\s+/.test(line) && !/^####\s+/.test(line)) {
            if (h2 === 0) h2 = 1;
            h3 += 1;
            const clean = stripNumber(line.replace(/^###\s+/, ''));
            const out = '### ' + h2 + '.' + h3 + ' ' + clean;
            if (out !== line) changed += 1;
            return out;
          }
          return line;
        });
        if (h2 === 0 && h3 === 0) {
          api.notify('文档中没有二级或三级标题，无需编号', 'info');
          return;
        }
        if (changed === 0) {
          api.notify('标题编号已规范，无需修改', 'info');
          return;
        }
        api.setMarkdown(next);
        api.notify('已为 ' + h2 + ' 个二级、' + h3 + ' 个三级标题规范化编号', 'success');
      }
    });
  }
};
