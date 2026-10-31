/**
 * 插件源码解析器回归（1.4.0）。
 *
 * 覆盖 1.3.1 正则实现的两个**真实缺陷**：
 * - 用例 c：字符串里含 `export default` 字样 => 旧实现会把它静默改写成 `return`，
 *   插件不报错但语义已错。本测试断言**字符串原样保留**。
 * - 用例 e：`//` 行注释把同一行的后续代码吞掉 => 旧实现抛出裸
 *   `SyntaxError: Unexpected token ')'`。本测试断言抛出**可读**的
 *   `PluginSourceError`（不是 SyntaxError），且抱怨括注释。
 *
 * 另外覆盖文件头注释、`export default` 换行、模板字符串、正则字面量、
 * `return {...}` 幂等，以及 5 个真实市场插件样本。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PluginSourceError,
  loadPluginModule,
  normalizePluginSource,
  normalizePluginSourceDetailed,
} from '../plugin-source';

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

describe('normalizePluginSource：a~g 七个用例', () => {
  it('a. 文件头块注释之后写 export default，可执行', () => {
    const src = ['/** 插件说明\n * 多行注释\n */', 'export default { id: "a-plugin", name: "A", setup(api) { api.notify("ok"); } };'].join('\n');
    const body = normalizePluginSource(src);
    expect(body).not.toContain('export default');
    expect(body).toContain('return {');
    const mod = loadPluginModule(src);
    expect(mod.id).toBe('a-plugin');
    expect(typeof mod.setup).toBe('function');
  });

  it('b. export default 与对象之间换行，不触发 ASI 而丢失返回值', () => {
    const src = 'export default\n{ id: "b-plugin", name: "B", setup() {} };';
    const mod = loadPluginModule(src);
    expect(mod.id).toBe('b-plugin');
    expect(typeof mod.setup).toBe('function');
  });

  it('c. 字符串里出现 export default 字样，不被改写（旧正则会静默改坏语义）', () => {
    const src = [
      'const demo = "export default { id: 1 }";',
      'const tpl = `示例：export default { }`;',
      'export default { id: "c-plugin", name: demo, setup(api) { api.notify(tpl); } };',
    ].join('\n');
    const { body } = normalizePluginSourceDetailed(src);
    // 关键断言：两处「字样」原样保留
    expect(body).toContain('"export default { id: 1 }"');
    expect(body).toContain('`示例：export default { }`');
    // 且只有真正的那一处被替换成 return
    expect(body.match(/return /g)?.length).toBe(1);
    const mod = loadPluginModule(src);
    expect(mod.name).toBe('export default { id: 1 }');
  });

  it('d. 字符串 / 模板 / 正则里含 } 与 /，不影响括号配对与执行', () => {
    const src = [
      'const s = "}";',
      'const t = `} ${ { k: 1 }.k } }`;',
      'const r = /[}\\/]+/;',
      'export default { id: "d-plugin", name: "D", setup() { return [s, t, String(r)]; } };',
    ].join('\n');
    const mod = loadPluginModule(src);
    expect(mod.id).toBe('d-plugin');
    const api = { getMarkdown: () => '', setMarkdown: () => undefined, insertMarkdown: () => undefined, notify: () => undefined, getTitle: () => '', registerCommand: () => undefined };
    expect(() => (mod.setup as (a: unknown) => void)(api)).not.toThrow();
  });

  it('e. `//` 注释把代码吞成一行：抛可读 PluginSourceError，而不是裸 SyntaxError', () => {
    // 这一行是被「压缩/拼接」坏的源码：注释之后没有换行，`name: "y" };` 被注释吞掉
    const broken = 'export default { id: "e-plugin", // 注释里有 ) 和 } name: "y" };';
    let caught: unknown;
    try {
      normalizePluginSource(broken);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PluginSourceError);
    // 不能是原生 SyntaxError（那对用户完全不可读）
    expect((caught as Error).name).not.toBe('SyntaxError');
    expect((caught as Error).message).toContain('未闭合');
    // 并且要提示到注释这个成因
    expect((caught as Error).message).toContain('注释');
  });

  it('e2. 单行但合法的尾部行注释仍可执行', () => {
    const src = 'export default { id: "e2-plugin", name: "E2", setup(api) { api.notify("e2"); } }; // 尾部注释';
    const mod = loadPluginModule(src);
    expect(mod.id).toBe('e2-plugin');
  });

  it('f. 模板字符串（含插值与共引号）可执行', () => {
    const src = [
      'const tpl = `第一行',
      '第二行 ${1 + 1}',
      'export default 这句在模板里，不是代码',
      '`;',
      'export default { id: "f-plugin", name: "F", setup(api) { api.notify(tpl); } };',
    ].join('\n');
    const { body } = normalizePluginSourceDetailed(src);
    expect(body).toContain('export default 这句在模板里');
    const mod = loadPluginModule(src);
    expect(mod.id).toBe('f-plugin');
  });

  it('g. 已经是 return 形式（历史脚本）保持幂等', () => {
    const src = 'return { id: "g-plugin", name: "G", setup() {} };';
    const { body, rewrites } = normalizePluginSourceDetailed(src);
    expect(body).toBe(src);
    expect(rewrites).toEqual([]);
    expect(loadPluginModule(src).id).toBe('g-plugin');
  });
});

