/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：16 | 分组：日常使用 · 写作与整理
 * id: blank-line-sweep | 命令: writing.blankSweep
 * 说明：压缩连续空行、清除行尾空格，并移除文末多余空行。
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

export default {
  id: 'blank-line-sweep',
  name: '空行与行尾清理',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'writing.blankSweep',
      title: '压缩连续空行并清除行尾空格',
      run() {
        const md = api.getMarkdown() || '';
        if (!md) {
          api.notify('文档为空，无需清理', 'info');
          return;
        }
        let trimmedCount = 0;
        const step1 = mapOutsideFence(md, (line) => {
          const cleaned = line.replace(/[ \t]+$/, '');
          if (cleaned !== line) trimmedCount += 1;
          return cleaned;
        });
        // 压缩连续空行为单行，并去掉文末空行
        const before = step1.split('\n');
        const out = [];
        let blankRun = 0;
        let collapsed = 0;
        for (const line of before) {
          if (line.trim() === '') {
            blankRun += 1;
            if (blankRun > 1) {
              collapsed += 1;
              continue;
            }
            out.push('');
          } else {
            blankRun = 0;
            out.push(line);
          }
        }
        while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
        const next = out.join('\n') + (out.length > 0 ? '\n' : '');
        if (next === md) {
          api.notify('空行与行尾已规范，无需修改', 'info');
          return;
        }
        api.setMarkdown(next);
        api.notify('已清理 ' + trimmedCount + ' 处行尾空格、' + collapsed + ' 行多余空行', 'success');
      }
    });
  }
};
