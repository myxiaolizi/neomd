/**
 * 外部 Markdown 文件接入。
 *
 * 三种来源：
 *  1. 系统「用此应用打开 .md」→ Tauri 通过 CLI 参数 / 单实例事件传入路径
 *  2. 浏览器 File Handling API（Chromium PWA 支持）
 *  3. 手动拖入或选择文件
 */

export interface ExternalFile {
  /** 文件名（含 .md） */
  name: string;
  /** 文件内容 */
  content: string;
  /** 原始路径（Tauri 下为绝对路径） */
  path?: string;
}

interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

function tauriInvoke(): TauriInternals['invoke'] | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  return w.__TAURI_INTERNALS__?.invoke ?? null;
}

export function isTauri(): boolean {
  return tauriInvoke() !== null;
}

/** 读取 Tauri 启动时携带的文件参数（系统关联打开） */
export async function takeStartupFile(): Promise<ExternalFile | null> {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  try {
    const payload = (await invoke('take_startup_file')) as
      | { name: string; path: string; content: string }
      | null;
    if (!payload) return null;
    return { name: payload.name, content: payload.content, path: payload.path };
  } catch {
    return null;
  }
}

/** 监听后续通过系统关联打开的文件（应用已运行时） */
export function onExternalFile(cb: (file: ExternalFile) => void): () => void {
  const invoke = tauriInvoke();
  if (!invoke) return () => undefined;

  // Tauri 事件桥接
  const w = window as unknown as {
    __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener?: (id: number) => void };
  };
  let stopped = false;

  (async () => {
    try {
      const listenId = (await invoke('plugin:event|listen', {
        event: 'mdnote://open-file',
        target: { kind: 'Any' },
        handler: '__mdnote_open_file__',
      })) as number;

      (window as unknown as Record<string, unknown>).__mdnote_open_file__ = (
        event: { payload: { name: string; path: string; content: string } },
      ) => {
        if (stopped) return;
        const p = event.payload;
        if (!p) return;
        cb({ name: p.name, content: p.content, path: p.path });
      };

      if (listenId && w.__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener) {
        // 记录以便清理
        (window as unknown as Record<string, unknown>).__mdnote_listen_id__ = listenId;
      }
    } catch {
      /* 非 Tauri 环境或事件不可用 */
    }
  })();

  return () => {
    stopped = true;
    delete (window as unknown as Record<string, unknown>).__mdnote_open_file__;
  };
}

/** 打开系统文件选择框（Tauri） */
export async function pickExternalFile(): Promise<ExternalFile | null> {
  const invoke = tauriInvoke();
  if (invoke) {
    try {
      const payload = (await invoke('pick_markdown_file')) as
        | { name: string; path: string; content: string }
        | null;
      if (!payload) return null;
      return { name: payload.name, content: payload.content, path: payload.path };
    } catch {
      return null;
    }
  }
  return pickViaInput();
}

/** 浏览器文件选择（含 PWA File Handling 优先） */
export async function pickViaInput(): Promise<ExternalFile | null> {
  const launcher = (window as unknown as {
    launchQueue?: { setConsumer: (c: (params: { files: FileSystemFileHandle[] }) => void) => void };
  }).launchQueue;

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.markdown,text/markdown';
    input.style.display = 'none';
    input.onchange = async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) {
        resolve(null);
        return;
      }
      const content = await file.text();
      resolve({ name: file.name, content });
    };
    document.body.appendChild(input);
    input.click();
    void launcher;
  });
}

/** 注册 PWA 文件处理（Chromium 桌面支持） */
export async function registerFileHandlers(
  cb: (file: ExternalFile) => void,
): Promise<void> {
  const w = window as unknown as {
    launchQueue?: {
      setConsumer: (
        consumer: (params: { files?: FileSystemFileHandle[] }) => void,
      ) => void;
    };
  };
  if (!w.launchQueue) return;
  try {
    w.launchQueue.setConsumer(async (params) => {
      const handle = params.files?.[0];
      if (!handle) return;
      const file = await handle.getFile();
      cb({ name: file.name, content: await file.text() });
    });
  } catch {
    /* 忽略 */
  }
}

/** 从拖放事件提取 Markdown 文件 */
export async function filesFromDrop(dt: DataTransfer): Promise<ExternalFile[]> {
  const out: ExternalFile[] = [];
  for (const file of Array.from(dt.files)) {
    if (!/\.(md|markdown)$/i.test(file.name)) continue;
    out.push({ name: file.name, content: await file.text() });
  }
  return out;
}
