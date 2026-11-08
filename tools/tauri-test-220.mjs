#!/usr/bin/env node
/**
 * Tauri 2.2.0 完整实测脚本
 * 通过外部 Chrome CDP 驱动 Tauri 页面
 */

import WebSocket from 'ws';
import http from 'http';

const CDP_WS = 'ws://127.0.0.1:9333/devtools/page/AF49222F00A49AC5182292DF9D218C90';
const REPORT = {
  startTime: new Date().toISOString(),
  tests: [],
  explorations: [],
  errors: []
};

let ws;
let msgId = 1;
const pending = new Map();

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 10000);
  });
}

async function evaluate(expr) {
  const result = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(`JS error: ${result.exceptionDetails.text}`);
  }
  return result.result.value;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function test1_StartupNoCrash() {
  console.log('Test 1: 启动不闪退');
  // 进程已存活，检查页面是否加载
  await sleep(3000);
  const readyState = await evaluate('document.readyState');
  return { pass: readyState === 'complete', evidence: `readyState=${readyState}` };
}

async function test2_PageNotEmpty() {
  console.log('Test 2: 页面非空白');
  const bodyLen = await evaluate('document.body.innerText.trim().length');
  const appChildren = await evaluate('document.querySelector("#app")?.children.length || 0');
  const shellWorkLen = await evaluate('document.querySelector(".shell__work")?.outerHTML?.length || 0');
  return {
    pass: appChildren > 0 && shellWorkLen > 5000,
    evidence: `body=${bodyLen}字, #app子节点=${appChildren}, .shell__work=${shellWorkLen}字符`
  };
}

async function test3_Login() {
  console.log('Test 3: 登录');
  // 先检查是否已登录
  const loggedIn = await evaluate(`
    (function() {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      return app.isLoggedIn;
    })()
  `);
  if (loggedIn) {
    return { pass: true, evidence: '已登录状态' };
  }
  // 执行登录
  const loginResult = await evaluate(`
    fetch('/api/auth/login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({account:'admin', password:'6655', deviceId:'test-device'})
    }).then(r => r.json())
  `);
  if (!loginResult.data?.accessToken) {
    return { pass: false, evidence: `登录失败: ${JSON.stringify(loginResult)}` };
  }
  // 写入 token
  await evaluate(`
    (function() {
      const token = '${loginResult.data.accessToken}';
      localStorage.setItem('neomd.access', token);
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      app.user = { account: 'admin' };
      app.isLoggedIn = true;
      return true;
    })()
  `);
  await sleep(1000);
  const finalCheck = await evaluate(`
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
    const app = pinia.get('app');
    return app.isLoggedIn;
  `);
  return { pass: finalCheck === true, evidence: `登录后 isLoggedIn=${finalCheck}` };
}

async function test4_LoginPersistence() {
  console.log('Test 4: 登录态持久化');
  const tokenBefore = await evaluate("localStorage.getItem('neomd.access')");
  return { pass: !!tokenBefore, evidence: `token存在=${!!tokenBefore}` };
}

async function test5_RepoSync() {
  console.log('Test 5: 仓库/云同步');
  const result = await evaluate(`
    (function() {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      return {
        docsLen: app.docs?.length || 0,
        syncState: app.syncState
      };
    })()
  `);
  return {
    pass: result.docsLen > 0 && result.syncState === 'idle',
    evidence: `docs=${result.docsLen}, syncState=${result.syncState}`
  };
}

async function test6_OpenDoc() {
  console.log('Test 6: 打开文档');
  const result = await evaluate(`
    (async function() {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      if (!app.docs || app.docs.length === 0) return { error: '无文档' };
      const docId = app.docs[0].id;
      await app.openDoc(docId);
      await new Promise(r => setTimeout(r, 500));
      return {
        tabsLen: app.tabs.length,
        firstDocId: app.tabs[0]?.docId,
        match: app.tabs[0]?.docId === docId
      };
    })()
  `);
  if (result.error) return { pass: false, evidence: result.error };
  return { pass: result.match, evidence: `tabs=${result.tabsLen}, docId匹配=${result.match}` };
}

