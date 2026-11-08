// Comprehensive test script for NeoMD Qt shell 2.2.0
// Uses CDP via WebSocket to drive all tests
const WS_URL = 'ws://127.0.0.1:9222/devtools/page/56BAED7DAE093CDD6DA0FF93A3F72BDE';
const HTTP_URL = 'http://127.0.0.1:51339';

let msgId = 1;
const pending = new Map();
let ws;
const consoleErrors = [];
const exceptions = [];

function connect() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      // Collect console errors and exceptions
      if (msg.method === 'Runtime.exceptionThrown') {
        exceptions.push(msg.params.exceptionDetails);
      }
      if (msg.method === 'Runtime.consoleAPIMeasured' || msg.method === 'Runtime.consoleAPICalled') {
        if (msg.params?.type === 'error') {
          consoleErrors.push(msg.params);
        }
      }
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
  });
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }
    }, 15000);
  });
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return res.result?.result;
}

async function evaluateFull(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return res.result;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const results = {};

async function test1_Startup() {
  // Already running, verify process alive
  const res = await evaluate('document.title');
  results['1_startup'] = {
    pass: res?.value?.includes('Neo'),
    evidence: `title="${res?.value}"`
  };
}

async function test2_PageNotEmpty() {
  const res = await evaluate(`
    (() => {
      const bodyText = document.body?.innerText?.trim()?.length || 0;
      const appChildren = document.querySelector('#app')?.children?.length || 0;
      const shellWork = document.querySelector('.shell__work')?.innerHTML?.length || 0;
      return { bodyText, appChildren, shellWork };
    })()
  `);
  const v = res?.value;
  results['2_pageNotEmpty'] = {
    pass: v?.appChildren > 0 && v?.shellWork > 5000,
    evidence: JSON.stringify(v)
  };
}

async function test3_Login() {
  // First check if already logged in
  let loggedIn = await evaluate(`
    (() => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      let userStore = null;
      for (const [, v] of pinia) {
        if (v && typeof v === 'object' && 'isLoggedIn' in v) { userStore = v; break; }
      }
      return userStore ? { isLoggedIn: userStore.isLoggedIn, hasUser: !!userStore.user } : null;
    })()
  `);
  
  if (loggedIn?.value?.isLoggedIn) {
    results['3_login'] = { pass: true, evidence: `Already logged in: ${JSON.stringify(loggedIn.value)}` };
    return;
  }
  
  // Login via API
  const loginRes = await fetch(`${HTTP_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: '6655', deviceId: 'test-qt' })
  }).then(r => r.json());
  
  if (loginRes?.data?.accessToken) {
    // Store token and reload
    await evaluate(`
      (async () => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
        let userStore = null;
        for (const [, v] of pinia) {
          if (v && typeof v === 'object' && 'setToken' in v) { userStore = v; break; }
        }
        localStorage.setItem('neomd.access', '${loginRes.data.accessToken}');
        if (loginRes.data.refreshToken) localStorage.setItem('neomd.refresh', '${loginRes.data.refreshToken}');
        location.reload();
      })()
    `);
    await sleep(3000);
    
    loggedIn = await evaluate(`
      (() => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
        let userStore = null;
        for (const [, v] of pinia) {
          if (v && typeof v === 'object' && 'isLoggedIn' in v) { userStore = v; break; }
        }
        return userStore ? { isLoggedIn: userStore.isLoggedIn, hasUser: !!userStore.user } : null;
      })()
    `);
    results['3_login'] = {
      pass: loggedIn?.value?.isLoggedIn === true,
      evidence: `After login: ${JSON.stringify(loggedIn?.value)}`
    };
  } else {
    results['3_login'] = { pass: false, evidence: `Login failed: ${JSON.stringify(loginRes)}` };
  }
}

async function test4_PersistLogin() {
  // Token should be in localStorage from previous test
  const tokens = await evaluate(`
    (() => {
      return {
        access: !!localStorage.getItem('neomd.access'),
        refresh: !!localStorage.getItem('neomd.refresh')
      };
    })()
  `);
  results['4_persistLogin'] = {
    pass: tokens?.value?.access === true,
    evidence: JSON.stringify(tokens?.value)
  };
}

async function test5_RepoSync() {
  const res = await evaluate(`
    (() => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      return {
        docsLength: app?.docs?.length || 0,
        syncState: app?.syncState || 'unknown'
      };
    })()
  `);
  const v = res?.value;
  results['5_repoSync'] = {
    pass: v?.docsLength > 0,
    evidence: JSON.stringify(v)
  };
}

async function test6_OpenDoc() {
  const res = await evaluate(`
    (async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      const firstDoc = app.docs[0];
      if (!firstDoc) return { error: 'no docs' };
      await app.openDoc(firstDoc.id);
      await new Promise(r => setTimeout(r, 500));
      const tabs = app.tabs.map(t => ({ id: t.id, docId: t.docId, title: t.title }));
      const activeTab = tabs.find(t => t.docId === firstDoc.id);
      return {
        docId: firstDoc.id,
        docTitle: firstDoc.title,
        tabsCount: tabs.length,
        activeTab: activeTab || null,
        hasEditor: !!document.querySelector('.editor-area, .cm-editor, [class*="editor"]')
      };
    })()
  `);
  const v = res?.value;
  results['6_openDoc'] = {
    pass: v?.activeTab && v?.hasEditor,
    evidence: JSON.stringify(v)
  };
}

async function test7_EditSave() {
  const res = await evaluate(`
    (async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      
      // Create new doc
      const newDoc = await app.createDoc({ title: 'QtTest-' + Date.now() });
      await app.openDoc(newDoc.id);
      await new Promise(r => setTimeout(r, 800));
      
      // Write content via editor
      const marker = 'QWERTY_UIOP_TEST_' + Date.now();
      const cmView = document.querySelector('.cm-editor');
      if (cmView) {
        const view = cmView.cmView?.view;
        if (view) {
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: marker } });
        }
      }
      
      // Save
      await app.saveActiveTab();
      await new Promise(r => setTimeout(r, 1500));
      
      // Verify cloud object
      const doc = app.docs.find(d => d.id === newDoc.id);
      return {
        marker,
        docId: newDoc.id,
        docTitle: doc?.title,
        docContent: doc?.content?.substring(0, 100),
        dirty: app.tabs.find(t => t.docId === newDoc.id)?.dirty
      };
    })()
  `);
  const v = res?.value;
  results['7_editSave'] = {
    pass: v?.docContent?.includes(v?.marker?.substring(0, 20)),
    evidence: JSON.stringify(v)
  };
}

async function test8_HistoryVersion() {
  const res = await evaluate(`
    (async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      
      // Find our test doc
      const testDoc = app.docs.find(d => d.title?.startsWith('QtTest-'));
      if (!testDoc) return { error: 'no test doc found' };
      
      // Get versions before
      const versionsBefore = await app.listDocVersions(testDoc.id);
      const countBefore = versionsBefore?.length || 0;
      
      // Modify and save again
      const cmView = document.querySelector('.cm-editor');
      if (cmView) {
        const view = cmView.cmView?.view;
        if (view) {
          const newContent = view.state.doc.toString() + '\\n---VERSION_TEST_2---';
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: newContent } });
        }
      }
      await app.saveActiveTab();
      await new Promise(r => setTimeout(r, 2000));
      
      const versionsAfter = await app.listDocVersions(testDoc.id);
      const countAfter = versionsAfter?.length || 0;
      
      return {
        docId: testDoc.id,
        countBefore,
        countAfter,
        grew: countAfter > countBefore,
        versions: (versionsAfter || []).map(v => ({ id: v.id, createdAt: v.createdAt }))
      };
    })()
  `);
  const v = res?.value;
  results['8_historyVersion'] = {
    pass: v?.grew === true,
    evidence: JSON.stringify(v)
  };
}

async function test9_Shortcuts() {
  // Test shortcuts one by one, each in a separate evaluate to avoid state flip-flop
  const shortcutResults = {};
  
  // Ctrl+P - Command palette
  let r = await evaluate(`
    (async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      const palette = document.querySelector('.palette, [class*="palette"]');
      const visible = palette ? palette.offsetParent !== null || getComputedStyle(palette).display !== 'none' : false;
      // Close it
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      return { visible, hasPalette: !!palette };
    })()
  `);
  shortcutResults['Ctrl+P'] = r?.value;
  
  // Ctrl+, - Settings tab
  r = await evaluate(`
    (async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      const tabsBefore = app.tabs.length;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 800));
      const settingsTab = app.tabs.find(t => t.type === 'settings' || t.title?.includes('设置'));
      return { hasSettingsTab: !!settingsTab, tabsCount: app.tabs.length };
    })()
  `);
  shortcutResults['Ctrl+,'] = r?.value;
  
  // Ctrl+E - View mode rotation
  r = await evaluate(`
    (async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      const activeTab = app.tabs.find(t => t.active);
      const modeBefore = activeTab?.mode;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      const modeAfter = app.tabs.find(t => t.active)?.mode;
      return { modeBefore, modeAfter, changed: modeBefore !== modeAfter };
    })()
  `);
  shortcutResults['Ctrl+E'] = r?.value;
  
  // Ctrl+S - Save (check dirty flag)
  r = await evaluate(`
    (async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      // Make doc dirty first
      const cmView = document.querySelector('.cm-editor');
      if (cmView) {
        const view = cmView.cmView?.view;
        if (view) {
          view.dispatch({ changes: { from: view.state.doc.length, insert: '\\nS_TEST' } });
        }
      }
      await new Promise(r => setTimeout(r, 300));
      const activeTab = app.tabs.find(t => t.active);
      const dirtyBefore = activeTab?.dirty;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 1000));
      const dirtyAfter = app.tabs.find(t => t.active)?.dirty;
      return { dirtyBefore, dirtyAfter };
    })()
  `);
  shortcutResults['Ctrl+S'] = r?.value;
  
  // Ctrl+Shift+F - Global search
  r = await evaluate(`
    (async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      const searchPanel = document.querySelector('[class*="search"], [class*="find"]');
      const visible = searchPanel ? searchPanel.offsetParent !== null : false;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      return { hasSearch: !!searchPanel, visible };
    })()
  `);
  shortcutResults['Ctrl+Shift+F'] = r?.value;
  
  // Ctrl+N - New doc
  r = await evaluate(`
    (async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      const countBefore = app.docs.length;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 1000));
      const countAfter = app.docs.length;
      return { countBefore, countAfter, created: countAfter > countBefore };
    })()
  `);
  shortcutResults['Ctrl+N'] = r?.value;
  
  // Ctrl+W - Close tab
  r = await evaluate(`
    (async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      const tabsBefore = app.tabs.length;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      const tabsAfter = app.tabs.length;
      return { tabsBefore, tabsAfter, closed: tabsAfter < tabsBefore };
    })()
  `);
  shortcutResults['Ctrl+W'] = r?.value;
  
  // Ctrl+\\ - Toggle left panel
  r = await evaluate(`
    (async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      let st = null;
      for (const [, v] of pinia) { if (v && typeof v === 'object' && ('settings' in v)) { st = v; break; } }
      const before = st?.settings?.layout?.leftPanelOpen;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '\\\\', ctrlKey: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      const after = st?.settings?.layout?.leftPanelOpen;
      return { before, after, toggled: before !== after };
    })()
  `);
  shortcutResults['Ctrl+\\'] = r?.value;
  
  // Count passes
  const passed = Object.values(shortcutResults).filter(r => {
    if (!r) return false;
    if (r.visible !== undefined) return r.visible || r.hasPalette || r.hasSearch;
    if (r.hasSettingsTab !== undefined) return r.hasSettingsTab;
    if (r.changed !== undefined) return r.changed;
    if (r.dirtyAfter !== undefined) return r.dirtyAfter === false;
    if (r.created !== undefined) return r.created;
    if (r.closed !== undefined) return r.closed;
    if (r.toggled !== undefined) return r.toggled;
    return false;
  }).length;
  
  results['9_shortcuts'] = {
    pass: passed >= 5,
    evidence: `Passed ${passed}/8 shortcuts: ${JSON.stringify(shortcutResults)}`
  };
}

async function test10_Settings() {
  const res = await evaluate(`
    (async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      let st = null;
      for (const [, v] of pinia) { if (v && typeof v === 'object' && ('settings' in v)) { st = v; break; } }
      
      // Open settings tab
      const app = pinia.get('app');
      // Ensure settings tab is open
      let settingsTab = app.tabs.find(t => t.type === 'settings');
      if (!settingsTab) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }));
        await new Promise(r => setTimeout(r, 800));
      }
      // Activate settings tab
      settingsTab = app.tabs.find(t => t.type === 'settings');
      if (settingsTab) {
        app.activateTab(settingsTab.id);
        await new Promise(r => setTimeout(r, 500));
      }
      
      // Click editor nav item
      const editorNav = document.querySelector('.settings__nav-item:nth-child(2)');
      if (editorNav) editorNav.click();
      await new Promise(r => setTimeout(r, 500));
      
      // Find font size input
      const fontSizeInput = document.querySelector('input[aria-label*="字号"][type="number"]');
      if (!fontSizeInput) return { error: 'font size input not found' };
      
      const originalValue = fontSizeInput.value;
      
      // Change value
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      nativeInputValueSetter.call(fontSizeInput, '20');
      fontSizeInput.dispatchEvent(new Event('input', { bubbles: true }));
      fontSizeInput.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      
      // Check store hasn't changed yet (draft mode)
      const draftFontSize = st?.draft?.appearance?.fontSize;
      const storeFontSize = st?.settings?.appearance?.fontSize;
      const lsSettings = JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}');
      const lsFontSize = lsSettings?.appearance?.fontSize;
      
      // Click save button
      const saveBtn = document.querySelector('.settings-savebar button, .settings-savebar .btn, button[class*="save"]');
      if (saveBtn) saveBtn.click();
      await new Promise(r => setTimeout(r, 800));
      
      // Now check store and localStorage
      const storeFontSizeAfter = st?.settings?.appearance?.fontSize;
      const lsSettingsAfter = JSON.parse(localStorage.getItem('neomd.settings.v1') || '{}');
      const lsFontSizeAfter = lsSettingsAfter?.appearance?.fontSize;
      
      return {
        originalValue,
        draftFontSize,
        storeFontSizeBefore: storeFontSize,
        lsFontSizeBefore: lsFontSize,
        storeFontSizeAfter,
        lsFontSizeAfter,
        draftDidNotWriteStore: storeFontSize === storeFontSizeAfter || storeFontSize === undefined,
        saveWroteStore: storeFontSizeAfter === 20,
        saveWroteLS: lsFontSizeAfter === 20
      };
    })()
  `);
  const v = res?.value;
  results['10_settings'] = {
    pass: v?.saveWroteStore || v?.saveWroteLS,
    evidence: JSON.stringify(v)
  };
}

async function test11_AdminRoundTrip() {
  const res = await evaluate(`
    (async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      
      // Open at least 2 doc tabs first
      const docs = app.docs.slice(0, 3);
      for (const doc of docs) {
        await app.openDoc(doc.id);
        await new Promise(r => setTimeout(r, 300));
      }
      const tabsBefore = app.tabs.length;
      const tabDocIdsBefore = app.tabs.map(t => t.docId).filter(Boolean);
      
      // Go to admin
      window.location.hash = '#/admin';
      // Or use router if available
      const router = document.querySelector('#app').__vue_app__.config.globalProperties.$router;
      if (router) {
        await router.push('/admin');
      }
      await new Promise(r => setTimeout(r, 1500));
      
      // Go back to app
      if (router) {
        await router.push('/app');
      }
      await new Promise(r => setTimeout(r, 1500));
      
      const tabsAfter1 = app.tabs.length;
      
      // Repeat round trip 2 more times
      for (let i = 0; i < 2; i++) {
        if (router) await router.push('/admin');
        await new Promise(r => setTimeout(r, 1000));
        if (router) await router.push('/app');
        await new Promise(r => setTimeout(r, 1000));
      }
      
      const tabsAfter3 = app.tabs.length;
      const tabDocIdsAfter = app.tabs.map(t => t.docId).filter(Boolean);
      
      // Check for duplicate docIds
      const dupes = tabDocIdsAfter.filter((id, i) => tabDocIdsAfter.indexOf(id) !== i);
      
      return {
        tabsBefore,
        tabsAfter1,
        tabsAfter3,
        tabDocIdsBefore: tabDocIdsBefore.length,
        tabDocIdsAfter: tabDocIdsAfter.length,
        duplicateDocIds: dupes.length > 0,
        uniqueDocIds: new Set(tabDocIdsAfter).size,
        totalDocIds: tabDocIdsAfter.length
      };
    })()
  `);
  const v = res?.value;
  results['11_adminRoundTrip'] = {
    pass: v?.tabsBefore === v?.tabsAfter3 && !v?.duplicateDocIds,
    evidence: JSON.stringify(v)
  };
}

async function test12_ConsoleClean() {
  results['12_consoleClean'] = {
    pass: exceptions.length === 0,
    evidence: `Exceptions: ${exceptions.length}, Console errors: ${consoleErrors.length}, Exceptions detail: ${JSON.stringify(exceptions.slice(0, 3))}`
  };
}

// Exploratory tests
async function exploratoryTests() {
  const exploratory = {};
  
  // E1: Large document (10k+ chars) save performance
  let r = await evaluate(`
    (async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      
      const bigDoc = await app.createDoc({ title: 'LargeDoc-QtTest' });
      await app.openDoc(bigDoc.id);
      await new Promise(r => setTimeout(r, 800));
      
      // Generate 100k chars
      let bigContent = '';
      const line = '这是一段用于测试大文档性能的中文内容。每行大约40个字符。\\n';
      while (bigContent.length < 100000) bigContent += line;
      
      const cmView = document.querySelector('.cm-editor');
      if (cmView?.cmView?.view) {
        const view = cmView.cmView.view;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: bigContent } });
      }
      
      const t0 = performance.now();
      await app.saveActiveTab();
      const t1 = performance.now();
      
      return { contentLength: bigContent.length, saveMs: Math.round(t1 - t0) };
    })()
  `);
  exploratory['largeDocSave'] = r?.value;
  
  // E2: Chinese filename
  r = await evaluate(`
    (async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      const doc = await app.createDoc({ title: '\\u6d4b\\u8bd5\\u4e2d\\u6587\\u6587\\u6863_\\u5e26\\u7a7a\\u683c \\u548c\\u82f1\\u6587' });
      await app.openDoc(doc.id);
      await new Promise(r => setTimeout(r, 500));
      const cmView = document.querySelector('.cm-editor');
      if (cmView?.cmView?.view) {
        cmView.cmView.view.dispatch({ changes: { from: 0, insert: 'Chinese filename test content' } });
      }
      await app.saveActiveTab();
      await new Promise(r => setTimeout(r, 1000));
      const found = app.docs.find(d => d.id === doc.id);
      return { title: found?.title, saved: !!found };
    })()
  `);
  exploratory['chineseFilename'] = r?.value;
  
  // E3: Quick switch 10 docs
  r = await evaluate(`
    (async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      const docs = app.docs.slice(0, 10);
      const t0 = performance.now();
      for (const doc of docs) {
        await app.openDoc(doc.id);
        await new Promise(r => setTimeout(r, 100));
      }
      const t1 = performance.now();
      return { switchedDocs: docs.length, totalMs: Math.round(t1 - t0), errors: null };
    })()
  `);
  exploratory['quickSwitch10'] = r?.value;
  
  // E4: 12 tabs
  r = await evaluate(`
    (async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      const docs = app.docs.slice(0, 12);
      for (const doc of docs) {
        await app.openDoc(doc.id);
        await new Promise(r => setTimeout(r, 150));
      }
      return { tabsCount: app.tabs.length, docsOpened: docs.length };
    })()
  `);
  exploratory['twelveTabs'] = r?.value;
  
  // E5: Save 5 times consecutively
  r = await evaluate(`
    (async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      const errors = [];
      const t0 = performance.now();
      for (let i = 0; i < 5; i++) {
        try {
          await app.saveActiveTab();
          await new Promise(r => setTimeout(r, 500));
        } catch (e) {
          errors.push(e.message);
        }
      }
      const t1 = performance.now();
      return { saves: 5, errors: errors.length, totalMs: Math.round(t1 - t0), errorMessages: errors };
    })()
  `);
  exploratory['save5Times'] = r?.value;
  
  // E6: Narrow window test
  r = await evaluate(`
    (async () => {
      const widths = [500, 600, 700, 720, 800, 900];
      const results = [];
      for (const w of widths) {
        // Can't actually resize window from page context, but we can check current overflow
        const overflow = document.documentElement.scrollWidth - window.innerWidth;
        results.push({ width: window.innerWidth, overflow, scrollWidth: document.documentElement.scrollWidth });
        break; // Only current width available from page context
      }
      return results;
    })()
  `);
  exploratory['narrowWindow'] = r?.value;
  
  // E7: Admin menus
  r = await evaluate(`
    (async () => {
      const router = document.querySelector('#app').__vue_app__.config.globalProperties.$router;
      if (!router) return { error: 'no router' };
      
      const menus = ['/admin', '/admin/users', '/admin/settings', '/admin/logs'];
      const results = [];
      for (const path of menus) {
        try {
          await router.push(path);
          await new Promise(r => setTimeout(r, 800));
          const bodyLen = document.body.innerText.trim().length;
          const hasContent = bodyLen > 50;
          results.push({ path, bodyLen, hasContent, error: null });
        } catch (e) {
          results.push({ path, error: e.message });
        }
      }
      // Go back to app
      await router.push('/app');
      await new Promise(r => setTimeout(r, 500));
      return results;
    })()
  `);
  exploratory['adminMenus'] = r?.value;
  
  // E8: Dark theme contrast
  r = await evaluate(`
    (() => {
      const body = document.body;
      const style = getComputedStyle(body);
      const color = style.color;
      const bg = style.backgroundColor;
      return { color, bg, theme: document.documentElement.getAttribute('data-theme') || document.documentElement.className };
    })()
  `);
  exploratory['darkTheme'] = r?.value;
  
  // E9: Vault location check
  r = await evaluate(`
    (() => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      const app = pinia.get('app');
      return { vaultLocation: app?.vaultLocation || 'N/A' };
    })()
  `);
  exploratory['vaultLocation'] = r?.value;
  
  return exploratory;
}

async function main() {
  console.log('Connecting to CDP...');
  await connect();
  console.log('Connected. Enabling runtime...');
  await send('Runtime.enable');
  await send('Page.enable');
  console.log('Starting tests...');
  
  await test1_Startup();
  await test2_PageNotEmpty();
  await test3_Login();
  await test4_PersistLogin();
  await test5_RepoSync();
  await test6_OpenDoc();
  await test7_EditSave();
  await test8_HistoryVersion();
  await test9_Shortcuts();
  await test10_Settings();
  await test11_AdminRoundTrip();
  await test12_ConsoleClean();
  
  console.log('Running exploratory tests...');
  const exploratory = await exploratoryTests();
  
  const output = { results, exploratory, exceptions: exceptions.slice(0, 10), consoleErrorCount: consoleErrors.length };
  console.log('TEST_OUTPUT_START');
  console.log(JSON.stringify(output, null, 2));
  console.log('TEST_OUTPUT_END');
  
  ws.close();
}

main().catch(e => {
  console.error('Test script error:', e);
  process.exit(1);
});
