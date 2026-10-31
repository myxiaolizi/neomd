/**
 * 1.4.0 端到端取证：把真实市场插件发布到本机 API，供 UI 安装链路取证使用。
 *
 * 只在本地测试库运行；不提交、不改版本号。
 * 用法：node tools/re14-seed-market.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const API = 'http://127.0.0.1:3200';
const REPO = path.resolve(import.meta.dirname, '..');

async function post(url, body, token) {
  const res = await fetch(`${API}${url}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const login = await post('/api/auth/login', { username: 'admin', password: '6655' });
if (!login.json?.ok) {
  console.error('登录失败', login.status, JSON.stringify(login.json));
  process.exit(1);
}
const token = login.json.data.accessToken;
console.log('登录成功');

/** 要上架的样本（都是 plugin-market/plugins 里的真实文件） */
const samples = [
  { file: '13-heading-auto-number.js', pluginId: 'heading-auto-number', name: '标题自动编号', category: 'writing', icon: 'type', description: '为二级与三级标题补全或纠正多级序号，一键规范文档层级编号。' },
  { file: '16-blank-line-sweep.js', pluginId: 'blank-line-sweep', name: '空行清理', category: 'writing', icon: 'layout', description: '清理多余空行与行尾空格，保持文档排版整洁。' },
  { file: '11-word-count-badge.js', pluginId: 'word-count-badge', name: '字数仪表盘', category: 'writing', icon: 'chart', description: '统计字数、词数、段落数与预计阅读时长，生成字数仪表盘区块。' },
];

for (const s of samples) {
  const codeJs = fs.readFileSync(path.join(REPO, 'plugin-market/plugins', s.file), 'utf8');
  const r = await post(
    '/api/plugins',
    {
      pluginId: s.pluginId,
      name: s.name,
      version: '1.0.0',
      category: s.category,
      icon: s.icon,
      description: s.description,
      readmeMd: `# ${s.name}\n\n${s.description}`,
      codeJs,
    },
    token,
  );
  console.log(`${s.pluginId}: status=${r.status} ${r.json?.ok ? `ok status=${r.json.data?.plugin?.status}` : JSON.stringify(r.json?.error ?? r.json)}`);
}

const market = await fetch(`${API}/api/plugins/market?page=1&pageSize=20`).then((x) => x.json());
console.log('\n市场现状:', {
  items: market?.data?.items?.length ?? market?.items?.length ?? 0,
  total: market?.data?.total ?? market?.total,
});
