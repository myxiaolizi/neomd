/**
 * 多窗口登记表（不 require electron，便于纯 Node 单测）。
 *
 * 背景（1.1.9 修复）：1.1.7/1.1.8 的主进程用**单个全局变量** `mainWindow` 记窗口，
 * 每开一个新窗口就把它覆盖掉，于是出现三类串味问题：
 * 1. `dialog:pickDirectory/pickFile/saveFile` 用 `mainWindow` 当父窗口 → 在 B 窗口点「选择文件夹」，
 *    对话框可能挂在 A 窗口上（甚至 A 已经关闭时挂空，Windows 下表现为对话框跑到屏幕角落或直接不弹）；
 * 2. `app:theme-changed` 只 send 给 `mainWindow` → 其它窗口不跟随系统主题；
 * 3. 主窗口关闭时把 `mainWindow` 置 null → 其余窗口的对话框、导出 PDF 全部失效。
 *
 * 因此改为「窗口集合 + 按事件发送方定位」：
 * - 所有 IPC 一律用 `BrowserWindow.fromWebContents(event.sender)` 找到**发起调用的那个窗口**；
 * - 需要广播的事件（主题）遍历集合里所有未销毁窗口；
 * - 集合里每个窗口都是平等的，不存在"主窗口"特权，关掉任何一个都不影响其它窗口。
 *
 * `requestSingleInstanceLock()` 限制的是「第二个应用进程」，与「同一进程内多窗口」不冲突，
 * 所以单实例锁保留，多窗口靠本登记表实现。
 */
'use strict';

/** 判断窗口是否仍然可用（已销毁 / 从未创建 都算不可用） */
function isUsableWindow(win) {
  if (!win || typeof win !== 'object') return false;
  try {
    if (typeof win.isDestroyed === 'function') return !win.isDestroyed();
  } catch {
    return false;
  }
  // 单元测试里的假窗口没有 isDestroyed，只要有 webContents 就当作可用
  return Boolean(win.webContents);
}

/** 安全读窗口 bounds：窗口销毁瞬间调用 getBounds 会抛错 */
function safeBounds(win) {
  if (!isUsableWindow(win) || typeof win.getBounds !== 'function') return null;
  try {
    const b = win.getBounds();
    return b && typeof b === 'object' ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
  } catch {
    return null;
  }
}

class WindowRegistry {
  /**
   * @param {object} [opts]
   * @param {(webContents:any)=>any} [opts.fromWebContents] 注入 BrowserWindow.fromWebContents（单测可替换）
   */
  constructor(opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    /** @type {Set<any>} */
    this._windows = new Set();
    this._fromWebContents = typeof options.fromWebContents === 'function' ? options.fromWebContents : null;
  }

  /** 延迟注入解析器：main.cjs 在 app ready 之后才拿到稳定的 BrowserWindow 引用 */
  setResolver(fn) {
    this._fromWebContents = typeof fn === 'function' ? fn : null;
  }

  add(win) {
    if (isUsableWindow(win)) this._windows.add(win);
    return win;
  }

  remove(win) {
    this._windows.delete(win);
  }

  /** 清理已销毁窗口，返回存活窗口数组（按创建顺序） */
  all() {
    const alive = [];
    for (const win of this._windows) {
      if (isUsableWindow(win)) alive.push(win);
      else this._windows.delete(win);
    }
    return alive;
  }

  count() {
    return this.all().length;
  }

  /**
   * 文件关联 / 第二个实例启动时的「默认目标窗口」。
   * 取当前聚焦的窗口，没有聚焦就取最早创建的存活窗口；一个都没有时返回 null。
   * 注意：这只是"优先选谁"的策略，不代表其它窗口不完整。
   */
  focused() {
    const alive = this.all();
    for (const win of alive) {
      try {
        if (typeof win.isFocused === 'function' && win.isFocused()) return win;
      } catch {
        /* 忽略 */
      }
    }
    return alive[0] ?? null;
  }

  /** 兼容旧语义：需要一个"代表窗口"时用它（例如打开外部文件） */
  primary() {
    return this.all()[0] ?? null;
  }

  /**
   * 从 IPC 事件定位发起调用的窗口。
   * 优先 `BrowserWindow.fromWebContents(event.sender)`；解析不出来时返回 null（**不回退到别的窗口**，
   * 否则又会重现"对话框挂错父窗口"的缺陷）。
   */
  resolveSender(event) {
    const sender = event && event.sender;
    if (!sender) return null;
    if (this._fromWebContents) {
      try {
        const win = this._fromWebContents(sender);
        if (isUsableWindow(win)) return win;
      } catch {
        /* 窗口正在销毁时 fromWebContents 可能抛错 */
      }
    }
    // 兜底：遍历集合，用 webContents 引用比对（fromWebContents 不可用时仍能定位）
    for (const win of this.all()) {
      try {
        if (win.webContents === sender) return win;
      } catch {
        /* 忽略 */
      }
    }
    return null;
  }

  /**
   * 对话框父窗口。
   * - 有发送方 → 就是发送方自己（"父窗口取自身"）；
   * - 没有 sender（主进程内部调用，例如菜单触发）→ 退化为当前聚焦窗口；
   * - 有 sender 但窗口已销毁 → 返回 null，让对话框以无父窗口方式弹出，绝不借用别人的窗口。
   */
  resolveDialogParent(event) {
    const win = this.resolveSender(event);
    if (win) return win;
    if (!event || !event.sender) return this.focused();
    return null;
  }

  /** 新窗口级联的参考 bounds：优先发起调用的窗口，其次聚焦窗口 */
  referenceBounds(event) {
    const win = this.resolveSender(event) || this.focused();
    return safeBounds(win);
  }

  /** 广播到所有未销毁窗口，返回成功发送的窗口数 */
  broadcast(channel, payload) {
    let sent = 0;
    for (const win of this.all()) {
      try {
        const wc = win.webContents;
        if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) continue;
        wc.send(channel, payload);
        sent += 1;
      } catch {
        /* 单个窗口发送失败不影响其它窗口 */
      }
    }
    return sent;
  }

  /** 安全地对某个窗口执行操作（窗口可能已销毁） */
  static withWindow(win, fn) {
    if (!isUsableWindow(win) || typeof fn !== 'function') return undefined;
    try {
      return fn(win);
    } catch {
      return undefined;
    }
  }
}

module.exports = { WindowRegistry, isUsableWindow, safeBounds };
