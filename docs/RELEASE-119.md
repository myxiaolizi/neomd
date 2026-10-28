# 1.1.9 发布 Runbook

本文是 1.1.9 的发布操作手册，按顺序执行即可。每条命令都给出**预期输出**与**失败回滚**。

---

## 0. 背景：为什么这次发布需要一个特殊流程

GitHub 上的 `main` 分支内容与本地开发源码**完全不是一套东西**，且两者**历史无关**（`git merge-base` 为空）：

| | 内容 | 最新提交 |
|---|---|---|
| 本地 `main`（monorepo） | `pnpm-workspace.yaml`、`apps/`、`packages/`、`services/` | `c26fbdd` |
| 远端 `origin/main`（旧 Tauri 项目） | `app/`、`src-tauri/`、`build.ps1`、`package.json#name=mdnote-workspace` | `db2d78d` |

也就是说「把更新记录同步到 GitHub」这件事，此前在**源码层面从未真正成立**过——Releases 有 10 个、tag 有 10 个，但 `main` 上的代码不是这个产品。

### 采用方案：`-s ours` 合并

```
git merge --allow-unrelated-histories -s ours origin/main
```

- 保留本地 monorepo 的**全部历史**；
- 把 `origin/main` 变成新提交的**祖先**，于是 `push` 是**快进（fast-forward）**，**不需要 `--force`**；
- 旧 Tauri 的**文件内容**被丢弃（`-s ours` 只取我方树），但仍可从 `db2d78d` 检出。

因此必须先建 `legacy-tauri` 远端分支，否则旧代码就只能靠翻 commit hash 才能找到。

> **前置硬条件**：合并只包含**已提交**内容。工作区若有未提交改动，它们不会进合并提交。所以第 1 步必须先确认工作区干净。

---

## 1. 前置检查（全部通过才能继续）

```powershell
cd C:\Data\BAC\neomd\neomd-V1

# 1.1 工作区必须干净（无未提交改动、无未跟踪的源码文件）
git status --porcelain
```
**预期**：无输出。
**若不为空**：先 `git add -A && git commit -m "..."` 提交，或把临时文件（`.tmp-*`、`.probe-*.mjs`、`.release-notes-*.md`）清理/加入 `.gitignore`。

```powershell
# 1.2 版本号全仓库一致
node tools/release-119.mjs check
```
**预期**：9 行 `✓` + `版本一致性校验通过。`

```powershell
# 1.3 类型检查（两道，缺一不可）
npx tsc -p tsconfig.json                          # packages/core + packages/shared（含测试）
cd apps/web; npx vue-tsc --noEmit -p tsconfig.json; cd ../..
```
**预期**：两条都 `EXIT=0`。
**为什么必须两道**：`pnpm build` 走 esbuild，**不做类型检查**。1.1.9 期间发生过两次「删了定义留了调用」的事故（`app.ts` 的 `isFirstSyncDone`、`EditorPage.vue` 的 `splitTabIntoPane`），打包零报错、运行时才抛 `ReferenceError`，且被 fire-and-forget 静默吞掉。`vue-tsc` 是唯一防线。

```powershell
# 1.4 单元测试
npx vitest run
```
**预期**：`Tests 204 passed (204)`。

```powershell
# 1.5 前端可构建
pnpm --filter @neomd/web build
```
**预期**：`✓ built in ~4s`，`EXIT=0`。

```powershell
# 1.6 端到端验收（需本地 API 3200 + 前端 5178 都在跑）
node tools/verify-119-full.mjs --skip-build
```
**预期**：`【门禁通过】`，退出码 0。
**若有失败项**：**不要继续**。按报告里的「复现」步骤定位。

---

## 2. 提交与建 legacy 分支

```powershell
# 2.1 提交本版全部改动
git add -A
git commit -m "feat(release): 1.1.9 — 同步链路根治、设置项修复、工作台与后台重构"
```
**预期**：`N files changed`。

```powershell
# 2.2 拉取远端（走本地代理 1886）
git -c http.proxy=http://127.0.0.1:1886 fetch origin
```
**预期**：`From https://github.com/myxiaolizi/neomd` + 若干分支引用。

```powershell
# 2.3 把旧 Tauri 历史存到远端 legacy-tauri 分支（保留旧代码可追溯）
git -c http.proxy=http://127.0.0.1:1886 push origin origin/main:refs/heads/legacy-tauri
```
**预期**：`* [new branch]      origin/main -> legacy-tauri`
**回滚**：`git push origin --delete legacy-tauri`（不影响 main 与 tag）

---

## 3. 合并远端历史（快进，不需要 force）

