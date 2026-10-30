/**
 * 补全 settings.ts 中被替换成「（注释原文编码损坏，已清理）」占位符的注释。
 *
 * 这些占位符是更早一次「乱码清理」留下的：原注释被整行删掉、只留占位符，
 * 导致代码逻辑失去了「为什么这么写」的解释。这里按上下文把语义补回来。
 *
 * 只替换占位注释行本身（含缩进），不改动任何代码行。
 * 用法：node tools/re121-restore-placeholders.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(path.resolve(here, '..'), 'apps', 'web', 'src', 'stores', 'settings.ts');
const DRY = process.argv.includes('--dry');

/**
 * 行号 → 正确注释。行号取自当前文件（脚本执行前已核对过上下文）。
 * 说明：同一行号若语句已变，脚本会用 PLACEHOLDER 校验，避免误改。
 */
const MAP = {
  137: '  // 只有完全没有 themePresetId 时才迁移：用户已经选过主题就一律不动，避免覆盖新数据',
  171: '  // 这里的 appearance 来自旧数据，migrateLegacyAppearance 可能补出 themePresetId；',
  287: '    // appearance 需要拆成两个分区，其余键按 PLATFORM_SCOPED_KEYS 归属',
  395: '    // 平台分组里若残留主题字段（旧 payload 结构），补进 global 只做「缺失填充」，不覆盖已有值',
  448: '      // 敏感字段不进 localStorage：网页端只留在内存，桌面端交给安全存储',
  777: '    // 未显式选主题时的明暗回退依据 prefers-color-scheme',
  800: '      // 未设置字体时回落到界面字体，保持与界面一致的默认观感',
  803: '      // 页面级缩放单独存一份，供需要的样式读取（不影响界面组件）',
  959: '      // global 区已合并完毕，下面处理本平台分组的阅读体验字段',
  1074: '      // payload 结构为 v2：global 与「本平台」分组分开提交，服务端按分组浅合并',
  1100: '      // 云端已收下本地主题 → 清除脏标记，后续拉取可以正常接受云端值',
  1115: '      // 只重试一次：网络抖动时需要一次机会，但连续失败说明是服务端/鉴权问题，继续重试只会放大压力',
  1305: '    // 监听系统明暗变化，让「跟随系统」的用户无需手动切换',
  1310: '    // 主题预设或自定义主题列表变化时也要重算 CSS 变量（切主题会同时改这两者）',
};

const PLACEHOLDER = /编码损坏/;

const raw = fs.readFileSync(TARGET, 'utf8');
const lines = raw.split(/\r?\n/);

let applied = 0;
const skipped = [];
for (const [k, text] of Object.entries(MAP)) {
  const idx = Number(k) - 1;
  const cur = lines[idx];
  if (cur === undefined) {
    skipped.push(`${k}: 行不存在`);
    continue;
  }
  if (!PLACEHOLDER.test(cur)) {
    skipped.push(`${k}: 该行不是占位注释（行号可能漂移），跳过`);
    continue;
  }
  lines[idx] = text;
  applied += 1;
}

console.log(`计划替换 ${Object.keys(MAP).length} 行，实际 ${applied} 行，跳过 ${skipped.length} 行`);
for (const s of skipped) console.log(`  跳过 ${s}`);

if (!DRY) {
  fs.writeFileSync(TARGET, lines.join('\n'), 'utf8');
  console.log('已写回（UTF-8 无 BOM）');
} else {
  console.log('（--dry，未写盘）');
}
