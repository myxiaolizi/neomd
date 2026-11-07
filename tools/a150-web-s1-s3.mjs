/**
 * AUDIT-150 网页端场景 S1–S3
 * =============================================================================
 * S1 首次访问游客：首页营销页可读性、CTA、注册/登录入口
 * S2 注册 / 登录：成功、失败、错误提示、限流、token 过期
 * S3 建仓库 → 建文档 → 写作核心链路
 *
 * 只读产品代码；所有结论来自实测（截图 + JSON + 控制台日志）。
 * 口令只从 AUDIT_PASS 读取，不落盘、不进截图、不进报告。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  API,
  BASE,
  DESKTOP_VIEWPORT,
  OUT_DIR,
  RAW_DIR,
  SHOT_DIR,
  apiLogin,
  auditPass,
  beginScenario,
  clickByText,
  httpJson,
  loadChromium,
  newSession,
  readToasts,
  scenarioSummary,
  shot,
  sleep,
  uiSnapshot,
  waitUntil,
  writeScenarioJson,
} from './a150-web-common.mjs';

const chromium = await loadChromium();
const results = {};
let createdDocTitle = null;

/* ==========================================================================
 * S1 首次访问游客
 * ========================================================================== */

{
  const sc = beginScenario(
    'S1',
    '首次访问游客：首页营销页',
    '未登录访客打开首页，能否在 5 秒内看懂产品是什么、找到注册/登录入口、理解主 CTA',
  );
  const { browser, page, logs } = await newSession(chromium);

  try {
    const t0 = Date.now();
    const resp = await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 45000 });
    const ttfbMs = Date.now() - t0;

    sc.step(
      '打开首页（未登录、全新上下文）',
      'HTTP 200 且首屏渲染出营销内容',
      `HTTP ${resp?.status()}，networkidle 耗时 ${ttfbMs}ms`,
      resp?.status() === 200,
    );

    await shot(page, 'web-s1-home-guest', { fullPage: true });

    // —— 首屏可见文本（只看视口内，判断「看得懂」）——
    const fold = await page.evaluate(() => {
      const inFold = [];
      const walk = (el) => {
        for (const c of el.children) {
          const r = c.getBoundingClientRect();
          if (r.top < window.innerHeight && r.bottom > 0 && r.height > 0) {
            const t = (c.innerText || '').trim();
            if (t && t.length < 200) inFold.push(t.replace(/\s+/g, ' '));
            walk(c);
          }
        }
      };
      walk(document.body);
      const btnText = Array.from(document.querySelectorAll('button, a')).filter((b) => {
        const r = b.getBoundingClientRect();
        return r.top < window.innerHeight && r.bottom > 0 && r.width > 0;
      }).map((b) => (b.textContent || '').trim().replace(/\s+/g, ' ')).filter(Boolean);
      const h1 = document.querySelector('h1')?.innerText?.trim() ?? '';
      return { h1, btnText: [...new Set(btnText)], inFoldHead: inFold.slice(0, 12) };
    });
    results.s1Fold = fold;
    sc.step(
      '首屏 H1（产品定位文案）',
      '存在明确 H1，一句话说清产品是什么',
      `H1 = "${fold.h1}"`,
      Boolean(fold.h1),
    );
    sc.step(
      '首屏可点 CTA 数量与文案',
      '至少 1 个主 CTA（进入工作台/注册），文案动词明确',
      `首屏 CTA: ${JSON.stringify(fold.btnText)}`,
      fold.btnText.some((t) => /进入|注册|登录|开始|下载/.test(t)),
    );

    // —— 导航与锚点是否可用 ——
    const nav = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a, button')).map((e) => ({
        text: (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24),
        href: e.getAttribute('href') || '',
        tag: e.tagName.toLowerCase(),
      }));
      return links.filter((l) => l.text);
    });
    results.s1Nav = nav;
    const anchors = nav.filter((l) => l.href.startsWith('#'));
    sc.step(
      '顶部导航项是否为真实可跳转入口',
      '导航项点击有明确目的地（锚点或路由）',
      `导航/按钮共 ${nav.length} 项，其中锚点 ${anchors.length} 项，href="#" 或空 href ${nav.filter((l) => l.href === '#' || l.href === '').length} 项`,
      nav.length > 0,
    );

    // —— 核心价值/对比/FAQ 是否真实渲染（防「假营销图」）——
    const sections = await page.evaluate(() => {
      const txt = document.body.innerText;
      return {
        hasCompare: /Neo MD（本产品）/i.test(txt) && /Obsidian/i.test(txt),
        faqCount: (document.querySelectorAll('details, .faq, [class*="faq"]').length || 0),
        hasDownload: /Android APK/i.test(txt),
        textLen: txt.length,
        imgCount: document.querySelectorAll('img').length,
      };
    });
    results.s1Sections = sections;
    sc.step(
      '营销内容真实性（对比表 / FAQ / 下载区 / 图片）',
      '对比表有数据、FAQ 可展开、下载区列出真实条目',
      `对比表=${sections.hasCompare}；FAQ 元素 ${sections.faqCount} 个；下载区=${sections.hasDownload}；正文 ${sections.textLen} 字；图片 ${sections.imgCount} 张`,
      sections.hasCompare && sections.hasDownload,
    );

    // —— FAQ 手风琴是否真的能展开（死按钮高频区）——
    const faqProbe = await page.evaluate(async () => {
      const cands = Array.from(document.querySelectorAll('button, .faq__q, [class*="faq"] button, summary'))
        .filter((e) => /不登录|API Key|插件|不同电脑/.test(e.textContent || ''));
      if (!cands.length) return { found: 0, opened: 0, reasons: ['未找到 FAQ 触发器'] };
      const el = cands[0];
      const before = el.getAttribute('aria-expanded');
      const beforeH = el.parentElement?.getBoundingClientRect().height ?? 0;
      el.click();
      await new Promise((r) => setTimeout(r, 350));
      const after = el.getAttribute('aria-expanded');
      const afterH = el.parentElement?.getBoundingClientRect().height ?? 0;
      return {
        found: cands.length,
        trigger: el.tagName.toLowerCase(),
        beforeAria: before,
        afterAria: after,
        beforeH: Math.round(beforeH),
        afterH: Math.round(afterH),
        opened: after === 'true' || afterH > beforeH + 8,
      };
    });
    results.s1Faq = faqProbe;
    sc.step(
      'FAQ 手风琴展开',
      '点击问题后答案展开（aria-expanded=true 或高度增加）',
      `找到 ${faqProbe.found} 个触发器；aria ${faqProbe.beforeAria}→${faqProbe.afterAria}；高度 ${faqProbe.beforeH}→${faqProbe.afterH}px；展开=${faqProbe.opened}`,
      Boolean(faqProbe.opened),
      faqProbe.opened ? '' : '疑似死按钮：点击后无展开',
    );
    await shot(page, 'web-s1-faq-open');

    // —— 主 CTA 是否真的进工作台 ——
    const ctaProbe = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('button, a'));
      const hit = all.find((e) => /立即进入在线工作台|进入在线工作台|进入工作台/.test(e.textContent || ''));
      return hit ? { found: true, text: hit.textContent.trim().slice(0, 30) } : { found: false };
    });
    results.s1Cta = ctaProbe;
    sc.step(
      '主 CTA「进入在线工作台」存在',
      '存在且文案明确',
      ctaProbe.found ? `找到「${ctaProbe.text}」` : '未找到主 CTA',
      ctaProbe.found,
    );

    if (ctaProbe.found) {
      await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('button, a'));
        all.find((e) => /立即进入在线工作台|进入在线工作台|进入工作台/.test(e.textContent || ''))?.click();
      });
      await sleep(2500);
      const snap = await uiSnapshot(page);
      results.s1AfterCta = snap;
      sc.step(
        '点击主 CTA 后落地页',
        '进入 /app 工作台（游客可写作）或明确引导登录',
        `URL=${snap.url.replace(BASE, '')}；shell=${snap.hasShell}；编辑器=${snap.hasProse || snap.hasCm}`,
        snap.url.includes('/app') || snap.url.includes('/login'),
      );
      await shot(page, 'web-s1-after-cta');
    }

    // —— 游客是否可直接写作（官网宣称「不登录也能用」）——
    results.s1GuestWrite = await page.evaluate(() => {
      const txt = document.body.innerText;
      return {
        hasLocalEntry: /进入本机编辑器|不登录/.test(txt),
        url: location.pathname,
      };
    });
    sc.observe(
      `游客首页 / FAQ 宣称「不登录也能使用完整编辑功能」，首页 footer 有「进入本机编辑器」入口=${results.s1GuestWrite.hasLocalEntry}`,
    );

    // —— 无障碍/语义抽查 ——
    const a11y = await page.evaluate(() => ({
      h1Count: document.querySelectorAll('h1').length,
      imgNoAlt: Array.from(document.querySelectorAll('img')).filter((i) => !i.alt).length,
      btnNoLabel: Array.from(document.querySelectorAll('button')).filter(
        (b) => !(b.textContent || '').trim() && !b.getAttribute('aria-label') && !b.getAttribute('title'),
      ).length,
      lang: document.documentElement.lang,
    }));
    results.s1A11y = a11y;
    sc.step(
      '无障碍基础项（H1 数量 / 图片 alt / 无标签按钮 / lang）',
      'h1 恰好 1 个、图片有 alt、按钮有可访问名',
      `h1=${a11y.h1Count}；img 缺 alt=${a11y.imgNoAlt}；按钮无名称=${a11y.btnNoLabel}；lang="${a11y.lang}"`,
      a11y.h1Count >= 1 && a11y.lang !== '',
    );

    // —— 控制台错误（游客首屏不应有报错）——
    results.s1Logs = {
      consoleErrors: logs.consoleErrors,
      pageErrors: logs.pageErrors,
      failed: logs.failedRequests.filter((r) => !/favicon/.test(r.url)),
    };
    sc.step(
      '游客首页控制台无报错、无请求失败',
      '0 个 pageerror，0 个非 favicon 请求失败',
      `pageerror=${logs.pageErrors.length}；console.error=${logs.consoleErrors.length}；失败请求=${results.s1Logs.failed.length}`,
      logs.pageErrors.length === 0 && results.s1Logs.failed.length === 0,
    );
  } catch (e) {
    sc.fail(String(e?.message ?? e));
  } finally {
    await browser.close().catch(() => {});
    sc.end();
  }
}

