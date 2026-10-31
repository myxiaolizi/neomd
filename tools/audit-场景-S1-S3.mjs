/**
 * 审计场景 S1-S3：访客 / 新用户路径
 * =============================================================================
 * S1 首次访问首页 → 能否在 5 秒内理解产品做什么
 * S2 注册流程（若开放）→ 登录 → 首次进入工作台的引导
 * S3 未登录访问 /app 的守卫行为
 *
 * ## 为什么 S3 必须用「全新 context」且**不注入 token**
 *
 * 门禁 common.mjs 的 `newSession()` 用 `ctx.addInitScript()` 注入登录态，
 * 而 addInitScript **在每次导航时都会重新执行**。所以「注入 token → 手动
 * removeItem → 重新 goto」这种测法根本测不出守卫：导航一发生 token 又回来了。
 * （我第一次侦察就踩了这个坑，看起来像「未登录能进工作台」，实际是假阳性。）
 *
 * 这里用 `chromium.launch()` + `newContext()` 且**完全不注入**任何 localStorage，
 * 才是真正的访客。
 *
 * 用法：node tools/audit-场景-S1-S3.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  API,
  BASE,
  LAUNCH_ARGS,
  ROOT,
  auditShot,
  beginScenario,
  fmt,
  httpJson,
  loadChromium,
  login,
  scenarioSummary,
  sleep,
  state,
  timed,
  waitUntil,
  writeScenarioJson,
} from './audit-场景-common.mjs';

const chromium = await loadChromium();

/* ============================ S1 首页价值传达 ============================ */
{
  const browser = await chromium.launch({ args: LAUNCH_ARGS });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e.message).slice(0, 200)));

  const s = beginScenario('S1', '首次访问首页的认知效率', '陌生访客能否在 5 秒内理解「这是什么、能干什么、我该点哪里」');
  try {
    const { ms } = await timed(async () => {
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(1500);
    });

    const home = await page.evaluate(() => {
      const visText = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
      const h1 = document.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      // 首屏（视口内）可见的文案：判断「5 秒能读到什么」的关键
      const inViewport = [];
      for (const el of document.querySelectorAll('h1, h2, h3, p, .nm-btn, button, a')) {
        const r = el.getBoundingClientRect();
        if (r.top >= 0 && r.top < window.innerHeight && r.height > 0 && r.width > 0) {
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (t.length > 1 && t.length < 120) inViewport.push(t);
        }
      }
      return {
        h1,
        title: document.title,
        totalTextLen: visText.length,
        inViewport: [...new Set(inViewport)].slice(0, 24),
        hasPrimaryCta: Boolean(document.querySelector('.nm-btn--primary')),
        bodyBg: getComputedStyle(document.body).backgroundColor,
      };
    });

    s.step(
      '打开首页并等网络空闲',
      'HTTP 200，DOM 渲染完成（h1 存在）',
      `h1=${JSON.stringify(home.h1)}，首屏可见文本 ${home.inViewport.length} 段`,
      Boolean(home.h1),
    );
    s.step(
      '首屏（1440×900 视口内）是否同时出现「价值主张 + 主 CTA」',
      '至少 1 条价值描述 + 1 个主按钮',
      `首屏文本：${fmt(home.inViewport.slice(0, 8))}；hasPrimaryCta=${home.hasPrimaryCta}`,
      home.hasPrimaryCta && home.inViewport.length >= 3,
    );

    // 价值传达的客观判据：h1 里应能看出产品类别
    const h1HasCategory = /Markdown|笔记|知识|文档|写作/.test(home.h1);
    s.step(
      'h1 是否直接说明产品类别（而非只有品牌名/口号）',
      'h1 含 Markdown / 笔记 / 知识 等类别词',
      `h1=${JSON.stringify(home.h1)}`,
      h1HasCategory,
    );

    s.step(
      '页面加载耗时',
      '< 5000ms（「5 秒内理解」的前提）',
      `${ms}ms`,
      ms < 5000,
      ms >= 5000 ? `首屏超过 5s，访客可能已离开` : '',
    );

    // 主 CTA 是否可点（未登录时应该能进登录/工作台）
    const cta = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.nm-btn--primary'));
      const b = btns[0];
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { text: (b.textContent || '').trim(), visible: r.width > 0 && r.height > 0, disabled: Boolean(b.disabled) };
    });
    s.step('主 CTA 可见且未禁用', 'visible=true, disabled=false', fmt(cta), Boolean(cta?.visible && !cta?.disabled));

    const brokenImgs = await page.evaluate(() =>
      Array.from(document.images)
        .filter((i) => i.complete && i.naturalWidth === 0)
        .map((i) => i.currentSrc || i.src)
        .slice(0, 8),
    );
    s.step('首屏图片无 404/破图', '破损图片数 = 0', `破损 ${brokenImgs.length} 张 ${fmt(brokenImgs)}`, brokenImgs.length === 0);
    s.step('无 JS 运行时错误', '0 条 pageerror', `${jsErrors.length} 条 ${fmt(jsErrors.slice(0, 3))}`, jsErrors.length === 0);

    if (home.inViewport.length > 8) {
      s.observe(`首屏文本偏多（${home.inViewport.length} 段），信息密度高但可能冲淡价值主张`);
    }
    await auditShot(page, 'S1-home-first-view');
  } finally {
    await browser.close();
    s.end();
  }
}

