# Neo MD 1.2.1 — 发布与部署链路审计（命令清单 + 坑位清单）

> 审计员：只读代码与只跑只读命令，未修改任何源码。
> 基准版本：1.2.0（根 `package.json` version = `1.2.0`）。
> 产出日期：2026-10-30。

---

## 一、版本号清单 — 1.2.1 必须同步改的**全部**位置

通过 `grep -r 1.2.0` 全仓库扫描（排除 `node_modules/`、`dist-artifacts/`、`docs/` 历史文件、`pnpm-lock.yaml`），得到以下**必须同步改**的文件与位置：

| # | 文件 | 位置类型 | 当前值 | 改法 |
|---|------|---------|--------|------|
| 1 | `package.json` | `"version": "1.2.0"` | 根 workspace 包 | `release-119.mjs version --to 1.2.1` |
| 2 | `apps/web/package.json` | `"version": "1.2.0"` | Web 子包 | 同上 |
| 3 | `apps/desktop/package.json` | `"version": "1.2.0"` | 桌面子包 | 同上 |
| 4 | `apps/android/package.json` | `"version": "1.2.0"` | Android 子包 | 同上 |
| 5 | `services/api/package.json` | `"version": "1.2.0"` | API 子包 | 同上 |
| 6 | `apps/web/src/env.ts` | `APP_VERSION = '1.2.0'` | 前端显示版本号 | 由脚本自动替换 |
| 7 | `apps/web/src/env.ts` | `NeoMD-1.2.0-win-x64.zip` 等 3 个下载 URL | 前端下载链接 | 由脚本自动替换 |
| 8 | `apps/desktop/build.mjs` | 产物名从 `package.json` 动态推导 | **无硬编码**（1.2.0 已改） | 不需要改 |
| 9 | `apps/android/build.mjs` | `NeoMD-1.2.0.apk` 硬编码（L159） | **有硬编码** | 由脚本自动替换 |
| 10 | `apps/web/vite.config.ts` | `__APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '1.0.0')` | 由 Vite 构建时注入 | **不需要改**（读 pnpm workspace 版本） |
| 11 | `CHANGELOG.md` | `## [1.2.0]` 顶部段落 | 需新增 `## [1.2.1]` 段落 | **手动添加** |

### 额外发现 — 不属 `release-119.mjs` TARGETS 清单但需关注的：

| # | 文件 | 说明 |
|---|------|------|
| A | `services/api/src/routes/plugins.js` L80, L88 | 社区插件示例 `version: '1.2.0'`（番茄专注时钟）— 这是**插件示例数据**，非产品版本，**不需要改** |
| B | `apps/desktop/main.cjs` L35 | `const APP_VERSION = require('./package.json').version` — 运行时读包，**不需要改** |
| C | `apps/desktop/preload.cjs` L124 | `process.env.npm_package_version || '1.0.0'` — 构建时注入，**不需要改** |
| D | `services/api/src/config.js` L89-96 | `readVersion()` 读 `services/api/package.json` — **不需要改** |

### 结论：`release-119.mjs` 的 TARGETS 数组覆盖全部必须改的位置

```javascript
// tools/release-119.mjs TARGETS（共 9 项）：
[
  { file: 'package.json', kind: 'package-json' },
  { file: 'apps/web/package.json', kind: 'package-json' },
  { file: 'apps/desktop/package.json', kind: 'package-json' },
  { file: 'apps/android/package.json', kind: 'package-json' },
  { file: 'services/api/package.json', kind: 'package-json' },
  { file: 'apps/web/src/env.ts', kind: 'env-version' },
  { file: 'apps/desktop/build.mjs', kind: 'artifact-name' },
  { file: 'apps/android/build.mjs', kind: 'artifact-name' },
]
```

### 升级版本号的完整命令

```powershell
cd C:\Data\BAC\neomd\neomd-V1

# 1. 预览改动（不写盘）
node tools/release-119.mjs version --to 1.2.1 --dry-run

# 2. 实际写入
node tools/release-119.mjs version --to 1.2.1

# 3. 手动编辑 CHANGELOG.md：在顶部新增 ## [1.2.1] 段落

# 4. 校验一致性
node tools/release-119.mjs check
```

---

## 二、`release-119.mjs check` 校验的 9 项 — 实测结果

### 实际跑一次 `check` 子命令

