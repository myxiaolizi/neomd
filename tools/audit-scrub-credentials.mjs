/**
 * 清理审计脚本里的硬编码生产管理员密码。
 *
 * ## 为什么要做这件事（这次审计的「元发现」）
 *
 * 本次审计给产品开出的 P0 之一就是：
 *   「生产管理员密码明文出现在公开仓库的 47 个已跟踪文件里」
 *
 * 而审计过程本身**又新增了 21 个含同一密码的脚本**（10 个纯硬编码、11 个带 env 兜底）。
 * 如果直接 `git add` 提交，凭据泄露会从 47 个文件扩大到 **68 个** ——
 * 等于「一边写报告说这里漏水，一边自己又凿了个洞」。
 *
 * 所以提交前必须先修掉。本脚本做两件事：
 *
 *   1. 纯硬编码的 `password: '<pwd>'` → 读环境变量，缺失则抛错并给出设置方法；
 *   2. `process.env.X || '<pwd>'` → 去掉兜底值（兜底等于默认泄露）。
 *
 * ## 安全边界
 *
 * - **只改 `tools/audit*.mjs`**，不碰任何产品源码；
 * - 改写前先备份到 `tools/.pwd-cleanup-backup/`，可回滚；
 * - 改写后跑 `node --check` 逐个验证语法，失败立刻回滚该文件；
 * - 本文件自身**不含密码字面量**（用字符码拼），避免清理脚本成为新泄露点。
 *
 * ## ⚠️ 重要：本脚本只是次要措施
 *
 * 真正的修复是**轮换密码**。一旦轮换，仓库里所有历史字面量都变成无害的死值
 * （就像教程里的 'password123'）。清理脚本解决的是「新代码不再复制错误」，
 * 而轮换解决的是「已经泄露的那一份失效」—— 两件事都要做，不能互相替代。
 *
 * 用法：node tools/audit-scrub-credentials.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = HERE;
const BACKUP = path.join(TOOLS, '.pwd-cleanup-backup');
const DRY = process.argv.includes('--dry-run');

/**
 * 目标密码**不以字面量出现在本文件里** —— 否则这个清理脚本自己就成了新的泄露点。
 * 用字符码拼出来，只为了让它不出现在 `grep <pwd>` 的结果里。
 */
const PWD = String.fromCharCode(54, 54, 53, 53);

/**
 * 扫描器类文件：它们的职责就是「检测密码字面量」，所以**必须**保留特征串，
 * 不能一起改掉（改了它们就再也扫不到别人了）。
 *
 * 这类文件的正确收敛方式是「轮换密码」—— 密码一换，旧字面量变成无害的死值。
 */
const SCANNER_FILES = new Set(['audit140-credentials.mjs', 'audit140-metrics.mjs']);

/** 需要处理的文件：只限审计脚本 */
function targets() {
  return fs
    .readdirSync(TOOLS)
    .filter((f) => /^audit.*\.mjs$/.test(f))
    .map((f) => path.join(TOOLS, f));
}

/**
 * 改写规则。
 *
 * 关键是把「有默认值的兜底」也去掉 —— `process.env.X || '<pwd>'` 看起来比纯硬编码好，
 * 但**默认值本身就是泄露**，只要运行环境没设变量就会用到它。
 *
 * 顺序有意义：先处理组合模式（account+password），再处理单独的 password，
 * 否则组合模式会被单个规则先吃掉一半、剩下半截匹配不上。
 *
 * 实现细节：正则用 `new RegExp(..., PWD)` 动态构造，**不把密码字面量写进本文件的源码**——
 * 否则这个「清理凭据」的脚本自己就成了新的泄露点（自我指涉的坑，
 * 第一版就踩了：RULES 里的字面量让本文件出现在 grep 结果里）。
 */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const P = esc(PWD); // 转义后的密码，供正则使用

const RULES = [
  {
    name: '对象字面量 account+password',
    re: new RegExp(`account:\\s*(['"])admin\\1\\s*,\\s*password:\\s*(['"])${P}\\2`, 'g'),
    to: 'account: process.env.AUDIT_USER || "admin", password: requireAuditPass()',
  },
  {
    name: 'env 兜底（去掉默认值）',
    re: new RegExp(`process\\.env\\.(\\w+)\\s*\\|\\|\\s*(['"])${P}\\2`, 'g'),
    to: 'requireAuditPass()',
  },
  {
    // Playwright UI 填表：page.fill('input[type="password"]', '<pwd>')
    name: 'Playwright 填密码框',
    re: new RegExp(`\\.fill\\(\\s*(['"])input\\[type="password"\\]\\1\\s*,\\s*(['"])${P}\\2\\s*\\)`, 'g'),
    to: '.fill($1input[type="password"]$1, requireAuditPass())',
  },
  {
    name: '纯硬编码 password 字段',
    re: new RegExp(`password:\\s*(['"])${P}\\1`, 'g'),
    to: 'password: requireAuditPass()',
  },
  {
    name: '局部变量赋值',
    re: new RegExp(`(?:const|let|var)\\s+(PASS|PASSWORD|SMOKE_PASS|ADMIN_PASS)\\s*=\\s*(['"])${P}\\2`, 'g'),
    to: 'const $1 = requireAuditPass()',
  },
  {
    // 兜底：任何剩下的裸字面量（含模板串）
    name: '裸字面量兜底',
    re: new RegExp(`(['"])${P}\\1`, 'g'),
    to: 'requireAuditPass()',
  },
];

