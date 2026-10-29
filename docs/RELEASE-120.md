# 1.2.0 发布 Runbook

本文是 **1.2.0** 的发布操作手册。与 1.1.9 那次不同，这次**不需要重建历史**——仓库同步在 1.1.9 已经修好并通过验收，本次只是常规的「推代码 → 打 tag → 建 Release → 传资产 → 验收」。

每条命令都给出**预期输出**与**失败回滚**。全部命令在 PowerShell 下执行。

---

## 0. 本次发布的是什么

| 项 | 内容 |
|---|---|
| 版本 | `1.2.0`（`package.json` / 4 个 workspace 包 / `env.ts` 的 `APP_VERSION` / CHANGELOG 顶部已同步） |
| 主题 | ①把「同步失败：Failed to fetch」从「笼统提示」变成「点名主机与操作」；②补 PC 端绿色版可下载产物；③1.1.9 的修复真正上线 |
| Git base | `main` @ `9cd2c0e`（monorepo，1.1.9 已完成历史重建） |
| 历史分支 | `legacy-tauri` @ `db2d78d`（保存 Tauri 世代源码） |
| 已有 Release | `v1.0.0` ~ `v1.1.9` 共 11 个，**本次全部不动** |

### 与 1.1.9 的差异（很重要）

1.1.9 需要解决「本地 monorepo 与远端 main 历史无关」，手段是
`git merge --allow-unrelated-histories -s ours origin/main` + 快进推送 + `legacy-tauri` 保历史。
**这套动作已经执行完毕**，其结果在本次仍可验证：

```powershell
node tools/verify-119-github.mjs --version 1.1.9 --code-only
```
**预期**：`✓ 验收通过`，其中包含
`main 树包含 pnpm-workspace.yaml / apps / apps/web / apps/desktop`、
`main 树不含旧 Tauri 目录`、`tag v1.1.9 指向 main 最新提交`。

> 因此**本次不要**再跑任何 `merge` / `--force` 推送。若有人照搬 1.1.9 的流程执行 3.x 步骤，会把一件已完成的事重做一遍。

---

## 1. 前置检查（全部通过才能继续）

```powershell
cd C:\Data\BAC\neomd\neomd-V1
$env:NODE_USE_ENV_PROXY='1'; $env:HTTPS_PROXY='http://127.0.0.1:1886'; $env:HTTP_PROXY=$env:HTTPS_PROXY
```

```powershell
# 1.1 工作区必须干净：所有改动都已 commit（提交由发布负责人统一做）
git status --porcelain
```
**预期**：无输出。
**若不为空**：说明还有未提交改动，**不要继续**。先 `git add -A && git commit -m "..."`。
原因：`git push` 只推送**已提交**的内容，未提交的改动不会进远端，tag 也会少东西。

```powershell
# 1.2 版本号全仓库一致（9 项）
node tools/release-119.mjs check
```
**预期**：9 行 `✓` + `版本一致性校验通过。`，`exit 0`。
其中 `apps/desktop/build.mjs` 会显示`（从 package.json 动态推导，无硬编码）`——这是 1.2.0 的改进，不是异常。

```powershell
# 1.3 本地产物就位（Release 要传的两个文件）
Get-ChildItem dist-artifacts\NeoMD-1.2.0-*
```
**预期**：至少两个文件，且大小与下表一致。

| 文件 | 字节数 | SHA256 |
|---|---|---|
| `NeoMD-1.2.0-win-x64.zip`（绿色版） | 159,308,688（151.9 MB） | `4581dbc24945ab2f19f04cd396fc90283e1ed51900fa4627f7bbf31e2cadd3ab` |
| `NeoMD-1.2.0-setup.exe`（NSIS 安装包） | 113,184,892（107.9 MB） | `abd5aa0c6e71ca2162670902a8b5f5daa0fa2696ca119c08442c0556c56caaaa` |

复核命令（可选，约 20 秒）：

```powershell
Get-FileHash dist-artifacts\NeoMD-1.2.0-win-x64.zip, dist-artifacts\NeoMD-1.2.0-setup.exe -Algorithm SHA256 |
  ForEach-Object { "$($_.Hash.ToLower())  $(Split-Path $_.Path -Leaf)" }
```