```
PS> node tools/release-119.mjs check
以根 package.json 为准：1.2.0
  ✓ package.json：1.2.0
  ✓ apps/web/package.json：1.2.0
  ✓ apps/desktop/package.json：1.2.0
  ✓ apps/android/package.json：1.2.0
  ✓ services/api/package.json：1.2.0
  ✓ apps/web/src/env.ts：1.2.0
  ✓ apps/desktop/build.mjs：1.2.0（从 package.json 动态推导，无硬编码）
  ✓ apps/android/build.mjs：1.2.0
  ✓ CHANGELOG.md 顶部段落：1.2.0

版本一致性校验通过。
```

### 9 项校验的详细说明

| # | 校验项 | 校验逻辑 | 1.2.1 是否适用 |
|---|--------|---------|---------------|
| 1 | `package.json` version | 解析 JSON 取 `.version` | ✅ |
| 2 | `apps/web/package.json` | 同上 | ✅ |
| 3 | `apps/desktop/package.json` | 同上 | ✅ |
| 4 | `apps/android/package.json` | 同上 | ✅ |
| 5 | `services/api/package.json` | 同上 | ✅ |
| 6 | `apps/web/src/env.ts` | 正则 `APP_VERSION = '(\d+.\d+.\d+)'` | ✅ |
| 7 | `apps/desktop/build.mjs` | 剥注释后正则 `NeoMD-(\d+(?:\.\d+)*?)(?=-|\.(?:apk\|exe\|zip\|dmg\|msi))`；若未命中但代码含 `${version}` / `pkg.version` 等动态推导特征 → **判通过** | ✅（1.2.0 已改为动态推导，注释里历史版本号不触发失败） |
| 8 | `apps/android/build.mjs` | 同上，但**有硬编码** L159 `NeoMD-1.2.0.apk`，会匹配到版本号 | ✅ |
| 9 | `CHANGELOG.md` | 正则 `^##\s*\[(\d+.\d+.\d+)\]` 匹配顶部第一个版本标题 | ✅ |

### 能否用于 1.2.1？

**可以**。`check` 子命令不硬编码版本号，它读取当前 `package.json` 的 version 作为基准，逐项对比。只要 1.2.1 的 `package.json` 已升级为 `1.2.1`，`check` 就会校验所有 9 项是否都是 `1.2.1`。

**注意**：`check` 不会检查 `services/api/src/routes/plugins.js` 里的插件示例版本号，也不会检查 `CHANGELOG.md` 的内容正确性。

---

## 三、构建顺序与命令

### 完整构建链

```
pnpm install          ← 确保依赖就位
pnpm build:shared     ← @neomd/shared 构建（类型定义 + 工具函数）
pnpm build:core       ← @neomd/core 构建（同步引擎 + 存储层）
pnpm build:ui         ← @neomd/ui 构建（样式 + 组件）
pnpm build:web        ← @neomd/web 构建（Vite → dist/）
pnpm build:desktop    ← electron-builder（依赖 web dist/）
pnpm build:android    ← Capacitor + Gradle（依赖 web dist/）
tools/make-deploy.mjs ← 生成部署包
```

### 3.1 Web 构建

```powershell
cd C:\Data\BAC\neomd\neomd-V1
pnpm --filter @neomd/web build
# 等价：cd apps/web && npx vite build
```

- **产物路径**：`apps/web/dist/`（含 `index.html` + 带 hash 的 chunk）
- **耗时量级**：10-30 秒（取决于机器性能）
- **已知坑**：
  - `vite.config.ts` L98 的 `__APP_VERSION__` 由 `process.env.npm_package_version` 注入，Vite 的 monorepo 模式下这个环境变量**可能为空**（fallback 到 `'1.0.0'`）。实测中 pnpm build 不会自动注入 workspace 包的 version 到环境变量，因此 `__APP_VERSION__` 很可能落到 `'1.0.0'`。**这不是致命问题**（前端显示版本号主要靠 `env.ts` 的 `APP_VERSION`），但需要留意。
  - `env.ts` 中的 `APP_VERSION = '1.2.0'` 是硬编码的运行时常量。**不是**由 `__APP_VERSION__` 注入的。
  - Vite 构建**不做类型检查**，`vue-tsc --noEmit` 需单独跑（1.1.9 教训）。

### 3.2 桌面端构建

```powershell
cd C:\Data\BAC\neomd\neomd-V1\apps\desktop
node build.mjs
```

