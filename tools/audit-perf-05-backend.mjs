/**
 * 板块 5：后端性能（服务端耗时 / N+1 查询 / EXPLAIN / 静态资源来源）
 * =============================================================================
 * **本板块全部走本地 API 3200**（它连的是同一个生产库），因此**不受生产站点 502 影响**。
 * 这是审计里最"稳"的部分：站点挂了也能做。
 *
 * 四个测量项：
 *  ① **服务端处理耗时**：用 `Server-Timing` 响应头 + 客户端分段计时（TTFB / body）
 *     —— 不重启 API 进程（禁止），因此不能上 `--cpu-prof`，用响应头近似
 *  ② **N+1 查询**：对列表接口做「耗时-条目数」相关性分析
 *     · 若条目数翻倍而耗时近似翻倍 → 疑似 N+1（每条约一次查询）
 *     · 若条目数翻倍而耗时近似不变 → 批量查询（正常）
 *  ③ **EXPLAIN 关键查询**：通过 MySQL 只读连接看执行计划（走 /api 的数据库无直连权限时，
 *     用「接口耗时 + 索引假设」做静态分析，并在报告里标注「未能直连 EXPLAIN」）
 *  ④ **静态资源是 nginx 直出还是 Node 转发**
 *     —— 这是 1.4.0 的遗留风险点：若 Node 转发静态资源，会吃掉 Node CPU
 *
 * 用法：
 *   node tools/audit-perf-05-backend.mjs                    # 全部四项（走本地 3200）
 *   node tools/audit-perf-05-backend.mjs --only=nplus1
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ARGS,
  ROOT,
  TARGETS,
  head,
  sub,
  loadChromium,
  login,
  health,
  timedFetch,
  stats,
  fmtStats,
  table,
  saveRaw,
  sleep,
  round,
} from './audit-perf-common.mjs';

/** 后端测量固定走本地 3200（连同一生产库，且不受站点 502 影响） */
const API = TARGETS.local.api;

/* ============================== ① 服务端耗时 ============================== */

async function measureServerTiming(auth) {
  sub('① 服务端处理耗时（Server-Timing + 分段计时）');
  const probes = [
    { name: 'health（基线，无业务）', path: '/api/health', auth: false },
    { name: 'settings 读取', path: '/api/settings?platform=desktop', auth: true },
    { name: 'vaults 列表', path: '/api/vaults', auth: true },
    { name: 'storage 列举 docs/', path: '/api/storage/list?prefix=docs%2F&maxKeys=1000', auth: true },
    { name: 'admin users p1', path: '/api/admin/users?page=1&pageSize=20', auth: true },
    { name: 'admin dashboard', path: '/api/admin/dashboard', auth: true },
    { name: 'plugins 市场', path: '/api/plugins/market?page=1&pageSize=20', auth: true },
    { name: 'plugins 我的', path: '/api/plugins/my', auth: true },
  ];
  const rows = [];
  for (const p of probes) {
    const runs = [];
    for (let i = 0; i < 5; i += 1) {
      runs.push(
        await timedFetch(`${API}${p.path}`, {
          headers: p.auth ? { authorization: `Bearer ${auth.accessToken}` } : {},
        }),
      );
      await sleep(100);
    }
    const ok = runs.filter((r) => r.ok);
    rows.push({
      接口: p.name,
      'TTFB中位': stats(ok.map((r) => r.ttfbMs)).med,
      'body中位': stats(ok.map((r) => r.bodyMs)).med,
      '总中位': stats(ok.map((r) => r.totalMs)).med,
      p95: stats(ok.map((r) => r.totalMs)).p95,
      'KB': round((ok[0]?.bytes || 0) / 1024),
      'Server-Timing': ok[0]?.serverTiming ? '有' : '无',
      '服务端dur': ok[0]?.serverDurMs ?? '-',
    });
  }
  rows.sort((a, b) => b['总中位'] - a['总中位']);
  console.log(table(rows));
  const withTiming = rows.filter((r) => r['Server-Timing'] === '有').length;
  console.log(`\n  Server-Timing 覆盖：${withTiming}/${rows.length} 个接口`);
  if (withTiming === 0) {
    console.log('  ⚠️ 全部接口都没有 Server-Timing 头 → 无法从外部区分「服务端处理」与「网络/序列化」耗时；');
    console.log('     这是可观测性缺陷（建议后端加 Server-Timing），但不影响下面的 N+1 推断。');
  }
  return rows;
}

/* ============================== ② N+1 查询检测 ============================== */

