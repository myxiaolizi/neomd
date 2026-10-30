/**
 * 用「索引里暂存的内容」在临时目录里跑一次真实构建校验。
 *
 *   node tools/verify-staged-build.mjs
 *
 * 目的：确认即将提交的这一版 EditorPage.vue 能独立通过 TS 检查与 Vite 构建，
 * 避免把「工作树能跑、提交后挂掉」的改动推上去。
 *
 * 做法：
 * 1) 建临时目录，把索引中的 apps/web + packages/shared 关键文件按 git 内容写出；
 * 2) 直接用 esbuild（vite 内置依赖）对暂存的 EditorPage.vue 做语法/转换校验；
 * 3) 用 TypeScript 编译器 API 对暂存文件做单文件语法诊断。
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const FILE = 'apps/web/src/views/EditorPage.vue';

const staged = execSync(`git show :${FILE}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const dir = mkdtempSync(join(tmpdir(), 'nm-build-check-'));
const tmpFile = join(dir, 'EditorPage.vue');
writeFileSync(tmpFile, staged, 'utf8');

const results = [];

// --- 1) esbuild 转换（vite 的 SFC 脚本一旦有语法错误，这里会直接失败） ---
try {
  // pnpm 布局下 esbuild 不在根 node_modules，按 pnpm store 路径兜底加载
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch {
    // pnpm 布局：根 node_modules 没有 esbuild，走 .pnpm 虚拟存储
    esbuild = require(join(process.cwd(), 'node_modules', '.pnpm', 'node_modules', 'esbuild'));
  }
  const scriptMatch = /<script[^>]*>([\s\S]*?)<\/script>/.exec(staged);
  if (!scriptMatch) throw new Error('未找到 <script> 块');
  const ts = scriptMatch[1];
  esbuild.transformSync(ts, { loader: 'ts', target: 'es2020' });
  results.push(['esbuild 转换 TS 脚本块', true, '']);
} catch (e) {
  results.push(['esbuild 转换 TS 脚本块', false, e.message.split('\n')[0]]);
}

// --- 2) TypeScript 语法诊断（只做语法层，不做类型解析，避免依赖整个工程） ---
try {
  const ts = require('typescript');
  const scriptMatch = /<script[^>]*>([\s\S]*?)<\/script>/.exec(staged);
  const ts2 = scriptMatch[1];
  const sf = ts.createSourceFile('EditorPage.ts', ts2, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
  const diags = sf.parseDiagnostics || [];
  if (diags.length === 0) {
    results.push(['TypeScript 语法诊断', true, '']);
  } else {
    const msg = diags
      .slice(0, 3)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))
      .join(' | ');
    results.push(['TypeScript 语法诊断', false, msg]);
  }
} catch (e) {
  results.push(['TypeScript 语法诊断', false, e.message.split('\n')[0]]);
}

// --- 3) 关键逻辑运行验证：用暂存文件里的实现跑一个带注释的插件 ---
try {
  const impl = /function normalizePluginSource\(codeJs: string\): string \{[\s\S]*?\n\}/.exec(staged);
  if (!impl) throw new Error('未找到 normalizePluginSource 实现');
  const js = impl[0].replace(/: string/g, '').replace(/codeJs: string/, 'codeJs');
  const fn = new Function(`${js}; return normalizePluginSource;`)();
  const plugin = "/**\n * 文件头注释\n */\nexport default { id: 'x', setup(api) { api.notify('ok'); } };";
  const out = fn(plugin);
  const ok = /^\/\*\*[\s\S]*return \{/.test(out) && !out.includes('export default');
  results.push(['normalizePluginSource 处理带注释插件', ok, ok ? '' : out.slice(0, 80)]);
} catch (e) {
  results.push(['normalizePluginSource 处理带注释插件', false, e.message.split('\n')[0]]);
}

console.log(`校验对象：索引中暂存的 ${FILE}（${staged.length} 字符）`);
console.log('─'.repeat(60));
let failed = 0;
for (const [name, pass, detail] of results) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!pass) failed += 1;
}
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
