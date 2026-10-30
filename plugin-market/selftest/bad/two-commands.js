/** red team: duplicate commands */
export default {
  id: 'todo-progress-rollup',
  name: '待办进度条',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({ id: 'writing.todoProgress', title: '统计待办完成率并生成进度条', run() { api.notify('完成', 'success'); } });
    api.registerCommand({ id: 'writing.todoProgress', title: '统计待办完成率并生成进度条', run() { api.notify('完成', 'success'); } });
  }
};
