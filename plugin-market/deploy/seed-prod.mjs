/**
 * Neo MD 社区插件 · 生产入库脚本（在服务器上运行）
 *
 *   cd /www/wwwroot/md.zhengl.vip/server
 *   node /path/to/seed-prod.mjs /path/to/plugins-payload.json --dry-run
 *   node /path/to/seed-prod.mjs /path/to/plugins-payload.json --user-id 1 --author "Neo MD 官方团队"
 *
 * 选项：
 *   --dry-run              只预演，不写库（先 SELECT 判断新增或更新，打印 plugin_id / 字节数 / 动作）
 *   --user-id <n>          归属用户 id（默认 1）
 *   --author <name>        作者展示名（默认 "Neo MD 官方团队"）
 *   --only <nn,...>        只处理指定序号或 plugin_id
 *   --help
 *
 * 数据库配置优先级：环境变量 DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME
 *                 → 当前目录 (cwd) 下的 .env（key=value，支持 # 注释与引号）
 * 全部使用 INSERT ... ON DUPLICATE KEY UPDATE，可反复幂等执行。
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

/** 截断异常文本，绝不打印堆栈顶部 20 行以外的内容，且抹除密码敏感词 */
function safeErrorSummary(err, secret) {
  let msg = String(err?.message || err || '未知错误');
  if (secret && secret.length > 0) {
    msg = msg.split(secret).join('***');
  }
  const lines = msg.split(/\r?\n/).slice(0, 5);
  return lines.join(' | ');
}

if (flag('--help') || argv.length === 0) {
  console.log(`用法: node seed-prod.mjs <payload.json> [--dry-run] [--user-id 1] [--author "Neo MD 官方团队"]

  --dry-run          只预演不写库（打印 plugin_id / 字节数 / 新增或更新）
  --user-id <n>      归属用户 id（默认 1）
  --author <name>    作者展示名（默认 "Neo MD 官方团队"）
  --only <nn,...>    只处理指定序号或 plugin_id，如 --only 01,02
  --help             显示本帮助

数据库配置：优先读取环境变量 DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME，缺失时解析当前工作目录 (cwd) 下的 .env`);
  process.exit(flag('--help') ? 0 : 1);
}

const rawPayloadArg = argv.find((a, idx) => {
  if (a.startsWith('--')) return false;
  const prev = idx > 0 ? argv[idx - 1] : '';
  if (prev === '--user-id' || prev === '--author' || prev === '--only') return false;
  return true;
});

if (!rawPayloadArg) {
  console.error('✗ 参数错误：请指定 payload.json 文件路径，例如：node seed-prod.mjs dist/plugins-payload.json --dry-run');
  process.exit(1);
}

// 兼容 cwd 相对路径与 plugin-market 相对路径（如在仓库根目录传 dist/plugins-payload.json）
const candidatePaths = [
  resolve(process.cwd(), rawPayloadArg),
  resolve(scriptDir, '..', rawPayloadArg),
  resolve(scriptDir, rawPayloadArg),
];
const payloadPath = candidatePaths.find((p) => existsSync(p)) || candidatePaths[0];

if (!existsSync(payloadPath)) {
  console.error(`✗ 找不到 payload 文件：${payloadPath}`);
  console.error('请先运行 node plugin-market/deploy/build-artifacts.mjs 生成产物，或检查传入的 payload.json 路径是否正确。');
  process.exit(1);
}

const dryRun = flag('--dry-run');
const userId = Number(val('--user-id', '1'));
if (!Number.isInteger(userId) || userId <= 0) {
  console.error(`✗ 参数错误：--user-id 必须是正整数（当前值：${val('--user-id', '')}）`);
  process.exit(1);
}
const author = String(val('--author', 'Neo MD 官方团队')).trim() || 'Neo MD 官方团队';
const onlyRaw = val('--only', '');
const only = onlyRaw
  ? new Set(
      onlyRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    )
  : null;

/** 解析 cwd 下的 .env（key=value，支持 # 注释与单双引号） */
function parseEnvFile(filePath) {
  const out = {};
  if (!existsSync(filePath)) return out;
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    let v = body.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    ) {
      v = v.slice(1, -1);
    } else {
      // 去掉行尾非引号内的 # 注释
      const hashIdx = v.indexOf(' #');
      if (hashIdx >= 0) v = v.slice(0, hashIdx).trim();
    }
    out[key] = v;
  }
  return out;
}

const cwdEnv = parseEnvFile(resolve(process.cwd(), '.env'));

function pickEnv(key, fallback = '') {
  const fromProc = process.env[key];
  if (fromProc !== undefined && fromProc !== '') return fromProc;
  const fromDot = cwdEnv[key];
  if (fromDot !== undefined && fromDot !== '') return fromDot;
  return fallback;
}

const db = {
  host: pickEnv('DB_HOST', '127.0.0.1'),
  port: Number(pickEnv('DB_PORT', '3306')) || 3306,
  user: pickEnv('DB_USER', ''),
  password: pickEnv('DB_PASSWORD', ''),
  database: pickEnv('DB_NAME', ''),
};

let payload;
try {
  payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
} catch (err) {
  console.error(`✗ 读取或解析 payload JSON 失败（${payloadPath}）：${safeErrorSummary(err, db.password)}`);
  process.exit(1);
}

if (!Array.isArray(payload) || payload.length === 0) {
  console.error('✗ payload 内容为空或不是数组，无法执行入库。');
  process.exit(1);
}

