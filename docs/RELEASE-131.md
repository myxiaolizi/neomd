# Neo MD 1.3.1 发布说明

- 发布日期：2026-10-30
- 上一版本：1.3.0
- 版本性质：**纯缺陷修复版**（无新功能）
- GitHub Release：<https://github.com/myxiaolizi/neomd/releases/tag/v1.3.1>
- 生产环境：<https://md.zhengl.vip>（已部署 1.3.1）

> **版本号说明**：本版原定发布为 `1.2.1`。验收过程中发现 1.3.0 已由另一条并行工作流（插件商店 50 款）提交、推送并**在 GitHub 公开发布 Release**（tag `v1.3.0`，2026-10-30T19:10:57Z）。若仍发 `1.2.1`，新版本号会小于已公开版本号，语义化版本倒挂、Releases 时间线错乱。经确认改为 **1.3.1**。

---

## 一、本版解决的六项用户报障

| # | 报障 | 修复要点 |
|---|---|---|
| 1 | 编辑器行距过大 | 默认行高 `1.75 → 1.6`、段落 margin `0.85em → 0.6em`（根因是两者**同向放大**，不是「两层 line-height 相乘」） |
| 2 | PC 端设置字体后自动恢复 | **主因在服务端** `flattenSettings()` 整块覆盖；另修复 `installCloudAutoPull` 死代码路径 |
| 3 | 左右分屏右侧颜色不对 | 分屏栏误用界面外壳色 `var(--bg)` → 改纸张色；预览栏补齐纸色与排版变量 |
| 4 | 文件保存后空换行丢失 | 空行做成**双向可逆载体**（N 空行 ⇄ N-1 空段落 ⇄ 2+(N-1) 换行） |
| 5 | 历史版本只能看到最近一版 | **6 条根因链**全部修复（含 100% 失败的恢复链路） |
| 6 | 设置项重复出现 | 主题页签只负责配色，排版类控件统一归编辑器页签 |

每项的根因与修复前后实测数值见 [`docs/ACCEPTANCE-131.md`](./ACCEPTANCE-131.md)。

---

## 二、交付产物

| 平台 | 文件 | 大小 | SHA256 |
|---|---|---|---|
| Windows x64 绿色版 | `NeoMD-1.3.1-win-x64.zip` | 151.9 MB（159,312,203 B） | `1028b111cda9d9032c7a5d12d29a8cd705870950a14abf9631bc4a42e171c893` |
| Windows x64 安装包 | `NeoMD-1.3.1-setup.exe` | 107.9 MB（113,187,877 B） | `23a51ab1c63196cf6276feb5a84d23b3ec691e43ebfc97f5f7efc5bccf6b2be6` |
| Android APK | `NeoMD-1.3.1.apk` | 4.2 MB（4,363,947 B） | `32bf02754b0c57f030666a49857afd319a50530c53188c043c0570cf974f54bf` |

**三种获取途径**，内容一致（SHA256 已逐项核对）：

1. **GitHub Releases**：<https://github.com/myxiaolizi/neomd/releases/tag/v1.3.1>
2. **官方下载页**：<https://md.zhengl.vip> → 下载弹窗
   - Windows 大文件：`/api/download/:file` 返回 302 → OSS 6 小时预签名直链
   - Android APK：由服务端直出（阿里云 OSS 默认域名拦截 `.apk`）
3. **阿里云 OSS**：`mdadmin/releases/`（与下载页同一份对象）

> 未签名安装包在 Windows 上可能触发 SmartScreen 提示，选择「更多信息 → 仍要运行」即可。

---

## 三、发布链路（实际执行）

```
1. 版本升级    node tools/release-119.mjs version --to 1.3.1      → 6 个文件
2. 版本校验    node tools/release-119.mjs check                   → 9/9 ✓
3. Web 构建    pnpm --filter @neomd/web build                     → dist/
4. 桌面端构建  node apps/desktop/build.mjs                        → zip + exe
5. Android 构建 node apps/android/build.mjs                       → apk（BUILD SUCCESSFUL）
6. 部署包      tar 精简包（public + server/src + package.json）    → 1.23 MB
7. 生产部署    宝塔 MCP：备份 → 解压 → 删 assets → 覆盖 → chown → node --check → 重启
8. 产物分发    OSS mdadmin/releases/ + server/releases/（APK）
9. GitHub      提交 → 推送 main → tag v1.3.1 → Release + 3 个资产
10. 发布验收   node tools/verify-119-github.mjs --version 1.3.1    → 20/20 ✓
```

---

## 四、发布验收结果

