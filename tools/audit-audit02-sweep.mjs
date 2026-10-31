/**
 * A4 管理端审计 · AUDIT-02 同类问题全仓排查（只读静态分析）。
 *
 * AUDIT-02 的模式是：「zod parse 丢弃 vaultId → resolveScope 拿不到 → 静默降级 legacy」。
 * 只要还有别的路由也是「parse(schema) 后把结果传给 resolveScope，而 schema 没声明 vaultId」，
 * 就存在同一个绕过。
 *
 * 本脚本对所有把 body/query 交给 resolveScope 的调用点做交叉检查。
 *
 * 用法：node tools/audit-audit02-sweep.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const routesDir = path.join(repo, 'services', 'api', 'src', 'routes');
const libDir = path.join(repo, 'services', 'api', 'src', 'lib');

/** 收集目录下所有 .js 内容 */
function collect(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile() || !name.endsWith('.js')) continue;
    out.push({ file: full, rel: path.relative(repo, full).replace(/\\/g, '/'), src: fs.readFileSync(full, 'utf8') });
  }
  return out;
}

const files = [...collect(routesDir), ...collect(libDir)];

console.log('='.repeat(94));
console.log('1. 所有 resolveScope 调用点及其 vaultId 可得性');
console.log('='.repeat(94));

let issues = 0;
let checked = 0;

for (const f of files) {
  const lines = f.src.split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = /resolveScope\(\s*req\s*,\s*([^,)]+)/.exec(line);
    if (!m) return;
    checked += 1;
    const arg = m[1].trim();
    const lineNo = i + 1;

    // 查找该路由 handler 内使用的 schema：向上找最近的 parse(xxxSchema, req.body
    let schemaName = null;
    for (let j = i; j >= Math.max(0, i - 40); j -= 1) {
      const pm = /parse\(\s*(\w+Schema)\s*,\s*req\.body/.exec(lines[j]);
      if (pm) {
        schemaName = pm[1];
        break;
      }
    }

    let hasVaultId = null;
    let schemaLine = null;
    if (schemaName) {
      const sm = new RegExp(`const ${schemaName} = z\\.object\\(\\{([\\s\\S]*?)\\n\\}\\);`).exec(f.src);
      if (sm) {
        hasVaultId = /\bvaultId\b/.test(sm[1]);
        schemaLine = f.src.slice(0, sm.index).split(/\r?\n/).length;
      }
    }

    const passesBody = arg !== 'null';
    const verdict =
      !passesBody
        ? '传 null（body 不参与，只能靠 header/query，属正常设计）'
        : hasVaultId === null
          ? '未找到对应 schema（需人工看）'
          : hasVaultId
            ? 'schema 已声明 vaultId ✓'
            : '❌ schema 未声明 vaultId → body 里的 vaultId 被丢弃';

    const isIssue = passesBody && hasVaultId === false;
    if (isIssue) issues += 1;

    console.log(`\n  ${f.rel}:${lineNo}`);
    console.log(`    resolveScope(req, ${arg})`);
    console.log(`    schema=${schemaName ?? '(未匹配)'}${schemaLine ? ` @${f.rel}:${schemaLine}` : ''}`);
    console.log(`    → ${verdict}`);
  });
}

console.log('');
console.log('='.repeat(94));
console.log(`2. 汇总：共检查 ${checked} 个 resolveScope 调用点，发现 ${issues} 处同类缺陷`);
console.log('='.repeat(94));

// 反向检查：presignSchema 这类「schema 里没有 vaultId 但 body 被用于作用域」的
console.log('');
console.log('3. 附带检查：storage.js 所有含 vaultId 的 schema 定义');
console.log('='.repeat(94));
const storage = files.find((f) => f.rel.endsWith('routes/storage.js'));
if (storage) {
  const schemaDefs = [...storage.src.matchAll(/const (\w+Schema) = z\.object\(\{([\s\S]*?)\n\}\);/g)];
  for (const s of schemaDefs) {
    const name = s[1];
    const body = s[2];
    const hasField = /\bvaultId\b/.test(body);
    const lineNo = storage.src.slice(0, s.index).split(/\r?\n/).length;
    console.log(`  ${name.padEnd(26)} @:${String(lineNo).padStart(4)}  含 vaultId: ${hasField ? '是' : '否'}`);
  }
}

console.log('');
console.log('结论：');
if (issues > 0) {
  console.log(`  ❌ 存在 ${issues} 处「parse 后丢 vaultId」缺陷，需按 AUDIT-02 同样方式修复。`);
} else {
  console.log('  ✅ 未发现其它同类调用点。');
}
console.log('  说明：传 null 的调用点（如 list/presign 的 GET 形态）本就只认 header/query，');
console.log('        不构成缺陷 —— 但**客户端若习惯用 body 传 vaultId，就会静默走 legacy**，这一点仍值得产品侧注意。');

process.exitCode = 0;
