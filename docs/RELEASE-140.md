# Neo MD 1.4.0 发布说明

- 发布日期：2026-10-31
- 上一版本：1.3.1
- 版本性质：**功能大版本**（插件生态 + 后台能力 + 设置体系三条主线）
- GitHub Release：<https://github.com/myxiaolizi/neomd/releases/tag/v1.4.0>
- 生产环境：<https://md.zhengl.vip>（已部署 1.4.0）

---

## 一、本版解决的 16 项需求

| # | 需求 | 修复要点 |
|---|---|---|
| 1 | 新装插件无法使用、需在功能区有入口且可用 | 功能区入口机制**原本不存在**；新增 `community:<id>` 前缀 + 独立 key，内置白名单零改动 |
| 2 | 后台插件市场增加编辑功能 | 新增 `PUT /api/admin/plugins/:id`（含语法校验 + 危险标识符拦截 + 审计）+ 编辑弹窗 |
| 3 | 插件市场翻页，每页 20 个 | 服务端 `page/pageSize/total/hasMore`（不传参向后兼容）+ 前端分页 + 回顶部 + 页码进 URL |
| 4 | 后台客户端分发没有最新版本 | 结论反转：本来能看到；真正缺的是同源复用、`isCurrent`、下载次数、可用性探测、四态区分 |
| 5 | 后台用户管理增加功能 | 交付 **6 项**：封禁/解封、批量、角色、登录记录、数据概览、CSV 导出 |
| 6/17 | 内置插件功能可用、逐一检查每款 | `PluginPanel.vue` 是**死代码**；26 款逐款：可用 21 / 部分 5 / 不可用 0 / 失败 0 |
| 7 | 左右/上下分屏拖动不跟手 | **两个独立 bug 叠加**：px→% 单位错配（灵敏度放大 13 倍）+ flex 方向相反 |
| 8 | 右侧最多 3 个 / 第 4 个替换最上 / 拖标题栏调位置 | 上限+淘汰纯函数（两处共用）+ 双通道拖动排序 + 前提修复（顺序被常量序抹平） |
| 9 | 命名模板 / AI 提示词乱码 | **历史脏数据**，原值经逐字符对齐反推；精确签名表 + 备份 + 21 条单测 |
| 10 | admin 出现很多仓库 | 服务端无条件自动登记是根因；三层收敛 + 清理 10→4 + 客户端 orphan 判定防复发 |
| 11 | 主题调色不影响分割线 | 语义分档 + `ensureContrast()`；10 套主题 1.14~1.33 → 1.25~1.63 |
| 12 | 勾选「仅正文」仍全局生效 | `removeProperty` 清空后**回落到 themes.css 同一套静态值** → 改写中性基线值 |
| 13 | 颜色细化不生效 | 强调色被 `applyThemePreset` 每次覆写吞掉 + 两步式交互（独立 `colorDraft`） |
| 14 | 全部设置项检查、确保有效果并归位 | 主色调搬到主题页签；逐项体检 **18/18，无效项 0** |
| 15 | 设置界面还会出现正文工具栏 | 设置是虚拟 tab，对 `activeTab` 为真 → 补 `!isSettingsActive && !isPluginActive` |
| 16 | 设置给保存按钮、不要即时生效 | 草稿模式 + 底部保存栏 + 实时预览开关 + **只提交差集** |

每项的根因与修复前后实测见 [`docs/ACCEPTANCE-140.md`](./ACCEPTANCE-140.md)。

---

## 二、交付产物

| 平台 | 文件 | 大小 | SHA256 |
|---|---|---|---|
| Windows x64 绿色版 | `NeoMD-1.4.0-win-x64.zip` | 152.0 MB（159,358,918 B） | `6ed887891a2160a2fd08efe189abcd78cf519dcbccde4b82ef720bdbf92bb668` |
| Windows x64 安装包 | `NeoMD-1.4.0-setup.exe` | 108.0 MB（113,226,039 B） | `9dddfae5578bb3387f657b0186f3ca2b537e1708529a0ac00d134e575ab3a008` |
| Android APK | `NeoMD-1.4.0.apk` | 4.2 MB（4,410,655 B） | `38dc5f44c32a8d5b969914c1274450aef7bacdc334030e95d8d0cd46e9482b17` |

**三种获取途径**，内容一致（SHA256 已逐项核对）：

