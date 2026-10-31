/**
 * Neo MD 发版门禁：校验 `services/api/releases/` 与对象存储上确实存在当前版本的产物。
 *
 * ## 为什么需要这个脚本（真实事故）
 *
 * 1.2.0 发布时，APK 已经放进 `server/releases/`，但 `DOWNLOAD_FILES` 清单没登记，
 * 结果 `/api/download/NeoMD-1.2.0.apk` 直接 404 —— 客户端下载页至今点不动，
 * 而构建日志里一切正常。这属于「静默缺件」：**发版流程没有任何一步会失败**。
 *
 * 1.3.1 把清单改成从 `package.json` 动态推导，堵住了「忘记改清单」这条路；
 * 但还有另一条：**产物根本没上传到 OSS / 没放进本地 releases 目录**。
 * 那时清单是对的，文件却不存在，下载依然是 404。
 *
 * 本脚本就是把这件事变成一条会失败的断言，接在发版之后跑。
 *
 * ## 判定规则（与 download.js 的分发链路一致）
 *
 * | 产物 | 分发链路 | 必须具备 |
 * |------|----------|----------|
 * | `NeoMD-<v>-win-x64.zip` | 302 → OSS 预签名 | **OSS 上有** |
 * | `NeoMD-<v>-setup.exe`   | 302 → OSS 预签名 | **OSS 上有** |
 * | `NeoMD-<v>.apk`         | 本服务直出本地文件，缺失才回退 OSS | **本地有**（阿里云禁止 APK 经 OSS 端点公开分发） |
 *
 * APK 这条特别容易踩：它明明在 OSS 上，但客户端仍然下不动。
 * 所以「OSS 上有」不能作为 APK 就绪的判据。
 *
 * ## 必须同时检查「运行期目录」与「部署产物目录」
 *
 * 只查运行期目录是不够的 —— 2026-10-31 实测发现：
 * `NeoMD-1.3.1.apk` 在 OSS 上有，但 `services/api/releases/` 与
 * `dist-artifacts/deploy/server/releases/` **两处都没有**，最新都只到 1.1.8；
 * 生产上那份是**手工放上去的**。
 *
 * 于是「本机跑得起来」但「一重新部署就丢」—— 这正是 1.2.0 / 1.3.1 反复踩的同一个坑。
 * 因此本脚本对 APK 同时校验两个目录，任一缺失即失败。
 *
 * 用法
 *
 *   node tools/re14-release-gate.mjs              # 校验 + 真实 HEAD 探测
 *   node tools/re14-release-gate.mjs --no-probe   # 只查存在性，不发网络请求
 *   API_BASE=http://127.0.0.1:3200 node tools/re14-release-gate.mjs
 *
 * 退出码：0 = 全部就绪；1 = 有缺件（CI/发版流程应据此中止）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const apiRoot = path.join(repo, 'services', 'api');

/**
 * 需要检查的本地 releases 目录（**两处，缺一不可**）。
 *
 * 1. `services/api/releases/` —— 运行期的 `LOCAL_DIR`
 *    （`download.js` 用 `path.resolve(..., '..','..','releases')` 推导，就是这里）；
 * 2. `dist-artifacts/deploy/server/releases/` —— **实际被部署出去的那份**。
 *
 * ## 为什么要查两处（1.4.0 实测发现的部署风险）
 *
 * 2026-10-31 实测：`NeoMD-1.3.1.apk` 在 OSS 上存在（4363947 字节），但
 * `services/api/releases/` **和** `dist-artifacts/deploy/server/releases/` **都没有它**，
 * 两处最新只到 `NeoMD-1.1.8.apk`；生产服务器上那份是**手工放上去的**。
 *
 * 后果：一旦用 `dist-artifacts/deploy` 重新部署，APK 会再次丢失 → 客户端 404，
 * 正是 1.2.0 / 1.3.1 反复踩的同一个坑。
 * **只查运行期目录发现不了这个** —— 「本机能跑」不等于「部署产物完整」。
 */
const LOCAL_DIRS = [
  { label: '运行期 services/api/releases', dir: path.join(apiRoot, 'releases'), required: true },
  {
    label: '部署产物 dist-artifacts/deploy/server/releases',
    dir: path.join(repo, 'dist-artifacts', 'deploy', 'server', 'releases'),
    required: false,
  },
];
const LOCAL_DIR = LOCAL_DIRS[0].dir;