const rows = payload.filter((p) => {
  if (!only) return true;
  return (
    only.has(String(p.nn || '')) ||
    only.has(String(p.pluginId || '')) ||
    only.has(String(p.pluginId || '').slice(0, 2))
  );
});

if (rows.length === 0) {
  console.error('✗ 按 --only 筛选后没有匹配的插件条目。');
  process.exit(1);
}

const missing = [];
if (!db.user) missing.push('DB_USER');
if (!db.password) missing.push('DB_PASSWORD');
if (!db.database) missing.push('DB_NAME');

if (missing.length > 0) {
  console.error(`✗ 数据库配置缺失：缺少 ${missing.join('、')}。`);
  console.error('请在环境变量中设置 DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME，或在当前工作目录 (/www/wwwroot/md.zhengl.vip/server) 下配置 .env 文件后重试。');
  process.exit(1);
}

async function loadMysql2() {
  try {
    const mod = await import('mysql2/promise');
    return mod.default || mod;
  } catch {
    const reqFromCwd = createRequire(resolve(process.cwd(), 'package.json'));
    const resolved = reqFromCwd.resolve('mysql2/promise');
    const mod = await import(pathToFileURL(resolved).href);
    return mod.default || mod;
  }
}

let mysql;
try {
  mysql = await loadMysql2();
} catch {
  console.error('✗ 未找到 mysql2 依赖模块：请在 /www/wwwroot/md.zhengl.vip/server 目录下运行本脚本（该目录 node_modules 已安装 mysql2）。');
  process.exit(1);
}

const UPSERT_SQL =
  "INSERT INTO community_plugins (plugin_id,user_id,author_name,name,version,category,icon,description,readme_md,code_js,status,downloads,stars,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'published',0,0,NOW(),NOW()) ON DUPLICATE KEY UPDATE name=VALUES(name),version=VALUES(version),category=VALUES(category),icon=VALUES(icon),description=VALUES(description),readme_md=VALUES(readme_md),code_js=VALUES(code_js),status='published',updated_at=NOW()";

let conn;
try {
  conn = await mysql.createConnection({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    charset: 'utf8mb4',
    connectTimeout: 10_000,
  });
} catch (err) {
  const code = err?.code ? `[${err.code}] ` : '';
  console.error(
    `✗ 数据库连接失败（目标：${db.user}@${db.host}:${db.port}/${db.database}）：${code}${safeErrorSummary(err, db.password)}`
  );
  if (err?.code === 'ER_ACCESS_DENIED_ERROR') {
    console.error('提示：数据库用户名或密码不正确，请核对 .env 或环境变量中的 DB_USER / DB_PASSWORD。');
  } else if (err?.code === 'ECONNREFUSED' || err?.code === 'ETIMEDOUT') {
    console.error('提示：无法连接到 MySQL 实例，请确认生产服务器 MySQL 服务正在运行且 DB_HOST / DB_PORT 可达。');
  } else if (err?.code === 'ER_BAD_DB_ERROR') {
    console.error(`提示：数据库 "${db.database}" 不存在，请检查 DB_NAME 配置。`);
  }
  process.exit(1);
}

try {
  const [existingRows] = await conn.query('SELECT plugin_id FROM community_plugins');
  const existing = new Set(existingRows.map((r) => r.plugin_id));

  console.log(
    `${dryRun ? '[DRY-RUN 预演模式] ' : ''}准备处理 ${rows.length} 款插件（目标库：${db.host}:${db.port}/${db.database}，作者：${author}，user_id：${userId}）`
  );
  console.log('─'.repeat(72));

  let okCount = 0;
  let failCount = 0;

  for (const p of rows) {
    const pluginId = String(p.pluginId || '').trim();
    const bytes = Buffer.byteLength(String(p.codeJs || ''), 'utf8');
    const action = existing.has(pluginId) ? '更新' : '新增';

    if (dryRun) {
      console.log(`✓ [预演·${action}] ${pluginId.padEnd(28, ' ')} ${String(bytes).padStart(6, ' ')} 字节  (${p.name || ''})`);
      okCount += 1;
      continue;
    }

    try {
      await conn.execute(UPSERT_SQL, [
        pluginId,
        userId,
        author,
        String(p.name || ''),
        String(p.version || '1.0.0'),
        String(p.category || 'writing'),
        String(p.icon || 'layers'),
        String(p.description || ''),
        String(p.readmeMd ?? ''),
        String(p.codeJs || ''),
      ]);
      console.log(`✓ ${pluginId} (${action}, ${bytes} 字节)`);
      okCount += 1;
    } catch (err) {
      failCount += 1;
      console.error(`✗ ${pluginId} — 入库失败：${safeErrorSummary(err, db.password)}`);
    }
  }

  const [countRows] = await conn.query('SELECT COUNT(*) AS total FROM community_plugins');
  const totalInTable = Number(countRows?.[0]?.total ?? 0);

  console.log('─'.repeat(72));
  console.log(
    `${dryRun ? '[预演完成·未写库] ' : ''}成功：${okCount} · 失败：${failCount} · community_plugins 表内总数：${totalInTable}`
  );

  await conn.end();
  process.exit(failCount > 0 ? 1 : 0);
} catch (err) {
  console.error(`✗ 执行过程中发生数据库异常：${safeErrorSummary(err, db.password)}`);
  try {
    await conn?.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
}