```powershell
# 3.1 以我方树为准合并，把 origin/main 变成祖先
git merge --allow-unrelated-histories -s ours origin/main -m "chore: 合并旧 Tauri 历史（内容以 monorepo 为准），保留 legacy-tauri 分支以便追溯"
```
**预期**：`Merge made by the 'ours' strategy.`

```powershell
# 3.2 确认合并后仍是 monorepo 内容
git ls-tree --name-only HEAD | Select-String -Pattern 'pnpm-workspace.yaml|apps|packages|services'
```
**预期**：能看到 `apps`、`packages`、`pnpm-workspace.yaml`、`services`。

```powershell
# 3.3 试推（必须是快进，不带 force）
git -c http.proxy=http://127.0.0.1:1886 push --dry-run origin HEAD:refs/heads/main
```
**预期**：`db2d78d..<new-sha>  HEAD -> main`，且**没有** `forced update` 字样。
**若提示 non-fast-forward**：说明合并步骤没生效，**不要加 `--force`**，回到 3.1 检查。

```powershell
# 3.4 正式推送
git -c http.proxy=http://127.0.0.1:1886 push origin HEAD:refs/heads/main
```

---

## 4. Tag 与 GitHub Release

```powershell
# 4.1 打 tag 并推送
git tag -a v1.1.9 -m "1.1.9"
git -c http.proxy=http://127.0.0.1:1886 push origin v1.1.9
```
**预期**：`* [new tag]         v1.1.9 -> v1.1.9`

```powershell
# 4.2 生成 Release body（从 CHANGELOG 抽取 1.1.9 段落）
node tools/release-119.mjs notes --version 1.1.9
```
**预期**：`已写入 .release-notes-1.1.9.md（约 6300 字符）`

```powershell
# 4.3 建 Release（通过代理；token 由 git credential 运行时读取，不落盘）
node tools/publish-github-release.mjs --version=1.1.9
```
**预期**：Release `v1.1.9` 创建成功，body 为 CHANGELOG 段落。
**幂等**：脚本对已存在的 Release 走更新而非重复创建。
**回滚**：在 GitHub UI 删除该 Release（tag 可保留）。

> 注意参数是 `--version=1.1.9`（等号形式），不是 `--version 1.1.9`。
> 该脚本自行从 `package.json` 读版本号，`--version` 仅用于覆盖。

---

## 5. 发布后验证

```powershell
# 5.1 校验远端状态
node tools/verify-119-github.mjs --version 1.1.9
```
**断言**：
- `main` 最新提交的 tree 含 `pnpm-workspace.yaml` 与 `apps/web`（证明源码真的同步了）
- tag `v1.1.9` 指向 `main` 最新提交
- Release `v1.1.9` 存在且 body 含「同步失败：Failed to fetch」等关键条目
- 历史 10 个 tag 与 Release 仍在

```powershell
# 5.2 确认旧代码仍可追溯
git -c http.proxy=http://127.0.0.1:1886 ls-remote --heads origin legacy-tauri
```
**预期**：有 `refs/heads/legacy-tauri`。

---

## 6. 凭据与代理约定

- 代理：`http://127.0.0.1:1886`（用户名密码均为空）。
- GitHub token：**只从 `git credential fill` 运行时读取**，仅存在于进程内存。
  - 绝不写入任何文件；
  - 绝不出现在脚本默认参数里；
  - 绝不打印到日志。
- Node 访问 GitHub API 需走代理。零依赖方式（Node 24）：
  ```powershell
  $env:NODE_USE_ENV_PROXY='1'; $env:HTTPS_PROXY='http://127.0.0.1:1886'
  ```
  若忘记设置，脚本会明确报错并给出这一行可直接复制的修复命令。

---

## 7. 回滚总方案

| 场景 | 回滚动作 |
|---|---|
| 推送后发现 main 内容不对 | `git -c http.proxy=... push origin db2d78d:refs/heads/main --force`（把 main 指回旧提交；`legacy-tauri` 已在，不会丢旧代码） |
| Release 建错 | GitHub UI 删除该 Release |
| tag 打错 | `git tag -d v1.1.9` + `git push origin :refs/tags/v1.1.9` |
| 只想撤源码不改 Release | 推一个 revert 提交到 main，保留 tag 指向（Releases 仍可访问） |

**注意**：`v1.0.0` ~ `v1.1.8` 这 10 个 tag/Release 全部指向旧 commit `db2d78d`，**这是可接受的**——它们记录的是当时的发布。本次合并不会让它们失效（`db2d78d` 仍是新 main 的祖先，仍然可达）。
