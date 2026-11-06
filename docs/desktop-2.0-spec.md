# Neo MD 2.0 · 四技术栈 Windows x64 桌面端并行开发规范

> 本文件是 **任务契约**，四个实现组必须严格遵循，确保四版行为一致、可对比测试。

---

## 一、背景与目标

Neo MD 现有 `apps/web`（Vue 3 + Vite 构建的 SPA，产物 `apps/web/dist`，157 个文件 / 3.56 MB）。
需要**同时**用四种桌面技术各做一版 Windows x64 客户端，放在本机供性能与稳定性对比测试：

| # | 技术栈 | 壳类型 | 渲染内核 |
|---|---|---|---|
| 1 | WinUI 3 | 原生（.NET 8 + Windows App SDK） | WebView2 |
| 2 | Qt 6 | 原生（C++ + QtWebEngine） | Chromium |
| 3 | Tauri 2 | 原生（Rust + wry） | WebView2（系统） |
| 4 | Flutter | 自绘（Dart + flutter_inappwebview/Cef） | WebView2 / 自绘 UI |

四版**只做"壳"**，业务逻辑全部复用同一份 Web 产物，不重写编辑器。

---

## 二、统一加载契约（最关键）

### 2.1 Web 产物来源

四版都加载 `apps/web/dist` 的**同一份构建产物**，不各自 build：

```
C:\Data\BAC\neomd\neomd-V1\apps\web\dist
├── index.html
├── assets/            (157 文件)
├── favicon.svg
├── icon-192.png
└── icon-512.png
```

### 2.2 必须注入的宿主标记

`packages/core/src/platform.ts` 的 `detectRuntime()` 通过 `globalThis.NeoMD.env` 判定平台：

```ts
const g = globalThis as unknown as {
  NeoMD?: { env?: RuntimePlatform; version?: string; bridge?: NativeBridge };
};
if (injected?.env) platform = injected.env;
```

**因此每个壳都必须在页面脚本执行前注入：**

```js
window.NeoMD = {
  env: 'desktop',        // 必需，否则被判定为 web
  version: '2.0.0',      // 必需
  bridge: { ... }        // 见 2.3
};
```

> ⚠️ 注入时机：必须在 `index.html` 的 `index-*.js` 执行**之前**。
> WebView2 用 `AddScriptToExecuteOnDocumentCreatedAsync`；Qt 用 `QWebEngineScript` + `InjectionPoint::Deferred`；
> Tauri 用 `initialization_script`；Flutter 用 `initialUserScripts` / `userScripts`。

### 2.3 NativeBridge 接口（`packages/core/src/platform.ts`）

**以下是与 `packages/core/src/platform.ts` 逐字对齐的真实接口**（不要臆造字段名）：

```ts
export interface NativeBridge {
  fs: {                                    // 必需
    readText(path: string): Promise<string>;
    readBinary(path: string): Promise<Uint8Array>;
    writeText(path: string, content: string): Promise<void>;
    writeBinary(path: string, data: Uint8Array): Promise<void>;
    mkdirp(path: string): Promise<void>;
    remove(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    list(path: string): Promise<Array<{ name: string; isDirectory: boolean; size: number; mtime: number }>>;
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<{ size: number; mtime: number } | null>;   // null 表示不存在
  };
  dialog?: {
    pickDirectory(): Promise<string | null>;
    pickFile(filters?: string[]): Promise<string | null>;
    saveFile(defaultName: string): Promise<string | null>;
  };
  paths?: {
    documents(): Promise<string>;
    userData(): Promise<string>;
    vaultDefault(): Promise<string>;
  };
  secrets?: { encrypt(plain: string): Promise<string>; decrypt(cipher: string): Promise<string> };
  shell?: { openExternal(url: string): Promise<void>; showItemInFolder(path: string): Promise<void> };
  win?: {
    isMaximized(): Promise<boolean>;
    toggleMaximize(): Promise<boolean>;          // 注意：返回 boolean
    minimize(): Promise<void>;
    close(): Promise<void>;
    onStateChange?(cb: (state: { maximized: boolean }) => void): void;
  };
  app?: {
    version(): Promise<string>;
    onOpenFile(cb: (path: string) => void): void;  // 注意：是同步注册回调
  };
}
```

**四个易错点（务必照抄真实定义）：**

| 字段 | 正确 | 容易写错 |
|---|---|---|
| `fs.list` 返回项 | `isDirectory: boolean` | ❌ `isDir` |
| `fs.stat` | `{size,mtime} \| null` | ❌ 返回 `isDir`，或不存在时抛异常 |
| `win.toggleMaximize` | `Promise<boolean>` | ❌ `Promise<void>` |
| `app.onOpenFile` | 同步 `void` 注册 | ❌ 写成 `Promise` |

### 2.4 最小可用范围（MUST）

第一版**必须**实现：`env` / `version` / `fs.*`（10 个方法全实现）/ `dialog.*` / `paths.*` / `app.version()`。

`secrets` / `shell` / `win` / `app.onOpenFile` 属于 SHOULD。缺失时 Web 端可选链兜底，
**未实现的方法统一返回 `Promise.reject(new Error('NOT_IMPLEMENTED'))`，绝不能同步 throw**。

### 2.5 架构契约：本地 HTTP + /api 反向代理（已验证可行）

这是四版**必须统一**的承载方式，原因是 Web 端的一段逻辑：

```ts
// apps/web/src/lib/server-endpoint.ts
function isRemoteWeb(): boolean {
  const proto = window.location.protocol;
  const host = window.location.hostname;
  return (proto === 'http:' || proto === 'https:') && host !== 'neomd' && ...;
}
export function resolveServerBase(): string {
  const custom = resolveCustomServerBase();
  if (custom) return custom;
  if (isRemoteWeb()) return '';        // ← http(s) 页面：返回空串，走同源相对路径
  return OFFICIAL_SERVER_BASE;
}
```

