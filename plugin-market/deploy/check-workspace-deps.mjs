/** 检查 workspace 内部依赖是否使用 workspace: 协议（版本提升后不应破坏解析） */
import { readFileSync, existsSync } from 'node:fs';

const files = [
  'apps/web/package.json',
  'apps/desktop/package.json',
  'apps/android/package.json',
  'services/api/package.json',
  'packages/core/package.json',
  'packages/ui/package.json',
  'packages/shared/package.json'
];

let bad = 0;
for (const f of files) {
  if (!existsSync(f)) continue;
  const pkg = JSON.parse(readFileSync(f, 'utf8'));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const internal = Object.entries(deps).filter(([k]) => k.startsWith('@neomd/'));
  if (!internal.length) continue;
  console.log(`${f} (version ${pkg.version}):`);
  for (const [name, spec] of internal) {
    const isWorkspace = String(spec).startsWith('workspace:');
    console.log(`  ${isWorkspace ? '✓' : '✗'} ${name}: ${spec}`);
    if (!isWorkspace) bad += 1;
  }
}
console.log(bad === 0 ? '全部使用 workspace: 协议，版本提升安全' : `${bad} 处使用硬编码版本，需同步`);
process.exit(bad === 0 ? 0 : 1);
