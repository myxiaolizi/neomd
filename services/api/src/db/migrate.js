/**
 * 数据库初始化：执行 schema.sql（幂等），并在没有管理员时创建初始管理员。
 * 初始管理员口令只在此次创建时打印一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { query, queryOne, execute, closePool } from './pool.js';
import config from '../config.js';
import { hashPassword, randomPassword } from '../lib/crypto.js';
import { migrateV2 } from './migrate-v2.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.join(here, 'schema.sql');

/** 去掉行注释后按分号拆分语句 */
export function splitStatements(sql) {
  const cleaned = String(sql)
    .split(/\r?\n/)
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
  return cleaned
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 执行 schema.sql */
export async function migrate() {
  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  const statements = splitStatements(sql);
  for (const statement of statements) {
    await query(statement);
  }
  return statements.length;
}

/**
 * 首次创建管理员账号。
 * @returns {Promise<{created: boolean, username?: string, email?: string, password?: string, reason?: string}>}
 */
export async function seedAdmin() {
  const existing = await queryOne("SELECT id, username, email FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  if (existing) {
    return { created: false, username: existing.username, email: existing.email, reason: '已存在管理员账号' };
  }

  const email = String(config.admin.email).toLowerCase();
  const username = String(config.admin.username);
  const password = config.admin.password && config.admin.password.length >= 8 ? config.admin.password : randomPassword(20);

  const conflict = await queryOne('SELECT id, email, username FROM users WHERE email = ? OR username = ? LIMIT 1', [email, username]);
  if (conflict) {
    return {
      created: false,
      reason: `邮箱 ${email} 或用户名 ${username} 已被占用，跳过管理员初始化，请手工处理`,
    };
  }

  const passHash = await hashPassword(password);
  await execute(
    "INSERT INTO users (email, username, pass_hash, role, status, quota_bytes, created_at) VALUES (?, ?, ?, 'admin', 'active', ?, NOW())",
    [email, username, passHash, config.defaultQuotaBytes],
  );

  return { created: true, username, email, password, reason: '' };
}

/** 打印一次性管理员口令，避免被日志轮转反复记录 */
export function printAdminBanner(seed) {
  if (!seed?.created) return;
  const line = '='.repeat(58);
  console.log(`\n${line}`);
  console.log('  Neo MD 初始管理员已创建（该口令只显示这一次，请立即保存）');
  console.log(`  用户名：${seed.username}`);
  console.log(`  邮箱  ：${seed.email}`);
  console.log(`  密码  ：${seed.password}`);
  console.log(`${line}\n`);
}

/** 迁移 + 初始化管理员 */
export async function migrateAndSeed({ silent = false } = {}) {
  const count = await migrate();
  if (!silent) console.log(`[db] 已执行 ${count} 条建表语句（幂等）`);

  // 增量结构：老库补列 + 平台默认配置，重复执行不报错
  const v2 = await migrateV2();
  if (!silent) {
    console.log(
      `[db] v2 增量迁移：新增列 ${v2.columns} 个，补充平台配置 ${v2.config.length} 项，新增 AI 供应商 ${v2.providers} 个`,
    );
  }

  const seed = await seedAdmin();
  if (seed.created) {
    printAdminBanner(seed);
  } else if (!silent) {
    console.log(`[db] 管理员账号 ${seed.username ?? '-'} 已存在，跳过初始化`);
  }
  return seed;
}

// 允许直接运行：node src/db/migrate.js
const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  migrateAndSeed()
    .then(async (seed) => {
      if (!seed.created) console.log(`[db] 未创建新管理员：${seed.reason}`);
      await closePool();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('[db] 初始化失败：', err.message);
      try {
        await closePool();
      } catch {
        /* ignore */
      }
      process.exit(1);
    });
}

export default { migrate, seedAdmin, migrateAndSeed };