所以每个壳都按下面这套来，**不要**各自发明：

1. 壳内起一个**本地静态服务器**（绑定 `127.0.0.1` 随机端口），根目录 = `apps/web/dist`；
2. 同一个服务器把 `/api/*` **反向代理**到 `https://md.zhengl.vip`；
3. 窗口加载 `http://127.0.0.1:<port>/`；
4. 页面首帧前注入 `window.NeoMD`（见 2.2）。

这样：
- 页面 origin 是 `http://127.0.0.1:<port>` → `isRemoteWeb()` 为 true → API 走相对路径 → 打到本地服务器 → 被代理转发，**全程同源，零 CORS 预检**；
- 四版行为完全一致，便于横向对比性能；
- 后端日志可通过注入 `x-neomd-shell: winui3|qt|tauri|flutter` 请求头区分来源。

> 参考实现见 `tools/verify-shell-architecture.mjs`（已实测：注入生效、`/api/plugins/market` 返回 53 条）。

> 注：Electron 老版用的是 `neomd://` 自定义协议（`host === 'neomd'` 时 `isRemoteWeb()` 为 false，
> 于是走绝对地址 `https://md.zhengl.vip`，CORS 已放行 `neomd://`）。四版**不沿用**这条路，
> 因为注册自定义 scheme 在 Qt/WinUI3 上成本高、坑多。

### 2.5 兜底行为验证

Web 端在 `bridge` 缺失时的行为已实现（`packages/core` 里可选链判断）。壳可以不实现
全部方法，但**必须不能抛异常**——未实现的方法返回 `Promise.reject(new Error('NOT_IMPLEMENTED'))`
会被 Web 端捕获，不能直接 `throw`。

---

## 三、四版目录与命名契约

四个实现组**各自独立目录**，互不写入对方范围：

```
C:\Data\BAC\neomd\neomd-V1\apps\
├── desktop-winui3\      # 组 1
├── desktop-qt\          # 组 2
├── desktop-tauri\       # 组 3
└── desktop-flutter\     # 组 4
```

### 3.1 统一产物命名

每版构建后把可运行目录放到：

```
C:\Data\BAC\neomd\releases\2.0.0\
├── NeoMD-2.0.0-winui3-x64\
├── NeoMD-2.0.0-qt-x64\
├── NeoMD-2.0.0-tauri-x64\
└── NeoMD-2.0.0-flutter-x64\
```

每个目录内**必须**有一个明确的可执行入口，且在同目录放 `RUN.md` 说明启动方式。

### 3.2 统一"绿色版"要求

- **不写注册表**（除 Windows 必需的 COM 注册外）；
- 用户数据写在 **exe 同级 `data/`** 目录（可整目录拷走）；
- 不依赖系统级安装，解压即用；
- 若技术栈强制需要（如 WinUI3 的 Packaged 模式），改用 **Unpackaged + self-contained** 发布。

---

## 四、性能与稳定性测试契约

四版完成后统一跑 `tools/bench-desktop/` 的同一套测试，产出可比数据。

### 4.1 采集指标（每版必出）

| 指标 | 采集方式 | 目标 |
|---|---|---|
| 冷启动到首屏（ms） | 进程创建 → 窗口 `did-finish-load` | 记录即可 |
| 内存峰值（MB） | 运行 60s 采样 `WorkingSet64` 峰值 | 记录即可 |
| 安装包/目录体积（MB） | 产物目录总字节 | 记录即可 |
| 空闲 CPU（%） | 静置 30s 平均 | ≤ 5% |
| 首屏交互可点（ms） | 注入脚本上报 `performance.now()` | 记录即可 |
| 崩溃次数（5 分钟压测） | 反复开关窗口 / 刷新 / 大文档加载 | 0 |

### 4.2 稳定性用例（每版都跑）

1. 启动 → 关闭 → 再启动（3 次）
2. 打开 10 MB Markdown 文档不崩溃
3. 连续切换主题 20 次不崩溃
4. 断网启动能进主界面（不白屏）
5. 同时开 3 个窗口不崩溃

---

## 五、禁止事项（红线）

1. **不得修改** `apps/web/`、`packages/`、`services/` 下任何现有源码——四版只能做壳。
   （唯一例外：经 Lead 明确批准的 bug 修复）
2. **不得** 让四版共享同一个 `node_modules` 写入（pnpm workspace 已隔离，不要破坏）。
3. **不得** 提交任何凭据、token、`.env` 内容。
4. **不得** 在代码里硬编码 `md.zhengl.vip` 以外的后端地址。
5. **不得** 声称未实际构建成功的产物——构建失败必须如实上报错误。

---

## 六、验收标准

每版独立验收（Lead 复核）：

- [ ] 能在本机启动，显示 Neo MD 主界面（不是白屏/报错）
- [ ] `window.NeoMD.env === 'desktop'`（在壳内 DevTools 可验证）
- [ ] 能新建文档、输入文字、保存到本地文件（走 bridge.fs）
- [ ] 目录体积 / 启动时间 / 内存 有实测数字
- [ ] 产物在 `releases/2.0.0/` 下可直接运行
- [ ] `RUN.md` 写明启动方式与已知问题

---

## 七、2.0 发布要求

四版全部验收后：

1. 版本号统一提升到 `2.0.0`（所有 `package.json` + `apps/web/src/env.ts`）
2. `CHANGELOG.md` 增加 2.0.0 条目
3. 本机输出 **PC 端绿色版**（Electron 版仍保留，作为第五个基线对照）
4. 生成 `releases/2.0.0/` 汇总说明与对比报告
