#!/usr/bin/env node
/**
 * GitHub 发布结果验收（1.1.9 起，适用于任何版本）。
 *
 * ## 为什么需要它
 *
 * 发布链路上最容易出错的地方不是「命令报错」，而是**命令都成功了但同步结果不对**：
 *  - 推错了分支（推了 neomd-v1-migration，main 还是旧 Tauri 项目）；
 *  - tag 打在了上一个 commit 上（比 main 落后一格）；
 *  - Release 建了但 body 是上一次的模板（CHANGELOG 段落没更新）；
 *  - 资产上传了但是上一次构建的旧包（同版本重发时最常见）。
 *
 * 这些错误在命令行里全都是「成功」。因此发布后必须**用 GitHub API 反过来读一遍**，
 * 拿「远端实际状态」和「本地期望值」逐条比对，全部对上才算发布完成。
 *
 * ## 用法
 *
 *   # 验收 1.2.0（默认读根 package.json 的 version）
 *   node tools/verify-119-github.mjs --version=1.2.0
 *
 *   # 额外要求 Release body 必须含某些关键条目
 *   node tools/verify-119-github.mjs --version=1.2.0 --expect="Failed to fetch,绿色版"
 *
 *   # 只校验代码/标签、不校验 Release 与资产（代码先推、Release 后建的场景）
 *   node tools/verify-119-github.mjs --version=1.2.0 --code-only
 *
 * ## 代理与凭据（本项目硬性要求）
 *
 * 访问 GitHub 必须走本地代理 `http://127.0.0.1:1886`（无鉴权）。Node 原生 fetch
 * （undici）**不读** HTTPS_PROXY 环境变量，但 Node 24 提供了内置开关
 * `NODE_USE_ENV_PROXY=1`：置为 1 后 undici 会按 HTTPS_PROXY/HTTP_PROXY/NO_PROXY 走代理。
 * 这是零依赖即可让 fetch 走代理的官方方式（undici 不随 Node 暴露为可 import 模块，
 * 直接 `import { ProxyAgent } from 'undici'` 实测 ERR_MODULE_NOT_FOUND）。
 *
 * Token 只在**运行时**从环境变量或 `git credential fill` 取，绝不写文件、绝不打印。
 * 读取用 AE（私有仓库也要能读），本脚本全程只发 GET，不产生任何远端变更。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.github.com';
/** 本项目固定代理：GitHub 直连不通，必须经它出去 */
const DEFAULT_PROXY = 'http://127.0.0.1:1886';

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

/** 取值型参数：同时支持 `--key=value` 与 `--key value` 两种写法 */
const VALUE_FLAGS = new Set(['version', 'repo', 'proxy', 'expect', 'artifacts', 'legacy-branch']);
/** 纯开关型参数：带 `=` 反而是写错了，要报出来 */
const BOOL_FLAGS = new Set(['no-proxy', 'code-only', 'help', 'h']);

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  /** 无法识别的参数：**必须报出来**，不能静默忽略 */
  const unknown = [];
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const body = raw.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      const key = body.slice(0, eq);
      if (!VALUE_FLAGS.has(key)) {
        // 例如 `--code-only=1`、`--coode-only`：静默接受会让「你以为开了某个开关、其实没开」
        unknown.push(raw);
        continue;
      }
      values.set(key, body.slice(eq + 1));
      continue;
    }
    // `--version 1.2.0`：docs/RELEASE-119.md 里就是这么写的，必须兼容，
    // 否则版本号会静默回落到 package.json，验收对象悄悄换掉
    if (VALUE_FLAGS.has(body) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      values.set(body, argv[i + 1]);
      i += 1;
      continue;
    }
    // 取值型参数后面没跟值（如 `--version` 单独出现）：同样不能静默忽略
    if (VALUE_FLAGS.has(body)) {
      unknown.push(`${raw}（缺少取值）`);
      continue;
    }
    if (!BOOL_FLAGS.has(body)) unknown.push(raw);
    flags.add(body);
  }
  return {
    unknown,
    version: values.get('version') || '',
    repo: values.get('repo') || '',
    proxy: values.get('proxy') || '',
    noProxy: flags.has('no-proxy'),
    codeOnly: flags.has('code-only'),
    expect: (values.get('expect') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    artifactsDir: values.get('artifacts') || 'dist-artifacts',
    legacyBranch: values.get('legacy-branch') || 'legacy-tauri',
    help: flags.has('help') || flags.has('h'),
  };
}

