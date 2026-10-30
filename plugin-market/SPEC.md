# Neo MD 社区插件实现规范（50 款 · 日常使用 & 协作）

本目录是 **Neo MD 插件商店（社区插件）** 的官方插件集合，共 50 款单文件 JavaScript 插件，
面向「日常使用」与「协作」两类高频场景。本规范是全部插件的实现契约，任何一款插件都必须
满足这里列出的每一条硬性要求；`plugin-market/validate.mjs` 会逐条校验。

参考文档：仓库根目录 `PLUGIN_DEVELOPMENT_GUIDE.md`（Plugin SDK 官方指南）。

---

## 一、文件位置与命名

| 项 | 要求 |
| --- | --- |
| 目录 | `plugin-market/plugins/` |
| 文件名 | `NN-<插件id>.js`，`NN` 为两位序号（01–50），id 必须与 `PLAN.json` 一致 |
| 示例 | `plugin-market/plugins/01-daily-standup-log.js` |
| 编码 | UTF-8，LF 换行，文件末尾必须有一个换行 |
| 体积 | 单文件 ≤ 12 KB |

一个文件 = 一款插件。**不允许**跨文件 import、不允许拆分多个文件。

---

## 二、模块契约

每个文件必须是一个 ES 模块，且**只有**一个默认导出：

```js
export default {
  id: 'daily-standup-log',        // 与 PLAN.json 完全一致，小写字母/数字/短横线
  name: '每日站会日志',             // 与 PLAN.json 完全一致
  version: '1.0.0',               // 统一 1.0.0
  setup(api) { /* ... */ }
};
```

`setup` 内**只能注册一个命令**，且必须与 `PLAN.json` 的 `commandId` / `commandTitle` 一致：

```js
api.registerCommand({
  id: 'daily.standupLog',
  title: '插入今日站会日志（昨天 / 今天 / 阻塞）',
  run() { /* 全部实际逻辑写在这里 */ }
});
```

> **重要：宿主语义**。`registerCommand` 在宿主中是「注册并立即执行」——调用后宿主会马上
> 执行 `run()`。因此：
> 1. 一个插件只注册一个命令，多注册会导致多个 `run()` 同时执行、互相覆盖文档；
> 2. 不要在 `setup` 里写业务逻辑，全部写在 `run()` 里；
> 3. 命令标题 ≤ 28 个字符，一句话说清「插入/生成/汇总什么」。

---

## 三、可用宿主 API（只有这 6 个）

| 方法 | 说明 | 使用要求 |
| --- | --- | --- |
| `api.getMarkdown()` | 返回当前文档完整 Markdown 字符串 | 可能为空字符串，必须兜底 `\|\| ''` |
| `api.setMarkdown(next)` | 整篇替换文档正文 | 会标记未保存并触发自动保存 |
| `api.insertMarkdown(snippet)` | 在文档**末尾**追加内容 | 需要前置换行时自行拼接 |
| `api.getTitle()` | 当前文档标题（不含 `.md`） | 仅用于文案展示，可能为空 |
| `api.notify(msg, type)` | 底部提示，`type` ∈ `'info' \| 'success' \| 'error'` | 每次执行结束前必须调用且仅调用一次 |
| `api.registerCommand(cmd)` | 注册命令（见上，立即执行） | 只调用一次 |

其它一切都是 **Web 平台原生 JavaScript**（`String`/`RegExp`/`Array`/`Math`/`Date`/`JSON`/`Intl`）。

---

## 四、硬性禁止项

代码中**不得出现**以下标识符或语句（校验器会做源码扫描）：

- DOM / 浏览器全局：`document`、`window`、`navigator`、`localStorage`、`sessionStorage`、`alert`、`confirm`、`prompt`
- 网络：`fetch`、`XMLHttpRequest`、`WebSocket`、`axios`
- 动态执行：`eval(`、`new Function`、`require(`、`import(`、`import ` 语句（ES import 语法）
- 定时器/异步：`setTimeout`、`setInterval`、`requestAnimationFrame`、`Promise`、`async `、`await `
- 宿主未提供的 API：`api.*` 里除上表 6 个方法外的任何调用（例如 `api.save`、`api.openDialog` 一律不存在）
- TypeScript 语法、JSX、顶层 `await`

> 理由：插件在 Web / Windows PC / Android 三个宿主中运行，宿主只保证上表 API 与纯 JS 运行时；
> 异步与 DOM 访问会让插件在不同端表现不一致，也会让「一次命令 = 一次同步文档变更」的模型失效。

