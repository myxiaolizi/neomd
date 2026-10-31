// 独立取证员 D —— 数据层实测（HTTP，只读 GET；仅登录一次）。
import { createRequire } from 'node:module';
import fs from 'node:fs';
const apiRequire = createRequire('C:/Data/BAC/neomd/neomd-V1/services/api/package.json');
// eslint-disable-next-line no-unused-vars
const _mysql = apiRequire('mysql2/promise'); // 保留锚定能力，本轮仅用 HTTP

const API = 'http://127.0.0.1:3200';
const OUT = { sampledAt: new Date().toISOString() };

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: '6655' }),
  });
  const loginBody = await login.json();
  const token = loginBody?.data?.accessToken ?? loginBody?.accessToken ?? loginBody?.token ?? null;
  OUT.login = { status: login.status, user: loginBody?.data?.user ?? loginBody?.user, hasToken: Boolean(token) };

  const get = async (p) => {
    const r = await fetch(`${API}${p}`, { headers: { authorization: `Bearer ${token}` } });
    const t = await r.text();
    let b; try { b = JSON.parse(t); } catch { b = t; }
    return { status: r.status, body: b };
  };

  // 问题1：云端 settings 里的 naming
  const sWeb = await get('/api/settings?platform=web');
  const sDesc = await get('/api/settings?platform=desktop');
  const sNone = await get('/api/settings');
  for (const [k, v] of [['web', sWeb], ['desktop', sDesc], ['none', sNone]]) {
    const data = v.body?.data ?? v.body ?? null;
    const payload = data?.payload ?? null;
    const naming = payload?.global?.naming ?? payload?.naming ?? null;
    OUT[`p1_settings_${k}`] = {
      status: v.status,
      version: data?.version,
      naming,
      payloadKeys: payload ? (payload.global ? Object.keys(payload.global) : Object.keys(payload)) : null,
      rawSnippet: JSON.stringify(naming),
    };
  }

  // 问题2：服务端仓库清单（HTTP 投影，与 DB 交叉校验）
  const vaults = await get('/api/vaults');
  const vaultData = vaults.body?.data ?? vaults.body ?? {};
  OUT.p2_vaults_http = {
    status: vaults.status,
    count: vaultData?.vaults?.length,
    vaults: vaultData?.vaults ?? vaultData,
  };

  // 问题3：后台客户端分发清单
  const rel = await get('/api/admin/releases');
  OUT.p3_admin_releases = { status: rel.status, body: rel.body?.data ?? rel.body };
  const dl = await fetch(`${API}/api/download/list`);
  const dlBody = await dl.json();
  OUT.p3_download_list = { status: dl.status, body: dlBody?.data ?? dlBody };

  // 问题4：后台插件列表（page=1&pageSize=20）
  const plg = await get('/api/admin/plugins?page=1&pageSize=20');
  const plgData = plg.body?.data ?? plg.body ?? {};
  OUT.p4_admin_plugins = {
    status: plg.status,
    itemCount: plgData?.items?.length,
    hasPage: plgData && 'page' in plgData,
    hasPageSize: plgData && 'pageSize' in plgData,
    hasTotal: plgData && 'total' in plgData,
    page: plgData?.page, pageSize: plgData?.pageSize, total: plgData?.total,
    sample: (plgData?.items ?? []).slice(0, 20).map((i) => ({ id: i.id, pluginId: i.pluginId, name: i.name, version: i.version, status: i.status, downloads: i.downloads })),
  };

  console.log(JSON.stringify(OUT, null, 2));
  fs.writeFileSync('C:/Data/BAC/neomd/neomd-V1/tools/re140-probe-D/data-probe-http.json', JSON.stringify(OUT, null, 2));
}
main().catch((e) => { console.error('PROBE FAILED:', e); process.exit(1); });