/**
 * [E] 数据（需求 9 / 10）
 * =============================================================================
 * 需求9：命名模板 + AI 命名提示词出现乱码
 *   本仓库有两种乱码，必须分开查（任务书明确要求）：
 *    (a) **源文件被 GBK 破坏**（PowerShell Set-Content 事故）——
 *        表现为 `閿|銆|鏂|鐨|鈥` 这类典型误解码字符；
 *    (b) **数据层乱码** —— 源文件正常，但 localStorage / 云端里存的值已损坏。
 *
 *   实测发现（本脚本 E1~E3 会复现）：源文件 0 处乱码，但**云端 naming 是坏的**：
 *     template = "YY?MM?DD?HHMM-?input?"（应为 YYMMDD日HHMM-{input}）
 *     fallback = "???"（应为 无标题）
 *     aiPrompt 里 103 个 '?'（中文被有损转成问号）
 *   这是「中文经某种编码转换后不可逆丢失」的典型数据层乱码，不是 GBK 误解码。
 *
 * 需求10：admin 用户出现很多仓库（测试残留 / 自动注册重复）
 *   断言：仓库数量在合理范围、无 QA/selftest 残留、且本脚本自身不新增仓库。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  API,
  authHeaders,
  check,
  clickSettingsTab,
  fmt,
  httpJson,
  loadChromium,
  newSession,
  openSettings,
  openWorkbench,
  ROOT,
  section,
  state,
  THRESHOLD,
} from './common.mjs';

/** GBK 误解码的典型特征字符（(a) 类乱码） */
const GBK_MOJI = /[閿銆鏂鐨鈥锛鍚瀛缂鏄涓寮锟]|\uFFFD/;

/**
 * 有损乱码的判据：连续出现的 '?' 或替换字符。
 *
 * 为什么把 '?' 也当乱码：中文经 Latin-1/GBK 有损转换后会变成 '?'（U+003F），
 * 这是**不可逆**的损坏。正常的命名模板里不会有连续 '?'。
 * 判据取「连续 2 个以上 ?」以避免误伤合法问号。
 */
const LOSSY_MOJI = /\?{2,}|\uFFFD/;

/** 默认值（从源码读，作为「正确值」基准） */
const EXPECTED_TEMPLATE = 'YYMMDD日HHMM-{input}';
const EXPECTED_FALLBACK = '无标题';