> `.blockmap` 不上传：本项目**没有自动更新代码**（`electron-builder` 的 `publish: null`），
> blockmap 只服务增量更新，传上去也只是让 Release 里多一个没人下载的文件。
> 脚本侧用 `--no-blockmap` 显式排除，不去删本地产物。
>
> `NeoMD-1.2.0.apk` 本次**不存在**（无 Android 构建）。发布脚本会打印
> 「缺少 1 个必需产物」的**警告但不中断**，最终 Release 只有 2 个资产，属预期。

---

## 2. 推送代码到 main（快进，不需要 --force）

```powershell
# 2.1 确认要推的就是这个提交
git log --oneline -1
git rev-parse HEAD
```
**预期**：最新提交是本版收口提交，记下它的哈希（下文记为 `<new>`）。

```powershell
# 2.2 拉取远端（走本地代理 1886）
git -c http.proxy=http://127.0.0.1:1886 fetch origin
```
**预期**：`From https://github.com/myxiaolizi/neomd`，`origin/main` 仍指向 `9cd2c0e`。

```powershell
# 2.3 试推（必须是快进）
git -c http.proxy=http://127.0.0.1:1886 push --dry-run origin HEAD:refs/heads/main
```
**预期**：`9cd2c0e..<new>  HEAD -> main`，**没有** `forced update` 字样。
**若提示 non-fast-forward**：说明本地与远端分叉了。**不要加 `--force`**，先 `git fetch` 后 `git log --oneline origin/main..HEAD` 看清差了什么。

```powershell
# 2.4 正式推送
git -c http.proxy=http://127.0.0.1:1886 push origin HEAD:refs/heads/main
```
**预期**：`   9cd2c0e..<new>  HEAD -> main`
**回滚**（仅在确认推错内容时）：
```powershell
git -c http.proxy=http://127.0.0.1:1886 push --force-with-lease=main:<new> origin 9cd2c0e:refs/heads/main
```

---

## 3. Tag

```powershell
# 3.1 打 annotated tag
git tag -a v1.2.0 -m "Neo MD 1.2.0"
```
**若提示 already exists**：说明本地残留旧 tag，先 `git tag -d v1.2.0` 再重打。

```powershell
# 3.2 推送 tag
git -c http.proxy=http://127.0.0.1:1886 push origin refs/tags/v1.2.0
```
**预期**：`* [new tag]         v1.2.0 -> v1.2.0`
**回滚**：
```powershell
git tag -d v1.2.0
git -c http.proxy=http://127.0.0.1:1886 push origin :refs/tags/v1.2.0
```

```powershell
# 3.3 确认 tag 就打在 main 最新提交上（差一格是最常见的发布事故）
git rev-list -n 1 v1.2.0
git rev-parse HEAD
```
**预期**：两行哈希**完全相同**。

---

## 4. 建 Release 并上传资产

```powershell
# 4.1 预览 body（从 CHANGELOG 的 1.2.0 段落抽取）
node tools/release-119.mjs notes --version 1.2.0
Get-Content .release-notes-1.2.0.md -TotalCount 8
```
**预期**：`已写入 .release-notes-1.2.0.md（2298 字符）`，首行是
「本版是一次**针对性修复 + 交付物补齐**…」。
该文件被 `.gitignore` 的 `.release-notes-*.md` 忽略，不会污染仓库。
（正式 body 由 4.2 直接从 CHANGELOG 生成，这一步只是人工过目。）

```powershell
# 4.2 建 Release + 上传两个资产（token 运行时从凭据管理器读，不落盘、不打印）
$in = "protocol=https`nhost=github.com`n`n"
$env:GITHUB_TOKEN = ((($in | git credential fill) | Where-Object { $_ -match '^password=' }) -replace '^password=','')

node tools/publish-github-release.mjs --version=1.2.0 --repo=myxiaolizi/neomd --no-blockmap
```
**预期**：
```
✓ 已创建 Release：https://github.com/myxiaolizi/neomd/releases/tag/v1.2.0
  上传 NeoMD-1.2.0-setup.exe（107.9 MB）… 完成
  上传 NeoMD-1.2.0-win-x64.zip（151.9 MB）… 完成
