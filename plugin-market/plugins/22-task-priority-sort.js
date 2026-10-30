/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：22 | 分组：日常任务 · 协作会议
 * id: task-priority-sort | 命令: task.prioritySort
 * 说明：识别待办上的 P0/P1/P2、紧急、重要标记，在同一列表内按优先级稳定排序。
 * 模式：inplace
 */
const TODO_RE = /^\s*[-*+]\s+\[[ xX]\]\s+/;

/** 标记行是否在围栏代码块之外 */
function outsideMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    } else if (m) {
      fence = m[1];
    } else {
      mask[i] = true;
    }
  }
  return mask;
}

function indentOf(line) {
  const m = /^(\s*)/.exec(String(line || ''));
  return m ? m[1] : '';
}

/** 优先级数值越小越靠前；无标记为最低 */
function rankOf(line) {
  if (/\bP0\b/.test(line) || /紧急/.test(line)) return 0;
  if (/\bP1\b/.test(line) || /重要/.test(line)) return 1;
  if (/\bP2\b/.test(line)) return 2;
  return 3;
}

export default {
  id: 'task-priority-sort',
  name: '任务优先级排序',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'task.prioritySort',
      title: '按 P0/P1/P2 标记重排待办顺序',
      run() {
        const md = api.getMarkdown() || '';
        const text = String(md).replace(/^\uFEFF/, '');
        const lines = text.split(/\r?\n/);
        const mask = outsideMask(lines);
        const next = lines.slice();
        let moved = 0;
        let i = 0;
        while (i < lines.length) {
          if (!mask[i] || !TODO_RE.test(lines[i])) {
            i += 1;
            continue;
          }
          const indent = indentOf(lines[i]);
          let j = i;
          const group = [];
          while (j < lines.length && mask[j] && TODO_RE.test(lines[j]) && indentOf(lines[j]) === indent) {
            group.push(lines[j]);
            j += 1;
          }
          const sorted = group
            .map((line, k) => ({ line, k, r: rankOf(line) }))
            .sort((a, b) => a.r - b.r || a.k - b.k)
            .map((x) => x.line);
          for (let k = 0; k < sorted.length; k++) {
            if (sorted[k] !== lines[i + k]) moved += 1;
            next[i + k] = sorted[k];
          }
          i = j;
        }
        if (moved === 0) {
          api.notify('待办已按优先级排列，无需调整', 'info');
          return;
        }
        api.setMarkdown(next.join('\n'));
        api.notify('已按优先级重排 ' + moved + ' 行待办', 'success');
      }
    });
  }
};
