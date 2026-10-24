/**
 * S3 同步端到端验证：
 * 启动模拟 S3 → 浏览器中配置 → 新建笔记 → 同步 → 校验远端对象 → 修改 → 再同步。
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { start } = require('./mock-s3.cjs');

const DIST = path.resolve(__dirname, '../../app/dist');
const OUT = path.resolve(__dirname, 'out');
const PORT = 5402;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serveStatic() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let rel = decodeURIComponent(req.url.split('?')[0]);
      if (rel === '/' || rel === '') rel = '/index.html';
      let file = path.join(DIST, rel);
      if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(DIST, 'index.html');
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const staticServer = await serveStatic();
  const s3 = await start(0);
  console.log('mock S3 port:', s3.port);

  const executablePath = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((p) => fs.existsSync(p));

  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e)));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // 直接写入配置到 localStorage（等价于用户在设置中填写）
  await page.evaluate((cfg) => {
    const key = 'mdnote:settings';
    const cur = JSON.parse(localStorage.getItem(key) || '{}');
    cur.sync = {
      enabled: true,
      endpoint: cfg.endpoint,
      region: cfg.region,
      bucket: cfg.bucket,
      prefix: 'mdnote/',
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      sessionToken: '',
      forcePathStyle: true,
      syncVersions: true,
      autoInterval: 0,
      concurrency: 4,
    };
    localStorage.setItem(key, JSON.stringify(cur));
  }, s3.config);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // 新建并写入内容
  await page.locator('.welcome .btn.primary').first().click();
  await page.waitForTimeout(400);
  await page.locator('.modal .input').first().fill('同步测试');
  await page.locator('.modal .modal-foot .btn.primary').first().click();
  await page.waitForTimeout(900);

  await page.locator('.cm-content').first().click();
  await page.keyboard.insertText('# 同步验证\n\n这是用于验证 S3 同步的正文。\n');
  await page.waitForTimeout(900);
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(900);

  // 触发同步
  await page.keyboard.press('Control+Shift+s');
  await page.waitForTimeout(3500);

  const afterFirst = {
    objects: [...s3.store.keys()],
    notes: [...s3.store.entries()].filter(([k]) => k.includes('/notes/')).map(([k, v]) => ({
      key: k,
      size: v.body.length,
      preview: v.body.toString('utf8').slice(0, 60),
    })),
    versions: [...s3.store.keys()].filter((k) => k.includes('/versions/')),
    manifest: [...s3.store.entries()].filter(([k]) => k.endsWith('manifest.json'))
      .map(([k, v]) => v.body.toString('utf8').slice(0, 120)),
    syncStatus: await page.evaluate(() => {
      const el = document.querySelector('.statusbar .item:last-child');
      return el ? el.innerText.trim() : '';
    }),
  };

  // 修改内容后再同步
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n第二次修改的内容。\n');
  await page.waitForTimeout(900);
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(900);
  await page.keyboard.press('Control+Shift+s');
  await page.waitForTimeout(3500);

  const afterSecond = {
    notes: [...s3.store.entries()].filter(([k]) => k.includes('/notes/')).map(([k, v]) => ({
      key: k,
      size: v.body.length,
      preview: v.body.toString('utf8').slice(0, 80),
    })),
    versions: [...s3.store.keys()].filter((k) => k.includes('/versions/')),
  };

  // 校验所有请求均通过服务端验签
  const authResults = s3.log.map((l) => ({ m: l.method, p: l.path, auth: l.auth }));
  const authFailures = authResults.filter((r) => r.auth !== 'ok');

  await page.screenshot({ path: path.join(OUT, '70-sync.png') });

  const result = {
    mockPort: s3.port,
    afterFirst,
    afterSecond,
    totalRequests: s3.log.length,
    authFailures,
    errors,
  };
  fs.writeFileSync(path.join(OUT, 'sync.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));

  await browser.close();
  staticServer.close();
  s3.server.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