远端资产数 2
```
耗时约 2~6 分钟（取决于上行带宽，259.9 MB）。建议放到后台跑：

```powershell
# 等价的后台写法
Start-Job -ScriptBlock { Set-Location C:\Data\BAC\neomd\neomd-V1; node tools/publish-github-release.mjs --version=1.2.0 --repo=myxiaolizi/neomd --no-blockmap } |
  Wait-Job | Receive-Job
```

**幂等**：重复执行安全——
- 已存在 `v1.2.0` 的 Release → 走 `PATCH` 更新说明，**不会**建出第二个；
- 同名资产先 `DELETE` 再上传，重传不会 422；
- 上传中途失败可原样重跑，已传完的会覆盖重传。

**回滚**：
- 只撤 Release：GitHub 页面删除 `v1.2.0` 这个 Release，其资产随之删除；**代码与 tag 不受影响**。
- 想保留但先下架：把它改成 Draft（`--draft` 重跑，或页面操作）。

---

## 5. 发布后验收（必须全绿）

```powershell
node tools/verify-119-github.mjs --version=1.2.0 --expect="Failed to fetch,绿色版"
```
**期望输出**：`✓ 验收通过`，`exit 0`。

它断言（全部走 GitHub API 反向读取，不信任命令的回显）：

| # | 断言 | 为什么查这一条 |
|---|---|---|
| 1 | 仓库 API 可读 | 代理/凭据/src 无障碍 |
| 2 | `main` 分支存在，记下 HEAD | 后续几条的基准 |
| 3 | main 顶层树含 `pnpm-workspace.yaml` / `apps` / `package.json` | 远端确实是 monorepo |
| 4 | main 的 `apps` 子树含 `web` / `desktop` | 顶层有 `apps` 不代表有 Web 应用 |
| 5 | main 树**不含** `src-tauri` / `build.ps1` | 没退回旧 Tauri 项目 |
| 6 | main 上的 `package.json` 版本 = `1.2.0` | 代码真的推上去了 |
| 7 | `legacy-tauri` 分支存在 | 旧代码仍可追溯 |
| 8 | tag `v1.2.0` 指向 main 最新提交 | 打偏一格是最常见事故 |
| 9 | Release `v1.2.0` 存在且非 draft | 用户能看到 |
| 10 | body 含 CHANGELOG 段落**全部小标题** | 说明来自本次 CHANGELOG，不是上次的模板 |
| 11 | body 含 `Failed to fetch`、`绿色版` | 关键条目没丢 |
| 12 | 两个资产存在且**字节数与本地完全一致** | 排除「传了上一次的旧包」 |
| 13 | 两个资产可下载（GET 资产接口返回 302 预签名跳转） | 用户点得动 |

补充检查（可选）：

```powershell
# 旧 tag / Release 一个没少（应为 12 个 Release：v1.0.0~v1.1.9 + v1.2.0）
node -e "process.env.NODE_USE_ENV_PROXY='1';process.env.HTTPS_PROXY='http://127.0.0.1:1886';(async()=>{const r=await fetch('https://api.github.com/repos/myxiaolizi/neomd/releases?per_page=100',{headers:{'User-Agent':'x'}});const j=await r.json();console.log(j.length, j.map(x=>x.tag_name).join(' '))})()"

# 历史分支仍在
git -c http.proxy=http://127.0.0.1:1886 ls-remote --heads origin legacy-tauri
```

**发布完成的判定标准**：`verify-119-github.mjs` 全绿 **且** 网页打开 Release 能看到 2 个资产。

---

## 6. 代理与凭据约定（本机硬性要求）

- **代理**：`http://127.0.0.1:1886`（用户名密码均为空）。git 用 `-c http.proxy=...` 显式指定。
- **Node 访问 GitHub API**：undici（Node 原生 `fetch`）**不读** `HTTPS_PROXY`。
  Node 24 提供内置开关：
  ```powershell
  $env:NODE_USE_ENV_PROXY='1'; $env:HTTPS_PROXY='http://127.0.0.1:1886'
  ```
  置 `1` 后 undici 才按 `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` 走代理。
  （`import { ProxyAgent } from 'undici'` 在本机不可用：undici 不随 Node 暴露为可 import 的模块，
  实测 `ERR_MODULE_NOT_FOUND`。`NODE_USE_ENV_PROXY` 是零依赖的官方方式。）
  **若忘记设置**，脚本会直接报错并给出上面这行可复制的修复命令，而不是抛一句无 URL 的 `Failed to fetch`。
