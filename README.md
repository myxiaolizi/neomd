# Neo MD

> 本地优先（Local-First）的 Markdown 知识生产力平台。笔记以明文 `.md` 保存在你自己的文件夹或个人对象存储中，一套代码产出 **Windows 桌面端**、**Android 端** 与 **网页版**。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.19-brightgreen.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-12-orange.svg)](https://pnpm.io/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Android%20%7C%20Web-lightgrey.svg)](#交付形态)
[![Tests](https://img.shields.io/badge/tests-30%20passed-success.svg)](#开发与测试)

<!--
  CI 徽章：仓库推到 GitHub 后，把 <owner>/<repo> 替换为真实路径并取消注释。
  ![CI](https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg)
-->

<!--
  截图占位：把编辑器主界面截图放到 docs/images/editor.png，然后取消下一行注释。
  ![Neo MD 编辑器主界面](docs/images/editor.png)
-->

**目录** · [为什么选 Neo MD](#为什么选-neo-md) · [交付形态](#交付形态) · [功能特性](#功能特性) · [技术栈](#技术栈) · [目录结构](#目录结构) · [快速开始](#快速开始) · [部署](#部署) · [PC 端自定义服务器](#pc-端自定义服务器102) · [用户指南](./docs/USER_GUIDE.md) · [更新日志](./CHANGELOG.md) · [贡献](#贡献指南) · [License](#license)

---

## 为什么选 Neo MD

| 你的顾虑 | Neo MD 的做法 |
| --- | --- |
| 笔记被锁在某个 SaaS 里 | 正文就是本机文件夹里的明文 `.md`，不用 Neo MD 也能用任意编辑器打开 |
| 换设备要重新排版、丢格式 | 自研 Markdown 往返桥，所见即所得 / 源码 / 对照 / 阅读四模式无损互转 |
| 云端同步要信任第三方服务器 | 走标准 S3 兼容协议，直连**你自己的**阿里云 OSS / 腾讯云 COS / MinIO 等桶 |
| 团队要求私有化部署 | 服务端（Fastify + MySQL）完整开源，可自建；PC 端在「设置 → 服务器」填自己的地址即可切换 |
| 想要 AI 但不想交出 Key | 双轨 AI：自带 Key（本地直连供应商）或使用所连服务端的平台积分 |

---

## 交付形态

| 端 | 形态 | 说明 |
| --- | --- | --- |
| Web | SPA | 浏览器直接访问，无需安装；营销首页 / 编辑器 / 个人中心 / 管理后台 / 公开分享页 |
| Windows | `.zip` 绿色版 / `.exe` 安装包 | Electron 45，免安装包不写注册表；安装包注册 `.md` 文件关联 |
| Android | `.apk` | Capacitor 8 壳工程，手机与平板通用 |

---

## 功能特性

### 编辑与写作

- **四种编辑模式**：所见即所得（Tiptap 3）、源码（CodeMirror 6）、双栏对照、阅读视图，下拉切换或 `Ctrl+E` 快捷切换。
- **Markdown 保真往返**：`markdown-bridge.ts` 自行实现 `md → html → md`，表格、任务列表、Frontmatter、代码块语言、嵌套列表在模式切换时不失真。
- **多标签页与右键菜单**：双击关闭、锁定阅读视图、源码模式、分屏、查找、替换、重命名、复制路径、关闭全部 / 其他 / 右侧。
- **可配置工作区布局**：左侧栏支持文件列表 / 大纲 / 「上大纲下文件」三种模式；功能区可置于最左、最右或状态栏两侧；右侧栏区块可自由勾选与排序。
- **命令面板与全库搜索**：`Ctrl+P` 命令面板，`Ctrl+Shift+F` 全库检索（MiniSearch 中文二元分词 + 模糊匹配）。
- **自定义快捷键**：内置 36 个命令默认绑定（含 `Ctrl+1`~`Ctrl+6` 标题），浏览器占用冲突时主动提示。
- **页宽与排版**：四档页宽（620 / 760 / 1080 / 铺满）、行号、5 套配色 + 自定义。
- **导出与发布**：PDF、Word（`.docx`）、单文件 HTML；可一键发布为静态网页。

### 仓库、同步与版本

- **双适配器仓库**：桌面端 / Android 经原生桥读写本机文件夹；网页端与配置了对象存储的客户端使用按用户隔离的云端仓库（IndexedDB 兜底）。
- **多云 S3 同步**：原生适配阿里云 OSS、腾讯云 COS、火山引擎 TOS、百度云 BOS、京东云、金山云 KS3 及自定义 S3。
- **内容寻址 + 三方合并**：blob 以 SHA-256 内容寻址且不可变，并发写与断点续传天然安全；冲突时用共同祖先做三方合并，可另存为新文件或采用远端版本。
- **版本历史**：每次保存自动留痕，时间线对比与任意版本恢复；历史可同步至对象存储。
- **文档身份稳定**：`docId` 恒定，重命名 / 移动不改变它，反向链接与历史版本自动跟随。

### Obsidian 仓库导入

从 Obsidian 平滑迁移整个仓库，而不是逐个文件手工复制。**1.1.0 新增**。

- **整仓导入**：选择 Obsidian 仓库目录 → 设定目标文件夹 → 一键导入，支持把多个外部仓库合并进同一 Neo MD 仓库。
- **保留时间线**：可选保留源文件的修改 / 创建时间，否则所有笔记会被压平成导入当天，历史版本排序与「最近打开」会全部失真。
- **语法转换**（逐项可关）：
  - `![[image.png]]` 嵌入资源 → 相对路径图片引用；
  - `%%注释%%` → HTML 注释（否则会被当成正文显示）；
  - `> [!note]` callout → 引用块 + 粗体标题；
  - `==高亮==` → `<mark>`；
  - `- [ ]` 任务列表 → 标准 GFM 任务列表；
  - 硬换行（行尾空格 / 单个换行）→ CommonMark 两空格换行。
- **安全跳过**：自动忽略 `.obsidian/`、`.trash/` 等配置目录。
- **同名策略**：冲突时可选 `rename`（重命名）/ `overwrite`（覆盖）/ `skip`（跳过）。
- **可选报告**：导入结束给出汇总（总数 / 已导入 / 已转换 / 跳过 / 失败 / 耗时）与逐文件明细，每条记录列出该文件实际应用了哪些转换，失败项附原因。

> 为什么需要转换：Obsidian 的 Markdown 有多处与 CommonMark 不完全一致，直接拷贝会出现**换行丢失、嵌入资源裂图、callout 与注释被当成正文显示**。迁移细节见 [用户指南](./docs/USER_GUIDE.md#一从-obsidian-迁移)。

### AI 能力

- **双轨 AI 引擎**：① 平台积分模式——由所连服务端配置多家供应商密钥、优先级队列与计费方式（按 tokens / 按次 / 免费），用户用积分消费；② 自带 Key 模式——内置 DeepSeek、小米 MiMo、通义千问、腾讯混元、智谱、火山方舟、百度千帆 7 家预设，动态拉取 `/models`。
- **AI 标题、润色、排版**：流式输出，可开关「带正文上下文」。
- **密钥安全**：用户填写的对象存储密钥与 AI Key 在服务端以 AES-256-GCM 加密存储，接口永不回传明文。

### AI 知识库

让 AI 基于**你自己的全部笔记**回答，而不是只看当前文档。**1.1.0 新增，纯前端实现**。

- **五种切片颗粒度**：按语义单位分级，不同问题类型适用不同颗粒度。

  | 颗粒度 | 切分依据 | 适合场景 |
  | --- | --- | --- |
  | `heading` | 按 H1–H6 标题 | 长文、结构化文档；保留完整章节上下文 |
  | `paragraph` | 按段落（空行分隔） | **默认推荐**，检索精度与上下文兼顾 |
  | `sentence` | 按句（`。！？；` 与换行） | 精确问答与原文定位 |
  | `block` | 固定字符数滑动窗口 | 无结构长文、日记流 |
  | `doc` | 整篇文档一个切片 | 摘要类、概括类问答 |

- **检索调优**：`topK`（1–30，单次返回片段数）、`minScore`（0–1，相关性阈值）、`searchMode`（关键词 / 混合 / 向量）三项可直接在界面上调，边调边看效果。
- **范围可控**：支持排除目录前缀（如 `日记/`、`归档/`）与排除标签（如 `private`），被排除的内容不会进入知识库。
  - `block` 粒度还可设 `chunkSize`（200–4000）与 `chunkOverlap`（0–500），避免句子被腰斩；
  - 单文档纳入上限 `maxDocChars` 防止超大文件拖垮索引；
  - `autoIndex` 开启后文件变动会自动增量重建该文档的切片；
  - `maxContextChunks` 控制注入 AI 上下文时最多携带多少片段（直接决定回答质量与 token 消耗）。
- **索引不出本机**：切片与索引**完全在前端完成**，服务端只做 AI 请求转发，**不落库、不存储用户文档正文**。

> 五种颗粒度分别适合什么场景、`topK` / `minScore` 怎么调，见 [用户指南](./docs/USER_GUIDE.md#二使用-ai-知识库)。自建服务端的相关接口与数据边界见 [部署指南](./docs/DEPLOYMENT.md#十四知识库-api)。

### 思维导图与流程图

在编辑器内直接画图，图作为仓库内的一等公民文件被同步与版本管理。**1.1.0 新增，纯前端实现**。

- **两种图类型**：思维导图（`.mind`）与流程图（`.flow`），保存为 **JSON 文件**——因此可以随仓库被 S3 同步、跨设备打开、纳入版本历史回滚，也能用文本 diff 审阅结构变化。
- **10 种节点形状**：矩形、圆角矩形、椭圆、菱形、平行四边形、六边形、圆柱、文档、圆形、纯文本。
- **连线**：5 种端点箭头（无 / 箭头 / 三角 / 圆点 / 菱形，起终点可分别设置）、3 种线型（实线 / 虚线 / 点线）、6 种锚点（上 / 右 / 下 / 左 / 中心 / 自动），支持正交折线与曲线、连线标签、自由端点。
- **思维导图**：4 种布局方向（右 / 左 / 双向 / 向下）、节点层级与折叠。
- **画布**：背景网格（无 / 点 / 线）、网格大小、显示网格、吸附网格、缩放平移。
- **编辑器设置**：默认布局方向（`mindmapLayout`）、默认网格（`grid`）、是否吸附（`snapToGrid`）、网格大小（`gridSize`）、默认节点填充色（`nodeFill`）/ 描边色（`nodeStroke`）/ 连线色（`edgeStroke`）、自动保存（`autoSave`）、小地图（`showMinimap`）。

> 坐标系统一使用**画布世界坐标**，缩放与平移只影响视图矩阵，因此拖拽、对齐与导出都以节点自身的 `x/y/w/h` 为准。画布操作见 [用户指南](./docs/USER_GUIDE.md#三使用思维导图与流程图)。

### 分享、协作与插件

- **公开分享页**：免登录链接，访客可阅读、评价并划词标注；支持访问密码与自定义品牌页眉。
- **插件开放平台**：内置 24 款可开关核心插件，并提供**免编译**的 JavaScript Plugin SDK —— 单文件即可编写插件，可通过 AI 生成、本地导入运行或发布到插件市场。详见 [插件开发指南](./PLUGIN_DEVELOPMENT_GUIDE.md)。
- **企业运营后台**：用户管理、兑换码、AI 优先级、计费与赠送、分享审核、发布管理、插件审核、客户端分发、审计日志。

> **关于插件市场（应用商店）**：插件市场**始终使用官方统一服务**，不支持私有化部署。自建服务端只接管账号、同步、分享、发布等数据接口，插件市场的浏览、下载与发布仍由官方服务提供。

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | Vue 3.5 · Vite 7 · Pinia 3 · Vue Router 4 · TypeScript 5.9 · vue-tsc 3 |
| 编辑器 | Tiptap 3（ProseMirror） · CodeMirror 6 · markdown-it 15 · lowlight |
| 本地数据 | sql.js（WASM SQLite） · MiniSearch 7 · IndexedDB |
| 同步 | 自研 S3 客户端（AWS Signature V4）· 内容寻址 + 三方合并 |
| 知识库检索 | 纯前端：切片器 + MiniSearch 倒排索引 + 相关性打分（`packages/core/src/knowledge/`），无外部向量库 |
| 图引擎 | 纯前端：自研画布渲染与布局（`packages/core/src/diagram/`），图文档为 JSON，无第三方图形库 |
| 桌面 / 移动 | Electron 45 · Capacitor 8 · Gradle / Android SDK 35 |
| 服务端 | Fastify 5 · MySQL 8（utf8mb4）· mysql2 · Argon2id · JWT · zod 4 |
| 测试 / CI | Vitest 3 · Playwright（工具脚本）· GitHub Actions |

**关于「纯前端实现」**：知识库的切片、索引、检索与图的渲染、布局全部在客户端完成，**不依赖任何第三方检索服务、图形库或向量数据库**。服务端在这两项能力上只承担一件事——转发 AI 请求（知识库）或什么都不做（绘图）。这保证：

- 笔记内容不需要上传即可被检索与画图；
- 自建部署时无需额外搭建 Elasticsearch / Milvus / 图数据库等组件；
- 离线状态下知识库检索与绘图照常可用（仅 AI 问答需要联网）。

---

## 目录结构

```text
neomd-V1/
├─ packages/
│  ├─ shared/        # 领域类型、AI / 存储预设、内置插件清单、命名与格式化工具
│  ├─ core/          # 编辑器内核：仓库适配器、Markdown 桥、索引、搜索、S3、同步、AI、导出
│  │  ├─ import/     # Obsidian 仓库导入：扫描、语法转换、冲突处理、报告生成（1.1.0）
│  │  ├─ knowledge/  # AI 知识库：切片器、倒排索引、相关性检索与上下文拼装（1.1.0）
│  │  └─ diagram/    # 图引擎：节点 / 连线模型、布局、命中测试、序列化（1.1.0）
│  └─ ui/            # 设计令牌（CSS 变量）与通用组件（图标、模态框、开关、选择器）
├─ apps/
│  ├─ web/           # Vue 3 SPA：营销首页、编辑器、个人中心、登录、管理后台、分享页
│  │  └─ src/
│  │     └─ components/
│  │        └─ diagram/   # 思维导图 / 流程图编辑器 UI：画布、节点、连线、属性面板（1.1.0）
│  ├─ desktop/       # Electron 主进程 / preload / 打包脚本
│  └─ android/       # Capacitor 壳工程与 APK 构建脚本
├─ services/
│  └─ api/           # Fastify 后端：认证、资料、积分、设置、分享、发布、上传、AI 代理、插件、后台
├─ tools/            # 部署打包、客户端发布、端到端验证脚本
├─ docs/             # 部署、自建与用户文档
└─ dist-artifacts/   # 构建产物输出（已 gitignore）
```

包清单以 [`pnpm-workspace.yaml`](./pnpm-workspace.yaml) 为准：`packages/*`、`apps/web`、`apps/desktop`、`apps/android`、`services/api`。

---

## 快速开始

### 环境要求

| 组件 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | ≥ 20.19（README 与 CI 在 24.x 验证） | 全部 |
| pnpm | 12.x | 依赖与工作区管理 |
| MySQL | 8.0（utf8mb4） | 仅在需要账号 / 分享 / 发布等云端能力时 |
| JDK 21 + Android SDK 35 | 可选 | 仅 Android APK 构建 |
| 现代浏览器 | Chromium / Firefox / Safari | 网页端 |

### 安装与开发

```bash
# 克隆后进入仓库根目录
pnpm install

# 网页版开发服务器（http://127.0.0.1:5178，/api 自动代理到 3200）
pnpm dev

# 后端（http://127.0.0.1:3200）
pnpm --filter @neomd/api dev

# 桌面端（Electron）
pnpm dev:desktop
```

### 开发与测试

```bash
pnpm exec vitest run                                  # 单元测试（Markdown 往返 / 解析 / 命名 / 格式化）
pnpm --filter @neomd/web exec vue-tsc --noEmit -p tsconfig.json   # 前端类型检查
pnpm --filter @neomd/web build                        # 前端产物（三端共用）
```

> 类型检查在仓库根目录执行时请使用 `pnpm --filter`（见上），因为 `vue-tsc` 是 `apps/web` 的 devDependency，根 `node_modules/.bin` 下没有该命令。

### 构建安装包

```bash
pnpm --filter @neomd/desktop build    # Windows 绿色版 zip + 安装包 exe → dist-artifacts/
pnpm --filter @neomd/android build    # Android APK → dist-artifacts/
```

---

## 部署

完整步骤见 **[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)**（服务器要求、MySQL 建库、`.env` 全字段说明、宝塔 Node 项目、Nginx 反代、对象存储、首次启动与管理员、常见问题）。

最小可运行路径：

```bash
# 1. 服务端
cd services/api
cp .env.example .env          # 按 docs/DEPLOYMENT.md 填写，密钥一律用随机值
pnpm install --prod
node src/server.js            # 首次启动自动建表并创建管理员

# 2. 前端
pnpm --filter @neomd/web build
# 把 apps/web/dist 交给 Nginx 托管，/api 反代到 127.0.0.1:3200
```

### 部署拓扑（结构示意）

```text
用户 ──TLS──> Nginx（域名 + 证书）
                ├─ /          → 前端静态产物目录（SPA，未命中回退 index.html）
                └─ /api/*     → 反向代理 127.0.0.1:3200
                                  └─ Fastify 服务 ──> MySQL 8（127.0.0.1:3306）
                                                  └─> 对象存储（S3 兼容，启动必填）
```

> 注意：服务端在读取配置时会对 `OSS_BUCKET` / `OSS_AK` / `OSS_SK` 做必填校验，缺失时进程直接退出。可先用占位值启动，但头像、备份、发布与客户端分发包等依赖对象存储的功能不可用。详见部署文档。

---

## PC 端自定义服务器（1.0.2）

1.0.2 起，桌面端支持把「数据平面」指向你自己部署的服务端，而不再依赖官方实例：

1. 先按 [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) 部署好服务端，确认 `https://你的域名/api/health` 返回 `ok: true`。
2. 打开 PC 客户端 → **设置 → 服务器**。
3. 在地址栏填入服务端根地址（例如 `https://md.example.com`，或内网 `http://192.168.1.10:3200`），保存并测试连通性。
4. 之后登录、账号资料、云端设置、分享与发布请求都会发往该地址；留空则回退到默认官方服务。

细节与排错见 **[docs/SELF_HOSTING.md](./docs/SELF_HOSTING.md)**。

> 插件市场不受该设置影响，始终使用官方统一服务。

---

## 贡献指南

欢迎 Issue 与 Pull Request。提交前请阅读 **[CONTRIBUTING.md](./CONTRIBUTING.md)**，其中包含分支模型、提交信息规范、本地校验清单与代码约定。

安全漏洞请勿公开提交 Issue，按 **[SECURITY.md](./SECURITY.md)** 的流程私下报告。

---

## License

[MIT](./LICENSE) © 2026 Neo MD Contributors

你可以自由使用、修改、分发与商用本项目，包括私有化部署。唯一要求是保留版权声明与许可声明。
