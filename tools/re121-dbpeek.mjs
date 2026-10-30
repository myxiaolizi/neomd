/**
 * 1.2.1 设置同步诊断：只读窥视生产库 user_settings 的 payload_json 结构。
 *
 * 目的：确认 `platform.<p>.appearance` 里是否残留 1.1.7 及更早版本写入的
 * `fontFamily` 旧值（当时 fontFamily 还属于「按端差异化」分区）。
 * 只做 SELECT，绝不写入。
 */
import fs from 'node:fs';
import mysql from '../services/api/node_modules/mysql2/promise.js';

/** 与 services/api/src/config.js 相同的极简 .env 解析（避免额外依赖） */
function loadEnv() {
  const out = {};
  for (const file of ['../services/api/.env', '../services/api/.env.local']) {
    let raw = '';
    try {
      raw = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim();
      if (!text || text.startsWith('#')) continue;
      const eq = text.indexOf('=');
      if (eq <= 0) continue;
      out[text.slice(0, eq).trim()] = text.slice(eq + 1).trim();
    }
  }
  return out;
}
const env = { ...loadEnv(), ...process.env };

const conn = await mysql.createConnection({
  host: env.DB_HOST || '127.0.0.1',
  port: Number(env.DB_PORT || 3306),
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
});

const [rows] = await conn.execute(
  'SELECT user_id, version, updated_at, payload_json FROM user_settings ORDER BY updated_at DESC',
);
console.log(`行数：${rows.length}`);
for (const row of rows) {
  let parsed = null;
  try {
    parsed = JSON.parse(row.payload_json);
  } catch {
    parsed = null;
  }
  console.log(`\n--- user_id=${row.user_id} version=${row.version} updated_at=${row.updated_at}`);
  if (!parsed || typeof parsed !== 'object') {
    console.log('  payload 非对象');
    continue;
  }
  console.log(`  顶层键：${Object.keys(parsed).join(', ')}`);
  if (parsed.appearance) console.log(`  顶层 appearance：${JSON.stringify(parsed.appearance)}`);
  if (parsed.global) {
    const g = parsed.global;
    console.log(`  global.appearance：${JSON.stringify(g.appearance ?? null)}`);
  }
  if (parsed.platform) {
    for (const [p, group] of Object.entries(parsed.platform)) {
      console.log(`  platform.${p}.appearance：${JSON.stringify(group?.appearance ?? null)}`);
      console.log(`  platform.${p} 键：${Object.keys(group ?? {}).join(', ')}`);
    }
  }
}
await conn.end();
