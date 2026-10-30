/**
 * 把 1.3.0 版本条目合并进 CHANGELOG.md 顶部（保持 UTF-8 不变，纯 Node 实现）
 *
 *   node plugin-market/deploy/merge-changelog.mjs
 *
 * 设计要点：
 * - 全程 Buffer/utf8，绝不经过 PowerShell 的默认编码，避免中文被 GBK 往返破坏；
 * - 幂等：若已存在 `## [1.3.0]` 则先移除旧块再插入，重复执行结果一致；
 * - 在 `## [1.2.0]` 之前插入，保持倒序；
 * - 写入前比对原文，未变化则不落盘。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const changelogPath = join(root, 'CHANGELOG.md');
const blockPath = join(root, 'plugin-market', 'reports', 'changelog-1.3.0.md');

const VERSION_HEAD = '## [1.3.0] - 2026-10-30';
const ANCHOR = '## [1.2.0] - 2026-10-30';

let changelog = readFileSync(changelogPath, 'utf8');
const rawBlock = readFileSync(blockPath, 'utf8').trim();

// 统一成仓库既有的 "[x.y.z] - date" 标题风格
const block = rawBlock.replace(/^##\s*1\.3\.0[^\n]*/m, VERSION_HEAD);

if (!block.startsWith(VERSION_HEAD)) {
  console.error('changelog-1.3.0.md 首行不是 1.3.0 版本标题，已中止');
  process.exit(1);
}
if (changelog.includes(VERSION_HEAD)) {
  // 幂等：先摘掉旧块（从 1.3.0 标题到 1.2.0 标题之前）
  const start = changelog.indexOf(VERSION_HEAD);
  const end = changelog.indexOf(ANCHOR);
  if (start >= 0 && end > start) {
    changelog = changelog.slice(0, start) + changelog.slice(end);
    console.log('已移除旧的 1.3.0 块，准备重新插入');
  }
}

const anchorIdx = changelog.indexOf(ANCHOR);
if (anchorIdx < 0) {
  console.error(`CHANGELOG.md 中找不到锚点「${ANCHOR}」`);
  process.exit(1);
}

const before = changelog.slice(0, anchorIdx).replace(/\s*$/, '');
const after = changelog.slice(anchorIdx);
const next = `${before}\n\n${block}\n\n---\n\n${after}`;

if (next === readFileSync(changelogPath, 'utf8')) {
  console.log('CHANGELOG.md 已是最新，无需写入');
  process.exit(0);
}

writeFileSync(changelogPath, next, 'utf8');

// 自检：中文未损坏、顺序正确
const check = readFileSync(changelogPath, 'utf8');
const ok = [
  ['首个插件生态版本', check.includes('首个插件生态版本')],
  ['1.3.0 存在', check.includes(VERSION_HEAD)],
  ['1.2.0 存在', check.includes(ANCHOR)],
  ['顺序正确', check.indexOf(VERSION_HEAD) < check.indexOf(ANCHOR)],
  ['无乱码（更新日志）', check.includes('# 更新日志')],
  ['无 GBK 乱码', !check.includes('鏇存柊')]
];

let failed = 0;
for (const [name, pass] of ok) {
  console.log(`${pass ? '✓' : '✗'} ${name}`);
  if (!pass) failed += 1;
}
console.log(`CHANGELOG.md 现在 ${check.length} 字符`);
process.exit(failed ? 1 : 0);