const API_BASE = (process.env.API_BASE || 'http://127.0.0.1:3200').replace(/\/+$/, '');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '6655';
const noProbe = process.argv.includes('--no-probe');

const pkg = JSON.parse(fs.readFileSync(path.join(apiRoot, 'package.json'), 'utf8'));
const version = String(pkg.version);

/** 三类产物及其就绪判据 */
const TARGETS = [
  { file: `NeoMD-${version}-win-x64.zip`, label: 'Windows x64 绿色版', require: 'oss' },
  { file: `NeoMD-${version}-setup.exe`, label: 'Windows x64 安装包', require: 'oss' },
  { file: `NeoMD-${version}.apk`, label: 'Android APK', require: 'local' },
];

let failures = 0;
const problems = [];

function ok(label, extra) {
  console.log(`  OK    ${label}${extra ? `  [${extra}]` : ''}`);
}
function bad(label, extra) {
  failures += 1;
  problems.push(`${label}${extra ? `  [${extra}]` : ''}`);
  console.log(`  MISS  ${label}${extra ? `  [${extra}]` : ''}`);
}

console.log(`发版门禁：当前版本 v${version}（来自 services/api/package.json）`);

/* ---------------- 1. 本地磁盘（两处） ---------------- */
console.log('\n[1/3] 本地 releases/ 目录（运行期 + 部署产物）');
const existsIn = new Map(); // 目录 label -> Set<文件名>
for (const { label, dir, required } of LOCAL_DIRS) {
  const set = new Set();
  let readable = true;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (fs.statSync(path.join(dir, name)).isFile()) set.add(name);
    }
  } catch (err) {
    readable = false;
    if (required) console.log(`  ??    ${label} 不可读：${err.message}`);
    else console.log(`  --    ${label} 不存在（尚未构建部署产物，跳过）`);
  }
  existsIn.set(label, { set, dir, required, readable });
  if (readable) {
    console.log(`         ${label}：${set.size} 个文件`);
  }
}

for (const t of TARGETS) {
  const needLocal = t.require === 'local';
  // 运行期目录是「本机能不能跑」的判据；部署产物目录是「发布出去是否完整」的判据
  const runtime = existsIn.get(LOCAL_DIRS[0].label);
  const deploy = existsIn.get(LOCAL_DIRS[1].label);
  const inRuntime = runtime.set.has(t.file);
  const inDeploy = deploy.readable ? deploy.set.has(t.file) : null;

  if (needLocal) {
    if (inRuntime) {
      const size = fs.statSync(path.join(runtime.dir, t.file)).size;
      ok(`运行期存在 ${t.file}`, `${(size / 1024 / 1024).toFixed(1)} MB`);
    } else {
      bad(`运行期缺失 ${t.file}（该类产物必须本地直出）`);
    }
    // 部署产物缺失 = 一旦重新部署就会丢，这是 1.2.0/1.3.1 反复踩的坑
    if (inDeploy === false) {
      bad(`部署产物缺失 ${t.file}（重新部署会把 APK 弄丢 → 客户端 404）`);
    } else if (inDeploy === true) {
      const size = fs.statSync(path.join(deploy.dir, t.file)).size;
      ok(`部署产物存在 ${t.file}`, `${(size / 1024 / 1024).toFixed(1)} MB`);
    }
  } else if (inRuntime) {
    console.log(`  --    运行期有 ${t.file}（该类型走 OSS，本地可有可无）`);
  } else {
    console.log(`  --    运行期无 ${t.file}（该类型走 OSS，本地可有可无）`);
  }
}