允许并鼓励使用：`?.`、`??`、模板字符串、`Array.prototype.at/flat/map/filter`、`String.raw`、
`Intl.NumberFormat`、`new Date().toISOString()`（宿主为现代内核，ES2020 语法安全）。

---

## 五、三种输出模式与幂等要求

`PLAN.json` 的 `mode` 字段指定该插件属于哪一类，**行为必须严格符合**：

### `mode: "section"` —— 生成/更新标记区块（**必须幂等**）

在文档中维护一块带标记的内容区。区块标记固定为两行 HTML 注释：

```md
<!-- nm:daily-standup-log -->
（生成的内容）
<!-- /nm:daily-standup-log -->
```

规则：
1. 若文档中已存在成对标记，则把两个标记之间的内容整体替换为本次生成的内容（保留标记行本身）；
2. 若不存在，则把整块（含标记）追加到文末，与上文之间空一行；
3. 标记行必须各自独占一行，且 `id` 与插件 `id` 完全一致；
4. **连续执行两次，文档内容必须完全一致**（校验器会实测比对）。

### `mode: "inplace"` —— 就地改写正文（**必须幂等**）

不新增标记区块，直接修正文档正文（排版、编号、链接、表格等）。规则：

1. 只改需要改的行，尽量保留原文其它内容与空行结构；
2. **连续执行两次，文档内容必须完全一致**；
3. 没有任何可修正内容时，原样调用一次 `notify(..., 'info')` 并 `return`，**不要**写回文档。

### `mode: "append"` —— 每次执行追加一份模板（不要求幂等）

模板类插件（会议纪要、日终清单、周报…）。规则：

1. 输出内容必须自带日期或标题行，便于用户区分多次插入；
2. 追加前确保与上文之间恰好隔一个空行（即拼接 `'\n' + block` 或 `'\n\n' + block`，
   不要产生三行以上连续空行）；
3. 允许重复执行产生多份模板（用户可能一天开两次会）。

---

## 六、健壮性要求（全部为硬性）

1. **永不抛异常**：空文档、超短文档、纯代码块文档、含 BOM/CRLF 的文档都必须正常返回；
   任何可能访问 `undefined` 的地方都要兜底。
2. **围栏代码块内不处理**：所有按行处理正文的逻辑，都必须跳过 ``` 与 ~~~ 围栏内部内容，
   避免把代码里的 `# 标题`、`- [ ]`、`| 表格 |` 当成正文。统一使用第七节的 `mapOutsideFence`。
3. **CRLF 安全**：读入后用 `md.split(/\r?\n/)`，输出统一 `join('\n')`。
4. **BOM 安全**：入口先 `md.replace(/^\uFEFF/, '')`。
5. **不改动用户看不出来的东西**：不删除用户内容（`append` 除外），不重排无关行。
6. **数量下限保护**：需要统计/汇总的插件，在结果为空时给出 `notify(..., 'info')` 说明
   「未找到…」并直接 `return`，不要生成空表格或空章节。
7. **输出规模上限**：汇总类插件最多输出 200 行 / 50 条明细，超出时截断并标注「等 N 项」。

---

## 七、可复制的工具函数（按需内联，不要抽公共文件）

### 7.1 跳过围栏代码块逐行处理（必用）

```js
function mapOutsideFence(md, visit) {
  const lines = String(md || '').split(/\r?\n/);
  const out = new Array(lines.length);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out[i] = line;
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    } else if (m) {
      fence = m[1];
      out[i] = line;
    } else {
      out[i] = visit(line, i);
    }
  }
  return out.join('\n');
}
```

### 7.2 区块读写（`section` 模式必用）

```js
const BEGIN = '<!-- nm:my-plugin-id -->';
const END = '<!-- /nm:my-plugin-id -->';

/** 有则替换块内内容，无则追加到文末；返回新全文 */
function upsertSection(md, block) {
  const text = String(md || '').replace(/^\uFEFF/, '');
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b >= 0 && e > b) {
    const head = text.slice(0, b + BEGIN.length);
    const tail = text.slice(e);
    return head + '\n' + block.trim() + '\n' + tail;
  }
  const trimmed = text.replace(/\s+$/, '');
  return (trimmed ? trimmed + '\n\n' : '') + BEGIN + '\n' + block.trim() + '\n' + END + '\n';
}
```

> 校验器要求：第二次执行必须得到完全相同的字符串。所以 `upsertSection` 内部不要附带时间戳；
> 若内容确实需要日期（如「汇总于 2026-10-30」），该日期在同一天内是稳定值，可以接受。

### 7.3 常用文本工具

