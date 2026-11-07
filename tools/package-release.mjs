/**
 * Package a release's five portable builds into clean zips.
 *
 * Usage: node tools/package-release.mjs 2.2.0
 *
 * Why this exists instead of reusing package-210.mjs:
 *   that script hardcodes the version into the release path, the shell folder
 *   names and the zip names, so it can only ever package 2.1.0. Every release
 *   bump would otherwise need a new copy-pasted script.
 *
 * Each release folder contains runtime state produced by the acceptance runs
 * (vault data, WebView2 profiles, logs, boot.json). That state must not ship:
 * a user unzipping the archive would inherit another machine's session, and a
 * stale boot.json makes diagnostics lie about the port.
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

const VERSION = process.argv[2];
if (!VERSION || !/^\d+\.\d+\.\d+$/.test(VERSION)) {
  console.error('usage: node tools/package-release.mjs <x.y.z>');
  process.exit(2);
}

const ROOT = 'C:\\Data\\BAC\\neomd';
const RELEASE = path.join(ROOT, 'releases', VERSION);
const OUT = path.join(RELEASE, 'zips');

const SHELLS = ['tauri', 'flutter', 'winui3', 'qt', 'electron'].map((key) => ({
  key,
  dir: `NeoMD-${VERSION}-${key}-x64`,
}));

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

/**
 * Flutter keeps real runtime assets inside data/, so never drop these.
 * Dropping them produces a shell that starts and immediately dies, which looks
 * exactly like a crash-on-launch bug rather than a packaging mistake.
 */
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

let ok = 0;
let failed = 0;

for (const s of SHELLS) {
  const dir = path.join(RELEASE, s.dir);
  if (!fs.existsSync(dir)) {
    console.log(`${s.key.padEnd(9)} MISSING ${dir}`);
    failed += 1;
    continue;
  }
  const removed = clean(dir, s.key);
  const zip = path.join(OUT, `${s.dir}.zip`);
  fs.rmSync(zip, { force: true });

  // Compress-Archive keeps long paths and empty dirs sane
  const ps = `Compress-Archive -Path '${dir}' -DestinationPath '${zip}' -CompressionLevel Optimal -Force`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'pipe', timeout: 900000 });
    const mb = (fs.statSync(zip).size / 1024 / 1024).toFixed(1);
    console.log(`${s.key.padEnd(9)} cleaned=[${removed.join(',')}] zip=${mb}MB`);
    ok += 1;
  } catch (e) {
    console.log(`${s.key.padEnd(9)} zip FAILED ${String(e).slice(0, 200)}`);
    failed += 1;
  }
}

console.log(`\noutput: ${OUT}`);
console.log(`summary: ${ok} packaged, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
