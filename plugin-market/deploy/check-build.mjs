/** 校验构建产物中插件源码转换逻辑是否为修复后的版本 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'apps/web/dist/assets';
const files = readdirSync(dir).filter((f) => f.startsWith('EditorPage-') && f.endsWith('.js'));

const OLD_BROKEN = 'export\\s+default\\s+/,"return "';   // 无 m 标志的旧写法
const MULTILINE = 'export\\s+default\\s+/m';             // 修复后：多行标志
const SECOND = 'export\\s+default\\s+/,"return "';       // 兜底替换

for (const f of files) {
  const c = readFileSync(join(dir, f), 'utf8');
  const hasM = c.includes(MULTILINE);
  const hasSecond = c.includes(SECOND);
  console.log(
    `${f} | 旧缺陷正则=${!hasM} | 多行标志=${hasM} | 兜底替换=${hasSecond}`
  );
  if (hasM) {
    const i = c.indexOf(MULTILINE);
    console.log('  片段：' + c.slice(Math.max(0, i - 120), i + 160).replace(/\n/g, ' '));
  }
}
