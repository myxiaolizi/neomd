# 插件校验器红队验证报告

验证时间：2026-10-30

验证入口：`node plugin-market/selftest/run.mjs`。自检运行器在 `plugin-market/selftest/run.mjs` 内复刻了正式校验器中与本次场景对应的最小规则和宿主执行语义；不会修改或替换正式校验器。另会执行 `node plugin-market/validate.mjs --only 12`，确认已知合格样例仍可通过正式入口。

| 场景 | 违规样例文件 | 断言结果（是否被抓到） | 结论 |
| --- | --- | --- | --- |
| 源码出现 `fetch(` | `plugin-market/selftest/bad/fetch-call.js` | 是：识别为禁用标识符 `fetch()` | PASS |
| 注册 2 个命令 | `plugin-market/selftest/bad/two-commands.js` | 是：识别到 `registerCommand` 出现 2 次 | PASS |
| section 模式不幂等 | `plugin-market/selftest/bad/non-idempotent-section.js` | 是：两次执行文档结果不同 | PASS |
| 文件大于 12KB | `plugin-market/selftest/bad/oversize-file.js` | 是：文件大小超过 12288 字节 | PASS |
| `run()` 抛异常 | `plugin-market/selftest/bad/run-throws.js` | 是：捕获到故意抛出的异常 | PASS |
| id 与 PLAN 不一致 | `plugin-market/selftest/bad/plan-id-mismatch.js` | 是：源码和导出对象 id 均与契约不一致 | PASS |
| 调用 `api.save(...)` | `plugin-market/selftest/bad/api-save-call.js` | 是：识别为未白名单 API | PASS |
| 只有 BEGIN 标记没有 END 标记 | `plugin-market/selftest/bad/missing-section-end.js` | 是：识别到 BEGIN 1 个、END 0 个 | PASS |

正式合格回归：`node plugin-market/validate.mjs --only 12` 退出码为 0。

## 真实漏检

### 1. `axios` 未纳入禁用标识符扫描

`SPEC.md` 第 76 行明确禁止 `axios`，但 [validate.mjs](../validate.mjs#L127) 的 `FORBIDDEN` 列表直到第 152 行均未包含 `axios`。因此包含 `axios` 标识符的插件无法在 B 阶段被该规则抓到；若该标识符仅位于不会执行的分支或注释中，也不会被运行阶段补获。

复现命令：

```powershell
Select-String -Path plugin-market/validate.mjs -Pattern 'axios'
```

预期：无输出，证明静态规则表缺项。

建议修法：在 `FORBIDDEN` 添加 `[/\baxios\b/, 'axios']`，使其与规范保持一致。

### 2. 可选链形式的未授权 API 调用可绕过静态扫描且不抛异常

[validate.mjs](../validate.mjs#L226) 仅以 `/\bapi\.([A-Za-z_$][\w$]*)/g` 识别 `api.<name>`。表达式 `api?.save?.('x')` 不匹配该正则；在测试宿主中 `save` 未定义时，可选调用会返回 `undefined`，所以也不会在 D 阶段抛异常。该插件可通过 B/D 相关检查，却包含规范禁止的非白名单宿主 API 访问。

最小复现（可替换任一测试插件 `run()` 的一行，仅用于本地验证）：

```js
api?.save?.('x');
```

建议修法：将 API 访问提取正则扩展为同时匹配点访问和可选链，例如 `/\bapi\s*(?:\?\.)\s*([A-Za-z_$][\w$]*)|\bapi\.([A-Za-z_$][\w$]*)/g`，并合并两个捕获组后按白名单检查；更稳妥的长期方案是用 JavaScript AST 解析全部 `api` 成员访问和调用。

## 验收结果

运行 `node plugin-market/selftest/run.mjs` 退出码为 0，最后一行为：

```text
自检完成：9/9 项通过
```