- **token**：**只从 `git credential fill` 运行时读取**（Windows 凭据管理器里 93 字符的 `github_pat_…`）。
  - 不写入任何文件、不进脚本默认参数、不进日志；
  - `verify-119-github.mjs` 与 `publish-github-release.mjs` 都只在进程内存里持有它；
  - 终端回显只会看到「已获取（长度 93）」。

---

## 7. 回滚总方案

| 场景 | 回滚动作 | 影响面 |
|---|---|---|
| 推错内容 | `git push --force-with-lease=main:<new> origin 9cd2c0e:refs/heads/main` | 源码回退；tag / Release 不动 |
| tag 打偏 | `git tag -d v1.2.0` + `git push origin :refs/tags/v1.2.0`，再重打 | 只影响 tag |
| Release 建错 | GitHub 页面删除该 Release | 资产一并删除；源码与 tag 不动 |
| 资产是旧包 | 4.2 原样重跑（同名资产先删再传） | 只影响资产 |
| 只想撤源码、保留 Release | 推一个 revert 提交到 main | Release 与 tag 仍指向已发布提交 |
| 需要找回 Tauri 世代代码 | `git switch legacy-tauri`（或 `git checkout db2d78d`） | — |

**注意**：`v1.0.0` ~ `v1.1.9` 共 11 个 tag/Release 保持原样，不迁移、不改指向。
它们记录的是各自当时的发布，指向旧 commit 是正常且可接受的。

---

## 8. 发布记录

> 已发布完成。下表为**实际发布结果**（不是计划值），可作为下次发布对照的样本。

| 项 | 值 |
|---|---|
| 发布版本 | `1.2.0` |
| 源码提交 | `e7e5bc1be1cbe6cc4f46170091861319ef77c747` |
| 推送前 main | `9cd2c0e` |
| 快进区间 | `9cd2c0e..e7e5bc1`（普通推送，**未使用 `--force`**） |
| Tag | `v1.2.0`（annotated，tag 对象 `41b9f4fa4e1d0fc6e66398ee002d09dec45c38e7`） |
| Tag 目标提交 | `e7e5bc1be1cbe6cc4f46170091861319ef77c747`（与源码提交一致 ✓） |
| Release | https://github.com/myxiaolizi/neomd/releases/tag/v1.2.0 |
| Release id | `428182840`（`draft=false`，`target_commitish=main`） |
| 验收结果 | **18 项通过 / 0 项失败**（`verify-119-github.mjs --version 1.2.0 --expect="Failed to fetch,绿色版"`） |
| 全部 Release | 12 个（`v1.0.0`~`v1.1.9` 共 11 个旧 Release **全部保留未动** + `v1.2.0`） |
| 生产部署 | 已部署 1.2.0（`https://md.zhengl.vip/api/health` → `version: 1.2.0`） |

**验收关键项回显**（`verify-119-github.mjs` 实测）：

```
✓ main HEAD = e7e5bc1「fix(release): 1.2.0 — 同步错误可定位化 + PC 绿色版发布 + 生产部署」
✓ main 树含 pnpm-workspace.yaml / apps / apps/web / apps/desktop / package.json
✓ main 树不含 src-tauri / build.ps1
✓ main 上 package.json 版本 = 1.2.0
✓ legacy-tauri 分支存在：db2d78d
✓ tag v1.2.0 指向 main 最新提交：e7e5bc1
✓ Release body 含 CHANGELOG 全部小标题：Fixed / Added / Changed / Security / 已知未实现（非本版回归）
✓ Release body 含指定关键字：Failed to fetch、绿色版
✓ 资产大小一致：win-x64.zip 151.9 MB、setup.exe 107.9 MB
✓ 两资产均可下载（HTTP 302 → release-assets.githubusercontent.com 预签名）
```

### 资产清单（已上传，字节数与本地逐一核对一致）

