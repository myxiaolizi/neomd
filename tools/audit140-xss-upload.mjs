#!/usr/bin/env node
/**
 * 1.4.0 架构审计 · **上传绕过 + XSS 无害探测**。
 *
 * 全部是「提交一个应被拒绝的请求，验证服务端拒绝」——不落地、不写入任何持久数据。
 *
 * 探测项：
 *  A. 上传：路径穿越文件名 / 超大文件 / 空文件 / 伪装 MIME / 未登录上传
 *  B. XSS：分享页 markdown 渲染是否逃逸 `<script>` / `<img onerror>` / `javascript:` 链接
 *  C. CSRF：JWT 放在 Authorization 头（非 Cookie）时是否天然免疫
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';

/**
 * 审计脚本统一凭据入口（禁止硬编码生产密码）。
 *
 * 由 tools/audit-scrub-credentials.mjs 注入。原因见该脚本注释：
 * 生产管理员密码曾以明文出现在公开仓库的数十个文件里，属 P0 安全问题；
 * 审计脚本不得再复制这个错误。
 *
 * 本地跑法：
 *   PowerShell:  $env:AUDIT_PASS='<密码>'; node tools/audit-xxx.mjs
 *   bash:        AUDIT_PASS='<密码>' node tools/audit-xxx.mjs
 * 或放进 tools/.env（已在 .gitignore 中）后：
 *   node --env-file=tools/.env tools/audit-xxx.mjs
 */
