/**
 * 审计侦察：摸清工作台/首页/右栏的真实 DOM 结构，供场景脚本使用稳定选择器。
 * 这不是交付物，是写场景脚本前的必要勘察（只读，不改任何东西）。
 *
 * 用法：node tools/audit-侦察.mjs
 */
import {
  API,
  BASE,
  LAUNCH_ARGS,
  auditShot,
  fmt,
  httpJson,
  loadChromium,
  login,
  newSession,
  openWorkbench,
  sleep,
  state,
} from './audit-场景-common.mjs';

const chromium = await loadChromium();
await login();
console.log(`登录成功，user=${state.user?.username ?? '?'}`);

/* ---------------------- 1. 访客视角：首页 / 守卫 ---------------------- */
{
  const { browser, page } = await newSession(chromium, { settingsMode: 'fake' });
  try {
    // 未登录：清掉注入的 token
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      localStorage.removeItem('neomd.access');
      localStorage.removeItem('neomd.refresh');
    });
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    console.log('\n===== 首页（未登录） =====');
    console.log('url =', page.url());
    const home = await page.evaluate(() => {
      const txt = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
      const h1 = document.querySelector('h1')?.textContent?.trim() ?? '';
      const h2s = Array.from(document.querySelectorAll('h2, h3')).slice(0, 8).map((e) => e.textContent?.trim());
      const ctas = Array.from(document.querySelectorAll('button, a'))
        .map((e) => ({
          t: (e.textContent || '').trim().slice(0, 24),
          href: e.getAttribute('href') || '',
          cls: (typeof e.className === 'string' ? e.className : '').slice(0, 40),
        }))
        .filter((x) => x.t && x.t.length > 1)
        .slice(0, 20);
      return { h1, h2s, ctas, first1200: txt.slice(0, 1200), len: txt.length };
    });
    console.log('h1 =', JSON.stringify(home.h1));
    console.log('h2/h3 =', JSON.stringify(home.h2s));
    console.log('文案长度 =', home.len);
    console.log('首屏文案 =', JSON.stringify(home.first1200.slice(0, 600)));
    console.log('CTA =', JSON.stringify(home.ctas, null, 1));
    await auditShot(page, 'recon-01-home-guest');

    // 未登录访问 /app
    await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    console.log('\n===== /app（未登录守卫） =====');
    console.log('url =', page.url());
    const guard = await page.evaluate(() => ({
      hasShell: Boolean(document.querySelector('.shell__main')),
      hasLoginForm: Boolean(document.querySelector('input[type="password"]')),
      text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    }));
    console.log('守卫结果 =', JSON.stringify(guard, null, 1));
    await auditShot(page, 'recon-02-app-guard');

    // 登录页 / 注册入口
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    console.log('\n===== 登录页 =====');
    const loginPage = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input')).map((e) => ({
        type: e.getAttribute('type') || 'text',
        ph: e.getAttribute('placeholder') || '',
        aria: e.getAttribute('aria-label') || '',
      }));
      const btns = Array.from(document.querySelectorAll('button, a')).map((e) => ({
        t: (e.textContent || '').trim().slice(0, 30),
        href: e.getAttribute('href') || '',
      }));
      return { inputs, btns: btns.filter((b) => b.t).slice(0, 15) };
    });
    console.log('输入框 =', JSON.stringify(loginPage.inputs));
    console.log('按钮/链接 =', JSON.stringify(loginPage.btns));
    await auditShot(page, 'recon-03-login');
  } finally {
    await browser.close();
  }
}