describe('normalizePluginSource：其他边界', () => {
  it('BOM 被剥离', () => {
    const src = '\uFEFFexport default { id: "bom" };';
    expect(normalizePluginSource(src).startsWith('return ')).toBe(true);
  });

  it('具名 export 被降级为普通声明，不产生 SyntaxError', () => {
    const src = ['export const VERSION = "1.0.0";', 'export function helper() { return VERSION; }', 'export default { id: "named", helper };'].join('\n');
    const mod = loadPluginModule(src);
    expect(mod.id).toBe('named');
  });

  it('import 语句给出可读错误（new Function 无法支持）', () => {
    const src = "import fs from 'node:fs';\nexport default { id: 'x' };";
    expect(() => loadPluginModule(src)).toThrow(PluginSourceError);
    try {
      loadPluginModule(src);
    } catch (e) {
      expect((e as Error).message).toContain('import');
    }
  });

  it('多个 export default 给出可读错误', () => {
    const src = 'export default { id: "a" };\nexport default { id: "b" };';
    expect(() => loadPluginModule(src)).toThrow(/多个 `export default`/);
  });

  it('空源码给出可读错误', () => {
    expect(() => loadPluginModule('   ')).toThrow(PluginSourceError);
  });

  it('export default 后面跟的是函数也支持', () => {
    const src = 'export default function () { return { id: "fn" }; }';
    const mod = loadPluginModule(src) as unknown as { id?: string };
    expect(mod.id).toBe('fn');
  });

  it('注释出现多个 export default 字样（非代码）不算重复导出', () => {
    const src = [
      '// export default 旧写法',
      '/* export default 也是旧写法 */',
      'export default { id: "comment-safe" };',
    ].join('\n');
    const mod = loadPluginModule(src);
    expect(mod.id).toBe('comment-safe');
  });
});

describe('真实市场插件样本（plugin-market/plugins）', () => {
  const samples = [
    '01-daily-standup-log.js',
    '11-word-count-badge.js',
    '13-heading-auto-number.js',
    '20-table-aligner.js',
    '26-meeting-minutes-brief.js',
  ];

  for (const name of samples) {
    it(`${name} 能解析并导出 id/name/setup`, () => {
      const src = readFileSync(`${REPO_ROOT}plugin-market/plugins/${name}`, 'utf8');
      const mod = loadPluginModule(src);
      expect(typeof mod.id).toBe('string');
      expect((mod.id ?? '').length).toBeGreaterThan(0);
      expect(typeof mod.name).toBe('string');
      expect(typeof mod.setup).toBe('function');
    });
  }
});
