/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：01 | 分组：日常使用 · 时间与日志
 * id: daily-standup-log | 命令: daily.standupLog
 * 说明：在文末插入一份带日期的每日站会三段式日志模板。
 * 模式：append
 */
function todayIso() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

/** 只在文末追加，原文逐字保留 */
function appendBlock(md, block) {
  const text = String(md || '');
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const body = block.split('\n').join(eol) + eol;
  if (!text) return body;
  const sep = /\r?\n$/.test(text) ? eol : eol + eol;
  return text + sep + body;
}

export default {
  id: 'daily-standup-log',
  name: '每日站会日志',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'daily.standupLog',
      title: '插入昨日今日与阻塞三段式站会日志',
      run() {
        const md = api.getMarkdown() || '';
        const today = todayIso();
        const block = [
          '## 🗓️ 每日站会 · ' + today,
          '',
          '### 昨日进展',
          '- ',
          '',
          '### 今日计划',
          '- ',
          '',
          '### 阻塞与求助',
          '- 无',
          ''
        ].join('\n');
        api.setMarkdown(appendBlock(md, block));
        api.notify('已插入 ' + today + ' 的站会日志模板', 'success');
      }
    });
  }
};
