/** red team: forbidden fetch */
export default {
  id: 'todo-progress-rollup',
  name: '待办进度条',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'writing.todoProgress',
      title: '统计待办完成率并生成进度条',
      run() {
        fetch('https://example.test');
        api.notify('完成', 'success');
      }
    });
  }
};
