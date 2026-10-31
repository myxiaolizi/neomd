/**
 * Neo MD 1.4 · 后台组 T2 端到端验收脚本（真实请求，不打桩）。
 *
 * 覆盖 task-6 的四项需求：
 *   A. 插件市场编辑：改名称+描述+代码 → 保存 → **客户端市场接口立即可见** → 改回原值（自清理）
 *   B. 插件市场翻页：造 25 条临时数据 → 断言第 1 页 20 条 / 第 2 页 5 条 / total / hasMore / 页码切换
 *   C. 客户端分发：断言 currentVersion === services/api/package.json 的 version，
 *      且历史版本、大小、时间、下载次数、可下载性、OSS/本地来源分布全部有值
 *   D. 用户管理 5 项：封禁（含原因与到期）/ 解封 / 批量操作 / 登录记录 / 数据概览 / 角色 / CSV 导出
 *
 * 测试纪律（生产库有真实用户数据）：
 *  - 用户类测试一律**新建临时用户**，finally 里 DELETE 清理，绝不删真实用户；
 *  - 插件类测试一律**新建临时插件**，finally 里 DELETE 清理；
 *  - 若临时插件被编辑过，先断言客户端可见，再清理；
 *  - 所有断言失败即退出码 1。
 *
 * 用法：
 *   node tools/re14-admin-verify.mjs
 *   API_BASE=http://127.0.0.1:3211 node tools/re14-admin-verify.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const API_BASE = (process.env.API_BASE || 'http://127.0.0.1:3211').replace(/\/+$/, '');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '6655';

let pass = 0;
const failures = [];

function check(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}${extra ? `  [${extra}]` : ''}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${extra ? `  [${extra}]` : ''}`);
  }
}

function section(title) {
  console.log(`\n${'='.repeat(70)}\n${title}\n${'='.repeat(70)}`);
}

let accessToken = '';

async function login() {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: ADMIN_USER, password: ADMIN_PASS }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) throw new Error(`登录失败 HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  accessToken = json.data.accessToken;
  return json.data.user;
}

async function call(method, p, body, extraHeaders = {}) {
  const res = await fetch(`${API_BASE}${p}`, {
    method,
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** 从 services/api/package.json 读版本（断言 C 的期望值 = 唯一事实源） */
function apiPackageVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'services', 'api', 'package.json'), 'utf8'));
  return String(pkg.version);
}

/* 临时数据登记表（finally 里统一清理） */
const tempPluginIds = [];
const tempUserIds = [];

const me = await login();
console.log(`登录成功：${me.username} (id=${me.id}, role=${me.role})，API=${API_BASE}`);

