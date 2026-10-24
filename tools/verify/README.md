# 自动化验证

用真实 Chromium 与模拟 S3 服务验证核心链路，无需人工点击。

## 准备

```powershell
cd tools\verify
npm install
```

脚本会自行启动静态服务器与模拟服务，无需预先运行 `npm run dev`。
其中 `prod-e2e.cjs`、`sync-e2e.cjs` 依赖 `app/dist`，请先构建前端：

```powershell
cd app && npx vite build
```

浏览器使用本机已安装的 Chrome 或 Edge，不额外下载。

## 脚本

| 脚本 | 验证内容 |
|---|---|
| `sig-test.cjs` | AWS SigV4 签名与 URL 编码（对照 AWS 官方测试向量） |
| `render-e2e.cjs` | 编辑器所见即所得渲染与交互（任务框、表格、链接、代码块、光标还原） |
| `prod-e2e.cjs` | 生产构建全量回归（新建、保存、历史版本、设置、命令面板、移动端溢出） |
| `sync-e2e.cjs` | S3 双向同步端到端（启动模拟 S3 → 上传 → 修改 → 再同步 → 校验远端对象） |
| `mock-s3.cjs` | 供 `sync-e2e.cjs` 使用的内存 S3 服务，含服务端 SigV4 验签 |

## 运行

```powershell
node sig-test.cjs      # 签名校验，输出对照结果
node render-e2e.cjs    # 截图与断言写入 out/
node prod-e2e.cjs
node sync-e2e.cjs
```

断言结果与截图输出在 `out/`（已加入 `.gitignore`）。
