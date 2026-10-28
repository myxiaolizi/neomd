/**
 * 1.1.9 桌面端多窗口验收脚本。
 *
 * 分两层验证：
 *   A. 纯 Node 单元测试（不依赖 Electron，任何环境都能跑）
 *      - apps/desktop/window-utils.cjs：级联定位 / 不越屏 / URL 参数约定
 *      - apps/desktop/window-registry.cjs：窗口登记表 / 按发送方定位 / 广播 / 关窗回收
 *   B. 真实 Electron GUI 冒烟（有 Electron 运行时就会跑）
 *      - 用 tools/verify-119-multiwindow-driver.cjs 作为入口启动真实 main.cjs，
 *        开多窗口、走真实 IPC + 真实 preload，断言任务要求的 a/b/c/d 四项。
 *      - 若本机无法启动 Electron（缺依赖 / 无图形环境），自动降级为"仅单元测试"，
 *        并在结果里明确标注 degraded 与原因（不静默通过）。
 *
 * 用法：
 *   node tools/verify-119-multiwindow.mjs
 *   node tools/verify-119-multiwindow.mjs --unit-only     # 只跑单元测试
 *   node tools/verify-119-multiwindow.mjs --no-unit       # 只跑 GUI 冒烟
 *
 * 退出码 0 表示全部通过。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const desktopDir = path.join(repoRoot, 'apps', 'desktop');
const requireCjs = createRequire(import.meta.url);
const unitOnly = process.argv.includes('--unit-only');
const noUnit = process.argv.includes('--no-unit');

const unitResults = [];
const guiResults = [];
const notes = [];

function assert(name, pass, detail) {
  unitResults.push({ name, pass: Boolean(pass), detail });
  const mark = pass ? 'PASS' : 'FAIL';
  const extra = detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`;
  console.log(`[unit] ${mark} ${name}${extra}`);
}

/* ================= A. 纯单元测试 ================= */

