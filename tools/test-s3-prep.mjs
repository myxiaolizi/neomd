/**
 * S3 客户端实测：对真实阿里云 OSS 桶执行 probe（列举/写入/读取/删除），
 * 并验证同步引擎的核心合并逻辑。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

// 先用 esbuild 把 TS 打成单文件，避免 Node 直接跑 .ts
const bundle = path.join(here, '.s3test.mjs');
const ESBUILD = path.join(
  repo,
  'node_modules',
  '.pnpm',
  '@esbuild+win32-x64@0.28.2',
  'node_modules',
  '@esbuild',
  'win32-x64',
  'esbuild.exe',
);
const build = spawnSync(
  ESBUILD,
  [
    path.join(repo, 'packages', 'core', 'src', 'storage', 's3-client.ts'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--outfile=' + bundle,
  ],
  { cwd: repo, stdio: 'inherit' },
);
if (build.status !== 0) process.exit(1);
console.log('打包完成:', bundle);