/* ---------------------- 2. 工作台结构 ---------------------- */
{
  const { browser, page } = await newSession(chromium, { settingsMode: 'fake' });
  try {
    await openWorkbench(page);
    await page.waitForTimeout(2000);
    console.log('\n===== 工作台 DOM =====');
    const shell = await page.evaluate(() => {
      const q = (sel) => Array.from(document.querySelectorAll(sel));
      const info = (el) => ({
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
        title: (el.getAttribute('title') || '').slice(0, 40),
        text: (el.textContent || '').trim().slice(0, 24),
      });
      return {
        tabs: q('.tab').map(info),
        ribbonBtns: q('.ribbon__btn').map(info),
        editorbarGroups: q('.editorbar__group').map((e) => (e.className || '').slice(0, 60)),
        viewswitch: q('.viewswitch__btn').map(info),
        tbtns: q('.editorbar .tbtn').map((e) => e.getAttribute('title') || e.getAttribute('aria-label') || '').slice(0, 40),
        rightSections: q('.rightstack .rightsec, .rightsec').map((e) => (e.className || '').slice(0, 70)),
        rightTabs: q('.rightpanel button, .rightbar button').map(info).slice(0, 20),
        leftPanel: q('.leftpanel, .shell__left').map((e) => (e.className || '').slice(0, 60)),
        statusbar: q('.statusbar, .shell__status').map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)),
        proseMirror: q('.ProseMirror').length,
        cmContent: q('.cm-content').length,
      };
    });
    console.log(JSON.stringify(shell, null, 1).slice(0, 4000));
    await auditShot(page, 'recon-04-workbench');

    // 右栏开关在哪
    const rightToggles = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, [role="button"]'))
        .map((e) => ({
          title: (e.getAttribute('title') || '').slice(0, 44),
          aria: (e.getAttribute('aria-label') || '').slice(0, 44),
          text: (e.textContent || '').trim().slice(0, 20),
          cls: (typeof e.className === 'string' ? e.className : '').slice(0, 46),
        }))
        .filter((x) => /AI|大纲|反链|反向|标签|历史|统计|日历|右|面板/.test(x.title + x.aria + x.text))
        .slice(0, 30),
    );
    console.log('\n右栏相关按钮 =', JSON.stringify(rightToggles, null, 1));

    // 选区/光标可用性（写作场景需要）
    const editable = await page.evaluate(() => {
      const pm = document.querySelector('.ProseMirror');
      return {
        exists: Boolean(pm),
        editable: pm ? pm.getAttribute('contenteditable') : null,
        text: pm ? (pm.textContent || '').slice(0, 100) : null,
      };
    });
    console.log('\n编辑器可编辑性 =', JSON.stringify(editable));
  } finally {
    await browser.close();
  }
}

/* ---------------------- 3. 功能区 / 菜单项全量 ---------------------- */
{
  const { browser, page } = await newSession(chromium, { settingsMode: 'fake' });
  try {
    await openWorkbench(page);
    await page.waitForTimeout(1500);
    console.log('\n===== 功能区 / 可点击入口全量 =====');
    const all = await page.evaluate(() => {
      const out = [];
      const push = (kind, el) => {
        const r = el.getBoundingClientRect();
        out.push({
          kind,
          title: (el.getAttribute('title') || '').slice(0, 50),
          aria: (el.getAttribute('aria-label') || '').slice(0, 50),
          text: (el.textContent || '').trim().slice(0, 22),
          cls: (typeof el.className === 'string' ? el.className : '').slice(0, 50),
          visible: r.width > 0 && r.height > 0,
        });
      };
      for (const el of document.querySelectorAll('.ribbon__btn')) push('ribbon', el);
      for (const el of document.querySelectorAll('.editorbar .tbtn')) push('editorbar-tbtn', el);
      for (const el of document.querySelectorAll('.tabbar button, .tab')) push('tabbar', el);
      for (const el of document.querySelectorAll('.statusbar button, .shell__status button')) push('statusbar', el);
      return out;
    });
    console.log(`可点击入口 ${all.length} 个`);
    for (const a of all) {
      console.log(`  [${a.kind}] ${a.visible ? 'V' : 'H'} ${(a.title || a.aria || a.text || a.cls).slice(0, 60)}`);
    }
  } finally {
    await browser.close();
  }
}

console.log('\n侦察完成。');
