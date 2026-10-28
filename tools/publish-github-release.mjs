#!/usr/bin/env node
/**
 * Neo MD —— GitHub Release 发布脚本
 *
 * 一条命令完成「版本发布 + 更新记录同步到 GitHub Releases」：
 *   1. 从 package.json 读版本号（可用 --version 覆盖）；
 *   2. 从 CHANGELOG.md 提取该版本对应的段落作为 Release 说明（body）；
 *   3. 创建或更新 GitHub Release（tag = v<版本号>）；
 *   4. 上传三端安装产物（Windows 安装包 / Windows 免安装包 / Android APK）。
 *
 * 设计约束：
 * - **不引入任何第三方依赖**，只用 Node 24 原生能力（fetch / fs / path）。
 * - **Token 只从环境变量 `GITHUB_TOKEN` 读取，绝不写死在代码或配置文件里。**
 * - 幂等：Release 已存在则更新说明；同名资产先删除再上传，可反复执行。
 * - 支持 `--dry-run`：只打印将要做什么，不发出任何网络请求。
 *
 * 用法：
 *   # 只演练，不联网（推荐先跑这个）
 *   node tools/publish-github-release.mjs --dry-run
 *
 *   # 真正发布（需要 GITHUB_TOKEN 与仓库标识）
 *   set GITHUB_TOKEN=ghp_xxx          # Windows PowerShell: $env:GITHUB_TOKEN="ghp_xxx"
 *   set GITHUB_REPO=owner/repo
 *   node tools/publish-github-release.mjs
 *
 *   # 只同步 Release 说明、不上传安装包
 *   node tools/publish-github-release.mjs --skip-assets
 *
 *   # 发布为草稿 / 预发布
 *   node tools/publish-github-release.mjs --draft
 *   node tools/publish-github-release.mjs --prerelease
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ */
/* 基础路径与常量                                                      */
/* ------------------------------------------------------------------ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

/** GitHub REST API 主机 */
const API_HOST = 'https://api.github.com';
/** 资产上传专用主机（与 API 主机不同，大文件必须走它） */
const UPLOAD_HOST = 'https://uploads.github.com';

/** 三端产物在 dist-artifacts 下的文件名模板（与 electron-builder / gradle 输出保持一致） */
const ARTIFACT_TEMPLATES = [
  { kind: 'win-installer', template: (v) => `NeoMD-${v}-setup.exe`, label: 'Windows 安装包' },
  { kind: 'win-portable', template: (v) => `NeoMD-${v}-win-x64.zip`, label: 'Windows 免安装包' },
  { kind: 'android', template: (v) => `NeoMD-${v}.apk`, label: 'Android 安装包' },
];

/**
 * 可选附属文件：electron-updater 的增量更新需要 .blockmap，
 * 缺失不算失败（有些构建不会产出），存在就顺手一起传。
 */
const OPTIONAL_TEMPLATES = [{ kind: 'win-installer-map', template: (v) => `NeoMD-${v}-setup.exe.blockmap`, label: 'Windows 增量更新索引' }];

/* ------------------------------------------------------------------ */
/* 命令行参数解析                                                      */
/* ------------------------------------------------------------------ */

/** 解析 `--key=value` / `--flag` 形式的参数 */
function parseArgs(argv) {
  const out = { flags: new Set(), values: new Map() };
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const body = raw.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) {
      out.flags.add(body);
    } else {
      out.values.set(body.slice(0, eq), body.slice(eq + 1));
    }
  }
  return {
    dryRun: out.flags.has('dry-run'),
    draft: out.flags.has('draft'),
    prerelease: out.flags.has('prerelease'),
    skipAssets: out.flags.has('skip-assets'),
    help: out.flags.has('help') || out.flags.has('h'),
    versionOverride: out.values.get('version') ?? '',
    tagOverride: out.values.get('tag') ?? '',
    repoOverride: out.values.get('repo') ?? '',
    artifactsDir: out.values.get('artifacts') ?? '',
    changelogPath: out.values.get('changelog') ?? '',
    proxyOverride: out.values.get('proxy') ?? '',
    noProxy: out.flags.has('no-proxy'),
    allVersions: out.flags.has('all-versions'),
  };
}