- **产物路径**：
  - `dist-artifacts/NeoMD-<version>-setup.exe`（NSIS 安装包）
  - `dist-artifacts/NeoMD-<version>-win-x64.zip`（绿色版，由 `tar -a -c -f` 从 `win-unpacked/` 生成）
  - 中间产物：`dist-artifacts/win-unpacked/`
- **耗时量级**：2-5 分钟（electron-builder 打包 + 绿色版压缩）
- **已知坑**：
  - **ELECTRON_MIRROR**：脚本 L56 设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，国内必须走这个镜像，否则 electron 二进制下载超时。
  - **ELECTRON_BUILDER_BINARIES_MIRROR**：L57 设置 `https://npmmirror.com/mirrors/electron-builder-binaries/`，同上。
  - **ELECTRON_RUN_AS_NODE**：本脚本未显式设置，但 electron-builder 在某些 Windows 环境下需要。若遇到 "electron is not recognized" 错误，尝试 `set ELECTRON_RUN_AS_NODE=1`。
  - **绿色版压缩静默失败**：`build.mjs` L101-107 的 `tar -a` 命令以前只打印错误但退出码仍 0（假成功）。**1.2.0 已修复**：L103-107 捕获异常后 `process.exit(1)`，且 L108-111 检查产物是否存在。但仍需留意 `tar` 命令在 Windows 上是否可用（Win10+ 自带 bsdtar）。
  - **portable.cjs 打包白名单**：`electron-builder.config.cjs` L28 的 `files` 白名单必须包含 `portable.cjs`，否则打包后 `MODULE_NOT_FOUND`。1.2.0 已确认包含。

### 3.3 Android 构建

```powershell
cd C:\Data\BAC\neomd\neomd-V1\apps\android
node build.mjs
```

- **产物路径**：`dist-artifacts/NeoMD-<version>.apk`（实际从 `android/app/build/outputs/apk/release/app-release.apk` 复制）
- **耗时量级**：5-15 分钟（Gradle 构建 + 签名）
- **前置依赖**：
  - JDK 21：`tools/jdk21/bin/java.exe`
  - Android SDK：`tools/android-sdk/`（含 `platforms/android-35`、`build-tools/35.0.0`）
  - 由 `tools/setup-toolchain.ps1` 准备
- **已知坑**：
  - **L159 硬编码文件名**：`const target = path.join(outDir, 'NeoMD-1.2.0.apk')` — **必须用 `release-119.mjs version --to 1.2.1` 更新**。
  - **ANDROID_KEYSTORE_PASSWORD**：签名密钥生成/使用需要此环境变量（L69-74）。若缺失且 keystore 不存在 → 报错退出。
  - **Gradle 缓存**：`GRADLE_USER_HOME=tools/.gradle`，首次构建需下载依赖。
  - **首次工程初始化**：若 `android/app/` 不存在 → 先跑 `npx cap add android`。
  - **签名配置注入**：L106-141 会修改 `android/app/build.gradle`，注入 keystore 签名。这是幂等的（检查 `keystorePropsFile` 是否已存在）。

### 3.4 部署包生成

```powershell
cd C:\Data\BAC\neomd\neomd-V1
node tools/make-deploy.mjs
```

- **产物**：`dist-artifacts/neomd-deploy.tar.gz`
- **构成**：`public/`（前端产物）+ `server/src/` + `server/package.json` + `server/.env`（已替换为生产配置）
- **耗时量级**：5-10 秒
- **已知坑**：
  - **依赖 `.env` 文件**：L42 读取 `services/api/.env`，若不存在 → 报错。
  - **WEB_ROOT 硬编码**：L47 写死 `WEB_ROOT=/www/wwwroot/md.zhengl.vip/public`，生产路径必须一致。
  - **tar 命令**：L73 用 Windows 自带 `tar`（Win10+），旧版 Windows 可能没有。

### 3.5 生产发布（上传 OSS）

```powershell
cd C:\Data\BAC\neomd\neomd-V1
$env:OSS_AK='<ak>'; $env:OSS_SK='<sk>'
node tools/publish-releases.mjs
```

- **作用**：上传 APK 到阿里云 OSS `mdadmin/releases/` 前缀，并开放匿名读取。
- **已知坑**：
  - **L92-96 硬编码 1.1.8 文件名**：`publish-releases.mjs` 的 `releases` 数组写死了 1.1.8 的文件名。如果要发布 1.2.1 的 APK，**需修改此脚本或手动上传**。
  - **需要 OSS_AK/OSS_SK 环境变量**。