try {
  /* ================================================================== */
  /* A. 插件市场编辑                                                     */
  /* ================================================================== */
  section('A. 插件市场编辑：改元数据+代码 → 保存 → 客户端市场可见 → 改回');

  const stamp = Date.now();
  const tempPluginId = `re14tmp-${stamp}`;
  const originalCode = `export default {
  id: '${tempPluginId}',
  name: '临时验证插件',
  version: '1.0.0',
  setup(api) {
    api.registerCommand({
      id: 'tmp.noop',
      title: '占位命令',
      run() { api.notify('原始版本'); }
    });
  }
};`;

  // A1. 建临时插件
  let r = await call('POST', '/api/plugins', {
    pluginId: tempPluginId,
    name: '临时验证插件',
    version: '1.0.0',
    category: 'writing',
    icon: 'layers',
    description: '自动化验收用的临时插件，测试结束会删除。',
    readmeMd: '# 临时插件\n\n仅用于 1.4.0 后台编辑功能验收。',
    codeJs: originalCode,
  });
  check(r.status === 200 || r.status === 201, 'A1 创建临时插件', `HTTP ${r.status}`);
  const tempId = r.json?.data?.plugin?.id;
  if (tempId) tempPluginIds.push(tempId);
  check(typeof tempId === 'number', 'A1b 拿到插件 id', `id=${tempId}`);

  // A2. 客户端市场（未传分页 = 1.3.1 行为）里能看到原始值
  r = await call('GET', '/api/plugins/market');
  const beforeMarket = (r.json?.data?.items ?? []).find((x) => x.pluginId === tempPluginId);
  check(Boolean(beforeMarket), 'A2 客户端市场可见临时插件');
  check(beforeMarket?.name === '临时验证插件', 'A2b 市场里的名称 = 原始值', beforeMarket?.name);

  // A3. 后台读单个插件（编辑弹窗取最新值）
  r = await call('GET', `/api/admin/plugins/${tempId}`);
  check(r.status === 200 && r.json?.data?.plugin?.codeJs === originalCode, 'A3 后台 GET /api/admin/plugins/:id 返回完整代码', `HTTP ${r.status}`);

  // A4. 非法代码必须被拒绝（语法错误）
  r = await call('PUT', `/api/admin/plugins/${tempId}`, { codeJs: 'export default { name: "坏代码" ' });
  check(r.status === 400, 'A4a 语法错误代码被拒绝', `HTTP ${r.status} code=${r.json?.error?.code}`);
  check(r.json?.error?.code === 'PLUGIN_CODE_INVALID', 'A4b 错误码 = PLUGIN_CODE_INVALID', r.json?.error?.code);

  // A5. 明显危险标识符必须被拒绝
  r = await call('PUT', `/api/admin/plugins/${tempId}`, { codeJs: 'const cp = require("child_process"); export default { cp };' });
  check(r.status === 400, 'A5a 含 require/child_process 的代码被拒绝', `HTTP ${r.status}`);

  // A6. 空 PUT 必须被拒绝（避免写无意义审计）
  r = await call('PUT', `/api/admin/plugins/${tempId}`, {});
  check(r.status === 400, 'A6 空 PUT 被拒绝', `HTTP ${r.status}`);

  // A7. 合法编辑：名称 + 描述 + 分类 + 标签 + 版本 + README + 代码
  const updatedCode = `export default {
  id: '${tempPluginId}',
  name: '临时验证插件（已编辑）',
  version: '1.1.0',
  setup(api) {
    api.registerCommand({
      id: 'tmp.noop',
      title: '占位命令',
      run() { api.notify('编辑后的版本'); }
    });
  }
};`;
  r = await call('PUT', `/api/admin/plugins/${tempId}`, {
    name: '临时验证插件（已编辑）',
    description: '这段描述由后台编辑功能改写，用于验证保存后客户端立即可见。',
    category: 'visual',
    version: '1.1.0',
    tags: ['验收', '临时', '验收'],
    readmeMd: '# 临时插件（已编辑）\n\nREADME 也一起被后台改写了。',
    codeJs: updatedCode,
  });
  check(r.status === 200, 'A7 合法编辑保存成功', `HTTP ${r.status}`);
  const changes = r.json?.data?.changes ?? {};
  check(r.json?.data?.plugin?.name === '临时验证插件（已编辑）', 'A7b 响应里 name 已更新');
  check(JSON.stringify(Object.keys(changes).sort()) === JSON.stringify(['category', 'codeJs', 'description', 'name', 'readmeMd', 'tags', 'version'].sort()), 'A7c 返回的变更字段完整', Object.keys(changes).join(','));
  check(Array.isArray(changes.codeJs) === false && changes.codeJs?.lengthAfter > changes.codeJs?.lengthBefore, 'A7d 代码变更只记录长度（不落全文）', JSON.stringify(changes.codeJs));

  // A8. 客户端市场立即可见（这是需求的核心断言）
  r = await call('GET', '/api/plugins/market');
  const afterMarket = (r.json?.data?.items ?? []).find((x) => x.pluginId === tempPluginId);
  check(afterMarket?.name === '临时验证插件（已编辑）', 'A8a 客户端市场立即看到新名称', afterMarket?.name);
  check(afterMarket?.description?.includes('后台编辑功能改写'), 'A8b 客户端市场立即看到新描述');
  check(afterMarket?.version === '1.1.0', 'A8c 客户端市场立即看到新版本', afterMarket?.version);
  check(afterMarket?.category === 'visual', 'A8d 客户端市场立即看到新分类', afterMarket?.category);
  check(afterMarket?.codeJs === updatedCode, 'A8e 客户端市场立即看到新代码');
  check(JSON.stringify(afterMarket?.tags) === JSON.stringify(['验收', '临时']), 'A8f 标签去重且保序', JSON.stringify(afterMarket?.tags));
  check(afterMarket?.readmeMd?.includes('README 也一起被后台改写了'), 'A8g README 已更新');

  // A9. 审计记录已写入
  r = await call('GET', '/api/admin/audit?page=1&pageSize=50&action=admin.plugin.update');
  const auditHit = (r.json?.data?.items ?? []).find((a) => String(a.target ?? '').includes(tempPluginId));
  check(Boolean(auditHit), 'A9 审计日志记录了 admin.plugin.update', auditHit ? `id=${auditHit.id} by=${auditHit.userId}` : '未找到');
  check(Boolean(auditHit?.detail?.operatorId), 'A9b 审计含操作者 id', auditHit?.detail?.operatorId);
  // 校验失败也要留痕
  r = await call('GET', '/api/admin/audit?page=1&pageSize=50&action=admin.plugin.update_rejected');
  check((r.json?.data?.items ?? []).length > 0, 'A9c 校验被拒也写审计（admin.plugin.update_rejected）', `count=${(r.json?.data?.items ?? []).length}`);

  // A10. 改回原值（自清理的前置：验证可以无损回滚）
  r = await call('PUT', `/api/admin/plugins/${tempId}`, {
    name: '临时验证插件',
    description: '自动化验收用的临时插件，测试结束会删除。',
    category: 'writing',
    version: '1.0.0',
    tags: [],
    readmeMd: '# 临时插件\n\n仅用于 1.4.0 后台编辑功能验收。',
    codeJs: originalCode,
  });
  check(r.status === 200, 'A10 改回原值成功', `HTTP ${r.status}`);
  r = await call('GET', '/api/plugins/market');
  const restored = (r.json?.data?.items ?? []).find((x) => x.pluginId === tempPluginId);
  check(restored?.name === '临时验证插件' && restored?.codeJs === originalCode, 'A10b 客户端市场已回到原值');

  /* ================================================================== */
  /* B. 翻页 20/页                                                       */
  /* ================================================================== */
  section('B. 插件市场翻页：20/页 + total + hasMore + 页码切换');

  // B1. 造 25 条临时数据（复用同一 pluginId 前缀，finally 清理）
  const bulkPrefix = `re14page-${stamp}`;
  let created = 0;
  for (let i = 1; i <= 25; i += 1) {
    const rr = await call('POST', '/api/plugins', {
      pluginId: `${bulkPrefix}-${String(i).padStart(2, '0')}`,
      name: `翻页测试插件 ${i}`,
      version: '1.0.0',
      category: 'writing',
      description: `翻页断言用临时插件 #${i}，测试结束会删除。`,
      codeJs: `export default { id: 'p${i}', name: 'p${i}', setup() {} };`,
    });
    if (rr.status === 200 || rr.status === 201) {
      created += 1;
      if (rr.json?.data?.plugin?.id) tempPluginIds.push(rr.json.data.plugin.id);
    }
  }
  check(created === 25, 'B1 造出 25 条临时插件', `created=${created}`);

  // B2. 用 search 精确限定到这批数据，断言 20/5
  const pageSize = 20;
  r = await call('GET', `/api/plugins/market?page=1&pageSize=${pageSize}&search=${encodeURIComponent(bulkPrefix)}`);
  const p1 = r.json?.data ?? {};
  check(p1.items?.length === 20, 'B2a 第 1 页 20 条', `items=${p1.items?.length}`);
  check(p1.total === 25, 'B2b total = 25（真实 COUNT，不是页长）', `total=${p1.total}`);
  check(p1.hasMore === true, 'B2c 第 1 页 hasMore = true', `hasMore=${p1.hasMore}`);
  check(p1.page === 1 && p1.pageSize === 20, 'B2d page/pageSize 回显正确', `${p1.page}/${p1.pageSize}`);

  r = await call('GET', `/api/plugins/market?page=2&pageSize=${pageSize}&search=${encodeURIComponent(bulkPrefix)}`);
  const p2 = r.json?.data ?? {};
  check(p2.items?.length === 5, 'B3a 第 2 页 5 条', `items=${p2.items?.length}`);
  check(p2.total === 25, 'B3b 第 2 页 total 仍为 25', `total=${p2.total}`);
  check(p2.hasMore === false, 'B3c 第 2 页 hasMore = false', `hasMore=${p2.hasMore}`);

  // B4. 两页无重叠、并集 = 25
  const ids1 = (p1.items ?? []).map((x) => x.pluginId);
  const ids2 = (p2.items ?? []).map((x) => x.pluginId);
  const union = new Set([...ids1, ...ids2]);
  check(union.size === 25, 'B4a 两页并集 = 25 条（无重复、无遗漏）', `union=${union.size}`);
  check(ids1.filter((id) => ids2.includes(id)).length === 0, 'B4b 两页无交集');

  // B5. 向后兼容：不传分页参数 → 与 1.3.1 行为一致（全量）
  const allR = await call('GET', `/api/plugins/market?search=${encodeURIComponent(bulkPrefix)}`);
  check(allR.json?.data?.items?.length === 25, 'B5 不传 page/pageSize → 返回全量（向后兼容）', `items=${allR.json?.data?.items?.length}`);

  // B6. 边界：page 超界返回空数组但 total 不变（前端据此显示「没有更多」）
  r = await call('GET', `/api/plugins/market?page=99&pageSize=${pageSize}&search=${encodeURIComponent(bulkPrefix)}`);
  check(r.json?.data?.items?.length === 0 && r.json?.data?.total === 25, 'B6 超界页返回空数组 + total 不变', `items=${r.json?.data?.items?.length} total=${r.json?.data?.total}`);

  // B7. pageSize 上限保护（>100 应被夹到 100，不是报错也不是全量）
  r = await call('GET', `/api/plugins/market?page=1&pageSize=500&search=${encodeURIComponent(bulkPrefix)}`);
  check(r.json?.data?.pageSize === 100, 'B7 pageSize 被夹到上限 100', `pageSize=${r.json?.data?.pageSize}`);

  /* ================================================================== */
  /* C. 客户端分发版本                                                    */
  /* ================================================================== */
  section('C. 客户端分发：当前版本 == services/api/package.json version');

  const pkgVersion = apiPackageVersion();
  r = await call('GET', '/api/admin/releases');
  const rel = r.json?.data ?? {};
  check(r.status === 200, 'C1 /api/admin/releases 返回 200', `HTTP ${r.status}`);
  check(rel.currentVersion === pkgVersion, 'C2 currentVersion === package.json version', `api=${rel.currentVersion} pkg=${pkgVersion}`);

  const cur = rel.current ?? [];
  check(cur.length === 3, 'C3 当前版本 3 个平台文件', `count=${cur.length}`);
  check(cur.every((f) => f.version === pkgVersion), 'C4 每个当前版本文件带正确 version', cur.map((f) => f.version).join(','));
  check(cur.every((f) => f.isCurrent === true), 'C5 当前版本文件 isCurrent=true');

  /*
   * C6 刻意**不**断言「当前版本所有文件都可下载」。
   *
   * 1.4.0 排查中发现一个真实生产缺陷：`NeoMD-1.3.1.apk` 存在于 OSS，但
   * `services/api/releases/` 本地目录只到 1.1.8。APK 走的是「本地直出，缺失才回退 OSS」，
   * 而阿里云禁止 APK 经 OSS 端点公开分发（ApkDownloadForbidden）—— 所以当前版本的 APK
   * 实际上**下不动**（实测 404）。这是产品缺陷，不是后台展示问题，
   * 后台的职责是**如实标记**它不可用（见 C22），而不是把它粉饰成可用。
   */
  const curApk = cur.find((f) => f.file.endsWith('.apk'));
  const curWin = cur.filter((f) => !f.file.endsWith('.apk'));
  check(curWin.every((f) => f.available === true), 'C6a 当前版本 Windows 包可用（OSS 302 直连）', curWin.map((f) => `${f.file}:${f.available}`).join(' '));
  check(
    curApk ? curApk.available === curApk.onLocal : true,
    'C6b 当前版本 APK 的可用性 === 本地是否存在（阿里云禁止 APK 走 OSS 端点）',
    curApk ? `onLocal=${curApk.onLocal} available=${curApk.available}` : '无 APK 条目',
  );

  // 与 download.js 公开清单严格同源
  const pub = await call('GET', '/api/download/list');
  const pubFiles = (pub.json?.data?.files ?? []).map((f) => f.file).sort();
  const adminCurFiles = cur.map((f) => f.file).sort();
  check(JSON.stringify(pubFiles) === JSON.stringify(adminCurFiles), 'C7 后台当前版本文件集 === /api/download/list（同一数据源）', `${adminCurFiles.join(',')} vs ${pubFiles.join(',')}`);

  // 历史版本：含大小/时间/下载次数/可下载性
  const hist = rel.history ?? [];
  check(hist.length > 0, 'C8 有历史版本', `count=${hist.length}`);
  const withSize = hist.filter((f) => Number(f.size) > 0).length;
  check(withSize > 0, 'C9 历史版本包含文件大小', `有大小=${withSize}/${hist.length}`);
  const withTime = hist.filter((f) => f.lastModified).length;
  check(withTime > 0, 'C10 历史版本包含上传/修改时间', `有时间=${withTime}/${hist.length}`);
  check(hist.every((f) => f.downloads !== undefined && typeof f.downloads === 'number'), 'C11 每个文件都有下载次数字段（数字）');
  check(hist.every((f) => typeof f.downloadable === 'boolean' && typeof f.available === 'boolean'), 'C12 每个文件都有 downloadable/available 布尔');

  // 来源区分：OSS 有 / 本地有 / 两者都有
  const sum = rel.summary ?? {};
  check(sum.onOss > 0, 'C13 summary.onOss > 0（能识别 OSS 上有的）', `onOss=${sum.onOss}`);
  check(sum.onLocal > 0, 'C14 summary.onLocal > 0（能识别本地有的）', `onLocal=${sum.onLocal}`);
  check(sum.both > 0, 'C15 summary.both > 0（能识别两者都有的）', `both=${sum.both}`);
  check(sum.localOnly > 0, 'C16 summary.localOnly > 0（识别出「只在本地、OSS 没有」—— 1.4.0 之前后台完全看不见这批）', `localOnly=${sum.localOnly}`);
  const localOnlyFiles = (rel.files ?? []).filter((f) => f.onLocal && !f.onOss).map((f) => f.file);
  console.log(`    仅本地存在（老接口看不到）：${localOnlyFiles.join(', ') || '无'}`);

  // 每个文件的三态标记必须自洽
  const inconsistent = (rel.files ?? []).filter(
    (f) => f.onOss === false && f.onLocal === false,
  );
  check(inconsistent.length === 0, 'C17 不存在「OSS 与本地都没有」的幽灵条目', `inconsistent=${inconsistent.length}`);

  // 可用性探测（HEAD，不污染下载计数）
  const dlBefore = (await call('GET', '/api/admin/releases')).json?.data?.summary?.totalDownloads ?? 0;
  // 探测一个「按分发链路规则确实可用」的文件：优先本地存在的 APK，其次 OSS 上的 zip/exe
  const probeTarget =
    (rel.files ?? []).find((f) => f.available && f.file.endsWith('.apk')) ??
    (rel.files ?? []).find((f) => f.available);
  if (probeTarget) {
    r = await call('GET', `/api/admin/releases/${encodeURIComponent(probeTarget.file)}/probe`);
    check(r.status === 200, 'C18 可用性探测接口返回 200', `HTTP ${r.status}`);
    check(
      r.json?.data?.reachable === true,
      'C19 标记为可用的文件端到端可达',
      `file=${probeTarget.file} status=${r.json?.data?.status} msg=${r.json?.data?.message}`,
    );
    const dlAfter = (await call('GET', '/api/admin/releases')).json?.data?.summary?.totalDownloads ?? 0;
    check(dlAfter === dlBefore, 'C20 HEAD 探测不增加下载计数（已排除 HEAD）', `before=${dlBefore} after=${dlAfter}`);
  }

  // C21. 静态 available 标记必须与真实探测一致（防止「后台说能下、实际 404」）
  const mismatch = [];
  for (const f of (rel.files ?? []).filter((x) => x.downloadable).slice(0, 8)) {
    const pr = await call('GET', `/api/admin/releases/${encodeURIComponent(f.file)}/probe`);
    const actual = pr.json?.data?.reachable === true;
    if (actual !== f.available) mismatch.push(`${f.file}: static=${f.available} actual=${actual}(${pr.json?.data?.status})`);
  }
  check(mismatch.length === 0, 'C21 静态 available 与真实 HEAD 探测结果一致', mismatch.join(' | ') || '全部一致');

  // C22. 已知生产缺陷必须被如实标记为「不可下载」（不做美化）
  const brokenApk = (rel.files ?? []).find((f) => f.file === `NeoMD-${rel.currentVersion}.apk`);
  if (brokenApk) {
    console.log(`    当前版本 APK：local=${brokenApk.onLocal} oss=${brokenApk.onOss} available=${brokenApk.available}`);
    console.log(`    说明：${brokenApk.note}`);
    check(
      brokenApk.onLocal || brokenApk.available === false,
      'C22 当前版本 APK 若本地缺失则必须标记不可用（阿里云禁止 APK 走 OSS 端点）',
      `onLocal=${brokenApk.onLocal} available=${brokenApk.available}`,
    );
  }

  /* ================================================================== */
  /* D. 用户管理 5 项                                                     */
  /* ================================================================== */
  section('D. 用户管理增强：封禁/批量/登录记录/概览/角色/导出');

  // D0. 建两个临时用户（绝不碰真实用户）
  const tempUsers = [];
  for (let i = 1; i <= 2; i += 1) {
    const email = `re14tmp${i}-${stamp}@neomd.local`;
    const username = `re14tmp${i}_${stamp}`;
    const rr = await call('POST', '/api/auth/register', { email, username, password: 'Re14Temp!pass' });
    if (rr.status === 200 || rr.status === 201) {
      const uid = rr.json?.data?.user?.id;
      if (uid) {
        tempUsers.push({ id: uid, email, username });
        tempUserIds.push(uid);
      }
    }
  }
  check(tempUsers.length === 2, 'D0 创建 2 个临时用户', `count=${tempUsers.length}`);
  const [u1, u2] = tempUsers;

  // --- 功能1：封禁（含原因与到期） ---
  r = await call('POST', `/api/admin/users/${u1.id}/ban`, { reason: '验收测试：违规内容', hours: 24 });
  check(r.status === 200, 'D1a 封禁成功（带原因 + 24 小时到期）', `HTTP ${r.status}`);
  check(r.json?.data?.user?.status === 'disabled', 'D1b 封禁后 status=disabled', r.json?.data?.user?.status);
  check(r.json?.data?.user?.banned === true, 'D1c 派生字段 banned=true');
  check(r.json?.data?.user?.banReason === '验收测试：违规内容', 'D1d 封禁原因已保存', r.json?.data?.user?.banReason);
  check(Boolean(r.json?.data?.user?.banUntil), 'D1e 封禁到期时间已保存', r.json?.data?.user?.banUntil);
  check(r.json?.data?.user?.banExpired === false, 'D1f banExpired=false（未到期）');

  // 封禁后该用户无法登录，且提示文案要区分封禁 vs 停用
  r = await call('POST', '/api/auth/login', { account: u1.username, password: 'Re14Temp!pass' });
  check(r.status !== 200, 'D1g 封禁用户无法登录', `HTTP ${r.status}`);
  const banMsg = String(r.json?.error?.message ?? '');
  check(/封禁|禁封|ban/i.test(banMsg) || (r.json?.error?.code ?? '').includes('BAN') || (r.json?.error?.code ?? '').includes('DISABLED'), 'D1h 登录失败文案/错误码能体现封禁状态', `msg=${banMsg} code=${r.json?.error?.code}`);

  // 非管理员不能封禁
  r = await call('POST', `/api/admin/users/${u2.id}/ban`, { reason: '越权测试' }, { authorization: 'Bearer invalid' });
  check(r.status === 401 || r.status === 403, 'D1i 无有效令牌不能调用封禁接口', `HTTP ${r.status}`);

  // 不能封禁自己
  r = await call('POST', `/api/admin/users/${me.id}/ban`, { reason: '自杀测试' });
  check(r.status === 403, 'D1j 不能封禁自己', `HTTP ${r.status} code=${r.json?.error?.code}`);

  // 封禁原因必填/长度校验
  r = await call('POST', `/api/admin/users/${u2.id}/ban`, { reason: '' });
  check(r.status === 400, 'D1k 封禁原因必填（服务端校验）', `HTTP ${r.status}`);

  // 过期时间必须是未来
  r = await call('POST', `/api/admin/users/${u2.id}/ban`, { reason: '过去时间测试', until: '2020-01-01T00:00:00.000Z' });
  check(r.status === 400, 'D1l 封禁到期时间必须在未来', `HTTP ${r.status}`);

  // --- 功能2：解封 ---
  r = await call('POST', `/api/admin/users/${u1.id}/unban`);
  check(r.status === 200 && r.json?.data?.user?.status === 'active', 'D2a 解封后 status=active', `HTTP ${r.status}`);
  check(r.json?.data?.user?.banReason === null, 'D2b 解封后封禁原因已清空');
  check(r.json?.data?.user?.banUntil === null, 'D2c 解封后到期时间已清空');
  check(r.json?.data?.user?.banned === false, 'D2d 解封后 banned=false');
  // 解封后可以登录
  r = await call('POST', '/api/auth/login', { account: u1.username, password: 'Re14Temp!pass' });
  check(r.status === 200, 'D2e 解封后可以正常登录', `HTTP ${r.status}`);

  // --- 功能2b：统一状态入口 PUT /:id/status ---
  r = await call('PUT', `/api/admin/users/${u1.id}/status`, { status: 'disabled', banReason: '状态入口封禁测试', hours: 2 });
  check(r.status === 200 && r.json?.data?.user?.banned === true, 'D2f PUT /:id/status 可封禁（带原因+到期）', `HTTP ${r.status}`);
  check(Boolean(r.json?.data?.user?.banUntil), 'D2g 状态入口写入到期时间', r.json?.data?.user?.banUntil);

  /*
   * D2g2 时区回归断言（1.4.0 实测抓到的真缺陷）。
   *
   * 根因：连接池 `timezone:'Z'` 把 JS Date 按 UTC 写进 DATETIME，但 MySQL 的 `NOW()`
   * 返回服务器**本地**时间（+08:00），两者相差 8 小时 —— 于是「封禁 2 小时」会被
   * 立刻判成「已到期」，后台显示已解封而账号实际仍是 disabled。
   * 修复：SQL 侧一律用 `UTC_TIMESTAMP()`。
   *
   * 这条断言专门盯「到期时间必须落在未来」：只要时区再被改坏，它立刻红。
   */
  const banUntilMs = new Date(r.json?.data?.user?.banUntil ?? 0).getTime();
  const remainMin = Math.round((banUntilMs - Date.now()) / 60000);
  check(
    Number.isFinite(banUntilMs) && remainMin > 100 && remainMin <= 121,
    'D2g2 封禁 2 小时的到期时间确实在约 120 分钟后（时区回归）',
    `剩 ${remainMin} 分钟`,
  );
  check(r.json?.data?.user?.banExpired === false, 'D2g3 未到期的封禁 banExpired 必须为 false', String(r.json?.data?.user?.banExpired));
  // active = 解封并清空封禁字段
  r = await call('PUT', `/api/admin/users/${u1.id}/status`, { status: 'active' });
  check(r.status === 200 && r.json?.data?.user?.status === 'active' && r.json?.data?.user?.banReason === null, 'D2h PUT /:id/status 置 active 同时清空封禁字段');
  // disabled 无原因 = 人工停用（不产生封禁标记）
  r = await call('PUT', `/api/admin/users/${u1.id}/status`, { status: 'disabled' });
  check(r.status === 200 && r.json?.data?.user?.status === 'disabled' && r.json?.data?.user?.banned === false, 'D2i PUT /:id/status 无原因时是「人工停用」而非封禁');
  // 恢复
  await call('PUT', `/api/admin/users/${u1.id}/status`, { status: 'active' });
  // 不能停用自己
  r = await call('PUT', `/api/admin/users/${me.id}/status`, { status: 'disabled' });
  check(r.status === 403, 'D2j PUT /:id/status 不能停用自己', `HTTP ${r.status}`);
  // 状态审计
  r = await call('GET', '/api/admin/audit?page=1&pageSize=20&action=admin.user.status');
  check((r.json?.data?.items ?? []).length > 0, 'D2k 状态变更写入审计 admin.user.status');

  // --- 功能3：批量操作 ---
  // 批量发放积分
  const creditsBefore = await call('GET', `/api/admin/users/${u1.id}`);
  const bal1 = creditsBefore.json?.data?.user?.credits ?? 0;
  r = await call('POST', '/api/admin/users/batch', {
    ids: [u1.id, u2.id],
    action: 'grant',
    amount: 50,
    reason: '验收批量发放',
  });
  check(r.status === 200, 'D3a 批量发放积分成功', `HTTP ${r.status}`);
  check(r.json?.data?.succeeded === 2 && r.json?.data?.skipped === 0, 'D3b 批量发放 2 个全部成功', `ok=${r.json?.data?.succeeded} skip=${r.json?.data?.skipped}`);
  const afterGrant = await call('GET', `/api/admin/users/${u1.id}`);
  check((afterGrant.json?.data?.user?.credits ?? 0) === bal1 + 50, 'D3c 积分确实 +50', `${bal1} → ${afterGrant.json?.data?.user?.credits}`);

  // 批量禁用
  r = await call('POST', '/api/admin/users/batch', { ids: [u1.id, u2.id], action: 'disable' });
  check(r.status === 200 && r.json?.data?.succeeded === 2, 'D3d 批量禁用 2 个成功', `ok=${r.json?.data?.succeeded}`);

  // 批量启用
  r = await call('POST', '/api/admin/users/batch', { ids: [u1.id, u2.id], action: 'enable' });
  check(r.status === 200 && r.json?.data?.succeeded === 2, 'D3e 批量启用 2 个成功', `ok=${r.json?.data?.succeeded}`);

  // 批量操作不能把自己禁用（逐条护栏）
  r = await call('POST', '/api/admin/users/batch', { ids: [me.id, u1.id], action: 'disable' });
  const selfSkip = (r.json?.data?.results ?? []).find((x) => x.id === me.id);
  check(selfSkip?.ok === false, 'D3f 批量操作中「自己」被逐条跳过而不是整批失败', `reason=${selfSkip?.reason}`);
  check(r.json?.data?.succeeded >= 1, 'D3g 同批次里合法的用户仍然成功', `ok=${r.json?.data?.succeeded}`);
  // 恢复（上一步把 u1 禁用了）
  await call('POST', '/api/admin/users/batch', { ids: [u1.id], action: 'enable' });

  // 批量参数校验
  r = await call('POST', '/api/admin/users/batch', { ids: [], action: 'disable' });
  check(r.status === 400, 'D3h 空 ids 被拒绝', `HTTP ${r.status}`);
  r = await call('POST', '/api/admin/users/batch', { ids: [u1.id], action: 'grant' });
  check(r.status === 400, 'D3i grant 缺 amount 被拒绝', `HTTP ${r.status}`);

  // --- 功能4：登录记录 / 最后活跃 ---
  await call('POST', '/api/auth/login', { account: u1.username, password: 'Re14Temp!pass' });
  await call('POST', '/api/auth/login', { account: u1.username, password: '错误口令测试' });
  r = await call('GET', `/api/admin/users/${u1.id}/logins?page=1&pageSize=20`);
  const lg = r.json?.data ?? {};
  check(r.status === 200, 'D4a 登录记录接口返回 200', `HTTP ${r.status}`);
  check((lg.items ?? []).length > 0, 'D4b 有登录记录', `items=${lg.items?.length}`);
  check((lg.summary?.success ?? 0) > 0, 'D4c 统计到成功登录次数', `success=${lg.summary?.success}`);
  check((lg.summary?.failed ?? 0) > 0, 'D4d 统计到失败登录次数', `failed=${lg.summary?.failed}`);
  check((lg.items ?? []).some((x) => x.success === true), 'D4e 记录里有成功条目');
  check((lg.items ?? []).some((x) => x.success === false && x.reason), 'D4f 失败条目带原因', (lg.items ?? []).find((x) => !x.success)?.reason);
  // failuresOnly 过滤
  r = await call('GET', `/api/admin/users/${u1.id}/logins?failuresOnly=true`);
  check((r.json?.data?.items ?? []).every((x) => x.success === false), 'D4g failuresOnly=true 只返回失败记录');
  // 用户列表带 lastActiveAt
  r = await call('GET', `/api/admin/users?page=1&pageSize=50&search=${encodeURIComponent(u1.username)}`);
  const listed = (r.json?.data?.items ?? [])[0];
  check(Boolean(listed?.lastActiveAt), 'D4h 用户列表带 lastActiveAt（最后活跃）', listed?.lastActiveAt);

  // --- 功能5：用户数据概览 ---
  r = await call('GET', `/api/admin/users/${u1.id}/overview`);
  const ov = r.json?.data?.overview ?? {};
  check(r.status === 200, 'D5a 数据概览接口返回 200', `HTTP ${r.status}`);
  check(ov.vaults && typeof ov.vaults.total === 'number', 'D5b 含仓库数');
  check(ov.vaults && typeof ov.vaults.documents === 'number', 'D5c 含文档数');
  check(ov.shares && typeof ov.shares.total === 'number', 'D5d 含分享数');
  check(ov.ai && typeof ov.ai.calls === 'number', 'D5e 含 AI 用量', `calls=${ov.ai?.calls}`);
  check(ov.credits && typeof ov.credits.balance === 'number', 'D5f 含积分余额', `balance=${ov.credits?.balance}`);
  check(ov.quota && typeof ov.quota.usageRatio === 'number', 'D5g 含配额使用率', `ratio=${ov.quota?.usageRatio}`);

  // --- 功能6：角色调整 ---
  r = await call('POST', `/api/admin/users/${u1.id}/role`, { role: 'admin' });
  check(r.status === 200 && r.json?.data?.user?.role === 'admin', 'D6a 提升为管理员成功', `HTTP ${r.status}`);
  check(r.json?.data?.changed === true, 'D6b changed=true');
  r = await call('POST', `/api/admin/users/${u1.id}/role`, { role: 'user' });
  check(r.status === 200 && r.json?.data?.user?.role === 'user', 'D6c 降回普通用户成功');
  // 幂等：重复设置同一角色 → changed=false
  r = await call('POST', `/api/admin/users/${u1.id}/role`, { role: 'user' });
  check(r.json?.data?.changed === false, 'D6d 重复设置同一角色 changed=false（幂等）');
  // 不能取消自己的管理员
  r = await call('POST', `/api/admin/users/${me.id}/role`, { role: 'user' });
  check(r.status === 403, 'D6e 不能取消自己的管理员身份', `HTTP ${r.status}`);
  // 角色审计
  r = await call('GET', '/api/admin/audit?page=1&pageSize=20&action=admin.user.role');
  check((r.json?.data?.items ?? []).length > 0, 'D6f 角色变更写入独立审计动作 admin.user.role');

  // --- 功能7：导出 CSV ---
  // 注意：必须用 arrayBuffer 读原始字节。fetch 的 `res.text()` 按 WHATWG 规范
  // **会剥离 UTF-8 BOM**，用它断言 BOM 会得到假失败（本项目实测踩过）。
  const csvRes = await fetch(`${API_BASE}/api/admin/users/export.csv`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const csvBuf = Buffer.from(await csvRes.arrayBuffer());
  const csv = csvBuf.toString('utf8');
  check(csvRes.status === 200, 'D7a CSV 导出返回 200', `HTTP ${csvRes.status}`);
  check(
    csvBuf[0] === 0xef && csvBuf[1] === 0xbb && csvBuf[2] === 0xbf,
    'D7b 带 UTF-8 BOM（Excel 中文不乱码）',
    `前 3 字节=${[...csvBuf.slice(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`,
  );
  const ct = String(csvRes.headers.get('content-type') ?? '');
  check(ct.includes('text/csv'), 'D7c Content-Type = text/csv', ct);
  const cd = String(csvRes.headers.get('content-disposition') ?? '');
  check(cd.includes('attachment'), 'D7d 触发浏览器下载', cd);
  const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
  check(lines.length >= 4, 'D7e CSV 至少含表头 + 3 行用户', `lines=${lines.length}`);
  check(lines[0].includes('用户名') && lines[0].includes('邮箱') && lines[0].includes('封禁原因'), 'D7f 表头含中文列名与封禁列', lines[0].slice(0, 120));
  // 导出的内容必须与列表一致（同一个筛选口径）
  const listTotal = (await call('GET', '/api/admin/users?page=1&pageSize=1')).json?.data?.total ?? 0;
  check(lines.length - 1 === listTotal, 'D7g 导出行数 === 用户总数', `csv=${lines.length - 1} total=${listTotal}`);
  await new Promise((res) => setTimeout(res, 200));
  r = await call('GET', '/api/admin/audit?page=1&pageSize=20&action=admin.user.export');
  check((r.json?.data?.items ?? []).length > 0, 'D7h 导出写入审计 admin.user.export');

  // --- 权限边界 ---
  section('E. 权限边界：所有新增接口都必须仅管理员可用');
  const newPaths = [
    ['POST', `/api/admin/users/${u1.id}/ban`, { reason: 'x1' }],
    ['POST', `/api/admin/users/${u1.id}/unban`, undefined],
    ['POST', '/api/admin/users/batch', { ids: [u1.id], action: 'enable' }],
    ['POST', `/api/admin/users/${u1.id}/role`, { role: 'user' }],
    ['GET', `/api/admin/users/${u1.id}/logins`, undefined],
    ['GET', `/api/admin/users/${u1.id}/overview`, undefined],
    ['GET', '/api/admin/users/export.csv', undefined],
    ['PUT', `/api/admin/plugins/1`, { name: 'x' }],
    ['GET', '/api/admin/plugins/1', undefined],
    ['GET', '/api/admin/releases', undefined],
  ];
  for (const [method, p, body] of newPaths) {
    const saved = accessToken;
    accessToken = '';
    const anon = await call(method, p, body);
    accessToken = saved;
    check(anon.status === 401 || anon.status === 403, `E ${method} ${p} 匿名访问被拒绝`, `HTTP ${anon.status}`);
  }
} finally {
  /* ============================ 清理 ================================= */
  section('清理：删除全部临时数据（绝不删除真实用户）');

  for (const pid of tempPluginIds) {
    const rr = await call('DELETE', `/api/admin/plugins/${pid}/force`).catch(() => null);
    // 没有 force 接口时走标准删除（作者或管理员均可）
    if (!rr || rr.status >= 400) {
      const row = await call('GET', `/api/admin/plugins/${pid}`);
      const pluginId = row.json?.data?.plugin?.pluginId;
      if (pluginId) await call('DELETE', `/api/plugins/${encodeURIComponent(pluginId)}`);
    }
  }
  const remaining = await call('GET', '/api/admin/plugins?page=1&pageSize=200&search=re14');
  const leftover = (remaining.json?.data?.items ?? []).filter(
    (p) => p.pluginId.startsWith('re14tmp-') || p.pluginId.startsWith('re14page-'),
  );
  check(leftover.length === 0, '临时插件已全部清理', `剩余=${leftover.length}`);

  for (const uid of tempUserIds) {
    await call('DELETE', `/api/admin/users/${uid}`);
  }
  const usersAfter = await call('GET', '/api/admin/users?page=1&pageSize=200&search=re14tmp');
  const leftoverUsers = (usersAfter.json?.data?.items ?? []).filter((u) => String(u.username).startsWith('re14tmp'));
  check(leftoverUsers.length === 0, '临时用户已全部清理', `剩余=${leftoverUsers.length}`);
  // 真实用户数必须 ≥ 3（原有数量），证明没误删
  const totalAfter = (await call('GET', '/api/admin/users?page=1&pageSize=1')).json?.data?.total ?? 0;
  check(totalAfter >= 3, '真实用户未被误删（总数 ≥ 3）', `total=${totalAfter}`);
}

section('结果汇总');
console.log(`  通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.log('  失败项：');
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(failures.length === 0 ? '\n全部通过' : '\n有失败项');
process.exit(failures.length === 0 ? 0 : 1);