/* ====================== S2 注册流程 / 登录后引导 ====================== */
{
  const browser = await chromium.launch({ args: LAUNCH_ARGS });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  const s = beginScenario('S2', '注册 → 登录 → 首次进入工作台的引导', '新用户能否顺利完成注册并知道下一步做什么');
  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);

    const loginPage = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input')).map((e) => ({
        type: e.getAttribute('type') || 'text',
        ph: e.getAttribute('placeholder') || '',
      }));
      const links = Array.from(document.querySelectorAll('button, a')).map((e) => (e.textContent || '').trim());
      return { inputs, hasRegister: links.some((t) => /注册/.test(t)) };
    });
    s.step('登录页存在注册入口', '页面上有「立即注册」', `hasRegister=${loginPage.hasRegister}`, loginPage.hasRegister);

    // 点注册，看是否开放
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button, a')).find((e) => /立即注册|注册/.test((e.textContent || '').trim()));
      el?.click();
    });
    await page.waitForTimeout(2200);
    const regState = await page.evaluate(() => {
      const txt = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
      const inputs = Array.from(document.querySelectorAll('input')).map((e) => ({
        type: e.getAttribute('type') || 'text',
        ph: e.getAttribute('placeholder') || '',
      }));
      const disabled = Array.from(document.querySelectorAll('button')).filter((b) => b.disabled).map((b) => (b.textContent || '').trim());
      return {
        url: location.pathname,
        text: txt.slice(0, 500),
        inputs,
        disabledBtns: disabled.slice(0, 5),
        closedHint: /未开放|暂未开放|关闭注册|邀请/.test(txt),
      };
    });
    const regOpen = regState.inputs.length >= 2 && !regState.closedHint;
    if (regOpen) {
      s.step('注册表单可用（字段齐全）', '≥2 个输入框（账号/密码）', fmt(regState.inputs), true);
      s.observe(`注册页填写字段：${fmt(regState.inputs.map((i) => i.ph || i.type))}（未实际注册，避免在生产库造用户）`);
    } else {
      s.skip(`注册未开放或需邀请（提示：${regState.closedHint ? '命中未开放文案' : '字段不足'}；文本前 120 字：${regState.text.slice(0, 120)}）`);
    }

    // 登录（用真实 admin，验证登录后是否直达工作台）
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    const d = await login();
    await page.evaluate(
      ([a, r, u]) => {
        localStorage.setItem('neomd.access', a);
        localStorage.setItem('neomd.refresh', r);
        localStorage.setItem('neomd.user.cache', u);
      },
      [state.token, state.refresh, JSON.stringify(state.user)],
    );
    const { ms: loginMs } = await timed(async () => {
      await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.shell__main', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2000);
    });
    const after = await page.evaluate(() => ({
      hasShell: Boolean(document.querySelector('.shell__main')),
      hasEditor: Boolean(document.querySelector('.ProseMirror, .cm-content')),
      hasWelcome: /欢迎|开始|引导|新建|创建/.test((document.body.innerText || '').slice(0, 3000)),
      tabCount: document.querySelectorAll('.tab').length,
      emptyHint: (document.querySelector('.empty, .emptyhint, .shell__empty')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    }));
    s.step('登录后能进入工作台', '.shell__main 存在', `hasShell=${after.hasShell}`, after.hasShell);
    s.step('进入工作台耗时', '< 8000ms', `${loginMs}ms`, loginMs < 8000);
    s.step(
      '首次进入是否有引导或明确的下一步入口',
      '存在欢迎/引导文案，或已自动打开可编辑文档',
      `hasEditor=${after.hasEditor}, 有引导词=${after.hasWelcome}, 空状态文案=${JSON.stringify(after.emptyHint)}`,
      after.hasEditor || after.hasWelcome,
      after.hasEditor ? '已自动打开文档（等效于明确的下一步）' : '',
    );
    await auditShot(page, 'S2-after-login');
  } catch (e) {
    s.fail(String(e?.message ?? e));
  } finally {
    await browser.close();
    s.end();
  }
}

