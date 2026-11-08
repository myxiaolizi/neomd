/**
 * 给子代理准备隔离测试副本。
 *
 * 关键教训（本轮踩过，代价是两个测试者的结论作废）：
 *   `data/` 目录在各壳里的语义**完全不同**，不能一刀切删除。
 *
 *   flutter : data/ 里是运行时资产 —— flutter_assets / app.so / icudtl.dat
 *             删掉它 exe 根本起不来（缺 app.so / icudtl.dat），表现为"启动即闪退"。
 *             这不是产品缺陷，是我的副本准备脚本把程序本体删了。
 *   qt      : data/ 里是 vault / webengine / boot.json —— 纯用户态，可删
 *   tauri   : data/ 里是 vault / webview2 / boot.json (+chrome-cdp-tmp) —— 可删
 *   winui3  : data/ 空 —— 可删
 *   electron: 无 data/ 目录 —— 无需处理
 *
 * 所以正确做法是：**按白名单删除用户态子项**，其余原样保留。
 *
 * 用法：
 *   node tools/prep-testcopy.mjs <shell> <name>
 *   node tools/prep-testcopy.mjs --all
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const VERSION = process.env.NEOMD_VERSION ?? '2.2.0';
const RELEASE = `C:\\Data\\BAC\\neomd\\releases\\${VERSION}`;
const ROOT = 'C:\\Data\\BAC\\neomd\\.testcopy';

/** 各壳 data/ 里属于「用户态、可安全删除」的子项。未列出的文件一律保留。 */
const USER_STATE = {
  flutter: [], // 全部是运行时资产，一个都不能删
  qt: ['vault', 'webengine', 'boot.json'],
  tauri: ['vault', 'webview2', 'boot.json', 'chrome-cdp-tmp'],
  winui3: ['webview2', 'boot.json'],
  electron: [], // 无 data 目录
};

/** 各壳 exe 名（用于运行前清进程） */
const EXE = {
  flutter: 'neomd_flutter.exe',
  qt: 'NeoMD.exe',
  tauri: 'NeoMD.exe',
  winui3: 'NeoMD.WinUI3.exe',
  electron: 'Neo MD.exe',
};

function prep(shell, name) {
  const src = path.join(RELEASE, `NeoMD-${VERSION}-${shell}-x64`);
  const dst = path.join(ROOT, name);
  if (!fs.existsSync(src)) throw new Error(`source missing: ${src}`);

  /*
   * 删除旧副本可能失败：子代理还在跑，exe/webview profile 被占用。
   * 这种情况不能让整个批次崩掉（一个占用就全军覆没），要单独报出来，
   * 让调用者决定是杀掉占用者重试、还是跳过这个副本。
   */
  try {
    fs.rmSync(dst, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  } catch (e) {
    const busy = [];
    try {
      execFileSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*${name}*' } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`],
        { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean).forEach((l) => busy.push(l.trim()));
    } catch {}
    return { shell, name, dst, removed: [], kept: [], missing: [], ok: false,
      error: `副本被占用无法重建：${e.code ?? e.message}` + (busy.length ? `；占用进程 ${busy.join(', ')}` : '') };
  }

  // robocopy 的返回码 0-7 都算成功
  try {
    execFileSync('robocopy', [src, dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1'], { stdio: 'ignore' });
  } catch (e) {
    if (typeof e.status !== 'number' || e.status > 7) throw e;
  }

  const dataDir = path.join(dst, 'data');
  const removed = [];
  const kept = [];
  if (fs.existsSync(dataDir)) {
    const allow = new Set(USER_STATE[shell]);
    for (const entry of fs.readdirSync(dataDir)) {
      if (allow.has(entry)) {
        fs.rmSync(path.join(dataDir, entry), { recursive: true, force: true });
        removed.push(entry);
      } else {
        kept.push(entry);
      }
    }
  }

  // 复核：flutter 的运行时资产必须仍在，否则副本不可启动
  const mustHave = {
    flutter: ['data/app.so', 'data/icudtl.dat', 'data/flutter_assets'],
    qt: ['_internal'],
    tauri: ['webdist'],
    winui3: ['web-dist'],
    electron: ['resources/webdist'],
  }[shell] ?? [];
  const missing = mustHave.filter((p) => !fs.existsSync(path.join(dst, p)));

  return { shell, name, dst, removed, kept, missing, ok: missing.length === 0 };
}

const args = process.argv.slice(2);
const need = {
  qt: ['qt-gemini4argon', 'qt-qwen38max', 'qt-gpt56terra'],
  tauri: ['tauri-gemini38flash', 'tauri-glm53flash', 'tauri-qwen37plus'],
  winui3: ['winui3-gemini4argon', 'winui3-deepseekv4pro', 'winui3-gemini36flash'],
  flutter: ['flutter-gemini37flash', 'flutter-deepseekv41flash', 'flutter-qwen38max'],
  electron: ['electron-gemini4argon', 'electron-gpt56terra', 'electron-glm53flash'],
};

const tasks = args[0] === '--all'
  ? Object.entries(need).flatMap(([shell, names]) => names.map((n) => [shell, n]))
  : [[args[0], args[1]]];

if (!tasks[0][0] || !tasks[0][1]) {
  console.error('usage: node tools/prep-testcopy.mjs <shell> <name> | --all');
  process.exit(1);
}

let bad = 0;
for (const [shell, name] of tasks) {
  const r = prep(shell, name);
  const flag = r.ok ? 'OK  ' : 'BAD ';
  if (!r.ok) bad += 1;
  if (r.error) {
    console.log(`${flag} ${name.padEnd(26)} ${r.error}`);
    continue;
  }
  console.log(
    `${flag} ${name.padEnd(26)} removed=[${r.removed.join(',')}] kept=[${r.kept.join(',')}]` +
    (r.missing.length ? `  MISSING=[${r.missing.join(',')}]` : ''),
  );
}
console.log(bad === 0 ? '\nall copies ready' : `\n${bad} copies incomplete`);

// 有问题的副本必须显式失败，不能静默交给测试者
process.exit(bad === 0 ? 0 : 1);
