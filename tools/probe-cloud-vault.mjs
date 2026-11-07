#!/usr/bin/env node
/** 直接对生产 API 查 OSS 实际对象结构，确认客户端期望的 prefix 与服务端是否一致 */
const BASE = 'https://md.zhengl.vip';
const ACC = { username: 'admin', password: '6655' };

const r = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(ACC),
});
const j = await r.json();
const tok = j.data.accessToken;
const H = { authorization: `Bearer ${tok}` };
console.log('login ok, user =', j.data.user.username);

// 1. 仓库列表
const v = await (await fetch(`${BASE}/api/vaults`, { headers: H })).json();
console.log('\n=== /api/vaults ===');
console.log(JSON.stringify(v.data, null, 2));

// 2. 根 storage list
for (const q of ['', '?prefix=', '?prefix=docs/', '?limit=10']) {
  const res = await fetch(`${BASE}/api/storage/list${q}`, { headers: H });
  let body;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  console.log(`\n=== /api/storage/list${q} -> ${res.status} ===`);
  console.log(JSON.stringify(body).slice(0, 1200));
}
