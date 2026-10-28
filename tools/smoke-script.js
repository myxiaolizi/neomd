(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const findBtn = (txt) => Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').includes(txt));

  // 1. 点击新建文档
  const create = findBtn('新建文档');
  if (!create) return 'no create button';
  create.click();
  await sleep(900);

  // 2. 处理命名对话框（应用内 InputDialog）
  const dialogInput = document.querySelector('.nm-input');
  if (dialogInput) {
    dialogInput.value = '产品路线图';
    dialogInput.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
    const okBtn = findBtn('确定');
    if (okBtn) okBtn.click();
    await sleep(1400);
  }

  // 3. 写入正文
  const editor = document.querySelector('.ProseMirror');
  if (!editor) return { error: 'no editor', html: document.body.innerHTML.slice(0, 300) };

  const text = '第一季度聚焦本地优先的编辑体验，第二季度打通对象存储与多端同步。\n\n- 完成四模式编辑器\n- 对象存储支持六家预设\n- 版本历史接入时间线对比\n\n参见 [[会议纪要]] 与 #项目/规划。';
  editor.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand('insertText', false, text);
  await sleep(900);

  // 4. 切到对照模式看效果
  const compareBtn = Array.from(document.querySelectorAll('.mode-switch__item')).find((b) => (b.textContent || '').includes('对照'));
  if (compareBtn) {
    compareBtn.click();
    await sleep(1200);
  }

  return {
    chars: (document.querySelector('.ProseMirror') || {}).textContent?.length ?? 0,
    tabs: document.querySelectorAll('.tab').length,
    title: document.querySelector('.tab-title__text')?.textContent,
  };
})()
