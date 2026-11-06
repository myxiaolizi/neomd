/**
 * 技术验证：模拟四个桌面壳的统一承载架构，确认可行性。
 *
 *   node tools/verify-shell-architecture.mjs
 *
 * 验证的三件事（这是四版共存的前提）：
 * 1. 本地起一个静态服务器承载 apps/web/dist；
 * 2. 在 index.html 里**注入 window.NeoMD**（env=desktop + bridge 桩），
 *    使 detectRuntime() 返回 desktop；
 * 3. 把 /api/* 反向代理到官方后端 https://md.zhengl.vip，
 *    这样页面是 http://127.0.0.1:<port>，isRemoteWeb() 为 true，
 *    resolveServerBase() 返回空串 → 走相对路径 → 打到本地服务器 → 被代理转发。
 *
 * 为什么不用 neomd:// 自定义协议：
 * Electron 版用的是自定义协议（origin 为 neomd://，CORS 已放行），
 * 但 WinUI3/Qt/Flutter 注册自定义 scheme 的成本和坑都远高于一个本地 http 端口，
 * 而「本地端口 + 同源代理」对四者完全一致，且天然规避 CORS 预检。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpsRequest } from 'node:https';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(root, 'apps', 'web', 'dist');
const UPSTREAM = 'https://md.zhengl.vip';
const PORT = Number(process.argv[2] || 4199);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.wasm': 'application/wasm'
};

/** 注入到页面最前面的宿主标记脚本（对应各壳的 init script） */
const INJECT = `<script>
(function () {
  var noop = function () { return Promise.reject(new Error('NOT_IMPLEMENTED')); };
  window.NeoMD = {
    env: 'desktop',
    version: '2.0.0-archprobe',
    bridge: {
      fs: {
        readText: noop, readBinary: noop, writeText: noop, writeBinary: noop,
        mkdirp: noop, remove: noop, rename: noop, list: noop, exists: noop, stat: noop
      },
      dialog: { pickDirectory: noop, pickFile: noop, saveFile: noop },
      paths: { documents: noop, userData: noop, vaultDefault: noop },
      shell: { openExternal: noop, showItemInFolder: noop },
      win: { isMaximized: noop, toggleMaximize: noop, minimize: noop, close: noop },
      app: { version: function () { return Promise.resolve('2.0.0-archprobe'); }, onOpenFile: function () {} }
    }
  };
})();
</script>`;

/** 把 /api/* 转发到官方后端，保持方法/头/体 */
function proxy(req, res, url) {
  const target = new URL(UPSTREAM + url);
  const headers = { ...req.headers, host: new URL(UPSTREAM).host };
  // 让后端看到真实来源，便于排查
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-neomd-shell'] = 'archprobe';

  const up = httpsRequest(
    { hostname: target.hostname, port: 443, path: target.pathname + target.search, method: req.method, headers },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    }
  );
  up.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'UPSTREAM_FAIL', message: e.message }));
  });
  req.pipe(up);
}

const server = createServer(async (req, res) => {
  const url = req.url || '/';

  if (url.startsWith('/api/')) return proxy(req, res, url);

  // 静态资源
  let pathname = decodeURIComponent(url.split('?')[0]);
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  let file = join(DIST, pathname);

  // 防目录穿越
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const st = await stat(file);
    if (st.isDirectory()) file = join(file, 'index.html');
    let body = await readFile(file);

    if (extname(file) === '.html') {
      // 注入宿主标记：模拟各壳 AddScriptToExecuteOnDocumentCreated
      const html = body.toString('utf8').replace('<head>', `<head>\n${INJECT}`);
      body = Buffer.from(html, 'utf8');
    }

    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': body.length
    });
    res.end(body);
  } catch {
    // SPA 兜底
    try {
      const html = await readFile(join(DIST, 'index.html'));
      const injected = html.toString('utf8').replace('<head>', `<head>\n${INJECT}`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(injected);
    } catch {
      res.writeHead(404).end('not found');
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[archprobe] 静态 + /api 代理已启动：http://127.0.0.1:${PORT}/`);
  console.log(`[archprobe] 静态根目录：${DIST}`);
  console.log(`[archprobe] /api/* → ${UPSTREAM}`);
  console.log('[archprobe] 按 Ctrl+C 停止');
});