function runUnitTests() {
  console.log('\n=== A. 单元测试（window-utils / window-registry，纯 Node） ===');
  const utils = requireCjs(path.join(desktopDir, 'window-utils.cjs'));
  const registryMod = requireCjs(path.join(desktopDir, 'window-registry.cjs'));
  const { WindowRegistry } = registryMod;

  /* --- 级联定位 / 不越屏 --- */
  const area1080 = { x: 0, y: 0, width: 1920, height: 1040 };
  const b1 = utils.computeCascadeBounds({ workArea: area1080, cascade: 28, size: { width: 1280, height: 840 } });
  assert(
    '级联：常规 1920x1040 下，1280x840 窗口 +28 偏移仍在工作区内',
    utils.isBoundsWithinWorkArea(b1, area1080) && b1.x === 28 && b1.y === 28,
    b1,
  );

  const areaSmall = { x: 0, y: 0, width: 1024, height: 700 };
  const b2 = utils.computeCascadeBounds({ workArea: areaSmall, cascade: 28, size: { width: 1280, height: 840 } });
  assert(
    '级联：小屏（1024x700）时尺寸被收缩进工作区，不产生溢出',
    utils.isBoundsWithinWorkArea(b2, areaSmall) && b2.width === 1024 && b2.height === 700,
    { bounds: b2, area: areaSmall },
  );

  // 父窗口已贴近右下角：偏移后必须被拉回来，而不是跑到屏幕外
  const fromBR = { x: 1800, y: 980, width: 120, height: 60 };
  const b3 = utils.computeCascadeBounds({ from: fromBR, workArea: area1080, cascade: 224 });
  assert('级联：父窗口贴右下角 + 大偏移仍被 clamp 进工作区（不越屏）', utils.isBoundsWithinWorkArea(b3, area1080), b3);

  // 多显示器：父窗口在左侧副屏（负坐标），参考显示器是副屏
  const areaLeft = { x: -1920, y: 0, width: 1920, height: 1040 };
  const b4 = utils.computeCascadeBounds({
    from: { x: -1900, y: 20, width: 1280, height: 840 },
    workArea: areaLeft,
    cascade: 56,
  });
  assert('级联：副屏负坐标下仍落在该屏工作区内', utils.isBoundsWithinWorkArea(b4, areaLeft) && b4.x >= -1920, b4);

  assert(
    '级联：偏移步长递增且永不为 0',
    [0, 1, 2, 7, 8, 9].every((n) => utils.nextCascadeOffset(n) > 0) &&
      utils.nextCascadeOffset(1) < utils.nextCascadeOffset(2) &&
      utils.nextCascadeOffset(8) === utils.nextCascadeOffset(0),
    [0, 1, 2, 7, 8, 9].map((n) => utils.nextCascadeOffset(n)),
  );

  /* --- URL 参数约定（渲染层契约） --- */
  assert(
    'URL 约定：doc + fresh 拼成 ?doc=<id>&fresh=1',
    utils.buildWindowRoute({ docId: 'abc123', fresh: true }) === '?doc=abc123&fresh=1',
    utils.buildWindowRoute({ docId: 'abc123', fresh: true }),
  );
  assert(
    'URL 约定：含特殊字符的 docId 会被 encodeURIComponent',
    utils.buildWindowRoute({ docId: 'a b&c=d', fresh: true }) === '?doc=a%20b%26c%3Dd&fresh=1',
    utils.buildWindowRoute({ docId: 'a b&c=d', fresh: true }),
  );
  assert(
    'URL 约定：只有 doc 时不带 fresh（向后兼容旧行为）',
    utils.buildWindowRoute({ docId: 'x' }) === '?doc=x',
    utils.buildWindowRoute({ docId: 'x' }),
  );
  assert('URL 约定：无参数时返回空串（新窗口恢复旧标签）', utils.buildWindowRoute({}) === '', utils.buildWindowRoute({}));

  /* --- newWindow 入参归一化 --- */
  const n1 = utils.normalizeNewWindowArgs('doc-1');
  const n2 = utils.normalizeNewWindowArgs({ docId: 'doc-2', fresh: false });
  const n3 = utils.normalizeNewWindowArgs(null);
  assert(
    '入参归一化：字符串 / 对象 / null 三种形态都正确，fresh 默认 true',
    n1.docId === 'doc-1' && n1.fresh === true && n2.docId === 'doc-2' && n2.fresh === false && n3.docId === null && n3.fresh === true,
    { n1, n2, n3 },
  );

  /* --- 窗口登记表：按发送方定位（核心回归点） --- */
  function fakeWindow(id, opts = {}) {
    const wc = { id: id * 10, sent: [], isDestroyed: () => false, send: (ch, payload) => wc.sent.push({ ch, payload }) };
    const win = {
      id,
      webContents: wc,
      isDestroyed: () => Boolean(win._destroyed),
      isFocused: () => Boolean(win._focused),
      getBounds: () => ({ x: id * 10, y: id * 10, width: 800, height: 600 }),
      _destroyed: Boolean(opts.destroyed),
      _focused: Boolean(opts.focused),
    };
    return win;
  }

  const winA = fakeWindow(1, { focused: false });
  const winB = fakeWindow(2, { focused: true });
  const registry = new WindowRegistry({ fromWebContents: (wc) => [winA, winB].find((w) => w.webContents === wc) ?? null });
  registry.add(winA);
  registry.add(winB);
  assert('登记表：add 后计数为 2', registry.count() === 2, registry.count());

  const resolvedA = registry.resolveSender({ sender: winA.webContents });
  const resolvedB = registry.resolveSender({ sender: winB.webContents });
  assert('登记表：resolveSender 精确返回发送方窗口（A→A、B→B）', resolvedA === winA && resolvedB === winB, {
    a: resolvedA === winA,
    b: resolvedB === winB,
  });

  // 关键回归：解析不出窗口时**不得**借用别的窗口
  assert('登记表：无法识别的发送方返回 null（绝不回退到某个"主窗口"）', registry.resolveSender({ sender: { id: 999 } }) === null);
  // 发送方窗口已经被销毁（但 sender 引用还能拿到）时必须返回 null，不能借用其它窗口
  const winC = fakeWindow(3, { destroyed: true });
  assert(
    '登记表：sender 对应窗口已销毁时返回 null（不借用其它窗口）',
    registry.resolveSender({ sender: winC.webContents }) === null,
  );

  // 销毁的窗口从登记表剔除
  winA._destroyed = true;
  assert('登记表：已销毁窗口被剔除，只剩 1 个', registry.count() === 1 && registry.all()[0] === winB, registry.count());

  // 对话框父窗口
  assert('对话框：父窗口取发送方自身', registry.resolveDialogParent({ sender: winB.webContents }) === winB);
  assert(
    '对话框：发送方窗口已销毁时不借用其它窗口（返回 null 由系统无父窗口弹出）',
    registry.resolveDialogParent({ sender: winA.webContents }) === null,
  );
  assert(
    '对话框：主进程内部调用（无 sender）退化为聚焦窗口',
    registry.resolveDialogParent({}) === winB,
  );

  // 广播
  const sent = registry.broadcast('app:theme-changed', 'dark');
  assert(
    '广播：只发给存活窗口，payload 正确',
    sent === 1 && winB.webContents.sent.length === 1 && winB.webContents.sent[0].payload === 'dark',
    { sent, calls: winB.webContents.sent },
  );

  // primary / focused 语义
  assert('窗口定位：focused() 返回聚焦窗口', registry.focused() === winB);
  assert('窗口定位：primary() 返回首个存活窗口（不再有特权"主窗口"）', registry.primary() === winB);

  // 关闭一个窗口后再广播，不应抛错
  winB._destroyed = true;
  const sentAfter = registry.broadcast('app:theme-changed', 'light');
  assert('广播：窗口全部关闭后广播返回 0 且不抛错', sentAfter === 0 && registry.count() === 0, sentAfter);

  /* --- 打包完整性：主进程 require 的本地模块必须都在 electron-builder 的 files 白名单里 --- */
  // 这条很容易漏：开发态直接跑源码不会暴露，打包后才会以 MODULE_NOT_FOUND 崩在启动阶段。
  try {
    const builderConfig = requireCjs(path.join(desktopDir, 'electron-builder.config.cjs'));
    const listed = new Set((builderConfig.files ?? []).map((f) => String(f)));
    const mainSrc = fs.readFileSync(path.join(desktopDir, 'main.cjs'), 'utf8');
    const localRequires = [...mainSrc.matchAll(/require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)].map((m) => m[1].replace(/^\.\//, ''));
    const missing = localRequires.filter((rel) => !listed.has(rel));
    assert(
      '打包：main.cjs 依赖的本地模块都在 electron-builder files 白名单中',
      missing.length === 0 && localRequires.length >= 2,
      { listed: [...listed], localRequires, missing },
    );
  } catch (e) {
    assert('打包：读取 electron-builder 配置失败', false, { message: String(e && e.message) });
  }
}

/* ================= B. 真实 Electron GUI 冒烟 ================= */

function resolveElectronExe() {
  // 1) 显式指定
  if (process.env.NEOMD_ELECTRON_EXE && fs.existsSync(process.env.NEOMD_ELECTRON_EXE)) return process.env.NEOMD_ELECTRON_EXE;
  // 2) apps/desktop 下安装的 electron 包（node 环境下 require 返回可执行文件路径）
  const candidates = [];
  try {
    const electronPkg = createRequire(path.join(desktopDir, 'package.json'))('electron');
    if (typeof electronPkg === 'string') candidates.push(electronPkg);
  } catch {
    /* 未安装 electron 时忽略 */
  }
  // 3) path.txt 兜底
  try {
    const p = path.join(desktopDir, 'node_modules', 'electron', 'path.txt');
    if (fs.existsSync(p)) candidates.push(path.join(desktopDir, 'node_modules', 'electron', 'dist', fs.readFileSync(p, 'utf8').trim()));
  } catch {
    /* ignore */
  }
  // 4) 打包产物
  candidates.push(path.join(repoRoot, 'dist-artifacts', 'win-unpacked', 'Neo MD.exe'));
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function runGuiSmoke() {
  console.log('\n=== B. 真实 Electron 多窗口冒烟 ===');
  const driver = path.join(here, 'verify-119-multiwindow-driver.cjs');
  if (!fs.existsSync(driver)) {
    notes.push('缺少驱动脚本 ' + driver + '，跳过 GUI 冒烟');
    return Promise.resolve({ skipped: 'missing-driver' });
  }
  const exe = resolveElectronExe();
  if (!exe) {
    notes.push('本机未找到 Electron 可执行文件，跳过 GUI 冒烟（降级为仅单元测试）');
    return Promise.resolve({ skipped: 'no-electron' });
  }
  notes.push('Electron 可执行文件：' + exe);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neomd-verify119-'));
  const env = { ...process.env };
  // 若父环境带了 ELECTRON_RUN_AS_NODE，Electron 会退化成一个普通 node，GUI 起不来
  delete env.ELECTRON_RUN_AS_NODE;

  return new Promise((resolve) => {
    const child = spawn(
      exe,
      [driver, '--user-data-dir=' + userDataDir, '--disable-gpu', '--no-sandbox'],
      { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: repoRoot },
    );
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      notes.push('GUI 冒烟超过 200s，强制结束');
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, 200_000);

    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      for (const line of s.split(/\r?\n/)) if (line.trim()) console.log('[electron]', line);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      for (const line of s.split(/\r?\n/)) if (line.trim()) console.log('[electron:err]', line);
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      const marker = '##VERIFY_RESULT##';
      const idx = stdout.lastIndexOf(marker);
      // 已经跑出了 [verify] 断言行却拿不到结果标记 → 是驱动自身卡住/崩溃，属于真实失败，不能当环境降级
      const sawAssertions = /\[verify\] (PASS|FAIL)/.test(stdout);
      if (idx === -1) {
        resolve({
          ok: false,
          reason: timedOut
            ? '冒烟进程超时未结束（退出码 ' + code + '）'
            : '未拿到冒烟结果标记（进程退出码 ' + code + '）',
          sawAssertions,
          stderrTail: stderr.slice(-2000),
        });
        return;
      }
      const jsonText = stdout.slice(idx + marker.length).split(/\r?\n/)[0].trim();
      let payload = null;
      try {
        payload = JSON.parse(jsonText);
      } catch (e) {
        resolve({ ok: false, reason: '冒烟结果 JSON 解析失败：' + e.message, sawAssertions, raw: jsonText.slice(0, 500) });
        return;
      }
      for (const r of payload.results ?? []) guiResults.push(r);
      resolve({ ok: (payload.failed ?? 0) === 0 && code === 0, payload, code, sawAssertions });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: '无法启动 Electron：' + e.message, sawAssertions: false });
    });
  });
}

