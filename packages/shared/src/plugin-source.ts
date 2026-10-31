/**
 * 社区插件源码解析器（1.4.0）。
 *
 * ## 为什么要有这个文件
 *
 * 社区插件是**单文件 ESM 模块**，形如：
 *
 * ```js
 * /** 说明注释 *\/
 * export default { id, name, version, setup(api) { ... } };
 * ```
 *
 * 宿主需要把它交给 `new Function(body)` 执行，因此得把 `export default` 换成
 * `return`。1.3.1 及以前这一步是**正则**做的：
 *
 * ```js
 * src.replace(/^\s*export\s+default\s+/m, 'return ')
 *    .replace(/\bexport\s+default\s+/, 'return ')   // ← 兜底，无锚点
 * ```
 *
 * 第二条兜底正则带来两个真实缺陷：
 *
 * 1. **语义被静默改写**：插件里只要有一处字符串 / 模板 / 注释写了
 *    `export default` 这几个字（例如生成文档时输出代码示例），第一处行首替换
 *    成功之后，兜底正则就会把**字符串里的那处**改成 `return` —— 插件不再报错，
 *    但行为已经错了。静默的错误比崩溃更危险。
 * 2. **注释被压成一行时抛原生 SyntaxError**：`//` 行注释会吞掉本行剩余内容。
 *    若源码被打包成单行，注释后的 `}`、`)` 全部被吞 => 括号不闭合，
 *    `new Function` 抛出裸的 `SyntaxError: Unexpected token ')'`，
 *    用户只看到一句无从下手的英文。
 *
 * ## 做法：不用正则，逐字符扫描
 *
 * 本模块用**状态机**扫描源码，逐字符标记「这个位置是不是真正的代码」，
 * 正确跳过：
 *
 * - 单引号 / 双引号字符串（含转义）；
 * - 模板字符串（含嵌套 `${ ... }`，且 `${}` 内部重新算作代码）；
 * - 行注释 / 块注释；
 * - 正则字面量（含字符类 `[...]` 与转义）—— 依据「上一个有效 token」判断
 *   `/` 是除号还是正则起始。
 *
 * 然后只在**代码位置**、且**花括号深度为 0**（模块顶层）处寻找 `export default`，
 * 精确替换那一处。字符串、模板、注释里的同样字样**永远不会被碰到**。
 *
 * 顺带解决两件事：
 * - 多个 `export default` => 可读错误（而不是静默取第一个）；
 * - 括号不闭合（典型成因就是注释吞行）=> 可读错误，提示是注释问题，
 *   而不是把浏览器原生 `SyntaxError` 直接甩给用户。
 *
 * 本文件不依赖 DOM / Node API，可被 vitest（node 环境）直接单测。
 */

/** 插件源码的**可读**错误。宿主应当把 `message` 原样展示给用户。 */
export class PluginSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginSourceError';
  }
}

/** 扫描结果：`code[i] === 1` 表示第 i 个字符属于**真正的代码**（不在字符串/模板/注释/正则里） */
interface ScanResult {
  code: Uint8Array;
  /** 第 i 个字符处的花括号深度（仅 code 位置有意义） */
  depth: Int32Array;
  /** 扫描结束时仍未闭合的括号上下文数量（>0 说明源码括号不闭合） */
  unbalanced: number;
  /** 是否在模板字符串 / 字符串里出现过未闭合（用于给出更准的错误文案） */
  unterminatedLiteral: boolean;
}

type Ctx = { kind: 'code'; brace: number } | { kind: 'template' };

/** 判断标识符字符 */
function isIdentStart(c: string): boolean {
  return /[A-Za-z_$]/.test(c);
}
function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}

/**
 * 上一个有效 token 之后，`/` 是正则起始还是除号？
 *
 * 规则（与 JS 引擎的词法判定等价的常用近似）：
 * - 源码开头、或上一个有效字符是运算符 / 开括号 / 逗号 / 冒号 / 分号 / 关键字之后 => 正则；
 * - 上一个有效 token 是标识符、数字、`)`、`]`、`}` => 除号。
 */