---

## 四、GitHub 推送与 Release

### 4.1 Git 提交/打 tag/push

```powershell
cd C:\Data\BAC\neomd\neomd-V1

# 0. 代理设置（本项目硬性要求）
Remove-Item Env:HTTPS_PROXY,Env:HTTP_PROXY,Env:NODE_USE_ENV_PROXY -ErrorAction SilentlyContinue

# 1. 确认工作区干净
git status --porcelain
# 预期：无输出

# 2. 提交所有改动
git add -A
git commit -m "chore(release): 1.2.1 — <描述>"

# 3. 推送代码
git -c http.proxy=http://127.0.0.1:1886 push origin HEAD:refs/heads/main

# 4. 打 tag
git tag -a v1.2.1 -m "Neo MD 1.2.1"

# 5. 推送 tag
git -c http.proxy=http://127.0.0.1:1886 push origin refs/tags/v1.2.1

# 6. 验证 tag 指向 main 最新提交
git rev-list -n 1 v1.2.1
git rev-parse HEAD
# 预期：两行哈希相同
```

### 4.2 `publish-github-release.mjs` 参数与代理

```powershell
# 代理设置
$env:NODE_USE_ENV_PROXY='1'
$env:HTTPS_PROXY='http://127.0.0.1:1886'
$env:HTTP_PROXY='http://127.0.0.1:1886'

# Token 获取（从 git credential fill 读取，不落盘）
$in = "protocol=https`nhost=github.com`n`n"
$env:GITHUB_TOKEN = ((($in | git credential fill) | Where-Object { $_ -match '^password=' }) -replace '^password=','')

# 发布
node tools/publish-github-release.mjs --version=1.2.1 --repo=myxiaolizi/neomd --no-blockmap
```

**参数说明**：

| 参数 | 说明 |
|------|------|
| `--version=1.2.1` | 版本号（默认读 package.json） |
| `--repo=myxiaolizi/neomd` | 仓库（默认读 GITHUB_REPO 或 package.json） |
| `--no-blockmap` | 不上传 .blockmap（本项目无自动更新） |
| `--dry-run` | 演练模式，不联网 |
| `--skip-assets` | 只同步说明，不上传安装包 |
| `--proxy=URL` | 覆盖代理（默认 http://127.0.0.1:1886） |
| `--no-proxy` | 强制直连 |
| `--draft` | 发布为草稿 |
| `--all-versions` | 批量为 CHANGELOG 所有版本建 Release |

**代理要求**：
- 本机访问 GitHub **必须走** `http://127.0.0.1:1886`
- Node 24 的 `fetch`（undici）不读 `HTTPS_PROXY`，需设 `NODE_USE_ENV_PROXY=1`
- git 用 `-c http.proxy=...` 显式指定

**Token 来源**：
- 优先 `GITHUB_TOKEN` 环境变量
- 其次 `git credential fill`（Windows 凭据管理器）
- **绝不写文件**

### 4.3 v1.2.0 Release 现状（只读查询结果）

```
Tag:    v1.2.0
Name:   Neo MD v1.2.0
Draft:  false
Prerelease: false
Assets: 2
  1. NeoMD-1.2.0-setup.exe     113,184,892 B (107.9 MB)  — 下载 1 次
  2. NeoMD-1.2.0-win-x64.zip   159,308,688 B (151.9 MB)  — 下载 1 次
```

- Release 页面：https://github.com/myxiaolizi/neomd/releases/tag/v1.2.0
- 状态：正常发布，非草稿，非预发布
- 资产：2 个（无 APK，无 blockmap，符合预期）

---

## 五、生产部署步骤（基于 docs/DEPLOY-120.md 推导 1.2.1 部署流程）

### 5.1 部署前准备

```bash
# 在宝塔面板执行（或通过 SSH）

# 1. 确认当前版本
curl -s https://md.zhengl.vip/api/health | python -m json.tool
# 预期：version: "1.2.0", db: true

# 2. 备份（回滚依据）
BK=/www/backup/neomd-121-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BK"

# 备份 .env
cp /www/wwwroot/md.zhengl.vip/server/.env "$BK/.env.bak"

# 备份前端产物
cp -a /www/wwwroot/md.zhengl.vip/public "$BK/public.bak"

# 备份后端源码
tar -czf "$BK/server-src.tar.gz" -C /www/wwwroot/md.zhengl.vip/server .

# 备份 package.json
cp /www/wwwroot/md.zhengl.vip/server/package.json "$BK/package.json.bak"

# 备份 releases/ 目录
cp -a /www/wwwroot/md.zhengl.vip/server/releases "$BK/releases.bak"

echo "备份完成: $BK"
```

