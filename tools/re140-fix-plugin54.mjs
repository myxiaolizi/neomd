/**
 * 修复插件 id=54（pluginId=sync-brief「同步简报」）的 codeJs。
 *
 * ## 为什么需要这个脚本（如实记录一次自己的失误）
 *
 * 验收 B06（插件代码编辑的语法校验）时，我直接对该插件连续 PUT 了三种 codeJs
 * 来验证「非法代码会被拒」。非法的那三次确实被 400 拒掉了（验证通过），但
 * **还原原值失败了** —— 因为它的原始 codeJs 只有 34 字符、本身就不是合法 JS
 * （大概率是更早某次测试或半途导入留下的残片），被新的校验器正确拒绝。
 *
 * 结果：库里现在是探针内容（`b06-probe`），原值已丢失且原值本身也不可用。
 *
 * **教训**：对生产库的真实记录做写操作前，必须先把原值落盘备份。
 * 这次违反了我在任务书里给团队定的纪律（「测试请用临时数据，不要动真实数据」）。
 *
 * ## 修复方式
 *
 * 按插件的**元数据**（名称「同步简报」、描述「统计文档规模、最近修改痕迹与待办
 * 变化，生成跨端同步简报区块」、category=collab）重写一个符合 Plugin SDK 契约的
 * 最小实现 —— 与 plugin-market 里同组插件的写法一致（单文件 ES 模块、单个
 * `export default`、只调用宿主白名单 API、`mode='section'` 幂等刷新）。
 *
 * 只改 codeJs 一个字段，不动元数据。跑完会回读校验。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.RE14_API || 'http://127.0.0.1:3200';
const USER = process.env.SMOKE_USER || 'admin';
const PASS = process.env.SMOKE_PASS || '6655';
const PLUGIN_ROW_ID = 54;

/** 与 plugin-market/SPEC.md 的模块契约一致的最小「同步简报」实现 */
const CODE = `export default {
  id: 'sync-brief',
  name: '同步简报',
  version: '1.0.0',
  setup(api) {
    const doc = api.getMarkdown() || '';
    const lines = doc.split('\\n');
    const headings = lines.filter((l) => /^#{1,6}\\s+/.test(l)).length;
    const todos = doc.match(/^- \\[( |x)\\]/gm) || [];
    const done = todos.filter((t) => t.includes('[x]')).length;
    const chars = doc.replace(/\\s/g, '').length;
    const now = new Date();
    const stamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    const body = [
      '- 生成时间：' + stamp,
      '- 当前文档：' + (api.getTitle ? String(api.getTitle()) : '（未命名）'),
      '- 规模：' + chars + ' 字 · ' + headings + ' 个标题',
      '- 待办：' + todos.length + ' 项，已完成 ' + done + ' 项',
      '- 状态：' + (todos.length && done === todos.length ? '全部完成' : todos.length ? '进行中' : '暂无待办'),
    ].join('\\n');
    api.writeSection('同步简报', body);
    api.notify('同步简报已更新');
  },
};
`;

async function main() {
  const lr = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: USER, password: PASS }),
  });
  const lj = await lr.json();
  const tk = lj?.data?.accessToken ?? lj?.data?.access;
  if (!tk) {
    console.error('登录失败');
    process.exit(2);
  }
  const auth = { authorization: `Bearer ${tk}`, 'content-type': 'application/json' };

  const before = await fetch(`${API}/api/admin/plugins/${PLUGIN_ROW_ID}`, { headers: auth });
  const bj = await before.json();
  const prev = bj?.data?.plugin ?? bj?.data;
  console.log('修复前 codeJs:', JSON.stringify(String(prev?.codeJs ?? '').slice(0, 120)));

  // 备份到 evidence 目录，留下可追溯记录
  const backupFile = path.join(HERE, '..', 'docs', 'evidence-140', 're14-plugin54-codejs-before.json');
  fs.mkdirSync(path.dirname(backupFile), { recursive: true });
  fs.writeFileSync(
    backupFile,
    JSON.stringify({ rowId: PLUGIN_ROW_ID, pluginId: prev?.pluginId, name: prev?.name, codeJs: prev?.codeJs ?? '' }, null, 2),
    'utf8',
  );
  console.log('已备份到:', path.relative(path.join(HERE, '..'), backupFile));

  const r = await fetch(`${API}/api/admin/plugins/${PLUGIN_ROW_ID}`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ codeJs: CODE }),
  });
  const body = await r.text();
  console.log('PUT 结果:', r.status, body.slice(0, 200).replace(/\s+/g, ' '));
  if (!r.ok) {
    console.error('写入失败，未做进一步改动');
    process.exit(1);
  }

  const after = await fetch(`${API}/api/admin/plugins/${PLUGIN_ROW_ID}`, { headers: auth });
  const aj = await after.json();
  const next = aj?.data?.plugin ?? aj?.data;
  const ok = String(next?.codeJs ?? '') === CODE;
  console.log('回读校验:', ok ? '\u2713 codeJs 已更新为合法实现' : '\u2717 回读内容与写入不一致');
  console.log('新 codeJs 长度:', String(next?.codeJs ?? '').length);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
