/**
 * Neo MD 桌面端统一性能与稳定性基准测试。
 *
 *   node tools/bench-desktop.mjs --all
 *   node tools/bench-desktop.mjs --exe <exe路径> --name <名字> [--duration 45] [--rounds 3]
 *
 * 采集指标（每版一致，保证可比）：
 *   - coldStartMs   进程启动 → 主窗口句柄出现
 *   - peakMemMb     运行期所有同名进程 WorkingSet64 之和的峰值（WebView 多进程会明显偏高）
 *   - idleCpuPct    静置期 CPU 平均占用（按逻辑核数归一化）
 *   - dirSizeMb     产物目录总字节
 *   - exeSizeMb     主 exe 体积
 *   - processCount  进程数峰值
 *   - 稳定性        连续启停 N 次，统计「主窗口出现 + 3 秒后仍存活」
 *
 * 采集端是 tools/bench-collect.ps1（独立 .ps1 文件，避免 cmd 二次解析吃掉 $ 变量）。
 *
 * 结果写入 reports/bench-<name>.json，全量写 reports/bench-all.json。
 */
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const RELEASES = join(root, '..', 'releases', '2.0.0');
const REPORTS = join(root, 'reports');
const PS1 = join(here, 'bench-collect.ps1');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 调用采集脚本，返回 trim 后的 stdout */
function collect(action, procName = '', timeoutSec = 30) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    PS1,
    '-Action',
    action,
    '-ProcName',
    procName,
    '-TimeoutSec',
    String(timeoutSec)
  ];
  return execFileSync('powershell', args, {
    encoding: 'utf8',
    timeout: (timeoutSec + 15) * 1000,
    windowsHide: true
  }).trim();
}

/** 目录总字节 */
function dirBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          total += statSync(p).size;
        } catch {
          /* 瞬时文件忽略 */
        }
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return total;
}

const mb = (b) => Math.round((b / 1024 / 1024) * 10) / 10;

/**
 * 启动 exe（detached，不阻塞）。
 *
 * ⚠ 必须从子进程环境里剔除 `ELECTRON_RUN_AS_NODE`：
 * 本机当前 shell 环境里带着 `ELECTRON_RUN_AS_NODE=1`（通常是某次 electron 相关命令
 * 或 pnpm 脚本残留的），Electron 应用会因此**以纯 Node 模式启动、不创建任何窗口**，
 * 表现为「进程瞬间退出、窗口句柄永远是 0」，极容易被误判成「构建出来的 exe 是坏的」。
 * 这里在 spawn 时剔除，保证被测应用拿到干净的环境。
 */
function launch(exe) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false, env });
  child.unref();
}

/** 测量单个版本 */
async function measure(exe, { duration = 45 } = {}) {
  const procName = basename(exe).replace(/\.exe$/i, '');

  // 清理残留，保证真的是冷启动
  try {
    collect('kill', procName);
  } catch {
    /* ignore */
  }
  await sleep(500);

  const t0 = Date.now();
  launch(exe);

  // 冷启动：等主窗口
  let coldStartMs = null;
  try {
    const r = collect('wait-window', procName, 30);
    if (r === 'OK') coldStartMs = Date.now() - t0;
  } catch {
    /* 超时 */
  }

  // 采样
  const samples = [];
  const sampleStart = Date.now();
  while (Date.now() - sampleStart < duration * 1000) {
    try {
      const raw = collect('sample', procName, 10);
      if (raw === 'DEAD') break;
      const [ws, cpu, n] = raw.split('|');
      samples.push({ t: Date.now() - sampleStart, ws: Number(ws), cpu: Number(cpu), n: Number(n) });
    } catch {
      /* 采样失败就跳过这一次 */
    }
    await sleep(1000);
  }

  const diedEarly = samples.length === 0;

  try {
    collect('kill', procName);
  } catch {
    /* ignore */
  }
  await sleep(600);

  const peakMem = samples.length ? Math.max(...samples.map((s) => s.ws)) : 0;
  const procCount = samples.length ? Math.max(...samples.map((s) => s.n)) : 0;

  // CPU%：首末采样差值 / 墙钟 / 逻辑核数
  let idleCpuPct = null;
  if (samples.length >= 2) {
    const first = samples[0];
    const last = samples[samples.length - 1];
    const cpuDelta = last.cpu - first.cpu;
    const wallSec = (last.t - first.t) / 1000;
    let cores = 1;
    try {
      cores = Number(collect('cores')) || 1;
    } catch {
      /* ignore */
    }
    if (wallSec > 0) idleCpuPct = Math.round((cpuDelta / wallSec / cores) * 1000) / 10;
  }

  return {
    coldStartMs,
    peakMemMb: mb(peakMem),
    idleCpuPct,
    processCount: procCount,
    diedEarly,
    sampleCount: samples.length
  };
}

/** 稳定性：连续启停 N 次 */
async function stability(exe, rounds = 3) {
  const procName = basename(exe).replace(/\.exe$/i, '');
  let ok = 0;
  const details = [];

  for (let i = 1; i <= rounds; i++) {
    try {
      collect('kill', procName);
    } catch {
      /* ignore */
    }
    await sleep(500);

    const t0 = Date.now();
    launch(exe);

    let started = false;
    try {
      const r = collect('wait-window', procName, 30);
      started = r === 'OK';
    } catch {
      started = false;
    }

    // 存活检查：启动后 3 秒还在不在
    await sleep(3000);
    let aliveAfter3s = false;
    try {
      aliveAfter3s = collect('alive', procName, 10) === '1';
    } catch {
      aliveAfter3s = false;
    }

    // 只有「起来了 且 3 秒后还活着」才算这次成功
    const success = started && aliveAfter3s;
    if (success) ok++;

    details.push({ round: i, started, aliveAfter3s, success, ms: Date.now() - t0 });

    try {
      collect('kill', procName);
    } catch {
      /* ignore */
    }
    await sleep(400);
  }

  return { rounds, success: ok, successRate: Math.round((ok / rounds) * 1000) / 10, details };
}

