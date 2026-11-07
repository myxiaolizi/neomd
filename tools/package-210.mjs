/**
 * Package the five 2.1.0 portable builds into clean zips.
 *
 * Each release folder currently contains runtime state produced by the
 * acceptance runs (vault data, WebView2 profiles, logs, boot.json). That state
 * must not ship: a user unzipping the archive would inherit another machine's
 * session, and a stale boot.json makes diagnostics lie about the port.
 *
 * What we keep per shell:
 *   - the executable
 *   - the shell's own runtime assets (Flutter's app.so etc., Qt's _internal/,
 *     Electron's resources/)
 *   - the freshly deployed web-dist
 * What we drop:
 *   - data/ contents that are pure session state
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:\\Data\\BAC\\neomd';
const RELEASE = path.join(ROOT, 'releases', '2.1.0');
const OUT = path.join(RELEASE, 'zips');

const SHELLS = [
  { key: 'tauri', dir: 'NeoMD-2.1.0-tauri-x64' },
  { key: 'flutter', dir: 'NeoMD-2.1.0-flutter-x64' },
  { key: 'winui3', dir: 'NeoMD-2.1.0-winui3-x64' },
  { key: 'qt', dir: 'NeoMD-2.1.0-qt-x64' },
  { key: 'electron', dir: 'NeoMD-2.1.0-electron-x64' },
];

/** Session-state entries that must never ship inside data/. */
const SESSION_STATE = new Set([
  'vault',
  'webview2',
  'webengine',
  'userData',
  'boot.json',
  'server-port.txt',
  'runtime-probe.json',
  'logs',
]);

/** Flutter keeps real runtime assets inside data/, so never drop these. */
const FLUTTER_KEEP = new Set([
  'app.so',
  'icudtl.dat',
  'fonts',
  'packages',
  'shaders',
  'AssetManifest.bin',
  'FontManifest.json',
  'NativeAssetsManifest.json',
  'NOTICES.Z',
]);

function clean(dir, key) {
  const data = path.join(dir, 'data');
  if (!fs.existsSync(data)) return [];
  const removed = [];
  for (const e of fs.readdirSync(data)) {
    if (key === 'flutter' && FLUTTER_KEEP.has(e)) continue;
    if (!SESSION_STATE.has(e)) continue;
    fs.rmSync(path.join(data, e), { recursive: true, force: true });
    removed.push(e);
  }
  // an empty data/ is still useful: it opts Electron into portable mode
  if (key !== 'flutter') fs.mkdirSync(data, { recursive: true });
  return removed;
}

fs.mkdirSync(OUT, { recursive: true });

for (const s of SHELLS) {
  const dir = path.join(RELEASE, s.dir);
  if (!fs.existsSync(dir)) {
    console.log(`${s.key}: MISSING ${dir}`);
    continue;
  }
  const removed = clean(dir, s.key);
  const zip = path.join(OUT, `${s.dir}.zip`);
  fs.rmSync(zip, { force: true });

  // Compress-Archive via PowerShell keeps long paths and empty dirs sane
  const ps = `Compress-Archive -Path '${dir}' -DestinationPath '${zip}' -CompressionLevel Optimal -Force`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'pipe', timeout: 600000 });
  } catch (e) {
    console.log(`${s.key}: zip FAILED ${String(e).slice(0, 200)}`);
    continue;
  }
  const mb = (fs.statSync(zip).size / 1024 / 1024).toFixed(1);
  console.log(`${s.key.padEnd(9)} cleaned=[${removed.join(',')}] zip=${mb}MB`);
}

console.log('\noutput:', OUT);
