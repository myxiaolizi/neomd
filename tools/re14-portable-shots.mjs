/**
 * 通过 CDP 抓取 1.4.0 绿色版的关键界面截图（设置页 / 主题页签）。
 *
 * 用法：node tools/re14-portable-shots.mjs <CDP 端口>
 *
 * 说明：这里用 DOM 事件触发 `Ctrl+,` 打开设置页，再点「主题」页签，
 * 用来目视确认需求14（主色调归位）、需求15（无正文工具栏）、需求16（底部保存栏）。
 */
import fs from 'node:fs';

const PORT = process.argv[2] || '9416';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalIn(ws, expression) {
  const id = Math.floor(Math.random() * 1e6);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('evaluate 超时')), 25000);
    const onMsg = (ev) => {
      try {
        const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
        if (m.id === id) {
          clearTimeout(timer);
          ws.removeEventListener('message', onMsg);
          if (m.result?.exceptionDetails) {
            reject(new Error(String(m.result.exceptionDetails.text || 'page error')));
          } else {
            resolve(m.result?.result?.value);
          }
        }
      } catch {
        /* 忽略 */
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}

async function shot(ws, file) {
  const id = Math.floor(Math.random() * 1e6);
  const data = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('screenshot 超时')), 25000);
    const onMsg = (ev) => {
      try {
        const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
        if (m.id === id && m.result?.data) {
          clearTimeout(timer);
          ws.removeEventListener('message', onMsg);
          resolve(m.result.data);
        }
      } catch {
        /* 忽略 */
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png' } }));
  });
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`  已保存：${file}`);
}

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  if (!target) throw new Error('未找到页面目标');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  // 打开设置页
  await evalIn(
    ws,
    `(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 2600));
      return document.querySelectorAll('.settings__nav-item').length;
    })()`,
  );
  await sleep(800);
  await shot(ws, 'docs/shots-140/re14-portable-settings-general.png');

  // 切到主题页签
  await evalIn(
    ws,
    `(async () => {
      const items = Array.from(document.querySelectorAll('.settings__nav-item'));
      const t = items.find(e => (e.textContent || '').trim() === '主题');
      if (t) t.click();
      await new Promise(r => setTimeout(r, 1400));
      return {
        swatches: document.querySelectorAll('[data-testid="accent-swatches"] button').length,
        cards: document.querySelectorAll('[data-testid="theme-cards"] > *').length,
        editorbars: document.querySelectorAll('.editorbar').length,
        saveBar: Boolean(document.querySelector('[data-testid="settings-save-bar"]'))
      };
    })()`,
  );
  await sleep(600);
  await shot(ws, 'docs/shots-140/re14-portable-settings-theme.png');

  ws.close();
  console.log('截图完成');
}

main().catch((e) => {
  console.error('截图失败：', e.message);
  process.exit(1);
});