| # | 文件 | 字节数 | 大小 | SHA256 | 说明 |
|---|---|---|---|---|---|
| 1 | `NeoMD-1.2.0-win-x64.zip` | 159,308,688 | 151.9 MB | `4581dbc24945ab2f19f04cd396fc90283e1ed51900fa4627f7bbf31e2cadd3ab` | 绿色版，**主发布物** |
| 2 | `NeoMD-1.2.0-setup.exe` | 113,184,892 | 107.9 MB | `abd5aa0c6e71ca2162670902a8b5f5daa0fa2696ca119c08442c0556c56caaaa` | NSIS 安装包，附带 |
| — | 合计 | 272,493,580 | 259.9 MB | — | 2 个资产 |

**未上传（有意为之，非遗漏）**

| 文件 | 不传的原因 |
|---|---|
| `NeoMD-1.2.0-setup.exe.blockmap` | 项目无自动更新代码（`electron-builder` 的 `publish: null`，`autoUpdater`/`electron-updater`/`checkForUpdates` 零命中）。blockmap 只服务增量更新，传上去会增加一个没人下载的文件。脚本用 `--no-blockmap` 显式排除，**保留本地产物**以备将来接自动更新。 |
| `NeoMD-1.2.0.apk` | 本次**未做 Android 构建**（用户只要求 PC 端绿色版）。发布时脚本会打印「缺少 1 个必需产物：NeoMD-1.2.0.apk」的**警告但不中断**——这是预期行为，不要因此阻断发布。将来做 Android 版本时，这条警告即为缺口清单。 |

> 注意资产**顺序**：绿色版 zip 是用户主要下载物，安装包是附带。Release body 的「## 安装包」表格由发布脚本按「安装包 → 免安装包」顺序生成，如需调整顺序请改 `tools/publish-github-release.mjs` 的 `ARTIFACT_TEMPLATES`。

---

## 9. 本次修掉/摸清的流程缺陷（留给下一个版本的人）

这几条都不是业务代码问题，而是**发布工具链自身**的问题。它们共同的特征是：
**不报错、输出看起来正常，但实际做的事不是你以为的那件**——比直接失败危险得多。
第 9.3 节稍特殊：它是「真实存在但间歇性」的故障，症状极易让人查错方向。

### 9.1 参数解析必须拒绝未识别的写法，静默忽略比报错更危险

`docs/RELEASE-119.md` 里写的是 `node tools/verify-119-github.mjs --version 1.1.9`（空格形式），
而脚本早期只认 `--version=1.1.9`（等号形式）。后果不是报错，而是：
**版本号被静默丢弃 → 回落到 `package.json` 的版本 → 验收对象换了一个，而且全绿。**

一个「拼错的参数」「开关后面带了 `=1`」「`--version` 忘了跟值」的调用，
都可能让你以为验收了 A，实际验收了 B。

现在脚本对上述三类写法**一律硬失败**并列出无法识别的参数：

```powershell
node tools/verify-119-github.mjs --version 1.1.9 --coode-only   # → 中止：无法识别的参数 · --coode-only
node tools/verify-119-github.mjs --version                      # → 中止：· --version（缺少取值）
node tools/verify-119-github.mjs --code-only=1                  # → 中止：· --code-only=1
```

**通用原则**：命令行解析器遇到不认识的输入，要么报错，要么显式警告；
**绝不能静默忽略**。同理适用于配置文件里未知的键、环境变量拼错的情形。

### 9.2 门禁校验不能把「注释」当「代码」

1.2.0 把 `apps/desktop/build.mjs` 的产物名改成从 `package.json` 动态读取，
但 JSDoc 里留了一句历史说明：`早先版本这里把 zip 文件名硬编码成 NeoMD-1.1.9-win-x64.zip`。
`release-119.mjs check` 全文正则匹配，于是把这句**注释**当成「还没升级的硬编码」而报错。

修复方式是**剥掉注释再匹配**（而不是删掉这条检查、也不是把它降级成警告）。
因为门禁一旦出现假阳性，就会被习惯性绕过，等于门禁失效。
同时补了「产物名由 `${version}` 动态推导 → 判通过」的分支，输出会标注
`（从 package.json 动态推导，无硬编码）`。

修复后做过反向验证，确认**没有把门禁改松**：

