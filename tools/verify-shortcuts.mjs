/**
 * Static check: no two commands may share the same key binding.
 *
 * This is a pure source-level assertion so it needs no running shell.
 * It exists because a real defect shipped when `editor.code` and
 * `app.toggleMode` were both bound to Ctrl+E: the key handler takes only the
 * first match, so the second command could never fire.
 */
import fs from 'node:fs';

const SRC = 'packages/core/src/settings/settings.ts';
const src = fs.readFileSync(SRC, 'utf8');

// Match entries like: { command: 'x', keys: ['Ctrl+E'] },
const re = /\{\s*command:\s*'([^']+)'\s*,\s*keys:\s*\[([^\]]*)\]/g;
const map = new Map();
let m;
while ((m = re.exec(src))) {
  const cmd = m[1];
  const keys = m[2]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  for (const k of keys) {
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(cmd);
  }
}

let dup = 0;
for (const [k, cmds] of [...map.entries()].sort()) {
  if (cmds.length > 1) {
    dup++;
    console.log('DUPLICATE', k, '->', cmds.join(' and '));
  }
}

console.log('');
console.log('total bindings:', map.size, ' duplicates:', dup);
for (const probe of ['Ctrl+E', 'Ctrl+Shift+E', 'Ctrl+Shift+T', 'Ctrl+Shift+L', 'Ctrl+S', 'Ctrl+N', 'Ctrl+W']) {
  console.log(`  ${probe.padEnd(14)} -> ${(map.get(probe) ?? []).join(', ') || '(unbound)'}`);
}

console.log(`\n${dup === 0 ? 'PASS' : 'FAIL'}: ${dup} duplicate binding(s)`);
process.exit(dup ? 1 : 0);
