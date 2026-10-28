/**
 * 窗口几何 / 路由的纯函数集合（不 require electron）。
 *
 * 为什么单独抽一个文件：
 * 1. 主进程 main.cjs 一旦 require('electron') 就只能跑在 Electron 里，纯 Node 单测无法覆盖；
 *    而「级联定位不越屏」「新窗口 URL 参数」这两件事恰恰是最容易算错、又最值得回归的部分，
 *    所以把它们做成不依赖 Electron 的纯函数，tools/verify-119-multiwindow.mjs 可以直接 require 做单测。
 * 2. 多显示器 / 小屏 / 高 DPI 场景下，级联偏移很容易把窗口推到屏幕外（用户会以为"没打开"），
 *    把「以 workArea 收敛」写成一处实现，避免 main.cjs 里再散落第二份 clamp 逻辑。
 *
 * 注意：本文件会被 electron-builder 打进 asar（见 electron-builder.config.cjs 的 files），
 * 因此只能使用 Node 内置能力，不能引入任何第三方依赖。
 */
'use strict';

/** 主窗口默认尺寸（与 1.1.7 保持一致，避免改动用户观感） */
const DEFAULT_SIZE = Object.freeze({ width: 1280, height: 840 });
/** 最小尺寸（与 BrowserWindow 的 minWidth/minHeight 一致） */
const MIN_SIZE = Object.freeze({ width: 720, height: 520 });
/** 级联偏移步长与最大阶梯数：超过 8 个窗口后回到第一级，避免偏移过大跑到屏幕外 */
const CASCADE_STEP = 28;
const CASCADE_MODULO = 8;

/** 把 {x,y,width,height} 里非有限数字的字段丢掉，返回 null 表示"不是有效矩形" */
function normalizeRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * 第 count 个窗口的级联偏移像素。
 *
 * 第一个额外窗口偏移 1 格（28px），之后逐级递增；到第 8 格回到 1 格，
 * 避免开十几个窗口后偏移量大到被 clamp 到屏幕边缘、反而全部重叠在同一个位置。
 * 任何情况下都返回 > 0，保证新窗口不会与父窗口完全重合（完全重合时用户会以为"没打开"）。
 */
function nextCascadeOffset(count) {
  const n = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  return ((n % CASCADE_MODULO) + 1) * CASCADE_STEP;
}

/**
 * 计算新窗口位置与尺寸：以父窗口（或工作区）左上角为锚点偏移，再整体收敛进 workArea。
 *
 * @param {object} opts
 * @param {{x:number,y:number,width:number,height:number}|null} [opts.from] 父窗口 bounds（可能在其他显示器上）
 * @param {{x:number,y:number,width:number,height:number}} opts.workArea 目标显示器工作区（screen.getDisplayMatching(from).workArea）
 * @param {{width:number,height:number}} [opts.size] 期望尺寸，默认 DEFAULT_SIZE
 * @param {number} [opts.cascade] 级联偏移像素
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function computeCascadeBounds(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const workArea = normalizeRect(options.workArea) || {
    x: 0,
    y: 0,
    width: DEFAULT_SIZE.width,
    height: DEFAULT_SIZE.height,
  };
  const size = normalizeRect({ x: 0, y: 0, ...(options.size || {}) }) || { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height };
  const from = normalizeRect(options.from);
  const cascade = Number.isFinite(options.cascade) ? Math.max(0, Math.trunc(options.cascade)) : 0;

  // 先按工作区收缩尺寸：小屏（或缩放比例很大）时 1280x840 可能比工作区还大，直接放进去会溢出
  const width = Math.max(1, Math.min(size.width, workArea.width));
  const height = Math.max(1, Math.min(size.height, workArea.height));

  const anchorX = from ? from.x : workArea.x;
  const anchorY = from ? from.y : workArea.y;

  // 可移动的上界：保证右下边缘不超出工作区；若窗口比工作区还宽（已被上面收缩，理论上不会），退化为工作区原点
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - width);
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - height);

  return {
    x: Math.min(Math.max(anchorX + cascade, workArea.x), maxX),
    y: Math.min(Math.max(anchorY + cascade, workArea.y), maxY),
    width,
    height,
  };
}

/** 窗口是否完整落在工作区内（验收断言用） */
function isBoundsWithinWorkArea(bounds, workArea) {
  const b = normalizeRect(bounds);
  const a = normalizeRect(workArea);
  if (!b || !a) return false;
  return b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;
}

/**
 * 归一化 `window:newWindow` 的入参。
 *
 * 兼容两种调用形态：
 * - 旧渲染层：`newWindow(docId)`（字符串）
 * - 新渲染层：`newWindow(docId, { fresh })` / `newWindow({ docId, fresh })`
 *
 * `fresh` 语义：新窗口不要恢复旧标签（由渲染层读取 URL 上的 `fresh=1` 实现）。
 * 默认 **true** —— "移动至新窗口" 的语义就是把这一篇文档单独搬过去，
 * 恢复出整套旧标签等于把新窗口克隆成旧窗口（1.1.7 的缺陷 2）。
 */
function normalizeNewWindowArgs(payload) {
  let docId = null;
  let fresh = true;
  if (typeof payload === 'string') {
    docId = payload;
  } else if (payload && typeof payload === 'object') {
    if (typeof payload.docId === 'string') docId = payload.docId;
    if (payload.fresh === false) fresh = false;
  }
  docId = typeof docId === 'string' ? docId.trim() : '';
  return { docId: docId || null, fresh };
}

/**
 * 构造新窗口的 URL 查询串（由 createWindow 拼到 `neomd://neomd/app` 后面）。
 *
 * 约定（渲染层必须遵守）：
 * - `doc=<docId>`：只打开这一篇文档；
 * - `fresh=1`：**不要**恢复旧标签，直接以「仅这篇文档」的干净状态启动；
 * - 只有 `doc` 时：打开该文档但仍恢复旧标签（历史行为，保持向后兼容）；
 * - 既无 doc 也无其他参数时返回空串：新窗口恢复旧标签（Ctrl+Shift+N 新建窗口的历史行为）。
 *
 * `fresh` 只在同时给了 `docId` 时才拼：单独一个 `fresh=1` 没有意义
 * （没有目标文档时"只打开这一篇"无从谈起），也会让渲染层误判成本次启动是"移动文档"。
 *
 * 用 URL 而不是 webContents.send：新窗口在 did-finish-load 之前收不到 IPC 消息，
 * URL 是窗口自身加载时就带上的，最稳。
 */
function buildWindowRoute(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const params = [];
  const docId = typeof options.docId === 'string' ? options.docId.trim() : '';
  if (docId) {
    params.push(`doc=${encodeURIComponent(docId)}`);
    if (options.fresh) params.push('fresh=1');
  }
  return params.length ? `?${params.join('&')}` : '';
}

module.exports = {
  DEFAULT_SIZE,
  MIN_SIZE,
  CASCADE_STEP,
  CASCADE_MODULO,
  normalizeRect,
  nextCascadeOffset,
  computeCascadeBounds,
  isBoundsWithinWorkArea,
  normalizeNewWindowArgs,
  buildWindowRoute,
};
