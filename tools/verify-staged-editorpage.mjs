/** 校验索引中暂存的 EditorPage.vue 只含插件修复、不含并行改动 */
import { execSync } from 'node:child_process';

const content = execSync('git show :apps/web/src/views/EditorPage.vue', {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024
});

const checks = [
  ['含 normalizePluginSource 定义', content.includes('function normalizePluginSource')],
  ['调用处已替换', content.includes('normalizePluginSource(item.codeJs)')],
  ['含多行标志修复', content.includes('export\\s+default\\s+/m')],
  ['含 BOM 剥离', content.includes('\\uFEFF')],
  ['旧缺陷调用已移除', !content.includes("item.codeJs.replace(/^\\s*export\\s+default\\s+/, 'return ')")],
  ['未混入他人分屏配色改动', !content.includes('分屏第二栏必须用')],
  ['未混入他人 flex 改动', !content.includes('--content-bg, var(--bg-elevated)')]
];

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}`);
  if (!pass) failed += 1;
}
console.log(`文件长度 ${content.length} 字符`);
process.exit(failed ? 1 : 0);