const USAGE = `Neo MD —— GitHub 发布结果验收

用法：
  node tools/verify-119-github.mjs [选项]

选项：
  --version=1.2.0      要验收的版本（默认读根 package.json 的 version）
  --repo=owner/repo    GitHub 仓库（默认读 package.json 的 repository）
  --proxy=URL          代理地址（默认 ${DEFAULT_PROXY}）
  --no-proxy           强制直连（CI 环境用；本地直连 GitHub 会失败）
  --expect="a,b"       Release body 必须额外包含的关键字（逗号分隔）
  --artifacts=目录     本地产物目录（默认 dist-artifacts，用于核对资产大小）
  --legacy-branch=名字 旧 Tauri 代码所在分支（默认 legacy-tauri，仅提示不强制）
  --code-only          只验收「代码已同步 + tag 正确」，跳过 Release 与资产
  --help               显示本帮助

环境变量：
  GITHUB_TOKEN         可选。未设置时自动用 git credential fill 读取（不落盘、不打印）。
  HTTPS_PROXY/HTTP_PROXY  可选。未设置时回落到本项目固定代理。

退出码：0 = 全部通过；1 = 有失败项（逐条列出）。
`;

/* ------------------------------------------------------------------ */
/* 代理：零依赖让 Node 24 的 fetch 走代理                               */
/* ------------------------------------------------------------------ */

function applyProxy(args) {
  if (args.noProxy) {
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NODE_USE_ENV_PROXY']) delete process.env[k];
    return { url: '', source: '命令行 --no-proxy（强制直连）' };
  }
  const url = args.proxy || (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim() || DEFAULT_PROXY;
  process.env.HTTPS_PROXY = url;
  process.env.HTTP_PROXY = url;
  // 关键：Node 24 内置开关，置 1 后 undici 才会按上面两个变量走代理
  process.env.NODE_USE_ENV_PROXY = '1';
  const source = args.proxy
    ? '命令行 --proxy'
    : (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) && !args.proxy
      ? '环境变量'
      : '项目默认代理';
  return { url, source };
}

/** TCP 探活代理端口，把「代理没启动」这种最常见故障说清楚 */
async function probeProxy(url) {
  if (!url) return { ok: true, detail: '未启用代理' };
  const u = new URL(url);
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  const { Socket } = await import('node:net');
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, detail });
    };
    socket.setTimeout(3000);
    socket.once('connect', () => done(true, `${u.hostname}:${port} 可连通`));
    socket.once('timeout', () => done(false, `${u.hostname}:${port} 连接超时`));
    socket.once('error', (e) => done(false, `${u.hostname}:${port} 连接失败：${e.code || e.message}`));
    socket.connect(port, u.hostname);
  });
}

/* ------------------------------------------------------------------ */
/* 凭据：运行时读取，绝不落盘/打印                                      */
/* ------------------------------------------------------------------ */

/**
 * 取 token：优先环境变量，其次 `git credential fill`。
 *
 * 之所以走 credential helper：token 已在 Windows 凭据管理器里，硬编码或写文件都会
 * 造成永久泄露（本仓库有硬编码凭据被清理的历史）。进程内传递是唯一安全方式。
 */