/**
 * N+1 检测方法：**改变返回条目数，看耗时是否线性增长**。
 *
 * 原理：N+1 的特征是「主查询 1 次 + 每条记录再查 1 次」，
 * 因此条目数 20 → 100（5 倍）时，耗时也会接近 5 倍增长（甚至更多）。
 * 若采用批量 JOIN/IN 查询，条目数增长时耗时增长远低于线性（多为固定开销）。
 *
 * 判据（写死）：
 *   ratio = t(100条) / t(20条)
 *   ratio > 3.0  → 疑似 N+1（增长远超条目数带来的序列化成本）
 *   1.0 <= ratio <= 3.0 → 正常（序列化本身有成本，允许 3 倍内）
 */
async function detectNPlus1(auth) {
  sub('② N+1 查询检测（对比条目数 20 vs 100 的耗时比）');

  const cases = [
    { name: 'admin/users', path: (n) => `/api/admin/users?page=1&pageSize=${n}`, auth: true },
    { name: 'admin/audit', path: (n) => `/api/admin/audit?page=1&pageSize=${n}`, auth: true },
    { name: 'admin/plugins', path: (n) => `/api/admin/plugins?page=1&pageSize=${n}`, auth: true },
    { name: 'admin/vaults', path: () => '/api/admin/vaults', auth: true },
    { name: 'vaults', path: () => '/api/vaults', auth: true },
    { name: 'storage/list docs', path: () => '/api/storage/list?prefix=docs%2F&maxKeys=1000', auth: true },
    { name: 'storage/list 根', path: () => '/api/storage/list?prefix=&maxKeys=50', auth: true },
    { name: 'plugins/market', path: (n) => `/api/plugins/market?page=1&pageSize=${n}`, auth: true },
  ];

  const rows = [];
  for (const c of cases) {
    const measure = async (n) => {
      const runs = [];
      for (let i = 0; i < 4; i += 1) {
        const url = `${API}${c.path(n)}`;
        const r = await timedFetch(url, { headers: c.auth ? { authorization: `Bearer ${auth.accessToken}` } : {} });
        if (r.ok) {
          /* 尽量解析条目数（不同接口结构不同） */
          runs.push(r);
        }
        await sleep(120);
      }
      return { s: stats(runs.map((r) => r.totalMs)), bytes: runs[0]?.bytes ?? 0, n: runs.length };
    };

    const a = await measure(20);
    const b = await measure(100);
    const ratio = a.s.med ? round(b.s.med / a.s.med, 2) : null;
    const bytesRatio = a.bytes ? round(b.bytes / a.bytes, 2) : null;
    rows.push({
      接口: c.name,
      '20条ms': a.s.med,
      '100条ms': b.s.med,
      耗时比: ratio,
      体积比: bytesRatio,
      判定: ratio === null ? '无数据' : ratio > 3.0 ? '⚠️ 疑似 N+1' : '正常',
    });
  }
  console.log(table(rows));
  console.log(
    '\n判据：耗时比 > 3.0 判为疑似 N+1（条目数 5 倍增长时耗时增长远超序列化成本）；1.0~3.0 视为正常',
  );
  console.log('注：不含分页参数的接口（vaults / storage/list）两列数值相同，耗时比 ≈1，仅作基线参考。');
  return rows;
}

/* ============================== ③ EXPLAIN（数据库执行计划） ============================== */

/**
 * 尝试通过 MySQL 只读连接执行 EXPLAIN。
 *
 * 局限：本机未必有 mysql 客户端，也未必有生产库直连凭据。
 * 若拿不到，如实标注「未能直连 EXPLAIN」，并用「接口耗时」做间接证据。
 */
