/**
 * 生成部署包：前端静态产物 + 后端服务 + 环境配置。
 * 产出 dist-artifacts/neomd-deploy.tar.gz，供上传到服务器解压。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const stage = path.join(repo, 'dist-artifacts', 'deploy');
const webDist = path.join(repo, 'apps', 'web', 'dist');
const apiDir = path.join(repo, 'services', 'api');
const outTar = path.join(repo, 'dist-artifacts', 'neomd-deploy.tar.gz');

if (!existsSync(path.join(webDist, 'index.html'))) {
  console.error('缺少前端产物，请先执行 pnpm --filter @neomd/web build');
  process.exit(1);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(path.join(stage, 'public'), { recursive: true });
mkdirSync(path.join(stage, 'server'), { recursive: true });

// 前端
cpSync(webDist, path.join(stage, 'public'), { recursive: true });

// 后端（源码 + 依赖清单，依赖在服务器上安装）
cpSync(path.join(apiDir, 'src'), path.join(stage, 'server', 'src'), { recursive: true });
cpSync(path.join(apiDir, 'package.json'), path.join(stage, 'server', 'package.json'));
if (existsSync(path.join(apiDir, 'README.md'))) {
  cpSync(path.join(apiDir, 'README.md'), path.join(stage, 'server', 'README.md'));
}
// 随服务分发的安装包（APK 受对象存储限制，由服务器直出）
const localReleases = path.join(apiDir, 'releases');
if (existsSync(localReleases)) {
  cpSync(localReleases, path.join(stage, 'server', 'releases'), { recursive: true });
}

// 生产环境配置：数据库走本机，端口 3200
const envSrc = readFileSync(path.join(apiDir, '.env'), 'utf8');
const envProd = envSrc
  .replace(/^DB_HOST=.*$/m, 'DB_HOST=127.0.0.1')
  .replace(/^PORT=.*$/m, 'PORT=3200')
  .replace(/^HOST=.*$/m, 'HOST=127.0.0.1')
  .replace(/^WEB_ROOT=.*$/m, 'WEB_ROOT=/www/wwwroot/md.zhengl.vip/public')
  .replace(/^NODE_ENV=.*$/m, 'NODE_ENV=production');
writeFileSync(path.join(stage, 'server', '.env'), envProd, 'utf8');

// 部署说明
writeFileSync(
  path.join(stage, 'DEPLOY.md'),
  [
    '# Neo MD 部署说明',
    '',
    '目录结构：',
    '- public/  前端静态产物，作为站点根目录',
    '- server/  后端服务，Node 项目运行入口 server/src/server.js',
    '',
    '步骤：',
    '1. 把 public/ 内容放到 /www/wwwroot/md.zhengl.vip/public',
    '2. 把 server/ 放到 /www/wwwroot/md.zhengl.vip/server',
    '3. 在 server 目录执行 npm install --omit=dev',
    '4. 面板创建 Node 项目：端口 3200、Node v24、启动 node src/server.js',
    '5. 站点绑定 md.zhengl.vip 并部署 SSL，反向代理到 127.0.0.1:3200',
    '',
  ].join('\n'),
  'utf8',
);

// 打包（Windows 自带 tar）
execFileSync('tar', ['-czf', outTar, '-C', stage, '.'], { stdio: 'inherit' });
console.log('部署包已生成:', outTar);
