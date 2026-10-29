#!/usr/bin/env node
/**
 * Neo MD 版本升级与发布编排（1.1.9 起）。
 *
 * ## 为什么需要这个脚本
 *
 * 版本号在仓库里散落在 8 个位置（5 个 package.json、env.ts 的 APP_VERSION 与
 * 3 个下载文件名、desktop/android 构建脚本里的产物文件名）。手工改必漏，
 * 漏掉的后果是「安装包叫 1.1.8、应用内显示 1.1.9」这类难以察觉的不一致。
 *
 * 本脚本的原则：
 *  - **只改「真的是版本号」的位置**，不碰历史注释里的旧版本号
 *    （`// 1.1.8 修复了…` 这类注释是有价值的历史记录，改了反而丢失信息）；
 *  - 所有改动**先 dry-run 打印 diff**，确认后才写盘；
 *  - 可重复执行（幂等）。
 *
 * ## 用法
 *
 *   node tools/release-119.mjs version --to 1.1.9 --dry-run   # 预览改动
 *   node tools/release-119.mjs version --to 1.1.9             # 实际写入
 *   node tools/release-119.mjs check                          # 校验全仓库版本一致性
 *   node tools/release-119.mjs notes --version 1.1.9          # 抽取 CHANGELOG 段落
 *
 * 推送与建 Release 由 runbook（docs/RELEASE-119.md）里的 git/gh 命令完成，
 * 本脚本**不直接操作 git 远端**，避免在无人值守时误推。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 需要同步版本号的文件清单。
 *
 * `kind` 决定替换方式：
 *  - `package-json`：只替换 `"version": "x.y.z"` 这一行；
 *  - `env-version`：替换 `APP_VERSION = 'x.y.z'`；
 *  - `artifact-name`：替换产物文件名里的 `NeoMD-x.y.z-*` / `NeoMD-x.y.z.apk`。
 */
const TARGETS = [
  { file: 'package.json', kind: 'package-json' },
  { file: 'apps/web/package.json', kind: 'package-json' },
  { file: 'apps/desktop/package.json', kind: 'package-json' },
  { file: 'apps/android/package.json', kind: 'package-json' },
  { file: 'services/api/package.json', kind: 'package-json' },
  { file: 'apps/web/src/env.ts', kind: 'env-version' },
  { file: 'apps/desktop/build.mjs', kind: 'artifact-name' },
  { file: 'apps/android/build.mjs', kind: 'artifact-name' },
];

const SEMVER = /^\d+\.\d+\.\d+$/;

function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 读取根 package.json 的当前版本 */
function currentVersion() {
  const pkg = JSON.parse(read('package.json'));
  return String(pkg.version ?? '');
}

/**
 * 计算单个文件在目标版本下的新内容。
 * @returns {{ changed: boolean, before: string, after: string }}
 */
function rewrite(rel, kind, from, to) {
  const before = read(rel);
  let after = before;
  if (kind === 'package-json') {
    // 只替换顶层 version 字段，避免误伤 dependencies 里同名字符串
    after = before.replace(/("version"\s*:\s*)"([^"]+)"/, `$1"${to}"`);
  } else if (kind === 'env-version') {
    after = before.replace(/(APP_VERSION\s*=\s*')[\d.]+(')/, `$1${to}$2`);
    // 下载文件名（NeoMD-<ver>-win-x64.zip / -setup.exe / .apk）
    after = after.replace(new RegExp(`NeoMD-${escapeRe(from)}`, 'g'), `NeoMD-${to}`);
  } else if (kind === 'artifact-name') {
    after = after.replace(new RegExp(`NeoMD-${escapeRe(from)}`, 'g'), `NeoMD-${to}`);
  }
  return { changed: after !== before, before, after };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 打印统一 diff 风格的行级差异（只打印变化行，足够定位） */
