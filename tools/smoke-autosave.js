(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const findBtn = (txt) => Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').includes(txt));

  // 打开已有文档或新建
  const openBtn = document.querySelector('.file-row:not(.file-row--dir)');
  if (openBtn) {
    openBtn.click();
    await sleep(1500);
  } else {
    const create = findBtn('新建文档');
    if (create) {
      create.click();
      await sleep(900);
      const inp = document.querySelector('.modal .nm-input');
      if (inp) {
        inp.value = '自动保存验证';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(200);
        findBtn('确定')?.click();
        await sleep(1500);
      }
    }
  }

  const editor = document.querySelector('.ProseMirror');
  if (!editor) return { error: 'no editor' };

  editor.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand('insertText', false, '自动保存验证内容 2026\n\n这一段用于验证编辑后无需手动保存也能落盘。\n\n- 自动保存间隔 1.2 秒\n- 关闭前尽力落盘\n');
  await sleep(3000);

  // 检查是否已保存（脏标记消失）
  const dirtyDot = document.querySelector('.tab__dot');
  return {
    chars: editor.textContent.length,
    stillDirty: Boolean(dirtyDot),
    title: document.querySelector('.tab-title__text')?.textContent,
    wordCount: document.querySelector('.statusbar')?.textContent?.replace(/\s+/g, ' ').slice(0, 80),
  };
})()
