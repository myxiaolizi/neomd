# neomd

轻量、快速、本地优先的 Markdown 笔记编辑器。

笔记以**明文 `.md` 文件**保存在你自己的文件夹里，支持 **S3 兼容对象存储同步**、**历史版本**、
**所见即所得编辑**与**完全可自定义的快捷键**。

运行于 Windows x64（原生桌面）、Android 手机与平板，也可作为 PWA 在浏览器中使用。

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)

---

## 特性

**快**
首屏约 1.26 MB，索引存于 IndexedDB，只读文件元信息，不预载正文。代码块语法高亮按需加载。

**本地优先**
笔记本体就是磁盘上的普通 `.md` 文件，可直接用其他编辑器打开、用 Git 管理。
没有账号体系，没有云端锁定，断网也能完整使用。

**所见即所得**
基于 CodeMirror 6 与 Lezer 语法树实现实时预览：加粗/斜体/行内代码的标记符自动淡出，
链接可点击、图片直接显示、任务列表渲染为可勾选方框、表格渲染为真实表格。
光标进入相应区间时还原原始 Markdown，全程无需切换编辑/预览模式。

**S3 同步**
自带 AWS Signature V4 实现（纯 WebCrypto，无第三方 SDK），
兼容 AWS S3、MinIO、Cloudflare R2、阿里云 OSS、腾讯云 COS 等。
冲突时远端版本另存为 `原名-冲突-时间戳.md`，绝不静默覆盖。

**历史版本**
保存前自动留存上一版（可配置最小间隔），支持手动快照与一键回滚，
版本数据可随 S3 同步，多设备共享同一份历史。

**两种自动命名**
- 日期时间 + 关键词：`YY年MM月DD日HHMM-【关键词】`
- AI 生成标题：保存时阅读正文自动命名，失败自动回退到本地提取

---

## 下载

