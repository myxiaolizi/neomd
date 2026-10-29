/**
 * 1.2.0 绿色版（便携版）端到端验收。
 *
 * 验收目标不是"进程起来了"，而是产物真的能用：
 *   ① 产物 + 白名单静态检查（版本三处一致、SHA256、files 覆盖全部本地 require）
 *   ② 解压到**含中文和空格**的临时目录（顺便验证该场景）
 *   ③ 启动真实 `Neo MD.exe`，用 Chrome DevTools Protocol 做 DOM/桥接断言
 *   ④ 便携模式专项：exe 同目录放 portable.txt 后，userData 必须落到该目录的 data/ 下
 *
 * ## 为什么用 CDP 而不是"脚本入口"驱动
 * 上一版（verify-119）用 `electron.exe driver.cjs` 驱动，因为那时的 electron.exe 是**未打包**的
 * 运行时，会把第一个参数当入口脚本。但打包后的 `Neo MD.exe` 入口固定为 app.asar 内 main.cjs，
 * 传进去的脚本参数只会进 process.argv、根本不会被执行——实测表现为"驱动日志一行都没有，
 * 但 stderr 出现了 main.cjs 才有的 console-message 弃用警告"。
 * 因此这里改为 `--remote-debugging-port` + CDP：启动的**就是用户双击的那个 exe**，
 * 断言跑在真实渲染上下文里，比注入驱动更接近真实使用。
 *
 * ## 为什么不用截图
 * 本机 capturePage 报 UnknownVizError（缺 Viz 后端）。改用 DOM 断言（#app 子节点、标题、
 * 桥接 API 实测调用）与日志断言，证据强度不低于截图。
 *
 * 用法：node tools/verify-120-portable.mjs [zip路径]
 * 退出码 0 = 全部通过。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const desktopDir = path.join(repoRoot, 'apps', 'desktop');
const outDir = path.join(repoRoot, 'dist-artifacts');

const pkgVersion = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8')).version;
const zipPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(outDir, `NeoMD-${pkgVersion}-win-x64.zip`);

const staticResults = [];
const guiResults = [];
const portableResults = [];
const notes = [];

function assert(list, tag, name, pass, detail) {
  list.push({ name, pass: Boolean(pass), detail });
  const extra = detail === undefined ? '' : ' :: ' + JSON.stringify(detail);
  console.log(`[${tag}] ${pass ? 'PASS' : 'FAIL'} ${name}${extra}`);
}
function note(msg) {
  notes.push(String(msg));
  console.log('[note]', msg);
}
function sha256(file) {
  const h = createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}
function mb(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(1));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ================= ① 静态检查 ================= */