export async function sectionE() {
  section('E', '数据（需求9：命名模板/AI 提示词乱码；需求10：admin 仓库残留）');

  /* ---------- E1：源文件乱码扫描（(a) 类） ---------- */
  {
    const files = [
      'packages/core/src/settings/settings.ts',
      'packages/shared/src/naming.ts',
      'apps/web/src/views/SettingsPage.vue',
      'apps/web/src/stores/settings.ts',
      'apps/web/src/stores/app.ts',
    ];
    const scan = [];
    for (const f of files) {
      try {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        /*
         * 必须逐行扫描并**排除注释行**。
         *
         * 为什么：仓库里有几处注释是在「描述这个乱码特征本身」，例如
         *   * 源文件按 UTF-8 扫描 GBK 特征串（`閿|銆|鏂|…`）**命中 0 处**；
         * 这些示例字符会被朴素正则误判成真乱码，产生假失败。
         * 正确做法：去掉 // 与 * 开头的注释部分后再扫，只检查**代码与字符串字面量**。
         */
        const lines = src.split('\n');
        const badLines = [];
        lines.forEach((line, i) => {
          const trimmed = line.trim();
          // 整行注释 / JSDoc 行 / 块注释 —— 跳过
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
          // 行尾注释也剥掉（保留字符串里的内容）
          const code = line.replace(/\/\/.*$/, '');
          const hits = code.match(new RegExp(GBK_MOJI.source, 'g')) || [];
          if (hits.length) badLines.push({ line: i + 1, hits: hits.length, sample: code.trim().slice(0, 90) });
        });
        scan.push({ file: f, hits: badLines.reduce((n, b) => n + b.hits, 0), badLines: badLines.slice(0, 3) });
      } catch (e) {
        scan.push({ file: f, hits: -1, badLines: [], error: String(e?.message ?? e).slice(0, 80) });
      }
    }
    const bad = scan.filter((s) => s.hits > 0);
    check(
      'E1 相关源文件无 GBK 误解码乱码（(a) 类，注释里的示例串已排除）',
      '5 个关键源文件的**代码与字符串字面量**里 GBK 典型误解码字符数为 0',
      bad.length
        ? `命中：${fmt(bad.map((b) => ({ file: b.file, hits: b.hits, lines: b.badLines })))}`
        : `0 命中（扫描 ${scan.length} 个文件：${scan.map((s) => s.hits).join('/')}）`,
      bad.length === 0 && scan.every((s) => s.hits >= 0),
      {
        repro: 'node 读源文件 utf8，逐行剥掉注释后匹配 閿|銆|鏂|鐨|鈥|锛|鍚|瀛|缂|鏄|涓|寮',
        note: 'PowerShell 的 Get-Content 默认 ANSI 解码看不到这类乱码，必须用 Node 读；注释里的示例串需排除',
      },
    );
  }

  /* ---------- E2/E3：云端与 localStorage 的数据层乱码（(b) 类） ---------- */
  {
    const cloud = await httpJson(`${API}/api/settings?platform=desktop`, { headers: authHeaders(state.token) });
    const payload = cloud.status === 200 && cloud.body?.ok ? cloud.body.data.payload : null;
    const naming = payload?.naming ?? {};

    const tpl = String(naming.template ?? '');
    const fb = String(naming.fallback ?? '');
    const aiPrompt = String(naming.aiPrompt ?? '');

    const tplLossy = LOSSY_MOJI.test(tpl);
    const fbLossy = LOSSY_MOJI.test(fb);
    const aiLossy = LOSSY_MOJI.test(aiPrompt);
    const aiQmarks = (aiPrompt.match(/\?/g) || []).length;

    check(
      'E2 云端 naming.template 无乱码且等于默认模板（需求9 核心）',
      `云端 naming.template === "${EXPECTED_TEMPLATE}"，且不含连续 '?' 等有损乱码`,
      `云端值=${fmt(tpl)}（长度 ${tpl.length}）；有损乱码=${tplLossy}；期望=${fmt(EXPECTED_TEMPLATE)}`,
      tpl === EXPECTED_TEMPLATE && !tplLossy,
      {
        repro: 'GET /api/settings?platform=desktop → 读 payload.naming.template',
        note: '实测缺陷：云端存的是 "YY?MM?DD?HHMM-?input?" —— 中文「日」与花括号被有损转成 ?',
      },
    );

    check(
      'E3 云端 naming.fallback 无乱码',
      `云端 naming.fallback === "${EXPECTED_FALLBACK}"`,
      `云端值=${fmt(fb)}；有损乱码=${fbLossy}`,
      fb === EXPECTED_FALLBACK && !fbLossy,
      { repro: 'GET /api/settings → payload.naming.fallback', note: '实测缺陷：云端存的是 "???"' },
    );

    check(
      'E4 云端 naming.aiPrompt 无乱码（中文完整）',
      `aiPrompt 含中文、不含**连续** '?'（单个 ? 可能是合法标点）、长度接近默认提示词（约 160 字符）`,
      `长度=${aiPrompt.length}；单个 '?'=${aiQmarks} 个；连续 '??' =${(aiPrompt.match(/\?{2,}/g) || []).length}；有损乱码=${aiLossy}；前 60 字=${fmt(aiPrompt.slice(0, 60))}`,
      !aiLossy && aiPrompt.length > 100 && /[\u4e00-\u9fff]/.test(aiPrompt),
      {
        repro: 'GET /api/settings → payload.naming.aiPrompt',
        note: '正常的中文提示词里可能含单个 ? （如「是否为…?」），故判据取「连续 2 个以上 ?」；坏数据的特征是整段中文变成 ???',
      },
    );

    // localStorage 侧同查（双查，任务书要求）
    const localCheck = await httpJson(`${API}/api/settings/version`, { headers: authHeaders(state.token) });
    check(
      'E5 settings 版本接口可用（便于前端判断是否需要重拉）',
      'GET /api/settings/version 返回 200 且给出 version 数字',
      `status=${localCheck.status} version=${fmt(localCheck.body?.data?.version)}`,
      localCheck.status === 200 && Number.isFinite(Number(localCheck.body?.data?.version)),
      { repro: 'GET /api/settings/version' },
    );
  }

  /* ---------- E6/E7：浏览器侧 DOM 值双查（设置页输入框实际文字） ---------- */
  {
    const chromium = await loadChromium();
    const { browser, page } = await newSession(chromium);
    try {
      await openWorkbench(page);
      await openSettings(page, '通用');
      await clickSettingsTab(page, '通用');
      await page.waitForTimeout(700);

      const dom = await page.evaluate(() => {
        const find = (re) => {
          const fields = Array.from(document.querySelectorAll('.settings .field, .settings .field--row'));
          const f = fields.find((x) => re.test(x.querySelector('.nm-label, label')?.textContent || ''));
          const el = f?.querySelector('input, textarea');
          return el ? { value: el.value, len: el.value.length } : null;
        };
        const local = (() => {
          try {
            return JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}').naming ?? {};
          } catch {
            return {};
          }
        })();
        return {
          template: find(/命名模板/),
          aiPrompt: find(/AI 命名提示词/),
          localTemplate: local.template ?? null,
          localAiLen: (local.aiPrompt ?? '').length,
        };
      });

      const domTpl = String(dom.template?.value ?? '');
      const domAi = String(dom.aiPrompt?.value ?? '');
      check(
        'E6 设置页「命名模板」输入框实际文字正确（DOM 侧）',
        `输入框 value === "${EXPECTED_TEMPLATE}"，不含连续 '?'`,
        `DOM value=${fmt(domTpl)}；localStorage=${fmt(dom.localTemplate)}`,
        domTpl === EXPECTED_TEMPLATE && !LOSSY_MOJI.test(domTpl),
        { repro: '设置 → 通用 → 读「命名模板」input 的 value' },
      );

      check(
        'E7 设置页「AI 命名提示词」文本框实际文字正确（DOM 侧）',
        'textarea 含中文、无连续 ?、长度 > 100',
        `DOM 长度=${domAi.length}；'?'=${(domAi.match(/\?/g) || []).length}；localStorage 长度=${dom.localAiLen}；前 60 字=${fmt(domAi.slice(0, 60))}`,
        domAi.length > 100 && !LOSSY_MOJI.test(domAi),
        { repro: '设置 → 通用 → 读「AI 命名提示词」textarea 的 value' },
      );
    } finally {
      await browser.close();
    }
  }

  /* ---------- E8~E10：需求10 admin 仓库 ---------- */
  {
    const v = await httpJson(`${API}/api/vaults`, { headers: authHeaders(state.token) });
    const list = v.status === 200 && v.body?.ok ? (v.body.data?.vaults ?? []) : [];
    const items = Array.isArray(list) ? list : [];

    /** 测试残留特征：名称/ID 命中 QA/selftest/re12x 等前缀 */
    const residueRe = /^(QA121-|QA140-|re121|re14|vaultre121|selftest|test-|qa-)/i;
    const residue = items.filter((x) => residueRe.test(String(x.vaultId ?? '')) || residueRe.test(String(x.name ?? '')));
    const emptyVaults = items.filter((x) => Number(x.docCount ?? 0) === 0);

    check(
      'E8 admin 仓库数量在合理范围（需求10）',
      `仓库数 <= ${THRESHOLD.vaultCountMax}（测试残留不应推高数量）`,
      `实测 ${items.length} 个；空仓库 ${emptyVaults.length} 个；明细=${fmt(items.map((x) => `${x.vaultId}(${x.docCount ?? 0})`))}`,
      items.length <= THRESHOLD.vaultCountMax,
      {
        repro: 'GET /api/vaults，统计条数与 docCount',
        note: `实测缺陷：1.4 开工时观察到 10 个仓库，其中 5 个 docCount=0 的测试残留`,
      },
    );

    check(
      'E9 admin 仓库无 QA/selftest 测试残留',
      '没有任何 vaultId/name 命中 QA121-/QA140-/re121/selftest/test- 等测试前缀',
      residue.length ? `残留 ${residue.length} 个：${fmt(residue.map((x) => x.vaultId))}` : `0 个残留（共 ${items.length} 个仓库）`,
      residue.length === 0,
      {
        repro: 'GET /api/vaults，按测试前缀过滤',
        note: '需求10：admin 用户出现很多仓库，其中大量是测试遗留',
      },
    );

    check(
      'E10 空仓库（docCount=0）数量受控',
      'docCount === 0 的仓库数 <= 2（空仓库通常是自动注册/附着产生的幽灵条目）',
      `空仓库 ${emptyVaults.length} 个：${fmt(emptyVaults.map((x) => x.vaultId))}`,
      emptyVaults.length <= 2,
      {
        repro: 'GET /api/vaults，过滤 docCount === 0',
        note: 'registry 的 pullVaultList 会把云端清单自动附着为 available:false 条目，易堆积',
      },
    );
  }

  /* ---------- E11：本脚本自身未新增仓库（零污染自证，与 P 段呼应） ---------- */
  {
    const vaultWrites = state.selfWrites.filter((w) => /\/api\/vaults/.test(w.url));
    check(
      'E11 本脚本未发起任何建仓/改仓请求',
      'state.selfWrites 中对 /api/vaults 的写请求为 0 条',
      `自身写请求 ${vaultWrites.length} 条`,
      vaultWrites.length === 0,
      { note: '并行修复组会自建临时仓库，故按「本脚本自身写请求」自证' },
    );
  }
}