1. **GitHub Releases**：<https://github.com/myxiaolizi/neomd/releases/tag/v1.4.0>
2. **官方下载页**：<https://md.zhengl.vip> → 下载弹窗
3. **阿里云 OSS**：`mdadmin/releases/`（与下载页同一份对象）

> 未签名安装包在 Windows 上可能触发 SmartScreen 提示，选择「更多信息 → 仍要运行」即可。

---

## 三、PC 绿色版本机实测（14/14 全通过）

按需求「在本机和 github 同时发布 PC 端绿色版本程序，同时在本机测试」执行。

**测试环境**：解压到**含中文与空格的路径** `...\nm140 中文 路径 测试\我的 软件\Neo MD 1.4.0 绿色版\`

**方法学**：打包后的 exe 入口固定在 `app.asar/main.cjs`，无法用脚本注入驱动，因此用 `--remote-debugging-port` + CDP 连接 —— 启动的就是用户双击的那个 exe 本体。

| 类别 | 项数 | 结果 |
|---|---|---|
| A 静态 | 5 | exe 存在（238.2 MB）/ `app.asar` 57,715 B / `webdist/index.html` 存在 / **FileVersion = 1.4.0** / 解压目录无残留 |
| B GUI | 4 | 主窗口加载 `neomd://neomd/app` / `window.NeoMD.bridge` **8 项 API 齐全** / `contextIsolation` 未回退（`require`/`process` 均 undefined）/ `#app` 已挂载 |
| C 数据 | 1 | 本地仓库**真读写**：创建含中文名文档成功，docs=697 |
| D 1.4.0 特征 | 3 | **底部保存栏 + 实时预览开关**存在 / **`.editorbar` = 0**（需求15）/ **主题页签 5 色板 + 10 主题卡片 + 5 个颜色细化取色器**（需求14） |

**视觉确认**（截图见下）：主界面、设置页「通用」（**无主色调**）、设置页「主题」（**主色调 5 色板 + 主题卡片 + 颜色细化**，**无正文工具栏**，底部保存栏）。

> ⚠️ **一个必须记录的排查坑**：首次测试时应用「双击即消失、exit code 0、无任何日志、无进程残留」，一度误判为「打包产物坏了」。实测**连 1.2.0 的旧产物也启动不了** → 确认是环境问题。根因是 shell 里残留 **`ELECTRON_RUN_AS_NODE=1`**（构建脚本为让 `electron-builder` 用系统 node 跑而设），它让 Electron 二进制以**纯 Node 模式**启动，`require('electron')` 直接 `MODULE_NOT_FOUND`。用干净 env 启动即正常。
> **教训**：「打包产物启动不了」先排除环境变量，再看产物 —— 否则会去修一个没坏的包。

---

## 四、发布链路（实际执行）

```
1. 版本升级    node tools/release-119.mjs version --to 1.4.0     → 6 个文件（含下载 URL）
2. 版本校验    node tools/release-119.mjs check                  → 9/9 ✓
3. Web 构建    pnpm --filter @neomd/web build                    → dist/
4. 桌面端构建  node apps/desktop/build.mjs                       → zip 152MB + exe 108MB
5. Android 构建 node apps/android/build.mjs                      → apk 4.2MB（BUILD SUCCESSFUL）
6. 产物归位    cp dist-artifacts/NeoMD-1.4.0.apk services/api/releases/   ← **源头**（关键）
7. 部署包      make-deploy.mjs → 自动带进 dist-artifacts/deploy/server/releases/
8. 发版门禁    node tools/re14-release-gate.mjs                  → 3/3 ✓（三层校验）
9. OSS 上传    node tools/publish-releases.mjs                   → 三端全传
10. 生产部署   宝塔 MCP：备份 → 解压 → 删 assets → 覆盖 → chown → node --check → 重启
11. schema     users 3 列 + release_downloads 表 + 3 索引（幂等，二次执行零变更）
12. GitHub     提交 → 推送 main → tag v1.4.0 → Release + 3 资产
13. 发布验收   node tools/verify-119-github.mjs --version 1.4.0  → 20/20 ✓
14. 本机实测   node tools/re14-verify-portable.mjs "<解压目录>"   → 14/14 ✓
```

