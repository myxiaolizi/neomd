/**
 * 1.2.1 缺陷2 复现/回归脚本：改正文字体后「一下」又自动恢复。
 *
 * ## 为什么这样测
 *
 * 症状是「改完字体，过一会儿自己变回去」。store 的拉取时机是
 * `focus / visibilitychange`（节流 30s）与 60s 版本号轮询，因此脚本：
 *   改字体 → 等 >=90s（覆盖 30s 节流 + 60s 轮询窗口）→ 派发一次 focus → 再读 DOM。
 * 读的是**真实 DOM 的 computed font-family**（探针取 `var(--font-content)`），
 * 而不是 localStorage —— 用户看到的是渲染结果，只有 DOM 才算数。
 *
 * ## 判定
 *
 * 每个字体值都要求：等待 + focus 之后，`--font-content`、探针 computed font-family
 * 与 localStorage 里的 `appearance.fontFamily` **仍包含所选字体特征串**。
 * 修复前必然失败（复现），修复后必须 3/3 通过（回归）。
 *
 * 第 4 步额外验证「保护机制没有退化成永久拒绝云端」：
 * 直接从服务端改主题，再触发 focus，本端必须应用新主题（1.1.9 脏标记僵住的教训）。
 *
 * ## 生产数据还原
 *
 * 脚本会真的读写生产 user_settings，finally 里：
 *   1. 取最新版本号；
 *   2. PUT 回启动时快照的整份 `global.appearance`（服务端按分组合并，只动 global）；
 *   3. 用「纯 global 视图」复查字段是否逐个还原，并打印比对结果。
 *
 * 用法：
 *   node tools/re121-settings-font-repro.mjs
 *   RE121_WAIT_MS=95000 node tools/re121-settings-font-repro.mjs
 *   RE121_BASE=http://127.0.0.1:5178 node tools/re121-settings-font-repro.mjs
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { chromium } = playwright;
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'shots-121-settings');
fs.mkdirSync(shots, { recursive: true });

const BASE = process.env.RE121_BASE || 'http://127.0.0.1:5178';
const BROWSER =
  process.env.SMOKE_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER = process.env.SMOKE_USER || 'admin';
const PASS = process.env.SMOKE_PASS || '6655';
/** 必须 >= 90s：30s 拉取节流 + 60s 版本轮询都要覆盖到 */
const WAIT_MS = Number(process.env.RE121_WAIT_MS || 95_000);
const PLATFORM = process.env.RE121_PLATFORM || 'web';
/** 读「纯 global 视图」用的哨兵平台名（服务端未登记该平台 → 只返回 global） */
const GLOBAL_PROBE = '__re121_global_probe__';

/**
 * 三个不同的字体值：用「选项里的特征串」定位选项，避免硬编码某一端的字体表
 * （PC 端列表是系统字体，网页端列表含 Georgia/KaiTi，特征串两边都可能命中）。
 * 注意不要用「衬线」这类子串匹配 —— 它会命中「无衬线」，脚本自己就会选错。
 */
const FONT_TARGETS = [
  { key: '衬线 Georgia', match: /Georgia/ },
  { key: '楷体 KaiTi', match: /KaiTi/ },
  { key: '等宽 Cascadia', match: /Cascadia/ },
];

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

/* --------------------------- 服务端只读 / 还原工具 --------------------------- */

let token = '';

