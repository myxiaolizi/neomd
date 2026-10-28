/**
 * Neo MD 1.1.9 · task-4 验收：后台管理端 + 平台 AI 治理 + 知识库令牌治理。
 *
 * 覆盖内容（全部为「真实请求 / 真实浏览器」验证，不打桩）：
 *   A. 后端接口
 *      A1. GET  /api/ai/providers             —— 前台不再出现 enabled（「是否开通」语义已移除）
 *      A2. GET  /api/ai/platform-models       —— 平台模型只暴露模型/上限/价格/提示词，无 baseUrl/apiKey
 *      A3. GET  /api/admin/knowledge-tokens   —— 分页 + 筛选 + 风险审计
 *      A4. DELETE /api/admin/knowledge-tokens/:id —— 管理员吊销
 *      A5. GET  /api/admin/ai-analytics       —— 按天/模型/供应商，含 p95 与成本
 *   B. 知识库令牌全链路（用户侧）
 *      申请（明文只回一次）→ 立即用 Bearer 打 /api/knowledge/stats 必须 200
 *      → 复制 → 吊销 → 再打必须 401 KB_TOKEN_REVOKED
 *   C. 平台模型系统提示词
 *      保存模型级 systemPrompt → GET /api/admin/ai-models 的 resolved.systemPromptSource === 'model'
 *   D. 后台界面（Playwright）
 *      16 个模块全部可打开、不报 JS 错误、浅色主题生效、AI 运营分析图表有 SVG、令牌治理页有数据
 *
 * 用法：
 *   node tools/verify-119-admin.mjs
 *   SMOKE_BASE=http://127.0.0.1:5178 node tools/verify-119-admin.mjs     # 前端 dev（推荐，走 vite 代理）
 *   API_BASE=http://127.0.0.1:3211 node tools/verify-119-admin.mjs       # 直接打独立 API 实例
 *
 * 退出码：0 = 全绿，1 = 有失败项。
 */
import playwright from '../apps/desktop/node_modules/playwright-core/index.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { chromium } = playwright;
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'shots-119-admin');
fs.mkdirSync(shots, { recursive: true });

/** 前端地址（默认 vite dev，/api 代理到 3200） */
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:5178';
/** 直连 API 地址：接口断言走这里，避免前端代理层的干扰；默认与前端同源（走代理） */
const API_BASE = process.env.API_BASE || BASE;
const BROWSER =
  process.env.BROWSER_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '6655';

let pass = 0;
const failures = [];

/**
 * 本次运行中观察到的 429 次数。
 *
 * 服务端有「每 IP 300 次/分钟」的全局限流（middleware/rate.js），
 * 而本脚本一轮就要发 100+ 个请求；**连续快速重跑脚本**时会撞到窗口，
 * 表现为界面上的「创建令牌」静默失败（POST 429）。
 * 这不是产品缺陷，但会让断言假红，所以这里统计并显式重试。
 */
let throttled429 = 0;

function check(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}${extra ? ` → ${extra}` : ''}`);
    console.log(`  ✗ ${label}${extra ? ` → ${extra}` : ''}`);
  }
}

/** 等到下一个限流窗口（服务端窗口 60 秒，这里按 retry-after 或固定 20s 退避） */
async function coolDown(ms = 20000) {
  console.log(`    … 触发全局限流，等待 ${Math.round(ms / 1000)}s 后重试`);
  await new Promise((r) => setTimeout(r, ms));
}

function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ */
/* 0. 登录拿令牌                                                       */
/* ------------------------------------------------------------------ */

let accessToken = '';
let refreshToken = '';

async function login() {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: ADMIN_USER, password: ADMIN_PASS }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) {
    throw new Error(`登录失败（HTTP ${res.status}）：${JSON.stringify(json).slice(0, 200)}`);
  }
  accessToken = json.data.accessToken;
  refreshToken = json.data.refreshToken ?? '';
  return json.data.user;
}

/** 带鉴权的 API 调用（不抛异常，返回 { status, json }） */
async function apiCall(method, p, body) {
  const res = await fetch(`${API_BASE}${p}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 429) throttled429 += 1;
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/**
 * 在浏览器里重试一个「会改状态」的界面动作，直到它真的成功。
 *
 * 为什么需要：界面动作（点「创建」）撞上限流时不会有任何提示，
 * 表单只是停在原地。这里在 UI 层重试并配合服务端冷却，避免把
 * 限流误报成功能缺陷。返回最后一次的明文（失败则空串）。
 */
