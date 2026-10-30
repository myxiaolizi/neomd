/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：21 | 分组：日常任务 · 协作会议
 * id: task-archive-done | 命令: task.archiveDone
 * 说明：把全文已勾选的待办按日期归档到文末清单区块，正文原位置保留不删除。
 * 模式：section
 */
const BEGIN = '<!-- nm:task-archive-done -->';
const END = '<!-- /nm:task-archive-done -->';
const DONE_RE = /^\s*[-*+]\s+\[[xX]\]\s+/;
const MAX_ITEMS = 50;

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** 提取行内日期：优先 ISO，其次「11月2日」与「11-02」 */
function isoOf(text) {
  const src = String(text || '');
  const full = /(\d{4})-(\d{2})-(\d{2})/.exec(src);
  if (full) return full[1] + '-' + full[2] + '-' + full[3];
  const year = String(new Date().getFullYear());
  const cn = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(src);
  if (cn) return year + '-' + pad2(Number(cn[1])) + '-' + pad2(Number(cn[2]));
  const short = /(^|[^\d-])(\d{1,2})-(\d{1,2})(?![\d-])/.exec(src);
  if (short) return year + '-' + pad2(Number(short[2])) + '-' + pad2(Number(short[3]));
  return '';
}

/** 去掉行内日期，避免与分组标题重复 */
function stripDate(text) {
  return String(text || '')
    .replace(/\d{4}-\d{2}-\d{2}/g, '')
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*日/g, '')
    .replace(/(^|[^\d-])\d{1,2}-\d{1,2}(?![\d-])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s·,，。;；:：\-–—]+/, '')
    .replace(/[\s·,，。;；:：\-–—]+$/, '')
    .trim();
}

/** 去掉已有区块，只扫描正文，保证二次执行结果一致 */
function withoutSection(md) {
  const text = String(md || '').replace(/^\uFEFF/, '');
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b >= 0 && e > b) return text.slice(0, b) + text.slice(e + END.length);
  return text;
}

/** 有则替换区块内容，无则追加到文末 */
function upsertSection(md, block) {
  const text = String(md || '').replace(/^\uFEFF/, '');
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b >= 0 && e > b) {
    return text.slice(0, b + BEGIN.length) + '\n' + block.trim() + '\n' + text.slice(e);
  }
  const trimmed = text.replace(/\s+$/, '');
  return (trimmed ? trimmed + '\n\n' : '') + BEGIN + '\n' + block.trim() + '\n' + END + '\n';
}

/** 跳过围栏代码块，逐行回调 */
function scanOutsideFence(md, visit) {
  const lines = String(md || '').split(/\r?\n/);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    visit(line, i);
  }
}

export default {
  id: 'task-archive-done',
  name: '已完成任务归档',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'task.archiveDone',
      title: '把已完成待办归档到文末清单',
      run() {
        const md = api.getMarkdown() || '';
        const grouped = {};
        const order = [];
        let total = 0;
        scanOutsideFence(withoutSection(md), (line) => {
          if (!DONE_RE.test(line)) return;
          const text = line.replace(DONE_RE, '').trim();
          if (!text) return;
          const key = isoOf(text);
          const label = stripDate(text) || text;
          if (!grouped[key]) {
            grouped[key] = [];
            order.push(key);
          }
          grouped[key].push(label);
          total += 1;
        });
        if (total === 0) {
          api.notify('当前文档没有已完成的待办，未生成归档区块', 'info');
          return;
        }
        const dated = order.filter((k) => k).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
        const keys = order.indexOf('') >= 0 ? dated.concat(['']) : dated;
        const out = ['## 🗂 已完成任务归档', '', '归档于 ' + todayIso() + ' · 共 ' + total + ' 项'];
        let used = 0;
        for (const key of keys) {
          if (used >= MAX_ITEMS) break;
          const items = grouped[key];
          out.push('', '### ' + (key || '未标注日期') + '（' + items.length + ' 项）');
          for (const item of items) {
            if (used >= MAX_ITEMS) break;
            out.push('- ' + item);
            used += 1;
          }
        }
        if (total > used) out.push('', '> 其余 ' + (total - used) + ' 项已截断');
        api.setMarkdown(upsertSection(md, out.join('\n')));
        api.notify('已归档 ' + total + ' 项已完成待办', 'success');
      }
    });
  }
};
