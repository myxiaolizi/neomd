// 端到端冒烟：登录 → 建分享 → 匿名读取 → 匿名评价 → 发布页 → 后台统计
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3210';

async function call(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, json, text };
}

function assert(cond, label) {
  if (!cond) throw new Error('断言失败: ' + label);
  console.log('  ✓ ' + label);
}

const main = async () => {
  console.log('健康检查');
  const health = await call('/api/health');
  assert(health.status === 200 && health.json.db === true, '数据库连通');

  console.log('登录');
  const login = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'tester01', password: 'Test#12345' }),
  });
  assert(login.status === 200 && login.json.ok, 'tester01 登录成功');
  const token = login.json.data.accessToken;
  const auth = { authorization: 'Bearer ' + token };

  console.log('分享闭环');
  const title = '中文标题·联调文档';
  const md = '# 中文标题\n\n这是 **加粗** 与 `code`，还有 [[内链]]。\n\n- 列表一\n- 列表二\n';
  const create = await call('/api/shares', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ docId: 'smoke-utf8-1', title, markdown: md, mode: 'comment', allowComment: true }),
  });
  assert(create.status === 200 || create.status === 201, '创建分享返回成功');
  const shareToken = create.json.data.token;
  assert(/^https:\/\/md\.zhengl\.vip\/s\//.test(create.json.data.url), '分享链接域名正确');

  const pub = await call('/api/public/shares/' + shareToken);
  assert(pub.status === 200, '匿名可读取分享');
  assert(pub.json.data.title === title, '中文标题完整往返: ' + pub.json.data.title);
  assert(pub.json.data.html.includes('<strong>加粗</strong>'), 'Markdown 渲染为 HTML');
  assert(pub.json.data.html.includes('<h1>中文标题</h1>'), '标题层级正确');

  const comment = await call('/api/public/shares/' + shareToken + '/comments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      authorName: '访客小明',
      body: '第二段表述可以更紧凑一些。',
      annotation: { quote: '这是加粗与 code', selector: { quote: '这是加粗与 code' } },
    }),
  });
  assert(comment.status === 200 || comment.status === 201, '匿名评价提交成功');

  const pub2 = await call('/api/public/shares/' + shareToken);
  assert(pub2.json.data.comments.length >= 1, '评价可被读回');
  const c = pub2.json.data.comments[0];
  assert(c.authorName === '访客小明', '昵称中文往返: ' + c.authorName);
  assert(Boolean(c.annotation && c.annotation.quote), '标注引用可读回');

  console.log('发布页');
  const pubDoc = await call('/api/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ docId: 'smoke-utf8-1', title, markdown: md }),
  });
  assert(pubDoc.status === 200 || pubDoc.status === 201, '发布成功');
  const slug = pubDoc.json.data.slug;
  const page = await call('/p/' + slug);
  assert(page.status === 200 && page.text.includes('neomd-export'), '发布页可访问且带导出样式');

  console.log('后台');
  const adminLogin = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: 'MaC2=KRV4J-KBK=b6X=J' }),
  });
  assert(adminLogin.status === 200, 'admin 登录成功');
  const adminAuth = { authorization: 'Bearer ' + adminLogin.json.data.accessToken };
  const stats = await call('/api/admin/stats', { headers: adminAuth });
  assert(stats.status === 200 && stats.json.ok, '后台统计可读');
  assert(stats.json.data.users.total >= 2, '用户数: ' + stats.json.data.users.total);
  assert(typeof stats.json.data.shares.total === 'number', '分享统计可读');
  assert(typeof stats.json.data.storage.bytes === 'number', '存储统计可读');
  const noAuth = await call('/api/admin/stats');
  assert(noAuth.status === 401, '未登录访问后台被拒绝');

  console.log('清理');
  const list = await call('/api/shares', { headers: auth });
  const shareItems = Array.isArray(list.json.data) ? list.json.data : (list.json.data?.items ?? []);
  for (const s of shareItems) {
    if (s.token === shareToken) await call('/api/shares/' + s.id, { method: 'DELETE', headers: auth });
  }
  const pubs = await call('/api/publish', { headers: auth });
  const pubItems = Array.isArray(pubs.json.data) ? pubs.json.data : (pubs.json.data?.items ?? []);
  for (const p of pubItems) {
    if (p.slug === slug) await call('/api/publish/' + p.id, { method: 'DELETE', headers: auth });
  }
  console.log('  ✓ 测试数据已清理');

  console.log('\n全部通过');
};

main().catch((e) => {
  console.error('冒烟失败:', e.message);
  process.exit(1);
});
