/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：18 | 分组：日常使用 · 写作与整理
 * id: divider-normalize | 命令: writing.dividerNormalize
 * 说明：把各类分隔线写法统一为标准三短横，并清理多余空行。
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

/** 分隔线：整行只有 >=3 个相同符号（- * _ =）允许夹空格 */
const DIVIDER_RE = /^\s{0,3}([-*_=])(?:\s*\1){2,}\s*$/;

export default {
  id: 'divider-normalize',
  name: '分隔线规范化',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'writing.dividerNormalize',
      title: '统一分散的分隔线写法',
      run() {
        const md = api.getMarkdown() || '';
        if (!md) {
          api.notify('文档为空，无需规范分隔线', 'info');
          return;
        }
        let fixed = 0;
        const step1 = mapOutsideFence(md, (line) => {
          if (!DIVIDER_RE.test(line)) return line;
          if (line === '---') return line;
          fixed += 1;
          return '---';
        });
        // 分隔线前后各保留一个空行，避免粘连
        const lines = step1.split('\n');
        const out = [];
        let removed = 0;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line === '---') {
            while (out.length > 0 && out[out.length - 1].trim() === '') {
              out.pop();
              removed += 1;
            }
            if (out.length > 0) out.push('');
            out.push('---');
            let j = i + 1;
            while (j < lines.length && lines[j].trim() === '') {
              j += 1;
              removed += 1;
            }
            if (j < lines.length) out.push('');
            i = j - 1;
            continue;
          }
          out.push(line);
        }
        while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
        const next = out.join('\n') + (out.length > 0 ? '\n' : '');
        if (next === md) {
          api.notify('分隔线已规范，无需修改', 'info');
          return;
        }
        api.setMarkdown(next);
        api.notify('已统一 ' + fixed + ' 处分隔线，清理 ' + removed + ' 行空行', 'success');
      }
    });
  }
};
