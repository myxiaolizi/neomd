/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：19 | 分组：日常使用 · 写作与整理
 * id: emphasis-normalize | 命令: writing.emphasisNormalize
 * 说明：统一加粗与斜体符号，并把中文语境下的半角标点替换为全角。
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

/** 行内代码与链接目标不应被替换，先占位保护 */
function protectInline(line) {
  const slots = [];
  let out = line.replace(/`[^`]*`/g, (m) => {
    slots.push(m);
    return '\u0000' + (slots.length - 1) + '\u0000';
  });
  out = out.replace(/\]\([^)]*\)/g, (m) => {
    slots.push(m);
    return '\u0000' + (slots.length - 1) + '\u0000';
  });
  return { out, slots };
}

function restoreInline(text, slots) {
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)] || '');
}

export default {
  id: 'emphasis-normalize',
  name: '强调与符号规范',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'writing.emphasisNormalize',
      title: '统一强调符号与中英文符号混用',
      run() {
        const md = api.getMarkdown() || '';
        if (!md) {
          api.notify('文档为空，无需规范', 'info');
          return;
        }
        let emphasisFixed = 0;
        let punctFixed = 0;
        const next = mapOutsideFence(md, (line) => {
          const { out: protectedLine, slots } = protectInline(line);
          let text = protectedLine;
          // 三个及以上连续星号 → 双星号（加粗）
          const t1 = text.replace(/\*{3,}([^*\n]+?)\*{3,}/g, '**$1**');
          if (t1 !== text) emphasisFixed += 1;
          text = t1;
          // 紧贴中文的半角括号/逗号/句号 → 全角
          const t2 = text
            .replace(/([\u4e00-\u9fff])\s*\(\s*/g, '$1（')
            .replace(/\s*\)\s*([\u4e00-\u9fff])/g, '）$1')
            .replace(/([\u4e00-\u9fff]),/g, '$1，')
            .replace(/([\u4e00-\u9fff])\.(?=\s|$)/g, '$1。')
            .replace(/([\u4e00-\u9fff]);/g, '$1；')
            .replace(/([\u4e00-\u9fff]):/g, '$1：');
          if (t2 !== text) punctFixed += 1;
          text = t2;
          return restoreInline(text, slots);
        });
        if (next === md) {
          api.notify('强调与标点已规范，无需修改', 'info');
          return;
        }
        api.setMarkdown(next);
        api.notify('已规范 ' + emphasisFixed + ' 处强调、' + punctFixed + ' 处标点', 'success');
      }
    });
  }
};
