/**
 * preload：把受控能力暴露到 window.NeoMD。
 * 渲染进程只能通过这里访问文件系统、密钥与系统对话框。
 */
const { contextBridge, ipcRenderer } = require('electron');

/**
 * 窗口最大化状态的订阅表。
 * 多个组件（标签栏、左栏头部、后续的 UI）都可能关心该状态，
 * 这里统一挂一个 ipcRenderer 监听再分发，避免每个订阅者都在 IPC 上加一个监听器。
 */
const windowStateListeners = new Set();
let windowStateBound = false;

function ensureWindowStateBridge() {
  if (windowStateBound) return;
  windowStateBound = true;
  ipcRenderer.on('app:window-state', (_e, state) => {
    for (const cb of windowStateListeners) {
      try {
        cb(state);
      } catch {
        /* 单个订阅者异常不影响其他订阅者 */
      }
    }
  });
}

function onWindowStateChange(cb) {
  ensureWindowStateBridge();
  windowStateListeners.add(cb);
  // 立即补一次当前状态，避免首次事件之前界面停留在默认值
  ipcRenderer
    .invoke('window:isMaximized')
    .then((maximized) => cb({ maximized: Boolean(maximized) }))
    .catch(() => undefined);
}

function offWindowStateChange(cb) {
  windowStateListeners.delete(cb);
}

const bridge = {
  fs: {
    readText: (p) => ipcRenderer.invoke('fs:readText', p),
    readBinary: (p) => ipcRenderer.invoke('fs:readBinary', p),
    writeText: (p, c) => ipcRenderer.invoke('fs:writeText', p, c),
    writeBinary: (p, d) => ipcRenderer.invoke('fs:writeBinary', p, d),
    mkdirp: (p) => ipcRenderer.invoke('fs:mkdirp', p),
    remove: (p) => ipcRenderer.invoke('fs:remove', p),
    rename: (a, b) => ipcRenderer.invoke('fs:rename', a, b),
    list: (p) => ipcRenderer.invoke('fs:list', p),
    exists: (p) => ipcRenderer.invoke('fs:exists', p),
    stat: (p) => ipcRenderer.invoke('fs:stat', p),
  },
  dialog: {
    pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
    pickFile: (filters) => ipcRenderer.invoke('dialog:pickFile', filters),
    saveFile: (name) => ipcRenderer.invoke('dialog:saveFile', name),
  },
  paths: {
    documents: () => ipcRenderer.invoke('paths:documents'),
    userData: () => ipcRenderer.invoke('paths:userData'),
    vaultDefault: () => ipcRenderer.invoke('paths:vaultDefault'),
  },
  secrets: {
    encrypt: (plain) => ipcRenderer.invoke('secrets:encrypt', plain),
    decrypt: (cipher) => ipcRenderer.invoke('secrets:decrypt', cipher),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    showItemInFolder: (p) => ipcRenderer.invoke('shell:showItemInFolder', p),
  },
  win: {
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    minimize: () => ipcRenderer.invoke('window:minimize'),
    close: () => ipcRenderer.invoke('window:close'),
    /**
     * 新建应用窗口（1.1.7 多窗口）。
     *
     * 传入 docId 时，主进程会把它拼到新窗口的 URL 上（`/app?doc=<docId>`），
     * 新窗口启动后由渲染层自行打开该文档 —— 不走跨窗口 IPC 推送，
     * 避免新窗口 webContents 尚未加载完成时丢消息。
     *
     * @param {string} [docId] 要在新窗口打开的文档 id
     * @returns {Promise<number>} 新窗口的 id
     */
    newWindow: (docId) => ipcRenderer.invoke('window:newWindow', docId ?? null),
    /**
     * 订阅最大化状态变化：回调立即触发一次当前状态，之后随窗口事件触发。
     * 配套 `offStateChange(cb)` 取消订阅，避免组件反复挂载时监听器累积。
     */
    onStateChange: (cb) => {
      onWindowStateChange(cb);
    },
    offStateChange: (cb) => {
      offWindowStateChange(cb);
    },
  },
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    onOpenFile: (cb) => {
      ipcRenderer.on('app:open-file', (_e, filePath) => cb(filePath));
    },
    onThemeChanged: (cb) => {
      ipcRenderer.on('app:theme-changed', (_e, theme) => cb(theme));
    },
  },
  printToPdf: (html, title) => ipcRenderer.invoke('app:printToPdf', html, title),
};

contextBridge.exposeInMainWorld('NeoMD', {
  env: 'desktop',
  version: process.env.npm_package_version || '1.0.0',
  bridge,
});
