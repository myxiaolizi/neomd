/**
 * [G] 回归门禁
 * =============================================================================
 * 默认不跑（耗时 10+ 分钟），需 `--with-regression` 或 `--only=G` 显式开启。
 *
 *  G1 npx vitest run                       （1.3.1 基线：9 files / 236 passed）
 *  G2 vue-tsc --noEmit（apps/web）         （0 错误）
 *  G3 npx tsc -p tsconfig.json             （0 错误）
 *  G4 **node tools/verify-121.mjs**        （1.3.1 六项缺陷门禁必须仍全绿 —— 本版不允许回归）
 *  G5 services/api/src 全量 node --check
 *
 * G4 是本版重点：1.3.1 修好的六项（行距 / 分屏配色 / 空行保真 / 历史版本 /
 * 设置项唯一 / 字体不被恢复）不允许被 1.4 的改动破坏，所以必须把上版门禁原样跑一遍。
 */

import fs from 'node:fs';
import path from 'node:path';
import { check, ROOT, section, sh, tail } from './common.mjs';

/** 1.3.1 发布基线（1.4 开工时实测值） */
const BASELINE_131 = {
  vitestPassed: 236,
  vitestFiles: 9,
  verify121AllPass: true,
};

export async function sectionG() {
  section('G', '回归门禁（vitest / vue-tsc / tsc / verify-121 / node --check）');

  /* G1：vitest */
  {
    const r = sh('npx', ['vitest', 'run'], { timeout: 900_000 });
    const passM = /Tests\s+(\d+) passed/.exec(r.out);
    const failM = /Tests\s+.*?(\d+) failed/.exec(r.out);
    const filesM = /Test Files\s+(\d+) passed/.exec(r.out);
    const passed = passM ? Number(passM[1]) : 0;
    const failed = failM ? Number(failM[1]) : 0;
    const filesCount = filesM ? Number(filesM[1]) : 0;
    check(
      'G1 vitest 全量单测',
      `0 failed（1.3.1 基线 ${BASELINE_131.vitestFiles} files / ${BASELINE_131.vitestPassed} passed；1.4 允许新增，总数不得下降）`,
      `files=${filesCount} passed=${passed} failed=${failed} exit=${r.code}${failed || r.code !== 0 ? `\n${tail(r.out, 1400)}` : ''}`,
      r.code === 0 && failed === 0 && passed >= BASELINE_131.vitestPassed,
      { repro: 'npx vitest run' },
    );
  }

  /* G2：vue-tsc（web 包） */
  {
    const r = sh('npx', ['vue-tsc', '--noEmit', '-p', 'tsconfig.json'], {
      cwd: path.join(ROOT, 'apps', 'web'),
      timeout: 900_000,
    });
    check(
      'G2 vue-tsc --noEmit（@neomd/web）',
      '0 个类型错误（exit=0）',
      r.code === 0 ? '0 错误' : `exit=${r.code}\n${tail(r.out, 1400)}`,
      r.code === 0,
      { repro: 'pnpm --filter @neomd/web exec vue-tsc --noEmit -p tsconfig.json' },
    );
  }

  /* G3：tsc（根 tsconfig：shared + core） */
  {
    const r = sh('npx', ['tsc', '-p', 'tsconfig.json'], { timeout: 900_000 });
    check(
      'G3 tsc -p tsconfig.json（shared + core）',
      '0 个类型错误（exit=0）',
      r.code === 0 ? '0 错误' : `exit=${r.code}\n${tail(r.out, 1400)}`,
      r.code === 0,
      { repro: 'npx tsc -p tsconfig.json' },
    );
  }

  /* G4：1.3.1 门禁 verify-121 必须仍然全绿（本版不允许回归） */
  {
    const r = sh('node', ['tools/verify-121.mjs', '--only=A,B,D,E,F'], { timeout: 1_500_000 });
    const out = r.out;

    /* 解析 summary 行：`  合计：通过 45 / 失败 0 / 跳过 0` */
    const totalM = /合计：通过\s*(\d+)\s*\/\s*失败\s*(\d+)\s*\/\s*跳过\s*(\d+)/.exec(out);
    const totals = totalM
      ? { pass: Number(totalM[1]), fail: Number(totalM[2]), skip: Number(totalM[3]) }
      : { pass: -1, fail: -1, skip: -1 };

    /* 失败项清单（正文与汇总各出现一次，去重） */
    const failedItems = [
      ...new Map(
        [...out.matchAll(/^\s*\u2717\s*\[([A-F]\d+)\]\s*(.+)$/gm)].map((m) => [m[1], { id: m[1], name: m[2].trim() }]),
      ).values(),
    ];

    check(
      'G4 1.3.1 门禁（verify-121）跑完并给出汇总',
      '输出含「合计：通过 N / 失败 M / 跳过 K」且 N > 0',
      totals.pass >= 0
        ? `合计 通过=${totals.pass} 失败=${totals.fail} 跳过=${totals.skip}（1.3.1 基线：45 通过 / 0 失败）`
        : `未解析到汇总行；exit=${r.code}\n${tail(out, 900)}`,
      totals.pass > 0,
      { repro: 'node tools/verify-121.mjs --only=A,B,D,E,F' },
    );

    check(
      'G5 1.3.1 六项缺陷门禁无失败（本版不允许回归）',
      'verify-121 的失败项必须为 0（行距/分屏配色/空行保真/历史版本/设置项唯一/字体不被恢复）',
      failedItems.length
        ? `失败 ${failedItems.length} 项：${failedItems.map((x) => `[${x.id}] ${x.name}`).join(' | ')}`
        : `0 项失败（通过 ${totals.pass} 项）`,
      failedItems.length === 0 && totals.fail <= 0,
      {
        repro: 'node tools/verify-121.mjs --only=A,B,D,E,F',
        note: '1.3.1 已修好的六项是本版的回归红线；任一失败都说明 1.4 的改动破坏旧修复',
      },
    );

    /* 逐段明细：便于定位是哪一项回归 */
    const secM = [...out.matchAll(/^\s+\[([A-F])\]\s*通过\s*(\d+)\s*\/\s*失败\s*(\d+)(?:\s*\/\s*跳过\s*(\d+))?/gm)].map((m) => ({
      sec: m[1],
      pass: Number(m[2]),
      fail: Number(m[3]),
      skip: m[4] ? Number(m[4]) : 0,
    }));
    const secFails = secM.filter((s) => s.fail > 0);
    check(
      'G6 1.3.1 门禁各段明细（逐段失败数 = 0）',
      'A / B / D / E / F 五段每段的失败数都为 0',
      secM.length
        ? secM.map((s) => `${s.sec}:${s.pass}/${s.fail}`).join(' ')
        : '未解析到段级明细',
      secM.length > 0 && secFails.length === 0,
      { repro: 'node tools/verify-121.mjs --only=A,B,D,E,F，读段级汇总' },
    );
  }

  /* G7：后端语法检查 */
  {
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) files.push(p);
      }
    };
    walk(path.join(ROOT, 'services', 'api', 'src'));
    const bad = [];
    for (const f of files) {
      const r = sh('node', ['--check', f], { timeout: 60_000 });
      if (r.code !== 0) bad.push({ file: path.relative(ROOT, f), out: tail(r.out, 300) });
    }
    check(
      'G7 services/api/src 全量 node --check',
      `${files.length} 个 .js 文件语法全部通过`,
      bad.length ? `${bad.length} 个失败：${JSON.stringify(bad).slice(0, 900)}` : `${files.length} 个文件全部通过`,
      bad.length === 0,
      { repro: 'Get-ChildItem services/api/src -Recurse -Filter *.js | % { node --check $_.FullName }' },
    );
  }
}