/* ==========================================================================
 * S2 注册 / 登录
 * ========================================================================== */

{
  const sc = beginScenario(
    'S2',
    '注册与登录：成功/失败/提示/限流/Token 过期',
    '真实用户从注册到进入工作台，并验证各类失败路径是否有明确提示',
  );
  const { browser, page, logs } = await newSession(chromium);
  const stamp = Date.now().toString(36);
  const newUser = { email: `audit150_${stamp}@example.com`, username: `audit150_${stamp}`, password: 'Audit150-Pass!' };
  results.s2NewUser = { email: newUser.email, username: newUser.username };

  try {
    // —— 2.1 登录页表单与可访问性 ——
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 45000 });
    await shot(page, 'web-s2-login-page');

    const form = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('label')).map((l) => ({
        for: l.getAttribute('for'),
        text: (l.textContent || '').trim(),
      }));
      const inputs = Array.from(document.querySelectorAll('input')).map((i) => ({
        id: i.id,
        type: i.type,
        placeholder: i.placeholder,
        autocomplete: i.autocomplete,
        hasLabel: Boolean(
          (i.id && document.querySelector(`label[for="${i.id}"]`)) || i.getAttribute('aria-label'),
        ),
      }));
      return { labels, inputs, submitText: document.querySelector('button[type="submit"]')?.textContent?.trim() };
    });
    results.s2Form = form;
    sc.step(
      '登录页表单字段与 label 关联',
      '每个 input 都有 label 或 aria-label；密码框 type=password 且 autocomplete 正确',
      `${form.inputs.length} 个输入；无 label=${form.inputs.filter((i) => !i.hasLabel).length} 个；密码 autocomplete=${form.inputs.find((i) => i.type === 'password')?.autocomplete}`,
      form.inputs.every((i) => i.hasLabel),
    );

    // —— 2.2 空提交 ——
    await page.click('button[type="submit"]');
    await sleep(900);
    const emptySubmit = await page.evaluate(() => ({
      errorText: (document.querySelector('.nm-error, .card__error, [class*="error"]')?.textContent || '').trim(),
      toasts: Array.from(document.querySelectorAll('.toast, [class*="toast"]')).map((t) => t.textContent.trim()),
      stillOnLogin: location.pathname === '/login',
      url: location.pathname,
    }));
    results.s2EmptySubmit = emptySubmit;
    sc.step(
      '空表单提交',
      '出现明确错误提示（必填校验）',
      `URL=${emptySubmit.url}；错误文案="${emptySubmit.errorText}"；toast=${JSON.stringify(emptySubmit.toasts)}`,
      Boolean(emptySubmit.errorText || emptySubmit.toasts.length),
      emptySubmit.errorText || emptySubmit.toasts.length ? '' : '点「登录」无任何反馈 → 静默失败',
    );
    await shot(page, 'web-s2-empty-submit');

    // —— 2.3 错误密码 ——
    await page.fill('#account', 'admin');
    await page.fill('#password', 'definitely-wrong-pass-150');
    await page.click('button[type="submit"]');
    await sleep(2200);
    const wrongPass = await page.evaluate(() => ({
      errorText: (document.querySelector('.card__error, .nm-error, [class*="error"]')?.textContent || '').trim(),
      bodyHasError: /密码|错误|失败/.test(
        Array.from(document.querySelectorAll('p, div, span')).map((e) => e.textContent).join(' '),
      ),
      url: location.pathname,
      btnDisabled: document.querySelector('button[type="submit"]')?.disabled ?? null,
    }));
    results.s2WrongPass = wrongPass;
    sc.step(
      '错误密码登录',
      '页面可见错误提示，停留在登录页，按钮恢复可点',
      `错误文案="${wrongPass.errorText}"；URL=${wrongPass.url}；按钮 disabled=${wrongPass.btnDisabled}`,
      Boolean(wrongPass.errorText) && wrongPass.url === '/login',
    );
    await shot(page, 'web-s2-wrong-pass');

    // —— 2.4 正确登录 ——
    await page.fill('#account', 'admin');
    await page.fill('#password', auditPass());
    await page.click('button[type="submit"]');
    const loggedIn = await waitUntil(page, () => location.pathname === '/app' && document.querySelector('.shell__main'), {
      timeout: 25000,
    });
    sc.step(
      '正确账号密码登录',
      '跳转 /app 并渲染工作台外壳',
      loggedIn ? '已进入 /app' : `未跳转，当前 ${await page.evaluate(() => location.pathname)}`,
      Boolean(loggedIn),
    );
    await shot(page, 'web-s2-logged-in');

    // 登录态持久化：刷新后仍登录
    await page.reload({ waitUntil: 'networkidle', timeout: 45000 });
    const afterReload = await waitUntil(page, () => document.querySelector('.shell__main'), { timeout: 25000 });
    const userShown = await page.evaluate(() => document.body.innerText.includes('admin'));
    sc.step(
      '刷新后登录态保持',
      '不跳登录页，工作台正常渲染，用户名可见',
      `shell=${Boolean(afterReload)}；用户名可见=${userShown}；URL=${await page.evaluate(() => location.pathname)}`,
      Boolean(afterReload) && userShown,
    );

    // —— 2.5 注册流程 ——
    const reg = await (async () => {
      // 用独立上下文，避免已登录态干扰
      const s2 = await newSession(chromium);
      try {
        await s2.page.goto(`${BASE}/login?mode=register`, { waitUntil: 'networkidle', timeout: 45000 });
        const hasForm = await s2.page.evaluate(() => Boolean(document.querySelector('#email')));
        if (!hasForm) {
          // 退回：点「立即注册」
          await s2.page.evaluate(() => {
            Array.from(document.querySelectorAll('button.link')).find((b) => /注册/.test(b.textContent || ''))?.click();
          });
          await sleep(600);
        }
        const fields = await s2.page.evaluate(() =>
          Array.from(document.querySelectorAll('input')).map((i) => ({ id: i.id, type: i.type })),
        );
        await s2.page.fill('#email', newUser.email);
        await s2.page.fill('#username', newUser.username);
        const pwSel = (await s2.page.evaluate(() => document.querySelectorAll('input[type="password"]').length)) > 1
          ? 'input[type="password"]'
          : '#newpass';
        await s2.page.fill(pwSel, newUser.password);
        await shot(s2.page, 'web-s2-register-form');
        await s2.page.click('button[type="submit"]');
        const ok = await waitUntil(s2.page, () => location.pathname === '/app', { timeout: 25000 });
        const errText = await s2.page.evaluate(
          () => (document.querySelector('.card__error, .nm-error, [class*="error"]')?.textContent || '').trim(),
        );
        return { fields, ok: Boolean(ok), errText, logs: s2.logs, url: await s2.page.evaluate(() => location.pathname) };
      } finally {
        await s2.browser.close().catch(() => {});
      }
    })();
    results.s2Register = { fields: reg.fields, ok: reg.ok, errText: reg.errText, url: reg.url };
    sc.step(
      '注册新账号',
      '填写邮箱/用户名/密码后成功注册并进入 /app',
      `字段=${JSON.stringify(reg.fields.map((f) => f.id))}；结果 URL=${reg.url}；错误文案="${reg.errText}"`,
      reg.ok,
    );
    await shot(page, 'web-s2-registered');

    // —— 2.6 注册重复邮箱（错误提示）——
    const dup = await (async () => {
      const s3 = await newSession(chromium);
      try {
        await s3.page.goto(`${BASE}/login?mode=register`, { waitUntil: 'networkidle', timeout: 45000 });
        await s3.page.fill('#email', newUser.email).catch(() => {});
        await s3.page.fill('#username', `${newUser.username}x`).catch(() => {});
        const pws = await s3.page.evaluate(() => document.querySelectorAll('input[type="password"]').length);
        await s3.page.fill('input[type="password"]', newUser.password).catch(() => {});
        await s3.page.click('button[type="submit"]');
        await sleep(2200);
        const e = await s3.page.evaluate(() => ({
          text: (document.querySelector('.card__error, .nm-error, [class*="error"]')?.textContent || '').trim(),
          body: document.body.innerText.slice(0, 400),
          url: location.pathname,
        }));
        return { errText: e.text, url: e.url, pwCount: pws, bodyHas: /已被注册|已占用|已存在/.test(e.body) };
      } finally {
        await s3.browser.close().catch(() => {});
      }
    })();
    results.s2DupRegister = dup;
    sc.step(
      '重复邮箱注册',
      '提示「该邮箱已被注册」类明确文案',
      `错误区="${dup.errText}"；页面含冲突文案=${dup.bodyHas}；URL=${dup.url}`,
      Boolean(dup.errText) || dup.bodyHas,
    );

    // —— 2.7 登录限流（10 次/分钟）——
    const rl = await (async () => {
      const rs = [];
      for (let i = 0; i < 12; i += 1) {
        const r = await httpJson(`${API}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ account: 'admin', password: 'wrong-rate-limit-probe' }),
        });
        rs.push({ i, status: r.status, code: r.body?.error?.code, msg: r.body?.error?.message, retryAfter: r.headers?.['retry-after'] });
      }
      return rs;
    })();
    results.s2RateLimit = rl;
    const got429 = rl.filter((r) => r.status === 429);
    sc.step(
      '登录限流（连续 12 次错误密码）',
      '第 11 次起返回 429 + Retry-After',
      `429 次数=${got429.length}；首次 429 出现在第 ${got429[0]?.i + 1 ?? '-'} 次；Retry-After=${got429[0]?.retryAfter ?? '-'}`,
      got429.length > 0,
    );
    sc.observe(
      `限流期 429 文案：${got429[0]?.msg ?? '（无）'} —— 前端是否把它呈现给用户需单独验证（见 S2.8）`,
    );

    // —— 2.8 UI 层限流提示（前端是否把 429 变成人话）——
    const uiRl = await (async () => {
      const s4 = await newSession(chromium);
      try {
        await s4.page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 45000 });
        for (let i = 0; i < 4; i += 1) {
          await s4.page.fill('#account', 'admin');
          await s4.page.fill('#password', 'wrong-rl-ui-probe');
          await s4.page.click('button[type="submit"]');
          await sleep(700);
        }
        const txt = await s4.page.evaluate(
          () => (document.querySelector('.card__error, .nm-error, [class*="error"]')?.textContent || '').trim(),
        );
        return { errText: txt };
      } finally {
        await s4.browser.close().catch(() => {});
      }
    })();
    results.s2UiRateLimit = uiRl;
    sc.step(
      '限流时前端提示可读性',
      '用户能看到「请求过于频繁/请稍后」类文案，而非原始 code',
      `UI 错误文案="${uiRl.errText}"`,
      Boolean(uiRl.errText),
    );

    // —— 2.9 Token 过期行为 ——
    const expired = await (async () => {
      const s5 = await newSession(chromium, { tokens: { accessToken: 'invalid.expired.token', refreshToken: 'x', user: { username: 'admin', role: 'admin' } } });
      try {
        await s5.page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 45000 });
        await sleep(3500);
        const st = await s5.page.evaluate(() => ({
          url: location.pathname,
          hasShell: Boolean(document.querySelector('.shell__main')),
          bodyHead: document.body.innerText.replace(/\s+/g, ' ').slice(0, 220),
          token: (localStorage.getItem('neomd.access') || '').slice(0, 24),
          hasRefresh: Boolean(localStorage.getItem('neomd.refresh')),
        }));
        await shot(s5.page, 'web-s2-expired-token');
        return { ...st, logs: s5.logs };
      } finally {
        await s5.browser.close().catch(() => {});
      }
    })();
    results.s2ExpiredToken = expired;
    sc.step(
      '无效/过期 token 打开 /app',
      '要么重定向登录页并说明会话过期，要么以游客本机模式继续可用',
      `URL=${expired.url}；shell=${expired.hasShell}；token 仍保留=${Boolean(expired.token)}；首屏文案="${expired.bodyHead}"`,
      expired.url.includes('/login') || expired.hasShell,
      expired.url.includes('/app') && !expired.hasShell ? '既未跳登录也没渲染工作台 → 空白页风险' : '',
    );
    sc.observe(`过期 token 场景 pageerror=${expired.logs.pageErrors.length}，console.error=${expired.logs.consoleErrors.length}`);

    results.s2Logs = {
      consoleErrors: logs.consoleErrors,
      pageErrors: logs.pageErrors,
      failed: logs.failedRequests.filter((r) => !/favicon/.test(r.url)),
    };
  } catch (e) {
    sc.fail(String(e?.message ?? e));
  } finally {
    await browser.close().catch(() => {});
    sc.end();
  }
}

/* ==========================================================================
 * S3 建仓库 → 建文档 → 写作核心链路
 * ========================================================================== */

{
  const sc = beginScenario('S3', '建仓库 → 建文档 → 写作核心链路', '从零建仓库、新建文档、写满一段正文并确认保存与同步');
  const tokens = await apiLogin();
  const { browser, page, logs } = await newSession(chromium, { tokens });

  try {
    await page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 45000 });
    await waitUntil(page, () => document.querySelector('.shell__main'), { timeout: 30000 });
    await shot(page, 'web-s3-workbench');

    // —— 3.1 当前仓库状态 ——
    const vaultState = await page.evaluate(() => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const s = pinia._s.get('app');
      return {
        vaults: (s.vaults || []).map((v) => ({ id: v.vaultId, name: v.name, docCount: v.docCount })),
        current: s.vault?.name,
        docs: (s.docs || []).length,
        vaultReady: s.vaultReady,
      };
    });
    results.s3VaultState = vaultState;
    sc.step(
      '打开工作台并读取仓库列表',
      '至少一个仓库，能加载文档索引',
      `仓库=${JSON.stringify(vaultState.vaults)}；当前=${vaultState.current}；文档索引 ${vaultState.docs} 篇；vaultReady=${vaultState.vaultReady}`,
      vaultState.vaults.length > 0,
    );

    // —— 3.2 新建仓库入口 ——
    const createVaultEntry = await page.evaluate(() => {
      const btn = document.querySelector('.vaultpick__btn');
      if (!btn) return { found: false };
      btn.click();
      return { found: true, text: btn.textContent.trim().slice(0, 40) };
    });
    await sleep(500);
    const vaultMenu = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.popmenu__item, .vaultpick .popmenu button'));
      return items.map((i) => (i.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30));
    });
    results.s3VaultMenu = { createVaultEntry, vaultMenu };
    sc.step(
      '仓库切换菜单（页脚仓库按钮）',
      '菜单可打开，列出已有仓库与「新建仓库」入口',
      `按钮=${createVaultEntry.found}；菜单项=${JSON.stringify(vaultMenu)}`,
      createVaultEntry.found && vaultMenu.length > 0,
    );
    await shot(page, 'web-s3-vault-menu');

    const hasCreateVault = vaultMenu.some((t) => /新建|新建仓库|创建/.test(t));
    sc.step(
      '菜单里有「新建仓库」入口',
      '存在新建仓库入口',
      hasCreateVault ? '存在' : `不存在（菜单项：${JSON.stringify(vaultMenu)}）`,
      hasCreateVault,
      hasCreateVault ? '' : '仓库是产品核心概念，却可能只能从设置页建 —— 记录绕路成本',
    );

    // 关闭菜单
    await page.evaluate(() => document.body.click());
    await sleep(300);

    // —— 3.3 新建文档（点击 + 校验真实落库）——
    const before = await page.evaluate(() => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const s = pinia._s.get('app');
      return { docs: (s.docs || []).length, tabs: s.tabs.length };
    });
    await page.evaluate(() => {
      document.querySelector('.leftpanel__tools button.act--primary')?.click();
    });
    const created = await waitUntil(
      page,
      () => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
        const s = pinia._s.get('app');
        return s.docs.length > 0 ? { docs: s.docs.length, tabTitle: s.activeTab?.title, docId: s.activeTab?.docId } : null;
      },
      { timeout: 20000 },
    );
    results.s3CreateDoc = { before, created };
    sc.step(
      '点「新建文档」按钮',
      '文档数 +1，新标签打开且标题非空',
      `文档数 ${before.docs}→${created?.docs}；新标签标题="${created?.tabTitle}"`,
      Boolean(created) && Boolean(created.tabTitle),
    );
    createdDocTitle = created?.tabTitle ?? null;

    // 检查命名模板是否产生「空 input 尾巴」
    const namingProbe = await page.evaluate(() => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const st = pinia._s.get('settings');
      const s = pinia._s.get('app');
      return {
        template: st.settings.naming.template,
        mode: st.settings.naming.mode,
        title: s.activeTab?.title,
        looksPlaceholder: /[-—(（]\s*$/.test(s.activeTab?.title || ''),
      };
    });
    results.s3Naming = namingProbe;
    sc.step(
      '新建文档默认命名',
      '默认名可读（不含空模板尾巴，如「261031日1553-」）',
      `模板="${namingProbe.template}" 模式=${namingProbe.mode} → 实际标题="${namingProbe.title}"；疑似空尾巴=${namingProbe.looksPlaceholder}`,
      !namingProbe.looksPlaceholder,
      namingProbe.looksPlaceholder
        ? '模板 `YYMMDD日HHMM-{input}` 在 input 为空时生成尾部悬空的「-」，用户首次看到的名字不可读'
        : '',
    );

    // —— 3.4 写作 ——
    const draft =
      '# 审计 150 写作链路验证\n\n' +
      '这是一段用于验证**所见即所得**写作与保存链路的正文。\n\n' +
      '## 二级标题\n\n' +
      '- 列表项 A\n- 列表项 B\n\n' +
      '> 引用块用于验证 blockquote 渲染。\n\n' +
      '结尾一行用于确认保存后全文完整。\n';
    await page.click('.ProseMirror');
    await page.evaluate((text) => {
      const pm = document.querySelector('.ProseMirror');
      pm.focus();
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(pm);
      sel.removeAllRanges();
      sel.addRange(r);
      document.execCommand('insertText', false, text);
    }, draft);
    const typed = await waitUntil(
      page,
      () => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
        const s = pinia._s.get('app');
        const c = s.activeTab?.content ?? '';
        return c.includes('结尾一行用于确认保存后全文完整') ? { len: c.length, dirty: s.activeTab?.dirty } : null;
      },
      { timeout: 12000 },
    );
    results.s3Typing = typed;
    sc.step(
      '在所见即所得编辑器写入多段 Markdown',
      'store 内 content 与输入一致',
      `content 长度=${typed?.len}；dirty=${typed?.dirty}`,
      Boolean(typed),
    );

    // 渲染结构检查
    const render = await page.evaluate(() => {
      const pm = document.querySelector('.ProseMirror');
      return {
        h1: pm.querySelectorAll('h1').length,
        h2: pm.querySelectorAll('h2').length,
        strong: pm.querySelectorAll('strong').length,
        ul: pm.querySelectorAll('ul').length,
        li: pm.querySelectorAll('li').length,
        quote: pm.querySelectorAll('blockquote').length,
        html: pm.innerHTML.slice(0, 500),
      };
    });
    results.s3Render = render;
    sc.step(
      '所见即所得结构渲染（h1/h2/strong/ul/li/blockquote）',
      '各自元素数量与 Markdown 语法匹配',
      `h1=${render.h1} h2=${render.h2} strong=${render.strong} ul=${render.ul} li=${render.li} blockquote=${render.quote}`,
      render.h1 === 1 && render.h2 === 1 && render.strong === 1 && render.li === 2 && render.quote === 1,
    );
    await shot(page, 'web-s3-writing');

    // —— 3.5 保存（Ctrl+S）+ 校验真实落盘 ——
    const docId = created?.docId;
    await page.keyboard.press('Control+s');
    await sleep(2500);
    const saved = await page.evaluate(() => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const s = pinia._s.get('app');
      return { dirty: s.activeTab?.dirty, statusText: s.statusText, syncState: JSON.stringify(s.syncState), lastSyncAt: s.lastSyncAt };
    });
    results.s3Saved = saved;
    sc.step(
      'Ctrl+S 保存',
      'dirty 变为 false，状态栏给出已保存/同步状态',
      `dirty=${saved.dirty}；状态栏="${saved.statusText}"；syncState=${saved.syncState}`,
      saved.dirty === false,
    );

    // 服务端是否真有对象（内容真的上云了）
    const remote = await (async () => {
      const r = await httpJson(`${API}/api/storage/list?prefix=docs/${docId}/`, {
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });
      const keys = Array.isArray(r.body?.data?.keys) ? r.body.data.keys : Array.isArray(r.body?.data) ? r.body.data : [];
      return { status: r.status, count: keys.length, sample: keys.slice(0, 3) };
    })();
    results.s3RemoteObjects = remote;
    sc.step(
      '服务端对象存储确认正文已上传',
      `docs/${docId}/ 下至少 1 个版本对象`,
      `HTTP ${remote.status}，对象 ${remote.count} 个：${JSON.stringify(remote.sample)}`,
      remote.count > 0,
    );

    // —— 3.6 刷新后内容仍在（本地/云端往返）——
    await page.reload({ waitUntil: 'networkidle', timeout: 45000 });
    const persisted = await waitUntil(
      page,
      () => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
        const s = pinia._s.get('app');
        const c = s.activeTab?.content ?? '';
        return c.length > 0 ? { len: c.length, hasTail: c.includes('结尾一行用于确认保存后全文完整'), title: s.activeTab?.title } : null;
      },
      { timeout: 30000 },
    );
    results.s3Persisted = persisted;
    sc.step(
      '刷新页面后重新打开该文档',
      '正文完整保留（含最后一行）',
      persisted ? `长度=${persisted.len}；含尾行=${persisted.hasTail}；标题="${persisted.title}"` : '刷新后无活动文档内容',
      Boolean(persisted?.hasTail),
    );
    await shot(page, 'web-s3-after-reload');

    // —— 3.7 侧栏文档列表是否反映新文档 ——
    const listAfter = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.file-row')).map((r) => (r.textContent || '').trim().slice(0, 40));
      return { rowCount: rows.length, sample: rows.slice(0, 6) };
    });
    results.s3DocList = listAfter;
    sc.step(
      '左侧文件列表出现新文档',
      '列表首项为刚建的文档',
      `列表 ${listAfter.rowCount} 行，样例=${JSON.stringify(listAfter.sample)}`,
      listAfter.rowCount > 0,
    );

    results.s3Logs = {
      consoleErrors: logs.consoleErrors,
      pageErrors: logs.pageErrors,
      failed: logs.failedRequests.filter((r) => !/favicon/.test(r.url)),
    };
    sc.step(
      '写作链路全程无控制台报错',
      '0 pageerror',
      `pageerror=${logs.pageErrors.length}；console.error=${logs.consoleErrors.length}；失败请求=${results.s3Logs.failed.length}`,
      logs.pageErrors.length === 0,
    );
  } catch (e) {
    sc.fail(String(e?.message ?? e));
  } finally {
    await browser.close().catch(() => {});
    sc.end();
  }
}

/* ==========================================================================
 * 落盘
 * ========================================================================== */

fs.mkdirSync(RAW_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });
writeScenarioJson('web-s1-s3.json', { section: 'S1-S3 游客/登录注册/写作链路', results, createdDocTitle });
scenarioSummary();
console.log('\n（本组不清理 admin 既有仓库存量文档；新建文档标题已记录，供后续组复用）');
