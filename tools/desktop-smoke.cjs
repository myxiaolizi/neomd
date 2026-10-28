/**
 * 桌面端启动自检：以 --dev 模式启动打包后的应用，用 Electron 自身截屏验证渲染结果。
 * 通过环境变量 DSH_ELECTRON_EXE 指定可执行文件。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const exe =
  process.env.DSH_ELECTRON_EXE ||
  path.join(__dirname, '..', 'dist-artifacts', 'win-unpacked', 'Neo MD.exe');
const shot = path.join(__dirname, process.env.SMOKE_SHOT || 'desktop-shot.png');
const route = process.env.SMOKE_ROUTE || '';

if (!fs.existsSync(exe)) {
  console.error('找不到可执行文件:', exe);
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.NEOMD_AUTOTEST = '1';

const args = ['--autotest', '--shot', shot];
if (route) args.push('--route', route);
if (process.env.SMOKE_SCRIPT) args.push('--script', path.join(__dirname, process.env.SMOKE_SCRIPT));

const child = spawn(exe, args, { env, stdio: 'inherit' });
const timer = setTimeout(() => {
  console.log('超时，强制结束');
  child.kill();
}, 40_000);

child.on('exit', (code) => {
  clearTimeout(timer);
  console.log('退出码:', code);
  if (fs.existsSync(shot)) {
    console.log('截图已生成:', shot, fs.statSync(shot).size, 'bytes');
  } else {
    console.log('未生成截图');
  }
  process.exit(code ?? 1);
});
