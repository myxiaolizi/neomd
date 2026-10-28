# 贡献指南

感谢你愿意为 Neo MD 出力。本文说明参与方式、本地开发约定与提交前的自检清单。

- 参与本项目即表示你同意遵守 [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) 行为准则：友善、就事论事、不人身攻击。
- 本项目使用 [MIT 许可证](./LICENSE)。提交 PR 即表示你同意以同一许可证授权你的贡献。

---

## 一、你可以怎么参与

| 方式 | 说明 |
| --- | --- |
| 报 Bug | 提 Issue，附版本号、操作系统、复现步骤与日志 |
| 提需求 | 提 Issue 说明使用场景，而不是只给结论 |
| 写代码 | 修 Bug / 加功能，先开 Issue 对齐方案再动手 |
| 写文档 | 部署、排错、插件示例都非常欢迎 |
| 写插件 | 见 [插件开发指南](./PLUGIN_DEVELOPMENT_GUIDE.md)，无需改主仓库 |
| 做翻译 | 文档与界面文案 |

**开始写代码前请先开 Issue**。避免你花两天写的功能因为架构方向不一致被拒。

---

## 二、开发环境

| 组件 | 版本 |
| --- | --- |
| Node.js | ≥ 20.19（CI 用 24.x） |
| pnpm | 12.x |
| MySQL | 8.0（只改前端可不装） |
| JDK 21 + Android SDK 35 | 只在构建 APK 时需要 |

```bash
git clone <repo-url>
cd neomd
pnpm install

pnpm dev                                    # 前端 http://127.0.0.1:5178
pnpm --filter @neomd/api dev                # 后端 http://127.0.0.1:3200
pnpm dev:desktop                            # 桌面端
```

前端开发服务器已把 `/api` 代理到 `127.0.0.1:3200`，本地调试无需处理跨域。

---

## 三、分支与提交

### 3.1 分支命名

```text
feat/<简短描述>      新功能
fix/<简短描述>       缺陷修复
docs/<简短描述>      文档
refactor/<简短描述>  重构（无行为变化）
chore/<简短描述>     构建、依赖、工具链
```

### 3.2 提交信息

采用 Conventional Commits，一行标题 + 可选正文：

```text
fix(editor): 修正标题快捷键在对照模式下失效

Vue 的深层响应式代理会破坏 ProseMirror 事务对象引用，
改为 shallowRef 托管 Editor 实例后恢复。
```

类型：`feat` / `fix` / `docs` / `refactor` / `perf` / `test` / `build` / `chore`。

标题用中文或英文都可以，**同一 PR 内保持一致**。

### 3.3 PR 要求

- 一个 PR 只做一件事，避免「顺手重构」污染 diff；
- 描述里写清楚：改了什么、为什么改、怎么验证的；
- 涉及界面改动的，附截图或录屏；
- 涉及数据库结构的，说明迁移是否幂等、是否需要回滚方案。

---

## 四、提交前自检清单

在**仓库根目录**执行，三项都必须通过：

```bash
# 1. 单元测试（当前基线 30 个用例）
pnpm exec vitest run

# 2. 前端类型检查（基线 0 错误）
pnpm --filter @neomd/web exec vue-tsc --noEmit -p tsconfig.json

# 3. 前端构建
pnpm --filter @neomd/web build
```

> ⚠️ 类型检查**不要**在根目录直接写 `npx vue-tsc`：`vue-tsc` 是 `apps/web` 的 devDependency，根 `node_modules/.bin` 下没有该命令，会报 `'vue-tsc' is not recognized`。请使用上面的 `pnpm --filter` 形式（`apps/web/package.json` 里也提供了等价的 `pnpm --filter @neomd/web typecheck`）。

如果改动了后端，再补一次冒烟：

```bash
cd services/api
NODE_ENV=development node src/server.js
curl -s http://127.0.0.1:3200/api/health
```

CI（`.github/workflows/ci.yml`）会跑同样的三件事，本地通过即基本不会红。

---

## 五、代码约定

### 5.1 分层与依赖方向

```text
apps/web ──> packages/core ──> packages/shared
    │              │
    └──────────────┴──> packages/ui（仅样式与通用组件）
services/api（纯 ESM JavaScript，不依赖 packages/*）
```

- `packages/shared` 保持零外部重依赖，只放类型、常量、纯函数；
- `packages/core` 不依赖任何 Vue / DOM 之外的具体 UI 框架，保证桌面端、Android、Web 三端复用；
- 前端**不要**直接 `import` 后端源码，反之亦然。

### 5.2 Tiptap 与 Vue 响应式（高频踩坑）

`apps/web/src/components/editor/WysiwygEditor.vue` 中的 Tiptap `Editor` 实例**必须**用 `shallowRef<Editor | null>(null)` 保存，绝不能用深层 `ref()`。

原因：Vue 的 Proxy 包装会破坏 ProseMirror 内部事务对象引用，执行标题快捷键（`Ctrl+1`~`Ctrl+6`）或格式化命令时会抛 `RangeError: Applying a mismatched transaction`。

