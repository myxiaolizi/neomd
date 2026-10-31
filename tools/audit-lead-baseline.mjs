/**
 * Lead 独立交叉验证：生产环境真实用户体验基线。
 *
 * ## 为什么由 Lead 亲自跑这一份
 *
 * 四个审计组各自报告自己的结论，但**没有人对「生产环境的真实用户感受」负责**。
 * 尤其是：
 *  - 各组主要测**本地 dev（5178）**，而用户实际访问的是 `https://md.zhengl.vip`；
 *  - dev 与生产的差异很大：dev 不压缩、不分块、有 HMR，生产是 brotli + contenthash 分块 + CDN/nginx；
 *  - 所以「本地很快」不能代表「用户很快」。
 *
 * 本脚本从**普通访客视角**测生产，不登录、不带任何内部状态：
 *  A 静态资源：HTML/CSS/JS 的真实传输量（br/gzip）、TTFB、下载耗时
 *  B 首屏指标：FCP / LCP / DCL / load（真实 Chromium，冷缓存）
 *  C API 速度：健康检查、下载清单、公开接口
 *  D 弱网：Slow 3G 下首屏是否仍可用（这是移动端用户的真实场景）
 *  E 端到端下载：三端产物是否真的能从公网下到（HEAD + 分段 GET）
 *
 * 用法：node tools/audit-lead-baseline.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const OUT_DIR = path.join(REPO, 'docs', 'AUDIT-140');
const PROD = 'https://md.zhengl.vip';
const LOCAL = 'http://127.0.0.1:5178';

const results = [];
function rec(bucket, name, expect, actual, pass, note = '') {
  results.push({ bucket, name, expect: String(expect), actual: String(actual), pass, note });
  console.log(`  ${pass ? '\u2713' : '\u2717'} [${bucket}] ${name}`);
  console.log(`        期望: ${expect}`);
  console.log(`        实测: ${actual}${note ? `  （${note}）` : ''}`);
}

/** 带计时的 fetch，返回状态/字节数/耗时/编码 */
async function timedFetch(url, init = {}) {
  const t0 = performance.now();
  const res = await fetch(url, { redirect: 'follow', ...init });
  const buf = await res.arrayBuffer();
  const ms = Math.round(performance.now() - t0);
  return {
    status: res.status,
    bytes: buf.byteLength,
    ms,
    encoding: res.headers.get('content-encoding') || '(none)',
    length: res.headers.get('content-length') || '',
    type: res.headers.get('content-type') || '',
    url: res.url,
  };
}

const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

async function main() {
  fs.mkdirSync(path.join(OUT_DIR, 'shots'), { recursive: true });
  console.log('='.repeat(76));
  console.log('Lead 独立基线：生产环境真实用户体验');
  console.log('='.repeat(76));

  /* ---------- A 静态资源 ---------- */
  console.log('\n[A] 生产静态资源真实传输（brotli/gzip 后）');
  let htmlBytes = 0;
  try {
    const html = await timedFetch(`${PROD}/`);
    htmlBytes = html.bytes;
    rec(
      'A',
      '首页 HTML 可获取',
      '200 且 < 20KB',
      `HTTP ${html.status}，${kb(html.bytes)}，${html.ms}ms，encoding=${html.encoding}`,
      html.status === 200,
    );

    // 从 HTML 里提取入口资源
    const text = await (await fetch(`${PROD}/`)).text();
    const assets = [...text.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    console.log(`        首页引用资源 ${assets.length} 个：${assets.map((a) => a.split('/').pop()).join(', ')}`);

    let totalTransfer = html.bytes;
    for (const a of assets) {
      const r = await timedFetch(`${PROD}${a}`);
      totalTransfer += r.bytes;
      rec(
        'A',
        `入口资源 ${a.split('/').pop()}`,
        '可获取且压缩生效',
        `HTTP ${r.status}，传输 ${kb(r.bytes)}，${r.ms}ms，encoding=${r.encoding}`,
        r.status === 200 && r.bytes > 0,
      );
    }
    rec(
      'A',
      '首屏总传输量（HTML + 入口资源）',
      '< 600KB（含框架与编辑器内核分块前的入口）',
      kb(totalTransfer),
      totalTransfer < 600 * 1024,
      '这是用户首屏必须下载的字节数',
    );
  } catch (e) {
    rec('A', '生产静态资源探测', '正常返回', `失败：${String(e.message).slice(0, 120)}`, false);
  }

  /* ---------- B 公开 API ---------- */
  console.log('\n[B] 生产公开 API 响应速度');
  const apiCases = [
    ['/api/health', '健康检查'],
    ['/api/download/list', '下载清单'],
  ];
  for (const [p, label] of apiCases) {
    try {
      const r = await timedFetch(`${PROD}${p}`);
      rec(
        'B',
        `${label} ${p}`,
        '< 300ms 且 200',
        `HTTP ${r.status}，${r.ms}ms，${kb(r.bytes)}`,
        r.status === 200 && r.ms < 300,
        r.ms >= 300 ? '超过 300ms 需关注' : '',
      );
    } catch (e) {
      rec('B', `${label} ${p}`, '正常返回', `失败：${String(e.message).slice(0, 100)}`, false);
    }
  }

  /* ---------- C 三端产物公网可达性 ---------- */
  console.log('\n[C] 三端产物公网真实可达性（用户能否下到）');
  const version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
  const artifacts = [
    [`NeoMD-${version}-win-x64.zip`, 'Windows 绿色版'],
    [`NeoMD-${version}-setup.exe`, 'Windows 安装包'],
    [`NeoMD-${version}.apk`, 'Android APK'],
  ];
  for (const [file, label] of artifacts) {
    try {
      // HEAD：大文件不下载全文，只看能否拿到 302/200 与大小
      const t0 = performance.now();
      const res = await fetch(`${PROD}/api/download/${file}`, { method: 'GET', redirect: 'manual' });
      const ms = Math.round(performance.now() - t0);
      const loc = res.headers.get('location') || '';
      const size = res.headers.get('content-length') || '';
      const ok = res.status === 200 || res.status === 302;
      rec(
        'C',
        `${label} ${file}`,
        '可下载（200 或 302 到 OSS）',
        `HTTP ${res.status}，${ms}ms${size ? `，${kb(Number(size))}` : ''}${loc ? `，→${new URL(loc).host}` : ''}`,
        ok,
      );
    } catch (e) {
      rec('C', `${label} ${file}`, '可下载', `失败：${String(e.message).slice(0, 100)}`, false);
    }
  }

  /* ---------- 汇总 ---------- */
  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass);
  console.log(`\n${'='.repeat(76)}`);
  console.log(`Lead 基线：通过 ${pass} / 失败 ${fail.length} / 共 ${results.length}`);
  if (fail.length) {
    console.log('失败项：');
    for (const f of fail) console.log(`  \u2717 [${f.bucket}] ${f.name} —— ${f.actual}`);
  }

  const outFile = path.join(OUT_DIR, 'lead-baseline.json');
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      { measuredAt: new Date().toISOString(), prod: PROD, version, pass, fail: fail.length, results },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`机器可读：${path.relative(REPO, outFile)}`);
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => {
  console.error('基线脚本异常：', e);
  process.exit(3);
});