async function createTokenViaUi(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nameInput = page.locator('.kb-tokenform input[aria-label="令牌名称"]').first();
    if (!(await nameInput.count())) {
      // 表单没展开（上一轮已提交并收起）→ 重新点「申请令牌」
      const apply = page.locator('.kb-tokens button', { hasText: '申请令牌' }).first();
      if (await apply.count()) await apply.click();
      await page.locator('.kb-tokenform').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    }
    const input = page.locator('.kb-tokenform input[aria-label="令牌名称"]').first();
    if (!(await input.count())) return '';
    await input.fill(`ui-verify-${Date.now()}`);
    await page.locator('.kb-tokenform button', { hasText: '创建' }).first().click();
    // 成功时明文区块出现；失败（429）时表单仍在
    await page
      .locator('.kb-tokenplain__value')
      .first()
      .waitFor({ state: 'visible', timeout: 8000 })
      .catch(() => {});
    const plain = await page.evaluate(() => document.querySelector('.kb-tokenplain__value')?.textContent?.trim() ?? '');
    if (plain.startsWith('nmd_kb_')) return plain;
    await coolDown(22000);
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

let browser = null;
const jsErrors = [];
let user = null;

try {
  section('[0] 登录管理员账号');
  user = await login();
  check(Boolean(accessToken), '登录成功并拿到 accessToken', `user=${user?.username}`);
  check(user?.role === 'admin', '账号具备管理员角色', `role=${user?.role}`);

  /* ============ A1. /api/ai/providers 不含 enabled ============ */
  section('[A1] 前台供应商目录不再有「是否开通」语义');
  {
    const res = await fetch(`${API_BASE}/api/ai/providers`);
    const json = await res.json();
    const providers = json?.data?.providers ?? [];
    check(res.ok && providers.length > 0, '供应商目录可读且非空', `count=${providers.length}`);

    const withEnabled = providers.filter((p) => Object.prototype.hasOwnProperty.call(p, 'enabled'));
    check(withEnabled.length === 0, '响应中没有任何 provider 携带 enabled 字段', `违规=${withEnabled.length}`);

    // 关键：整个 JSON 文本里不应出现「开通」字样，也不应出现 enabled 键
    const raw = JSON.stringify(json);
    check(!raw.includes('"enabled"'), '原始响应文本不含 "enabled" 键');
    check(!raw.includes('开通'), '原始响应文本不含「开通」字样');

    // 展示字段仍然完整（去 enabled 不能顺手删掉有用的字段）
    const first = providers[0] ?? {};
    const need = ['id', 'name', 'models', 'signupUrl', 'note', 'sortOrder', 'group'];
    const missing = need.filter((k) => !(k in first));
    check(missing.length === 0, '展示字段完整（id/name/models/signupUrl/note/sortOrder/group）', `缺=${missing.join(',')}`);
    check(Array.isArray(first.models) && first.models.length > 0, 'provider 带可用模型列表');

    /*
     * 平台代付组**不得**回传 baseUrl（1.1.9 平台付费与 BYOK 分离）：
     * group === 'platform' 表示「用平台积分、服务端代付」，上游地址属服务端内部实现，
     * 暴露给前端只会让「平台付费」被当成「自带 Key 直连」用。
     * group !== 'platform'（自带 Key）则必须回传，客户端要直连用户自己的供应商。
     */
    const platformGroup = providers.filter((p) => p.group === 'platform');
    const leakedBase = platformGroup.filter((p) => 'baseUrl' in p || 'builtinBaseUrl' in p);
    check(
      leakedBase.length === 0,
      '平台代付组不泄露 baseUrl / builtinBaseUrl（与 BYOK 彻底分离）',
      `泄露=${leakedBase.map((p) => p.id).join(',')}`,
    );

    const byokGroup = providers.filter((p) => p.group !== 'platform');
    if (byokGroup.length > 0) {
      const missingBase = byokGroup.filter((p) => !p.baseUrl);
      check(
        missingBase.length === 0,
        '自带 Key 组仍回传 baseUrl（客户端需直连）',
        `缺=${missingBase.map((p) => p.id).join(',')}`,
      );
    } else {
      console.log('    （当前没有 group!=platform 的供应商，跳过 BYOK baseUrl 断言）');
    }
  }

  /* ============ A2. 平台模型不暴露 baseUrl / apiKey ============ */
  section('[A2] 平台付费模型清单与客户端设置彻底分离');
  {
    const res = await fetch(`${API_BASE}/api/ai/platform-models`);
    const json = await res.json();
    const models = json?.data?.models ?? [];
    check(res.ok && Array.isArray(models), '平台模型接口可读', `count=${models.length}`);

    if (models.length > 0) {
      const m = models[0];
      const forbidden = ['baseUrl', 'apiKey', 'apiKeyEnc', 'apiKeySet'];
      const leaked = forbidden.filter((k) => k in m);
      check(leaked.length === 0, '模型条目不含 baseUrl / apiKey / 密钥状态', `泄露=${leaked.join(',')}`);

      const raw = JSON.stringify(json);
      // 内置供应商的 baseUrl 形如 https://api.xxx/v1 —— 平台模型响应里绝不能出现
      check(!/https?:\/\/[a-z0-9.-]+\/v\d/i.test(raw), '响应文本不含上游 baseUrl 形态的地址');
      check(!/sk-[A-Za-z0-9]{8,}/.test(raw), '响应文本不含 sk- 形态的密钥');

      const needed = ['model', 'providerName', 'temperature', 'maxTokens', 'priceIn', 'priceOut'];
      const missing = needed.filter((k) => !(k in m));
      check(missing.length === 0, '模型条目含治理字段（温度/maxTokens/单价）', `缺=${missing.join(',')}`);
      check('systemPrompt' in m, '模型条目含系统提示词字段');
    } else {
      // 生产库可能还没启用任何平台供应商 —— 这不算失败，但要说明
      console.log('    （当前没有已启用且配密钥的平台供应商，跳过条目字段断言）');
    }
  }

  /* ============ C. 平台模型系统提示词保存后生效 ============ */
  section('[C] 模型级系统提示词保存后 resolved 来源为 model');
  let promptSaved = false;
  let savedProvider = '';
  {
    const list = await apiCall('GET', '/api/admin/ai-models');
    check(list.status === 200, '管理员可读 /api/admin/ai-models', `HTTP ${list.status}`);
    const providers = list.json?.data?.providers ?? [];
    check(providers.length > 0, '存在供应商模型治理配置', `count=${providers.length}`);

    // 选一个「模型列表非空」的供应商做写入测试
    const target = providers.find((p) => Array.isArray(p.models) && p.models.length > 0);
    if (target) {
      savedProvider = target.provider;
      const model = target.models[0];
      const marker = `【verify-119 提示词 ${Date.now()}】你是 Neo MD 的写作助手，回答务必简洁。`;

      const saved = await apiCall('PUT', `/api/admin/ai-models/${encodeURIComponent(target.provider)}`, {
        modelSettings: {
          ...(target.modelSettings ?? {}),
          [model]: { ...(target.modelSettings?.[model] ?? {}), systemPrompt: marker },
        },
      });
      check(saved.status === 200, '保存模型级系统提示词成功', `HTTP ${saved.status}`);

      const after = await apiCall('GET', '/api/admin/ai-models');
      const p2 = (after.json?.data?.providers ?? []).find((p) => p.provider === target.provider);
      const resolved = p2?.resolved?.find((r) => r.model === model);
      check(resolved?.systemPrompt === marker, '回读的生效提示词与写入一致', `got=${String(resolved?.systemPrompt).slice(0, 40)}`);
      check(resolved?.systemPromptSource === 'model', '生效来源标记为 model（模型级优先于供应商级）', `source=${resolved?.systemPromptSource}`);
      promptSaved = true;

      // 前台接口也应带上该提示词（前台只读展示，用于告知用户「平台会附加这段指令」）
      const pub = await fetch(`${API_BASE}/api/ai/platform-models`);
      const pubJson = await pub.json();
      const pubModel = (pubJson?.data?.models ?? []).find((m) => m.model === model);
      if (pubModel) {
        check(pubModel.systemPrompt === marker, '前台平台模型同步展示该提示词', `got=${String(pubModel.systemPrompt).slice(0, 30)}`);
      }

      // 还原：把该模型的 systemPrompt 清掉，避免污染生产库
      const revertSettings = { ...(p2?.modelSettings ?? {}) };
      if (revertSettings[model]) {
        delete revertSettings[model].systemPrompt;
        if (Object.keys(revertSettings[model]).length === 0) delete revertSettings[model];
      }
      await apiCall('PUT', `/api/admin/ai-models/${encodeURIComponent(target.provider)}`, {
        modelSettings: revertSettings,
      });
      const reverted = await apiCall('GET', '/api/admin/ai-models');
      const p3 = (reverted.json?.data?.providers ?? []).find((p) => p.provider === target.provider);
      const r3 = p3?.resolved?.find((r) => r.model === model);
      check(r3?.systemPrompt !== marker, '清理临时提示词成功（生产库未被污染）');
    } else {
      check(false, '存在至少一个配置了模型的供应商（用于提示词写入测试）');
    }
  }

  /* ============ B. 知识库令牌全链路 ============ */
  section('[B] 知识库令牌：申请 → Bearer 实测 → 吊销 → 再打 401');
  let createdTokenId = 0;
  let createdPlain = '';
  {
    const created = await apiCall('POST', '/api/knowledge/tokens', {
      name: `verify-119-${Date.now()}`,
      scope: 'read',
      expiresInDays: 1,
    });
    check(created.status === 200, '申请令牌成功', `HTTP ${created.status}`);
    createdPlain = created.json?.data?.token ?? '';
    createdTokenId = Number(created.json?.data?.item?.id ?? 0);
    check(typeof createdPlain === 'string' && createdPlain.startsWith('nmd_kb_'), '响应返回 nmd_kb_ 前缀的明文令牌');
    check(createdTokenId > 0, '响应返回令牌 id', `id=${createdTokenId}`);
    check(Boolean(created.json?.data?.warning), '响应带「明文只显示一次」警示');

    // 列表接口不得回传明文或哈希
    const listed = await apiCall('GET', '/api/knowledge/tokens');
    const items = listed.json?.data?.tokens ?? [];
    const mine = items.find((t) => t.id === createdTokenId);
    check(Boolean(mine), '令牌出现在用户自己的列表里');
    const rawList = JSON.stringify(listed.json);
    check(!rawList.includes(createdPlain), '列表响应不含明文令牌');
    check(!('tokenHash' in (mine ?? {})), '列表项不含 token_hash');
    check(mine?.tokenPrefix === createdPlain.slice(0, 12), '列表项只展示前 12 位前缀', `prefix=${mine?.tokenPrefix}`);

    // ★ 核心证据：立刻用 Bearer 打 /api/knowledge/stats
    const statsRes = await fetch(`${API_BASE}/api/knowledge/stats`, {
      headers: { authorization: `Bearer ${createdPlain}` },
    });
    const statsJson = await statsRes.json().catch(() => null);
    check(statsRes.status === 200, '★ 新建令牌用 Bearer 实测 /api/knowledge/stats 返回 200', `HTTP ${statsRes.status}`);
    check(statsJson?.ok === true, '实测响应 ok=true');
    check(statsJson?.data?.authMode === 'token', '鉴权方式被识别为 token（而非 jwt）', `authMode=${statsJson?.data?.authMode}`);
    check(typeof statsJson?.data?.total?.calls === 'number', '实测响应含用量统计结构');

    // 「复制」等价验证：明文可以被再次取出使用（前端复制的是同一个字符串）
    const statsAgain = await fetch(`${API_BASE}/api/knowledge/stats`, {
      headers: { authorization: `Bearer ${createdPlain}` },
    });
    check(statsAgain.status === 200, '同一令牌可重复调用（复制后仍可用）');

    // 错误令牌必须被拒
    const bad = await fetch(`${API_BASE}/api/knowledge/stats`, {
      headers: { authorization: 'Bearer nmd_kb_thisIsNotARealToken0000000000000000' },
    });
    check(bad.status === 401, '伪造令牌被拒绝（401）', `HTTP ${bad.status}`);

    // 按 id 自检（前端「测试」按钮走的接口）
    const testRes = await apiCall('POST', `/api/knowledge/tokens/${createdTokenId}/test`, {});
    check(testRes.status === 200 && testRes.json?.data?.passed === true, '按 id 的令牌自检通过（前端「测试」按钮）');
  }

  /* ============ A3. 管理员令牌治理列表 ============ */
  section('[A3] 管理员知识库令牌治理：列表 / 筛选 / 风险审计');
  {
    const all = await apiCall('GET', '/api/admin/knowledge-tokens?page=1&pageSize=10');
    check(all.status === 200, '管理员可读 /api/admin/knowledge-tokens', `HTTP ${all.status}`);
    const items = all.json?.data?.items ?? [];
    const summary = all.json?.data?.summary ?? {};
    check(items.length > 0, '列表返回数据', `count=${items.length}`);
    check(typeof all.json?.data?.total === 'number', '返回分页总数', `total=${all.json?.data?.total}`);

    const raw = JSON.stringify(all.json);
    check(!raw.includes('token_hash'), '响应不含 token_hash');
    check(!/nmd_kb_[A-Za-z0-9]{20,}/.test(raw), '响应不含完整明文令牌');

    const first = items[0] ?? {};
    const need = ['id', 'name', 'tokenPrefix', 'status', 'usable', 'userId', 'username', 'risk'];
    const missing = need.filter((k) => !(k in first));
    check(missing.length === 0, '列表项含治理字段（owner / 状态 / 风险）', `缺=${missing.join(',')}`);
    check(typeof first.risk?.level === 'string' && Array.isArray(first.risk?.signals), '风险审计结构完整（level + signals）');
    check(
      ['none', 'medium', 'high'].includes(first.risk?.level),
      '风险等级取值合法',
      `level=${first.risk?.level}`,
    );
    check(summary.total >= items.length, '汇总 total 覆盖当前页', `summary.total=${summary.total}`);
    check('writeScope' in summary && 'active' in summary && 'users' in summary, '汇总含 active/writeScope/users');

    // 按状态筛选
    for (const st of ['active', 'revoked', 'expired']) {
      const filtered = await apiCall('GET', `/api/admin/knowledge-tokens?status=${st}&pageSize=5`);
      check(filtered.status === 200, `按状态「${st}」筛选可用`, `HTTP ${filtered.status}`);
      const wrong = (filtered.json?.data?.items ?? []).filter((t) => t.status !== st);
      check(wrong.length === 0, `筛选结果状态一致（${st}）`, `不一致=${wrong.length}`);
    }

    // 按用户 ID 筛选
    const byUser = await apiCall('GET', `/api/admin/knowledge-tokens?userId=${user.id}&pageSize=5`);
    check(byUser.status === 200, '按用户 ID 筛选可用', `HTTP ${byUser.status}`);
    const wrongUser = (byUser.json?.data?.items ?? []).filter((t) => t.userId !== user.id);
    check(wrongUser.length === 0, '筛选结果用户一致', `不一致=${wrongUser.length}`);

    // 按名称搜索
    const byName = await apiCall('GET', '/api/admin/knowledge-tokens?search=verify-119&pageSize=10');
    check(byName.status === 200, '按名称搜索可用', `HTTP ${byName.status}`);

    // 非法状态应被 400 拒绝（防止前端拼错静默返回全量）
    const badStatus = await apiCall('GET', '/api/admin/knowledge-tokens?status=bogus');
    check(badStatus.status === 400, '非法状态值被 400 拒绝', `HTTP ${badStatus.status}`);
  }

  /* ============ A5. AI 运营分析 ============ */
  section('[A5] AI 运营分析：按天 / 模型 / 供应商 + p95 + 成本');
  {
    for (const days of [7, 30]) {
      const res = await apiCall('GET', `/api/admin/ai-analytics?days=${days}`);
      check(res.status === 200, `days=${days} 可读`, `HTTP ${res.status}`);
      if (res.status !== 200) continue;
      const d = res.json.data;
      check(d.range?.days === days, `range.days 回显正确（${days}）`, `got=${d.range?.days}`);
      check(Array.isArray(d.daily) && d.daily.length === days, `按天序列满 ${days} 天（含无调用的空日）`, `len=${d.daily.length}`);
      check(Array.isArray(d.byModel), 'byModel 为数组');
      check(Array.isArray(d.byProvider), 'byProvider 为数组');

      const t = d.totals ?? {};
      const keys = ['calls', 'errors', 'failRate', 'inTokens', 'outTokens', 'cost', 'avgLatency', 'p95Latency'];
      const missing = keys.filter((k) => !(k in t));
      check(missing.length === 0, 'totals 含调用/失败率/延迟/p95/成本', `缺=${missing.join(',')}`);
      check(typeof t.p95Latency === 'number', 'p95 延迟为数值', `p95=${t.p95Latency}`);

      if (d.byModel.length > 0) {
        const m = d.byModel[0];
        const modelKeys = ['model', 'calls', 'failRate', 'avgLatency', 'p95Latency', 'cost', 'costShare'];
        const miss2 = modelKeys.filter((k) => !(k in m));
        check(miss2.length === 0, '模型维度含调用量/失败率/p95/成本/占比', `缺=${miss2.join(',')}`);
      }
      if (d.byProvider.length > 0) {
        const p = d.byProvider[0];
        check('provider' in p && 'name' in p && 'p95Latency' in p, '供应商维度字段完整');
      }
      check('knowledgeTokens' in d && 'conversion' in d && Array.isArray(d.lowBalanceUsers), '含令牌健康 / 付费转化 / 低余额用户');
    }

    // 参数越界应被拒
    const bad = await apiCall('GET', '/api/admin/ai-analytics?days=999');
    check(bad.status === 400, 'days 越界（999）被 400 拒绝', `HTTP ${bad.status}`);
  }

  /* ============ A4. 管理员吊销（放在界面之前，避免影响后续界面数据） ============ */
  section('[A4] 管理员吊销令牌 + 吊销后立即失效');
  {
    const del = await apiCall('DELETE', `/api/admin/knowledge-tokens/${createdTokenId}`);
    check(del.status === 200, '管理员吊销成功', `HTTP ${del.status}`);
    check(del.json?.data?.item?.status === 'revoked', '吊销后状态为 revoked');
    check(del.json?.data?.alreadyRevoked === false, '首次吊销返回 alreadyRevoked=false');

    // 吊销后 Bearer 必须 401
    const statsAfter = await fetch(`${API_BASE}/api/knowledge/stats`, {
      headers: { authorization: `Bearer ${createdPlain}` },
    });
    const afterJson = await statsAfter.json().catch(() => null);
    check(statsAfter.status === 401, '★ 吊销后 Bearer 调用立即 401', `HTTP ${statsAfter.status}`);
    check(afterJson?.error?.code === 'KB_TOKEN_REVOKED', '错误码为 KB_TOKEN_REVOKED', `code=${afterJson?.error?.code}`);

    // 幂等：重复吊销不报错
    const again = await apiCall('DELETE', `/api/admin/knowledge-tokens/${createdTokenId}`);
    check(again.status === 200 && again.json?.data?.alreadyRevoked === true, '重复吊销幂等（alreadyRevoked=true）');

    // 不存在的 id
    const missing = await apiCall('DELETE', '/api/admin/knowledge-tokens/999999999');
    check(missing.status === 404, '吊销不存在的令牌返回 404', `HTTP ${missing.status}`);

    // 审计日志应记录这次吊销
    const audit = await apiCall('GET', '/api/admin/audit?page=1&pageSize=30&action=admin.knowledge_token.revoke');
    const auditItems = audit.json?.data?.items ?? [];
    check(
      auditItems.some((a) => String(a.target ?? '').includes(`kb-token:${createdTokenId}`)),
      '审计日志记录了本次管理员吊销',
      `最近=${auditItems.length}`,
    );
  }

  /* ============ 普通用户不能访问管理员接口 ============ */
  section('[权限] 管理接口拒绝非管理员 / 未登录');
  {
    // 未登录
    const anon = await fetch(`${API_BASE}/api/admin/knowledge-tokens`);
    check(anon.status === 401, '未登录访问令牌治理返回 401', `HTTP ${anon.status}`);

    const anonAnalytics = await fetch(`${API_BASE}/api/admin/ai-analytics?days=7`);
    check(anonAnalytics.status === 401, '未登录访问运营分析返回 401', `HTTP ${anonAnalytics.status}`);

    // 用知识库令牌（低权限凭据）也不行
    const kbRes = await fetch(`${API_BASE}/api/admin/knowledge-tokens`, {
      headers: { authorization: `Bearer ${createdPlain}` },
    });
    check(kbRes.status === 401 || kbRes.status === 403, '知识库令牌不能访问管理接口', `HTTP ${kbRes.status}`);
  }

  /* ============ D. 后台界面 ============ */
  section('[D] 后台管理端界面（Playwright）');
  browser = await chromium.launch({
    executablePath: BROWSER,
    args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
  const page = await ctx.newPage();

  page.on('pageerror', (e) => jsErrors.push(String(e.message).slice(0, 180)));
  page.on('console', (m) => {
    if (m.type() === 'error') jsErrors.push(`console: ${m.text().slice(0, 180)}`);
  });

  // 注入登录态（与前端读 localStorage 的键一致）
  await page.addInitScript(
    ([a, r]) => {
      localStorage.setItem('neomd.access', a);
      if (r) localStorage.setItem('neomd.refresh', r);
    },
    [accessToken, refreshToken],
  );

  await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('.admin-shell', { timeout: 25000 });
  await page.waitForTimeout(1200);

  check(true, '后台页面加载完成（.admin-shell 已挂载）');

  // 浅色主题：取侧栏与内容区背景色
  const theme = await page.evaluate(() => {
    const nav = document.querySelector('.adm-nav');
    const body = document.querySelector('.adm-body');
    const shell = document.querySelector('.admin-shell');
    return {
      navBg: nav ? getComputedStyle(nav).backgroundColor : '',
      bodyBg: body ? getComputedStyle(body).backgroundColor : '',
      shellBg: shell ? getComputedStyle(shell).backgroundColor : '',
      colorScheme: shell ? getComputedStyle(shell).colorScheme : '',
    };
  });
  console.log(`    侧栏背景=${theme.navBg} 内容区=${theme.bodyBg} color-scheme=${theme.colorScheme}`);
  check(theme.colorScheme === 'light', 'color-scheme 锁定为 light', theme.colorScheme);
  // 浅色判定：三个通道都 > 200 视为浅色（#f7f8fa / #f5f6f8 都在此范围）
  const isLight = (rgb) => {
    const m = String(rgb).match(/(\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return false;
    return Number(m[1]) > 200 && Number(m[2]) > 200 && Number(m[3]) > 200;
  };
  check(isLight(theme.navBg), '侧栏为浅色（RGB 各通道 > 200）', theme.navBg);
  check(isLight(theme.bodyBg), '内容区为浅色', theme.bodyBg);

  // 16 个模块逐个打开
  const MODULES = [
    '数据看板',
    '运营概览',
    '用户与配额',
    '仓库管理',
    '分享与评价',
    '发布与分发',
    '插件市场',
    '积分与兑换码',
    '积分流水',
    '计费与赠送',
    'AI 供应商',
    '平台模型配置',
    'AI 运营分析',
    '知识库令牌',
    '配置中心',
    '审计日志',
  ];

  const navLabels = await page.$$eval('.adm-nav .nav-item', (els) => els.map((e) => e.textContent?.trim() ?? ''));
  const missingNav = MODULES.filter((m) => !navLabels.includes(m));
  check(missingNav.length === 0, `侧栏包含全部 ${MODULES.length} 个模块`, `缺=${missingNav.join(',')}`);

  const opened = [];
  for (const label of MODULES) {
    const before = jsErrors.length;
    const btn = page.locator('.adm-nav .nav-item', { hasText: label }).first();
    if (!(await btn.count())) {
      check(false, `模块「${label}」可点击打开`, '找不到导航项');
      continue;
    }
    await btn.click();
    await page.waitForTimeout(750);
    // 内容区必须有实际渲染内容（不是空白）
    const info = await page.evaluate(() => {
      const body = document.querySelector('.adm-body');
      return {
        textLen: (body?.textContent ?? '').trim().length,
        hasHead: Boolean(body?.querySelector('.adm-page-head, .dash')),
        childCount: body?.children.length ?? 0,
      };
    });
    const newErrors = jsErrors.slice(before);
    opened.push({ label, ...info, errors: newErrors.length });
    check(
      info.childCount > 0 && info.textLen > 30 && newErrors.length === 0,
      `模块「${label}」可打开且有内容`,
      `textLen=${info.textLen} children=${info.childCount} newErrors=${newErrors.length}`,
    );
    if (label === '数据看板') {
      await page.screenshot({ path: path.join(shots, '01-dashboard.png'), fullPage: false });
    }
  }

  // AI 运营分析：图表必须是自绘 SVG 且有路径
  section('[D2] AI 运营分析图表（自绘 SVG）');
  {
    await page.locator('.adm-nav .nav-item', { hasText: 'AI 运营分析' }).first().click();
    await page.waitForTimeout(1500);
    const chart = await page.evaluate(() => {
      const svg = document.querySelector('.aiu svg.chart');
      const ring = document.querySelector('.aiu svg.ring');
      return {
        hasChart: Boolean(svg),
        pathCount: svg ? svg.querySelectorAll('path').length : 0,
        textCount: svg ? svg.querySelectorAll('text').length : 0,
        hasRing: Boolean(ring),
        metricCount: document.querySelectorAll('.aiu .adm-metric').length,
        tables: document.querySelectorAll('.aiu .adm-table').length,
      };
    });
    console.log(
      `    折线图=${chart.hasChart} path=${chart.pathCount} text=${chart.textCount} 环形图=${chart.hasRing} 指标卡=${chart.metricCount} 表格=${chart.tables}`,
    );
    check(chart.hasChart, '折线趋势图已渲染');
    check(chart.pathCount >= 1, '折线图有实际路径（非空图）', `path=${chart.pathCount}`);
    check(chart.textCount >= 4, '折线图有坐标轴标签', `text=${chart.textCount}`);
    check(chart.hasRing, '令牌健康环形图已渲染');
    check(chart.metricCount >= 5, '指标卡渲染完整', `count=${chart.metricCount}`);
    check(chart.tables >= 2, '模型/供应商维度表格存在', `tables=${chart.tables}`);

    // 切 30 天
    await page.locator('.aiu .adm-seg button', { hasText: '近 30 天' }).first().click();
    await page.waitForTimeout(1400);
    const after30 = await page.evaluate(() => {
      const svg = document.querySelector('.aiu svg.chart');
      return { path: svg ? svg.querySelectorAll('path').length : 0 };
    });
    check(after30.path >= 1, '切到 30 天窗口图表仍正常', `path=${after30.path}`);
    await page.screenshot({ path: path.join(shots, '02-ai-analytics.png'), fullPage: true });
  }

  // 知识库令牌治理：表格有数据、风险列存在、筛选可用
  section('[D3] 知识库令牌治理页');
  {
    await page.locator('.adm-nav .nav-item', { hasText: '知识库令牌' }).first().click();
    await page.waitForTimeout(1400);
    const kt = await page.evaluate(() => {
      const root = document.querySelector('.kt');
      return {
        hasRoot: Boolean(root),
        metrics: root ? root.querySelectorAll('.adm-metric').length : 0,
        rows: root ? root.querySelectorAll('tbody tr').length : 0,
        hasRisk: root ? root.querySelectorAll('.risk-chip').length > 0 : false,
        hasFilter: root ? root.querySelectorAll('.adm-toolbar select').length : 0,
        hasTable: Boolean(root?.querySelector('.adm-table')),
      };
    });
    console.log(`    指标卡=${kt.metrics} 行数=${kt.rows} 风险标签=${kt.hasRisk} 筛选器=${kt.hasFilter}`);
    check(kt.hasRoot && kt.hasTable, '令牌治理页结构正常');
    check(kt.metrics >= 4, '顶部汇总指标完整', `count=${kt.metrics}`);
    check(kt.rows >= 1, '列表有数据行', `rows=${kt.rows}`);
    check(kt.hasFilter >= 1, '状态筛选器存在', `count=${kt.hasFilter}`);

    // 用状态筛选器验证交互真的接上了（选「已吊销」后行状态应全为已吊销）
    await page.selectOption('.kt .adm-toolbar select', 'revoked');
    await page.waitForTimeout(1200);
    const filtered = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.kt tbody tr')];
      return {
        rows: rows.length,
        texts: rows.map((r) => r.textContent ?? ''),
      };
    });
    const hasNonRevoked = filtered.texts
      .filter((t) => t.includes('nmd_kb_'))
      .some((t) => !t.includes('已吊销') && t.includes('有效'));
    check(!hasNonRevoked, '筛选「已吊销」后列表中不含有效令牌', `rows=${filtered.rows}`);
    await page.screenshot({ path: path.join(shots, '03-knowledge-tokens.png'), fullPage: true });
  }

  // 平台模型配置：提示词来源列存在（治理可见性）
  section('[D4] 平台模型配置页');
  {
    await page.locator('.adm-nav .nav-item', { hasText: '平台模型配置' }).first().click();
    await page.waitForTimeout(1500);
    const aim = await page.evaluate(() => {
      const root = document.querySelector('.aim');
      return {
        hasRoot: Boolean(root),
        cards: root ? root.querySelectorAll('.adm-card').length : 0,
        hasNote: Boolean(root?.querySelector('.adm-note')),
        expandButtons: root ? [...root.querySelectorAll('.adm-rowbtn')].filter((b) => /展开设置|收起设置/.test(b.textContent ?? '')).length : 0,
      };
    });
    check(aim.hasRoot && aim.cards >= 1, '模型配置页有供应商卡片', `cards=${aim.cards}`);
    check(aim.hasNote, '页面有治理说明（生效优先级）');
    check(aim.expandButtons >= 1, '每模型设置可展开', `count=${aim.expandButtons}`);

    // 展开第一个供应商，检查「提示词来源」列
    const expandBtn = page.locator('.aim .adm-rowbtn', { hasText: '展开设置' }).first();
    if (await expandBtn.count()) {
      await expandBtn.click();
      await page.waitForTimeout(700);
      const detail = await page.evaluate(() => {
        const root = document.querySelector('.aim');
        const heads = root ? [...root.querySelectorAll('.adm-table th')].map((t) => t.textContent ?? '') : [];
        return {
          hasPromptCol: heads.some((h) => h.includes('提示词来源')),
          hasTempCol: heads.some((h) => h.includes('温度上限')),
          hasPriceCol: heads.some((h) => h.includes('单价')),
          hasSystemPromptInput: Boolean(root?.querySelector('input[aria-label="模型级系统提示词"]')),
        };
      });
      check(detail.hasPromptCol, '每模型表格有「提示词来源」列');
      check(detail.hasTempCol, '每模型表格有「温度上限」列');
      check(detail.hasPriceCol, '每模型表格有「单价」列');
      check(detail.hasSystemPromptInput, '每模型可编辑系统提示词');
    }
    await page.screenshot({ path: path.join(shots, '04-ai-models.png'), fullPage: true });
  }

  // AI 供应商：不得出现「是否开通」
  section('[D5] AI 供应商页不出现「是否开通」语义');
  {
    await page.locator('.adm-nav .nav-item', { hasText: 'AI 供应商' }).first().click();
    await page.waitForTimeout(1300);
    const pageText = await page.evaluate(() => document.querySelector('.aip')?.textContent ?? '');
    check(!/未开通|平台已开通|是否开通/.test(pageText), 'AI 供应商页无「未开通/已开通」字样');
    check(/平台密钥|密钥已配|未配置/.test(pageText) || pageText.length > 100, '供应商表格正常渲染');

    // 前台设置页也不应出现「是否开通」（只检查公开接口，页面归 settings 任务）
    const provRes = await fetch(`${API_BASE}/api/ai/providers`);
    const provText = await provRes.text();
    check(!provText.includes('开通'), '前台供应商接口文本不含「开通」');
    await page.screenshot({ path: path.join(shots, '05-ai-providers.png'), fullPage: true });
  }

  // 响应式：窄屏下侧栏变横向且无横向溢出
  section('[D6] 响应式（窄屏）');
  {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.waitForTimeout(700);
    const narrow = await page.evaluate(() => {
      const nav = document.querySelector('.adm-nav');
      const navStyle = nav ? getComputedStyle(nav) : null;
      return {
        flexDirection: navStyle?.flexDirection ?? '',
        docScrollW: document.documentElement.scrollWidth,
        docClientW: document.documentElement.clientWidth,
      };
    });
    check(narrow.flexDirection === 'row', '窄屏侧栏切换为横向', `flexDirection=${narrow.flexDirection}`);
    check(
      narrow.docScrollW <= narrow.docClientW + 2,
      '窄屏无横向溢出',
      `scrollW=${narrow.docScrollW} clientW=${narrow.docClientW}`,
    );
    await page.screenshot({ path: path.join(shots, '06-narrow.png'), fullPage: false });
    await page.setViewportSize({ width: 1680, height: 1000 });
  }

  // 全流程无 JS 错误
  check(jsErrors.length === 0, '整个后台浏览过程无 JS 错误', jsErrors.slice(0, 3).join(' | '));

  /* ============ D7. 用户侧令牌界面全链路（申请→复制→测试→吊销） ============ */
  section('[D7] 用户侧设置界面令牌全链路（申请 → 复制 → 实测 → 吊销）');
  {
    /*
     * 设置是弹窗（没有 /settings 路由），入口是 Ctrl+, 快捷键。
     * 知识库区块在关闭状态下只渲染精简视图，必须先打开开关才能看到令牌区。
     */
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3500);
    await page.keyboard.press('Control+,');
    await page.waitForTimeout(2500);

    const navCount = await page.locator('.settings__nav-item').count();
    check(navCount > 0, '设置弹窗可打开', `navItems=${navCount}`);

    const kbNav = page.locator('.settings__nav-item', { hasText: '知识库' }).first();
    if (await kbNav.count()) {
      await kbNav.click();
      await page.waitForTimeout(1800);
    }

    // 打开知识库总开关
    const kbOn = await page.evaluate(async () => {
      const sw = document.querySelector('.kb-switch input, input[aria-label="启用知识库"]');
      if (!sw) return { found: false, checked: false };
      if (!sw.checked) sw.click();
      await new Promise((r) => setTimeout(r, 800));
      return { found: true, checked: sw.checked };
    });
    check(kbOn.found && kbOn.checked, '知识库开关可启用', JSON.stringify(kbOn));
    await page.waitForTimeout(2000);

    // 教程区块 → 一键跳转到令牌区
    const hasEntry = await page.locator('.kb-tokenentry').count();
    check(hasEntry > 0, '「AI 知识库使用教程」区块有令牌入口');
    if (hasEntry > 0) {
      const beforeTop = await page.evaluate(() => {
        const el = document.querySelector('.kb-tokens');
        const r = el?.getBoundingClientRect();
        return { top: Math.round(r?.top ?? -1), flash: el?.classList.contains('is-flash') ?? false };
      });
      await page.locator('.kb-tokenentry button').first().click();
      await page.waitForTimeout(1100);
      const afterJump = await page.evaluate(() => {
        const el = document.querySelector('.kb-tokens');
        const r = el?.getBoundingClientRect();
        return {
          top: Math.round(r?.top ?? -1),
          flash: el?.classList.contains('is-flash') ?? false,
          inView: r ? r.top >= -50 && r.top < window.innerHeight : false,
        };
      });
      console.log(`    跳转前 top=${beforeTop.top}px → 跳转后 top=${afterJump.top}px，高亮=${afterJump.flash}`);
      check(afterJump.inView, '点「去申请令牌」后滚动到令牌区（进入可视区）', `top=${afterJump.top}`);
      check(afterJump.flash, '跳转后令牌区有高亮反馈');
    }

    // 申请令牌（走界面）—— 带限流退避重试
    const applyBtn = page.locator('.kb-tokens button', { hasText: '申请令牌' }).first();
    check((await applyBtn.count()) > 0, '令牌区有「申请令牌」按钮');
    if (await applyBtn.count()) {
      await applyBtn.click();
      // 表单是「第一次点击展开、第二次点击提交」的两段式，必须等它渲染出来
      await page.locator('.kb-tokenform').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
      const nameInput = page.locator('.kb-tokenform input[aria-label="令牌名称"]').first();
      check((await nameInput.count()) > 0, '点「申请令牌」后展开新建表单');

      // 提交（含 429 退避重试，见 createTokenViaUi 的说明）
      const plain = await createTokenViaUi(page);
      check(plain.startsWith('nmd_kb_'), '界面创建后显示明文令牌（nmd_kb_ 前缀）', `len=${plain.length}`);

      // 「立即验证这枚令牌」= 用 Bearer 真打 /api/knowledge/stats
      const verifyBtn = page.locator('.kb-tokenplain__verify').first();
      if ((await verifyBtn.count()) && plain) {
        await verifyBtn.click();
        await page.waitForTimeout(2500);
        const verifyText = await page.evaluate(() => {
          const tips = [...document.querySelectorAll('.kb-tokenplain .kb-tip')];
          return tips.map((t) => t.textContent?.trim() ?? '').join(' | ');
        });
        console.log(`    界面实测结果：${verifyText.slice(0, 90)}`);
        check(/验证通过/.test(verifyText), '界面「立即验证」显示验证通过', verifyText.slice(0, 60));
      }

      // 复制按钮存在（点击后应提示已复制）
      const copyBtn = page.locator('.kb-tokenplain button', { hasText: '复制' }).first();
      check((await copyBtn.count()) > 0, '明文旁有「复制」按钮');

      // 吊销（界面）：找到刚创建的那条并点吊销
      const revokeBtn = page.locator('.kb-tokenitem button', { hasText: '吊销' }).first();
      if (await revokeBtn.count()) {
        // 页面里的吊销用 confirm 二次确认，自动接受
        page.once('dialog', (d) => void d.accept());
        await revokeBtn.click();
        await page.waitForTimeout(2000);
        const tip = await page.evaluate(() => {
          const tips = [...document.querySelectorAll('.kb-tokens .kb-tip')];
          return tips.map((t) => t.textContent?.trim() ?? '').join(' | ');
        });
        console.log(`    界面吊销结果：${tip.slice(0, 90)}`);
        check(/已吊销|吊销成功/.test(tip) || tip.length > 0, '界面吊销有结果反馈', tip.slice(0, 60));

        // 吊销后用界面拿到的明文再打一次，必须 401（端到端闭环）
        if (plain) {
          const afterRevoke = await fetch(`${API_BASE}/api/knowledge/stats`, {
            headers: { authorization: `Bearer ${plain}` },
          });
          check(afterRevoke.status === 401, '★ 界面吊销后该明文立即失效（401）', `HTTP ${afterRevoke.status}`);
        }
      } else {
        console.log('    （未找到吊销按钮，可能令牌列表尚未刷新）');
      }
    }
    await page.screenshot({ path: path.join(shots, '07-knowledge-token-ui.png') });
  }
}
catch (err) {
  failures.push(`未捕获异常：${err?.message ?? err}`);
  console.error('\n[异常]', err?.stack ?? err);
}
finally {
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 汇总                                                               */
/* ------------------------------------------------------------------ */

console.log('\n' + '='.repeat(60));
if (throttled429 > 0) {
  console.log(`注意：本次运行共命中 ${throttled429} 次全局限流（300 次/分钟），已自动退避重试。`);
  console.log('      连续快速重跑本脚本会撞窗口，属正常现象；间隔 1 分钟后再跑即可。');
}
if (failures.length === 0) {
  console.log(`全部通过：${pass} 个断言 ✓`);
  console.log(`截图目录：${shots}`);
  process.exit(0);
} else {
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`截图目录：${shots}`);
  process.exit(1);
}