### 5.3 Vue 模板里不要直接访问全局对象

Vue 3 模板渲染代理白名单**不包含** `window` / `navigator` / `document`。在模板里写 `window.innerWidth` 或 `navigator.clipboard` 会报错。

正确做法：在 `<script setup>` 中封装成函数或 `computed`，模板只调用它。需要窗口尺寸时用 `globalThis.innerWidth`。

### 5.4 桌面端与移动端的 API 地址

所有前端请求必须经 `apps/web/src/api/client.ts` 的 `resolveApiUrl()`。不要自己拼 `fetch('/api/...')`：桌面端运行在 `neomd://neomd/app`、Android 运行在 `capacitor://localhost`，相对路径会命中本地静态协议并返回 `index.html`（表现为「请求失败 (200)」）。

### 5.5 中文编码

**不要在 PowerShell 5.1 下用 `Set-Content -Encoding UTF8` 写含中文的源文件**：它会把无 BOM 的 UTF-8 按 GBK 读入再写回，产生不可逆乱码。

改用：

```powershell
[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
```

或者直接用编辑器保存为 UTF-8（无 BOM）。

### 5.6 依赖与版本

- 新增依赖前先说明理由，优先用现有依赖解决；
- 提交 `pnpm-lock.yaml` 的变更；
- `package.json` 的版本号由维护者在发版时统一修改，**PR 里不要改版本号**。

### 5.7 安全红线

- **绝不在代码、文档、测试、示例、截图、Issue、PR 中出现真实凭据**（数据库密码、对象存储 AK/SK、JWT 密钥、管理员密码、第三方 API Key）；
- 示例配置一律用占位符，如 `change-me`、`replace-with-64-hex-chars`；
- 新增环境变量时同步更新 `services/api/.env.example`；
- 涉及用户密钥的功能，必须经服务端 `SECRETS_KEY` 加密后再落库，接口不得回传明文。

---

## 六、文档贡献

- 文档一律中文，路径、命令、代码块、变量名保留英文；
- 命令示例给出可直接复制执行的完整形式；
- 涉及部署的改动，同步更新 [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)；
- 涉及客户端连接方式的改动，同步更新 [docs/SELF_HOSTING.md](./docs/SELF_HOSTING.md)。

---

## 七、插件贡献

插件不必进主仓库：

1. 按 [插件开发指南](./PLUGIN_DEVELOPMENT_GUIDE.md) 写一个单文件 `.js`；
2. 本地导入验证（个人中心 → 插件市场与开放平台 → 导入本地插件脚本）；
3. 直接发布到插件市场，或提 PR 把示例补充进文档。

> 注意：**插件市场是官方统一服务，不接受"自建私有市场"的 PR**。

---

## 八、发版与 Release（维护者）

发版是维护者操作，贡献者只需在 PR 里写好变更说明，**不要动版本号与 CHANGELOG**。

### 8.1 三条铁律

1. **`CHANGELOG.md` 的改动必须随版本一起进主分支**，不能只在本地写。
2. **产物必须在所有代码修复落盘之后再构建**。本项目曾两次出现「产物落后于源码」（1.1.1 → 重发 1.1.2、1.1.5 → 重发 1.1.6），根因都是构建早于最后一处修复。
3. **token 只走环境变量，绝不写进任何文件**。见 [5.7 安全红线](#57-安全红线)。

### 8.2 发布命令

```bash
# 1) 先演练：不联网、不需要 token，检查版本段能否解析、产物是否齐全
node tools/publish-github-release.mjs --dry-run

# 2) 配置凭据（仅当前终端会话有效）
#    PowerShell：$env:GITHUB_TOKEN="ghp_xxx"; $env:GITHUB_REPO="owner/repo"
#    Bash：      export GITHUB_TOKEN="ghp_xxx"; export GITHUB_REPO="owner/repo"

# 3) 正式发布（幂等，可反复执行）
node tools/publish-github-release.mjs
```

也可以只推 tag，让 [`.github/workflows/release.yml`](./.github/workflows/release.yml) 自动发布：
CI 会先跑类型检查与单元测试，**通过后**才创建 Release 并上传产物。

完整流程（升版本号要改哪几个文件、产物怎么构建、发布后如何验收、常见报错怎么处理）见
[docs/DEPLOYMENT.md → 十五、版本发布流程](./docs/DEPLOYMENT.md#十五版本发布流程同步到-github-与-releases)。

---

## 九、Issue 提交清单

请包含：

- Neo MD 版本（设置 → 关于 / `package.json`）
- 端与系统（Windows 11 / Android 14 / Chrome 130 / ...）
- 复现步骤（1、2、3）
- 期望结果 vs 实际结果
- 控制台报错与日志片段（**先脱敏**：删掉 token、cookie、AK/SK、密码）

安全漏洞请走 [SECURITY.md](./SECURITY.md) 的私下渠道，不要开公开 Issue。