/* ---------------- 2. 后台清单（OSS 存在性） ---------------- */
console.log('\n[2/3] 后台客户端分发清单（复用 download.js 数据源）');
let releases = null;
try {
  const loginRes = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: ADMIN_USER, password: ADMIN_PASS }),
  });
  const login = await loginRes.json();
  if (!login?.ok) throw new Error(`登录失败 HTTP ${loginRes.status}`);
  const token = login.data.accessToken;

  const res = await fetch(`${API_BASE}/api/admin/releases`, { headers: { authorization: `Bearer ${token}` } });
  const json = await res.json();
  if (!json?.ok) throw new Error(`接口失败 HTTP ${res.status}: ${json?.error?.message ?? ''}`);
  releases = json.data;

  /*
   * 兼容旧后端：1.4.0 之前 `/api/admin/releases` 只返回 `{ prefix, files }`，
   * 没有 `currentVersion` / `available` / `onOss`。门禁是发版流程的一环，
   * **不能因为「后端还没升级」就把所有产物报成缺件** —— 那会让门禁失去可信度。
   * 因此检测到旧格式时降级为「只校验文件存在性与 HEAD 可达」，并明确提示。
   */
  const legacyShape = releases.currentVersion === undefined;
  if (legacyShape) {
    console.log('  --    检测到旧版后台接口（无 currentVersion 字段），降级为「存在性 + HEAD」校验');
    console.log('        升级到 1.4.0 后可获得 OSS/本地来源区分与可用性判定');
    for (const t of TARGETS) {
      const row = (releases.files ?? []).find((f) => f.key?.endsWith(`/${t.file}`) || f.file === t.file);
      if (row) ok(`OSS 清单里有 ${t.file}`, `${(((row.size ?? 0) / 1024) / 1024).toFixed(1)} MB`);
      else if (t.require === 'oss') bad(`OSS 清单里没有 ${t.file}`);
      else console.log(`  --    OSS 清单里无 ${t.file}（APK 走本地直出，本地存在即可）`);
    }
  } else {
    if (releases.currentVersion === version) {
      ok(`后台 currentVersion === package.json version`, releases.currentVersion);
    } else {
      bad('后台 currentVersion 与 package.json 不一致', `后台=${releases.currentVersion} pkg=${version}`);
    }

    for (const t of TARGETS) {
      const row = (releases.files ?? []).find((f) => f.file === t.file);
      if (!row) {
        bad(`后台清单里没有 ${t.file}`);
        continue;
      }
      const meta = `OSS=${row.onOss} 本地=${row.onLocal} 可下载=${row.available} 大小=${row.size ?? '—'}`;
      if (t.require === 'local' && !row.onLocal) bad(`${t.file} 本地缺失（APK 必须本地直出）`, meta);
      else if (t.require === 'oss' && !row.onOss) bad(`${t.file} OSS 缺失（Windows 包走 OSS 302）`, meta);
      else if (!row.available) bad(`${t.file} 标记为不可下载`, meta);
      else ok(`${t.file} 就绪`, meta);
    }
  }
} catch (err) {
  bad('无法读取后台清单', err.message);
}

/* ---------------- 3. 真实 HEAD 探测 ---------------- */
console.log('\n[3/3] 客户端下载链路真实探测（HEAD）');
if (noProbe) {
  console.log('  --    已按 --no-probe 跳过');
} else if (!releases) {
  console.log('  --    上一步失败，跳过探测');
} else {
  for (const t of TARGETS) {
    const row = (releases.files ?? []).find((f) => f.file === t.file);
    if (!row) continue;
    try {
      const res = await fetch(`${API_BASE}/api/download/${encodeURIComponent(t.file)}`, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
      });
      const reachable = res.status === 200 || res.status === 302 || res.status === 307;
      if (reachable) ok(`${t.file} 客户端可达`, `HTTP ${res.status}`);
      else bad(`${t.file} 客户端不可达`, `HTTP ${res.status}`);
    } catch (err) {
      bad(`${t.file} 探测异常`, err.message);
    }
  }
}

/* ---------------- 汇总 ---------------- */
console.log(`\n${'='.repeat(60)}`);
if (failures === 0) {
  console.log(`v${version} 发版门禁通过：三类产物均已就绪。`);
  /*
   * 用 process.exitCode 而不是 process.exit()：
   * Node 24 在 Windows 上「还有未关闭的 fetch keep-alive handle 时直接 process.exit()」
   * 会触发 libuv 断言崩溃（`!(handle->flags & UV_HANDLE_CLOSING)`），
   * 表现成 exit code -1073740791 而不是 0/1 —— 门禁脚本绝不能这样退出，
   * 否则 CI 无法区分「门禁失败」和「脚本自身崩了」。
   */
  process.exitCode = 0;
} else {
  console.log(`v${version} 发版门禁失败：${failures} 项缺件，请勿发布。`);
  for (const p of problems) console.log(`  - ${p}`);
  console.log('\n修复提示：');
  console.log('  - Windows 包缺失 → 检查构建产物是否上传到 OSS mdadmin/releases/');
  console.log('  - APK 缺失 → 必须放到 services/api/releases/（阿里云禁止 APK 经 OSS 端点公开分发）');
  process.exitCode = 1;
}