function readToken() {
  const envToken = (process.env.GITHUB_TOKEN || '').trim();
  if (envToken) return { token: envToken, source: '环境变量 GITHUB_TOKEN' };

  const res = spawnSync('git', ['credential', 'fill'], {
    cwd: ROOT,
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    return { token: '', source: `git credential fill 失败（exit ${res.status}）：${(res.stderr || '').trim().slice(0, 200)}` };
  }
  const line = (res.stdout || '')
    .split(/\r?\n/)
    .find((l) => l.startsWith('password='));
  const token = line ? line.slice('password='.length).trim() : '';
  return { token, source: 'git credential fill（Windows 凭据管理器）' };
}

/* ------------------------------------------------------------------ */
/* GitHub API 封装                                                     */
/* ------------------------------------------------------------------ */

let TOKEN = '';
/** owner/repo，供资产探测等辅助函数复用（main 里赋值） */
let OWNER_REPO = '';

/**
 * 发一个 GitHub API 请求。404 不抛异常（由调用方判定「不存在」），
 * 其余非 2xx 抛出带修复建议的错误。
 */
async function gh(apiPath, { accept = 'application/vnd.github+json' } = {}) {
  const url = apiPath.startsWith('http') ? apiPath : `${API}${apiPath}`;
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${TOKEN}`,
        'User-Agent': 'neomd-verify-github',
      },
    });
  } catch (e) {
    // fetch 的网络层失败不带 URL，这里必须自己补上，否则又是一句无从下手的提示
    throw new Error(
      `无法连接 GitHub API（${url}）：${e instanceof Error ? e.message : String(e)}\n` +
        '→ 本机访问 GitHub 必须走代理。请确认代理已启动，并让 Node 走代理：\n' +
        `   PowerShell: $env:NODE_USE_ENV_PROXY='1'; $env:HTTPS_PROXY='${DEFAULT_PROXY}'\n` +
        `   bash:       NODE_USE_ENV_PROXY=1 HTTPS_PROXY=${DEFAULT_PROXY} node tools/verify-119-github.mjs`,
    );
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok && res.status !== 404) {
    const detail = json?.message ?? text.slice(0, 200);
    throw new Error(`GitHub API ${url} 失败：HTTP ${res.status} ${detail}`);
  }
  return { status: res.status, json, headers: res.headers };
}

/* ------------------------------------------------------------------ */
/* 本地工具                                                            */
/* ------------------------------------------------------------------ */

/**
 * 探测一个 Release 资产是否「用户点得动」。
 *
 * 用 redirect:'manual' 只取第一跳：GitHub 对 Accept: application/octet-stream
 * 返回 302 + 预签名地址，拿到 302 就足以证明该资产可下载，且**不会**把
 * 上百 MB 的包读进内存（验收脚本不该产生这种副作用）。
 */
async function probeAssetRedirect(assetId) {
  const ownerRepo = OWNER_REPO;
  const url = `${API}/repos/${ownerRepo}/releases/assets/${assetId}`;
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      Accept: 'application/octet-stream',
      Authorization: `Bearer ${TOKEN}`,
      'User-Agent': 'neomd-verify-github',
    },
  });
  if (res.status === 302 || res.status === 301) {
    const location = res.headers.get('location') || '';
    const host = location ? new URL(location).host : '(无 location)';
    return { ok: true, detail: `HTTP ${res.status} → 预签名跳转 ${host}` };
  }
  if (res.status === 200) return { ok: true, detail: 'HTTP 200（直出）' };
  return { ok: false, detail: `HTTP ${res.status}` };
}

function readJson(rel) {
  return JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
}

function parseRepoField(repository) {
  const raw = typeof repository === 'string' ? repository : (repository?.url ?? '');
  const cleaned = String(raw)
    .replace(/^git\+/, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(cleaned);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从 CHANGELOG 里取某版本的段落（与 release-119.mjs notes 完全同源） */
function changelogSection(version) {
  const changelog = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const start = new RegExp(`^##\\s*\\[${escapeRe(version)}\\][^\\n]*$`, 'm').exec(changelog);
  if (!start) return null;
  const rest = changelog.slice(start.index + start[0].length);
  const nextIdx = rest.search(/^##\s*\[/m);
  return (nextIdx >= 0 ? rest.slice(0, nextIdx) : rest).replace(/\n+---\s*$/, '').trim();
}

/** 段落里的小标题（### Fixed / ### Added …），Release body 必须原样带上 */
function sectionHeadings(section) {
  const out = [];
  for (const line of section.split(/\r?\n/)) {
    const m = /^###\s+(.+?)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 断言收集                                                            */
/* ------------------------------------------------------------------ */

const results = [];
function pass(name, detail = '') {
  results.push({ ok: true, name, detail });
  console.log(`  ✓ ${name}${detail ? `：${detail}` : ''}`);
}
function fail(name, detail = '') {
  results.push({ ok: false, name, detail });
  console.log(`  ✗ ${name}${detail ? `：${detail}` : ''}`);
}
function warn(name, detail = '') {
  results.push({ ok: true, warn: true, name, detail });
  console.log(`  ! ${name}${detail ? `：${detail}` : ''}`);
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return `${n}`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  /*
   * 未识别的参数必须**中止**，不能忽略。
   *
   * 教训来自一个真实的坑：文档里写 `--version 1.1.9`（空格），而脚本早期只认
   * `--version=1.1.9`（等号），于是空格写法被静默丢弃、版本号回落到
   * package.json——**你以为在验 1.1.9，实际验的是另一个版本，而且全绿**。
   * 这类「不报错、结果看起来正常、但验的不是你以为的东西」的缺陷，
   * 比直接报错危险得多，因此这里选择硬失败。
   */
  if (args.unknown.length) {
    console.error('无法识别的参数：');
    for (const u of args.unknown) console.error(`  · ${u}`);
    console.error('\n验收对象可能因此不是你预期的那一个，已中止。用法见 --help。');
    return 1;
  }

  const pkg = readJson('package.json');
  const version = (args.version || pkg.version || '').trim();
  if (!version) {
    console.error('无法确定版本号：package.json 没有 version，也没有传 --version。');
    return 1;
  }
  const repoParts = args.repo ? /^([\w.-]+)\/([\w.-]+)$/.exec(args.repo) : parseRepoField(pkg.repository);
  if (!repoParts) {
    console.error('无法解析仓库标识，请用 --repo=owner/repo。');
    return 1;
  }
  const { owner, repo } = repoParts;
  const tag = `v${version}`;

  const proxy = applyProxy(args);
  const probe = await probeProxy(proxy.url);
  const { token, source: tokenSource } = readToken();

  console.log('══════════════════════════════════════════════════════');
  console.log(' Neo MD —— GitHub 发布验收');
  console.log('══════════════════════════════════════════════════════');
  console.log(`版本      : ${version}（tag ${tag}）`);
  console.log(`仓库      : ${owner}/${repo}`);
  console.log(`代理      : ${proxy.url || '（直连）'}  探活 ${probe.ok ? '✓' : '✗'} ${probe.detail}`);
  console.log(`凭据      : ${token ? `已获取（${tokenSource}，长度 ${token.length}）` : `未获取（${tokenSource}）`}`);
  console.log('');

  if (!probe.ok) {
    console.error('代理不可用，无法访问 GitHub。请先启动本地代理后重试。');
    return 1;
  }
  if (!token) {
    console.error('无法获取 token，验收需要读私有 API。请设置 GITHUB_TOKEN 或确认 git credential 已存 GitHub 凭据。');
    return 1;
  }
  TOKEN = token;
  OWNER_REPO = `${owner}/${repo}`;

  /* ---------- 1. 仓库可读 ---------- */
  console.log('── 1. 仓库可读 ───────────────────────────────────────');
  const repoInfo = await gh(`/repos/${owner}/${repo}`);
  if (repoInfo.status === 200) pass('仓库 API 可读', `${repoInfo.json.full_name}（private=${repoInfo.json.private}）`);
  else fail('仓库 API 可读', `HTTP ${repoInfo.status}`);

  /* ---------- 2. main 分支与代码内容 ---------- */
  console.log('\n── 2. main 分支内容 ──────────────────────────────────');
  const mainBranch = await gh(`/repos/${owner}/${repo}/branches/main`);
  const mainSha = mainBranch.json?.commit?.sha ?? '';
  if (mainSha) pass('main 分支存在', `HEAD = ${mainSha.slice(0, 7)}「${(mainBranch.json.commit.commit.message || '').split('\n')[0]}」`);
  else fail('main 分支存在', `HTTP ${mainBranch.status}`);

  if (mainSha) {
    // 顶层 tree 必须同时有 pnpm-workspace.yaml 与 apps/web，
    // 这正是「远端正本到底是不是 monorepo」的判据（历史无关问题就表现在这里）
    const tree = await gh(`/repos/${owner}/${repo}/git/trees/${mainSha}`);
    const entries = tree.json?.tree ?? [];
    const names = new Set(entries.map((e) => e.path));
    for (const required of ['pnpm-workspace.yaml', 'apps', 'package.json']) {
      if (names.has(required)) pass(`main 树包含 ${required}`);
      else fail(`main 树包含 ${required}`, '远端 main 不是 monorepo 内容');
    }

    /*
     * `apps/web` 是二级路径，顶层 tree 里只有 `apps`。
     * 必须再取一层 apps 的 tree 才能真正证明 Web 应用在远端——
     * 这正是「远端 main 到底是不是 monorepo」最关键的一条证据。
     */
    const appsEntry = entries.find((e) => e.path === 'apps' && e.type === 'tree');
    if (!appsEntry) {
      fail('main 树包含 apps/web', '顶层没有 apps 目录');
    } else {
      const appsTree = await gh(`/repos/${owner}/${repo}/git/trees/${appsEntry.sha}`);
      const appDirs = new Set((appsTree.json?.tree ?? []).map((e) => e.path));
      for (const required of ['web', 'desktop']) {
        if (appDirs.has(required)) pass(`main 树包含 apps/${required}`);
        else fail(`main 树包含 apps/${required}`, 'apps 下缺少该子项目');
      }
    }
    // 顺带确认「不是旧 Tauri 项目」——这两个目录只应存在于 legacy-tauri
    const tauriOnly = ['src-tauri', 'build.ps1'].filter((p) => names.has(p));
    if (tauriOnly.length) warn('main 树仍含旧 Tauri 目录', tauriOnly.join('、'));
    else pass('main 树不含旧 Tauri 目录', 'src-tauri / build.ps1 均不存在');

    // main 上的 package.json 版本必须是本次要发布的版本
    const pkgFile = await gh(`/repos/${owner}/${repo}/contents/package.json?ref=main`);
    if (pkgFile.status === 200 && pkgFile.json?.content) {
      const remotePkg = JSON.parse(Buffer.from(pkgFile.json.content, 'base64').toString('utf8'));
      if (remotePkg.version === version) pass('main 上的 package.json 版本', remotePkg.version);
      else fail('main 上的 package.json 版本', `远端 ${remotePkg.version} ≠ 期望 ${version}`);
    } else {
      fail('main 上的 package.json 版本', `HTTP ${pkgFile.status}`);
    }
  }

  /* ---------- 3. legacy-tauri 分支（历史保留） ---------- */
  console.log('\n── 3. 历史保留 ───────────────────────────────────────');
  const legacy = await gh(`/repos/${owner}/${repo}/branches/${encodeURIComponent(args.legacyBranch)}`);
  if (legacy.status === 200) pass(`${args.legacyBranch} 分支存在`, legacy.json.commit.sha.slice(0, 7));
  else warn(`${args.legacyBranch} 分支不存在`, '旧 Tauri 代码将只能通过 commit 哈希找回');

  /* ---------- 4. tag 指向 main 最新提交 ---------- */
  console.log('\n── 4. tag ────────────────────────────────────────────');
  const tagRef = await gh(`/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (tagRef.status !== 200) {
    fail(`tag ${tag} 存在`, '未找到该 tag（可能还没推送）');
  } else {
    let tagSha = tagRef.json.object.sha;
    // annotated tag 的 ref 指向 tag 对象，需要再解一层才拿到 commit
    if (tagRef.json.object.type === 'tag') {
      const tagObj = await gh(`/repos/${owner}/${repo}/git/tags/${tagSha}`);
      tagSha = tagObj.json?.object?.sha ?? tagSha;
    }
    if (mainSha && tagSha === mainSha) pass(`tag ${tag} 指向 main 最新提交`, tagSha.slice(0, 7));
    else fail(`tag ${tag} 指向 main 最新提交`, `tag → ${tagSha.slice(0, 7)}，main → ${mainSha.slice(0, 7)}`);
  }

  if (args.codeOnly) {
    return summarize({ version, tag, codeOnly: true });
  }

  /* ---------- 5. Release 与 body ---------- */
  console.log('\n── 5. Release ────────────────────────────────────────');
  const rel = await gh(`/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  let release = null;
  if (rel.status === 200) {
    release = rel.json;
    pass(`Release ${tag} 存在`, `id=${release.id}${release.draft ? '（草稿）' : ''}`);
    if (release.draft) fail(`Release ${tag} 非草稿`, '当前是 draft，用户看不到');
  } else {
    fail(`Release ${tag} 存在`, `HTTP ${rel.status}`);
  }

  const section = changelogSection(version);
  if (!section) {
    fail('CHANGELOG 含该版本段落', `CHANGELOG.md 里找不到 ## [${version}]`);
  } else if (release) {
    const body = release.body || '';
    // 小标题（Fixed/Added/Changed/Security…）必须原样出现在 body 里：
    // 这是「Release 说明来自 CHANGELOG 而不是上一次的模板」最直接的证据
    const headings = sectionHeadings(section);
    const missingHeadings = headings.filter((h) => !body.includes(h));
    if (headings.length && !missingHeadings.length) pass('Release body 含 CHANGELOG 全部小标题', headings.join(' / '));
    else if (headings.length) fail('Release body 含 CHANGELOG 全部小标题', `缺少：${missingHeadings.join('、')}`);
    else warn('Release body 小标题校验', 'CHANGELOG 段落没有 ### 小标题，跳过');

    if (args.expect.length) {
      const missing = args.expect.filter((k) => !body.includes(k));
      if (!missing.length) pass('Release body 含指定关键字', args.expect.join('、'));
      else fail('Release body 含指定关键字', `缺少：${missing.join('、')}`);
    }
  }

  /* ---------- 6. 资产：存在 + 大小 + 可下载 ---------- */
  console.log('\n── 6. Release 资产 ───────────────────────────────────');
  const artifactsDir = path.resolve(ROOT, args.artifactsDir);
  // 期望资产 = 本地真实存在的产物（绿色版 zip、安装包，有 APK 才算 APK）
  const expectedFiles = [
    `NeoMD-${version}-win-x64.zip`,
    `NeoMD-${version}-setup.exe`,
    `NeoMD-${version}.apk`,
  ].filter((f) => existsSync(path.join(artifactsDir, f)));

  if (!expectedFiles.length) {
    warn('本地无产物可核对', `在 ${artifactsDir} 里没找到 ${version} 的产物，跳过资产校验`);
    console.log('  （若这是「只同步更新记录、不发安装包」的发布，属预期情况）');
  } else if (release) {
    const assets = release.assets?.length
      ? (await gh(`/repos/${owner}/${repo}/releases/${release.id}/assets?per_page=100`)).json ?? []
      : [];
    const byName = new Map(assets.map((a) => [a.name, a]));

    for (const file of expectedFiles) {
      const localSize = statSync(path.join(artifactsDir, file)).size;
      const asset = byName.get(file);
      if (!asset) {
        fail(`资产 ${file} 存在`, 'Release 里没有该文件');
        continue;
      }
      if (asset.size === localSize) pass(`资产 ${file} 大小一致`, formatBytes(asset.size));
      else fail(`资产 ${file} 大小一致`, `远端 ${asset.size} B ≠ 本地 ${localSize} B（可能是上一次构建的旧包）`);
    }

    // 真正证明「用户能下载」：资产接口对 Accept: octet-stream 会 302 到对象存储的
    // 预签名地址。这里用 redirect:'manual' 只读这一跳，**不跟随**——否则会把
    // 151MB 的包整个下载进内存，验收脚本变成压测。
    for (const file of expectedFiles) {
      const asset = byName.get(file);
      if (!asset) continue;
      try {
        const probeRes = await probeAssetRedirect(asset.id);
        if (probeRes.ok) pass(`资产 ${file} 可下载`, probeRes.detail);
        else fail(`资产 ${file} 可下载`, probeRes.detail);
      } catch (e) {
        fail(`资产 ${file} 可下载`, e instanceof Error ? e.message.split('\n')[0] : String(e));
      }
    }

    // 反向检查：不该有的资产别混进来（本项目无自动更新，blockmap 无用）
    const unexpected = assets.filter((a) => a.name.endsWith('.blockmap')).map((a) => a.name);
    if (unexpected.length) warn('Release 含 blockmap 资产', `${unexpected.join('、')}（本项目无自动更新，可删除）`);
  }

  return summarize({ version, tag, release });
}

function summarize({ version, tag, release, codeOnly = false }) {
  const failed = results.filter((r) => !r.ok);
  const warned = results.filter((r) => r.warn);
  console.log('');
  console.log('══════════════════════════════════════════════════════');
  console.log(failed.length ? ' ✗ 验收未通过' : ' ✓ 验收通过');
  console.log('══════════════════════════════════════════════════════');
  console.log(`版本 ${version} / tag ${tag}：${results.length - failed.length} 项通过，${failed.length} 项失败${warned.length ? `，${warned.length} 项提示` : ''}`);
  if (codeOnly) console.log('（--code-only：已跳过 Release 与资产校验）');
  if (release?.html_url) console.log(`Release 页面：${release.html_url}`);
  if (failed.length) {
    console.log('');
    console.log('失败项：');
    for (const f of failed) console.log(`  · ${f.name}：${f.detail}`);
    console.log('');
    console.log('回滚参考：docs/RELEASE-120.md 的「回滚」一节。');
    return 1;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error('');
    console.error('✗ 验收脚本异常：');
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
