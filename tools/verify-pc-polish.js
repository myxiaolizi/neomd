/**
 * PC 端七项改造的实机验证脚本。
 * 由主进程通过 --script 注入执行，返回值会写入 neomd-main.log。
 */
(async () => {
  const out = { checks: [], errors: [] };
  const check = (name, pass, extra) => out.checks.push({ name, pass, extra: extra ?? '' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const bridge = window.NeoMD?.bridge;

  // 1. 桌面端标记与拖拽区
  check('html[data-runtime=desktop]', document.documentElement.dataset.runtime === 'desktop', document.documentElement.dataset.runtime);
  const dragEls = [...document.querySelectorAll('.nm-drag')];
  check('存在 .nm-drag 拖拽区', dragEls.length >= 2, `count=${dragEls.length}`);

  const dragStyle = dragEls[0] ? getComputedStyle(dragEls[0]).getPropertyValue('-webkit-app-region') : '';
  check('.nm-drag 计算样式为 drag', dragStyle.trim() === 'drag', dragStyle);

  // 拖拽区内的按钮必须 no-drag，否则点不到
  const btnInDrag = dragEls[0]?.querySelector('button');
  const btnRegion = btnInDrag ? getComputedStyle(btnInDrag).getPropertyValue('-webkit-app-region') : '';
  check('拖拽区内按钮为 no-drag', btnRegion.trim() === 'no-drag', btnRegion);

  // 2. 窗口双击最大化 / 还原（直接调桥，验证 IPC 通路与状态回传）
  if (bridge?.win) {
    const before = await bridge.win.isMaximized();
    await bridge.win.toggleMaximize();
    await sleep(500);
    const s1 = await bridge.win.isMaximized();
    check('切换后最大化状态反转', s1 === !before, `before=${before} after=${s1}`);

    await bridge.win.toggleMaximize();
    await sleep(500);
    const s2 = await bridge.win.isMaximized();
    check('再次切换后回到初始状态', s2 === before, `before=${before} now=${s2}`);
  } else {
    check('bridge.win 已暴露', false, 'undefined');
  }

  // 3. 自动保存按钮：独立开关样式，且不复用历史图标
  const autoSave = document.querySelector('.autosave');
  check('存在独立自动保存开关按钮', Boolean(autoSave));
  if (autoSave) {
    check('自动保存按钮带 switch 语义', autoSave.getAttribute('role') === 'switch', autoSave.getAttribute('aria-checked'));
    const hasTrack = Boolean(autoSave.querySelector('.autosave__track'));
    check('自动保存为拨动开关（track/knob）', hasTrack);
    const svgPaths = [...autoSave.querySelectorAll('svg path')].map((p) => p.getAttribute('d') || '');
    // 历史图标首段为 "M3 3v5h5"
    const looksLikeHistory = svgPaths.some((d) => d.startsWith('M3 3v5h5'));
    check('自动保存未复用历史版本图标', !looksLikeHistory, svgPaths.join(' | ').slice(0, 60));
  }

  // 4. 页宽下拉：位于历史版本之后、编辑模式之前
  const right = document.querySelector('.editorbar__group--right');
  if (right) {
    const order = [...right.children].map((c) => {
      if (c.classList.contains('widthswitch')) return 'width';
      if (c.classList.contains('viewswitch')) return 'mode';
      if (c.classList.contains('tbtn')) return (c.getAttribute('title') || '').slice(0, 4);
      return c.className;
    });
    const iWidth = order.indexOf('width');
    const iMode = order.indexOf('mode');
    check('页宽下拉存在', iWidth >= 0, order.join(' , '));
    check('页宽在编辑模式之前', iWidth >= 0 && iMode >= 0 && iWidth < iMode, `width=${iWidth} mode=${iMode}`);
    check('历史版本排在页宽之前', iWidth === 1, `width index=${iWidth}`);
  } else {
    check('右侧工具组存在', false);
  }

  // 5. 页宽四个档位都在，且铺满不再写 10px 备注
  const widthBtn = document.querySelector('.widthswitch .viewswitch__btn');
  const widthTitle = widthBtn?.getAttribute('title') || '';
  check('页宽按钮标题不含 10px', !widthTitle.includes('10px'), widthTitle);

  // 先展开下拉再取选项
  widthBtn?.click();
  await sleep(250);
  const widthMenuItems = [...document.querySelectorAll('.widthswitch .viewswitch__item')];
  check('页宽下拉已展开为 4 档', widthMenuItems.length === 4, `count=${widthMenuItems.length} :: ${widthMenuItems.map((b) => b.textContent.trim()).join('|')}`);
  check('铺满档位不写 10px 备注', !widthMenuItems.some((b) => (b.textContent || '').includes('10px')));

  // 6. 页宽四档是否真的生效。
  //    窗口在 1280 宽、左右侧栏展开时正文可用宽度约 640px，三档受限宽度都会被压到同一值，
  //    因此用「计算样式里的 max-width」逐档校验接线，再用实际宽度校验窄档确实收窄。
  const content = document.querySelector('.shell__content');
  const measure = () => (content ? Math.round(content.getBoundingClientRect().width) : -1);
  const clsOf = () => content?.className || '';
  const maxWidthOf = () => (content ? getComputedStyle(content).maxWidth : '');

  const clickWidth = (label) => {
    const btn = [...document.querySelectorAll('.widthswitch .viewswitch__item')].find((b) => (b.textContent || '').trim().startsWith(label));
    btn?.click();
  };
  const openWidthMenu = async () => {
    if (!document.querySelector('.widthswitch .viewswitch__item')) {
      widthBtn?.click();
      await sleep(200);
    }
  };

  const expect = [
    { label: '窄', cls: 'nm-page-narrow', max: '620px' },
    { label: '标准', cls: 'nm-page-standard', max: '760px' },
    { label: '宽', cls: 'nm-page-wide', max: '1080px' },
    { label: '铺满', cls: 'nm-page-full', max: 'none' },
  ];
  for (const e of expect) {
    await openWidthMenu();
    clickWidth(e.label);
    await sleep(300);
    check(`页宽「${e.label}」挂上 ${e.cls}`, clsOf().includes(e.cls), clsOf());
    check(`页宽「${e.label}」max-width 为 ${e.max}`, maxWidthOf() === e.max, maxWidthOf());
  }

  // 实际宽度：铺满必须明显宽于窄档
  await openWidthMenu();
  clickWidth('铺满');
  await sleep(350);
  const fullWidth = measure();
  const fullPad = content ? getComputedStyle(content) : null;
  check('铺满不再有 10px 特例内边距', fullPad ? fullPad.paddingLeft !== '10px' && fullPad.paddingRight !== '10px' : false, fullPad ? `${fullPad.paddingLeft}/${fullPad.paddingRight}` : '');

  await openWidthMenu();
  clickWidth('窄');
  await sleep(350);
  const narrowWidth = measure();
  check('切到「窄」后正文确实收窄', narrowWidth > 0 && narrowWidth < fullWidth, `${fullWidth} -> ${narrowWidth}`);
  check('「窄」实际宽度不超过 620', narrowWidth <= 620, String(narrowWidth));

  // 页宽写入设置（唯一数据源），切标签后仍保持
  const persisted = (() => {
    try {
      const raw = localStorage.getItem('neomd.settings.v1') || localStorage.getItem('neomd.settings');
      return raw ? JSON.parse(raw)?.appearance?.pageWidth ?? '(none)' : '(no key)';
    } catch {
      return '(parse error)';
    }
  })();
  check('页宽已写入设置项', persisted === 'narrow', String(persisted));

  // 7. 右键菜单含「粘贴为纯文本」
  const editable = document.querySelector('.ProseMirror') || document.querySelector('.shell__content');
  if (editable) {
    const r = editable.getBoundingClientRect();
    editable.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 60, clientY: r.top + 60 }));
    await sleep(300);
    const items = [...document.querySelectorAll('.editor-ctxmenu__item')].map((b) => (b.textContent || '').trim());
    check('正文右键菜单已渲染', items.length > 0, `count=${items.length}`);
    check('右键菜单含「粘贴为纯文本」', items.some((t) => t.includes('粘贴为纯文本')), items.join(' / '));
    check('纯文本粘贴标注 Ctrl+Shift+V', items.some((t) => t.includes('Ctrl+Shift+V')));
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await sleep(150);
  } else {
    check('正文编辑区存在', false);
  }

  // 8. 新建文档不再弹输入框，直接自动命名并进入编辑
  const plusBtn = document.querySelector('.editorbar__group--left .tbtn');
  const modalCountBefore = document.querySelectorAll('.nm-modal').length;
  plusBtn?.click();
  await sleep(1200);
  const dialogOpen = Boolean(document.querySelector('.nm-modal'));
  const activeTitle = document.querySelector('.tab.is-active .tab__title')?.textContent || '';
  check('新建未弹出命名输入框', !dialogOpen, `modals=${modalCountBefore}->${document.querySelectorAll('.nm-modal').length}`);
  check('新建后自动获得文件名', activeTitle.trim().length > 0, activeTitle);
  check('新建后直接进入编辑页', Boolean(document.querySelector('.ProseMirror, .shell__content')), activeTitle);
  out.createdDocTitle = activeTitle.trim();

  // 9. 页宽选择状态在工具栏下拉里正确回显
  const widthAfter = document.querySelector('.widthswitch .viewswitch__item.is-active')?.textContent || '';
  out.widthMenuActive = widthAfter.trim();

  return out;
})();