function runStaticChecks() {
  console.log('\n=== ① 产物与打包白名单静态检查 ===');

  const builderConfigPath = path.join(desktopDir, 'electron-builder.config.cjs');
  const builderConfig = createRequire(builderConfigPath)(builderConfigPath);
  const listed = new Set((builderConfig.files ?? []).map(String));

  // 逐项比对：主进程与 preload 里每个 require('./x') 是否都在白名单里
  const localRequires = [];
  for (const f of ['main.cjs', 'preload.cjs']) {
    const src = fs.readFileSync(path.join(desktopDir, f), 'utf8');
    for (const m of src.matchAll(/require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)) {
      localRequires.push({ from: f, module: m[1].replace(/^\.\//, '') });
    }
  }
  const missing = localRequires.filter((r) => !listed.has(r.module));
  const ghostFiles = [...listed].filter((f) => !fs.existsSync(path.join(desktopDir, f)));

  assert(staticResults, 'unit', '白名单覆盖 main.cjs/preload.cjs 的全部本地 require', missing.length === 0, {
    requires: localRequires,
    missing,
  });
  assert(staticResults, 'unit', '白名单里没有指向不存在文件的条目（无幽灵条目）', ghostFiles.length === 0, { ghostFiles });

  // artifactName 必须用版本变量，不能写死
  const artifactName = builderConfig.win && builderConfig.win.artifactName;
  assert(staticResults, 'unit', 'win.artifactName 使用 ${version} 变量（不硬编码版本）', /\$\{version\}/.test(String(artifactName ?? '')), {
    artifactName,
  });

  // build.mjs 里不能再出现写死的版本号（1.1.x 曾硬编码 NeoMD-1.1.9-win-x64.zip，
  // 每升版本都要手工改，漏改就会产出文件名写着旧版本的包直接发出去）。
  // 检查前先剥离注释：注释里把历史硬编码当成反例写出来是有价值的，不该被判失败。
  const buildSrc = fs.readFileSync(path.join(desktopDir, 'build.mjs'), 'utf8');
  const buildCode = buildSrc
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/^\s*\/\/.*$/gm, ''); // 行注释
  const hardcoded = [...buildCode.matchAll(/NeoMD-\d+\.\d+\.\d+/g)].map((m) => m[0]);
  assert(staticResults, 'unit', 'build.mjs 代码中未硬编码版本号（版本从 package.json 读）', hardcoded.length === 0, {
    hardcoded,
  });
  assert(
    staticResults,
    'unit',
    'build.mjs 从 package.json 读取 version',
    /readFileSync[\s\S]{0,200}package\.json/.test(buildSrc) && /\bpkg\.version\b/.test(buildSrc),
    { readsPkgVersion: /\bpkg\.version\b/.test(buildSrc) },
  );

  if (!fs.existsSync(zipPath)) {
    assert(staticResults, 'unit', `绿色版产物存在：${path.basename(zipPath)}`, false, { zipPath });
    return null;
  }
  const st = fs.statSync(zipPath);
  assert(staticResults, 'unit', '绿色版产物存在且体积合理（>50MB）', st.size > 50 * 1024 * 1024, {
    file: zipPath,
    mb: mb(st.size),
  });
  const hash = sha256(zipPath);
  assert(staticResults, 'unit', 'SHA256 计算成功（64 位十六进制）', /^[0-9a-f]{64}$/.test(hash), { sha256: hash });

  const nameVersion = (path.basename(zipPath).match(/NeoMD-([0-9]+\.[0-9]+\.[0-9]+)/) ?? [])[1];
  assert(staticResults, 'unit', `产物文件名版本 == package.json 版本（${pkgVersion}）`, nameVersion === pkgVersion, {
    fileName: path.basename(zipPath),
    nameVersion,
    pkgVersion,
  });

  return { zipPath, bytes: st.size, sha256: hash };
}

/* ================= ② 解压到含中文+空格的路径 ================= */

function extractToTrickyPath(zipFile) {
  console.log('\n=== ② 解压到含中文与空格的临时路径 ===');
  const base = path.join(os.tmpdir(), `nm 中文 路径测试 ${Date.now()}`);
  const target = path.join(base, '我的 软件', 'Neo MD 绿色版');
  fs.mkdirSync(target, { recursive: true });
  note('解压目标：' + target);

  // 用系统 tar 解压（Windows 10+ 自带 bsdtar），与 build.mjs 打包用同一套工具
  const { spawnSync } = createRequire(import.meta.url)('node:child_process');
  const res = spawnSync('tar', ['-x', '-f', zipFile, '-C', target], { stdio: 'pipe' });
  if (res.status !== 0) {
    assert(staticResults, 'unit', '解压绿色版到中文+空格路径', false, {
      status: res.status,
      stderr: String(res.stderr ?? '').slice(-800),
    });
    return null;
  }
  const exe = path.join(target, 'Neo MD.exe');
  const ok = fs.existsSync(exe);
  assert(staticResults, 'unit', '解压后 Neo MD.exe 位于中文+空格路径下', ok, { exe });
  if (!ok) return null;

  // 前端产物与 asar 必须真的在包里：漏打 extraResources 会白屏，漏打 asar 会直接起不来
  const webIndex = path.join(target, 'resources', 'webdist', 'index.html');
  assert(staticResults, 'unit', 'resources/webdist/index.html 存在（前端产物已打入）', fs.existsSync(webIndex), { webIndex });
  const asar = path.join(target, 'resources', 'app.asar');
  assert(staticResults, 'unit', 'resources/app.asar 存在', fs.existsSync(asar), { asar });

  // asar 内部必须包含白名单里的每个模块（这是"打包后 MODULE_NOT_FOUND"的最终防线）
  const asarList = listAsar(asar);
  if (asarList) {
    const expectedModules = ['main.cjs', 'preload.cjs', 'package.json'];
    const builderConfig = createRequire(path.join(desktopDir, 'electron-builder.config.cjs'))(
      path.join(desktopDir, 'electron-builder.config.cjs'),
    );
    for (const f of builderConfig.files ?? []) {
      if (String(f).endsWith('.json')) continue;
      expectedModules.push(String(f));
    }
    const missingInAsar = [...new Set(expectedModules)].filter((f) => !asarList.includes(f));
    assert(staticResults, 'unit', 'asar 内包含白名单的全部 .cjs 模块', missingInAsar.length === 0, {
      missingInAsar,
      asarEntries: asarList.slice(0, 20),
    });
  }

  return { target, exe, asar };
}

/** 读 asar 文件头，列出其内部条目（不依赖 @electron/asar 包） */
function listAsar(asarPath) {
  try {
    const fd = fs.openSync(asarPath, 'r');
    const sizeBuf = Buffer.alloc(16);
    fs.readSync(fd, sizeBuf, 0, 16, 0);
    // asar 格式：4 字节 uint32 表示 pickle header 大小，随后 8 字节 + JSON 头长度
    const jsonSize = sizeBuf.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(jsonSize);
    fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
    fs.closeSync(fd);
    const header = JSON.parse(jsonBuf.toString('utf8'));
    const out = [];
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const full = prefix ? `${prefix}/${name}` : name;
        if (child.files) walk(child, full);
        else out.push(full);
      }
    };
    walk(header, '');
    return out;
  } catch (e) {
    note('读取 asar 目录失败（不作为失败项）：' + String(e && e.message));
    return null;
  }
}