/** 跑单个版本 */
async function benchOne(exe, name, opts = {}) {
  console.log(`\n=== 基准测试：${name} ===`);
  console.log(`exe: ${exe}`);

  if (!existsSync(exe)) {
    console.log(`✗ exe 不存在`);
    return { name, exe, error: 'EXE_NOT_FOUND' };
  }

  const dirBytesTotal = dirBytes(dirname(exe));
  const exeBytes = statSync(exe).size;
  console.log(`目录体积：${mb(dirBytesTotal)} MB   exe：${mb(exeBytes)} MB`);

  console.log('测量冷启动 / 内存 / CPU ...');
  const m = await measure(exe, { duration: opts.duration ?? 45 });
  console.log(`  冷启动：${m.coldStartMs === null ? '未测到（窗口未出现）' : m.coldStartMs + ' ms'}`);
  console.log(`  内存峰值：${m.peakMemMb} MB    进程数：${m.processCount}`);
  console.log(`  空闲 CPU：${m.idleCpuPct === null ? 'N/A' : m.idleCpuPct + ' %'}`);
  if (m.diedEarly) console.log('  ⚠ 运行期一个样本都没采到，判定为启动失败');

  console.log(`稳定性：连续启停 ${opts.rounds ?? 3} 次 ...`);
  const st = await stability(exe, opts.rounds ?? 3);
  console.log(`  成功 ${st.success}/${st.rounds}（${st.successRate}%）`);

  const result = {
    name,
    exe,
    dirSizeMb: mb(dirBytesTotal),
    exeSizeMb: mb(exeBytes),
    ...m,
    stability: st,
    measuredAt: new Date().toISOString()
  };

  mkdirSync(REPORTS, { recursive: true });
  writeFileSync(join(REPORTS, `bench-${name}.json`), JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`结果：reports/bench-${name}.json`);

  return result;
}

/** 自动发现 releases/2.0.0 下的主 exe（取体积最大的） */
function discover() {
  const found = [];
  if (!existsSync(RELEASES)) return found;

  for (const d of readdirSync(RELEASES, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = join(RELEASES, d.name);
    const exes = [];
    const walk = (p) => {
      let entries;
      try {
        entries = readdirSync(p, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(p, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && /\.exe$/i.test(e.name) && !/unins|crashpad|elevate|notification/i.test(e.name)) {
          exes.push(full);
        }
      }
    };
    walk(dir);
    if (exes.length) {
      exes.sort((a, b) => statSync(b).size - statSync(a).size);
      found.push({ name: d.name.replace(/^NeoMD-2\.0\.0-/, ''), exe: exes[0], dir });
    }
  }
  return found;
}

// ------------------------------ CLI ------------------------------
const argv = process.argv.slice(2);
const getArg = (k, d = null) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};

let sysinfo = '';
try {
  sysinfo = collect('sysinfo');
} catch {
  sysinfo = '';
}

if (argv.includes('--all')) {
  const targets = discover();
  if (!targets.length) {
    console.log(`未在 ${RELEASES} 找到任何 exe`);
    process.exit(1);
  }
  console.log(`发现 ${targets.length} 个版本：`);
  for (const t of targets) console.log(`  - ${t.name}: ${t.exe}`);

  const results = [];
  for (const t of targets) {
    results.push(
      await benchOne(t.exe, t.name, {
        duration: Number(getArg('--duration', 45)),
        rounds: Number(getArg('--rounds', 3))
      })
    );
  }

  mkdirSync(REPORTS, { recursive: true });
  writeFileSync(
    join(REPORTS, 'bench-all.json'),
    JSON.stringify({ sysinfo, results }, null, 2) + '\n',
    'utf8'
  );

  console.log('\n=== 汇总 ===');
  console.log('版本'.padEnd(12) + '启动(ms)'.padStart(10) + '内存(MB)'.padStart(11) + 'CPU(%)'.padStart(9) + '目录(MB)'.padStart(11) + '进程'.padStart(6) + '稳定'.padStart(8));
  for (const r of results) {
    console.log(
      String(r.name).padEnd(12) +
        String(r.coldStartMs ?? '-').padStart(10) +
        String(r.peakMemMb ?? '-').padStart(11) +
        String(r.idleCpuPct ?? '-').padStart(9) +
        String(r.dirSizeMb ?? '-').padStart(11) +
        String(r.processCount ?? '-').padStart(6) +
        String((r.stability?.successRate ?? '-') + '%').padStart(8)
    );
  }
  console.log(`\n全部结果：reports/bench-all.json`);
} else if (argv.includes('--exe')) {
  const exe = resolve(getArg('--exe'));
  const name = getArg('--name', basename(exe).replace(/\.exe$/i, ''));
  await benchOne(exe, name, {
    duration: Number(getArg('--duration', 45)),
    rounds: Number(getArg('--rounds', 3))
  });
} else {
  console.log('用法：');
  console.log('  node tools/bench-desktop.mjs --all');
  console.log('  node tools/bench-desktop.mjs --exe <exe路径> --name <名字> [--duration 45] [--rounds 3]');
}