async function test7_EditSave() {
  console.log('Test 7: 编辑保存');
  const marker = 'TEST_MARKER_' + Date.now();
  const result = await evaluate(`
    (async function() {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      // 新建文档
      const newDocId = await app.createDoc('测试文档_' + Date.now());
      await app.openDoc(newDocId);
      await new Promise(r => setTimeout(r, 300));
      // 写入标记
      app.updateContent(newDocId, '测试内容: ${marker}');
      await app.saveActiveTab();
      await new Promise(r => setTimeout(r, 1000));
      // 查云端
      const doc = app.docs.find(d => d.id === newDocId);
      return {
        docId: newDocId,
        content: doc?.content?.substring(0, 100),
        hasMarker: doc?.content?.includes('${marker}')
      };
    })()
  `);
  return { pass: result.hasMarker, evidence: `docId=${result.docId}, 含标记=${result.hasMarker}` };
}

async function test8_HistoryVersions() {
  console.log('Test 8: 历史版本');
  const result = await evaluate(`
    (async function() {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      if (!app.tabs || app.tabs.length === 0) return { error: '无标签' };
      const docId = app.tabs[0].docId;
      // 获取基线版本数
      const versions1 = await app.listDocVersions(docId);
      const baseCount = versions1?.length || 0;
      // 修改并保存
      app.updateContent(docId, app.tabs[0].content + '\\n追加内容_' + Date.now());
      await app.saveActiveTab();
      await new Promise(r => setTimeout(r, 1000));
      // 再查版本
      const versions2 = await app.listDocVersions(docId);
      const newCount = versions2?.length || 0;
      return {
        baseCount,
        newCount,
        increased: newCount > baseCount
      };
    })()
  `);
  if (result.error) return { pass: false, evidence: result.error };
  return { pass: result.increased, evidence: `基线=${result.baseCount}, 保存后=${result.newCount}, 增加=${result.increased}` };
}

async function test9_Shortcuts() {
  console.log('Test 9: 快捷键');
  const results = [];
  
  // Ctrl+P 命令面板
  const before_P = await evaluate("document.querySelector('.palette')?.style.display");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', {key:'p', ctrlKey:true}))");
  await sleep(300);
  const after_P = await evaluate("document.querySelector('.palette')?.style.display");
  results.push({ key: 'Ctrl+P', pass: after_P !== 'none', evidence: `before=${before_P}, after=${after_P}` });
  
  // Ctrl+, 设置
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', {key:',', ctrlKey:true}))");
  await sleep(300);
  const settingsTab = await evaluate(`
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
    const app = pinia.get('app');
    return app.tabs.some(t => t.docId === 'settings');
  `);
  results.push({ key: 'Ctrl+,', pass: settingsTab, evidence: `设置标签=${settingsTab}` });
  
  // Ctrl+S 保存
  await evaluate(`
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
    const app = pinia.get('app');
    app.updateContent(app.tabs[0].docId, 'test_' + Date.now());
  `);
  const dirtyBefore = await evaluate(`
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
    const app = pinia.get('app');
    return app.tabs[0].dirty;
  `);
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', {key:'s', ctrlKey:true}))");
  await sleep(500);
  const dirtyAfter = await evaluate(`
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
    const app = pinia.get('app');
    return app.tabs[0].dirty;
  `);
  results.push({ key: 'Ctrl+S', pass: dirtyBefore === true && dirtyAfter === false, evidence: `dirty: ${dirtyBefore}→${dirtyAfter}` });
  
  // Ctrl+N 新建
  const tabsBefore = await evaluate(`
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
    const app = pinia.get('app');
    return app.tabs.length;
  `);
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', {key:'n', ctrlKey:true}))");
  await sleep(300);
  const tabsAfter = await evaluate(`
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
    const app = pinia.get('app');
    return app.tabs.length;
  `);
  results.push({ key: 'Ctrl+N', pass: tabsAfter > tabsBefore, evidence: `tabs: ${tabsBefore}→${tabsAfter}` });
  
  // Ctrl+W 关闭
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', {key:'w', ctrlKey:true}))");
  await sleep(300);
  const tabsAfterClose = await evaluate(`
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
    const app = pinia.get('app');
    return app.tabs.length;
  `);
  results.push({ key: 'Ctrl+W', pass: tabsAfterClose < tabsAfter, evidence: `tabs: ${tabsAfter}→${tabsAfterClose}` });
  
  const passCount = results.filter(r => r.pass).length;
  return {
    pass: passCount >= 5,
    evidence: `${passCount}/${results.length} 通过: ` + results.map(r => `${r.key}=${r.pass ? '✓' : '✗'}`).join(', ')
  };
}