const USAGE = `Neo MD GitHub Release 发布脚本

用法：
  node tools/publish-github-release.mjs [选项]

选项：
  --dry-run            只打印将要执行的操作，不发出任何网络请求（不需要 token）
  --version=1.1.7      指定版本号（默认读 package.json 的 version）
  --tag=v1.1.7         指定 git tag（默认 v<版本号>）
  --repo=owner/repo    指定 GitHub 仓库（默认读环境变量 GITHUB_REPO 或 package.json 的 repository）
  --artifacts=目录     产物目录（默认 <仓库根>/dist-artifacts）
  --changelog=路径     CHANGELOG 路径（默认 <仓库根>/CHANGELOG.md）
  --proxy=URL          指定代理，如 http://127.0.0.1:1886（默认读 HTTPS_PROXY/HTTP_PROXY，都没有则用本项目固定代理）
  --no-proxy           强制不走代理（内网/已配置全局代理时用）
  --all-versions       为 CHANGELOG 里所有版本批量创建/更新 Release（不含产物）
  --draft              发布为草稿
  --prerelease         标记为预发布
  --skip-assets        只同步 Release 说明，不上传安装包
  --help               显示本帮助

环境变量：
  GITHUB_TOKEN         必填（真实发布时）。需要 public_repo 或 repo 权限。
  GITHUB_REPO          可选，形如 owner/repo；未设置时读 package.json 的 repository 字段。
  HTTPS_PROXY / HTTP_PROXY
                       代理地址。本项目固定要求走 http://127.0.0.1:1886，
                       两者都未设置时自动回落到该地址。
`;

/* ------------------------------------------------------------------ */
/* 代理支持                                                            */
/* ------------------------------------------------------------------ */

/**
 * 本项目固定要求的默认代理（访问 GitHub 必须走它）。
 * 该地址是本地 mixed/http 代理，无鉴权，不含任何凭据。
 */
const DEFAULT_PROXY = 'http://127.0.0.1:1886';

/**
 * 解析最终生效的代理地址。
 *
 * 优先级：`--proxy=` > `--no-proxy`（强制关闭） > `HTTPS_PROXY` > `HTTP_PROXY` > 默认值。
 *
 * 注意：`--no-proxy` 的优先级高于环境变量，用于「本机已配全局代理、
 * 不想再叠一层」的场景，避免双重代理导致 TLS 握手异常。
 */
function resolveProxy(args) {
  if (args.proxyOverride) return { url: args.proxyOverride.trim(), source: '命令行 --proxy' };
  if (args.noProxy) return { url: '', source: '命令行 --no-proxy（强制直连）' };
  const httpsProxy = (process.env.HTTPS_PROXY || process.env.https_proxy || '').trim();
  if (httpsProxy) return { url: httpsProxy, source: '环境变量 HTTPS_PROXY' };
  const httpProxy = (process.env.HTTP_PROXY || process.env.http_proxy || '').trim();
  if (httpProxy) return { url: httpProxy, source: '环境变量 HTTP_PROXY' };
  return { url: DEFAULT_PROXY, source: '项目默认代理（未设置 HTTPS_PROXY/HTTP_PROXY）' };
}

/**
 * 启用代理。
 *
 * 技术选型说明（踩过的坑）：
 * - Node 原生 `fetch`（undici）**不读取** `HTTPS_PROXY` 环境变量；
 * - `import { ProxyAgent } from 'undici'` 在本项目不可用（undici 未作为依赖安装，
 *   Node 也不暴露它为可 import 的模块，实测 ERR_MODULE_NOT_FOUND）；
 * - 因此使用 **Node 24 内置的 `NODE_USE_ENV_PROXY`** 开关：把它设为 `1` 后，
 *   undici 会按 `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` 自动走代理。
 *   实测「运行时设置 process.env 后再 fetch」即可生效，无需重启进程。
 * - 这是 Node 官方能力，**不引入任何第三方依赖**。
 *
 * 为了让 `--proxy=` 参数同样生效，这里会把解析出的地址**写回环境变量**，
 * 再由内置开关接管（这也是唯一能让 fetch 认自定义代理的零依赖方式）。
 */
function applyProxy(args) {
  const { url, source } = resolveProxy(args);

  if (!url) {
    // 强制直连：清掉环境变量与内置开关，确保没有任何代理介入
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.NODE_USE_ENV_PROXY;
    return { url: '', source, enabled: false };
  }

  // 写回环境变量（命令行 --proxy 通过这里生效）
  process.env.HTTPS_PROXY = url;
  process.env.HTTP_PROXY = url;
  // 关键：打开 Node 内置的「fetch 读取代理环境变量」开关
  process.env.NODE_USE_ENV_PROXY = '1';

  return { url, source, enabled: true };
}

/**
 * 探活代理端口，给出「代理没开」这种最常见的失败一个明确提示。
 * 只做 TCP 连接检查，不发起任何 HTTP 请求。
 */