async function tryExplain() {
  sub('③ 关键查询 EXPLAIN（尝试只读连接生产库）');
  /* 先看是否有 mysql 客户端 */
  const mysqlBin = ['mysql', 'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe', 'C:/xampp/mysql/bin/mysql.exe'].find((p) => {
    try {
      if (p === 'mysql') return true; // 交给 shell 解析
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  /* 尝试从 API 的 env 读取数据库连接信息（只读，不输出密码） */
  const envPaths = [path.join(ROOT, 'services', 'api', '.env')];
  let dbHost = null;
  let dbName = null;
  let hasCreds = false;
  for (const p of envPaths) {
    if (!fs.existsSync(p)) continue;
    const txt = fs.readFileSync(p, 'utf8');
    const host = /^\s*DB_HOST\s*=\s*(.+)$/m.exec(txt);
    const name = /^\s*DB_NAME\s*=\s*(.+)$/m.exec(txt);
    const user = /^\s*DB_USER\s*=\s*(.+)$/m.exec(txt);
    const pass = /^\s*DB_PASSWORD\s*=\s*(.+)$/m.exec(txt);
    dbHost = host?.[1]?.trim() ?? null;
    dbName = name?.[1]?.trim() ?? null;
    hasCreds = Boolean(user && pass);
    break;
  }

  if (!dbHost || !dbName) {
    console.log('  未能读取数据库连接配置 → 跳过 EXPLAIN');
    return { ok: false, reason: 'no-db-config' };
  }
  console.log(`  发现数据库配置：host=${dbHost} db=${dbName} 凭据=${hasCreds ? '有' : '无'}`);
  console.log('  （为避免泄露凭据，本脚本不打印用户名/密码，也不执行需凭据的命令）');

  /*
   * 说明：即便有凭据，直接连生产库执行 EXPLAIN 也超出「只读审计」的稳妥边界
   * （需要网络可达 + 凭据可用 + 不影响生产负载）。这里只做静态分析。
   */
  console.log('  → 改为**静态分析 + 接口耗时间接判断**（见下方索引建议）');
  return { ok: false, reason: 'static-analysis-only', host: dbHost, db: dbName };
}

/** 从源码里找列表查询的 SQL，判断是否有索引友好的 WHERE/LIMIT */
function staticSqlAudit() {
  sub('③b 列表查询 SQL 静态审计（找 WHERE / LIMIT / 潜在全表扫描）');
  const files = [
    'services/api/src/routes/admin.js',
    'services/api/src/routes/vaults.js',
    'services/api/src/routes/storage.js',
    'services/api/src/routes/plugins.js',
  ];
  const findings = [];
  for (const rel of files) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    /* 抓 SELECT ... FROM <table> 片段 */
    const sqls = [...src.matchAll(/`(SELECT[\s\S]{0,400}?)`/g)].map((m) => m[1]);
    for (const sql of sqls) {
      const oneLine = sql.replace(/\s+/g, ' ').trim();
      const tables = [...oneLine.matchAll(/FROM\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]);
      if (!tables.length) continue;
      findings.push({
        file: rel.split('/').pop(),
        tables: [...new Set(tables)].slice(0, 3).join(','),
        hasWhere: /\bWHERE\b/i.test(oneLine),
        hasLimit: /\bLIMIT\b/i.test(oneLine),
        hasJoin: /\bJOIN\b/i.test(oneLine),
        hasOrderBy: /\bORDER\s+BY\b/i.test(oneLine),
        /** 潜在风险：多表 FROM（笛卡尔/隐式 join）或 无 WHERE 的列表查询 */
        risk: tables.length > 1 ? '多表 FROM（检查是否有索引）' : !/\bWHERE\b/i.test(oneLine) && !/\bLIMIT\b/i.test(oneLine) ? '无 WHERE 且无 LIMIT' : '',
        sample: oneLine.slice(0, 110),
      });
    }
  }
  const risky = findings.filter((f) => f.risk);
  console.log(`扫描 ${files.length} 个路由文件，提取 ${findings.length} 条 SELECT；其中有风险特征 ${risky.length} 条`);
  if (risky.length) console.log(table(risky.slice(0, 10).map((f) => ({ 文件: f.file, 表: f.tables, 风险: f.risk, 片段: f.sample.slice(0, 70) }))));
  return findings;
}

/* ============================== ④ 静态资源来源 ============================== */

/**
 * 判断静态资源是 nginx 直出还是 Node 转发。
 *
 * 方法：比较**响应头指纹**
 *  - nginx 直出：`Server: nginx`、`ETag: W/"<hex>-<hex>"`（nginx 格式）、`Last-Modified` 由文件系统给
 *  - Node 转发（fastify-static / sendFile）：`etag: W/"<len>-<mtime>"`（send 库格式）、无 Server 头或 Server 为 Node 服务写的值
 *
 * 另外看 **gzip 是否由 nginx 完成**：nginx 的 `Content-Encoding: gzip` 通常配 `Vary: Accept-Encoding`。
 */
async function checkStaticOrigin() {
  sub('④ 静态资源来源（nginx 直出 vs Node 转发）');
  const results = [];

  /* 本地 3200 是否自己也 serve 静态资源？ */
  const probes = [
    { label: '本地 API 根路径', url: `${API}/` },
    { label: '本地 API /assets 探测', url: `${API}/assets/` },
    { label: '生产首页', url: `${TARGETS.prod.base}/` },
    { label: '生产静态 JS（codemirror）', url: `${TARGETS.prod.base}/assets/codemirror-DWuwBixc.js` },
  ];

  for (const p of probes) {
    try {
      const r = await timedFetch(p.url, {}, { timeout: 15000 });
      results.push({
        目标: p.label,
        状态: r.status ?? 'ERR',
        Server: r.server || '-',
        压缩: r.contentEncoding || '(none)',
        'content-length': r.contentLength || '-',
        'cache-control': (r.cacheControl || '').slice(0, 34),
        'TTFBms': r.ttfbMs,
        'KB': round((r.bytes || 0) / 1024, 1),
        error: r.error,
      });
    } catch (e) {
      results.push({ 目标: p.label, 状态: 'ERR', error: String(e?.message ?? e).slice(0, 60) });
    }
    await sleep(300);
  }

  console.log(table(results));

  /* 补充：用 Playwright 抓生产静态资源的完整响应头（更准） */
  let headerDetail = null;
  try {
    const chromium = await loadChromium();
    const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu'] });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const captured = {};
    page.on('response', async (res) => {
      const u = res.url();
      if (!/\/assets\/.*\.js$/.test(u)) return;
      if (Object.keys(captured).length >= 3) return;
      const h = await res.allHeaders().catch(() => ({}));
      captured[u.split('/').pop()] = {
        server: h['server'] || '-',
        etag: h['etag'] || '-',
        'last-modified': h['last-modified'] || '-',
        'content-encoding': h['content-encoding'] || '(none)',
        'content-length': h['content-length'] || '-',
        vary: h['vary'] || '-',
        'cache-control': h['cache-control'] || '-',
      };
    });
    await page.goto(`${TARGETS.prod.base}/app`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(3000);
    await browser.close().catch(() => {});
    headerDetail = captured;
    if (Object.keys(captured).length) {
      console.log(`\n静态 JS 响应头指纹（判断谁在 serve）：`);
      for (const [name, h] of Object.entries(captured)) {
        console.log(`  ${name}`);
        console.log(`    server=${h.server} etag=${h.etag}`);
        console.log(`    encoding=${h['content-encoding']} length=${h['content-length']} vary=${h.vary}`);
        console.log(`    cache-control=${h['cache-control']}`);
      }
      /* 判定 */
      const anyH = Object.values(captured)[0];
      const nginxStyle = /nginx/i.test(anyH.server) && /^W\/"[0-9a-f]+-[0-9a-f]+"$/.test(anyH.etag);
      console.log(
        `\n判定：${nginxStyle ? '✅ nginx 直出（Server: nginx + nginx 格式 ETag）' : '⚠️ 疑似 Node 转发或 CDN 中转（Server=' + anyH.server + '，ETag 格式不符 nginx）'}`,
      );
    }
  } catch (e) {
    console.log(`  响应头指纹抓取失败：${String(e?.message ?? e).slice(0, 120)}`);
  }

  return { results, headerDetail };
}

/* ============================== 主流程 ============================== */

async function main() {
  head('板块 5：后端性能（服务端耗时 / N+1 / EXPLAIN / 静态资源来源）');
  console.log(`测量目标：本地 API ${API}（连同一生产库，不受站点 502 影响）`);

  const h = await health(API);
  console.log(`健康：ok=${h.ok} version=${h.version} uptime=${h.uptime}s`);
  if (!h.ok) {
    console.error('本地 API 不可用，无法测量后端');
    process.exit(2);
  }
  const auth = await login(API);
  const only = ARGS.only;
  const out = { api: API, health: h };

  if (!only || only.includes('timing')) out.serverTiming = await measureServerTiming(auth);
  if (!only || only.includes('nplus1')) out.nplus1 = await detectNPlus1(auth);
  if (!only || only.includes('explain')) {
    out.explain = await tryExplain();
    out.sqlAudit = staticSqlAudit();
  }
  if (!only || only.includes('static')) out.staticOrigin = await checkStaticOrigin();

  const after = await health(API);
  out.healthGuard = { before: h.uptime, after: after.uptime, stable: after.uptime >= h.uptime };
  console.log(`\nuptime 稳定性：${h.uptime}s → ${after.uptime}s（${out.healthGuard.stable ? '稳定' : '⚠️ 回退'}）`);

  saveRaw('05-backend', out);
  return out;
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n测量异常终止：', e);
    process.exit(2);
  });
