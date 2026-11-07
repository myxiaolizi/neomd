#!/usr/bin/env node
/**
 * 四壳统一诊断：启动每个桌面壳，找到它的本地随机端口，
 * 直接对该端口做 HTTP 层的完整体检（不依赖 UI 自动化）。
 *
 * 说明：四个壳的承载架构一致——壳内起 127.0.0.1 随机端口服务器托管 web 产物，
 * 并把 /api/* 反代到上游。因此只要拿到端口，就能在进程之外验证
 * 「登录 / 鉴权 / 仓库同步 / 桥接口」这些真正决定功能可用性的链路。
 *
 * 用法：node tools/shell-diagnose.mjs [--only tauri|qt|winui3|flutter]
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const RELEASE = 'C:\\Data\\BAC\\neomd\\releases\\2.0.0';
const ACCOUNT = { username: 'admin', password: '6655' };

const SHELLS = [
  { name: 'tauri', dir: 'NeoMD-2.0.0-tauri-x64', exe: 'NeoMD.exe' },
  { name: 'qt', dir: 'NeoMD-2.0.0-qt-x64', exe: 'NeoMD.exe' },
  { name: 'winui3', dir: 'NeoMD-2.0.0-winui3-x64', exe: 'NeoMD.WinUI3.exe' },
  { name: 'flutter', dir: 'NeoMD-2.0.0-flutter-x64', exe: 'neomd_flutter.exe' },
];

const onlyArg = process.argv.indexOf('--only');
const only = onlyArg > -1 ? process.argv[onlyArg + 1] : null;
const targets = SHELLS.filter((s) => (only ? s.name === only : true));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 列出某个 pid 正在 LISTEN 的 TCP 端口。
 *
 * 注意：WinUI 3 版用 `HttpListener`，它走 Windows 内核态 http.sys，
 * 端口由 System 进程（PID 4）持有而**不归属应用进程本身**，
 * 所以按 PID 匹配 netstat 永远查不到它。对这类壳改用备用探测：
 * 直接读它自己写下的 `data/boot.json`（壳启动后第一时间落盘的真实地址）。
 */
function listenPorts(pid) {
  try {
    const out = execSync('netstat -ano -p TCP', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const ports = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const f = line.trim().split(/\s+/);
      if (f.length < 5) continue;
      if (Number(f[4]) !== pid) continue;
      const local = f[1];
      const p = Number(local.slice(local.lastIndexOf(':') + 1));
      if (p) ports.add(p);
    }
    return [...ports];
  } catch {
    return [];
  }
}

/** 从壳写下的 boot.json 里读出它实际监听的端口（http.sys 型壳专用） */
function portFromBootJson(dir) {
  try {
    const p = path.join(dir, 'data', 'boot.json');
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const m = /:(\d+)\//.exec(j?.url ?? '');
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function http(port, urlPath, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout ?? 30000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      signal: ctl.signal,
    });
    const text = await res.text();
    return { status: res.status, text, ok: res.ok };
  } finally {
    clearTimeout(t);
  }
}

function killShell(exe) {
  try {
    execSync(`taskkill /F /IM "${exe}" /T`, { stdio: 'ignore' });
  } catch {
    /* 没在跑 */
  }
}

