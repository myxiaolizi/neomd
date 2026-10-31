/**
 * 命名设置乱码纠偏单测（1.4.0 需求9）。
 *
 * ## 背景
 *
 * 1.4.0 排查确认：设置里「命名模板」「AI 命名提示词」显示乱码，**不是 GBK 乱码**、
 * 也不是字符集问题，而是**历史版本遗留的脏数据**。原值经逐字符对齐反推：
 *   落库 `YY?MM?DD?HHMM-?input?`（21 字符）
 *   原值 `YY年MM月DD日HHMM-{input}`（21 字符）
 *   规则 = 非 ASCII 字符 或 花括号 `{` `}` → 单个 `?`
 *
 * 修复策略：读时纠偏（`mergeSettings()` 统一入口）+ 精确签名匹配。
 *
 * ## 本测试要守住的底线
 *
 * 1. **已知乱码形态必须被修复**（否则用户继续看到乱码）；
 * 2. **合法的用户自定义配置绝不能被误重置**（数据丢失比乱码更严重）。
 *
 * 第 2 条是重点：比例启发式（「`?` 占比高就重置」）会误杀 `A?B?C` 这类合法模板，
 * 因此实现改用精确签名表 + 强约束，这里为每种「像乱码但其实合法」的形态都留了用例。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AI_TITLE_PROMPT,
  defaultSettings,
  isGarbledAiPrompt,
  isGarbledFallback,
  isKnownGarbledTemplate,
  mergeSettings,
  repairGarbleNaming,
} from '../settings/settings';
import { DEFAULT_NAMING_TEMPLATE } from '@neomd/shared';

/* ------------------------------------------------------------------ */
/* 样本：实测从生产库/云端/localStorage 取到的真实乱码值                 */
/* ------------------------------------------------------------------ */

/** 真实的 template 落库值（DB、云端、localStorage 三方一致） */
const REAL_GARBLED_TEMPLATE = 'YY?MM?DD?HHMM-?input?';
/** 真实的 fallback 落库值（原值 `无标题`） */
const REAL_GARBLED_FALLBACK = '???';
/** 真实的 aiPrompt 落库值（163 字符，103 个 ?，与默认提示词等长） */
const REAL_GARBLED_AI_PROMPT =
  '????????????????? Markdown ??,???????????????\n??:\n1. ???????,????????????????;\n2. ?? 6-24 ???(?????????);\n3. ????????,????????;\n4. ???? / \\ : * ? " < > | ?????????';

function namingWith(over: Record<string, unknown>) {
  return { ...defaultSettings().naming, ...over } as ReturnType<typeof defaultSettings>['naming'];
}

/* ------------------------------------------------------------------ */

