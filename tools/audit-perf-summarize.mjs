/**
 * 汇总 raw/*.json → 打印报告所需的全部数字（避免手抄出错）
 * 用法：node tools/audit-perf-summarize.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'docs', 'AUDIT-140', 'raw');

const read = (n) => {
  const p = path.join(RAW, n);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

const J = (x) => (x === undefined || x === null ? 'null' : typeof x === 'object' ? JSON.stringify(x) : String(x));

console.log('##### 01-load #####');
const load = read('01-load.json');
if (load) {
  for (const k of Object.keys(load)) {
    const a = load[k]?.agg;
    if (!a) {
      console.log(`  ${k}: (无 agg)`);
      continue;
    }
    console.log(`  [${k}] rounds=${a.rounds} label=${a.label}`);
    for (const f of ['ttfb', 'fcp', 'lcp', 'dcl', 'load', 'shell', 'interactive', 'editable', 'cls', 'longTaskTotal', 'longTaskMax', 'resourceCount', 'resourceKB', 'jsHeapMB']) {
      console.log(`    ${f.padEnd(14)} ${J(a[f])}`);
    }
    console.log(`    healthGuard    ${J(a.health)}`);
  }
} else console.log('  缺失');

console.log('\n##### 02-bundle #####');
const bundle = read('02-bundle.json');
if (bundle) {
  const d = bundle.dist;
  if (d?.ok) console.log(`  磁盘：files=${d.fileCount} total=${Math.round(d.total / 1024)}KB js=${Math.round(d.jsTotal / 1024)}KB css=${Math.round(d.cssTotal / 1024)}KB`);
  if (d?.top) console.log('  TOP:', d.top.slice(0, 8).map((f) => `${f.name}=${Math.round(f.bytes / 1024)}KB`).join(' '));
  const cs = bundle.prod_coverageSummary;
  if (cs) {
    console.log(`  Coverage 首屏：total=${cs.baseline.totalKB}KB unused=${cs.baseline.unusedKB}KB (${cs.baseline.unusedPct}%)`);
    console.log(`  Coverage 打开后：total=${cs.afterEdit.totalKB}KB unused=${cs.afterEdit.unusedKB}KB (${cs.afterEdit.unusedPct}%)`);
    console.log('  逐脚本：');
    for (const x of cs.top) console.log(`    ${String(x.name).padEnd(44)} total=${String(x.totalKB).padStart(8)} used=${String(x.usedKB).padStart(8)} unused=${String(x.unusedKB).padStart(8)} ${x.unusedPct}%`);
  }
  const tr = bundle.prod_transfer;
  if (tr?.ok) {
    const rt = (tr.rt || []).filter((r) => /\.(js|css)$/.test(r.name));
    const enc = rt.reduce((s, r) => s + (r.encodedBodySize || 0), 0);
    const dec = rt.reduce((s, r) => s + (r.decodedBodySize || 0), 0);
    console.log(`  传输：解码 ${Math.round(dec / 1024)}KB → 传输 ${Math.round(enc / 1024)}KB（${dec ? Math.round((1 - enc / dec) * 100) : 0}% 压缩）`);
    console.log('  逐资源（解码/传输/耗时）：');
    for (const r of rt.sort((a, b) => b.decodedBodySize - a.decodedBodySize).slice(0, 12)) {
      console.log(`    ${String(r.name).slice(0, 42).padEnd(44)} ${String(Math.round(r.decodedBodySize / 1024)).padStart(6)}KB → ${String(Math.round(r.encodedBodySize / 1024)).padStart(6)}KB  ${r.duration}ms`);
    }
    const doc = (tr.records || []).find((r) => r.type === 'document');
    if (doc) console.log(`  HTML：encoding=${doc.encoding} length=${doc.headersLength}B cacheControl=${doc.cacheControl}`);
    const cc = {};
    for (const r of tr.records || []) {
      const key = `${r.type}|${r.cacheControl || ''}`;
      cc[key] = (cc[key] || 0) + 1;
    }
    console.log('  cache-control 分布：');
    for (const [k, v] of Object.entries(cc)) console.log(`    ${v} × ${k}`);
  }
} else console.log('  缺失');

console.log('\n##### 03-runtime #####');
const rt = read('03-runtime.json');
if (rt) {
  for (const k of Object.keys(rt)) {
    const r = rt[k]?.result;
    if (!r) continue;
    console.log(`  [${k}]`);
    if (r.long?.ok) {
      console.log(`    long  typing=${r.long.phases.typingMs}ms blocks=${r.long.phases.blocksMs}ms chars=${r.long.phases.textCharsAfterTyping}`);
      console.log(`          FPS typing=${r.long.fps.typing.fps} blocks=${r.long.fps.blocks.fps} scroll=${r.long.fps.scroll.fps}`);
      console.log(`          p95帧 typing=${r.long.fps.typing.p95FrameMs}ms blocks=${r.long.fps.blocks.p95FrameMs}ms scroll=${r.long.fps.scroll.p95FrameMs}ms`);
      console.log(`          jank typing=${r.long.fps.typing.jankPct}% blocks=${r.long.fps.blocks.jankPct}% scroll=${r.long.fps.scroll.jankPct}%`);
      console.log(`          heapGrowth=${r.long.heap.growthMB}MB`);
    }
    if (r.big?.ok) {
      console.log(`    big   create=${r.big.phases.createMs}ms render=${r.big.phases.renderMs}ms reopen=${r.big.phases.reopenMs}ms`);
      console.log(`          scrollFPS=${r.big.fpsScroll.fps} p95=${r.big.fpsScroll.p95FrameMs}ms jank=${r.big.fpsScroll.jankPct}%`);
      console.log(`          search=${J(r.big.searchTimes)}`);
      console.log(`          outline=${J(r.big.outline)} heap=${r.big.heap.usedMB}MB`);
    }
    if (r.tabs?.ok) {
      console.log(`    tabs  count=${r.tabs.tabCount} heap ${r.tabs.heap.before.usedMB}→${r.tabs.heap.after.usedMB}MB growth=${r.tabs.heap.growthMB}MB perTab=${r.tabs.heap.perTabMB}MB`);
      console.log(`          openTimes=${J(r.tabs.openTimes)}`);
      console.log(`          switchTimes=${J(r.tabs.switchTimes)}`);
    }
    if (r.leak?.ok) {
      console.log(`    leak  heap ${r.leak.baseline.usedMB}→${r.leak.final.usedMB}MB growth=${r.leak.growthMB}MB (${r.leak.growthPct}%)`);
      console.log(`          nodes ${r.leak.baseline.nodes}→${r.leak.final.nodes} (+${r.leak.nodeGrowth})`);
      console.log(`          listeners ${r.leak.baseline.listeners}→${r.leak.final.listeners} (+${r.leak.listenerGrowth})`);
      console.log(`          leakSuspected=${r.leak.leakSuspected}`);
    }
  }
} else console.log('  缺失');

console.log('\n##### 04-network #####');
const net = read('04-network.json');
if (net) {
  for (const k of Object.keys(net)) {
    const r = net[k]?.result;
    if (!r) {
      console.log(`  [${k}] skipped/无 result`);
      continue;
    }
    console.log(`  [${k}]`);
    if (r.apis) {
      console.log('    API：');
      for (const a of r.apis) console.log(`      ${String(a.name).padEnd(20)} ttfb=${String(a.ttfb.med).padStart(7)} total=${String(a.total.med).padStart(7)} p95=${String(a.total.p95).padStart(7)} ${String(a.bytes).padStart(7)}B enc=${a.encoding || '-'}`);
    }
    if (r.login) console.log(`    login total=${J(r.login.total)} 429=${r.login.rateLimited}`);
    if (r.concurrency) {
      console.log('    并发：');
      for (const c of r.concurrency) console.log(`      ${String(c.probe).padEnd(20)} serial=${c.serialMedianMs}ms conc.med=${c.concurrent.med}ms p95=${c.concurrent.p95}ms wall=${c.wallMs}ms deg=${c.degradationX}x 429=${c.rateLimited}`);
    }
    if (r.weak) {
      console.log('    弱网：');
      for (const w of r.weak) console.log(`      ${String(w.label).padEnd(22)} lat=${String(w.latency).padStart(4)} down=${String(w.downKBs).padStart(6)}KB/s shell=${String(w.shellMs).padStart(6)}ms FCP=${String(w.fcp).padStart(6)}ms LCP=${String(w.lcp).padStart(6)}ms editable=${w.editableMs}(${w.editableVia || '-'}) usable=${w.usable}`);
    }
    if (r.healthGuard) console.log(`    uptimeGuard=${J(r.healthGuard)}`);
  }
} else console.log('  缺失');

console.log('\n##### 05-backend #####');
const be = read('05-backend.json');
if (be) {
  if (be.serverTiming) {
    console.log('  服务端耗时：');
    for (const s of be.serverTiming) console.log(`    ${String(s['接口']).padEnd(22)} ttfb=${String(s['TTFB中位']).padStart(7)} body=${String(s['body中位']).padStart(6)} total=${String(s['总中位']).padStart(7)} p95=${String(s.p95).padStart(7)} ${String(s.KB).padStart(7)}KB ST=${s['Server-Timing']}`);
  }
  if (be.nplus1) {
    console.log('  N+1：');
    for (const n of be.nplus1) console.log(`    ${String(n['接口']).padEnd(22)} 20条=${String(n['20条ms']).padStart(7)} 100条=${String(n['100条ms']).padStart(7)} 耗时比=${String(n['耗时比']).padStart(6)} 体积比=${String(n['体积比']).padStart(5)} ${n['判定']}`);
  }
  if (be.sqlAudit) {
    const risky = be.sqlAudit.filter((f) => f.risk);
    console.log(`  SQL 静态审计：${be.sqlAudit.length} 条 SELECT，风险 ${risky.length} 条`);
    for (const f of risky.slice(0, 8)) console.log(`    ${f.file} tables=${f.tables} risk=${f.risk}`);
  }
  if (be.staticOrigin) {
    console.log('  静态来源：');
    for (const s of be.staticOrigin.results || []) console.log(`    ${String(s['目标']).padEnd(28)} ${String(s['状态']).padStart(4)} server=${String(s.Server || '-').padEnd(8)} enc=${String(s['压缩']).padEnd(8)} ${s['KB']}KB`);
    if (be.staticOrigin.headerDetail) {
      console.log('    响应头指纹：');
      for (const [n, h] of Object.entries(be.staticOrigin.headerDetail)) console.log(`      ${n}: server=${h.server} etag=${h.etag} enc=${h['content-encoding']} cc=${h['cache-control']}`);
    }
  }
  if (be.healthGuard) console.log(`  uptimeGuard=${J(be.healthGuard)}`);
} else console.log('  缺失');