### 5.2 部署

```bash
# 3. 解压部署包到临时目录
rm -rf /tmp/neomd121 && mkdir -p /tmp/neomd121
tar -xzf /path/to/neomd-deploy.tar.gz -C /tmp/neomd121

# 4. 核对版本
cat /tmp/neomd121/server/package.json | grep version
# 预期：1.2.1

# 5. 部署前端（先删 assets 再覆盖）
cd /www/wwwroot/md.zhengl.vip
rm -rf public/assets
cp -a /tmp/neomd121/public/. public/

# 6. 部署后端源码（保留 .env 与 releases/）
rm -rf server/src
cp -a /tmp/neomd121/server/src server/src
cp -a /tmp/neomd121/server/package.json server/package.json

# 7. 权限
chown -R www:www public server/src server/package.json

# 8. 语法自检
for f in $(find server/src -name '*.js'); do node --check "$f" || echo "FAIL $f"; done
# 预期：无输出

# 9. 重启宝塔 Node 项目 neomd
#    通过宝塔面板操作：服务 → Node 项目 → neomd → 重启
```

### 5.3 部署后验证清单

| # | 验证项 | 命令 | 期望 |
|---|--------|------|------|
| 1 | `/api/health` 版本 | `curl -s https://md.zhengl.vip/api/health` | `version: "1.2.1"`, `db: true` |
| 2 | `.env` 完好 | `sha256sum /www/wwwroot/md.zhengl.vip/server/.env` | 与备份 `.env.bak` 的 sha256 一致 |
| 3 | `server/releases/` 完好 | `ls -la /www/wwwroot/md.zhengl.vip/server/releases/` | 存在，含历史 APK |
| 4 | 全部 JS 语法 | `find server/src -name '*.js' -exec node --check {} \;` | 0 失败 |
| 5 | 前端 index.html 引用 | `grep -o 'assets/[a-zA-Z0-9-]*\.js' public/index.html` | 引用的 chunk 存在于 public/assets/ |
| 6 | 关键接口冒烟 | `curl -s https://md.zhengl.vip/api/plugins/market | head -c 200` | 返回 JSON |
| 7 | 登录测试 | 浏览器登录 admin 账号 | 正常登录 |
| 8 | 同步测试 | 登录 → 点同步 → 观察状态 | 「已同步」，0 个直连 OSS 请求 |
| 9 | 桌面端下载 | 浏览器访问下载页 | 能下载 `NeoMD-1.2.1-win-x64.zip` |
| 10 | 磁盘空间 | `df -h /` | 使用率 < 80% |

---

## 六、发布前必须确认的检查项

| # | 检查项 | 验证命令 | 风险 |
|---|--------|---------|------|
| 1 | **版本号全仓库一致** | `node tools/release-119.mjs check` | 漏改 → 安装包名与版本不符 |
| 2 | **CHANGELOG 段落存在** | `grep -c '## \[1.2.1\]' CHANGELOG.md` | 至少 1 行；否则 Release body 用占位内容 |
| 3 | **CHANGELOG 与 package.json 版本一致** | `node tools/publish-github-release.mjs --dry-run` | 会打印警告 |
| 4 | **产物比源码新** | `stat -c '%Y %n' services/api/src/**/*.js apps/web/src/**/* apps/web/dist/index.html` | 产物 mtime 晚于源码 mtime |
| 5 | **构建假成功** | 检查 `dist-artifacts/` 中文件 mtime 与构建时间 | 上次构建失败但旧产物残留 |
| 6 | **绿色版产物存在** | `ls -la dist-artifacts/NeoMD-1.2.1-win-x64.zip` | 文件大小 ~150MB |
| 7 | **安装包产物存在** | `ls -la dist-artifacts/NeoMD-1.2.1-setup.exe` | 文件大小 ~108MB |
| 8 | **工作区干净** | `git status --porcelain` | 无未提交改动 |
| 9 | **代理可用** | `node -e "import('node:net').then(m=>{const s=new m.Socket();s.connect(1886,'127.0.0.1',()=>{console.log('OK');s.destroy()})})"` | 1886 端口可连通 |
| 10 | **GITHUB_TOKEN 可用** | `git -c http.proxy=http://127.0.0.1:1886 ls-remote origin` | 能读取仓库 |
| 11 | **tail 压缩不静默成功** | 检查 `tar -a` 退出码（1.2.0 已修复） | 旧版退出码 0 但产物缺失 |
| 12 | **Android SDK/JDK 路径** | `ls tools/jdk21/bin/java.exe tools/android-sdk/platforms` | 构建 Android 时需要 |