function isRegexAllowed(prevChar: string, prevWord: string): boolean {
  if (prevChar === '') return true;
  if ('(,=:[!&|?{};+-*%^~<>/'.includes(prevChar)) return true;
  // 关键字之后允许正则字面量
  if (
    prevWord === 'return' ||
    prevWord === 'typeof' ||
    prevWord === 'instanceof' ||
    prevWord === 'in' ||
    prevWord === 'of' ||
    prevWord === 'new' ||
    prevWord === 'delete' ||
    prevWord === 'void' ||
    prevWord === 'case' ||
    prevWord === 'do' ||
    prevWord === 'else' ||
    prevWord === 'yield' ||
    prevWord === 'await'
  ) {
    return true;
  }
  return false;
}

/** 逐字符扫描，标记代码位置与括号深度 */
function scanSource(src: string): ScanResult {
  const n = src.length;
  const code = new Uint8Array(n);
  const depth = new Int32Array(n);
  const stack: Ctx[] = [{ kind: 'code', brace: 0 }];
  let unterminatedLiteral = false;
  let i = 0;
  let prevChar = '';
  let prevWord = '';

  while (i < n) {
    const top = stack[stack.length - 1]!;
    const c = src[i]!;

    /* ---------------- 模板字符串原文区 ---------------- */
    if (top.kind === 'template') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        stack.pop();
        prevChar = '`';
        prevWord = '';
        i += 1;
        continue;
      }
      if (c === '$' && src[i + 1] === '{') {
        // 进入插值表达式：内部重新是代码
        stack.push({ kind: 'code', brace: 0 });
        prevChar = '{';
        prevWord = '';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    /* ---------------- 代码区 ---------------- */
    // 空白：不改变 prevChar / prevWord
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
      i += 1;
      continue;
    }

    // 行注释：吞到行尾
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }

    // 块注释
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) {
        unterminatedLiteral = true;
        i = n;
        break;
      }
      i = end + 2;
      continue;
    }

    // 字符串
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const d = src[j]!;
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === quote) {
          closed = true;
          j += 1;
          break;
        }
        if (d === '\n') break; // 单行字符串不允许裸换行
        j += 1;
      }
      if (!closed) unterminatedLiteral = true;
      prevChar = quote;
      prevWord = '';
      i = j;
      continue;
    }

    // 模板字符串起始
    if (c === '`') {
      stack.push({ kind: 'template' });
      i += 1;
      continue;
    }

    // 正则字面量
    if (c === '/' && isRegexAllowed(prevChar, prevWord)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const d = src[j]!;
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '\n') break; // 正则不能跨行 => 说明这不是正则，是除号
        if (inClass) {
          if (d === ']') inClass = false;
        } else if (d === '[') {
          inClass = true;
        } else if (d === '/') {
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      if (closed) {
        // 吃掉 flags
        while (j < n && /[a-z]/.test(src[j]!)) j += 1;
        prevChar = '/';
        prevWord = '';
        i = j;
        continue;
      }
      // 不是正则，按除号处理
      code[i] = 1;
      depth[i] = top.brace;
      prevChar = '/';
      prevWord = '';
      i += 1;
      continue;
    }

    // 花括号：维护深度与模板插值回退
    if (c === '{') {
      code[i] = 1;
      depth[i] = top.brace;
      top.brace += 1;
      prevChar = '{';
      prevWord = '';
      i += 1;
      continue;
    }
    if (c === '}') {
      if (top.brace === 0 && stack.length > 1 && stack[stack.length - 2]!.kind === 'template') {
        // 插值表达式结束，回到模板原文区
        stack.pop();
        i += 1;
        continue;
      }
      if (top.brace > 0) top.brace -= 1;
      code[i] = 1;
      depth[i] = top.brace;
      prevChar = '}';
      prevWord = '';
      i += 1;
      continue;
    }

    // 标识符 / 关键字
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j]!)) j += 1;
      const word = src.slice(i, j);
      for (let k = i; k < j; k += 1) {
        code[k] = 1;
        depth[k] = top.brace;
      }
      prevChar = word[word.length - 1]!;
      prevWord = word;
      i = j;
      continue;
    }

    // 数字：粗略吞掉数字字面量（含小数、指数、分隔符）
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxXoObBeE._n]/.test(src[j]!)) j += 1;
      for (let k = i; k < j; k += 1) {
        code[k] = 1;
        depth[k] = top.brace;
      }
      prevChar = src[j - 1]!;
      prevWord = '';
      i = j;
      continue;
    }

    // 其余作为普通代码字符
    code[i] = 1;
    depth[i] = top.brace;
    prevChar = c;
    prevWord = '';
    i += 1;
  }

  // 顶层 code 上下文必须都闭合
  let unbalanced = 0;
  for (let s = 0; s < stack.length; s += 1) {
    const ctx = stack[s]!;
    if (ctx.kind === 'code') {
      // 只剩根上下文时 brace 必须为 0；更深层上下文必然是被模板插值撑开的
      unbalanced += ctx.brace;
      if (s > 0) unbalanced += 1;
    } else {
      // 未闭合的模板字符串
      unbalanced += 1;
    }
  }

  return { code, depth, unbalanced, unterminatedLiteral };
}