| 输入 | 期望 | 实测 |
|---|---|---|
| 块注释里写 `NeoMD-1.1.9` | 不报错 | 无命中 ✓ |
| 行注释里写 `NeoMD-1.1.9` | 不报错 | 无命中 ✓ |
| 代码里真硬编码 `NeoMD-1.1.9` | **必须抓到** | 命中 `1.1.9` ✓ |
| 代码里 `${version}` 模板 | 不报错 | 无命中 ✓ |
| `https://…/NeoMD-1.1.9.zip`（URL 含 `//`） | 不能被当注释截断 | 命中 `1.1.9` ✓ |

最后一条尤其重要：剥注释用「`//` 前必须是空白」判断，否则 `https://` 会被误当行注释截断，
导致 URL 后面的版本号漏检——那才是真正的漏网。

### 9.3 代理链路间歇性 TLS 截断：现象、分层定位与操作建议

**这是本次发布唯一真正卡住流程的故障，而且下次发版一定还会遇到。**
它的危险之处在症状：看到「git 推不上去 / 发布失败」，人的本能是去查 **token 是否过期、权限够不够、仓库设置对不对**——全是错的方向，因为那些问题会明确报 401/403/404，不会表现为 TLS 断连。

#### 现象

```powershell
git -c http.proxy=http://127.0.0.1:1886 fetch origin
fatal: unable to access 'https://github.com/myxiaolizi/neomd.git/':
        schannel: failed to receive handshake, SSL/TLS connection failed
```

同一时刻用 node 读同一个 API 却是 **HTTP 200**——这说明「网络不通」这个直觉判断是错的。

#### 分层定位（每步都有明确判据）

按网络层次自下而上逐层排除，**不要跳步**：

| # | 探测 | 实测结果 | 判据 |
|---|---|---|---|
| 1 | TCP 探活 `127.0.0.1:1886` | 通 | 代理进程活着、端口在听 |
| 2 | 手写 `CONNECT github.com:443` | `HTTP/1.1 200 Connection established`，隧道存活 | 代理愿意为该目标建隧道 |
| 3 | 隧道内做真实 TLS 握手（SNI=github.com） | 成功，`TLSv1.3`，三种 CONNECT 写法均成功 | **代理的转发能力是好的** |
| 4 | `GIT_CURL_VERBOSE=1` 看字节流 | 代理回 200 → git 发出 457 字节 ClientHello → 收到的 TLS 记录**不完整**，持续 `need more data` 直到超时 | 故障在「TLS 记录被截断」 |
| 5 | 换 `--sslBackend=openssl` 交叉验证 | 变成 `unexpected eof while reading`（同样是被提前断开） | 排除「schannel 特有 bug」 |

**关键结论**：**代理本身是好的，坏在 git 走代理时 TLS 记录被截断**，且是**间歇性**的。
这一步排除了三大类误判方向：代理服务没起 / 端口不通 / 认证失败。

#### A/B 交错对照（不是「重试成功就算好了」）

单次重试成功没有说服力，必须交错对照才有证据力。实测**交替执行**各 6 次：

| 路径 | 成功率 |
|---|---|
| **代理 1886**（`-c http.proxy=http://127.0.0.1:1886`） | **6/6 ✓** |
| 直连（`-c http.proxy=`） | 4/6（失败为 `Could not connect to github.com:443 after 21067 ms`） |

另一组 10 次采样：代理路径 **10/10**，直连 5/10。
结论：**推送应当走代理**，直连不稳定。

#### 同一故障的第二处证据：资产上传路径

建 Release 成功，但上传第一个资产时失败：

```
上传 NeoMD-1.2.0-setup.exe（107.9 MB）… 失败
✗ 发布失败：fetch failed
```

`fetch failed` 是 undici 的**包装错误**，真实原因藏在 `err.cause` 链里（`ECONNRESET` / `UND_ERR_SOCKET` 等），
必须展开才能看见。诊断步骤：

| # | 探测 | 实测结果 |
|---|---|---|
| 1 | `api.github.com` / `uploads.github.com` 各 3 次 HEAD | 全部 HTTP 200（最慢 1833ms） |
| 2 | 代理对两主机的 CONNECT | 均 `200 Connection established` |
| 3 | 分档上传实测（展开 `err.cause` 后） | 1KB → `HTTP 201` 1810ms；**107.9MB → `HTTP 201` 12739ms**；**151.9MB → `HTTP 201` 18772ms** |

