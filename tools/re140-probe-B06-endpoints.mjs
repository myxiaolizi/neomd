/**
 * B06 差异定位：**作者侧** `PUT /api/plugins/:pluginId` 与 **后台侧**
 * `PUT /api/admin/plugins/:id` 的代码校验是否一致。
 *
 * ## 为什么要查这个
 *
 * QA 门禁 B06 报「非法 codeJs 也返回 200」，而 T2 组自测报「7/7 全过」。
 * 我用 `PUT /api/admin/plugins/:id` 直接测过，确认会 400。两边结论相反的
 * 唯一可能：**测的不是同一个端点**。
 *
 * 需求2 的原文是「**后台的插件市场增加编辑功能**，除了下架还可以插件进行修改和调整」，
 * 归属显然是后台端点。但如果作者侧端点在管理员身上也可用、且**没有校验**，
 * 那就是一个真实的安全缺口（管理员/作者都能写入非法代码 → 客户端执行时炸）。
 *
 * 本脚本对同一款插件分别打两个端点，输出对照结论，并**把两次写入都还原**。
 */
const API = process.env.RE14_API || 'http://127.0.0.1:3200';
const USER = process.env.SMOKE_USER || 'admin';
const PASS = process.env.SMOKE_PASS || '6655';

const BAD = 'export default { id: "x", setup( {';

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

  const l = await fetch(`${API}/api/admin/plugins?page=1&pageSize=5`, { headers: auth });
  const lj2 = await l.json();
  const target = (lj2?.data?.items ?? [])[0];
  if (!target) {
    console.error('没有可测插件');
    process.exit(2);
  }
  console.log(`目标插件：id=${target.id} pluginId=${target.pluginId} name=${target.name}`);

  const orig = await fetch(`${API}/api/admin/plugins/${target.id}`, { headers: auth });
  const oj = await orig.json();
  const originalCode = (oj?.data?.plugin ?? oj?.data)?.codeJs ?? '';
  const originalDesc = (oj?.data?.plugin ?? oj?.data)?.description ?? '';

  const probe = async (label, url) => {
    const r = await fetch(url, { method: 'PUT', headers: auth, body: JSON.stringify({ codeJs: BAD }) });
    const body = await r.text();
    const rejected = r.status >= 400 && r.status < 500;
    console.log(
      `  ${rejected ? '\u2713' : '\u2717'} ${label.padEnd(34)} status=${r.status}  ${body.slice(0, 110).replace(/\s+/g, ' ')}`,
    );
    return rejected;
  };

  const adminRejected = await probe('后台侧 PUT /api/admin/plugins/:id', `${API}/api/admin/plugins/${target.id}`);
  const authorRejected = await probe('作者侧 PUT /api/plugins/:pluginId', `${API}/api/plugins/${encodeURIComponent(target.pluginId)}`);

  // 还原（两个端点都写回合法内容）
  const restore = { codeJs: originalCode || 'export default { id: "x", name: "x", setup() {} };', description: originalDesc, name: target.name };
  const r1 = await fetch(`${API}/api/admin/plugins/${target.id}`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify(restore),
  });
  const r2 = await fetch(`${API}/api/plugins/${encodeURIComponent(target.pluginId)}`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify(restore),
  });
  console.log(`还原：admin=${r1.status} author=${r2.status}`);

  console.log('');
  console.log(`结论：后台侧校验=${adminRejected ? '有' : '无'}；作者侧校验=${authorRejected ? '有' : '无'}`);
  if (adminRejected && !authorRejected) {
    console.log('→ 两端口径不一致：**作者侧是安全缺口**，应复用同一校验器（这是真实缺陷，需修）。');
    process.exit(1);
  }
  if (adminRejected && authorRejected) {
    console.log('→ 两端都有校验，B06 失败属断言打错端点，非产品缺陷。');
    process.exit(0);
  }
  console.log('→ 后台侧也无校验，属真实缺陷。');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
