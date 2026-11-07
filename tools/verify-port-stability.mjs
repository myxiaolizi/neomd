/**
 * Verify that each shell reuses a STABLE port across restarts.
 *
 * Why this matters: localStorage/IndexedDB are keyed by origin
 * (scheme + host + PORT). A random port per launch means a brand new origin
 * every run, so the login token and every setting vanish on restart.
 * Users report that as "it asks me to log in every time".
 *
 * All four shells were changed to prefer a fixed base port. This script
 * launches each one twice and asserts the port is identical.
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RELEASE = 'C:\\Data\\BAC\\neomd\\releases\\2.1.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHELLS = [
  { name: 'electron', dir: 'NeoMD-2.1.0-electron-x64', exe: 'Neo MD.exe', args: [] },
  { name: 'tauri', dir: 'NeoMD-2.1.0-tauri-x64', exe: 'NeoMD.exe', args: [] },
  { name: 'qt', dir: 'NeoMD-2.1.0-qt-x64', exe: 'NeoMD.exe', args: ['--no-sandbox'] },
  { name: 'winui3', dir: 'NeoMD-2.1.0-winui3-x64', exe: 'NeoMD.WinUI3.exe', args: [] },
  { name: 'flutter', dir: 'NeoMD-2.1.0-flutter-x64', exe: 'neomd_flutter.exe', args: [] },
];

function listeningPorts(pid) {
  const out = [];
  try {
    const raw = execSync('netstat -ano -p TCP', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of raw.split(/\r?\n/)) {
      const m = /TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
      if (m && Number(m[3]) === pid) out.push(Number(m[2]));
    }
  } catch {}
  return out;
}

function portFromBoot(dir) {
  try {
    const p = path.join(dir, 'data', 'boot.json');
    if (!fs.existsSync(p)) return null;
    const m = /:(\d+)\//.exec(JSON.parse(fs.readFileSync(p, 'utf8'))?.url ?? '');
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function runOnce(spec, round) {
  const dir = path.join(RELEASE, spec.dir);
  const exe = path.join(dir, spec.exe);
  if (!fs.existsSync(exe)) return { port: null, reason: 'exe missing' };

  try {
    execSync(`taskkill /F /FI "IMAGENAME eq ${spec.exe}" /T`, { stdio: 'ignore' });
  } catch {}
  await sleep(2000);

  const env = { ...process.env };
  // This hides Electron completely (starts as plain Node and exits immediately)
  delete env.ELECTRON_RUN_AS_NODE;

  const proc = spawn(exe, spec.args, { cwd: dir, env, stdio: 'ignore' });

  let port = null;
  let alive = false;
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    if (proc.exitCode === null) alive = true;
    const b = portFromBoot(dir);
    const lp = listeningPorts(proc.pid);
    // Prefer the port the shell advertises; fall back to the listening socket
    // (WinUI3 uses http.sys so the socket belongs to System, not our PID).
    const cands = [b, ...lp].filter((x) => x && x > 1024);
    if (cands.length) {
      port = cands[0];
      break;
    }
    // Electron serves the SPA over a custom protocol (neomd://) and never
    // listens on a TCP port, so "no port" is its correct, expected state.
    if (spec.name === 'electron' && b === null && !lp.length && i >= 10) {
      break;
    }
  }

  try {
    execSync(`taskkill /F /PID ${proc.pid} /T`, { stdio: 'ignore' });
  } catch {
    try {
      execSync(`taskkill /F /FI "IMAGENAME eq ${spec.exe}" /T`, { stdio: 'ignore' });
    } catch {}
  }
  await sleep(4000);
  return { port, round, alive };
}

(async () => {
  const results = [];
  for (const spec of SHELLS) {
    const a = await runOnce(spec, 1);
    const b = await runOnce(spec, 2);
    /*
     * Electron is the special case: it serves the SPA over the custom
     * `neomd://` protocol and never binds a TCP port, so its origin is
     * inherently stable. Treat "no port in both runs" as a pass.
     */
    const noPortOk = spec.name === 'electron' && a.port === null && b.port === null;
    const stable = noPortOk || (a.port !== null && a.port === b.port);
    results.push({ shell: spec.name, run1: a.port, run2: b.port, stable, noPortOk });
    console.log(
      `${spec.name.padEnd(9)} run1=${String(a.port).padEnd(6)} run2=${String(b.port).padEnd(6)} ` +
        `${stable ? 'STABLE' : 'CHANGED'}${noPortOk ? ' (custom protocol, no TCP port)' : ''}`,
    );
  }
  fs.writeFileSync(
    path.join(process.cwd(), 'reports', 'port-stability.json'),
    JSON.stringify(results, null, 2),
    'utf8',
  );
  const bad = results.filter((r) => !r.stable);
  console.log(`\n${results.length - bad.length}/${results.length} stable`);
  process.exit(bad.length ? 1 : 0);
})();