async function probeProxy(url) {
  if (!url) return { ok: true, detail: '未启用代理' };
  let hostname = '';
  let port = 0;
  try {
    const u = new URL(url);
    hostname = u.hostname;
    port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch {
    return { ok: false, detail: `代理地址格式非法：${url}` };
  }
  return new Promise((resolve) => {
    // 用 node:net 做最小 TCP 握手，超时 3 秒
    import('node:net')
      .then(({ Socket }) => {
        const socket = new Socket();
        let settled = false;
        const done = (ok, detail) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve({ ok, detail });
        };
        socket.setTimeout(3000);
        socket.once('connect', () => done(true, `${hostname}:${port} 可连通`));
        socket.once('timeout', () => done(false, `${hostname}:${port} 连接超时（代理可能没启动）`));
        socket.once('error', (e) => done(false, `${hostname}:${port} 连接失败：${e.code || e.message}`));
        socket.connect(port, hostname);
      })
      .catch((e) => resolve({ ok: false, detail: `无法检测代理：${e.message}` }));
  });
}

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

/** 人类可读的字节数 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 读取并解析 JSON 文件 */
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * 从 `package.json` 的 `repository` 字段解析出 `owner/repo`。
 * 兼容三种写法：字符串、"github:owner/repo"、`{ type, url }` 对象。
 */
function parseRepositoryField(repository) {
  if (!repository) return '';
  const raw = typeof repository === 'string' ? repository : (repository.url ?? '');
  if (!raw) return '';
  // 去掉 github: 前缀、git+ 前缀、.git 后缀，支持 https 与 ssh 两种写法
  const cleaned = String(raw)
    .replace(/^git\+/, '')
    .replace(/^github:/, '')
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(cleaned);
  return m ? `${m[1]}/${m[2]}` : '';
}

/**
 * 从 CHANGELOG.md 提取指定版本的段落。
 *
 * 已知格式（Keep a Changelog 中文惯例）：
 *   ## [1.1.6] - 2026-10-27
 *   ...正文...
 *   ---
 *   ## [1.1.5] - ...
 *
 * 返回正文（去掉结尾多余的 `---` 分隔线），找不到时返回 null。
 */
function extractChangelogSection(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  // 版本标题行：## [x.y.z] - date，方括号与日期都可能缺省，尽量宽松
  const headingRe = /^##\s+\[?([^\]\s]+)\]?\s*(?:-\s*(.+))?$/;

  let start = -1;
  let titleLine = '';
  let releaseDate = '';

  for (let i = 0; i < lines.length; i += 1) {
    const m = headingRe.exec(lines[i]);
    if (!m) continue;
    // 跳过 [Unreleased]
    if (/^unreleased$/i.test(m[1])) continue;
    if (m[1] === version) {
      start = i;
      titleLine = lines[i];
      releaseDate = (m[2] ?? '').trim();
      break;
    }
  }
  if (start === -1) return null;

  // 收集到下一个 `## [` 之前
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+\[?[^\]\s]+\]?/.test(lines[i])) break;
    body.push(lines[i]);
  }

  // 去掉首尾空行与结尾的 `---` 分隔线
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  while (body.length && /^-{3,}\s*$/.test(body[body.length - 1])) {
    body.pop();
    while (body.length && !body[body.length - 1].trim()) body.pop();
  }

  return { titleLine, releaseDate, body: body.join('\n').trimEnd() };
}

/**
 * 在 CHANGELOG 里找「最新」的版本号（第一个非 Unreleased 的版本标题）。
 * 用于与 package.json 版本比对，提前发现「改了代码忘了写日志」。
 */
function findLatestChangelogVersion(markdown) {
  const headingRe = /^##\s+\[?([^\]\s]+)\]?/;
  for (const line of markdown.split(/\r?\n/)) {
    const m = headingRe.exec(line);
    if (!m) continue;
    if (/^unreleased$/i.test(m[1])) continue;
    return m[1];
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* GitHub API 封装                                                     */
/* ------------------------------------------------------------------ */

/** 统一的 GitHub 请求封装：自动带鉴权头、统一错误信息、限流提示 */
async function ghRequest({ method, url, token, body, contentType = 'application/json', extraHeaders = {} }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'neomd-release-script',
    ...extraHeaders,
  };
  if (body !== undefined) headers['Content-Type'] = contentType;

  const res = await fetch(url, { method, headers, body });

  // 限流与权限问题的提示要足够具体，否则用户只会看到一句 403
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.message ?? '';
      if (Array.isArray(j?.errors) && j.errors.length) {
        detail += `（${j.errors.map((e) => e.message ?? e.code ?? '').join('; ')}）`;
      }
    } catch {
      detail = (await res.text().catch(() => '')).slice(0, 300);
    }
    const remaining = res.headers.get('x-ratelimit-remaining');
    const retryAfter = res.headers.get('retry-after');
    let hint = '';
    if (res.status === 401) hint = '\n→ token 无效或已过期，请重新生成 GITHUB_TOKEN。';
    else if (res.status === 403) {
      hint = '\n→ 权限不足或触发限流。请确认 token 具备 repo（或 public_repo）权限。';
      if (remaining === '0') hint += `\n→ 当前 API 配额已用尽${retryAfter ? `，请在 ${retryAfter} 秒后重试` : ''}。`;
    } else if (res.status === 404) {
      hint = '\n→ 仓库或资源不存在。请确认 GITHUB_REPO 的 owner/repo 拼写，以及 token 是否有该仓库的访问权。';
    } else if (res.status === 422) {
      hint = '\n→ 请求参数被拒绝。常见原因：tag 已存在但格式非法，或该 Release 已有同名资产。';
    }
    throw new Error(`GitHub API ${method} ${url} 失败：HTTP ${res.status} ${detail}${hint}`);
  }

  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** 查询指定 tag 的 Release，不存在返回 null（404 视为「不存在」而非错误） */