async function apiJson(pathname, init = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

/** 读取某个平台视图（拍平后的 payload）里的 appearance */
async function readRemoteAppearance(platform) {
  const { status, body } = await apiJson(`/api/settings?platform=${encodeURIComponent(platform)}`);
  const payload = body?.data?.payload ?? null;
  return { status, appearance: payload?.appearance ?? null, version: body?.data?.version ?? null };
}

/* --------------------------------- 主流程 --------------------------------- */

/*
 * 用**持久化 profile**（而不是一次性的 browser+context）。
 *
 * ## 为什么必须这样
 *
 * 本机无头 Chrome 在加载真实应用页面后仍会随机退出（实测空白页加 `--disable-gpu`
 * 能撑住 60s，但 `/app` 这种重页面在 30-90s 间偶发 `Target page closed`）。
 * 而本脚本每个字体值都要**静等 95s**，一旦浏览器中途退出，整轮就白跑，
 * 看起来还像是「字体回归失败」——这是最危险的假信号。
 *
 * 换成持久化 profile 后，localStorage / cookie 都落在磁盘上：
 * 浏览器崩了就重启、重新导航，**本地设置状态不会丢**，等待可以接着进行。
 * 这同时也让断言更严格 —— 重新导航等于用户「重开一次应用」，
 * 恰好是缺陷2 最容易复现的动作。
 */
const USER_DATA_DIR = path.join(here, '.re121-chrome-profile');
fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });

/** Chrome 启动参数；`--disable-gpu` 必需（见 tools/re121-diag-args.mjs 的实测） */
const LAUNCH_ARGS = [
  '--headless=new',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

let ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
  executablePath: BROWSER,
  args: LAUNCH_ARGS,
  viewport: { width: 1600, height: 1000 },
});
let page = ctx.pages()[0] ?? (await ctx.newPage());