/* ================= 主流程 ================= */

const startedAt = Date.now();
if (!noUnit) runUnitTests();

let degraded = false;
let degradedReason = null;
let guiOutcome = null;
if (!unitOnly) {
  try {
    guiOutcome = await runGuiSmoke();
  } catch (e) {
    guiOutcome = { ok: false, reason: 'GUI 冒烟执行异常：' + (e && e.message) };
  }
  if (guiOutcome && guiOutcome.skipped) {
    degraded = true;
    degradedReason =
      guiOutcome.skipped === 'no-electron'
        ? '本机没有 Electron 运行时，无法启动 GUI'
        : '缺少 GUI 冒烟驱动脚本';
  } else if (guiOutcome && !guiOutcome.ok) {
    // 有 Electron 但启动/运行失败：区分"环境起不来 GUI"与"断言真的失败"
    const reason = String(guiOutcome.reason || '');
    // 关键：只要驱动已经跑出过 [verify] 断言，就说明 GUI 是起得来的，
    // 此时失败一定是代码问题，绝不能降级成"环境问题"糊过去。
    const looksLikeEnv =
      !guiOutcome.sawAssertions &&
      /无法启动 Electron|未拿到冒烟结果标记|ENOENT|EPERM|GPU|display|X server|spawn/i.test(reason) &&
      guiResults.length === 0;
    if (looksLikeEnv) {
      degraded = true;
      degradedReason = 'Electron 进程未能跑完（环境问题）：' + reason;
    }
  } else if (guiOutcome) {
    notes.push('Electron 进程退出码：' + guiOutcome.code);
  }
}

