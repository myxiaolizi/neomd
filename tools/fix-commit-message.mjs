/**
 * 修正最近一次提交信息中的 BOM（PowerShell 5.1 的 `-Encoding utf8` 会写入 BOM，
 * `git commit -F` 会把 BOM 当成提交信息首字符，导致 GitHub 上标题出现看不见的占位符）。
 *
 *   node tools/fix-commit-message.mjs            # 修正 HEAD 的提交信息
 *   node tools/fix-commit-message.mjs --check    # 只检查
 *
 * 做法：读原始 commit message 的字节 → 去掉开头 BOM → 用 git commit-tree 重建同一棵树
 * （父提交、作者、时间均保持），再 reset --soft 到新提交，工作树与索引不受影响。
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const check = process.argv.includes('--check');
const git = (cmd, opts = {}) => execSync(`git ${cmd}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

const rawPath = join(mkdtempSync(join(tmpdir(), 'nm-msg-')), 'message.txt');
// 用 bytes 取原始信息，避免中间层再做编码转换
execSync(`git log -1 --format=%B > "${rawPath}"`, { shell: 'cmd.exe' });
const buf = readFileSync(rawPath);

const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
console.log(`当前 HEAD 提交信息${hasBom ? '含' : '不含'} BOM，长度 ${buf.length} 字节`);

if (!hasBom) {
  console.log('无需修正');
  process.exit(0);
}
if (check) {
  process.exit(1);
}

const cleaned = buf.subarray(3);
writeFileSync(rawPath, cleaned);

const tree = git('rev-parse HEAD^{tree}').trim();
const parent = git('rev-parse HEAD^').trim();
const author = git('log -1 --format=%an <%ae> %at').trim();

// 用 commit-tree 重建提交，保留作者与父提交
const newSha = execSync(`git commit-tree ${tree} -p ${parent} -F "${rawPath}"`, {
  encoding: 'utf8',
  env: {
    ...process.env,
    // 保留原作者与提交时间，避免改写历史痕迹
    GIT_AUTHOR_NAME: /^(.*) <(.*)> (\d+)$/.exec(author)[1],
    GIT_AUTHOR_EMAIL: /^(.*) <(.*)> (\d+)$/.exec(author)[2],
    GIT_AUTHOR_DATE: `@${/^(.*) <(.*)> (\d+)$/.exec(author)[3]} +0800`
  }
}).trim();

git(`reset --soft ${newSha}`);
const now = execSync('git log -1 --pretty=%s', { encoding: 'utf8' });
console.log(`已修正：${newSha.slice(0, 8)}`);
console.log(`新首行首码点：${now.codePointAt(0).toString(16)}`);
console.log(`新首行：${now.trim().slice(0, 60)}`);
process.exit(now.codePointAt(0) === 0xfeff ? 1 : 0);