async function diagnose(shell) {
  const dir = path.join(RELEASE, shell.dir);
  const exePath = path.join(dir, shell.exe);
  const result = { name: shell.name, exe: exePath, checks: [] };
  const push = (id, pass, detail) => result.checks.push({ id, pass, detail });

  if (!fs.existsSync(exePath)) {
    push('exe', false, `主程序不存在：${shell.exe}`);
    return result;
  }

  killShell(shell.exe);
  await sleep(1500);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const tStart = Date.now();
  const proc = spawn(exePath, [], { cwd: dir, env, stdio: 'ignore', detached: false });
  result.pid = proc.pid;

  // 等本地服务器起来：轮询该进程的 LISTEN 端口，直到首页能取到。
  // 对 http.sys 型壳（WinUI 3）额外用 boot.json 里的自报端口兜底。
  let port = null;
  let homeHtml = '';
  const bootJsonPath = path.join(dir, 'data', 'boot.json');
  try {
    fs.rmSync(bootJsonPath, { force: true });
  } catch {
    /* ignore */
  }

  for (let i = 0; i < 40; i++) {
    await sleep(700);
    const candidates = new Set(listenPorts(proc.pid));
    const fromBoot = portFromBootJson(dir);
    if (fromBoot) candidates.add(fromBoot);
    for (const p of candidates) {
      try {
        const r = await http(p, '/', { timeout: 4000 });
        if (r.status === 200 && /<html/i.test(r.text)) {
          port = p;
          homeHtml = r.text;
          break;
        }
      } catch {
        /* 换下一个端口 */
      }
    }
    if (port) break;
    if (proc.exitCode !== null) break;
  }

  result.port = port;
  result.bootMs = Date.now() - tStart;

  if (!port) {
    push('boot', false, '未找到可用的本地 HTTP 服务（可能启动即退出或白屏）');
    return result;
  }
  push('boot', true, `本地服务 127.0.0.1:${port}，启动到可访问 ${result.bootMs} ms`);

  // 1. web 产物是否注入 window.NeoMD
  const injected = /window\.NeoMD/.test(homeHtml);
  push('inject', injected, injected ? 'window.NeoMD 已注入' : 'index.html 中未找到 window.NeoMD 注入');

  // 2. /api 反代是否通
  let health = null;
  try {
    const r = await http(port, '/api/health');
    health = r;
    const j = JSON.parse(r.text);
    push('api', r.status === 200 && j.ok === true, `/api/health -> ${r.status} ok=${j.ok} db=${j.db}`);
  } catch (e) {
    push('api', false, `/api/health 失败：${e.message}`);
  }

  // 3. 登录
  let token = null;
  try {
    const r = await http(port, '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ACCOUNT),
    });
    if (r.status === 200) {
      const j = JSON.parse(r.text);
      token = j?.data?.accessToken ?? null;
      push('login', Boolean(token), `POST /api/auth/login -> ${r.status}，accessToken ${token ? '已下发' : '缺失'}`);
    } else {
      push('login', false, `POST /api/auth/login -> ${r.status} ${r.text.slice(0, 200)}`);
    }
  } catch (e) {
    push('login', false, `/api/auth/login 失败：${e.message}`);
  }

  if (token) {
    const auth = { authorization: `Bearer ${token}` };

    // 4. 仓库列表（云同步的入口）
    try {
      const r = await http(port, '/api/vaults', { headers: auth });
      const j = JSON.parse(r.text);
      const vaults = j?.data?.vaults ?? [];
      const docs = vaults.reduce((a, v) => a + (v.docCount ?? 0), 0);
      push('vaults', r.status === 200, `/api/vaults -> ${r.status}，仓库 ${vaults.length} 个、文档 ${docs} 篇`);
      result.vaults = vaults.map((v) => ({ id: v.vaultId, name: v.name, docCount: v.docCount }));
    } catch (e) {
      push('vaults', false, `/api/vaults 失败：${e.message}`);
    }

    // 5. 对象存储列举（文档同步的实际数据通道）
    try {
      const r = await http(port, '/api/storage/list?limit=5', { headers: auth });
      push('storage', r.status === 200, `/api/storage/list -> ${r.status}`);
    } catch (e) {
      push('storage', false, `/api/storage/list 失败：${e.message}`);
    }

    // 6. 会话续期（历史版本跨端可见依赖它）
    try {
      const r = await http(port, '/api/auth/me', { headers: auth });
      push('me', r.status === 200, `/api/auth/me -> ${r.status}`);
    } catch (e) {
      push('me', false, `/api/auth/me 失败：${e.message}`);
    }

    // 7. 桥接口（各壳原生侧是否真的接通）
    try {
      const r = await http(port, '/__bridge/paths.userData', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [] }),
      });
      push('bridge', r.status === 200, `/__bridge/paths.userData -> ${r.status} ${r.text.slice(0, 120)}`);
    } catch (e) {
      push('bridge', false, `/__bridge 失败：${e.message}`);
    }
  }

  // 收尾：确认进程仍存活（闪退检测）
  await sleep(800);
  const alive = proc.exitCode === null;
  push('alive', alive, alive ? '进程存活' : `进程已退出，exitCode=${proc.exitCode}`);

  killShell(shell.exe);
  proc.kill?.();
  await sleep(1200);
  return result;
}

const all = [];
for (const s of targets) {
  process.stdout.write(`\n===== ${s.name} =====\n`);
  try {
    const r = await diagnose(s);
    all.push(r);
    for (const c of r.checks) {
      process.stdout.write(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.id.padEnd(8)} ${c.detail}\n`);
    }
  } catch (e) {
    process.stdout.write(`  诊断异常：${e.message}\n`);
    all.push({ name: s.name, error: e.message, checks: [] });
  }
}

fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync('reports/shell-diagnose.json', JSON.stringify({ at: new Date().toISOString(), results: all }, null, 2));

process.stdout.write('\n===== 汇总 =====\n');
for (const r of all) {
  const p = r.checks.filter((c) => c.pass).length;
  const t = r.checks.length;
  const failed = r.checks.filter((c) => !c.pass).map((c) => c.id);
  process.stdout.write(
    `${r.name.padEnd(9)} ${String(p)}/${String(t)} 通过` + (failed.length ? `  失败：${failed.join(',')}` : '') + '\n',
  );
}
process.stdout.write(`\n结果：reports/shell-diagnose.json\n`);