| 门禁 | 结果 |
|---|---|
| `verify-121.mjs`（本版六项缺陷） | **45 通过 / 0 失败** |
| `verify-119-full.mjs`（1.1.9 全量回归） | **111 通过 / 0 失败 / 1 跳过** |
| `verify-119-github.mjs`（发布状态） | **20 通过 / 0 失败** |
| `vitest run` | **236 passed**（9 文件） |
| `vue-tsc --noEmit` | **0 错误** |
| `tsc -p tsconfig.json` | **0 错误** |
| `node --check`（services/api/src 35 文件） | **0 失败** |
| `release-119.mjs check` | **9/9 ✓** |
| 生产 `/api/health` | `version: "1.3.1"`，`db: true` |
| 生产 APK 下载 | `200`，4,363,947 B（SHA256 一致） |
| 生产历史 APK 下载 | `200`（`NeoMD-1.1.8.apk` 仍可下） |
| 生产 Windows 安装包 | `302` → OSS，实下 113,187,877 B |

---

## 五、本版连带根治的结构性隐患

这三项不在用户报障范围，但都属于「发版靠人记得手改，漏改就静默失败」的同类问题：

1. **`services/api/src/routes/download.js` 硬编码 1.1.8 清单** —— 下载入口用清单做白名单，清单漏登记的文件**即使磁盘上有也永远 404**。这正是 1.2.0 发布时「APK 缺失」的真正原因（当时发布日志写的是「缺少必需产物」，其实文件在）。
2. **`tools/publish-releases.mjs` 硬编码 1.1.8 产物名** —— 同上。
3. **`apps/android/build.mjs` 硬编码 `NeoMD-1.2.0.apk`** —— `release-119.mjs check` 在本次收口时**真的拦到了**这一条。

三处全部改为从 `package.json` 动态推导，版本号自此只有**一个事实源**。

---

## 六、仓库脏数据清理

`apps/web/src/stores/settings.ts` 的中文注释在 **1.2.0 已发布版本里就是 GBK 乱码**（98 行真乱码 + 14 行「注释原文编码损坏，已清理」占位符）。

- 全部位于注释内，不影响运行时（所以类型检查与单测一直全绿），但是可维护性地雷；
- 根因：历史上用 PowerShell `Set-Content -Encoding UTF8` 写 UTF-8 无 BOM 文件，被按 GBK 读入再写回；
- 本版按语义还原 **112 行**，保留全部「为什么」解释；
- 附两个可复跑校验脚本，防止再次引入。

---

## 七、升级影响与注意事项

### 无需迁移

- **数据库**：本版无 schema 变更，启动时 `migrate.js` 幂等执行即可；
- **配置**：无需改动任何环境变量；
- **客户端设置**：缺陷2 的修复会在下次拉取时用「纯 global 视图」纠正被污染的拍平数据，**无需用户手动重置**。

### 行为变更（唯一一项）

`pruneVersions` 的默认保留策略由 **30 天 / 50 版** 放宽为 **180 天 / 200 版**，并在清理时同步删除版本索引条目。

- 影响面：**开启「本地留痕」的用户**本地磁盘占用会上升；
- 未开启者（默认 `keepLocalVersions=false`）**完全无感**。

### 已知遗留（不在本版范围）

1. 云端历史版本无数量上限，`pruneRemoteVersions` 存在但无调用点；
2. `@neomd/core/dist/` 产物不可用（`tsc` 输出省略扩展名的 ESM + 空 `index.js`），当前构建链路不依赖它；
3. 导出侧相邻 `margin` 未与编辑器完全对齐（纯视觉，不影响数据）；
4. `SettingsModal.vue` 是死代码，可后续删除；
5. Android APK 未做真机安装验证（仅验证构建成功与产物完整性）。

---

## 八、回滚

生产回滚点：`/www/backup/neomd-131-20261030-222943/`

```bash
BK=/www/backup/neomd-131-20261030-222943
cd /www/wwwroot/md.zhengl.vip

rm -rf public && cp -a "$BK/public.bak" public
rm -rf server/src && tar -xzf "$BK/server-src.tar.gz" -C server
cp -a "$BK/package.json.bak" server/package.json
cp -a "$BK/.env.bak" server/.env
chown -R www:www public server
# mcp__baota__NodeProjectControl({ project_name:'neomd', action:'restart' })
```

回滚后 `curl https://md.zhengl.vip/api/health` 应返回 `version: "1.2.0"`。

> **注意**：GitHub 上的 tag 与 Release 不会自动撤销；如需彻底回退版本线，需另发 `1.3.2` 或删除远端 tag（后者会破坏已有下载链接）。