---

## 七、完整 1.2.1 发布命令清单（按顺序执行）

```powershell
# ═══════════════════════════════════════════════════════
# 阶段 0：升级版本号
# ═══════════════════════════════════════════════════════
cd C:\Data\BAC\neomd\neomd-V1

# 0.1 预览改动
node tools/release-119.mjs version --to 1.2.1 --dry-run

# 0.2 实际写入
node tools/release-119.mjs version --to 1.2.1

# 0.3 手动添加 CHANGELOG.md 顶部段落
#     在 "## [1.2.0]" 之前插入 "## [1.2.1] - <日期>" 及变更内容

# 0.4 校验一致性
node tools/release-119.mjs check
# 预期：9 项全 ✓ + "版本一致性校验通过。"


# ═══════════════════════════════════════════════════════
# 阶段 1：构建
# ═══════════════════════════════════════════════════════

# 1.1 安装依赖（若刚拉代码）
pnpm install

# 1.2 类型检查（可选但推荐，Vite 不检查类型）
pnpm typecheck
# 或：cd apps/web && npx vue-tsc --noEmit

# 1.3 Web 构建
pnpm --filter @neomd/web build
# 产物：apps/web/dist/

# 1.4 桌面端构建
cd apps\desktop && node build.mjs
# 产物：dist-artifacts/NeoMD-1.2.1-setup.exe + NeoMD-1.2.1-win-x64.zip

# 1.5 Android 构建（可选，若需要 APK）
cd ..\android && node build.mjs
# 产物：dist-artifacts/NeoMD-1.2.1.apk

# 1.6 部署包生成
cd ..\.. && node tools\make-deploy.mjs
# 产物：dist-artifacts/neomd-deploy.tar.gz


# ═══════════════════════════════════════════════════════
# 阶段 2：Git 推送
# ═══════════════════════════════════════════════════════

# 2.1 确认工作区干净
git status --porcelain
# 预期：无输出

# 2.2 提交
git add -A
git commit -m "chore(release): 1.2.1 — <描述>"

# 2.3 推送代码
Remove-Item Env:HTTPS_PROXY,Env:HTTP_PROXY,Env:NODE_USE_ENV_PROXY -ErrorAction SilentlyContinue
git -c http.proxy=http://127.0.0.1:1886 push origin HEAD:refs/heads/main

# 2.4 打 tag
git tag -a v1.2.1 -m "Neo MD 1.2.1"

# 2.5 推送 tag
git -c http.proxy=http://127.0.0.1:1886 push origin refs/tags/v1.2.1

# 2.6 验证 tag
git rev-list -n 1 v1.2.1
git rev-parse HEAD
# 预期：两行相同


# ═══════════════════════════════════════════════════════
# 阶段 3：GitHub Release
# ═══════════════════════════════════════════════════════

# 3.1 代理设置
$env:NODE_USE_ENV_PROXY='1'
$env:HTTPS_PROXY='http://127.0.0.1:1886'
$env:HTTP_PROXY='http://127.0.0.1:1886'

# 3.2 Token 获取
$in = "protocol=https`nhost=github.com`n`n"
$env:GITHUB_TOKEN = ((($in | git credential fill) | Where-Object { $_ -match '^password=' }) -replace '^password=','')

# 3.3 预览（dry-run）
node tools/publish-github-release.mjs --version=1.2.1 --repo=myxiaolizi/neomd --no-blockmap --dry-run

# 3.4 真实发布
node tools/publish-github-release.mjs --version=1.2.1 --repo=myxiaolizi/neomd --no-blockmap