async function findReleaseByTag({ owner, repo, tag, token }) {
  const url = `${API_HOST}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'neomd-release-script',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`查询 Release 失败：HTTP ${res.status} ${detail}`);
  }
  return res.json();
}

/** 列出某个 Release 下已上传的资产 */
async function listAssets({ owner, repo, releaseId, token }) {
  const assets = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await ghRequest({
      method: 'GET',
      url: `${API_HOST}/repos/${owner}/${repo}/releases/${releaseId}/assets?per_page=100&page=${page}`,
      token,
    });
    if (!Array.isArray(batch) || !batch.length) break;
    assets.push(...batch);
    if (batch.length < 100) break;
  }
  return assets;
}

/** 删除一个已存在的资产（幂等重传前必须删掉，否则同名会 422） */
async function deleteAsset({ owner, repo, assetId, token }) {
  await ghRequest({
    method: 'DELETE',
    url: `${API_HOST}/repos/${owner}/${repo}/releases/assets/${assetId}`,
    token,
  });
}

/**
 * 上传一个文件作为 Release 资产。
 *
 * 大文件处理：用 `fs.openAsBlob()` 交给 fetch 流式读取，
 * 避免把 150MB+ 的 zip 整个读进内存（Node 19.8+ 支持 openAsBlob）。
 */
async function uploadAsset({ owner, repo, releaseId, token, filePath, fileName }) {
  const stat = fs.statSync(filePath);
  const blob = await fs.openAsBlob(filePath);
  const url = `${UPLOAD_HOST}/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`;
  const asset = await ghRequest({
    method: 'POST',
    url,
    token,
    body: blob,
    contentType: 'application/octet-stream',
    // GitHub 上传接口要求带长度，Blob 会自动带；这里显式补一份更稳
    extraHeaders: { 'Content-Length': String(stat.size) },
  });
  return asset;
}

/* ------------------------------------------------------------------ */
/* 批量模式：为 CHANGELOG 里的所有版本创建 / 更新 Release               */
/* ------------------------------------------------------------------ */

/**
 * 列出 CHANGELOG 里所有版本号（按文件出现顺序，即从新到旧）。
 * 跳过 `[Unreleased]`。
 */
function listChangelogVersions(markdown) {
  const out = [];
  const headingRe = /^##\s+\[?([^\]\s]+)\]?(?:\s*-\s*(.+))?$/;
  for (const line of markdown.split(/\r?\n/)) {
    const m = headingRe.exec(line);
    if (!m) continue;
    const v = m[1];
    if (/^unreleased$/i.test(v)) continue;
    if (!out.some((x) => x.version === v)) {
      out.push({ version: v, date: (m[2] ?? '').trim() });
    }
  }
  return out;
}

/**
 * 批量创建 / 更新 Release。
 *
 * 用途：把历史版本（如 v1.1.0 ~ v1.1.8）一次性同步到 GitHub Releases。
 * 特性：
 * - 幂等：已存在同名 tag 的 Release 只更新说明，不重复创建；
 * - 单个版本失败不影响后续（逐条 try/catch，最后汇总）；
 * - 不上传任何产物（产物只属于当前版本，由常规发布流程处理）。
 */
async function runAllVersions({ args, owner, repo, changelog, proxy, proxyProbe }) {
  const versions = listChangelogVersions(changelog);

  console.log('══════════════════════════════════════════════════════');
  console.log(' Neo MD —— 批量同步历史 Release');
  console.log('══════════════════════════════════════════════════════');
  console.log(`运行模式    : ${args.dryRun ? '演练（--dry-run，不发出任何网络请求）' : '真实创建 / 更新'}`);
  console.log(`仓库标识    : ${owner && repo ? `${owner}/${repo}` : '（未配置）'}`);
  console.log(`代理        : ${proxy.url || '（直连）'}（${proxy.source}）`);
  console.log(`              探活：${proxyProbe.ok ? '✓' : '✗'} ${proxyProbe.detail}`);
  console.log(`CHANGELOG   : 共 ${versions.length} 个版本`);
  console.log('');

  if (!versions.length) {
    console.log('CHANGELOG 里没有解析到任何版本标题（格式应为 `## [x.y.z] - 日期`）。');
    return 1;
  }

  for (const v of versions) {
    console.log(`  · v${v.version}  ${v.date || '（无日期）'}`);
  }
  console.log('');

  if (args.dryRun) {
    console.log('── 演练模式：以下 Release 将被创建或更新（未实际发出请求）──');
    for (const v of versions) {
      const section = extractChangelogSection(changelog, v.version);
      const body = section ? section.body : '（无更新记录）';
      const lines = body.split('\n').filter((l) => l.trim());
      console.log(`  v${v.version}  body ${lines.length} 行  首行：${(lines[0] ?? '').slice(0, 60)}…`);
    }
    console.log('');
    console.log('演练完成：未创建任何 Release。');
    return 0;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('缺少环境变量 GITHUB_TOKEN，无法创建 Release。');
  }
  if (!owner || !repo) {
    throw new Error('缺少 GitHub 仓库标识，请用 --repo=owner/repo 或环境变量 GITHUB_REPO 指定。');
  }

  const created = [];
  const updated = [];
  const failed = [];

  for (const v of versions) {
    const vTag = `v${v.version}`;
    const section = extractChangelogSection(changelog, v.version);
    const body = section
      ? section.body
      : `## v${v.version}\n\n（CHANGELOG.md 中未找到该版本的更新记录）`;
    const name = `Neo MD v${v.version}`;

    try {
      const existing = await findReleaseByTag({ owner, repo, tag: vTag, token });
      if (existing) {
        await ghRequest({
          method: 'PATCH',
          url: `${API_HOST}/repos/${owner}/${repo}/releases/${existing.id}`,
          token,
          body: JSON.stringify({ name, body, draft: false, prerelease: false }),
        });
        updated.push({ tag: vTag, url: existing.html_url });
        console.log(`  ✓ ${vTag} 已更新（id=${existing.id}）`);
      } else {
        const rel = await ghRequest({
          method: 'POST',
          url: `${API_HOST}/repos/${owner}/${repo}/releases`,
          token,
          body: JSON.stringify({
            tag_name: vTag,
            name,
            body,
            draft: false,
            prerelease: false,
            // target_commitish 留空 → 用默认分支的最新提交，tag 会自动指向它
          }),
        });
        created.push({ tag: vTag, url: rel.html_url });
        console.log(`  ✓ ${vTag} 已创建 → ${rel.html_url}`);
      }
    } catch (e) {
      failed.push({ tag: vTag, error: e instanceof Error ? e.message : String(e) });
      console.log(`  ✗ ${vTag} 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════');
  console.log(' 批量同步完成');
  console.log('══════════════════════════════════════════════════════');
  console.log(`新建 ${created.length} 个，更新 ${updated.length} 个，失败 ${failed.length} 个`);
  if (created.length) {
    console.log('新建列表：');
    for (const c of created) console.log(`  · ${c.tag}  ${c.url}`);
  }
  if (failed.length) {
    console.log('失败列表：');
    for (const f of failed) console.log(`  · ${f.tag}  ${f.error}`);
    return 1;
  }
  return 0;
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

  /* ---------- 0. 启用代理（必须在任何网络请求之前） ---------- */

  const proxy = applyProxy(args);
  const proxyProbe = await probeProxy(proxy.url);

  /* ---------- 1. 定位仓库与版本 ---------- */

  const pkgPath = path.join(REPO_ROOT, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`找不到 package.json：${pkgPath}`);
  }
  const pkg = readJson(pkgPath);
  const version = (args.versionOverride || pkg.version || '').trim();
  if (!version) throw new Error('无法确定版本号：package.json 里没有 version 字段，也没有传 --version。');

  const tag = (args.tagOverride || `v${version}`).trim();
  const artifactsDir = path.resolve(REPO_ROOT, args.artifactsDir || 'dist-artifacts');
  const changelogPath = path.resolve(REPO_ROOT, args.changelogPath || 'CHANGELOG.md');

  // 仓库标识：命令行 > 环境变量 > package.json repository
  const repoFromPkg = parseRepositoryField(pkg.repository);
  const repoSpec = (args.repoOverride || process.env.GITHUB_REPO || repoFromPkg || '').trim();
  const repoMatch = /^([\w.-]+)\/([\w.-]+)$/.exec(repoSpec);
  const owner = repoMatch?.[1] ?? '';
  const repo = repoMatch?.[2] ?? '';

  /* ---------- 2. 解析 CHANGELOG ---------- */

  if (!fs.existsSync(changelogPath)) {
    throw new Error(`找不到 CHANGELOG：${changelogPath}`);
  }
  const changelog = fs.readFileSync(changelogPath, 'utf8');
  const section = extractChangelogSection(changelog, version);
  const latestInChangelog = findLatestChangelogVersion(changelog);

  /* ---------- 批量模式：为 CHANGELOG 里所有版本建 Release ---------- */
  // 批量模式与单版本模式的前置条件不同（不需要产物），因此在这里提前分流，
  // 避免先打印一大段「单版本发布计划」再切到批量输出，造成误导。

  if (args.allVersions) {
    return await runAllVersions({ args, owner, repo, changelog, proxy, proxyProbe });
  }

  /* ---------- 3. 收集产物 ---------- */

  const requiredArtifacts = [];
  const missingArtifacts = [];
  for (const t of ARTIFACT_TEMPLATES) {
    const fileName = t.template(version);
    const filePath = path.join(artifactsDir, fileName);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      requiredArtifacts.push({ ...t, fileName, filePath, size: fs.statSync(filePath).size });
    } else {
      missingArtifacts.push({ ...t, fileName, filePath });
    }
  }

  const optionalArtifacts = [];
  for (const t of OPTIONAL_TEMPLATES) {
    const fileName = t.template(version);
    const filePath = path.join(artifactsDir, fileName);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      optionalArtifacts.push({ ...t, fileName, filePath, size: fs.statSync(filePath).size });
    }
  }

  /* ---------- 4. 组装 Release 说明 ---------- */

  // body 主体 = CHANGELOG 对应段落；末尾追加下载清单，方便访客直接拿安装包
  const downloadLines = [];
  if (requiredArtifacts.length || optionalArtifacts.length) {
    downloadLines.push('', '---', '', '## 安装包', '');
    downloadLines.push('| 平台 | 文件 | 大小 |');
    downloadLines.push('| --- | --- | --- |');
    for (const a of requiredArtifacts) {
      downloadLines.push(`| ${a.label} | \`${a.fileName}\` | ${formatBytes(a.size)} |`);
    }
    for (const a of optionalArtifacts) {
      downloadLines.push(`| ${a.label}（自动更新用） | \`${a.fileName}\` | ${formatBytes(a.size)} |`);
    }
    downloadLines.push('');
    downloadLines.push('> 未签名安装包在 Windows 上可能触发 SmartScreen 提示，选择「更多信息 → 仍要运行」即可。');
  }

  const bodyText = section
    ? `${section.body}${downloadLines.join('\n')}`
    : `## v${version}\n\n（CHANGELOG.md 中未找到 ${version} 的更新记录，请补充后再发布）${downloadLines.join('\n')}`;

  const releaseName = `Neo MD v${version}`;

  /* ---------- 5. 打印计划（dry-run 也走这里） ---------- */

  const bodyLines = bodyText.split('\n');
  const firstLine = (bodyLines.find((l) => l.trim()) ?? '').trim();
  const lastLine = ([...bodyLines].reverse().find((l) => l.trim()) ?? '').trim();

  console.log('══════════════════════════════════════════════════════');
  console.log(' Neo MD —— GitHub Release 发布');
  console.log('══════════════════════════════════════════════════════');
  console.log(`运行模式    : ${args.dryRun ? '演练（--dry-run，不发出任何网络请求）' : '真实发布'}`);
  console.log(`版本号      : ${version}`);
  console.log(`Git tag     : ${tag}`);
  console.log(`Release 名  : ${releaseName}`);
  console.log(`仓库标识    : ${owner && repo ? `${owner}/${repo}` : '（未配置）'}`);
  if (!owner || !repo) {
    console.log('              来源：命令行 --repo / 环境变量 GITHUB_REPO / package.json repository 均未提供');
  } else if (args.repoOverride) {
    console.log('              来源：命令行 --repo');
  } else if (process.env.GITHUB_REPO) {
    console.log('              来源：环境变量 GITHUB_REPO');
  } else {
    console.log('              来源：package.json 的 repository 字段');
  }
  console.log(`产物目录    : ${artifactsDir}`);
  console.log(`CHANGELOG   : ${changelogPath}`);
  console.log(`代理        : ${proxy.url || '（直连）'}`);
  console.log(`              来源：${proxy.source}`);
  console.log(`              探活：${proxyProbe.ok ? '✓' : '✗'} ${proxyProbe.detail}`);
  console.log('');

  // 版本一致性检查：这是「发布出去的版本和日志对不上」的高发点
  const warnings = [];
  if (!section) {
    warnings.push(`CHANGELOG.md 中没有找到版本 ${version} 的段落（## [${version}] - 日期），Release 说明将使用占位内容。`);
  }
  if (latestInChangelog && latestInChangelog !== version) {
    warnings.push(`CHANGELOG.md 的最新版本是 ${latestInChangelog}，与待发布版本 ${version} 不一致。通常是忘记更新更新日志，或忘记升 package.json 版本号。`);
  }
  if (missingArtifacts.length) {
    warnings.push(`缺少 ${missingArtifacts.length} 个必需产物：${missingArtifacts.map((a) => a.fileName).join('、')}`);
  }
  if (!owner || !repo) {
    warnings.push('未解析出 GitHub 仓库标识。请设置环境变量 GITHUB_REPO=owner/repo，或给 package.json 添加 "repository" 字段。');
  }
  if (!args.dryRun && !process.env.GITHUB_TOKEN) {
    warnings.push('环境变量 GITHUB_TOKEN 未设置，无法真实发布。请先设置 token（不要写进任何文件）。');
  }

  if (warnings.length) {
    console.log('⚠ 需要注意：');
    for (const w of warnings) console.log(`  · ${w}`);
    console.log('');
  }

  console.log('── Release 说明（取自 CHANGELOG）──────────────────────');
  if (section) {
    console.log(`标题行      : ${section.titleLine}`);
    console.log(`发布日志日期: ${section.releaseDate || '（未标注）'}`);
  }
  console.log(`正文行数    : ${bodyLines.length} 行（${bodyText.length} 字符）`);
  console.log(`首行        : ${firstLine.slice(0, 120)}${firstLine.length > 120 ? '…' : ''}`);
  console.log(`末行        : ${lastLine.slice(0, 120)}${lastLine.length > 120 ? '…' : ''}`);
  console.log('');

  console.log('── 待上传资产 ────────────────────────────────────────');
  if (args.skipAssets) {
    console.log('  已指定 --skip-assets，本次不上传任何安装包。');
  } else if (!requiredArtifacts.length && !optionalArtifacts.length) {
    console.log('  （无可用产物）');
  } else {
    for (const a of requiredArtifacts) {
      console.log(`  ✓ ${a.fileName.padEnd(38)} ${formatBytes(a.size).padStart(10)}  ${a.label}`);
    }
    for (const a of optionalArtifacts) {
      console.log(`  · ${a.fileName.padEnd(38)} ${formatBytes(a.size).padStart(10)}  ${a.label}（可选）`);
    }
    for (const a of missingArtifacts) {
      console.log(`  ✗ ${a.fileName.padEnd(38)} ${'缺失'.padStart(10)}  ${a.label}`);
    }
    const totalBytes = [...requiredArtifacts, ...optionalArtifacts].reduce((s, a) => s + a.size, 0);
    console.log(`  合计：${requiredArtifacts.length + optionalArtifacts.length} 个文件，${formatBytes(totalBytes)}`);
  }
  console.log('');

  /* ---------- dry-run：到此为止 ---------- */

  if (args.dryRun) {
    console.log('── 将要执行的 GitHub API 调用（演练模式，未实际发出）──');
    if (!owner || !repo) {
      console.log('  （仓库标识缺失，无法生成调用列表）');
    } else {
      console.log(`  1. GET   ${API_HOST}/repos/${owner}/${repo}/releases/tags/${tag}`);
      console.log('           → 存在则复用（更新说明），404 则新建');
      console.log(`  2. POST  ${API_HOST}/repos/${owner}/${repo}/releases    （不存在时）`);
      console.log(`     或 PATCH ${API_HOST}/repos/${owner}/${repo}/releases/{id}    （已存在时）`);
      console.log(`           body: { tag_name: "${tag}", name: "${releaseName}", draft: ${args.draft}, prerelease: ${args.prerelease} }`);
      if (!args.skipAssets) {
        console.log(`  3. GET   ${API_HOST}/repos/${owner}/${repo}/releases/{id}/assets`);
        console.log('           → 逐个比对同名资产，已存在的先 DELETE 再传');
        for (const a of [...requiredArtifacts, ...optionalArtifacts]) {
          console.log(`  4. POST  ${UPLOAD_HOST}/repos/${owner}/${repo}/releases/{id}/assets?name=${a.fileName}`);
        }
      }
    }
    console.log('');
    console.log('演练完成：未创建 Release、未上传任何文件、未修改任何远端数据。');
    console.log('去掉 --dry-run 并配置 GITHUB_TOKEN / GITHUB_REPO 后即可真实发布。');
    return 0;
  }

  /* ---------- 真实发布 ---------- */

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      '缺少环境变量 GITHUB_TOKEN，无法发布。\n' +
        '  PowerShell : $env:GITHUB_TOKEN="ghp_xxx"\n' +
        '  CMD        : set GITHUB_TOKEN=ghp_xxx\n' +
        '  Bash       : export GITHUB_TOKEN=ghp_xxx\n' +
        '注意：不要把 token 写进代码、脚本或任何会被提交的文件。',
    );
  }
  if (!owner || !repo) {
    throw new Error(
      '缺少 GitHub 仓库标识。三种提供方式任选其一：\n' +
        '  1) 环境变量 GITHUB_REPO=owner/repo\n' +
        '  2) 命令行参数 --repo=owner/repo\n' +
        '  3) 在 package.json 里添加 "repository": "owner/repo"',
    );
  }

  console.log('── 开始发布 ──────────────────────────────────────────');

  // 1) 查是否已有同名 Release
  const existing = await findReleaseByTag({ owner, repo, tag, token });
  let release;

  if (existing) {
    console.log(`已存在 tag ${tag} 的 Release（id=${existing.id}），将更新说明。`);
    release = await ghRequest({
      method: 'PATCH',
      url: `${API_HOST}/repos/${owner}/${repo}/releases/${existing.id}`,
      token,
      body: JSON.stringify({
        name: releaseName,
        body: bodyText,
        draft: args.draft,
        prerelease: args.prerelease,
      }),
    });
    console.log(`✓ 已更新 Release：${release.html_url}`);
  } else {
    // 注意：draft 不能与已存在 tag 的 release 混用；调用方需自行确认 tag 已推送
    release = await ghRequest({
      method: 'POST',
      url: `${API_HOST}/repos/${owner}/${repo}/releases`,
      token,
      body: JSON.stringify({
        tag_name: tag,
        name: releaseName,
        body: bodyText,
        draft: args.draft,
        prerelease: args.prerelease,
      }),
    });
    console.log(`✓ 已创建 Release：${release.html_url}`);
  }

  // 2) 上传资产（幂等：同名先删）
  if (args.skipAssets) {
    console.log('已指定 --skip-assets，跳过资产上传。');
  } else {
    const uploadList = [...requiredArtifacts, ...optionalArtifacts];
    if (!uploadList.length) {
      console.log('没有可上传的产物。');
    } else {
      const existingAssets = await listAssets({ owner, repo, releaseId: release.id, token });
      const byName = new Map(existingAssets.map((a) => [a.name, a]));

      for (const a of uploadList) {
        const old = byName.get(a.fileName);
        if (old) {
          console.log(`  同名资产已存在，先删除：${a.fileName}（id=${old.id}）`);
          await deleteAsset({ owner, repo, assetId: old.id, token });
        }
        process.stdout.write(`  上传 ${a.fileName}（${formatBytes(a.size)}）… `);
        try {
          const asset = await uploadAsset({
            owner,
            repo,
            releaseId: release.id,
            token,
            filePath: a.filePath,
            fileName: a.fileName,
          });
          console.log(`完成（${formatBytes(asset.size ?? a.size)}）`);
        } catch (e) {
          console.log('失败');
          throw e;
        }
      }
    }
  }

  // 3) 结果汇总
  const finalAssets = args.skipAssets ? [] : await listAssets({ owner, repo, releaseId: release.id, token });
  console.log('');
  console.log('══════════════════════════════════════════════════════');
  console.log(' 发布完成');
  console.log('══════════════════════════════════════════════════════');
  console.log(`Release 页面 : ${release.html_url}`);
  console.log(`tag          : ${tag}`);
  console.log(`远端资产数   : ${finalAssets.length}`);
  for (const a of finalAssets) {
    console.log(`  · ${a.name.padEnd(38)} ${formatBytes(a.size).padStart(10)}（下载 ${a.download_count} 次）`);
  }
  console.log('');
  console.log('后续检查：');
  console.log('  1. 打开上面的 Release 页面，确认说明与安装包齐全；');
  console.log('  2. 确认 CHANGELOG.md 的本次改动已提交并推送到主分支；');
  console.log('  3. 若这是草稿（--draft），记得在页面右上角发布。');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error('');
    console.error('✗ 发布失败：');
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
