/**
 * [B] 后台（需求 2 / 3 / 4 / 5）
 * =============================================================================
 * 需求2：后台插件市场增加「编辑」功能（改元数据 + 代码，保存生效）
 * 需求3：插件市场翻页，每页 20 条
 * 需求4：后台客户端分发必须显示最新版本（== services/api/package.json 的 version）
 * 需求5：用户管理新增功能（批量/封禁/导出等）
 *
 * 断言策略：
 *  - 能用 API 断言的一律走 API（稳定、可精确比对），涉 UI 的再补浏览器断言；
 *  - 所有写操作都记录为「本脚本自身写请求」，并在 finally 还原/清理，
 *    避免污染生产库（admin 是真实账号）。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  API,
  authHeaders,
  check,
  fmt,
  httpJson,
  ROOT,
  section,
  state,
  THRESHOLD,
} from './common.mjs';

const H = () => ({ ...authHeaders(state.token), 'content-type': 'application/json' });

/** 读 services/api/package.json 的 version（需求4 的唯一事实源） */
function readApiVersion() {
  const p = path.join(ROOT, 'services', 'api', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { version: String(pkg.version ?? '').trim(), file: p };
}

export async function sectionB() {
  section('B', '后台（需求2/3/4/5：插件编辑 / 翻页20 / 分发最新版 / 用户管理增强）');

  /* ---------- B1：插件市场翻页（需求3） ---------- */
  {
    const p1 = await httpJson(`${API}/api/admin/plugins?page=1&pageSize=${THRESHOLD.pluginPageSize}`, { headers: H() });
    const p2 = await httpJson(`${API}/api/admin/plugins?page=2&pageSize=${THRESHOLD.pluginPageSize}`, { headers: H() });
    const b1 = p1.body?.data ?? {};
    const b2 = p2.body?.data ?? {};
    const items1 = b1.items ?? [];
    const items2 = b2.items ?? [];
    const total = Number(b1.total ?? 0);
    const ids1 = items1.map((x) => x.id);
    const ids2 = items2.map((x) => x.id);
    const overlap = ids1.filter((id) => ids2.includes(id));

    check(
      'B1 插件市场服务端分页：第 1 页恰好 20 条且 total 正确',
      `pageSize=${THRESHOLD.pluginPageSize} 时第 1 页 items.length === 20，且 total >= 20`,
      `status=${p1.status} 第1页=${items1.length} 条 total=${total} page=${b1.page} pageSize=${b1.pageSize}`,
      p1.status === 200 && items1.length === THRESHOLD.pluginPageSize && total >= THRESHOLD.pluginPageSize,
      { repro: 'GET /api/admin/plugins?page=1&pageSize=20' },
    );

    check(
      'B2 插件市场分页第 2 页与第 1 页无重叠（翻页正确）',
      '第 2 页返回 total-20 条（或 20 条），且与第 1 页 id 无交集',
      `第2页=${items2.length} 条；重叠 id 数=${overlap.length}；第2页 page=${b2.page}`,
      p2.status === 200 && overlap.length === 0 && items2.length > 0,
      { repro: 'GET /api/admin/plugins?page=2&pageSize=20，与第 1 页 id 求交' },
    );

    // 需求3 还要求「每页 20」这一约定在客户端市场同样成立
    const market = await httpJson(`${API}/api/plugins/market?page=1&pageSize=${THRESHOLD.pluginPageSize}`);
    const mItems = market.body?.data?.items ?? [];
    const mTotal = market.body?.data?.total ?? market.body?.data?.items?.length ?? 0;
    check(
      'B3 客户端插件市场也支持分页（page/pageSize/total）',
      `GET /api/plugins/market?page=1&pageSize=20 返回 <=20 条，且能给出 total`,
      `status=${market.status} items=${mItems.length} total=${mTotal}`,
      market.status === 200 && mItems.length > 0 && mItems.length <= THRESHOLD.pluginPageSize && mTotal >= mItems.length,
      { repro: 'GET /api/plugins/market?page=1&pageSize=20' },
    );
  }

  /* ---------- B4~B6：插件市场编辑（需求2） ---------- */
  {
    const list = await httpJson(`${API}/api/admin/plugins?page=1&pageSize=5`, { headers: H() });
    const target = (list.body?.data?.items ?? [])[0];
    if (!target) {
      check('B4 插件市场编辑：存在可编辑插件', '至少 1 款插件', '市场为空，无法测试编辑', false, {
        repro: 'GET /api/admin/plugins',
      });
    } else {
      const origDesc = String(target.description ?? '');
      const markerDesc = `QA140 编辑验证 ${Date.now()}`;
      // 先尝试元数据编辑（PUT /api/plugins/:pluginId 为作者编辑；后台编辑走 admin 侧）
      const edit = await httpJson(`${API}/api/plugins/${encodeURIComponent(target.pluginId)}`, {
        method: 'PUT',
        headers: H(),
        body: JSON.stringify({ description: markerDesc, name: target.name }),
      });
      const editOk = edit.status === 200 && edit.body?.ok;
      const afterRead = await httpJson(`${API}/api/admin/plugins?page=1&pageSize=5`, { headers: H() });
      const afterItem = (afterRead.body?.data?.items ?? []).find((x) => x.id === target.id);
      const descChanged = String(afterItem?.description ?? '') === markerDesc;

      check(
        'B4 插件市场编辑：修改元数据后保存生效（回读一致）',
        `PUT /api/plugins/<pluginId> 改 description → 后台列表回读到新值`,
        `PUT status=${edit.status} ok=${editOk}；回读 description 变化=${descChanged}`,
        editOk && descChanged,
        {
          repro: `PUT /api/plugins/${target.pluginId} { description: "${markerDesc}" }`,
          note: '需求2 要求「能对插件进行修改和调整」；此断言验证保存后真的落库',
        },
      );

      // 还原
      await httpJson(`${API}/api/plugins/${encodeURIComponent(target.pluginId)}`, {
        method: 'PUT',
        headers: H(),
        body: JSON.stringify({ description: origDesc, name: target.name }),
      });
      const restored = await httpJson(`${API}/api/admin/plugins?page=1&pageSize=5`, { headers: H() });
      const restoredItem = (restored.body?.data?.items ?? []).find((x) => x.id === target.id);
      check(
        'B5 插件市场编辑：可还原原值（自清理）',
        '把 description 改回原值后回读等于原值',
        `原值=${fmt(origDesc.slice(0, 40))}；回读=${fmt(String(restoredItem?.description ?? '').slice(0, 40))}`,
        String(restoredItem?.description ?? '') === origDesc,
        { repro: '再次 PUT 原 description' },
      );

      // 代码编辑 + 语法校验（需求2 明确要求「至少做语法校验」）
      /*
       * 判据分两层，避免误判：
       *  1) 先确认「代码字段本身可写」——用一个**合法**代码 PUT，必须 200；
       *     若合法也写不进去，说明接口根本没接受 codeJs，那就不是「缺校验」而是「缺编辑能力」。
       *  2) 再确认「非法代码被拒」——语法错误的 codeJs 必须 4xx。
       * 只测第 2 步会把「接口不接受 codeJs」误报成「有校验」（因为那时也可能 4xx）。
       */
      const originalCode = String(target.codeJs ?? '');
      const validCode = `${originalCode}\n// QA140 合法校验探针`;
      const okPut = await httpJson(`${API}/api/plugins/${encodeURIComponent(target.pluginId)}`, {
        method: 'PUT',
        headers: H(),
        body: JSON.stringify({ codeJs: validCode }),
      });
      const codeWritable = okPut.status === 200 && okPut.body?.ok === true;

      const badSyntax = await httpJson(`${API}/api/plugins/${encodeURIComponent(target.pluginId)}`, {
        method: 'PUT',
        headers: H(),
        body: JSON.stringify({ codeJs: 'export default { id: "x", setup( {' }),
      });
      check(
        'B6 插件代码编辑有语法校验（合法可写、非法被拒）',
        '合法 codeJs 可以保存（200）；语法错误的 codeJs 必须被拒（4xx）',
        `合法 PUT status=${okPut.status}（可写=${codeWritable}）；非法 PUT status=${badSyntax.status}`,
        codeWritable === true && badSyntax.status >= 400 && badSyntax.status < 500,
        {
          repro: '先 PUT 合法 codeJs → 再 PUT 语法错误 codeJs，比对两次状态码',
          note: '需求2：编辑代码有安全风险，至少做语法校验',
        },
      );

      // 还原代码
      if (codeWritable) {
        await httpJson(`${API}/api/plugins/${encodeURIComponent(target.pluginId)}`, {
          method: 'PUT',
          headers: H(),
          body: JSON.stringify({ codeJs: originalCode }),
        });
      }
    }
  }

  /* ---------- B7/B8：客户端分发显示最新版本（需求4） ---------- */
  {
    const apiVer = readApiVersion();
    const dl = await httpJson(`${API}/api/download/list`);
    const files = dl.body?.data?.files ?? dl.body?.files ?? [];
    const names = files.map((f) => String(f.file ?? ''));
    const hasCurrent = names.some((n) => n.includes(apiVer.version));
    const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    check(
      'B7 客户端分发清单包含当前版本（== services/api/package.json）',
      `GET /api/download/list 至少有一个文件名包含 version=${apiVer.version}`,
      `api version=${apiVer.version}；清单=${fmt(names)}；命中=${hasCurrent}`,
      dl.status === 200 && hasCurrent && files.length > 0,
      {
        repro: 'GET /api/download/list，与 services/api/package.json 的 version 比对',
        note: '需求4：后台客户端分发没有最新版本 —— 版本号必须只有一个事实源',
      },
    );

    const rel = await httpJson(`${API}/api/admin/releases`, { headers: H() });
    const relItems = rel.body?.data?.files ?? [];
    /*
     * 1.4 的后台 releases 已重构为「富结构」（T2 交付）：
     *   { file, version, platform, title, size, lastModified, url,
     *     isCurrent, inCurrentManifest, historical, onOss, onLocal, downloadable, available, downloads, ... }
     * 之前用 `f.key` 取名字恒为空（旧结构才有 key），是断言读错字段，不是接口错。
     */
    const relNames = relItems.map((f) => String(f.file ?? f.key ?? ''));
    const currentItems = relItems.filter((f) => f.isCurrent === true);
    const relHasCurrent = relNames.some((n) => n.includes(apiVer.version));
    check(
      'B8 后台「发布与分发」对象清单含当前版本，且当前版本被标记 isCurrent',
      `GET /api/admin/releases 的 files 里至少一个 file 包含 ${apiVer.version}，且存在 isCurrent=true 的条目`,
      `status=${rel.status} 文件数=${relItems.length} 命中=${relHasCurrent} 当前版本条目=${fmt(currentItems.map((f) => `${f.file}(v${f.version}, downloadable=${f.downloadable})`))}；样例=${fmt(relItems.slice(0, 3).map((f) => f.file))}`,
      rel.status === 200 && relHasCurrent && currentItems.length > 0,
      {
        repro: 'GET /api/admin/releases，读 files[].file / version / isCurrent',
        note: '需求4：后台客户端分发没有最新版本；1.4 接口已给出 isCurrent/downloadable/isCurrentManifest 等标记',
      },
    );

    /* B8b：当前版本条目必须可下载（HEAD 探测 realOss/本地存在） */
    const currentDownloadable = currentItems.filter((f) => f.downloadable === true);
    check(
      'B8b 当前版本安装包标记为可下载（downloadable=true）',
      'isCurrent=true 的条目里至少 3 个（win zip / setup.exe / apk）downloadable=true',
      `当前版本条目 ${currentItems.length} 个，其中可下载 ${currentDownloadable.length} 个：${fmt(currentDownloadable.map((f) => f.file))}`,
      currentDownloadable.length >= 3,
      {
        repro: 'GET /api/admin/releases → 过滤 isCurrent=true → 看 downloadable 字段',
        note: '需求4 要求显示「是否可下载」；服务端做 HEAD 探测后给出该标记',
      },
    );

    // 三处版本号一致性（防止出现「第二个硬编码清单」）
    const pkgVer = String(rootPkg.version ?? '');
    check(
      'B9 版本号单一事实源：根 package.json 与 services/api/package.json 一致',
      `root=${pkgVer} 与 api=${apiVer.version} 必须相等（避免两个硬编码清单漂移）`,
      `root=${pkgVer} / api=${apiVer.version}`,
      pkgVer === apiVer.version && Boolean(pkgVer),
      { repro: '比对两个 package.json 的 version' },
    );
  }

  /* ---------- B10~B14：用户管理增强（需求5） ---------- */
  {
    const users = await httpJson(`${API}/api/admin/users?page=1&pageSize=5`, { headers: H() });
    const items = users.body?.data?.items ?? users.body?.data?.users ?? [];
    const first = items.find((u) => u.username !== 'admin') ?? items[0];

    check(
      'B10 用户列表接口可用（含分页与总数）',
      'GET /api/admin/users 返回 items 非空且给出 total',
      `status=${users.status} items=${items.length} total=${users.body?.data?.total ?? '?'}`,
      users.status === 200 && items.length > 0,
      { repro: 'GET /api/admin/users?page=1&pageSize=5' },
    );

    // 需求5：批量操作 / 封禁 / 导出 / 概览 —— 逐个探测接口是否存在
    /*
     * 判据：404/405 视为「接口不存在」，其它状态（含 400 参数校验失败）视为已实现。
     * 但 400 有两种来源，必须区分：
     *   - 我们的请求体不合规（说明路由存在）→ 算存在；
     *   - 路由根本不匹配但框架统一返回 400（Fastify 对某些畸形请求会这样做）→ 需看错误码。
     * 因此额外抓 error.code：命中 NOT_FOUND / ROUTE_NOT_FOUND 的 400 也算不存在。
     */
    const probes = [
      { name: 'B11 批量操作接口', method: 'POST', path: '/api/admin/users/batch', body: { action: 'noop', ids: [] } },
      { name: 'B12 用户封禁/状态接口', method: 'PUT', path: `/api/admin/users/${first?.id ?? 1}/status`, body: { status: 'active' } },
      { name: 'B13 用户导出 CSV 接口', method: 'GET', path: '/api/admin/users/export' },
      { name: 'B14 用户数据概览接口', method: 'GET', path: `/api/admin/users/${first?.id ?? 1}/overview` },
    ];
    for (const p of probes) {
      const r = await httpJson(`${API}${p.path}`, {
        method: p.method,
        headers: H(),
        ...(p.body ? { body: JSON.stringify(p.body) } : {}),
      });
      const code = String(r.body?.error?.code ?? '');
      const routeMissing =
        r.status === 404 ||
        r.status === 405 ||
        /NOT_FOUND|ROUTE_NOT_FOUND|METHOD_NOT_ALLOWED/i.test(code);
      const exists = !routeMissing;
      check(
        `${p.name}存在`,
        `${p.method} ${p.path} 不应返回 404/405 或 NOT_FOUND（400 参数校验失败算接口已实现）`,
        `status=${r.status} code=${fmt(code)}${exists ? '' : '（接口不存在）'} body=${fmt(r.body?.error?.message ?? '').slice(0, 100)}`,
        exists,
        {
          repro: `${p.method} ${p.path}`,
          note: '需求5 要求至少 5 项新增用户管理功能',
        },
      );
    }
  }

  /* ---------- B15：后台页面可打开（UI 层） ---------- */
  {
    const me = await httpJson(`${API}/api/admin/status`, { headers: H() });
    check(
      'B15 后台管理接口鉴权正常（admin 可访问）',
      'GET /api/admin/status 返回 200 且 ok',
      `status=${me.status} ok=${me.body?.ok}`,
      me.status === 200 && me.body?.ok === true,
      { repro: 'GET /api/admin/status（带 admin token）' },
    );
  }
}