function printDiff(rel, before, after) {
  const b = before.split('\n');
  const a = after.split('\n');
  const lines = [];
  const max = Math.max(b.length, a.length);
  for (let i = 0; i < max; i += 1) {
    if (b[i] !== a[i]) {
      if (b[i] !== undefined) lines.push(`  - ${b[i].trim()}`);
      if (a[i] !== undefined) lines.push(`  + ${a[i].trim()}`);
    }
  }
  if (lines.length) {
    console.log(`\n${rel}`);
    console.log(lines.join('\n'));
  }
}

function cmdVersion(args) {
  const to = valueOf(args, '--to');
  const dryRun = args.includes('--dry-run');
  const from = currentVersion();
  if (!to) {
    console.error('缺少 --to <版本号>，例如 --to 1.1.9');
    return 1;
  }
  if (!SEMVER.test(to)) {
    console.error(`版本号格式非法：${to}（应为 x.y.z）`);
    return 1;
  }
  if (from === to) {
    console.log(`当前版本已是 ${to}，无需改动。`);
    return 0;
  }
  console.log(`版本升级：${from} → ${to}${dryRun ? '（dry-run，不写盘）' : ''}`);

  let touched = 0;
  for (const t of TARGETS) {
    const { changed, before, after } = rewrite(t.file, t.kind, from, to);
    if (!changed) {
      console.log(`  - ${t.file}：未命中（可能已同步）`);
      continue;
    }
    printDiff(t.file, before, after);
    if (!dryRun) writeFileSync(path.join(ROOT, t.file), after, 'utf8');
    touched += 1;
  }
  console.log(`\n共 ${touched} 个文件${dryRun ? '待修改' : '已修改'}。`);
  if (!dryRun) {
    console.log('下一步：更新 CHANGELOG.md 顶部版本段落，然后运行 check 校验。');
  }
  return 0;
}

/**
 * 产物文件名的版本号捕获。
 *
 * 必须锚定到「扩展名之前」的边界：`NeoMD-1.1.9.apk` 若用宽松的 `([\d.]+)`
 * 会连扩展名的点一起吃进去，捕获成 `1.1.9.`（末尾多一个点）——校验因此假失败。
 * 这里要求版本号后面紧跟 `-` 或 `.` + 扩展名，且版本号本身只允许数字与点。
 */
const ARTIFACT_VERSION_RE = /NeoMD-(\d+(?:\.\d+)*?)(?=-|\.(?:apk|exe|zip|dmg|msi))/;

/** 「产物名由 package.json 动态推导」的特征（比硬编码更稳，应判通过） */
const DYNAMIC_VERSION_RE = /\$\{version\}|\$\{pkg\.version\}|pkg\.version|readFileSync\([^)]*package\.json/;

/**
 * 去掉源码注释，只留下「真正会参与构建的代码」。
 *
 * 为什么需要这一步：1.2.0 起 `apps/desktop/build.mjs` 已改为从 package.json
 * 读版本，但在 JSDoc 里留了一句「早先这里硬编码成 `NeoMD-1.1.9-win-x64.zip`」
 * 的历史说明。校验若直接对全文正则，会把这句**注释**当成「还没升级的硬编码」
 * 而误报失败——门禁一旦出现假阳性，就会被习惯性忽略，等于门禁失效。
 *
 * 实现：逐行处理。整行注释（`//` / `*` / `/*` 开头）丢弃，块注释状态跟踪；
 * 行尾 `//` 仅在「前一个是空白」时截断，从而不误伤 `https://` 这类 URL。
 */
function stripComments(text) {
  const out = [];
  let inBlock = false;
  for (const rawLine of text.split('\n')) {
    let line = rawLine;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlock = false;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      if (trimmed.startsWith('/*') && !trimmed.includes('*/')) inBlock = true;
      continue;
    }
    const slash = line.indexOf('//');
    if (slash > 0 && /\s/.test(line[slash - 1])) line = line.slice(0, slash);
    out.push(line);
  }
  return out.join('\n');
}