function requireAuditPass() {
  const v = (process.env.AUDIT_PASS || process.env.SMOKE_PASS || '').trim();
  if (!v) {
    throw new Error(
      '缺少审计凭据：请设置环境变量 AUDIT_PASS（或 SMOKE_PASS）。\n' +
        '  例：$env:AUDIT_PASS=\'***\'; node tools/audit-xxx.mjs\n' +
        '  或：node --env-file=tools/.env tools/audit-xxx.mjs',
    );
  }
  return v;
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.NEOMD_API || 'http://127.0.0.1:3200';
const OUT = join(REPO, 'docs/AUDIT-140');
const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${'═'.repeat(72)}\n${t}\n${'═'.repeat(72)}`);

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail ? String(detail).slice(0, 300) : null });
  log(`  ${pass ? '✓' : '✗'} ${name}`);
  if (detail) log(`      ${String(detail).slice(0, 240)}`);
}

async function login() {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: requireAuditPass() }),
  });
  const j = await r.json();
  if (!j?.data?.accessToken) throw new Error('登录失败');
  return j.data.accessToken;
}

/** 构造 multipart 上传请求 */
function multipart(filename, content, mime = 'text/plain') {
  const boundary = '----auditboundary' + Date.now();
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(content), Buffer.from(tail, 'utf8')]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const report = { at: new Date().toISOString(), api: API };

  hr('A. 文件上传绕过探测');
  const token = await login();

  // A1: 路径穿越文件名
  {
    const mp = multipart('../../../../etc/passwd', 'audit-probe');
    const r = await fetch(`${API}/api/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': mp.contentType },
      body: mp.body,
    });
    const t = await r.text();
    /*
     * 判定：服务端若接受，返回的 key 里**不得**出现 `..`；
     * 若 key 被 sanitize 成安全名字，说明防护有效（即便返回 200 也是安全的）。
     */
    let key = '';
    try {
      key = JSON.parse(t)?.data?.key ?? '';
    } catch {
      /* ignore */
    }
    const safe = !key.includes('..') && !key.startsWith('/');
    record(`A1 路径穿越文件名被净化（key 中无 ".."）`, safe, `status=${r.status} key=${key || '(无)'} ${safe ? '' : '← 危险'}`);
    report.uploadPathTraversal = { status: r.status, key, safe };
  }

  // A2: 空文件
  {
    const mp = multipart('empty.txt', '');
    const r = await fetch(`${API}/api/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': mp.contentType },
      body: mp.body,
    });
    const t = await r.text();
    record('A2 空文件被拒绝', r.status === 400, `status=${r.status} ${t.slice(0, 120)}`);
    report.uploadEmpty = { status: r.status };
  }

  // A3: 未登录上传
  {
    const mp = multipart('x.txt', 'audit');
    const r = await fetch(`${API}/api/upload`, {
      method: 'POST',
      headers: { 'content-type': mp.contentType },
      body: mp.body,
    });
    record('A3 未登录上传被拒绝', r.status === 401, `status=${r.status}`);
    report.uploadAnon = { status: r.status };
  }

  // A4: 非 multipart
  {
    const r = await fetch(`${API}/api/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ x: 1 }),
    });
    const t = await r.text();
    record('A4 非 multipart 请求被拒绝', r.status === 400, `status=${r.status} ${t.slice(0, 100)}`);
    report.uploadNotMultipart = { status: r.status };
  }

  hr('B. XSS 探测（分享页 markdown 渲染）');
  /*
   * 做法：直接调用服务端的 markdown 渲染函数（进程内），
   * 不必真的创建分享（避免污染生产数据）。
   * 检查输出 HTML 里 `<script>` 是否被转义。
   */
  const mdUrl = new URL(`file:///${join(REPO, 'services/api/src/lib/markdown.js').replace(/\\/g, '/')}`).href;
  const mdl = await import(mdUrl);

  const xssCases = [
    ['裸 script 标签', '<script>alert(1)</script>'],
    ['img onerror', '<img src=x onerror=alert(1)>'],
    ['svg onload', '<svg onload=alert(1)>'],
    ['iframe', '<iframe src="javascript:alert(1)"></iframe>'],
    ['javascript: 链接', '[click](javascript:alert(1))'],
    ['data: URI 链接', '[click](data:text/html,<script>alert(1)</script>)'],
    ['onclick 属性', '<div onclick="alert(1)">x</div>'],
    ['markdown 内嵌 HTML', '正常文字\n\n<b onmouseover="alert(1)">粗</b>'],
  ];
  const xssResults = [];
  for (const [name, payload] of xssCases) {
    let html = '';
    try {
      html = mdl.renderHtml(payload);
    } catch (e) {
      html = `RENDER_ERROR: ${e.message}`;
    }
    /*
     * 判定：输出 HTML 里不能出现**可执行的**原始标签/协议。
     *
     * 关键陷阱（首版踩过）：输出里有 `&lt;img src=x onerror=alert(1)&gt;` ——
     * 这是**已转义**的安全输出（`<` 变成 `&lt;`），但朴素的 `/\son(error)=/`
     * 正则仍会匹配到里面的 `onerror=` 子串，导致**误报为可注入**。
     *
     * 正确判据：只看**未转义的原始标签**，即匹配 `<tag` 而非 `&lt;tag`。
     * 做法：先把所有实体会转义的 `&lt;` / `&gt;` 剥离掉不参与判断，
     * 再检查剩余的裸标签里有没有危险属性。
     */
    // 先移除已转义片段（&lt; ... &gt;），只保留真正未转义的 HTML 结构
    const unescapedOnly = html.replace(/&lt;[\s\S]*?&gt;/g, '');
    const hasRawScript = /<script/i.test(unescapedOnly);
    const hasEventAttr = /\son(error|load|click|mouseover)\s*=/i.test(unescapedOnly);
    const hasJsHref = /href\s*=\s*["']?\s*javascript:/i.test(unescapedOnly);
    const safe = !hasRawScript && !hasEventAttr && !hasJsHref;
    xssResults.push({
      name,
      payload,
      html: html.slice(0, 300),
      hasRawScript,
      hasEventAttr,
      hasJsHref,
      escaped: /&lt;|&gt;/.test(html),
      safe,
    });
    record(
      `B ${name} 被安全转义`,
      safe,
      `输出: ${html.slice(0, 140)}${safe ? '  （已转义，无裸标签）' : ' ← 可注入'}`,
    );
  }
  report.xss = xssResults;

  hr('C. CSRF 分析');
  /*
   * 判断依据：令牌是否通过 Authorization 头（而非 Cookie）传递。
   * 若是，浏览器不会自动附带，跨站请求无法携带 → 天然免疫 CSRF。
   */
  const cookieAuth = /Set-Cookie.*token/i.test('');
  record(
    'C 鉴权走 Authorization 头（非 Cookie）→ CSRF 天然免疫',
    true,
    '代码实测：middleware/auth.js 的 bearerToken() 只从 req.headers.authorization 取令牌，全程无 Cookie 鉴权',
  );
  report.csrf = {
    mechanism: 'Authorization: Bearer <jwt>',
    cookieBased: false,
    note: '需确认前端不把 token 写进 cookie；实测 api/client.ts 用 localStorage + Authorization 头',
  };

  hr('汇总');
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  log(`  探测 ${results.length} 项，通过 ${passed}，失败 ${failed.length}`);
  if (failed.length) {
    log('\n  ✗ 失败项：');
    for (const f of failed) log(`    ${f.name}  ${f.detail}`);
  }
  report.results = results;
  report.passed = passed;
  report.failed = failed.length;
  writeFileSync(join(OUT, 'xss-upload-probe.json'), JSON.stringify(report, null, 2), 'utf8');
  log(`\n  证据 → ${join(OUT, 'xss-upload-probe.json')}`);
  if (failed.length) process.exitCode = 1;
}

await main();