# 3.5 验收
node tools/verify-119-github.mjs --version=1.2.1 --expect="1.2.1"
# 预期：全 ✓
```

---

## 八、风险最高的 5 个环节 + 规避动作

### 风险 1：版本号漏改（安装包里版本号与 CHANGELOG 不一致）

**场景**：改了 `package.json` 但忘了改 `apps/android/build.mjs` 的硬编码 `NeoMD-1.2.0.apk`。

**规避**：
- 必须跑 `node tools/release-119.mjs version --to 1.2.1` 统一改版本号
- 改完必跑 `node tools/release-119.mjs check`，9 项全绿才继续
- 特别注意 `apps/android/build.mjs` L159 的硬编码是 `artifact-name` 类型，脚本会替换

### 风险 2：绿色版 tar 压缩假成功（静默失败但退出码 0）

**场景**：`tar -a -c -f` 因磁盘满或权限问题失败，但旧版脚本不检查退出码。

**规避**：
- 1.2.0 已修复 L103-111 的退出码检查
- 但构建后仍需手动验证产物存在且大小合理：`ls -la dist-artifacts/NeoMD-1.2.1-win-x64.zip`
- 预期大小 ~150MB，若 < 10MB 说明压缩失败

### 风险 3：前端先删 assets 再复制 — 遗漏导致白屏

**场景**：部署时只 `cp -a public/. public/` 不删 `assets/`，旧 chunk 残留，新 `index.html` 引用旧资源 → 白屏。

**规避**：
- 必须先 `rm -rf public/assets` 再 `cp -a /tmp/neomd121/public/. public/`
- 验证 `grep -o 'assets/[a-zA-Z0-9-]*\.js' public/index.html` 引用的 chunk 都在 `public/assets/` 中

### 风险 4：代理间歇性 TLS 截断导致发布中断

**场景**：`git push` 或资产上传时遇到 TLS 记录被截断，表现为 `schannel: failed to receive handshake` 或 `fetch failed`。

**规避**：
- 清掉代理环境变量，只用 `-c` 显式指定：`Remove-Item Env:HTTPS_PROXY,Env:HTTP_PROXY,Env:NODE_USE_ENV_PROXY -ErrorAction SilentlyContinue`
- `fetch` / `push` / 资产上传加重试（最多 3 次，间隔 5 秒）
- 失败时先分层定位（TCP 探活 → CONNECT → TLS 握手 → 重试）

### 风险 5：`.env` 被覆盖导致服务连不上数据库

**场景**：部署包里的 `.env` 是本地配置，覆盖生产 `.env` 后数据库连不上。

**规避**：
- `make-deploy.mjs` 生成的 `.env` 已替换 `DB_HOST=127.0.0.1`、`PORT=3200`、`WEB_ROOT` 等
- 但生产数据库密码、OSS 密钥等仍不同
- **部署前必备份 `.env`**，部署后必校验 `.env` sha256 与备份一致
- 若用精简部署包（不含 `.env`），则无需担心此问题

---

## 附录 A：`publish-releases.mjs` 的已知问题

`tools/publish-releases.mjs` L92-96 硬编码了 1.1.8 的文件名：

```javascript
const releases = [
  { file: 'NeoMD-1.1.8-win-x64.zip', type: 'application/zip' },
  { file: 'NeoMD-1.1.8-setup.exe', type: 'application/vnd.microsoft.portable-executable' },
  { file: 'NeoMD-1.1.8.apk', type: 'application/vnd.android.package-archive' },
];
```

**1.2.1 发布时**：
- 若需要上传 APK 到 OSS，**需手动修改此脚本**为 1.2.1 文件名，或改用其他方式上传
- Windows 安装包和绿色版通常通过 GitHub Release 分发，不走此脚本

---

## 附录 B：`services/api/src/routes/plugins.js` 的插件示例版本

`plugins.js` L80, L88 中「番茄专注时钟」插件示例的 `version: '1.2.0'` 是**数据库初始化种子数据**，不是产品版本号。1.2.1 发布时**不需要改**。

---

> **审计结论**：1.2.1 的发布链路与 1.2.0 完全一致，核心差异在于 `apps/android/build.mjs` L159 的硬编码文件名（1.2.0 时 `apps/desktop/build.mjs` 已改为动态推导，但 `apps/android/build.mjs` 仍硬编码）。`release-119.mjs version --to 1.2.1` 会同时替换 5 个 `package.json`、`env.ts` 的 APP_VERSION 与下载 URL、以及 `android/build.mjs` 的 APK 文件名。改完后跑 `check` 即可确认一致性。
