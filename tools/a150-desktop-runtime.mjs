/**
 * A150 桌面端实机验证（只读审计，不修改产品源码）
 * ============================================================================
 * 用 Playwright connectOverCDP 连接**已真实启动的打包产物**（dist-artifacts/win-unpacked/Neo MD.exe），
 * 在不改代码的前提下取回可复核的运行时证据：
 *   - 窗口是否真的开出来、标题/URL/自定义协议
 *   - preload 暴露面（window.NeoMD 的实际形状，不是读源码猜的）
 *   - 主进程安全基线在**运行态**的真实取值（process.contextIsolated 等只能运行时验证）
 *   - 本地文件读写链路（fs:writeText → fs:readText → fs:remove）真的落盘
 *   - 离线可用：屏蔽 md.zhengl.vip 后编辑器还能不能输入
 *   - 设置持久化（localStorage 键写入）
 *   - 截图证据
 *
 * 前置：手动或由 a150-desktop-launch.ps1 以 `--remote-debugging-port=<port>` 启动 exe。
 *        注意必须清除 ELECTRON_RUN_AS_NODE（否则 exe 按 Node 解释器跑，不创建窗口）。
 *
 * 用法：node tools/a150-desktop-runtime.mjs [--port=9417]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'docs', 'AUDIT-150');
const SHOTS = path.join(OUT, 'shots');
const RAW = path.join(OUT, 'raw');

const argPort = process.argv.find((a) => a.startsWith('--port='));
const PORT = argPort ? Number(argPort.slice(7)) : 9417;

fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(RAW, { recursive: true });

async function loadChromium() {
  const candidates = [
    'playwright-core',
    path.join(ROOT, 'apps/desktop/node_modules/playwright-core/index.mjs'),
    path.join(ROOT, 'node_modules/playwright-core/index.mjs'),
    path.join(ROOT, 'node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.mjs'),
  ];
  const errs = [];
  for (const c of candidates) {
    try {
      const mod = await import(/^[A-Za-z]:/.test(c) ? `file://${c.replace(/\\/g, '/')}` : c);
      const chromium = mod.chromium || mod.default?.chromium;
      if (chromium) return chromium;
      errs.push(`${c}: 无 chromium 导出`);
    } catch (e) {
      errs.push(`${c}: ${e.code || e.message}`);
    }
  }
  throw new Error(`无法加载 Playwright：\n  - ${errs.join('\n  - ')}`);
}

const results = {
  meta: {
    kind: 'a150-desktop-runtime',
    generatedAt: new Date().toISOString(),
    cdpPort: PORT,
    targetExe: path.join(ROOT, 'dist-artifacts', 'win-unpacked', 'Neo MD.exe'),
  },
  steps: {},
  errors: [],
};

function rec(name, value) {
  results.steps[name] = value;
  console.log(`  [ok] ${name}`, typeof value === 'object' ? JSON.stringify(value).slice(0, 220) : value);
}

async function main() {
  const chromium = await loadChromium();
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  } catch (e) {
    throw new Error(`connectOverCDP 失败（exe 没带 --remote-debugging-port 启动？）：${e.message}`);
  }

  const contexts = browser.contexts();
  const allPages = contexts.flatMap((c) => c.pages());
  rec('windowCount', allPages.length);
  const page = allPages[0];
  if (!page) throw new Error('没有找到页面，桌面端可能未成功加载 webdist');

  // ---- 1. 窗口与协议 ----
  rec('window', {
    title: await page.title(),
    url: page.url(),
    readyState: await page.evaluate(() => document.readyState),
  });

  await page.waitForTimeout(1500);

  // ---- 2. preload 暴露面（运行时真实形状） ----
  const bridgeShape = await page.evaluate(() => {
    const nm = window.NeoMD;
    if (!nm) return { present: false };
    const shape = (obj, depth) => {
      const out = {};
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (depth > 0 && v && typeof v === 'object' && !Array.isArray(v)) out[k] = shape(v, depth - 1);
        else out[k] = typeof v;
      }
      return out;
    };
    return {
      present: true,
      env: nm.env,
      version: nm.version,
      topLevelKeys: Object.keys(nm),
      bridge: shape(nm.bridge || {}, 2),
      hasRequire: typeof window.require,
      hasProcess: typeof window.process,
      hasModule: typeof window.module,
    };
  });
  rec('preloadSurface', bridgeShape);

  // ---- 3. 主进程安全基线：运行态取值 ----
  // process.contextIsolated / sandboxed 只在隔离世界里可见，用 preload 的可见性反推
  const baseline = await page.evaluate(() => {
    return {
      // 渲染主世界的 Node 可见性（nodeIntegration=false 时应为 undefined）
      hasNodeRequire: typeof window.require,
      hasNodeProcess: typeof window.process,
      hasGlobalBuffer: typeof window.Buffer,
      // contextIsolation=true 时 preload 的 require 不会泄漏到主世界
      neomdBridgeIsBridgeObject: !!(window.NeoMD && window.NeoMD.bridge),
      // webSecurity 生效证据：能否从自定义协议跨源读
      origin: location.origin,
      protocol: location.protocol,
    };
  });
  rec('runtimeBaseline', baseline);

  // ---- 4. 本地文件系统链路（真实的 fs IPC） ----
  const sandboxDir = path.join(ROOT, 'docs', 'AUDIT-150', 'raw', 'fs-probe');
  fs.mkdirSync(sandboxDir, { recursive: true });
  const probeFile = path.join(sandboxDir, 'desktop-io-probe.md');
  const payload = `# A150 desktop IO probe\n\ngenerated: ${new Date().toISOString()}\n\n- 本文件由审计脚本通过 preload 的 fs API 写入\n`;
  try {
    if (fs.existsSync(probeFile)) fs.rmSync(probeFile, { force: true });
    const writeRes = await page.evaluate(
      async ([p, c]) => {
        try {
          await window.NeoMD.bridge.fs.writeText(p, c);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: String(e && e.message ? e.message : e) };
        }
      },
      [probeFile, payload],
    );
    const fileOnDisk = fs.existsSync(probeFile);
    const diskContent = fileOnDisk ? fs.readFileSync(probeFile, 'utf8') : null;
    const readBack = await page.evaluate(async (p) => {
      try {
        return { ok: true, content: await window.NeoMD.bridge.fs.readText(p) };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    }, probeFile);
    const stat = fs.existsSync(probeFile) ? fs.statSync(probeFile) : null;
    rec('fsRoundTrip', {
      writeOk: writeRes.ok,
      fileCreatedOnDisk: fileOnDisk,
      diskBytes: stat ? stat.size : 0,
      diskMatches: diskContent === payload,
      readBackOk: readBack.ok,
      readBackMatches: readBack.content === payload,
      probePath: path.relative(ROOT, probeFile),
    });

    // 清理探针文件（不污染仓库）
    await page.evaluate(async (p) => {
      try {
        await window.NeoMD.bridge.fs.remove(p);
        return true;
      } catch {
        return false;
      }
    }, probeFile);
    if (fs.existsSync(probeFile)) fs.rmSync(probeFile, { force: true });
    rec('fsCleanup', { probeRemoved: !fs.existsSync(probeFile) });
  } catch (e) {
    results.errors.push(`fsRoundTrip: ${e.message}`);
  }

  // ---- 5. 路径穿越 / 任意路径读写风险评估（只读探测，不写系统位置） ----
  try {
    const arbitrary = await page.evaluate(async () => {
      const out = { canReadArbitrary: false, sample: null, error: null };
      // 只读探测一个明确的系统路径，证明确实没有白名单。不写入。
      const sysPath = 'C:\\Windows\\win.ini';
      try {
        const t = await window.NeoMD.bridge.fs.readText(sysPath);
        out.canReadArbitrary = true;
        out.sample = String(t).slice(0, 80);
      } catch (e) {
        out.error = String(e && e.message ? e.message : e);
      }
      return out;
    });
    rec('arbitraryPathRead', arbitrary);
  } catch (e) {
    results.errors.push(`arbitraryPathRead: ${e.message}`);
  }

  // ---- 6. 离线可用（断 API 后编辑器还能不能编辑） ----
  try {
    await page.route('**/md.zhengl.vip/**', (route) => route.abort());
    await page.route('**/api/**', (route) => route.abort());
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
    await page.waitForTimeout(3000);
    const offline = await page.evaluate(() => {
      const app = document.querySelector('#app');
      return {
        appMounted: !!(app && app.children.length > 0),
        bodyTextLen: (document.body.innerText || '').length,
        hasEditorDom: !!document.querySelector('.cm-editor, .cm-content, [contenteditable="true"], textarea'),
        visibleTextSample: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
      };
    });
    rec('offlineMode', offline);
    await page.screenshot({ path: path.join(SHOTS, 'desktop-offline.png'), fullPage: false }).catch(() => null);
  } catch (e) {
    results.errors.push(`offlineMode: ${e.message}`);
  }

  // ---- 7. 恢复网络，正常态截图 + localStorage 持久化键 ----
  try {
    await page.unroute('**/md.zhengl.vip/**').catch(() => null);
    await page.unroute('**/api/**').catch(() => null);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
    await page.waitForTimeout(3500);
    await page.screenshot({ path: path.join(SHOTS, 'desktop-main.png'), fullPage: false });

    const storage = await page.evaluate(() => {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
      const interesting = keys.filter((k) => /neomd|token|refresh|access|vault|tabs|settings|device/i.test(k));
      const peek = {};
      for (const k of interesting.slice(0, 12)) {
        const v = localStorage.getItem(k) || '';
        // 只记录长度与前 40 字符，避免把凭据原样写进报告
        peek[k] = { len: v.length, head: v.slice(0, 40).replace(/[A-Za-z0-9_-]{20,}/g, '<redacted>') };
      }
      return { totalKeys: keys.length, keys, interesting, peek };
    });
    rec('localStorage', storage);
  } catch (e) {
    results.errors.push(`normalShot: ${e.message}`);
  }

  await browser.close().catch(() => null);

  const outJson = path.join(RAW, 'desktop-runtime.json');
  fs.writeFileSync(outJson, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\n[write] ${path.relative(ROOT, outJson)}`);
  if (results.errors.length) {
    console.log('[warn] errors:');
    for (const e of results.errors) console.log('  - ' + e);
  }
}

main().catch((e) => {
  results.errors.push(`fatal: ${e.message}`);
  fs.writeFileSync(path.join(RAW, 'desktop-runtime.json'), JSON.stringify(results, null, 2), 'utf8');
  console.error('[fail]', e.message);
  process.exitCode = 1;
});