/** 跳过非代码位置（空白 / 注释 / 字符串内容），得到下一个「代码字符」下标 */
function nextCodeIndex(src: string, code: Uint8Array, from: number): number {
  let k = from;
  while (k < src.length && code[k] !== 1) k += 1;
  return k;
}

/** 判断 `src` 在 `at` 处是否是完整标识符 `word`，且处于代码位置 */
function isWordAt(src: string, code: Uint8Array, at: number, word: string, targetDepth: number, depth: Int32Array): boolean {
  if (at + word.length > src.length) return false;
  if (src.slice(at, at + word.length) !== word) return false;
  // 每个字符都必须是代码位置
  for (let k = at; k < at + word.length; k += 1) {
    if (code[k] !== 1 || depth[k] !== targetDepth) return false;
  }
  // 边界：前后不能紧邻标识符字符
  const before = at > 0 ? src[at - 1]! : '';
  const after = at + word.length < src.length ? src[at + word.length]! : '';
  if (before && isIdentPart(before)) return false;
  if (after && isIdentPart(after)) return false;
  return true;
}

/** 收集所有「模块顶层」的 `export` 词位置 */
function findTopLevelWord(src: string, scan: ScanResult, word: string): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    if (scan.code[i] === 1 && scan.depth[i] === 0 && src[i] === word[0]) {
      if (isWordAt(src, scan.code, i, word, 0, scan.depth)) {
        out.push(i);
        i += word.length;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

export interface NormalizeResult {
  /** 可直接交给 `new Function` 的函数体 */
  body: string;
  /** 做了哪些改写（供调试 / 测试断言） */
  rewrites: string[];
}

/**
 * 把插件源码规范成 `new Function` 可执行的函数体。
 *
 * 行为约定：
 * - 已有 `export default` => 仅把**那一处**（模块顶层、代码区）替换为 `return `；
 * - 已经是 `return ...` 的函数体 => 原样返回（幂等）；
 * - 其他顶层 `export const/function/class ...` => 去掉 `export` 关键字；
 *   `export { ... }` => 整条删除；`export * ...` / `export ... from` => 可读错误；
 * - `import ...` => 可读错误（`new Function` 无法支持模块导入）；
 * - 多个 `export default` => 可读错误；
 * - 括号不闭合（典型成因：`//` 注释吞行）=> 可读错误，明确指出可能是注释问题。
 *
 * @throws {PluginSourceError} 源码无法安全转换时抛出
 */
export function normalizePluginSourceDetailed(codeJs: string): NormalizeResult {
  if (typeof codeJs !== 'string') {
    throw new PluginSourceError('插件源码必须是字符串');
  }
  const src = codeJs.replace(/^\uFEFF/, '');
  if (!src.trim()) {
    throw new PluginSourceError('插件源码为空');
  }

  const scan = scanSource(src);

  // 括号不闭合：最常见成因就是 `//` 行注释把右半边的括号吞掉了
  if (scan.unbalanced > 0 || scan.unterminatedLiteral) {
    throw new PluginSourceError(
      '插件源码括号或字符串未闭合，无法执行。常见原因是使用 `//` 行注释后，其后的代码（含 `}` `)`）被追加到了同一行而被注释吞掉；请把注释单独放一行，或改用 `/* */`。',
    );
  }

  // `import` 无法被 `new Function` 支持 —— 在改写前检查，位置信息才有效
  const importPositions = findTopLevelWord(src, scan, 'import');
  if (importPositions.length) {
    throw new PluginSourceError('插件源码使用了 `import` 导入语句，暂不支持；请把依赖代码内联进插件文件。');
  }

  const exportPositions = findTopLevelWord(src, scan, 'export');
  const defaultPositions: number[] = [];
  const namedExportPositions: number[] = [];
  for (const at of exportPositions) {
    const afterExport = nextCodeIndex(src, scan.code, at + 'export'.length);
    if (afterExport < src.length && isWordAt(src, scan.code, afterExport, 'default', 0, scan.depth)) {
      defaultPositions.push(at);
    } else {
      namedExportPositions.push(at);
    }
  }

  if (defaultPositions.length > 1) {
    throw new PluginSourceError('插件源码里出现了多个 `export default`，一个插件只能导出一个对象');
  }

  const rewrites: string[] = [];

  // 没有 export default：兼容旧脚本（已经是 `return {...}` 的函数体）。
  // 但若仍有具名 `export` 模块语法，`new Function` 会抛裸 SyntaxError，必须处理掉。
  if (defaultPositions.length === 0) {
    if (namedExportPositions.length === 0) {
      return { body: src, rewrites };
    }
    const onlyEdits = buildNamedExportEdits(src, scan, namedExportPositions, rewrites);
    return { body: applyEdits(src, onlyEdits), rewrites };
  }

  const exportAt = defaultPositions[0]!;
  const defaultAt = nextCodeIndex(src, scan.code, exportAt + 'export'.length);

  const edits = buildNamedExportEdits(src, scan, namedExportPositions, rewrites);
  // `export default` => `return`
  //
  // 这里必须一并吞掉 `default` 与后面的空白/注释，否则会踩 ASI：
  //   export default\n{ ... }   =>   return \n{ ... }   =>  ASI 在 return 后补分号
  //   => 对象字面量被当成块语句 => `Unexpected token ':'`
  // 把表达式首字符拉到 `return` 的同一行就不会有歧义。
  // 中间若夹了 `//` 行注释，转成 `/* */` 一并搬过去，避免它吞掉表达式。
  let exprStart = defaultAt + 'default'.length;
  const carriedComments: string[] = [];
  while (exprStart < src.length) {
    const ch = src[exprStart]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      exprStart += 1;
      continue;
    }
    if (ch === '/' && src[exprStart + 1] === '/') {
      const eol = src.indexOf('\n', exprStart + 2);
      const text = src.slice(exprStart + 2, eol < 0 ? src.length : eol);
      carriedComments.push(`/*${text.replace(/\*\//g, '* /')} */`);
      exprStart = eol < 0 ? src.length : eol;
      continue;
    }
    if (ch === '/' && src[exprStart + 1] === '*') {
      const end = src.indexOf('*/', exprStart + 2);
      if (end < 0) break;
      carriedComments.push(src.slice(exprStart, end + 2));
      exprStart = end + 2;
      continue;
    }
    break;
  }
  edits.push({
    start: exportAt,
    end: exprStart,
    text: `return ${carriedComments.length ? `${carriedComments.join(' ')} ` : ''}`,
  });
  rewrites.push('export default -> return');

  return { body: applyEdits(src, edits), rewrites };
}

interface SourceEdit {
  start: number;
  end: number;
  text: string;
}

/** 由后往前应用一批互不重叠的替换，避免下标偏移 */
function applyEdits(src: string, edits: SourceEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/**
 * 把具名 `export`（非 default）改造成可在函数体内执行的代码：
 * - `export const/let/var/function/class ...` => 去掉 `export` 关键字；
 * - `export { a, b };` => 整条删除（函数体里不需要再导出）；
 * - `export * from` / `export { } from` => 可读错误（无法静态内联）。
 */
function buildNamedExportEdits(
  src: string,
  scan: ScanResult,
  positions: number[],
  rewrites: string[],
): SourceEdit[] {
  const edits: SourceEdit[] = [];
  for (const at of positions) {
    const nextIdx = nextCodeIndex(src, scan.code, at + 'export'.length);
    const firstChar = src[nextIdx] ?? '';
    if (src.slice(nextIdx, nextIdx + 4) === 'from' || firstChar === '*') {
      throw new PluginSourceError('插件源码使用了 `export * from` / `export { } from` 再导出语法，暂不支持');
    }
    if (firstChar === '{') {
      // export { a, b }; 整条删除（找到匹配的 }）
      let k = nextIdx;
      let level = 0;
      let end = -1;
      while (k < src.length) {
        const ch = src[k]!;
        if (ch === '{' && scan.code[k] === 1) level += 1;
        else if (ch === '}' && scan.code[k] === 1) {
          level -= 1;
          if (level === 0) {
            end = k + 1;
            break;
          }
        }
        k += 1;
      }
      if (end < 0) throw new PluginSourceError('插件源码里的 `export { ... }` 语句不完整');
      // 吃掉可选分号
      let e = end;
      const semi = nextCodeIndex(src, scan.code, e);
      if (semi < src.length && src[semi] === ';') e = semi + 1;
      edits.push({ start: at, end: e, text: '' });
      rewrites.push('removed export-list');
      continue;
    }
    edits.push({ start: at, end: at + 'export'.length, text: '' });
    rewrites.push('stripped export keyword');
  }
  return edits;
}

/**
 * 把插件源码规范成可交给 `new Function` 的函数体。
 *
 * 语义安全：字符串 / 模板字符串 / 注释 / 正则里出现的 `export default` 字样
 * **不会**被改写（这正是 1.3.1 正则实现的缺陷）。
 *
 * @throws {PluginSourceError} 源码无法安全转换时抛出
 */
export function normalizePluginSource(codeJs: string): string {
  return normalizePluginSourceDetailed(codeJs).body;
}

/** 插件导出的对象形状（社区插件最小约定） */
export interface CommunityPluginModule {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  setup?: (api: unknown) => void;
  [key: string]: unknown;
}

/**
 * 把插件源码加载成模块对象。
 *
 * 这里是**唯一**把非受信字符串交给 `new Function` 的地方，安装 / 导入 / 发布
 * 三个入口都应该先调用它做预校验，坏插件当场报可读错误，而不是等到用户
 * 在功能区点按钮时才炸。
 *
 * @throws {PluginSourceError} 语法错误 / 导出形状不合法时抛出，带可读中文原因
 */
export function loadPluginModule(codeJs: string): CommunityPluginModule {
  const body = normalizePluginSource(codeJs);
  let factory: () => unknown;
  try {
    // eslint-disable-next-line no-new-func
    factory = new Function(body) as () => unknown;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new PluginSourceError(`插件源码语法错误：${msg}`);
  }
  let mod: unknown;
  try {
    mod = factory();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new PluginSourceError(`插件加载时抛错：${msg}`);
  }
  // `export default function () { return {...} }` —— 工厂函数写法，调用一次取对象
  if (typeof mod === 'function') {
    try {
      mod = (mod as () => unknown)();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new PluginSourceError(`插件工厂函数执行时抛错：${msg}`);
    }
  }
  if (!mod || typeof mod !== 'object') {
    throw new PluginSourceError('插件必须 `export default` 一个对象，例如 `export default { id, name, setup(api) {...} }`');
  }
  return mod as CommunityPluginModule;
}
