/**
 * 同步合并逻辑测试：threeWayMerge / diffLines，并模拟三设备收敛。
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(here, '.synctest.mjs')).toString());
const { threeWayMerge, diffLines } = mod;

let pass = 0;
let fail = 0;
function check(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + label);
  } else {
    fail += 1;
    console.log('  ✗ ' + label + (extra ? ' — ' + extra : ''));
  }
}

console.log('三方合并');
check(threeWayMerge('a\nb\nc', 'a\nB\nc', 'a\nb\nC') === 'a\nB\nC', '不同行修改可自动合并');
check(threeWayMerge('a\nb\nc', 'a\nX\nc', 'a\nY\nc') === null, '同一行冲突返回 null');
check(threeWayMerge('a\nb', 'a\nb', 'a\nB') === 'a\nB', '仅远端修改取远端');
check(threeWayMerge('a\nb', 'a\nB', 'a\nb') === 'a\nB', '仅本地修改取本地');
check(threeWayMerge('same', 'same', 'same') === 'same', '完全相同直接返回');
check(threeWayMerge('# 标题\n\n正文\n\n- 项目', '# 标题\n\n正文改了\n\n- 项目', '# 标题\n\n正文\n\n- 项目二') === '# 标题\n\n正文改了\n\n- 项目二', '中文多行不同位置合并');
check(threeWayMerge('', 'new\n', '') === 'new\n', '空基线新增内容');

console.log('\n行级 diff');
const hunks = diffLines(['a', 'b', 'c'], ['a', 'B', 'c']);
check(hunks.length === 1 && hunks[0].baseStart === 1, 'diff 定位到第 2 行');
check(hunks[0].lines.join('') === 'B', 'diff 内容正确');

const addHunks = diffLines(['a'], ['a', 'b']);
check(addHunks.length === 1 && addHunks[0].lines[0] === 'b', '追加行被识别');

const noChange = diffLines(['a', 'b'], ['a', 'b']);
check(noChange.length === 0, '无变化时 diff 为空');

console.log('\n冲突场景（模拟两台设备同时编辑）');
const base = '# 会议纪要\n\n- 议题一\n- 议题二\n';
const deviceA = '# 会议纪要\n\n- 议题一（已确认）\n- 议题二\n';
const deviceB = '# 会议纪要\n\n- 议题一\n- 议题二\n\n补充：下次同步周三。\n';
const merged = threeWayMerge(base, deviceA, deviceB);
check(merged !== null, '两侧改不同位置可自动合并');
check(merged && merged.includes('已确认'), '合并结果保留设备 A 修改');
check(merged && merged.includes('下次同步周三'), '合并结果保留设备 B 修改');

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