**第 6 步是本次新增的强制步骤**：1.3.1 期间发现 APK 只在生产服务器上（手工放入），`services/api/releases/` 与部署产物都没有 —— 一旦用部署包重部署就会再次 404。把 APK 放进**源头**（`services/api/releases/`），`make-deploy.mjs` 才会带进部署包，这样「任何人重新打包都不会丢」。

---

## 五、发布验收结果

| 门禁 | 结果 |
|---|---|
| `verify-140.mjs`（16 项需求 + 负向对照） | **59 通过 / 0 失败**，exit=0 |
| `verify-121.mjs`（1.3.1 六项不得回归） | **45 通过 / 0 失败** |
| `re14-settings-audit.mjs`（设置逐项） | **18 通过 / 0 失败**（无效项 0） |
| `re14-settings-save-verify.mjs`（保存语义） | **15 通过 / 0 失败** |
| `re14-builtin-plugins.mjs`（26 款） | **26 款失败 0** |
| `re14-release-gate.mjs`（发版产物） | **3/3 通过** |
| `verify-119-github.mjs`（发布状态） | **20 通过 / 0 失败** |
| `re14-verify-portable.mjs`（本机绿色版） | **14 通过 / 0 失败** |
| `vitest run` | **295 passed / 12 files** |
| `vue-tsc --noEmit` / `tsc` | **0 错误 / 0 错误** |
| `node --check`（services/api/src 35 文件） | **0 失败** |
| `release-119.mjs check` | **9/9 ✓** |
| 生产 `/api/health` | `version: "1.4.0"`，`db: true` |
| 生产 APK 下载 | `200`，4,410,655 B（SHA256 一致） |
| 生产 Windows 安装包 | `302` → OSS 预签名 |
| 生产 DB schema | 封禁 3 列 + `release_downloads` 表 + 3 索引全部生效 |

---

## 六、升级影响与注意事项

### 需要迁移的交互变更

1. **设置改为草稿模式**（需求16）：改动不点「保存」不再即时生效。**所有自动化脚本**在断言设置生效前必须插入「点保存」步骤（`[data-testid="settings-save"]`）。
2. **`splitRatio` 语义统一**为「第一栏占比」：左右分屏表示左栏、上下分屏表示上栏。极少数把比例调到非 50% 且已持久化的老用户，首次打开会看到上下比例对调（历史值本身按旧的反向语义存）。考虑到改前拖动实际不可用（偏差 129~672px），未做数据迁移。

### 无需迁移

- **数据库**：本版变更全部是**幂等增量**（3 列 + 1 表 + 3 索引），启动时自动执行；实测二次执行 `columns=0 tables=0 indexes=0`，生产库迁移前后逐表行数一致。
- **配置**：无需改动任何环境变量。
- **客户端设置**：乱码数据已在服务端修复；客户端下次拉取即得到正确值。

### 已知遗留（详见 ACCEPTANCE-140 第四章）

1. 斜杠命令行内 `/` 触发、页面预览行内悬停浮层（需编辑器扩展层，1.5）
2. 服务端与前端两份插件校验器（规则靠人工对齐，正解是下沉 shared 构建）
3. `SettingsModal.vue` 死代码、`admin.js` 已达 3473 行
4. 云端历史版本无数量上限
5. 封禁到期为惰性解封（读列表时纠正）

---

## 七、回滚

生产回滚点：`/www/backup/neomd-140-20261031-083612/`

```bash
BK=/www/backup/neomd-140-20261031-083612
cd /www/wwwroot/md.zhengl.vip

rm -rf public && cp -a "$BK/public.bak" public
rm -rf server/src && tar -xzf "$BK/server-src.tar.gz" -C server
cp -a "$BK/package.json.bak" server/package.json
cp -a "$BK/.env.bak" server/.env
chown -R www:www public server
# mcp__baota__NodeProjectControl({ project_name:'neomd', action:'restart' })
```

回滚后 `curl https://md.zhengl.vip/api/health` 应返回 `version: "1.3.1"`。

> **schema 不回滚**：新增的 3 列 / 1 表 / 3 索引对 1.3.1 完全兼容（1.3.1 不读它们），保留即可。回滚应用代码后封禁功能不可用，但账号与数据不受影响。
>
> **GitHub 的 tag 与 Release 不会自动撤销**；如需彻底回退版本线需另发 1.4.1。