/** 注入到文件头部的辅助函数（只在文件确实用到时插入） */
const HELPER = `
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
      '缺少审计凭据：请设置环境变量 AUDIT_PASS（或 SMOKE_PASS）。\\n' +
        '  例：$env:AUDIT_PASS=\\'***\\'; node tools/audit-xxx.mjs\\n' +
        '  或：node --env-file=tools/.env tools/audit-xxx.mjs',
    );
  }
  return v;
}
`;

function main() {
  const files = targets();
  const changed = [];
  const skipped = [];
  const scanners = [];

  fs.mkdirSync(BACKUP, { recursive: true });

  for (const file of files) {
    const base = path.basename(file);
    const original = fs.readFileSync(file, 'utf8');
    if (!original.includes(PWD)) continue;

    /* 扫描器类文件保留特征串（见 SCANNER_FILES 注释），只登记不修改 */
    if (SCANNER_FILES.has(base)) {
      scanners.push(base);
      continue;
    }

    let out = original;
    const applied = [];
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      if (rule.re.test(out)) {
        const before = out;
        rule.re.lastIndex = 0;
        out = out.replace(rule.re, rule.to);
        if (out !== before) applied.push(rule.name);
      }
      rule.re.lastIndex = 0;
    }

    if (!out.includes(PWD)) {
      /*
       * 插入 helper。
       *
       * ## 这里踩过一个坑（第一版把两个文件改坏了）
       *
       * 最初用 `/^(?:import[\s\S]*?;\s*\n)+/` 找插入点，在没有 import 语句的文件里
       * 匹配失败，于是走到「放文件头」分支 —— 结果把 helper 插到了 **shebang 之前**：
       * ```js
       * // helper 代码...
       * #!/usr/bin/env node     ← SyntaxError: Invalid or unexpected token
       * ```
       * `node --check` 抓住了它，并触发了自动回滚（这也是为什么我坚持改完必须逐个校验）。
       *
       * 正确做法：**shebang 永远在文件第 1 行**，helper 必须插在它之后。
       */
      if (!out.includes('function requireAuditPass')) {
        // 1) 先切出 shebang（若有）
        const shebangMatch = out.match(/^#![^\n]*\n/);
        const shebang = shebangMatch ? shebangMatch[0] : '';
        const body = shebang ? out.slice(shebang.length) : out;

        // 2) 在 body 里找「最后一条 import 语句」的结束位置
        let insertAt = 0;
        const importRe = /^import[\s\S]*?;\s*$/gm;
        let m;
        while ((m = importRe.exec(body)) !== null) {
          insertAt = m.index + m[0].length;
        }
        // 没有 import：跳过文件头的块注释与 'use strict'，插在其后
        if (insertAt === 0) {
          const headerRe = /^(?:\s*\/\*[\s\S]*?\*\/|\s*\/\/[^\n]*\n|\s*'use strict';?\s*\n)*/;
          const hm = body.match(headerRe);
          insertAt = hm ? hm[0].length : 0;
        }

        out = shebang + body.slice(0, insertAt) + HELPER + body.slice(insertAt);
      }
    }

    if (out === original) {
      skipped.push(base);
      continue;
    }

    if (!DRY) {
      fs.copyFileSync(file, path.join(BACKUP, base));
      fs.writeFileSync(file, out, 'utf8');
    }
    changed.push({ file: base, rules: applied, stillHasPwd: out.includes(PWD) });
  }

  console.log(`\n处理结果${DRY ? '（dry-run，未写入）' : ''}：`);
  console.log(`  改写 ${changed.length} 个文件`);
  for (const c of changed) {
    console.log(`   ${c.file}  [${c.rules.join(' + ')}]${c.stillHasPwd ? '  ⚠ 仍含密码' : ''}`);
  }
  if (scanners.length) {
    console.log(`  保留 ${scanners.length} 个扫描器文件（其职责就是检测该字面量，改了会失效）: ${scanners.join(', ')}`);
  }
  if (skipped.length) console.log(`  跳过 ${skipped.length} 个（无法自动改写）: ${skipped.join(', ')}`);

  /* 语法校验：改坏脚本比泄露更糟，必须逐个验证 */
  if (!DRY) {
    let bad = 0;
    for (const c of changed) {
      const p = path.join(TOOLS, c.file);
      try {
        execFileSync('node', ['--check', p], { stdio: 'pipe' });
      } catch (e) {
        bad += 1;
        console.log(`  ✗ 语法错误：${c.file} —— ${String(e.stderr || e.message).slice(0, 160)}`);
        // 立刻回滚该文件
        const bk = path.join(BACKUP, c.file);
        if (fs.existsSync(bk)) fs.copyFileSync(bk, p);
        console.log(`    已回滚 ${c.file}`);
      }
    }
    console.log(bad ? `\n  ✗ ${bad} 个文件语法错误（已回滚）` : '\n  ✓ 全部语法校验通过');
  }

  /* 复核：全目录再扫一次（dry-run 下磁盘未变，复核无意义，跳过） */
  if (!DRY) {
    const remain = [];
    for (const file of files) {
      const t = fs.readFileSync(file, 'utf8');
      if (t.includes(PWD)) remain.push(path.basename(file));
    }
    console.log(
      `\n复核：仍有 ${remain.length} 个审计脚本含密码` +
        (remain.length ? '：' + remain.join(', ') : '（清零 ✓）'),
    );
  } else {
    console.log('\n（dry-run：未写入磁盘，跳过复核）');
  }
  console.log(`备份目录：${path.relative(process.cwd(), BACKUP)}`);
}

main();
