/**
 * 1.2.1 缺陷2 硬证据：证明「focus / visibilitychange / 60s 版本轮询」这条自动拉取链路
 * **从未被安装**，所以任务描述里假设的触发机制在 1.2.0 实装里根本不存在。
 *
 * ## 为什么这个证据重要
 *
 * 缺陷2 的既有代码注释与多个版本的修复都建立在「focus 时拉取 → 云端旧值覆盖本地」
 * 这一假设上（见 stores/settings.ts 里 requestCloudPull / AUTO_PULL_THROTTLE_MS /
 * CLOUD_VERSION_POLL_MS 的注释）。如果那条链路其实没接上，那么所有基于它的
 * 推理与回归结论都是错的 —— 真实触发点必须重新定位。
 *
 * ## 本脚本给出的两类证据
 *
 * A. **静态证据**（grep 结果，脚本里用 fs 扫描源码再打印一次，保证可复现）：
 *    `installCloudAutoPull` 是全仓库唯一注册 focus/visibilitychange/轮询的地方，
 *    但它只有定义、**没有调用**，也**没有从 store 导出**。
 *
 * B. **运行时证据**（真实浏览器打点）：
 *    在页面里 hook window.fetch，清空计数后依次派发 focus / visibilitychange，
 *    再静等 65s（覆盖 60s 轮询周期），期间应当**没有任何** /api/settings 请求；
 *    随后打开设置页，应当立刻出现 GET /api/settings（证明真实触发点是「打开设置页」）。
 *
 * 用法：node tools/re121-evidence-autopull.mjs
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { chromium } = playwright;
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const OUT_DIR = path.join(here, 'shots-121-settings');
fs.mkdirSync(OUT_DIR, { recursive: true });

const BASE = process.env.RE121_BASE || 'http://127.0.0.1:5178';
const BROWSER =
  process.env.SMOKE_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER = process.env.SMOKE_USER || 'admin';
const PASS = process.env.SMOKE_PASS || '6655';

let pass = 0;
const fails = [];
function check(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    fails.push(`${label}${extra ? ` \u2192 ${extra}` : ''}`);
    console.log(`  \u2717 ${label}${extra ? ` \u2192 ${extra}` : ''}`);
  }
}

/* ----------------------------- A. 静态证据 ----------------------------- */
console.log('=== A. 静态证据：installCloudAutoPull 是「死代码」 ===');

const SETTINGS_TS = path.join(repoRoot, 'apps', 'web', 'src', 'stores', 'settings.ts');
const src = fs.readFileSync(SETTINGS_TS, 'utf8');
const srcLines = src.split(/\r?\n/);

/** 扫描 apps / packages / services 下所有源码，统计某标识符出现位置 */
function scanIdentifier(name) {
  const hits = [];
  /*
   * 只扫源码目录（每个 app / package / service 下的 src 子目录）。
   * 为什么必须收窄：仓库里有 `apps/web/dist-*`、`apps/android/.../assets/public/assets`
   * 这类**构建产物**（压缩后的 bundle），它们里面同样会命中函数名，
   * 混进来会让「出现几次」这个结论失真，日志也会被几十万字符的单行刷爆。
   * （注意：这里不能写带星号斜杠的 glob，会提前结束块注释。）
   */
  const roots = [];
  for (const group of ['apps', 'packages', 'services']) {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(repoRoot, group), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const srcDir = path.join(repoRoot, group, e.name, 'src');
      if (fs.existsSync(srcDir)) roots.push(srcDir);
    }
  }
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'releases') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|vue|js|mjs)$/.test(e.name)) continue;
      let text = '';
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      text.split(/\r?\n/).forEach((line, i) => {
        if (line.includes(name)) {
          hits.push({
            file: path.relative(repoRoot, full),
            line: i + 1,
            // 截断：防止极端长行把日志刷爆
            text: line.trim().slice(0, 160),
          });
        }
      });
    }
  };
  for (const r of roots) walk(r);
  return hits;
}

const installHits = scanIdentifier('installCloudAutoPull');
console.log(`\n  「installCloudAutoPull」共出现 ${installHits.length} 处：`);
for (const h of installHits) console.log(`    ${h.file}:${h.line}: ${h.text}`);
check(
  installHits.length === 1 && /function installCloudAutoPull/.test(installHits[0].text),
  '全仓库只有 1 处出现，且是函数定义本身（0 次调用）',
  `实际 ${installHits.length} 处`,
);

/* 定义体里那三行是 focus / visibilitychange / 轮询的唯一注册点 */
const fnStart = srcLines.findIndex((l) => l.includes('function installCloudAutoPull'));
const fnBody = srcLines.slice(fnStart, fnStart + 16).join('\n');
console.log('\n  该函数体（唯一注册点）：');
fnBody.split('\n').forEach((l, i) => console.log(`    ${fnStart + 1 + i}: ${l.trim()}`));
check(fnBody.includes("addEventListener('focus'"), "focus 监听只在这里注册");
check(fnBody.includes("addEventListener('visibilitychange'"), 'visibilitychange 监听只在这里注册');
check(fnBody.includes('setInterval') && fnBody.includes('pollCloudVersion'), '60s 版本轮询只在这里启动');