同一个 107.9MB 文件，第一次失败、诊断时重试即成功（12.7 秒）——**这就是间歇性断连的典型形态**，
与上面的 git TLS 截断属同一类现象，只是发生在上传路径。

#### 操作建议（下次发版直接照做）

1. **推送前清掉代理环境变量，只用 `-c` 显式指定**：

   ```powershell
   Remove-Item Env:HTTPS_PROXY,Env:HTTP_PROXY,Env:NODE_USE_ENV_PROXY -ErrorAction SilentlyContinue
   git -c http.proxy=http://127.0.0.1:1886 fetch origin
   ```
   原因：git 的**环境变量优先级高于 `-c`**。两者同时存在时实际生效的是环境变量那份，
   等于配置了两次、且可能是格式不同的地址，行为不可预期。

2. **`fetch` / `push` / 资产上传都要带重试**（最多 3 次，间隔 5 秒）。
   一次失败**不能**判定链路不可用——本次 `fetch`、`push`、`tag push` 全部第 1 次成功，
   但第一次的 `publish` 就撞上了断连。

3. **失败时先分层定位，再决定要不要重试**。
   `fetch failed` 本身不含原因，必须先展开 `err.cause`、先排除主机与代理，
   才能区分「偶发断连（重试有效）」与「确定性失败（重试无用，如体积上限、方法错误、权限不足）」。
   直接无脑重试会浪费时间，并掩盖真正的问题。

> **由此得出、且已在本次被采纳的结论：`publish-github-release.mjs` 必须为单个资产的上传加自动重试。**
> 这不是「锦上添花」——本次 259.9MB 的上传就真的中断过一次。
> 实现时须满足两点：
> - **只对网络类失败重试**（`fetch failed` / `ECONNRESET` / `UND_ERR_SOCKET` / 5xx）；
>   **4xx 不重试**（401 token 失效、422 资产已存在这类重试无意义，还会掩盖真正的问题）；
> - **每次重试必须打印「第 N 次重试」**，否则日志看起来像一次就成功了，下次遇到同样问题又得重新诊断一遍。

### 9.4 同一份数据被两处解析，必须交叉验证

`tools/release-119.mjs notes`（**预览** Release body）与 `tools/publish-github-release.mjs`
（**真正生成** Release body）是两份**独立实现**的 CHANGELOG 抽段逻辑。

这构成一个隐蔽风险：若两者抽出的正文有差异，就会出现
**「你审阅的内容 ≠ 真正发出去的内容」**；而 `verify-119-github.mjs` 又是按 CHANGELOG 抽段去断言
Release body 的小标题的，于是会报一个极难定位的假失败。

发布前做了逐字节交叉验证，5 个版本全部一致：

```
1.2.0   A=2298   B=2298   完全一致 ✓
1.1.9   A=6317   B=6317   完全一致 ✓
1.1.8   A=2786   B=2786   完全一致 ✓
1.1.5   A=1843   B=1843   完全一致 ✓
1.0.0   A=1293   B=1293   完全一致 ✓
```

因此可以信任 `notes` 的输出：**预览即最终 body 主体**。

> **约束（改 CHANGELOG 抽段逻辑时必须维持）**：这两个函数必须对同一份 CHANGELOG 产出**完全相同**的正文。
> 任何人修改其中一处，都必须重新跑一次交叉验证，否则「预览」就失去意义。
>
> 本项目已多次踩过「同一件事有两个实现」的坑（1.1.9 的 `--font-content` 被内层元素内联遮蔽、
> `layout` 与主题两套脏标记逻辑不一致）。**凡是「同一件事有两个实现」的地方，都应该有交叉验证。**

---

> 本文档与 `docs/RELEASE-119.md` 是同一套流程的两代版本：
> 119 那次额外包含「历史重建」（`-s ours` 合并 + `legacy-tauri` 保历史），
> 120 起回归常规发布流程，只有**代码 / tag / Release / 资产**四步。
> 若将来再次出现「远端 main 内容与本地不符」，请回看 119 的第 2、3 节。
