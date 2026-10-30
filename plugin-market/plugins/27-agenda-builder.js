/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：27 | 分组：日常任务 · 协作会议
 * id: agenda-builder | 命令: collab.agenda
 * 说明：在文末追加 45 分钟会议议程表，按议题时长自动排好累计开始时间。
 * 模式：append
 */
const START_MIN = 14 * 60;
const SLOTS = [
  { topic: '开场与目标对齐', who: '主持人', min: 5 },
  { topic: '上周进展回顾', who: '轮值同学', min: 10 },
  { topic: '本期重点议题', who: '主讲人', min: 15 },
  { topic: '风险与阻塞讨论', who: '全员', min: 10 },
  { topic: '行动项确认与分工', who: '主持人', min: 5 }
];

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function hhmm(total) {
  const m = ((total % 1440) + 1440) % 1440;
  return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
}

/** 仅在文末追加，原文逐字保留；保证与上文之间隔一个空行 */
function appendBlock(raw, block) {
  const text = String(raw || '');
  if (!text.replace(/\s+$/, '')) return block;
  const trimmed = text.replace(/\s+$/, '');
  const tail = text.slice(trimmed.length);
  const blank = /\r?\n[ \t]*\r?\n/.test(tail);
  if (blank) return text + block;
  const nl = tail.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  return text + (tail.indexOf('\n') >= 0 ? nl : nl + nl) + block;
}

export default {
  id: 'agenda-builder',
  name: '议程生成器',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'collab.agenda',
      title: '按议题时长生成会议议程表',
      run() {
        const md = api.getMarkdown() || '';
        const rows = ['| 开始 | 议题 | 主讲 | 时长 |', '| --- | --- | --- | --- |'];
        let cursor = START_MIN;
        let sum = 0;
        for (const slot of SLOTS) {
          rows.push('| ' + hhmm(cursor) + ' | ' + slot.topic + ' | ' + slot.who + ' | ' + slot.min + ' 分钟 |');
          cursor += slot.min;
          sum += slot.min;
        }
        const block = [
          '## 📅 会议议程（' + todayIso() + '）',
          '',
          '- 会议时长：' + sum + ' 分钟',
          '- 时间：' + hhmm(START_MIN) + '–' + hhmm(START_MIN + sum),
          '',
          ...rows,
          '',
          '> 请各议题主讲提前准备 1 页要点，超时议题转入会后跟进。'
        ].join('\n');
        api.setMarkdown(appendBlock(md, block));
        api.notify('已插入 ' + sum + ' 分钟共 ' + SLOTS.length + ' 个议题的议程表', 'success');
      }
    });
  }
};
