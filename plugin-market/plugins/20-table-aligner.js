/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：20 | 分组：日常使用 · 写作与整理
 * id: table-aligner | 命令: writing.tableAlign
 * 说明：识别 Markdown 表格，按各列显示宽度补齐空格重新对齐。
 * 模式：inplace
 */
const SEP_CELL = /^\s*:?-{1,}:?\s*$/;

/** 按显示宽度计（中日韩字符算 2） */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function padTo(s, width) {
  const gap = width - displayWidth(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

function splitRow(line) {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  return body.split('|').map((c) => c.trim());
}

function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line) || /^\s*[^|]+\|[^|]+$/.test(line);
}

export default {
  id: 'table-aligner',
  name: '表格对齐整理',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'writing.tableAlign',
      title: '按列宽重新对齐 Markdown 表格',
      run() {
        const md = api.getMarkdown() || '';
        if (!md) {
          api.notify('文档为空，未发现表格', 'info');
          return;
        }
        const lines = md.split(/\r?\n/);
        const out = [];
        let fence = null;
        let tables = 0;
        let i = 0;
        while (i < lines.length) {
          const line = lines[i];
          const fm = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
          if (fence) {
            out.push(line);
            if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length) fence = null;
            i += 1;
            continue;
          }
          if (fm) {
            fence = fm[1];
            out.push(line);
            i += 1;
            continue;
          }
          // 表格 = 表头行 + 分隔行
          if (isTableRow(line) && i + 1 < lines.length && isTableRow(lines[i + 1]) && splitRow(lines[i + 1]).every((c) => SEP_CELL.test(c) && c.includes('-'))) {
            const block = [line, lines[i + 1]];
            let j = i + 2;
            while (j < lines.length && isTableRow(lines[j]) && lines[j].trim() !== '') {
              block.push(lines[j]);
              j += 1;
            }
            const rows = block.map(splitRow);
            const cols = Math.max(...rows.map((r) => r.length));
            const widths = new Array(cols).fill(3);
            for (let r = 0; r < rows.length; r++) {
              if (r === 1) continue;
              for (let c = 0; c < cols; c++) {
                widths[c] = Math.max(widths[c], displayWidth(rows[r][c] || ''));
              }
            }
            const aligns = rows[1].map((c) => {
              const left = c.startsWith(':');
              const right = c.endsWith(':');
              if (left && right) return 'center';
              if (right) return 'right';
              if (left) return 'left';
              return 'none';
            });
            for (let r = 0; r < rows.length; r++) {
              if (r === 1) {
                const cells = [];
                for (let c = 0; c < cols; c++) {
                  const w = widths[c];
                  const a = aligns[c] || 'none';
                  if (a === 'center') cells.push(':' + '-'.repeat(Math.max(1, w - 2)) + ':');
                  else if (a === 'right') cells.push('-'.repeat(Math.max(1, w - 1)) + ':');
                  else if (a === 'left') cells.push(':' + '-'.repeat(Math.max(1, w - 1)));
                  else cells.push('-'.repeat(w));
                }
                out.push('| ' + cells.join(' | ') + ' |');
                continue;
              }
              const cells = [];
              for (let c = 0; c < cols; c++) {
                const cell = rows[r][c] || '';
                const a = aligns[c] || 'none';
                if (a === 'right') {
                  const gap = widths[c] - displayWidth(cell);
                  cells.push(' '.repeat(Math.max(0, gap)) + cell);
                } else if (a === 'center') {
                  const gap = Math.max(0, widths[c] - displayWidth(cell));
                  const left = Math.floor(gap / 2);
                  cells.push(' '.repeat(left) + cell + ' '.repeat(gap - left));
                } else {
                  cells.push(padTo(cell, widths[c]));
                }
              }
              out.push('| ' + cells.join(' | ') + ' |');
            }
            tables += 1;
            i = j;
            continue;
          }
          out.push(line);
          i += 1;
        }
        const next = out.join('\n');
        if (tables === 0) {
          api.notify('未发现可对齐的 Markdown 表格', 'info');
          return;
        }
        if (next === md) {
          api.notify('表格已对齐，无需修改', 'info');
          return;
        }
        api.setMarkdown(next);
        api.notify('已对齐 ' + tables + ' 个表格', 'success');
      }
    });
  }
};