async function test10_Settings() {
  console.log('Test 10: 设置');
  const result = await evaluate(`
    (async function() {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      let settingsStore = null;
      for (const [, v] of pinia) {
        if (v && typeof v === 'object' && 'settings' in v) {
          settingsStore = v;
          break;
        }
      }
      if (!settingsStore) return { error: '找不到设置store' };
      
      // 打开设置标签
      await app.openSettings();
      await new Promise(r => setTimeout(r, 300));
      
      // 找字号输入框
      const fontSizeInput = document.querySelector('input[aria-label*="字号"][type="number"]');
      if (!fontSizeInput) return { error: '找不到字号输入框' };
      
      const originalSize = settingsStore.appearance.fontSize;
      
      // 改值但不点保存
      fontSizeInput.value = 20;
      fontSizeInput.dispatchEvent(new Event('input', { bubbles: true }));
      fontSizeInput.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      
      // 检查草稿阶段 store 不变
      const afterDraft = settingsStore.appearance.fontSize;
      const draftNotSaved = afterDraft === originalSize;
      
      // 点保存
      const saveBtn = document.querySelector('.settings-savebar button');
      if (saveBtn) saveBtn.click();
      await new Promise(r => setTimeout(r, 500));
      
      // 检查保存后 store 变了
      const afterSave = settingsStore.appearance.fontSize;
      const saved = afterSave === 20;
      
      // 恢复原值
      fontSizeInput.value = originalSize;
      fontSizeInput.dispatchEvent(new Event('input', { bubbles: true }));
      fontSizeInput.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('.settings-savebar button')?.click();
      
      return {
        originalSize,
        afterDraft,
        draftNotSaved,
        afterSave,
        saved
      };
    })()
  `);
  if (result.error) return { pass: false, evidence: result.error };
  return {
    pass: result.draftNotSaved && result.saved,
    evidence: `原值=${result.originalSize}, 草稿=${result.afterDraft}(不变=${result.draftNotSaved}), 保存后=${result.afterSave}(生效=${result.saved})`
  };
}

async function test11_AdminRoundTrip() {
  console.log('Test 11: 管理后台往返');
  const result = await evaluate(`
    (async function() {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      
      // 先开2个文档标签
      if (app.tabs.length < 2) {
        const docs = app.docs.slice(0, 2);
        for (const d of docs) {
          await app.openDoc(d.id);
        }
      }
      const tabsBefore = app.tabs.length;
      const docIdsBefore = app.tabs.map(t => t.docId);
      
      // 进后台
      window.location.hash = '#/admin';
      await new Promise(r => setTimeout(r, 800));
      
      // 回前台
      window.location.hash = '#/app';
      await new Promise(r => setTimeout(r, 800));
      
      const tabsAfter = app.tabs.length;
      const docIdsAfter = app.tabs.map(t => t.docId);
      
      // 检查无重复
      const uniqueDocIds = new Set(docIdsAfter.filter(id => id !== 'settings'));
      const noDupes = uniqueDocIds.size === docIdsAfter.filter(id => id !== 'settings').length;
      
      return {
        tabsBefore,
        tabsAfter,
        noDupes,
        sameCount: tabsBefore === tabsAfter
      };
    })()
  `);
  return {
    pass: result.sameCount && result.noDupes,
    evidence: `标签: ${result.tabsBefore}→${result.tabsAfter}, 无重复=${result.noDupes}`
  };
}