/* 是否从 store 导出 */
const returnIdx = srcLines.reduce((acc, l, i) => (l.trim() === 'return {' ? i : acc), -1);
const returnBlock = srcLines.slice(returnIdx).join('\n');
check(
  !returnBlock.includes('installCloudAutoPull,'),
  '未被 store 导出（外部无法调用，进一步证明不可达）',
);

console.log('\n  对比：真正被调用的拉取入口');
for (const name of ['requestCloudPull', 'pullCloudSettings']) {
  const hits = scanIdentifier(`.${name}(`).filter((h) => !h.file.endsWith('settings.ts'));
  console.log(`    ${name} 的外部调用：`);
  for (const h of hits) console.log(`      ${h.file}:${h.line}: ${h.text}`);
}

/* ----------------------------- B. 运行时证据 ----------------------------- */
console.log('\n=== B. 运行时证据：focus / visibilitychange / 65s 内零拉取 ===');

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: USER, password: PASS }),
});
if (!loginRes.ok) throw new Error(`登录失败 HTTP ${loginRes.status}`);
const d = (await loginRes.json()).data ?? {};
const token = d.accessToken ?? d.access_token;
const refresh = d.refreshToken ?? d.refresh_token ?? '';

const browser = await chromium.launch({
  executablePath: BROWSER,
  // `--disable-gpu` 必需：本脚本要静等 65s，本机无头 Chrome 不带它约 30s 后崩溃
  // （见 re121-settings-font-repro.mjs 的注释说明）
  args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

/* hook fetch 记录所有 /api/settings* 请求（页面初始化脚本，先于应用加载） */
await page.addInitScript(() => {
  window.__re121Net = [];
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? '';
    if (url.includes('/api/settings')) {
      window.__re121Net.push({
        t: performance.now(),
        method: args[1]?.method || 'GET',
        path: url.replace(location.origin, ''),
      });
    }
    return origFetch.apply(this, args);
  };
});
await page.addInitScript(
  ([a, r]) => {
    localStorage.setItem('neomd.access', a);
    if (r) localStorage.setItem('neomd.refresh', r);
  },
  [token, refresh],
);

try {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(6000);

  const bootNet = await page.evaluate(() => window.__re121Net);
  console.log(`  启动阶段（不含设置页）的 /api/settings 请求 ${bootNet.length} 条：`);
  for (const r of bootNet) console.log(`    ${r.method} ${r.path}`);

  /* 清空计数，然后只派发 focus / visibilitychange，不再做任何交互 */
  await page.evaluate(() => {
    window.__re121Net.length = 0;
  });
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(4000);
  const afterFocus = await page.evaluate(() => window.__re121Net);
  console.log(`\n  派发 focus + visibilitychange 后 4s 内的请求 ${afterFocus.length} 条：`);
  for (const r of afterFocus) console.log(`    ${r.method} ${r.path}`);
  check(afterFocus.length === 0, 'focus / visibilitychange 不触发任何拉取（监听器未安装）', `${afterFocus.length} 条`);

  /* 静等 65s，覆盖 60s 轮询周期 */
  console.log('\n  静等 65s（覆盖 60s 版本轮询周期），期间不做任何交互…');
  await page.evaluate(() => {
    window.__re121Net.length = 0;
  });
  await page.waitForTimeout(65_000);
  const afterIdle = await page.evaluate(() => window.__re121Net);
  console.log(`  65s 内出现的请求 ${afterIdle.length} 条：`);
  for (const r of afterIdle) console.log(`    ${r.method} ${r.path}`);
  check(
    !afterIdle.some((r) => r.path.includes('/api/settings/version')),
    '65s 内没有 /api/settings/version 轮询（setInterval 未启动）',
    JSON.stringify(afterIdle.map((r) => r.path)),
  );

  /* 真实触发点：打开设置页 */
  await page.evaluate(() => {
    window.__re121Net.length = 0;
  });
  await page.keyboard.press('Control+Comma');
  await page.waitForTimeout(3000);
  const afterOpen = await page.evaluate(() => window.__re121Net);
  console.log(`\n  打开设置页后的请求 ${afterOpen.length} 条：`);
  for (const r of afterOpen) console.log(`    ${r.method} ${r.path}`);
  check(
    afterOpen.some((r) => r.path.includes('/api/settings?platform=')),
    '打开设置页 → 立即 GET /api/settings（这才是真实触发点）',
    JSON.stringify(afterOpen.map((r) => r.path)),
  );

  await page.screenshot({ path: path.join(OUT_DIR, 'evidence-autopull.png') });
  fs.writeFileSync(
    path.join(OUT_DIR, 'evidence-autopull.json'),
    JSON.stringify({ installHits, bootNet, afterFocus, afterIdle, afterOpen }, null, 2),
  );
} catch (e) {
  fails.push(`脚本异常：${e?.message ?? e}`);
  console.log(`\n[ERROR] ${e?.stack ?? e}`);
} finally {
  console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
  if (fails.length) for (const f of fails) console.log(`  - ${f}`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
}
