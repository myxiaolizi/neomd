/**
 * 只把「插件源码规范化」这一处修复写进 Git 索引，不触碰工作树里其他并行改动。
 *
 * 用法：node tools/stage-plugin-hunk.mjs [--dry-run]
 *
 * 为什么不用 `git apply --cached` 挑 hunk：
 * EditorPage.vue 同时存在其他并行工作的改动，手工拼 hunk 的补丁很容易因行数不符而 corrupt。
 * 这里改成确定性做法——
 *   1) 取 HEAD 版本内容；
 *   2) 在 HEAD 内容上只施加本修复的两处文本替换；
 *   3) 把结果写入索引（git hash-object + git update-index）；
 *   4) 工作树文件保持原样（含他人改动）不动。
 */
import { execSync } from 'node:child_process';

const FILE = 'apps/web/src/views/EditorPage.vue';
const dryRun = process.argv.includes('--dry-run');
const git = (cmd, opts = {}) => execSync(`git ${cmd}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

// 1) HEAD 版本
const headContent = git(`show HEAD:${FILE}`);

// 2) 两处替换（与工作树中的实现完全一致）
const OLD_CALL = "    const cleaned = item.codeJs.replace(/^\\s*export\\s+default\\s+/, 'return ');";

const NEW_FN = `/**
 * 把社区插件源码规范化成可交给 \`new Function\` 的函数体。
 *
 * 插件文件是 ESM 模块，形如：
 *   /** 说明注释 *\\/
 *   export default { id, name, version, setup(api) { ... } };
 *
 * 1.2.x 及以前只用 \`/^\\s*export\\s+default\\s+/\` 替换，**没有 \`m\` 标志**——
 * 于是「文件头带注释」的插件（这是 PLUGIN_DEVELOPMENT_GUIDE 与市场里最常见的写法）
 * 替换不生效，\`new Function\` 直接抛 \`SyntaxError: Unexpected token 'export'\`，
 * 用户点命令只会看到「插件执行异常」。1.3.0 修正为多行匹配，并兼容：
 *   - 前置注释 / 空行；
 *   - \`export default\` 后换行再写对象；
 *   - 已经写成 \`return {...}\` 的旧脚本（幂等，不重复加 return）。
 */
function normalizePluginSource(codeJs: string): string {
  const src = String(codeJs ?? '').replace(/^\\uFEFF/, '');
  if (!/\\bexport\\s+default\\b/.test(src)) {
    // 已经是函数体（历史脚本），原样返回
    return src;
  }
  const cleaned = src.replace(/^\\s*export\\s+default\\s+/m, 'return ');
  // 极少数写法把 export default 放在行尾之外的位置，兜底再替换一次
  return cleaned.replace(/\\bexport\\s+default\\s+/, 'return ');
}

function runCommunityPlugin(item: { pluginId: string; name: string; codeJs: string }): void {`;

const OLD_FN_SIG = 'function runCommunityPlugin(item: { pluginId: string; name: string; codeJs: string }): void {';

if (!headContent.includes(OLD_CALL)) {
  console.error('HEAD 中找不到待替换的旧调用行，已中止');
  process.exit(1);
}
if (!headContent.includes(OLD_FN_SIG)) {
  console.error('HEAD 中找不到 runCommunityPlugin 签名，已中止');
  process.exit(1);
}

let next = headContent.replace(OLD_FN_SIG, NEW_FN);
next = next.replace(OLD_CALL, '    const cleaned = normalizePluginSource(item.codeJs);');

if (next === headContent) {
  console.error('替换未产生变化，已中止');
  process.exit(1);
}
if (!next.includes('normalizePluginSource(item.codeJs)')) {
  console.error('替换结果校验失败，已中止');
  process.exit(1);
}

// 3) 写入索引
if (dryRun) {
  console.log(`[dry-run] 将写入索引：${FILE}（${headContent.length} → ${next.length} 字符）`);
  process.exit(0);
}

const { writeFileSync, mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const dir = mkdtempSync(join(tmpdir(), 'nm-idx-'));
const tmp = join(dir, 'EditorPage.vue');
writeFileSync(tmp, next, 'utf8');

const hash = git(`hash-object -w "${tmp}"`).trim();
git(`update-index --cacheinfo 100644,${hash},${FILE}`);
console.log(`已把仅含插件修复的版本写入索引：${FILE}`);
console.log(`  blob ${hash.slice(0, 12)}…  长度 ${next.length} 字符`);
console.log('工作树文件保持原样（其他并行改动未被提交）');