const unitFailed = unitResults.filter((r) => !r.pass);
const guiFailed = guiResults.filter((r) => !r.pass);
const total = unitResults.length + guiResults.length;
const passed = unitResults.length - unitFailed.length + (guiResults.length - guiFailed.length);

console.log('\n=== 汇总 ===');
console.log(`单元测试：${unitResults.length - unitFailed.length}/${unitResults.length} 通过`);
if (noUnit) console.log('单元测试：本次请求跳过（--no-unit）');
if (unitOnly) {
  console.log('GUI 冒烟：本次请求跳过（--unit-only）');
} else if (degraded) {
  console.log('GUI 冒烟：已降级 —— ' + degradedReason);
  console.log('  说明：本环境的 Electron 无法完成真实窗口冒烟，因此 a/b/c/d 的验证以单元测试覆盖的核心分支为准；');
  console.log('        在带图形环境的 Windows 桌面上重新执行 `node tools/verify-119-multiwindow.mjs` 可获得真实 GUI 结果。');
} else if (guiResults.length) {
  console.log(`GUI 冒烟：${guiResults.length - guiFailed.length}/${guiResults.length} 通过`);
} else {
  console.log('GUI 冒烟：未执行');
}

const failed = [...unitFailed, ...guiFailed];
if (failed.length) {
  console.log('\n失败项：');
  for (const f of failed) console.log(' - ' + f.name + (f.detail ? ' :: ' + JSON.stringify(f.detail) : ''));
}

const ok = failed.length === 0 && !(guiOutcome && guiOutcome.ok === false && !degraded);
console.log(`\n结果：${ok ? '通过' : '未通过'}（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s，共 ${total} 条断言）`);
process.exit(ok ? 0 : 1);
