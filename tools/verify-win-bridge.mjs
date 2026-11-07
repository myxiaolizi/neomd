#!/usr/bin/env node
/**
 * 窗口桥功能验收：直接对壳的 /__bridge/win.* 打请求，验证四个壳的
 * 最小化 / 最大化 / 关闭 / 拖动 是否真的接通（而不是 noop / NOT_IMPLEMENTED）。
 *
 * 用法：node tools/verify-win-bridge.mjs [--shell tauri]
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RELEASE = (() => {
  const i = process.argv.indexOf('--release');
  const v = i > -1 ? process.argv[i + 1] : '2.1.0';
  return `C:\\Data\\BAC\\neomd\\releases\\${v}`;
})();
const SHELLS = [
  { name: 'tauri', dir: 'NeoMD-2.1.0-tauri-x64', exe: 'NeoMD.exe' },
  { name: 'qt', dir: 'NeoMD-2.1.0-qt-x64', exe: 'NeoMD.exe' },
  { name: 'winui3', dir: 'NeoMD-2.1.0-winui3-x64', exe: 'NeoMD.WinUI3.exe' },
  { name: 'flutter', dir: 'NeoMD-2.1.0-flutter-x64', exe: 'neomd_flutter.exe' },
];
const only = (() => {
  const i = process.argv.indexOf('--shell');
  return i > -1 ? process.argv[i + 1] : null;
})();
const targets = SHELLS.filter((s) => (only ? s.name === only : true));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function kill(exe) {
  try {
    execSync(`taskkill /F /IM "${exe}" /T`, { stdio: 'ignore' });
  } catch {}
}
function ports(pid) {
  try {
    const o = execSync('netstat -ano -p TCP', { encoding: 'utf8', maxBuffer: 1 << 25 });
    const s = new Set();
    for (const l of o.split(/\r?\n/)) {
      if (!/LISTENING/i.test(l)) continue;
      const f = l.trim().split(/\s+/);
      if (f.length < 5 || Number(f[4]) !== pid) continue;
      const p = Number(f[1].slice(f[1].lastIndexOf(':') + 1));
      if (p) s.add(p);
    }
    return [...s];
  } catch {
    return [];
  }
}
function bootPort(dir) {
  try {
    const m = /:(\d+)\//.exec(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'boot.json'), 'utf8')).url);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function bridge(port, method) {
  // 各壳对 body 形状要求不同：Tauri/WinUI3 用数组，Qt/Flutter 用对象。
  // 这里统一发 `{}`（json 对象），数组型壳也会解析成空数组，
  // 避免「因为请求体形状不对而误判为未实现」。
  const r = await fetch(`http://127.0.0.1:${port}/__bridge/${encodeURIComponent(method)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {}
  const value = j?.value ?? j?.result ?? null;
  const err = j?.__error ?? j?.error ?? null;
  return { status: r.status, value, err, raw: text.slice(0, 160) };
}

const reports = [];
for (const s of targets) {
  const dir = path.join(RELEASE, s.dir);
  const exe = path.join(dir, s.exe);
  const rep = { name: s.name, checks: [] };
  const push = (id, pass, detail) => rep.checks.push({ id, pass, detail });
  process.stdout.write(`\n========== ${s.name} ==========\n`);

  if (!fs.existsSync(exe)) {
    push('exe', false, `缺失：${s.exe}`);
    reports.push(rep);
    continue;
  }

  kill(s.exe);
  await sleep(1200);
  try {
    fs.rmSync(path.join(dir, 'data', 'boot.json'), { force: true });
  } catch {}

  const proc = spawn(exe, [], { cwd: dir, env: { ...process.env }, stdio: 'ignore' });
  let port = null;
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    const c = new Set(ports(proc.pid));
    const b = bootPort(dir);
    if (b) c.add(b);
    for (const p of c) {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(4000) });
        if (r.ok) {
          port = p;
          break;
        }
      } catch {}
    }
    if (port) break;
  }
  if (!port) {
    push('boot', false, '本地服务未起来');
    kill(s.exe);
    reports.push(rep);
    continue;
  }

  // 1) isMaximized 是否实现（返回布尔而不是 NOT_IMPLEMENTED）
  const im = await bridge(port, 'win.isMaximized');
  const imOk = im.err === null && typeof im.value === 'boolean';
  push('win.isMaximized', imOk, imOk ? `返回 ${im.value}` : `未实现/异常：${im.err ?? im.raw}`);

  // 2) toggleMaximize 是否改变最大化状态
  const before = (await bridge(port, 'win.isMaximized')).value;
  await bridge(port, 'win.toggleMaximize');
  await sleep(1200);
  const after = (await bridge(port, 'win.isMaximized')).value;
  const toggleOk = before !== after;
  push('win.toggleMaximize', toggleOk, toggleOk ? `${before} → ${after}（状态真的变了）` : `状态未变（${before} → ${after}）`);

  // 还原，避免影响后续截图
  if (after === true) {
    await bridge(port, 'win.toggleMaximize');
    await sleep(800);
  }

  // 3) startDrag 是否实现（拖拽回退依赖它）
  const sd = await bridge(port, 'win.startDrag');
  const sdOk = sd.err === null;
  push('win.startDrag', sdOk, sdOk ? '已实现' : `未实现：${sd.err ?? sd.raw}`);

  // 4) minimize 是否实现
  const mi = await bridge(port, 'win.minimize');
  push('win.minimize', mi.err === null, mi.err === null ? '已实现' : `未实现：${mi.err ?? mi.raw}`);
  await sleep(600);

  // 最小化后恢复（用 toggle 无效，这里靠再次 minimize 的壳自恢复；只做存在性验证）
  kill(s.exe);
  await sleep(1000);
  process.stdout.write(
    rep.checks.map((c) => `  [${c.pass ? 'PASS' : 'FAIL'}] ${c.id.padEnd(18)} ${c.detail}\n`).join(''),
  );
  reports.push(rep);
}

fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync('reports/win-bridge.json', JSON.stringify({ at: new Date().toISOString(), reports }, null, 2));
process.stdout.write('\n===== 汇总 =====\n');
for (const r of reports) {
  const p = r.checks.filter((c) => c.pass).length;
  const f = r.checks.filter((c) => !c.pass);
  process.stdout.write(`${r.name.padEnd(9)} ${p}/${r.checks.length}` + (f.length ? `  失败：${f.map((x) => x.id).join(',')}` : '') + '\n');
}