前往 [**Releases**](https://github.com/myxiaolizi/neomd/releases/latest) 获取安装包：

| 文件 | 平台 | 说明 |
|---|---|---|
| `neomd-1.0.0-x64-setup.exe` | Windows x64 | 安装包，可选关联 `.md` 文件 |
| `neomd-1.0.0-x64-portable.exe` | Windows x64 | 便携版，免安装 |
| `neomd-1.0.0-arm64.apk` | Android arm64 | 主流手机与平板，体积小 |
| `neomd-1.0.0-universal.apk` | Android 全架构 | 含 arm64 / armv7 / x86 / x86_64 |
| `WebView2Loader.dll` | Windows x64 | 便携版必需，与 exe 放同一目录 |

**安装提示**

- Windows 11 已内置 WebView2；Windows 10 若缺失会提示安装
- 便携版需与 `WebView2Loader.dll` 同目录
- APK 使用自签名证书构建，安装时需允许「安装未知来源应用」
- 首次启动点击「选择仓库文件夹」指定笔记目录

> 应用内部标识为 `mdnote`（二进制名 `mdnote.exe`、包名 `com.mdnote.desktop`），
> 与仓库名 `neomd` 并存，不影响使用。

---

## 从源码构建

全程**无需管理员权限**——工具链便携安装在项目同级的 `toolchain/` 目录。

```powershell
.\build.ps1 -Target check      # 检查环境
.\build.ps1 -Target setup      # 查看工具链安装说明
.\build.ps1 -Target web        # 仅构建前端（PWA）
.\build.ps1 -Target windows    # 构建 Windows 安装包 + 便携版
.\build.ps1 -Target android    # 构建 Android APK
.\build.ps1 -Target all        # 两者都构建
```

产物统一输出到 `dist/`。

### 工具链

`build.ps1` 会自动激活 `toolchain/env.ps1`，其中包含：

| 组件 | 用途 | 获取方式 |
|---|---|---|
| Rust `x86_64-pc-windows-gnu` | 编译 Rust | [rustup.rs](https://rustup.rs)（按用户安装，免管理员） |
| MinGW-w64 | Windows 链接器 | [winlibs](https://winlibs.com) 便携包，替代 VS Build Tools |
| JDK 17 | Gradle / apksigner | [Adoptium](https://adoptium.net) 便携包 |
| Android SDK 34 + build-tools + NDK 26 | 构建 APK | 通过 `sdkmanager` 安装 |

手动激活：`. .\toolchain\env.ps1`

### 前端开发

```powershell
cd app
npm install
npm run dev          # http://127.0.0.1:5280
```

---

## 目录结构

```
.
├─ app/                        前端（React 19 + TypeScript + Vite 6）
│  ├─ src/
│  │  ├─ core/                 与界面无关的核心层
│  │  │  ├─ adapters/          存储适配层：Tauri / FSA / OPFS
│  │  │  ├─ s3.ts              S3 客户端（SigV4 签名）
│  │  │  ├─ sync.ts            同步引擎（双向比对、冲突处理、版本同步）
│  │  │  ├─ db.ts              IndexedDB：文档元数据 + 历史版本
│  │  │  ├─ ai.ts              AI 标题生成（OpenAI 兼容接口）
│  │  │  └─ external.ts        外部 .md 文件接入
│  │  ├─ editor/               编辑器
│  │  │  ├─ livepreview.ts     所见即所得装饰器（核心）
│  │  │  ├─ commands.ts        格式命令与智能回车
│  │  │  └─ languages.ts       代码块高亮（按需加载）
│  │  ├─ ui/                   界面组件
│  │  ├─ styles/               base / shell / editor
│  │  └─ state.ts              应用状态与业务动作
│  └─ public/                  manifest、Service Worker、图标
├─ src-tauri/                  原生壳（Tauri v2）
│  ├─ src/lib.rs               文件系统命令、HTTP 代理、文件关联
│  ├─ tauri.conf.json          桌面配置
│  └─ app.manifest             Windows 清单（DPI / UTF-8）
├─ tools/                      图标生成与自动化验证脚本
└─ build.ps1                   统一构建脚本
```

---

## 核心设计

### 存储：一套接口，三种落地

`VaultAdapter` 抽象出 `list / read / write / remove / move / exists / ensureDir`，
运行时按环境能力自动选择：

| 环境 | 实现 | 说明 |
|---|---|---|
| Tauri 桌面 / 安卓 | `TauriAdapter` | Rust 侧直接读写真实文件系统，无沙箱限制 |
| 桌面 Chrome / Edge | `FsaAdapter` | File System Access API，用户授权真实文件夹 |
| 其他 | `OpfsAdapter` | 私有文件系统，数据随应用存储 |

笔记本体永远是磁盘上的明文 `.md`；元数据与历史版本存放在 IndexedDB，与文件解耦。

### 同步协议

```
<prefix>/notes/<相对路径>.md           笔记正文，与本地仓库同构
<prefix>/versions/<相对路径>/<id>.json  历史版本
<prefix>/manifest.json                 仓库清单
```

1. 列举远端与本地索引做双向比对
2. 仅本地变化 → 上传；仅远端变化 → 下载；两端一致 → 跳过
3. **两端都变化 → 冲突处理**：远端版本另存为 `原名-冲突-YYYYMMDDHHmm.md`，
   本地版本继续上传，绝不静默丢数据
4. 本地删除以墓碑标记传播到远端
5. 历史版本双向同步（可选）

凭据只保存在本机。浏览器直连需为存储桶配置 CORS；Tauri 环境下请求由 Rust
发出，完全绕过 CORS 限制。

### 默认快捷键

所有动作都可在设置中重新绑定，点击即录制。

| 动作 | 快捷键 | 动作 | 快捷键 |
|---|---|---|---|
| 一级 ~ 六级标题 | `Ctrl+1` ~ `Ctrl+6` | 保存 | `Ctrl+S` |
| 正文段落 | `Ctrl+0` | 立即同步 | `Ctrl+Shift+S` |
| 加粗 | `Ctrl+B` | 新建 | `Ctrl+N` |
| 斜体 | `Ctrl+I` | 命令面板 | `Ctrl+P` |
| 行内代码 | `Ctrl+E` | 重命名 | `Ctrl+R` |
| 代码块 | `Ctrl+Shift+E` | 切换侧边栏 | `Ctrl+\` |
| 引用 | `Ctrl+Shift+.` | 历史版本 | `Ctrl+Shift+H` |
| 无序 / 有序 / 任务列表 | `Ctrl+Shift+8 / 7 / 9` | 设置 | `Ctrl+,` |
| 链接 | `Ctrl+K` | 表格 | `Ctrl+Shift+T` |

---

## 使用说明

### 首次启动

1. 点击「选择仓库文件夹」，指定存放笔记的目录
2. 已有的 `.md` 文件会被自动索引并出现在左侧列表
3. 点击「新建笔记」开始写作

### 配置 S3 同步

设置 → 同步：

| 字段 | 示例 |
|---|---|
| Endpoint | `https://s3.us-east-1.amazonaws.com`、`https://minio.example.com` |
| Region | `us-east-1` |
| Bucket | `my-notes` |
| Prefix | `neomd/` |
| Access Key / Secret | 你的密钥 |
| 路径风格寻址 | MinIO 等自建服务通常需要开启 |

> 浏览器直连需配置存储桶 CORS，允许当前来源的 `GET / PUT / DELETE / HEAD`
> 与 `authorization`、`x-amz-*` 头。Tauri 桌面/安卓版无需配置。

### 配置 AI 命名

设置 → AI 命名，填写接口地址、API Key 与模型名（兼容 OpenAI Chat Completions 协议）。
启用后新建笔记并保存时，会阅读正文生成标题并请你确认。

---

## 构建避坑记录

以下问题在实际构建中遇到并已解决，改动已固化在代码里：

| 问题 | 原因 | 解法 |
|---|---|---|
| 链接报 `multiple non-default manifests` | GNU 工具链自带清单与 Tauri 资源冲突 | `build.rs` 注入自定义 `app.manifest` |
| Android 编译 `rfd` 失败 | rfd 不支持移动端 | `#[cfg]` 按平台分派，安卓走 Tauri 对话框插件 |
| APK 白屏（空壳） | 手动 `cargo build` 漏了 `custom-protocol` feature | 在 `Cargo.toml` 定义 `default = ["custom-protocol"]` |
| Gradle 找不到 `npm.bat` | Node 只提供 `npm.cmd` | `toolchain/shims/npm.bat` 包装器 |
| 创建符号链接被拒 | 需管理员或开发者模式 | 直接复制 `.so` 到 `jniLibs`，跳过 `rustBuild` 任务 |
| `ring` 找不到 clang | 只设了 linker 变量 | 补充 `CC_/CXX_/AR_<target>` |
| NSIS / Gradle 下载超时 | GitHub、services.gradle.org 不稳定 | `TAURI_BUNDLER_TOOLS_GITHUB_MIRROR` + 本地 Gradle 分发 |

---

## 技术栈

React 19 · TypeScript · Vite 6 · CodeMirror 6 · Tauri 2 · Rust

## 贡献

欢迎提交 Issue 与 Pull Request。

## 许可证

[GPL-3.0](LICENSE)