```js
function countCjk(s) { const m = String(s).match(/[\u4e00-\u9fff]/g); return m ? m.length : 0; }
function countEnWords(s) { const m = String(s).match(/[A-Za-z][A-Za-z'-]*/g); return m ? m.length : 0; }
function todayIso() { return new Date().toISOString().slice(0, 10); }
function bar(done, total, width) {
  const n = total > 0 ? Math.round((done / total) * width) : 0;
  return '█'.repeat(n) + '░'.repeat(Math.max(0, width - n));
}
```

---

## 八、文案规范

- 全部面向用户文案使用**简体中文**；技术标识（id、commandId、section 标记）用英文。
- `notify` 成功用 `'success'`（如 `已汇总 12 项待办`），无可处理内容用 `'info'`，
  真正失败（不应发生）用 `'error'`。
- 生成的内容标题使用 `##`/`###` 级别，与文档既有层级不冲突；同一插件多次执行只应有一处区块。
- 不要输出营销文案、不要写「本插件由 AI 生成」之类无关内容。

---

## 九、文件头注释模板（每个文件必须有）

```js
/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：01 | 分组：日常使用 · 时间与日志
 * id: daily-standup-log | 命令: daily.standupLog
 * 说明：在文末插入一份带日期的每日站会三段式日志模板。
 * 模式：append
 */
```

字段与 `PLAN.json` 一一对应，方便审核与市场展示。

---

## 十、完整参考实现（`section` 模式范式）

```js
/**
 * Neo MD 社区插件 · 50 款日常协作套件
 * 编号：16 | 分组：日常使用 · 写作与整理
 * id: todo-progress-rollup | 命令: writing.todoProgress
 * 说明：统计全文待办完成情况并在文末生成完成率进度条。
 * 模式：section
 */
const BEGIN = '<!-- nm:todo-progress-rollup -->';
const END = '<!-- /nm:todo-progress-rollup -->';

function upsertSection(md, block) {
  const text = String(md || '').replace(/^\uFEFF/, '');
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b >= 0 && e > b) {
    return text.slice(0, b + BEGIN.length) + '\n' + block.trim() + '\n' + text.slice(e);
  }
  const trimmed = text.replace(/\s+$/, '');
  return (trimmed ? trimmed + '\n\n' : '') + BEGIN + '\n' + block.trim() + '\n' + END + '\n';
}

export default {
  id: 'todo-progress-rollup',
  name: '待办进度条',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'writing.todoProgress',
      title: '统计待办完成率并生成进度条',
      run() {
        const md = api.getMarkdown() || '';
        let done = 0;
        let open = 0;
        const lines = md.split(/\r?\n/);
        let fence = null;
        for (const line of lines) {
          const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
          if (fence) {
            if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
            continue;
          }
          if (f) { fence = f[1]; continue; }
          if (/^\s*[-*]\s+\[[xX]\]\s+/.test(line)) done += 1;
          else if (/^\s*[-*]\s+\[\s*\]\s+/.test(line)) open += 1;
        }
        const total = done + open;
        if (total === 0) {
          api.notify('当前文档没有待办项', 'info');
          return;
        }
        const width = 12;
        const filled = Math.round((done / total) * width);
        const pct = Math.round((done / total) * 100);
        const block = [
          '## ✅ 待办进度',
          '',
          '`' + '█'.repeat(filled) + '░'.repeat(width - filled) + '` ' + pct + '%',
          '',
          '- 已完成：' + done,
          '- 未完成：' + open,
          '- 合计：' + total
        ].join('\n');
        api.setMarkdown(upsertSection(md, block));
        api.notify('待办完成率 ' + pct + '%（' + done + '/' + total + '）', 'success');
      }
    });
  }
};
```

---

## 十一、自检与验收

实现完成后必须自跑校验（在仓库根 `neomd-V1/` 下）：

```bash
node plugin-market/validate.mjs            # 校验全部 50 款
node plugin-market/validate.mjs --group 2  # 只校验第 2 组
```

校验器会检查：文件存在与命名、元数据与 PLAN 一致、单命令、无禁用标识符、体积限制、
四个样本文档下不抛异常、区块/就地模式的幂等性、空文档兜底、notify 调用。

**验收标准：`0 error`，警告需逐条说明原因。**

---

## 十二、提交与发布

插件文件确认通过校验后，由维护者统一通过
「个人中心 → 插件市场与开放平台 → 发布插件」逐条提交，或使用
`plugin-market/publish-plan.md` 中的参数表批量填写（`PLAN.json` 已包含全部元数据：
`id / name / version / category / icon / description / readme`）。

插件市场只走官方服务（`https://md.zhengl.vip`），不支持私有化部署；本地验证请使用
「导入本地插件脚本」，或 `plugin-market/install-local.js` 批量写入本地已安装列表。