describe('乱码检测 · template 精确签名', () => {
  it('实测的线上乱码值能被识别', () => {
    expect(isKnownGarbledTemplate(REAL_GARBLED_TEMPLATE)).toBe(true);
  });

  it('旧版模板被破坏的其它已知变体也能识别', () => {
    expect(isKnownGarbledTemplate('YY?MM?DD?HHMM-?input')).toBe(true);
    expect(isKnownGarbledTemplate('YYYY?MM?DD?HHMM-?input?')).toBe(true);
  });

  it('当前默认模板（正确值）不识别为乱码', () => {
    expect(isKnownGarbledTemplate(DEFAULT_NAMING_TEMPLATE)).toBe(false);
  });

  it('【防误杀】合法的自定义模板不识别为乱码', () => {
    // 这些值都「含 ? 且不含 CJK」，比例启发式会误杀，精确签名不会
    for (const v of [
      'A?B?C', // ? 占比 40%
      '?????', // 全是问号但不在已知签名里
      'YYYY-MM-DD_HHmm',
      'Q{year}-第{input}问', // 含 CJK，安全
      'v{input}?',
      '', // 空串
    ]) {
      expect(isKnownGarbledTemplate(v), `不应判定为乱码: ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it('非字符串输入安全返回 false', () => {
    expect(isKnownGarbledTemplate(undefined)).toBe(false);
    expect(isKnownGarbledTemplate(null)).toBe(false);
    expect(isKnownGarbledTemplate(123)).toBe(false);
  });
});

describe('乱码检测 · fallback', () => {
  it('实测 `???`（原值「无标题」）被识别', () => {
    expect(isGarbledFallback(REAL_GARBLED_FALLBACK)).toBe(true);
  });

  it('正确的中文/英文/空值都不识别', () => {
    for (const v of ['无标题', 'Untitled', '', 'none', '?']) {
      expect(isGarbledFallback(v), `不应判定: ${JSON.stringify(v)}`).toBe(false);
    }
  });
});

describe('乱码检测 · aiPrompt 强约束', () => {
  it('实测的 163 字符乱码提示词被识别', () => {
    expect(REAL_GARBLED_AI_PROMPT.length).toBe(DEFAULT_AI_TITLE_PROMPT.length);
    expect(isGarbledAiPrompt(REAL_GARBLED_AI_PROMPT)).toBe(true);
  });

  it('默认提示词（正确值）不识别', () => {
    expect(isGarbledAiPrompt(DEFAULT_AI_TITLE_PROMPT)).toBe(false);
  });

  it('【防误杀】长度不等于默认值的英文提示词不识别', () => {
    // 即便全是问号，只要长度对不上就不动 —— 这是长度约束的价值
    const shortAscii = 'You are a title generator. Output only the title.';
    expect(shortAscii.length).not.toBe(DEFAULT_AI_TITLE_PROMPT.length);
    expect(isGarbledAiPrompt(shortAscii)).toBe(false);
    // 恰好等长的全问号串会被识别（属于极端构造，实际不可能出现）
    const exactLenQuestions = '?'.repeat(DEFAULT_AI_TITLE_PROMPT.length);
    expect(isGarbledAiPrompt(exactLenQuestions)).toBe(true);
  });

  it('【防误杀】含 CJK 的自定义提示词不识别（哪怕含问号）', () => {
    const custom = '请为下面的正文生成标题。要求：简洁？准确？不要解释。' + '?'.repeat(100);
    expect(isGarbledAiPrompt(custom)).toBe(false);
  });

  it('空值/undefined 不识别', () => {
    expect(isGarbledAiPrompt('')).toBe(false);
    expect(isGarbledAiPrompt(undefined)).toBe(false);
  });
});

describe('repairGarbleNaming · 纠偏行为', () => {
  it('三个字段全乱码 → 全部回落到默认值并备份原值', () => {
    const { naming, repaired, backup } = repairGarbleNaming(
      namingWith({
        template: REAL_GARBLED_TEMPLATE,
        fallback: REAL_GARBLED_FALLBACK,
        aiPrompt: REAL_GARBLED_AI_PROMPT,
      }),
    );
    expect(repaired.sort()).toEqual(['aiPrompt', 'fallback', 'template']);
    expect(naming.template).toBe(DEFAULT_NAMING_TEMPLATE);
    expect(naming.fallback).toBe('无标题');
    expect(naming.aiPrompt).toBe(DEFAULT_AI_TITLE_PROMPT);
    // 备份保留原值，便于误判时人工恢复
    expect(backup?.template).toBe(REAL_GARBLED_TEMPLATE);
    expect(backup?.fallback).toBe(REAL_GARBLED_FALLBACK);
    expect(backup?.aiPrompt).toBe(REAL_GARBLED_AI_PROMPT);
    expect(typeof backup?.at).toBe('number');
  });

  it('只有 template 乱码 → 只修 template，其余字段保持原样', () => {
    const { naming, repaired } = repairGarbleNaming(
      namingWith({
        template: REAL_GARBLED_TEMPLATE,
        fallback: '我的兜底名',
        aiPrompt: '自定义提示词，保持不动',
      }),
    );
    expect(repaired).toEqual(['template']);
    expect(naming.template).toBe(DEFAULT_NAMING_TEMPLATE);
    expect(naming.fallback).toBe('我的兜底名');
    expect(naming.aiPrompt).toBe('自定义提示词，保持不动');
  });

  it('完全正常的设置 → 一个字段都不动，backup 为 null', () => {
    const input = namingWith({});
    const { naming, repaired, backup } = repairGarbleNaming(input);
    expect(repaired).toEqual([]);
    expect(backup).toBeNull();
    expect(naming).toBe(input); // 引用不变（无变更）
  });

  it('【防误杀】合法的自定义模板原样保留', () => {
    const custom = 'Q{year}-第{input}问';
    const { naming, repaired } = repairGarbleNaming(namingWith({ template: custom }));
    expect(repaired).toEqual([]);
    expect(naming.template).toBe(custom);
  });

  it('修复后再次调用是幂等的（不会重复备份）', () => {
    const first = repairGarbleNaming(namingWith({ template: REAL_GARBLED_TEMPLATE }));
    const second = repairGarbleNaming(first.naming);
    expect(second.repaired).toEqual([]);
    expect(second.backup).toBeNull();
    expect(second.naming.template).toBe(DEFAULT_NAMING_TEMPLATE);
  });
});

describe('mergeSettings · 统一入口生效', () => {
  it('云端下发乱码 naming → 合并后被纠偏', () => {
    const local = defaultSettings();
    const merged = mergeSettings(local, {
      naming: {
        mode: 'datetime-input',
        template: REAL_GARBLED_TEMPLATE,
        fallback: REAL_GARBLED_FALLBACK,
        confirmBeforeRename: true,
        aiPrompt: REAL_GARBLED_AI_PROMPT,
        appendAiSummary: true,
      },
    });
    expect(merged.naming.template).toBe(DEFAULT_NAMING_TEMPLATE);
    expect(merged.naming.fallback).toBe('无标题');
    expect(merged.naming.aiPrompt).toBe(DEFAULT_AI_TITLE_PROMPT);
  });

  it('云端下发正常 naming → 正常合并，不被纠偏', () => {
    const local = defaultSettings();
    const merged = mergeSettings(local, {
      naming: { ...local.naming, template: 'YYYY-MM-DD_HHmm-{input}', fallback: '未命名' },
    });
    expect(merged.naming.template).toBe('YYYY-MM-DD_HHmm-{input}');
    expect(merged.naming.fallback).toBe('未命名');
  });

  it('remote 无 naming → 不触碰本地 naming', () => {
    const local = defaultSettings();
    const merged = mergeSettings(local, { appearance: { ...local.appearance, fontSize: 18 } });
    expect(merged.naming).toEqual(local.naming);
  });

  it('本地本身是乱码、云端干净 → 以云端为准（合并后正常）', () => {
    const local = defaultSettings();
    local.naming = namingWith({ template: REAL_GARBLED_TEMPLATE });
    const merged = mergeSettings(local, { naming: { ...defaultSettings().naming } });
    expect(merged.naming.template).toBe(DEFAULT_NAMING_TEMPLATE);
  });
});