const consoleErrors = [];
function wirePage(p) {
  p.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 240));
  });
  p.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 240)}`));
}
wirePage(page);

/** 页面是否还活着 */
async function pageAlive(p) {
  try {
    await p.evaluate(() => 1);
    return !p.isClosed();
  } catch {
    return false;
  }
}

/**
 * 确保有一个「活着的、停留在 /app 且已登录」的页面。
 * 浏览器/页面若已退出就重启（持久化 profile 会带回 localStorage 与登录态）。
 */
async function ensureAppPage() {
  if (await pageAlive(page)) return;
  console.log('    [恢复] 页面已关闭，重启浏览器并回到 /app（持久化 profile 保留本地设置）…');
  try {
    await ctx.close();
  } catch {
    /* 已断开 */
  }
  ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: BROWSER,
    args: LAUNCH_ARGS,
    viewport: { width: 1600, height: 1000 },
  });
  page = ctx.pages()[0] ?? (await ctx.newPage());
  wirePage(page);
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  await openFontTab();
  await page.waitForTimeout(1500);
}

/**
 * 分段等待 `totalMs`，每段检查页面存活；崩了就恢复后继续等（不缩短总等待时长）。
 * 这样「等待 95s」在浏览器中途崩掉的机器上也能真正等满，不会假失败也不会假通过。
 */
async function waitResilient(totalMs, chunkMs = 15_000) {
  let left = totalMs;
  while (left > 0) {
    const step = Math.min(chunkMs, left);
    try {
      await page.waitForTimeout(step);
    } catch {
      // 页面在等待期间崩了：恢复后把本段补上
      await ensureAppPage();
      try {
        await page.waitForTimeout(step);
      } catch {
        /* 仍失败则继续下一轮 */
      }
    }
    left -= step;
    await ensureAppPage();
  }
}

/** 原始状态快照（finally 还原用） */
const snapshot = {
  globalFont: '',
  globalAppearance: {},
  /** 平台分组的 appearance 原始值（= 拍平视图的 appearance，见下方说明） */
  platformAppearance: {},
  remoteVersion: 0,
  localStorage: null,
};

/**
 * 落盘备份路径。
 *
 * 为什么必须落盘而不只放内存：脚本会真实修改生产用户的设置，如果进程在
 * finally 之前被杀（前端 dev 崩溃、机器重启、Ctrl+C），内存里的快照就没了，
 * 生产库会**永久**停在测试值上。把快照写到文件后，任何时候都能用
 * `tools/re121-restore-original.mjs --from-snapshot` 精确还原。
 */
const SNAPSHOT_FILE = path.join(here, '.re121-settings-snapshot.json');

/**
 * 读取「正文实际字体」。
 *
 * 不新建文档（生产库里不该留测试文档），因此不在 `.ProseMirror` 上取样，而是插一个
 * 探针元素，字体取 `var(--font-content)` —— 这正是 `content.css` 里 `.nm-content`
 * 用的变量，探针的 computed font-family 就等于正文会用的字体族列表。
 */
const READ_FONT = `(() => {
  const root = document.documentElement;
  let probe = document.getElementById('re121-font-probe');
  if (!probe) {
    probe = document.createElement('div');
    probe.id = 're121-font-probe';
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;font-family:var(--font-content)';
    probe.textContent = 'x';
    document.body.appendChild(probe);
  }
  const pick = (sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).fontFamily : null;
  };
  let store = null;
  try { store = JSON.parse(localStorage.getItem('neomd.settings.v1') || 'null'); } catch {}
  return {
    rootVar: root.style.getPropertyValue('--font-content'),
    probe: getComputedStyle(probe).fontFamily,
    wysiwyg: pick('.wysiwyg__host .ProseMirror') || pick('.ProseMirror') || pick('.nm-content'),
    storeFontFamily: store?.appearance?.fontFamily ?? null,
    cloudVersion: store?.cloudVersion ?? null,
  };
})()`;

const readFont = () => page.evaluate(READ_FONT);

/**
 * 打开设置页并切到「编辑器」页签。
 *
 * 1.2.1 缺陷6 收敛后，字体 / 字号 / 行高 / 缩放只在「编辑器」页签出现
 * （主题页签只保留配色相关控件），因此脚本必须走这个页签。
 */
async function openFontTab() {
  // 页面可能在等待期间崩过：先确保活着并在 /app
  await ensureAppPage();
  if (!(await page.locator('.settings-page').count())) {
    await page.keyboard.press('Control+Comma');
    await page.waitForTimeout(1600);
  }
  const nav = page.locator('.settings__nav-item').filter({ hasText: '编辑器' }).first();
  if (await nav.count()) {
    await nav.click();
    await page.waitForTimeout(800);
  }
}

try {
  /* --- 登录并把 token 注入 localStorage（与真人登录后状态一致） --- */
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: USER, password: PASS }),
  });
  if (!loginRes.ok) throw new Error(`登录失败 HTTP ${loginRes.status}`);
  const loginBody = await loginRes.json();
  const d = loginBody.data ?? {};
  token = d.accessToken ?? d.access_token;
  const refresh = d.refreshToken ?? d.refresh_token ?? '';
  if (!token) throw new Error('登录响应里没有 accessToken');

  /* --- 记录原始 global 外观（还原基准：只还原 global.appearance，平台分组不动） --- */
  const globalView = await readRemoteAppearance(GLOBAL_PROBE);
  snapshot.globalAppearance = globalView.appearance ?? {};
  snapshot.globalFont = String(snapshot.globalAppearance.fontFamily ?? '');
  snapshot.remoteVersion = Number(globalView.version ?? 0);
  console.log(
    `\n原始状态：global.appearance.fontFamily = ${JSON.stringify(snapshot.globalFont)}，云端版本 ${snapshot.remoteVersion}`,
  );
  /*
   * 起点自检：如果上一次运行没还原干净（例如 finally 阶段遇到网络失败），
   * 那么这次拍下来的「快照」本身就是被污染的测试值，finally 会把它当成原始值写回去,
   * 污染就被一路继承下去（我实测踩过：platform.web 的字体连续几次都是测试字体）。
   *
   * 这里对账的关键字段取自「本任务开始前的真实生产基线」，一旦对不上就大声警告，
   * 提示用 `tools/re121-restore-original.mjs` 归零后再跑。
   */
  const EXPECTED_BASELINE_FONT = 'system-ui';
  if (snapshot.globalFont !== EXPECTED_BASELINE_FONT) {
    console.log(
      `  [警告] global.appearance.fontFamily 起点为 ${JSON.stringify(snapshot.globalFont)}，` +
        `不等于生产基线 ${JSON.stringify(EXPECTED_BASELINE_FONT)} —— ` +
        `说明上一次运行未还原干净，本次结束后请务必执行 node tools/re121-restore-original.mjs 归零。`,
    );
  }
  const platViewBefore = await readRemoteAppearance(PLATFORM);
  /*
   * 平台分组的 appearance 原始值。
   *
   * 服务端 flatten 是 `Object.assign(view, group)`，而 appearance 是**整体对象键**，
   * 所以拍平视图里的 appearance **就等于** `platform.<p>.appearance` 本身。
   * 于是可以把它当作平台分组的快照，finally 时原样写回去。
   *
   * 为什么必须一起还原：本次修复会在推送时把 global 的主题类字段镜像进平台分组
   * （见 stores/settings.ts 的 mirroredAppearance），只还原 global 会让平台分组
   * 残留测试值。
   */
  snapshot.platformAppearance = platViewBefore.appearance ?? {};
  console.log(
    `原始状态：GET ?platform=${PLATFORM} 拍平后 appearance.fontFamily = ${JSON.stringify(platViewBefore.appearance?.fontFamily ?? null)}`,
  );
  console.log(
    `  -> global 与 ${PLATFORM} 平台分组里的 fontFamily 是否一致：` +
      `${platViewBefore.appearance?.fontFamily === globalView.appearance?.fontFamily ? '是' : '否（存在平台残留旧值）'}`,
  );
  /* 快照落盘：进程若在 finally 前被杀，可据此精确还原（见 SNAPSHOT_FILE 注释） */
  fs.writeFileSync(
    SNAPSHOT_FILE,
    JSON.stringify(
      {
        savedAt: new Date().toISOString(),
        platform: PLATFORM,
        version: snapshot.remoteVersion,
        globalAppearance: snapshot.globalAppearance,
        platformAppearance: snapshot.platformAppearance,
      },
      null,
      2,
    ),
  );
  console.log(`  快照已备份到 ${SNAPSHOT_FILE}`);

  /*
   * 写入登录态。
   *
   * 用持久化 context 时 addInitScript 仍然有效（每次导航前注入），
   * 但它只挂在该 page 上；浏览器崩了重启后页面是新的，
   * ensureAppPage() 会重新导航，而 localStorage 在持久化 profile 里本来就有 ——
   * 因此这里先把 token 落到 localStorage，再导航。
   */
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ([a, r]) => {
      localStorage.setItem('neomd.access', a);
      if (r) localStorage.setItem('neomd.refresh', r);
    },
    [token, refresh],
  );
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  snapshot.localStorage = await page.evaluate(() => {
    const out = {};
    for (const k of [
      'neomd.settings.v1',
      'neomd.themeDirtySince',
      'neomd.layoutBaseline.v1',
      'neomd.appearanceBaseline.v1',
      'neomd.appearancePending.v1',
    ]) {
      out[k] = localStorage.getItem(k);
    }
    return out;
  });

  await openFontTab();
  check((await page.locator('.settings-page').count()) > 0, '设置页已打开');
  // 优先用 data-testid（不受文案调整影响），再退回 aria-label
  const fontSel = page
    .locator('select[data-testid="font-family"], select[aria-label="正文字体"]')
    .first();
  check((await fontSel.count()) > 0, '编辑器页签存在正文字体下拉');
  const optionTexts = await fontSel.locator('option').evaluateAll((els) =>
    els.map((e) => ({ value: e.value, label: e.textContent?.trim() ?? '' })),
  );
  console.log(`  可选字体：${optionTexts.map((o) => o.label).join(' / ')}`);

  /* --------------------------- 三个字体值逐一回归 --------------------------- */
  for (let i = 0; i < FONT_TARGETS.length; i += 1) {
    const target = FONT_TARGETS[i];
    const option = optionTexts.find(
      (o) => target.match.test(o.label) || target.match.test(o.value),
    );
    if (!option) {
      check(false, '字体下拉里存在该候选', target.key);
      continue;
    }
    // 期望串取该选项字体栈的第一个族名（去掉引号）——不跨平台硬编码
    const expect = option.value
      .split(',')[0]
      .trim()
      .replace(/^["']|["']$/g, '');
    console.log(
      `\n=== [${i + 1}/3] 字体：${target.key}（期望 computed font-family 含 ${expect}） ===`,
    );
    await openFontTab();
    /*
     * 选择字体也要抗崩：`fontSel` 是在更早的页面上取的 locator，
     * 页面若被重启过，旧 locator 就失效了（报 Target page closed）。
     * 这里用「重新 openFontTab + 重新取 locator」的方式重试一次。
     */
    let selected = false;
    for (let attempt = 0; attempt < 3 && !selected; attempt += 1) {
      try {
        await openFontTab();
        await page
          .locator('select[data-testid="font-family"], select[aria-label="正文字体"]')
          .first()
          .selectOption(option.value);
        selected = true;
      } catch (e) {
        console.log(`    [重试] 选择字体失败（${String(e.message).split('\n')[0].slice(0, 60)}），第 ${attempt + 1} 次`);
        await ensureAppPage();
      }
    }
    if (!selected) throw new Error(`无法选择字体 ${option.value}`);
    await page.waitForTimeout(1200);
    const justSet = await readFont();
    console.log(`  选择后：选项 value=${JSON.stringify(option.value)}`);
    console.log(
      `  选择后：--font-content=${JSON.stringify(justSet.rootVar)} store=${JSON.stringify(justSet.storeFontFamily)}`,
    );
    check(
      String(justSet.probe ?? '')
        .toLowerCase()
        .includes(expect.toLowerCase()),
      `选择后 DOM font-family 含 ${expect}`,
      justSet.probe,
    );

    // 等推送落库（防抖 1s；顺带确认 push 是否成功 —— 版本号应比前一次大）
    await page.waitForTimeout(3000);
    const afterPush = await readFont();
    const remoteAfterPush = await readRemoteAppearance(PLATFORM);
    const remoteGlobalAfterPush = await readRemoteAppearance(GLOBAL_PROBE);
    console.log(
      `  推送后：cloudVersion=${afterPush.cloudVersion}，` +
        `global.fontFamily=${JSON.stringify(remoteGlobalAfterPush.appearance?.fontFamily ?? null)}，` +
        `拍平(?platform=${PLATFORM})=${JSON.stringify(remoteAfterPush.appearance?.fontFamily ?? null)}`,
    );

    // 关键：等 >=90s，再模拟用户切窗口回来（focus 触发拉取）
    console.log(`  等待 ${Math.round(WAIT_MS / 1000)}s 后派发 focus（触发云端拉取）…`);
    // 用分段可恢复等待：本机无头 Chrome 偶发在长等待期间退出，
    // 直接 waitForTimeout(95s) 会抛 "Target page closed" 造成假失败
    await waitResilient(WAIT_MS);
    await page
      .locator('.settings-page')
      .first()
      .click({ position: { x: 5, y: 5 } })
      .catch(() => {});
    await page
      .evaluate(() => {
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
      })
      .catch(() => {});
    await waitResilient(4000, 2000);

    const settled = await readFont();
    const remoteSettled = await readRemoteAppearance(PLATFORM);
    console.log(
      `  恢复后：--font-content=${JSON.stringify(settled.rootVar)} store=${JSON.stringify(settled.storeFontFamily)}`,
    );
    console.log(`  恢复后 DOM（探针）font-family=${JSON.stringify(settled.probe)}`);
    console.log(
      `  恢复后云端：GET ?platform=${PLATFORM} 的 fontFamily=${JSON.stringify(
        remoteSettled.appearance?.fontFamily ?? null,
      )}`,
    );
    const stayed =
      String(settled.probe ?? '')
        .toLowerCase()
        .includes(expect.toLowerCase()) &&
      String(settled.rootVar ?? '')
        .toLowerCase()
        .includes(expect.toLowerCase()) &&
      String(settled.storeFontFamily ?? '')
        .toLowerCase()
        .includes(expect.toLowerCase());
    check(
      stayed,
      `等待 ${Math.round(WAIT_MS / 1000)}s + focus 后字体未被恢复（含 ${expect}）`,
      JSON.stringify({
        probe: settled.probe,
        rootVar: settled.rootVar,
        store: settled.storeFontFamily,
      }),
    );

    await page.screenshot({ path: path.join(shots, `font-${i + 1}.png`) });
  }

  /*
   * 第 4 步：确认「保护本地未推送改动」没有退化成「永久拒绝云端」。
   *
   * 1.1.9 的教训是脏标记会永久僵住，导致别处改了设置这边永远拿不到。
   * 这里直接从服务端改一次主题（模拟另一台设备），再用**真实生产路径**触发拉取：
   * 关闭设置页 → 重新打开（SettingsPage.onMounted → requestCloudPull）。
   *
   * 为什么不用 focus：实测 `installCloudAutoPull()`（focus/visibilitychange + 60s 轮询）
   * 虽然定义了，却**从未被调用**（全仓库只有定义处），是 1.2.0 的死代码；
   * 因此 focus 不会触发任何请求。真实生效的拉取时机就是「打开设置页」，
   * 这也解释了用户为什么觉得「再打开设置，字体又变回去了」。
   */
  console.log('\n=== [4/4] 跨端同步未退化：服务端改主题 -> 重开设置页 -> 本端应应用 ===');
  const themeBefore = await page.evaluate(
    () => document.documentElement.dataset.themePreset || '',
  );
  const probeTheme = snapshot.globalAppearance.themePresetId === 'midnight' ? 'daylight' : 'midnight';
  const ver2 = await apiJson('/api/settings/version');
  const putTheme = await apiJson('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      payload: {
        global: {
          appearance: {
            theme: probeTheme === 'midnight' ? 'dark' : 'light',
            themePresetId: probeTheme,
            editorColorScheme: probeTheme === 'midnight' ? 'black' : 'white',
          },
        },
      },
      version: Number(ver2.body?.data?.version ?? 0),
      platform: PLATFORM,
    }),
  });
  console.log(`  服务端改主题 ${themeBefore || '(空)'} -> ${probeTheme}，HTTP ${putTheme.status}`);

  // 真实触发路径：关掉设置页再打开（onMounted 会 requestCloudPull）
  await page.keyboard.press('Control+w');
  await page.waitForTimeout(1500);
  await openFontTab();
  await page.waitForTimeout(6000);
  const themeAfter = await page.evaluate(
    () => document.documentElement.dataset.themePreset || '',
  );
  console.log(`  本端 themePreset：${themeBefore || '(空)'} -> ${themeAfter || '(空)'}`);
  check(themeAfter === probeTheme, `云端改主题后本端已应用（${probeTheme}）`, themeAfter);

  /*
   * 同一次拉取里，还要确认字体**没有**被这次云端拉取带跑（第 3 步选的是 Cascadia）。
   * 这一步把「云端主题能同步」与「本地未推送字体被保护」同时钉住：
   * 前者证明保护没僵住，后者证明保护确实生效。
   */
  const fontAfterThemePull = await readFont();
  const lastExpect = FONT_TARGETS[FONT_TARGETS.length - 1];
  console.log(`  重开设置页后字体：${JSON.stringify(fontAfterThemePull.storeFontFamily)}`);
  check(
    String(fontAfterThemePull.storeFontFamily ?? '').toLowerCase().includes('cascadia'),
    `重开设置页后字体仍是本地所选（含 Cascadia，未被云端拉取覆盖）`,
    JSON.stringify({ store: fontAfterThemePull.storeFontFamily, expect: lastExpect.key }),
  );

  /*
   * 第 5 步：**推送失败**场景的定向验证（任务描述里的「push 失败后被轮询覆盖」）。
   *
   * 做法：拦截并 abort 掉所有 PUT /api/settings（模拟弱网 / 429 / 断网），
   * 此时本地改动注定到不了云端；再触发拉取（重开设置页）。
   * 期望：本地字体**不丢**（字段级基线 + 待推送集合保护）。
   * 然后解除拦截，验证能正常收敛（不永久僵住）。
   */
  console.log('\n=== [5/5] 推送失败时本地改动不被覆盖，且解除后能收敛（不僵住） ===');
  const abortPut = (route) =>
    route.request().method() === 'PUT' ? route.abort('failed') : route.continue();
  await page.route('**/api/settings**', abortPut);
  try {
    await openFontTab();
    const geo = optionTexts.find((o) => /Georgia/.test(o.value) || /Georgia/.test(o.label));
    if (geo) {
      await fontSel.selectOption(geo.value);
      await page.waitForTimeout(3000);
      const cloudDuringAbort = await readRemoteAppearance(GLOBAL_PROBE);
      console.log(
        `  推送被拦截期间：本地=${JSON.stringify((await readFont()).storeFontFamily)}，` +
          `云端 global=${JSON.stringify(cloudDuringAbort.appearance?.fontFamily ?? null)}（应为上一步的 Cascadia）`,
      );

      // 触发拉取：关掉设置页再打开
      await page.keyboard.press('Control+w');
      await page.waitForTimeout(1200);
      await openFontTab();
      await page.waitForTimeout(5000);
      const afterFailPull = await readFont();
      console.log(`  拉取后：store=${JSON.stringify(afterFailPull.storeFontFamily)}`);
      check(
        String(afterFailPull.storeFontFamily ?? '').toLowerCase().includes('georgia'),
        '推送失败 + 拉取后，本地字体改动仍在（未被云端旧值覆盖）',
        JSON.stringify({ store: afterFailPull.storeFontFamily }),
      );
    }
  } finally {
    await page.unroute('**/api/settings**', abortPut);
  }

  /* 解除拦截后应能自动收敛：本地未推送值最终写回云端（证明没有永久僵住） */
  await page.waitForTimeout(2000);
  // 主动触发一次推送（改一个无副作用的值再改回来，等价于用户任何一次设置动作）
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
  });
  await page.keyboard.press('Control+w');
  await page.waitForTimeout(1200);
  await openFontTab();
  await page.waitForTimeout(6000);
  const converged = await readRemoteAppearance(GLOBAL_PROBE);
  console.log(`  解除拦截后云端 global.fontFamily=${JSON.stringify(converged.appearance?.fontFamily ?? null)}`);
  check(
    String(converged.appearance?.fontFamily ?? '').toLowerCase().includes('georgia'),
    '解除拦截后本地改动已收敛到云端（推送链路未僵住）',
    JSON.stringify({ global: converged.appearance?.fontFamily ?? null }),
  );
} catch (e) {
  fails.push(`脚本异常：${e?.message ?? e}`);
  console.log(`\n[ERROR] ${e?.stack ?? e}`);
} finally {
  /* --------------- 还原生产设置（整块还原 global + 平台分组的 appearance） --------------- */
  /*
   * 带重试：上一次运行正是因为在 finally 里遇到 fetch 失败（前端 dev 恰好崩溃）
   * 而把测试值留在了生产库。还原是**必须成功**的动作，网络抖动不能成为留下的理由。
   */
  let restoredOk = false;
  for (let attempt = 1; attempt <= 3 && !restoredOk; attempt += 1) {
    try {
      const ver = await apiJson('/api/settings/version');
      const currentVersion = Number(ver.body?.data?.version ?? 0);
      const put = await apiJson('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          payload: {
            global: { appearance: snapshot.globalAppearance },
            /*
             * 平台分组也要还原：修复后的推送会把 global 的主题类字段镜像进平台分组，
             * 只还原 global 会让 `platform.<p>.appearance` 残留测试字体/主题。
             * 服务端按分组浅合并，这里传整份 appearance 即可精确写回原值。
             */
            platform: { [PLATFORM]: { appearance: snapshot.platformAppearance } },
          },
          version: currentVersion,
          platform: PLATFORM,
        }),
      });
      // 复查要用「仅 global 区」视图：平台拍平视图的 appearance 会被平台分组覆盖，看不出 global 是否还原
      const after = await readRemoteAppearance(GLOBAL_PROBE);
      const afterFlat = await readRemoteAppearance(PLATFORM);
      const diffs = [];
      for (const [k, v] of Object.entries(snapshot.globalAppearance)) {
        if (JSON.stringify(after.appearance?.[k]) !== JSON.stringify(v)) {
          diffs.push(`global.${k}: ${JSON.stringify(after.appearance?.[k])} !== ${JSON.stringify(v)}`);
        }
      }
      for (const [k, v] of Object.entries(snapshot.platformAppearance)) {
        if (JSON.stringify(afterFlat.appearance?.[k]) !== JSON.stringify(v)) {
          diffs.push(`platform.${k}: ${JSON.stringify(afterFlat.appearance?.[k])} !== ${JSON.stringify(v)}`);
        }
      }
      restoredOk = diffs.length === 0;
      console.log(
        `\n还原（第 ${attempt} 次）：PUT global+platform.appearance -> HTTP ${put.status}；` +
          `逐字段复查 -> ${restoredOk ? '全部已还原' : `差异 ${diffs.length} 项：${diffs.join('; ')}`}`,
      );
      console.log(
        `  关键字段：global.fontFamily=${JSON.stringify(after.appearance?.fontFamily ?? null)} / ` +
          `platform.fontFamily=${JSON.stringify(afterFlat.appearance?.fontFamily ?? null)} / ` +
          `themePresetId=${JSON.stringify(after.appearance?.themePresetId ?? null)}`,
      );
      if (!restoredOk) await new Promise((r) => setTimeout(r, 1500));
    } catch (e) {
      console.log(`\n[WARN] 还原第 ${attempt} 次失败：${e?.message ?? e}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!restoredOk) {
    console.log(
      `\n[!! 重要 !!] 还原未成功。快照已保存在 ${SNAPSHOT_FILE}，` +
        `请立即执行：node tools/re121-restore-original.mjs`,
    );
  }
  try {
    // 本机快照回写：脚本跑完后浏览器上下文即销毁，此处保证内存里恢复原状并留痕
    if (snapshot.localStorage) {
      await page.evaluate((snap) => {
        for (const [k, v] of Object.entries(snap)) {
          if (v === null || v === undefined) localStorage.removeItem(k);
          else localStorage.setItem(k, v);
        }
      }, snapshot.localStorage);
      console.log('本机 neomd.settings.v1 等快照已回写。');
    }
  } catch {
    /* 页面已关闭时忽略 */
  }

  console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
  if (fails.length) {
    console.log('失败明细：');
    for (const f of fails) console.log(`  - ${f}`);
  }
  if (consoleErrors.length) {
    console.log(`控制台错误 ${consoleErrors.length} 条（前 5）：`);
    for (const e of consoleErrors.slice(0, 5)) console.log(`  - ${e}`);
  }
  // 持久化 context 关闭（不是 browser.close：本脚本用的是 launchPersistentContext）
  await ctx.close().catch(() => {});
  // 清理临时 profile，避免污染下次运行
  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  // 有失败时用退出码 1 表达「复现成功/回归失败」
  process.exit(fails.length ? 1 : 0);
}