/* ================= CDP 客户端 ================= */

/**
 * 极简 CDP 客户端：用 Node 内置 WebSocket（Node 22+ 自带），零额外依赖。
 * 只实现 Runtime.evaluate，足够做 DOM/桥接断言。
 */
class CdpSession {
  constructor(ws, targets, port) {
    this.ws = ws;
    this.targets = targets;
    this.port = port;
    this.nextId = 1;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      }
    };
  }

  static async connect(port, targetPredicate) {
    // 等 CDP 就绪
    let targets = null;
    for (let i = 0; i < 200; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        targets = await res.json();
        if (Array.isArray(targets) && targets.some((t) => t.type === 'page')) break;
      } catch {
        /* 端口还没起来 */
      }
      await sleep(200);
    }
    if (!Array.isArray(targets)) throw new Error('CDP /json/list 不可达');
    const page = targets.find((t) => t.type === 'page' && (!targetPredicate || targetPredicate(t)));
    if (!page) throw new Error('没有匹配的 page target；现有=' + JSON.stringify(targets.map((t) => t.url)));
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'));
    });
    return new CdpSession(ws, targets, port);
  }

  /** 列出当前所有 page target（用于从"外部"观察多窗口是否真的开出来了） */
  async pageTargets() {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/list`);
      const list = await res.json();
      return list.filter((t) => t.type === 'page');
    } catch {
      return [];
    }
  }

  send(method, params) {
    const id = this.nextId++;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
  }

  /**
   * 在页面上下文求值。awaitPromise 让它能直接 await 桥接的 Promise API
   * （window.NeoMD.bridge.fs.writeText 之类返回 Promise）。
   */
  async evaluate(expression, timeoutMs = 25000) {
    const race = Promise.race([
      this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      sleep(timeoutMs).then(() => ({ __timeout: true })),
    ]);
    const r = await race;
    if (r.__timeout) throw new Error('Runtime.evaluate 超时（' + timeoutMs + 'ms）');
    if (r.error) throw new Error('CDP 错误：' + JSON.stringify(r.error));
    const details = r.result && r.result.exceptionDetails;
    if (details) {
      const desc = (details.exception && (details.exception.description || details.exception.value)) || details.text;
      throw new Error('页面执行异常：' + String(desc).split('\n')[0]);
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** 找空闲端口（避免与本机 3200/5178 等已占用端口冲突） */
async function findFreePort(start = 9411) {
  for (let p = start; p < start + 60; p += 1) {
    const ok = await new Promise((res) => {
      const srv = createRequire(import.meta.url)('node:net').createServer();
      srv.once('error', () => res(false));
      srv.once('listening', () => srv.close(() => res(true)));
      srv.listen(p, '127.0.0.1');
    });
    if (ok) return p;
  }
  return start;
}

/** 启动 exe 并等 CDP 就绪；返回 {child, cdp, port} */
async function launchAndConnect(exe, args, env, cwd) {
  const port = await findFreePort();
  const child = spawn(exe, [...args, `--remote-debugging-port=${port}`, '--disable-gpu'], {
    env,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.on('data', () => undefined);
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  const cdp = await CdpSession.connect(port);
  return { child, cdp, port, getStderr: () => stderr };
}

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    // Windows 上 Electron 会派生多个子进程，taskkill /T 才能清干净
    if (process.platform === 'win32') {
      createRequire(import.meta.url)('node:child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
}

/* ================= ③ 真实启动 + CDP 断言 ================= */

async function runGuiChecks(exe, workDir) {
  console.log('\n=== ③ 启动打包后的 Neo MD.exe（CDP 驱动）===');
  const env = { ...process.env };
  // 父环境若带 ELECTRON_RUN_AS_NODE，Electron 会退化成普通 node，GUI 起不来
  delete env.ELECTRON_RUN_AS_NODE;
  // 明确关闭便携模式，验证"默认不污染 exe 目录、走 AppData"的既有行为
  delete env.NEOMD_PORTABLE;

  const vaultDir = path.join(workDir, 'vault 仓库');
  const { child, cdp, getStderr } = await launchAndConnect(exe, [], env, workDir);
  try {
    // 等首帧 + 渲染层挂载
    let mounted = false;
    for (let i = 0; i < 200; i += 1) {
      try {
        const n = await cdp.evaluate("document.querySelector('#app') ? document.querySelector('#app').children.length : 0", 5000);
        if (n > 0) {
          mounted = true;
          break;
        }
      } catch {
        /* 页面还在导航 */
      }
      await sleep(250);
    }

    const url = await cdp.evaluate('location.href');
    assert(guiResults, 'gui', '主窗口 URL 是 neomd://neomd/app', /^neomd:\/\/neomd\/app/.test(String(url)), { url });
    assert(guiResults, 'gui', '渲染层已挂载 DOM（#app 有子节点，非白屏）', mounted);
    const title = await cdp.evaluate('document.title');
    assert(guiResults, 'gui', '页面标题已渲染（证明前端 bundle 真的跑起来了）', Boolean(title) && title.length > 0, { title });

    // preload 桥与安全基线
    const bridge = await cdp.evaluate(`({
      hasNeoMD: typeof window.NeoMD === 'object' && window.NeoMD !== null,
      env: window.NeoMD && window.NeoMD.env,
      keys: window.NeoMD && window.NeoMD.bridge ? Object.keys(window.NeoMD.bridge).sort() : [],
      nodeRequire: typeof window.require,
      nodeProcess: typeof window.process,
    })`);
    const expected = ['app', 'dialog', 'fs', 'paths', 'printToPdf', 'secrets', 'shell', 'win'];
    assert(guiResults, 'gui', 'window.NeoMD.bridge 存在且 env=desktop', bridge.hasNeoMD === true && bridge.env === 'desktop', {
      env: bridge.env,
    });
    assert(guiResults, 'gui', 'preload 暴露的 API 白名单完整（8 项）', expected.every((k) => bridge.keys.includes(k)), {
      got: bridge.keys,
      expected,
    });
    assert(
      guiResults,
      'gui',
      '渲染层拿不到 require/process（contextIsolation 生效，安全不回退）',
      bridge.nodeRequire === 'undefined' && bridge.nodeProcess === 'undefined',
      { nodeRequire: bridge.nodeRequire, nodeProcess: bridge.nodeProcess },
    );

    // 版本：桥上报的版本必须等于 package.json
    const appVersion = await cdp.evaluate('window.NeoMD.bridge.app.version()');
    assert(guiResults, 'gui', `应用版本 == ${pkgVersion}`, appVersion === pkgVersion, { appVersion, pkgVersion });

    // custom protocol 能取到打包资源（handler 正常工作的直接证据）
    const proto = await cdp.evaluate(`(async () => {
      try {
        const r = await fetch('neomd://neomd/index.html');
        const t = await r.text();
        return { status: r.status, hasApp: t.includes('id="app"') };
      } catch (e) { return { error: String(e && e.message) }; }
    })()`);
    assert(guiResults, 'gui', 'neomd:// 协议能取到 index.html（custom protocol 正常）', proto && proto.status === 200 && proto.hasApp === true, proto);

    // 本地仓库：真实建目录、写入中文名/中文内容的 .md、列目录、读回
    // 路径本身含中文与空格（在解压目录下），顺带验证 fs 桥对非 ASCII 路径的处理
    const p = (v) => JSON.stringify(v);
    await cdp.evaluate(`window.NeoMD.bridge.fs.mkdirp(${p(vaultDir)})`);
    const docPath = path.join(vaultDir, '第一篇 文档.md');
    const docBody = '# 中文标题\n\n绿色版实测写入的内容。';
    await cdp.evaluate(`window.NeoMD.bridge.fs.writeText(${p(docPath)}, ${p(docBody)})`);
    const list = await cdp.evaluate(`window.NeoMD.bridge.fs.list(${p(vaultDir)})`);
    const readBack = await cdp.evaluate(`window.NeoMD.bridge.fs.readText(${p(docPath)})`);
    assert(
      guiResults,
      'gui',
      '能打开本地仓库目录并读到文档列表',
      Array.isArray(list) && list.some((e) => e.name && e.name.endsWith('.md')),
      { vaultDir, list },
    );
    assert(guiResults, 'gui', '能写入并读回「中文文件名 + 中文内容」的文档', readBack === docBody, {
      readBackLen: typeof readBack === 'string' ? readBack.length : null,
      expectedLen: docBody.length,
    });

    // 磁盘交叉验证：排除"只在内存里成功"的假象
    let onDisk = false;
    try {
      onDisk = fs.existsSync(docPath) && fs.readFileSync(docPath, 'utf8') === docBody;
    } catch {
      onDisk = false;
    }
    assert(guiResults, 'gui', '文档真实落盘（磁盘内容与写入一致）', onDisk, { docPath });

    // 多窗口能力在绿色版内仍然可用（1.1.9 的改造不能被回退）
    const beforeCount = (await cdp.pageTargets()).length;
    const newWinId = await cdp.evaluate('window.NeoMD.bridge.win.newWindow("portable-check")');
    // 轮询等第二个 page target 出现（新窗口要导航完才会出现在 /json/list 里）
    let afterTargets = [];
    for (let i = 0; i < 60; i += 1) {
      afterTargets = await cdp.pageTargets();
      if (afterTargets.length > beforeCount) break;
      await sleep(250);
    }
    assert(guiResults, 'gui', '绿色版内多窗口可用（newWindow 返回窗口 id）', typeof newWinId === 'number', { newWindowId: newWinId });
    assert(guiResults, 'gui', '多窗口真实开出第二个页面（CDP target 数增加）', afterTargets.length > beforeCount, {
      before: beforeCount,
      after: afterTargets.length,
      urls: afterTargets.map((t) => t.url),
    });
    assert(
      guiResults,
      'gui',
      '新窗口 URL 带 doc=portable-check 与 fresh=1',
      afterTargets.some((t) => /doc=portable-check/.test(String(t.url)) && /fresh=1/.test(String(t.url))),
      { urls: afterTargets.map((t) => t.url) },
    );

    // 读回启动日志：userData 位置、便携模式结论、无未捕获异常
    const userData = await cdp.evaluate('window.NeoMD.bridge.paths.userData()');
    const logPath = path.join(String(userData), 'neomd-main.log');
    let logText = '';
    try {
      logText = fs.readFileSync(logPath, 'utf8');
    } catch {
      logText = '';
    }
    assert(guiResults, 'gui', '启动日志写入 userData/neomd-main.log', logText.length > 0, { logPath, bytes: logText.length });
    assert(guiResults, 'gui', '日志记录了 userData 与便携模式结论', /userData=/.test(logText) && /portable=(yes|no):/.test(logText), {
      tail: logText.slice(-350),
    });
    assert(guiResults, 'gui', '日志中没有 uncaughtException', !/uncaughtException/.test(logText), {
      hasUncaught: /uncaughtException/.test(logText),
    });

    // 默认（无便携标记）应当落在 AppData，而不是污染 exe 目录
    const appDataRoot = process.env.APPDATA || '';
    const inAppData = appDataRoot ? String(userData).toLowerCase().startsWith(appDataRoot.toLowerCase()) : null;
    assert(guiResults, 'gui', '默认模式 userData 在 AppData（未污染解压目录）', inAppData === true, {
      userData,
      appDataRoot,
    });
    const exeDirData = path.join(path.dirname(exe), 'data');
    assert(guiResults, 'gui', '默认模式未在 exe 同目录创建 data/ 目录', !fs.existsSync(exeDirData), { exeDirData });

    note('运行态：userData=' + userData + '  isPackaged 环境=' + exe);
    const stderr = getStderr();
    if (stderr && /MODULE_NOT_FOUND/.test(stderr)) {
      assert(guiResults, 'gui', '进程 stderr 中没有 MODULE_NOT_FOUND', false, { stderr: stderr.slice(-800) });
    } else {
      assert(guiResults, 'gui', '进程 stderr 中没有 MODULE_NOT_FOUND', true);
    }
  } finally {
    cdp.close();
    killTree(child);
  }
}

/* ================= ④ 便携模式专项 ================= */

/**
 * 便携模式验证：在解压目录放 portable.txt，再启动一次，
 * 断言 userData 变成 exe 同目录的 data/ —— 这才是"绿色版不污染系统"。
 */
async function runPortableChecks(exe, workDir) {
  console.log('\n=== ④ 便携模式专项（exe 同目录放 portable.txt）===');
  const exeDir = path.dirname(exe);
  const marker = path.join(exeDir, 'portable.txt');
  const dataDir = path.join(exeDir, 'data');
  fs.writeFileSync(marker, 'portable mode enabled by verify-120\n', 'utf8');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NEOMD_PORTABLE;

  let child = null;
  let cdp = null;
  try {
    const launched = await launchAndConnect(exe, [], env, workDir);
    child = launched.child;
    cdp = launched.cdp;
    // 等渲染层挂载后再问 userData
    for (let i = 0; i < 200; i += 1) {
      try {
        const n = await cdp.evaluate("document.querySelector('#app') ? document.querySelector('#app').children.length : 0", 5000);
        if (n > 0) break;
      } catch {
        /* 还在导航 */
      }
      await sleep(250);
    }
    const userData = await cdp.evaluate('window.NeoMD.bridge.paths.userData()');
    const expected = path.join(dataDir);
    assert(portableResults, 'portable', '放 portable.txt 后 userData 指向 exe 同目录 data/', path.resolve(String(userData)) === path.resolve(expected), {
      userData,
      expected,
    });
    assert(portableResults, 'portable', 'data/ 目录被真实创建', fs.existsSync(dataDir), { dataDir });

    // 便携模式下日志也必须落在 data/ 里
    const logPath = path.join(String(userData), 'neomd-main.log');
    let logText = '';
    try {
      logText = fs.readFileSync(logPath, 'utf8');
    } catch {
      logText = '';
    }
    assert(portableResults, 'portable', '便携模式日志落在 data/neomd-main.log', logText.length > 0, { logPath });
    assert(portableResults, 'portable', '日志记录 portable=yes', /portable=yes:/.test(logText), {
      matched: (logText.match(/portable=[^\s]+/) ?? [null])[0],
    });

    // 便携模式不能破坏核心功能：页面仍能加载、桥仍在
    const url = await cdp.evaluate('location.href');
    const bridgeOk = await cdp.evaluate('typeof window.NeoMD === "object" && Boolean(window.NeoMD.bridge)');
    assert(portableResults, 'portable', '便携模式下页面与桥接仍正常', /^neomd:\/\/neomd\/app/.test(String(url)) && bridgeOk === true, {
      url,
      bridgeOk,
    });

    // 单实例锁不能被便携模式破坏：再起一个进程应当立刻退出（拿不到锁）
    const second = spawn(exe, [], { env, cwd: workDir, stdio: 'ignore', detached: false });
    const exitedFast = await Promise.race([
      new Promise((res) => second.once('exit', () => res(true))),
      sleep(12000).then(() => false),
    ]);
    if (!exitedFast) killTree(second);
    assert(portableResults, 'portable', '便携模式下单实例锁仍生效（第二个实例自动退出）', exitedFast === true, {
      secondExitedFast: exitedFast,
    });
  } finally {
    if (cdp) cdp.close();
    killTree(child);
    // 清理标记文件，避免影响后续手工测试
    try {
      fs.rmSync(marker, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/* ================= 主流程 ================= */

const startedAt = Date.now();
const artifact = runStaticChecks();
let extracted = null;
if (artifact) extracted = extractToTrickyPath(artifact.zipPath);

if (extracted) {
  try {
    await runGuiChecks(extracted.exe, extracted.target);
  } catch (e) {
    assert(guiResults, 'gui', 'GUI 验收执行异常', false, { message: String(e && e.message ? e.message : e) });
  }
  try {
    await runPortableChecks(extracted.exe, extracted.target);
  } catch (e) {
    assert(portableResults, 'portable', '便携模式验收执行异常', false, { message: String(e && e.message ? e.message : e) });
  }
}

const allLists = [
  ['① 静态检查', staticResults],
  ['③ GUI 实测', guiResults],
  ['④ 便携模式', portableResults],
];
const failed = [];
for (const [, list] of allLists) for (const r of list) if (!r.pass) failed.push(r);

console.log('\n=== 汇总 ===');
for (const [label, list] of allLists) {
  const bad = list.filter((r) => !r.pass).length;
  console.log(`${label}：${list.length - bad}/${list.length} 通过`);
}
if (failed.length) {
  console.log('\n失败项：');
  for (const f of failed) console.log(' - ' + f.name + (f.detail ? ' :: ' + JSON.stringify(f.detail) : ''));
}
if (artifact) {
  console.log('\n=== 发布信息 ===');
  console.log('产物：' + artifact.zipPath);
  console.log('大小：' + mb(artifact.bytes) + ' MB (' + artifact.bytes + ' bytes)');
  console.log('SHA256：' + artifact.sha256);
}
// GUI 与便携两组必须有实际断言，否则说明根本没跑起来，不能算通过
const ranGui = guiResults.length > 0;
const ranPortable = portableResults.length > 0;
const ok = failed.length === 0 && ranGui && ranPortable;
if (!ranGui || !ranPortable) console.log('\n注意：GUI/便携模式断言未执行，不能判定通过。');
console.log(`\n结果：${ok ? '通过' : '未通过'}（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);
process.exit(ok ? 0 : 1);