/** 校验全仓库版本一致性（发布前门禁） */
function cmdCheck() {
  const expected = currentVersion();
  console.log(`以根 package.json 为准：${expected}`);
  let bad = 0;
  for (const t of TARGETS) {
    const text = read(t.file);
    let found = '';
    let note = '';
    if (t.kind === 'package-json') {
      found = JSON.parse(text).version ?? '';
    } else if (t.kind === 'env-version') {
      found = /APP_VERSION\s*=\s*'([\d.]+)'/.exec(text)?.[1] ?? '';
    } else if (t.kind === 'artifact-name') {
      // 先剥注释再匹配：注释里的历史版本号不应该触发失败
      const code = stripComments(text);
      found = ARTIFACT_VERSION_RE.exec(code)?.[1] ?? '';
      if (!found && DYNAMIC_VERSION_RE.test(code)) {
        note = '（从 package.json 动态推导，无硬编码）';
        found = expected;
      }
    }
    const ok = found === expected;
    if (!ok) bad += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${t.file}：${found || '(未找到)'}${note}`);
  }
  // CHANGELOG 顶部段落必须与版本一致
  const changelog = read('CHANGELOG.md');
  const top = /^##\s*\[([\d.]+)\]/m.exec(changelog)?.[1] ?? '';
  const clOk = top === expected;
  if (!clOk) bad += 1;
  console.log(`  ${clOk ? '✓' : '✗'} CHANGELOG.md 顶部段落：${top || '(未找到)'}`);

  if (bad) {
    console.error(`\n${bad} 处不一致，禁止发布。`);
    return 1;
  }
  console.log('\n版本一致性校验通过。');
  return 0;
}

/** 从 CHANGELOG 抽取指定版本的段落，用作 GitHub Release body */
function cmdNotes(args) {
  const version = valueOf(args, '--version') ?? currentVersion();
  const changelog = read('CHANGELOG.md');
  /*
   * 段落边界：从 `## [<ver>]` 到**下一个** `## [` 之前。
   * 注意不能用 `[\d.]` 之类宽匹配来定位结束，版本号里的点是元字符；
   * 这里用「下一个二级标题」作为唯一终止条件，简单且不会误判。
   */
  const startRe = new RegExp(`^##\\s*\\[${escapeRe(version)}\\][^\\n]*$`, 'm');
  const start = startRe.exec(changelog);
  if (!start) {
    console.error(`CHANGELOG 中找不到版本 ${version} 的段落。`);
    return 1;
  }
  const from = start.index + start[0].length;
  const rest = changelog.slice(from);
  const nextIdx = rest.search(/^##\s*\[/m);
  let body = (nextIdx >= 0 ? rest.slice(0, nextIdx) : rest).trim();
  // 去掉段落末尾的分隔线，避免 Release body 里出现孤立的 `---`
  body = body.replace(/\n+---\s*$/, '').trim();
  if (!body) {
    console.error(`版本 ${version} 的段落内容为空。`);
    return 1;
  }
  const out = path.resolve(ROOT, valueOf(args, '--out') ?? `.release-notes-${version}.md`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${body}\n`, 'utf8');
  console.log(`已写入 ${path.relative(ROOT, out)}（${body.length} 字符）`);
  return 0;
}

function valueOf(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const [cmd, ...rest] = process.argv.slice(2);
const handlers = { version: cmdVersion, check: cmdCheck, notes: cmdNotes };
const fn = handlers[cmd];
if (!fn) {
  console.log('用法：');
  console.log('  node tools/release-119.mjs version --to 1.1.9 [--dry-run]');
  console.log('  node tools/release-119.mjs check');
  console.log('  node tools/release-119.mjs notes [--version 1.2.0] [--out 路径]');
  process.exit(cmd ? 1 : 0);
}
process.exit(fn(rest));
