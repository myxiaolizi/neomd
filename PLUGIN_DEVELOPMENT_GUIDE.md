# Neo MD 插件开发指南（Plugin SDK）

> 本文档随 Neo MD 主仓库以 [MIT 许可证](./LICENSE) 开源，欢迎提交 PR 补充示例与修正。
>
> **边界声明**：插件市场（应用商店）**始终使用官方统一服务，不支持私有化部署**。本指南中的「发布到插件开放平台」指发布到官方市场；自建服务端不影响插件市场的浏览、下载与发布。

Neo MD 提供轻量、免构建工具链的插件扩展体系。开发者既可以手工编写单文件 JavaScript 插件，也可以直接将本指南中的 AI 提示词模板发给大模型（如 DeepSeek、MiMo、通义千问等），在 30 秒内生成可运行的插件脚本。

生成的插件可通过以下两种方式使用：
1. **本地导入运行（Web 端与 Windows PC 端通用）**：进入「个人中心 → 插件市场与开放平台 → 导入本地插件脚本」，选择 `.js` 文件或直接粘贴代码即可启用，并在编辑器命令面板（`Ctrl+P`）中运行。
2. **发布到插件开放平台**：登录账号后在「个人中心 → 插件市场与开放平台 → 发布插件」中提交插件代码与简介，即可向全体用户公开，并在「开发者中心」实时查看安装量与获赞统计，或随时推送版本更新。

---

## 一、插件文件结构规范

一个标准的 Neo MD 插件是一个导出默认配置对象的 JavaScript 模块：

```js
export default {
  // 1. 插件唯一标识（必填，小写字母、数字与短横线）
  id: 'my-plugin-id',

  // 2. 插件显示名称（必填）
  name: '我的自定义插件',

  // 3. 语义化版本号（必填）
  version: '1.0.0',

  // 4. 插件入口函数：当用户在编辑器中触发插件时调用
  setup(api) {
    api.registerCommand({
      id: 'myPlugin.action',
      title: '在文末追加时间戳签名',
      run() {
        const now = new Date().toLocaleString('zh-CN');
        api.insertMarkdown(`\n\n> ✍️ 签署时间：${now}\n`);
        api.notify('已插入时间戳签名', 'success');
      }
    });
  }
};
```

---

## 二、宿主 API（`api` 对象）参考

在 `setup(api)` 中，宿主向插件注入以下安全接口：

| 方法签名 | 说明 |
| --- | --- |
| `api.getMarkdown(): string` | 获取当前活动文档的完整 Markdown 源码字符串 |
| `api.setMarkdown(next: string): void` | 使用新的 Markdown 字符串完整替换当前文档正文（自动标记未保存并触发自动保存） |
| `api.insertMarkdown(snippet: string): void` | 在当前文档末尾追加一段 Markdown 内容 |
| `api.getTitle(): string` | 获取当前活动文档的标题（不含 `.md` 扩展名） |
| `api.registerCommand({ id, title, run }): void` | 注册并执行插件命令 |
| `api.notify(message: string, type?: 'info' \| 'success' \| 'error'): void` | 在工作区底部弹出轻量提示消息 |

---

## 三、完整示例插件

### 示例 1：提取全文所有任务项汇总到文末

```js
export default {
  id: 'task-collector',
  name: '待办任务汇总器',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'taskCollector.run',
      title: '提取全文未完成待办并汇总到末尾',
      run() {
        const md = api.getMarkdown() || '';
        const todoLines = md
          .split(/\r?\n/)
          .filter((line) => /^\s*-\s*\[\s\]\s+/.test(line));
        if (!todoLines.length) {
          api.notify('当前文档没有未完成的待办项', 'info');
          return;
        }
        const summary = [
          '',
          '## 📋 未完成待办汇总',
          ...todoLines,
          ''
        ].join('\n');
        api.insertMarkdown(summary);
        api.notify(`已汇总 ${todoLines.length} 项待办任务`, 'success');
      }
    });
  }
};
```

### 示例 2：一键为二级标题自动添加中文序号

```js
export default {
  id: 'heading-numbering',
  name: '二级标题自动编号',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'headingNumbering.run',
      title: '为所有 H2 标题添加中文序号',
      run() {
        const cn = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
        let idx = 0;
        const next = (api.getMarkdown() || '')
          .split(/\r?\n/)
          .map((line) => {
            if (/^##\s+/.test(line)) {
              const clean = line.replace(/^##\s+([一二三四五六七八九十]+、)?/, '');
              const num = cn[idx] || String(idx + 1);
              idx += 1;
              return `## ${num}、${clean}`;
            }
            return line;
          })
          .join('\n');
        api.setMarkdown(next);
        api.notify(`已为 ${idx} 个二级标题添加序号`, 'success');
      }
    });
  }
};
```

---

## 四、使用 AI 自动生成插件的标准提示词

将以下提示词复制给 AI 助手，即可直接获得符合规范的插件代码：

```text
请为我编写一个 Neo MD 编辑器插件（单文件 JavaScript 模块），功能需求是：
【在此描述你的需求】

请只输出 JavaScript 代码，结构如下：
export default {
  id: '英文短横线ID',
  name: '插件中文名',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: '命令ID',
      title: '命令名称',
      run() {
        // 可使用 api.getMarkdown() / api.setMarkdown(str) / api.insertMarkdown(str) / api.getTitle() / api.notify(msg, 'success')
      }
    });
  }
};
```

---

## 五、开源与贡献

- 本指南与 Plugin SDK 规范属于 Neo MD 开源项目的一部分，遵循 [MIT 许可证](./LICENSE)；
- 插件脚本本身由作者自行决定许可证，但发布到官方插件市场即表示同意官方对该条目进行审核、展示与分发；
- 发现文档错误、缺少 API 说明，或想补充示例插件，请按 [贡献指南](./CONTRIBUTING.md) 提交 PR；
- 安全相关问题（例如 SDK 权限边界、插件执行沙箱的绕过）请遵循 [安全策略](./SECURITY.md) 私下报告，不要开公开 Issue。

相关文档：

- [自建部署指南 →](./docs/DEPLOYMENT.md)
- [自建服务端与 PC 端「自定义服务器」→](./docs/SELF_HOSTING.md)
- [贡献指南 →](./CONTRIBUTING.md)
- [安全策略 →](./SECURITY.md)