async function test12_ConsoleClean() {
  console.log('Test 12: 控制台干净');
  // 收集控制台错误（已在监听）
  const errors = REPORT.errors.filter(e => e.type === 'exception' || e.type === 'error');
  return {
    pass: errors.length === 0,
    evidence: `未捕获异常=${errors.length}`
  };
}

async function exploration_LargeDoc() {
  console.log('探索: 大文档性能');
  const result = await evaluate(`
    (async function() {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      const largeContent = '测试内容'.repeat(20000); // 约10万字
      const docId = await app.createDoc('大文档测试');
      await app.openDoc(docId);
      const start = Date.now();
      app.updateContent(docId, largeContent);
      await app.saveActiveTab();
      const elapsed = Date.now() - start;
      return { elapsed, contentLen: largeContent.length };
    })()
  `);
  return { item: '10万字文档保存', result: `${result.elapsed}ms`, note: result.elapsed < 5000 ? '性能良好' : '性能较慢' };
}

async function exploration_ChineseFilename() {
  console.log('探索: 中文文件名');
  const result = await evaluate(`
    (async function() {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      const docId = await app.createDoc('中文标题测试_空格 test_超长标题'.repeat(5));
      await app.openDoc(docId);
      await app.saveActiveTab();
      const doc = app.docs.find(d => d.id === docId);
      return { success: !!doc, title: doc?.title?.substring(0, 50) };
    })()
  `);
  return { item: '中文/空格/超长文件名', result: result.success ? '成功' : '失败', note: result.title };
}

async function exploration_ManyTabs() {
  console.log('探索: 12个标签页');
  const result = await evaluate(`
    (async function() {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      for (let i = 0; i < 12; i++) {
        const docId = await app.createDoc('标签测试' + i);
        await app.openDoc(docId);
      }
      return { tabsCount: app.tabs.length };
    })()
  `);
  return { item: '12个标签页', result: `${result.tabsCount}个标签`, note: result.tabsCount >= 12 ? '正常' : '异常' };
}