/* ====================== S3 未登录访问 /app 的守卫 ====================== */
{
  const browser = await chromium.launch({ args: LAUNCH_ARGS });
  const s = beginScenario('S3', '未登录直接访问 /app 的守卫', '未登录访问工作台应被拦到登录页，且不泄露他人数据');
  try {
    // 全新 context，**不注入任何 token**（见文件头注释：addInitScript 会在每次导航重放）
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
    const page = await ctx.newPage();
    const guard1 = await (async () => {
      await page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(3500);
      return page.evaluate(() => ({
        path: location.pathname,
        hasShell: Boolean(document.querySelector('.shell__main')),
        hasEditor: Boolean(document.querySelector('.ProseMirror, .cm-content')),
        hasPasswordInput: Boolean(document.querySelector('input[type="password"]')),
        // 是否渲染了真实文档名（数据泄露判据）
        text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400),
        tabCount: document.querySelectorAll('.tab').length,
      }));
    })();

    s.step(
      '未登录访问 /app 是否被拦到登录页',
      'path=/login 且无 .shell__main',
      `path=${guard1.path}, hasShell=${guard1.hasShell}, hasEditor=${guard1.hasEditor}, hasPasswordInput=${guard1.hasPasswordInput}`,
      guard1.path === '/login' || (guard1.hasPasswordInput && !guard1.hasEditor),
      `页面文本前 200 字：${guard1.text.slice(0, 200)}`,
    );
    s.step(
      '未登录时是否泄露文档列表/正文（不渲染工作台内容）',
      '无 .tab、无编辑器、文本不含真实文档名',
      `tabCount=${guard1.tabCount}, 文本：${JSON.stringify(guard1.text.slice(0, 160))}`,
      guard1.tabCount === 0 && !guard1.hasEditor,
    );

    // 直接命中受保护 API：未带 token 应 401
    const apiProbe = await httpJson(`${API}/api/settings?platform=web`);
    s.step(
      '未带 token 访问受保护 API /api/settings',
      'HTTP 401（拒绝）',
      `HTTP ${apiProbe.status}：${fmt(apiProbe.body).slice(0, 160)}`,
      apiProbe.status === 401 || apiProbe.status === 403,
    );
    const vaultProbe = await httpJson(`${API}/api/vaults`);
    s.step(
      '未带 token 访问 /api/vaults（仓库列表）',
      'HTTP 401/403',
      `HTTP ${vaultProbe.status}：${fmt(vaultProbe.body).slice(0, 160)}`,
      vaultProbe.status === 401 || vaultProbe.status === 403,
    );

    await auditShot(page, 'S3-app-guard-guest');

    // 顺带验证「进入本机编辑器」这类免登录入口是否真的可用（登录页上的按钮）
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    const localBtn = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button, a')).find((e) => /本机编辑器|本地/.test((e.textContent || '').trim()));
      if (!el) return { found: false };
      el.click();
      return { found: true, text: (el.textContent || '').trim() };
    });
    await page.waitForTimeout(3000);
    const localState = await page.evaluate(() => ({
      path: location.pathname,
      hasShell: Boolean(document.querySelector('.shell__main')),
      hasEditor: Boolean(document.querySelector('.ProseMirror, .cm-content')),
      text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    }));
    if (localBtn.found) {
      s.step(
        '「进入本机编辑器」免登录入口是否可用',
        '跳转后能进入可编辑界面',
        `path=${localState.path}, hasEditor=${localState.hasEditor}, 文本=${JSON.stringify(localState.text.slice(0, 120))}`,
        localState.hasEditor,
      );
      await auditShot(page, 'S3-local-editor');
    } else {
      s.observe('登录页未找到「进入本机编辑器」入口');
    }
    await ctx.close();
  } catch (e) {
    s.fail(String(e?.message ?? e));
  } finally {
    await browser.close();
    s.end();
  }
}

writeScenarioJson('scenarios-S1-S3.json');
scenarioSummary();
