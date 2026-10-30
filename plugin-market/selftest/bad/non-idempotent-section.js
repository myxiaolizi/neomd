/** red team: section output changes on each run */
const BEGIN = '<!-- nm:todo-progress-rollup -->';
const END = '<!-- /nm:todo-progress-rollup -->';
export default {
  id: 'todo-progress-rollup',
  name: '待办进度条',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'writing.todoProgress',
      title: '统计待办完成率并生成进度条',
      run() {
        const block = '## 结果 ' + Math.random();
        const md = api.getMarkdown() || '';
        const begin = md.indexOf(BEGIN);
        const end = md.indexOf(END);
        const next = begin >= 0 && end > begin
          ? md.slice(0, begin + BEGIN.length) + '\n' + block + '\n' + md.slice(end)
          : md.replace(/\s+$/, '') + '\n\n' + BEGIN + '\n' + block + '\n' + END + '\n';
        api.setMarkdown(next);
        api.notify('完成', 'success');
      }
    });
  }
};
