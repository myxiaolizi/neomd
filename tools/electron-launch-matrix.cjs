/**
 * Electron 启动参数矩阵测试。
 *
 * 目的：找出「双击即用」的稳定组合。
 * 每组都真实截图，用「页面是否真的画出内容」判定成功，
 * 不能只看 MainWindowTitle（标题可能已设置但页面是白的）。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const DIR = 'C:\\Data\\BAC\\neomd\\releases\\2.1.0\\NeoMD-2.1.0-electron-x64';
const EXE = path.join(DIR, 'Neo MD.exe');
const OUT = 'C:\\Data\\BAC\\neomd\\neomd-V1\\reports\\model-verify';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const kill = () => {
  try {
    execSync('taskkill /F /IM "Neo MD.exe" /T', { stdio: 'ignore' });
  } catch {}
};

const CASES = [
  { name: 'no-args', args: [], env: {} },
  { name: 'disable-gpu', args: ['--disable-gpu'], env: { NEOMD_ENABLE_GPU: '1' } },
  { name: 'disable-gpu-no-sandbox', args: ['--disable-gpu', '--no-sandbox'], env: { NEOMD_ENABLE_GPU: '1' } },
  { name: 'no-sandbox-only', args: ['--no-sandbox'], env: { NEOMD_ENABLE_GPU: '1' } },
  { name: 'gpu-on', args: [], env: { NEOMD_ENABLE_GPU: '1' } },
];

const results = [];

(async () => {
  for (const c of CASES) {
    kill();
    await sleep(3000);
    // 清日志便于归因
    const logFile = path.join(DIR, 'data', 'neomd-main.log');
    try {
      fs.rmSync(logFile, { force: true });
    } catch {}

    const env = { ...process.env, ...c.env };
    delete env.ELECTRON_RUN_AS_NODE;

    const proc = spawn(EXE, c.args, { cwd: DIR, env, stdio: 'ignore' });

    // 等 20 秒，期间多次采样窗口标题，判断是否出现 stopped working
    let titles = [];
    let exited = null;
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      if (proc.exitCode !== null) {
        exited = proc.exitCode;
        break;
      }
      try {
        const out = execSync(
          `powershell -NoProfile -Command "Get-Process -Name 'Neo MD' -EA SilentlyContinue | Select-Object -ExpandProperty MainWindowTitle"`,
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        );
        const t = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        for (const x of t) if (!titles.includes(x)) titles.push(x);
      } catch {}
    }

    // 截图
    const shot = path.join(OUT, `electron-case-${c.name}.png`);
    try {
      execSync(
        `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ` +
          `$b=New-Object System.Drawing.Bitmap([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width,[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height); ` +
          `$g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(0,0,0,0,$b.Size); ` +
          `$b.Save('${shot}'); $g.Dispose(); $b.Dispose()"`,
        { stdio: 'ignore' },
      );
    } catch {}

    // 读日志
    let logTail = '';
    try {
      logTail = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).slice(-4).join('\n');
    } catch {}

    const crashed = titles.some((t) => /stopped working/i.test(t));
    results.push({
      case: c.name,
      args: c.args,
      env: c.env,
      exited,
      titles,
      crashed,
      shot: path.basename(shot),
      logTail,
    });
    console.log(`[${c.name}] exited=${exited} crashed=${crashed} titles=${JSON.stringify(titles)}`);
  }

  kill();
  fs.writeFileSync(path.join(OUT, 'electron-matrix.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log('\n=== written electron-matrix.json ===');
  process.exit(0);
})();
