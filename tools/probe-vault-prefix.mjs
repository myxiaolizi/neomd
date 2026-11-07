#!/usr/bin/env node
/** 确认 702 篇文档在 OSS 中的真实前缀与文件构成 */
const BASE = 'https://md.zhengl.vip';
const ACC = { username: 'admin', password: '6655' };
const r = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(ACC),
});
const tok = (await r.json()).data.accessToken;
const H = { authorization: `Bearer ${tok}` };

const VAULT = 'vaultmvuqt3rn8ubd9num';
const prefixes = [
  `vaults/${VAULT}/`,
  `vaults/${VAULT}/index/`,
  `vaults/${VAULT}/docs/`,
  `vaults/${VAULT}/versions/`,
  'vaults/ADMIN/',
];

for (const p of prefixes) {
  const res = await fetch(`${BASE}/api/storage/list?prefix=${encodeURIComponent(p)}&limit=1000`, { headers: H });
  const j = await res.json();
  const objs = j?.data?.objects ?? [];
  console.log(`\n=== prefix "${p}" -> ${res.status}, ${objs.length} objects, truncated=${j?.data?.truncated} ===`);
  const kinds = {};
  for (const o of objs) {
    const seg = o.key.split('/').slice(-2, -1)[0] ?? '';
    const k = /\.json$/.test(o.key) ? 'json' : /\.md$/.test(o.key) ? 'md' : 'other';
    kinds[k] = (kinds[k] ?? 0) + 1;
  }
  console.log('  构成:', JSON.stringify(kinds));
  for (const o of objs.slice(0, 8)) console.log(`   ${o.key}  (${o.size}B)`);
}
