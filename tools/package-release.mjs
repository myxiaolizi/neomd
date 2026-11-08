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
  /*
   * Chrome 调试缓存目录。
   *
   * 实测事故：2.2.0 的 tauri 包 7 MB，而 2.3.0 只有 3.7 MB。拆开对比发现
   * 前者混进了 `data/chrome-cdp-tmp/` —— **358 个文件、约 3.3 MB** 的
   * Chrome 用户数据（BrowserMetrics、component_crx_cache、Cache_Data、
   * CrashpadMetrics…）。
   *
   * 来源：某些验收/探针脚本为了在无 CDP 的壳上驱动页面，会起一个外部 Chrome，
   * 并把 `--user-data-dir` 指到壳目录下的 data/chrome-cdp-tmp（为了和壳的
   * 数据放一起便于清理）。跑完没删，打包就把它一起收进去了。
   *
   * 危害不只是体积：
   *   1. 这是**本机测试残留**，跟产品功能无关，绿色版里根本不该有；
   *   2. 里面可能残留缓存的页面资源、扩展组件清单，属于测试环境泄漏；
   *   3. 用户解压后会看到一个莫名其妙的 chrome-cdp-tmp 目录，像是被污染过。
   *
   * 所以列入清理白名单，并在下面额外按前缀兜底（见 clean()）。
   */
  'chrome-cdp-tmp',
  'chrome-profile',
  'chrome-debug-profile',
  'chrome-temp-a',
  '.tmp-cdp-profile',
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
    /*
     * 精确名单 + 前缀兜底两道闸。
     *
     * 只靠精确名单很脆弱：下一个人写探针时换个名字（chrome-tmp、edge-cdp…），
     * 又会静默混进包里，而且**体积变化不明显时根本发现不了** ——
     * 2.2.0 那次就是因为 7 MB 看着也"合理"才一直没被察觉。
     *
     * 兜底规则只针对测试工具链的产物（chrome/edge/cdp/profile/tmp/.tmp 开头），
     * 不碰任何产品自己的目录，避免误删运行时资源。
     */
    const looksLikeToolResidue =
      /^(chrome|edge|cdp|msedge|playwright|puppeteer)/i.test(e) ||
      /(^|[-_.])(tmp|temp|profile|userdata|cdp)([-_.]|$)/i.test(e) ||
      e.startsWith('.tmp');
    if (!SESSION_STATE.has(e) && !looksLikeToolResidue) continue;
    fs.rmSync(path.join(data, e), { recursive: true, force: true });
    removed.push(e);
  }
  if (key !== 'flutter') fs.mkdirSync(data, { recursive: true });
  return removed;
}

/**
 * 让「绿色版」真的绿色。
 *
 * Electron 壳的 portable.cjs 只在三种情况下才把 userData 放到 exe 同级的
 * data/：环境变量 NEOMD_PORTABLE=1、存在 portable.txt 标记、或 data/ 目录已存在。
 * 默认（DEFAULT_PORTABLE=false）走 %APPDATA%\@neomd\desktop。
 *
 * 2.2.0 实测踩到的坑：zip 里**放不进空目录**，`data/` 存在于本地发布目录但
 * 没进压缩包。用户解压后同级没有 data/，于是 15.1 MB 用户数据（登录态、
 * 窗口位置、Local Storage）写进了 %APPDATA% —— 换台机器或换个解压位置就
 * 等于"仓库和登录态丢了"，这与绿色版语义直接冲突。另外四壳都把数据写在
 * 本地 data/，只有 Electron 例外，属实现与定位不一致。
 *
 * 修法：在包里落一个 portable.txt 标记文件（产品原生支持，内容不解析）。
 * 用文件而不是空目录，是因为空目录在 zip/压缩工具里普遍会被丢弃。
 */
function ensurePortableMarker(dir, key) {
  if (key !== 'electron') return false;
  const marker = path.join(dir, 'portable.txt');
  if (fs.existsSync(marker)) return false;
  fs.writeFileSync(
    marker,
    [
      '这个文件让 Neo MD 绿色版把用户数据存放在本目录的 data/ 下，而不是系统 AppData。',
      '存在即生效，内容不会被解析，删掉它就会退回 %APPDATA%\\@neomd\\desktop。',
      '',
    ].join('\r\n'),
    'utf8',
  );
  return true;
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
  const addedMarker = ensurePortableMarker(dir, s.key);
  const zip = path.join(OUT, `${s.dir}.zip`);
  fs.rmSync(zip, { force: true });

  // Compress-Archive keeps long paths and empty dirs sane
  const ps = `Compress-Archive -Path '${dir}' -DestinationPath '${zip}' -CompressionLevel Optimal -Force`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'pipe', timeout: 900000 });
    const mb = (fs.statSync(zip).size / 1024 / 1024).toFixed(1);
    const extra = addedMarker ? ' +portable.txt' : '';
    console.log(`${s.key.padEnd(9)} cleaned=[${removed.join(',')}]${extra} zip=${mb}MB`);
    ok += 1;
  } catch (e) {
    console.log(`${s.key.padEnd(9)} zip FAILED ${String(e).slice(0, 200)}`);
    failed += 1;
  }
}

console.log(`\noutput: ${OUT}`);
console.log(`summary: ${ok} packaged, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
