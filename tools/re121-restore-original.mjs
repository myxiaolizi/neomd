/**
 * 一次性精确还原：把 admin 的 global / platform.web appearance 写回
 * 本任务开始前的**最初生产状态**（取自 2026-10-30 17:12 的首份 DB 窥视，version 219）。
 *
 * ## 为什么需要它
 *
 * 回归脚本的 finally 是按「本次运行开始时的快照」还原的，而最早那次运行还没加
 * 「平台分组也还原」的逻辑，导致 `platform.web.appearance.fontFamily` 残留测试字体，
 * 之后每次快照都把这个残留当成原始值 —— 越还原越偏。
 * 这里用最初记录的真实值一次性归零，然后按 API 正规路径写回（走服务端分组合并，
 * 版本号由服务端递增，不会与运行中的客户端产生版本冲突）。
 *
 * 只写 appearance，不动 layout / enabledPlugins / storage / ai / sync。
 * 用法：node tools/re121-restore-original.mjs
 */
const BASE = process.env.RE121_BASE || 'http://127.0.0.1:5178';
const USER = process.env.SMOKE_USER || 'admin';
const PASS = process.env.SMOKE_PASS || '6655';

/** 最初生产状态（17:12 首份窥视，version 219） */
const ORIGINAL_GLOBAL_APPEARANCE = {
  theme: 'system',
  accent: '#1677ff',
  fontFamily: 'system-ui',
  fontSize: 24,
  lineHeight: 2,
  pageWidth: 'wide',
  showLineNumbers: false,
  spellcheck: true,
  typewriterMode: false,
  editorColorScheme: 'white',
  customEditorBg: '#ffffff',
  customEditorFg: '#1f2329',
  themePresetId: 'daylight',
  customThemes: [],
  zoom: 150,
};

const ORIGINAL_WEB_APPEARANCE = {
  theme: 'system',
  accent: '#1677FF',
  fontFamily: 'system-ui',
  fontSize: 24,
  lineHeight: 2,
  pageWidth: 'full',
  showLineNumbers: false,
  spellcheck: true,
  typewriterMode: false,
  editorColorScheme: 'gray',
  customEditorBg: '#ffffff',
  customEditorFg: '#1f2329',
  zoom: 70,
  themePresetId: 'daylight',
  customThemes: [],
};

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: USER, password: PASS }),
});
if (!loginRes.ok) throw new Error(`登录失败 HTTP ${loginRes.status}`);
const token = (await loginRes.json()).data.accessToken;
const H = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
const getJson = async (p) => (await fetch(`${BASE}${p}`, { headers: H })).json();

const GLOBAL_PROBE = '__re121_global_probe__';
const before = (await getJson(`/api/settings?platform=${GLOBAL_PROBE}`)).data;
const beforeFlat = (await getJson('/api/settings?platform=web')).data;
console.log('还原前：');
console.log('  global.fontFamily        =', JSON.stringify(before.payload?.appearance?.fontFamily));
console.log('  global.editorColorScheme =', JSON.stringify(before.payload?.appearance?.editorColorScheme));
console.log('  global.accent            =', JSON.stringify(before.payload?.appearance?.accent));
console.log('  platform.web.fontFamily  =', JSON.stringify(beforeFlat.payload?.appearance?.fontFamily));

const put = await fetch(`${BASE}/api/settings`, {
  method: 'PUT',
  headers: H,
  body: JSON.stringify({
    payload: {
      global: { appearance: ORIGINAL_GLOBAL_APPEARANCE },
      platform: { web: { appearance: ORIGINAL_WEB_APPEARANCE } },
    },
    version: Number(before.version ?? 0),
    platform: 'web',
  }),
});
console.log(`\nPUT HTTP ${put.status}`);

const after = (await getJson(`/api/settings?platform=${GLOBAL_PROBE}`)).data;
const afterFlat = (await getJson('/api/settings?platform=web')).data;
console.log('还原后：');
console.log('  global.fontFamily        =', JSON.stringify(after.payload?.appearance?.fontFamily));
console.log('  global.editorColorScheme =', JSON.stringify(after.payload?.appearance?.editorColorScheme));
console.log('  global.accent            =', JSON.stringify(after.payload?.appearance?.accent));
console.log('  platform.web.fontFamily  =', JSON.stringify(afterFlat.payload?.appearance?.fontFamily));
console.log('  version                  =', after.version);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const globalOk = same(after.payload?.appearance, ORIGINAL_GLOBAL_APPEARANCE);
const webOk = same(afterFlat.payload?.appearance, ORIGINAL_WEB_APPEARANCE);
console.log(
  `\n校验：global.appearance ${globalOk ? 'OK' : 'FAIL'} / platform.web.appearance ${webOk ? 'OK' : 'FAIL'}`,
);
if (!globalOk) {
  console.log('  global 差异：', JSON.stringify(after.payload?.appearance));
}
if (!webOk) {
  console.log('  web 差异：', JSON.stringify(afterFlat.payload?.appearance));
}
process.exit(globalOk && webOk ? 0 : 1);