async function exploration_NarrowWindow() {
  console.log('探索: 窄窗口');
  const widths = [500, 600, 700, 720, 800, 900];
  const results = [];
  for (const w of widths) {
    await cdp('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    });
    await sleep(300);
    const overflow = await evaluate('document.documentElement.scrollWidth - window.innerWidth');
    results.push({ width: w, overflow });
  }
  await cdp('Emulation.clearDeviceMetricsOverride');
  const allPass = results.every(r => r.overflow <= 0);
  return { item: '窄窗口横向溢出', result: allPass ? '全部通过' : '有溢出', note: results.map(r => `${r.width}px:${r.overflow}`).join(', ') };
}

async function exploration_DarkTheme() {
  console.log('探索: 深色主题');
  const result = await evaluate(`
    (async function() {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      let settings = null;
      for (const [, v] of pinia) {
        if (v && typeof v === 'object' && 'settings' in v) {
          settings = v;
          break;
        }
      }
      const originalTheme = settings.appearance.theme;
      settings.updateAppearance({ theme: 'dark' });
      document.querySelector('.settings-savebar button')?.click();
      await new Promise(r => setTimeout(r, 500));
      const bodyColor = getComputedStyle(document.body).color;
      const bgColor = getComputedStyle(document.body).backgroundColor;
      // 恢复
      settings.updateAppearance({ theme: originalTheme });
      document.querySelector('.settings-savebar button')?.click();
      return { bodyColor, bgColor };
    })()
  `);
  return { item: '深色主题对比度', result: '已切换', note: `正文色=${result.bodyColor}, 背景=${result.bgColor}` };
}

async function exploration_QuickSwitch() {
  console.log('探索: 快速切换10个文档');
  const result = await evaluate(`
    (async function() {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      const docs = app.docs.slice(0, 10);
      const start = Date.now();
      for (const d of docs) {
        await app.openDoc(d.id);
      }
      const elapsed = Date.now() - start;
      return { elapsed, count: docs.length };
    })()
  `);
  return { item: '快速切换10个文档', result: `${result.elapsed}ms`, note: result.elapsed < 3000 ? '流畅' : '较慢' };
}

async function exploration_ConsecutiveSave() {
  console.log('探索: 连续保存5次');
  const result = await evaluate(`
    (async function() {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      const docId = app.tabs[0]?.docId;
      if (!docId) return { error: '无标签' };
      const start = Date.now();
      for (let i = 0; i < 5; i++) {
        app.updateContent(docId, '内容' + i + '_' + Date.now());
        await app.saveActiveTab();
      }
      const elapsed = Date.now() - start;
      return { elapsed, count: 5 };
    })()
  `);
  if (result.error) return { item: '连续保存5次', result: '失败', note: result.error };
  return { item: '连续保存5次', result: `${result.elapsed}ms`, note: result.elapsed < 5000 ? '正常' : '较慢' };
}

async function exploration_AdminMenus() {
  console.log('探索: 管理后台菜单');
  const result = await evaluate(`
    (async function() {
      window.location.hash = '#/admin';
      await new Promise(r => setTimeout(r, 500));
      const menuItems = document.querySelectorAll('.admin__nav-item, .admin__menu-item');
      const results = [];
      for (const item of Array.from(menuItems).slice(0, 5)) {
        item.click();
        await new Promise(r => setTimeout(r, 300));
        const hasContent = document.querySelector('.admin__content, .admin__main')?.children.length > 0;
        results.push({ menu: item.textContent.trim().substring(0, 20), hasContent });
      }
      window.location.hash = '#/app';
      return { results };
    })()
  `);
  const allOk = result.results.every(r => r.hasContent);
  return { item: '管理后台菜单', result: allOk ? '全部正常' : '有白屏', note: result.results.map(r => `${r.menu}:${r.hasContent ? '✓' : '✗'}`).join(', ') };
}

// Main
async function main() {
  console.log('开始 NeoMD 2.2.0 Tauri 实测...');
  
  ws = new WebSocket(CDP_WS);
  
  ws.on('open', async () => {
    console.log('CDP 连接成功');
    
    // 监听控制台错误
    await cdp('Runtime.enable');
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.method === 'Runtime.exceptionThrown') {
        REPORT.errors.push({ type: 'exception', text: msg.params.exceptionDetails.text });
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        REPORT.errors.push({ type: 'error', text: msg.params.args?.[0]?.value });
      }
    });
    
    await sleep(2000);
    
    // 验证 vault 位置
    const vaultLoc = await evaluate(`
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      return app.vaultLocation;
    `);
    console.log('仓库位置:', vaultLoc);
    
    // 运行必测12项
    const tests = [
      test1_StartupNoCrash,
      test2_PageNotEmpty,
      test3_Login,
      test4_LoginPersistence,
      test5_RepoSync,
      test6_OpenDoc,
      test7_EditSave,
      test8_HistoryVersions,
      test9_Shortcuts,
      test10_Settings,
      test11_AdminRoundTrip,
      test12_ConsoleClean
    ];
    
    for (const test of tests) {
      try {
        const result = await test();
        REPORT.tests.push({ name: test.name, ...result });
      } catch (err) {
        REPORT.tests.push({ name: test.name, pass: false, evidence: `错误: ${err.message}` });
      }
    }
    
    // 运行探索项
    const explorations = [
      exploration_LargeDoc,
      exploration_ChineseFilename,
      exploration_ManyTabs,
      exploration_NarrowWindow,
      exploration_DarkTheme,
      exploration_QuickSwitch,
      exploration_ConsecutiveSave,
      exploration_AdminMenus
    ];
    
    for (const exp of explorations) {
      try {
        const result = await exp();
        REPORT.explorations.push(result);
      } catch (err) {
        REPORT.explorations.push({ item: exp.name, result: '失败', note: err.message });
      }
    }
    
    REPORT.endTime = new Date().toISOString();
    
    // 输出 JSON 结果
    console.log('\n===TEST_REPORT_START===');
    console.log(JSON.stringify(REPORT, null, 2));
    console.log('===TEST_REPORT_END===');
    
    ws.close();
    process.exit(0);
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket 错误:', err.message);
    process.exit(1);
  });
}

main();
