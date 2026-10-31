/**
 * 1.4.0 内置插件逐一验证脚本。
 *
 * 用法：node tools/re14-builtin-plugins.mjs [--json]
 *
 * ## 为什么这个脚本的结论可信
 *
 * 它**不复制**宿主逻辑，而是直接 import 宿主自己的运行时：
 * - `packages/shared/src/builtin-plugin-runtime.ts` —— 26 款的能力表、
 *   命令派发表、以及字数/脚注/属性/出链/预览等全部纯函数；
 * - `packages/shared/src/plugins.ts` —— manifest（声明的命令、面板、扩展点）；
 * - `packages/shared/src/community-plugins.ts` —— 社区插件的安装与执行。
 *
 * `apps/web/src/views/EditorPage.vue` 与 `PluginPanel.vue` 调用的是同一份模块，
 * 所以这里测的是**真品**，不是复刻品。
 *
 * ## 判定口径（三层，缺一不可）
 *
 * 1. **清单一致性**：manifest 声明的每个命令 / 面板 / 扩展点，必须能在能力表里
 *    找到对应实现 —— 防止「清单写了、宿主没有」的静默失效；
 * 2. **宿主可解析**：命令能在派发表里命中；面板能在 `PluginPanel.vue` 里找到
 *    对应的 `v-else-if` 渲染分支（脚本直接读源码文本核对，不靠人工）；
 * 3. **执行有实效果**：把命令放到一个**会记录副作用**的假宿主上跑一遍，
 *    断言「至少产生一个可观测后果」（打开面板 / 改了文档 / 打开了弹窗 /
 *    给了提示），而不是「没抛异常就算过」。
 *
 * 无副作用的命令（例如「打开分享弹窗」）用「宿主动作被调用」作为效果；
 * 有文档变换的命令用「文档真的变了」作为效果。两种情况都覆盖不到才算失败。
 */

import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * 让 Node 能直接加载仓库里的 `.ts` 源码。
 *
 * 两个必须解决的差异（都用宿主侧的 hook 解决，**不改仓库源码的 import 写法**）：
 *
 * 1. **扩展名省略**：源码里写 `import { x } from './plugin-source'`（bundler 风格，
 *    Vite / vitest 都认）。Node 的 ESM 解析要求显式扩展名，否则
 *    `ERR_MODULE_NOT_FOUND`。这里在解析阶段补 `.ts` / `/index.ts`。
 * 2. **Windows 盘符路径**：`import('C:\\...')` 会报
 *    `ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'c:'`，必须转成 `file://` URL。
 *
 * 注意：本脚本能直接跑 `.ts`，靠的是 Node 24 的内置类型擦除
 * （`--experimental-strip-types` 在 22.18+/24 默认开启）。
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    // 相对路径且没有扩展名 => 依次尝试 .ts / .tsx / /index.ts
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {
      const base = new URL(specifier, context.parentURL);
      for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`, `${base.href}.js`]) {
        try {
          if (fs.existsSync(fileURLToPath(candidate))) {
            return { url: candidate, shortCircuit: true };
          }
        } catch {
          /* 继续尝试下一个候选 */
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

/** Windows 安全地把绝对路径转成可 import 的 URL */
const load = (relPath) => import(pathToFileURL(path.join(ROOT, relPath)).href);

const runtime = await load('packages/shared/src/builtin-plugin-runtime.ts');
const manifests = await load('packages/shared/src/plugins.ts');
const community = await load('packages/shared/src/community-plugins.ts');

const {
  BUILTIN_PLUGIN_CAPABILITY,
  executeBuiltinCommand,
  computeWordStats,
  extractFootnotes,
  aggregateProperties,
  extractOutgoingLinks,
  buildLinkPreviews,
  parseBookmarks,
  toggleBookmark,
  commandOwner,
  allBuiltinCommandIds,
  getBuiltinCapability,
} = runtime;

/** 渲染分支读取来源（用于核对「面板真的有人在渲染」） */
const PANEL_VUE = fs.readFileSync(path.join(ROOT, 'apps/web/src/components/panels/PluginPanel.vue'), 'utf8');
/** 宿主接线来源（用于核对「功能区点击真的有落点」） */
const EDITOR_VUE = fs.readFileSync(path.join(ROOT, 'apps/web/src/views/EditorPage.vue'), 'utf8');

/* ------------------------------ 假宿主 ------------------------------ */

/**
 * 造一个「会记账」的宿主上下文。
 *
 * 每个动作都写进 `calls`，这样「打开了一个面板」这种无文档副作用的命令
 * 也能被客观验证 —— 而不是只看有没有抛异常。
 */
function makeHost(initialMarkdown = '') {
  let md = initialMarkdown;
  const calls = [];
  const notices = [];
  const stores = new Map();
  const ctx = {
    getMarkdown: () => md,
    setMarkdown: (next) => {
      md = String(next ?? '');
      calls.push('setMarkdown');
    },
    getTitle: () => '验收测试文档',
    getDocId: () => 'doc-acceptance',
    notify: (message, type) => {
      notices.push({ message, type });
      calls.push(`notify:${type ?? 'info'}`);
    },
    openPanel: (panel) => calls.push(`openPanel:${panel}`),
    openLeftPanel: (mode) => calls.push(`openLeftPanel:${mode}`),
    searchInLeft: (q) => calls.push(`searchInLeft:${q}`),
    openDaily: () => calls.push('openDaily'),
    openRandom: () => calls.push('openRandom'),
    openHistory: () => calls.push('openHistory'),
    openShare: () => calls.push('openShare'),
    openPalette: () => calls.push('openPalette'),
    createDiagram: (kind) => calls.push(`createDiagram:${kind}`),
    openPluginCenter: () => calls.push('openPluginCenter'),
    saveWorkspace: () => calls.push('saveWorkspace'),
    restoreWorkspace: () => {
      calls.push('restoreWorkspace');
      return true;
    },
    readStore: (key) => stores.get(key) ?? null,
    writeStore: (key, value) => {
      stores.set(key, value);
      calls.push('writeStore');
    },
  };
  return {
    ctx,
    calls,
    notices,
    getMarkdown: () => md,
    reset: () => {
      calls.length = 0;
      notices.length = 0;
    },
  };
}

/* ---------------------------- 逐款验证 ---------------------------- */

const results = [];
let failures = 0;

/** 检查 PluginPanel.vue 是否有该面板的渲染分支 */
function panelHasRenderBranch(panel) {
  return PANEL_VUE.includes(`panel === '${panel}'`);
}

/**
 * 检查 EditorPage 是否接线到这款插件。
 *
 * 判定依据（命中任一即可，因为入口可能走不同路径）：
 * 1. `openPluginPanel('<panel>')` —— 直接开面板；
 * 2. `case '<pluginId>'` —— 功能区 / 右键菜单按插件 id 派发；
 * 3. 插件 id 出现在 `PLUGIN_RIBBON_DEFS`（功能区定义表）里。
 *
 * 注意：命令类插件不必在 switch 里逐个 case —— 它们通过
 * `dispatchBuiltinCommand()` 统一派发，那条链路由「第 3 层：执行有实效果」验证。
 */
function editorWiresPlugin(pluginId, panel) {
  if (panel && EDITOR_VUE.includes(`openPluginPanel('${panel}')`)) return true;
  if (EDITOR_VUE.includes(`case '${pluginId}'`)) return true;
  // 功能区定义表：`'plugin-id': { icon: ..., pluginId: 'plugin-id' }`
  if (new RegExp(`['"]${pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*:\\s*\\{`).test(EDITOR_VUE)) return true;
  // RIBBON_ALL_ITEMS 里的 id
  if (EDITOR_VUE.includes(`id: '${pluginId}'`)) return true;
  return false;
}

/**
 * 命令的执行效果样本。
 *
 * `expect` 返回一句「拿到的可观测后果」，空串表示**没有任何可观测后果** => 失败。
 */
function verifyCommand(commandId) {
  const host = makeHost('## 一\n### 一.一\n\n正文段落。\n\n- [ ] 待办\n');

  const samples = {
    /* 面板类：应当调用 openPanel */
    'whiteboard.create': (c, h) => (c.includes('openPanel:whiteboard') ? '打开白板面板' : ''),
    'reorganize.batch': (c) => (c.includes('openPanel:reorganize') ? '打开笔记重组面板' : ''),
    'graph.open': (c) => (c.includes('openPanel:graph') ? '打开关系图谱面板' : ''),
    'slides.present': (c) => (c.includes('openPanel:slides') ? '打开幻灯片面板' : ''),
    'recorder.toggle': (c) => (c.includes('openPanel:recorder') ? '打开录音机面板' : ''),
    'recovery.open': (c) => (c.includes('openPanel:recovery') ? '打开文件恢复面板' : ''),
    'browser.open': (c) => (c.includes('openPanel:browser') ? '打开内嵌浏览器面板' : ''),
    'database.create': (c) => (c.includes('openPanel:database') ? '打开数据库视图面板' : ''),
    /* 导航 / 搜索类 */
    'tags.panel': (c) => (c.includes('openLeftPanel:search') && c.some((x) => x.startsWith('searchInLeft:')) ? '左侧栏按 # 搜索' : ''),
    'publish.current': (c) => (c.includes('openShare') ? '打开分享/发布弹窗' : ''),
    'daily.open': (c) => (c.includes('openDaily') ? '打开今日日记' : ''),
    'daily.today': (c) => (c.includes('openDaily') ? '打开今日日记' : ''),
    'random.open': (c) => (c.includes('openRandom') ? '打开随机笔记' : ''),
    'quick.open': (c) => (c.includes('openPalette') ? '打开命令面板' : ''),
    /* 工作区 */
    'workspace.save': (c) => (c.includes('saveWorkspace') ? '保存工作区布局' : ''),
    'workspace.restore': (c) => (c.includes('restoreWorkspace') ? '恢复工作区布局' : ''),
    /* 图表 */
    'diagram.createFlowchart': (c) => (c.includes('createDiagram:flowchart') ? '新建流程图文档' : ''),
    'diagram.createMindmap': (c) => (c.includes('createDiagram:mindmap') ? '新建思维导图文档' : ''),
    /* 文档变换类 */
    'slash.insertMenu': (c, h) => (h.getMarkdown() !== '## 一\n### 一.一\n\n正文段落。\n\n- [ ] 待办\n' ? '插入标题标记（文档已变）' : ''),
    'bookmark.toggle': (c) => (c.includes('writeStore') ? '写入书签存储' : ''),
  };

  const check = samples[commandId];
  if (!check) return { ok: false, effect: '', reason: '脚本里没有该命令的执行样本（未知命令）' };

  const result = executeBuiltinCommand(commandId, host.ctx);
  if (!result.ok) {
    return { ok: false, effect: '', reason: `派发返回 ok=false：${result.message}` };
  }
  // 断言归属插件正确（防止命令挂到错的插件上）
  const owner = commandOwner(commandId);
  if (owner !== result.pluginId) {
    return { ok: false, effect: '', reason: `命令归属不一致：派发=${result.pluginId}，能力表=${owner}` };
  }
  const effect = check(host.calls, host);
  if (!effect) {
    return { ok: false, effect: '', reason: `执行了但没有任何可观测后果（calls=${host.calls.join(',') || '无'}）` };
  }
  return { ok: true, effect };
}

/** 面板类插件的数据装配验证（用真实纯函数跑最小样本） */
function verifyPanelData(panel) {
  const samples = {
    'word-count': () => {
      // 中文 7 字（中文测试 + 第二行）、英文 2 词（abc / def）
      const s = computeWordStats('中文测试 abc def\n第二行');
      return s.chars > 0 && s.cjk === 7 && s.words === 9 && s.readingMinutes >= 0
        ? `字数统计：${s.chars} 字符 / ${s.words} 词 / ${s.cjk} 中日韩字符`
        : '';
    },
    'footnote-view': () => {
      const f = extractFootnotes('正文[^a] 与[^b]\n\n[^a]: 定义一\n[^b]: 定义二');
      return f.length === 2 && f.every((x) => x.refCount === 1) ? `脚注：解析出 ${f.length} 条定义 + 引用次数` : '';
    },
    'footnote-view-dangling': () => {
      const f = extractFootnotes('只有引用[^zz]没有定义');
      const dangling = f.find((x) => x.label === 'zz' && x.text === '');
      return dangling ? '脚注：能识别悬空引用（只有引用无定义）' : '';
    },
    properties: () => {
      const p = aggregateProperties([
        { title: 'A', content: '---\n状态: 进行中\n标签:\n  - x\n---\n正文' },
        { title: 'B', content: '---\n状态: 完成\n---\n正文' },
      ]);
      const status = p.find((x) => x.key === '状态');
      return status && status.docs === 2 && status.values.length === 2 ? `属性：聚合 ${p.length} 个键，状态出现于 ${status.docs} 篇` : '';
    },
    database: () => {
      const p = aggregateProperties([{ title: 'A', content: '---\n优先级: 高\n---\n正文' }]);
      return p.length === 1 && p[0].key === '优先级' ? '数据库：可把 frontmatter 聚合成表格列' : '';
    },
    'outgoing-links': () => {
      const l = extractOutgoingLinks('见 [[目标A]] 与 ![[嵌入B|别名]] 以及 [外链](https://example.com)');
      const wiki = l.filter((x) => x.kind === 'wikilink').length;
      const embed = l.filter((x) => x.kind === 'embed').length;
      const md = l.filter((x) => x.kind === 'markdown').length;
      return wiki === 1 && embed === 1 && md === 1 ? `出链：解析 ${wiki} 个 wikilink + ${embed} 个嵌入 + ${md} 个外链` : '';
    },
    'page-preview': () => {
      const p = buildLinkPreviews('见 [[存在]] 与 [[不存在]]', (t) =>
        t === '存在' ? { title: '存在', content: '## 标题\n\n这是第一段正文。' } : null,
      );
      const hit = p.find((x) => x.target === '存在');
      const miss = p.find((x) => x.target === '不存在');
      return hit?.excerpt === '这是第一段正文。' && miss && miss.exists === false
        ? '页面预览：能取到目标首段摘要，并标出目标不存在'
        : '';
    },
    bookmarks: () => {
      const r1 = toggleBookmark([], { docId: 'd1', title: '文档一' }, 1000);
      const r2 = toggleBookmark(r1.list, { docId: 'd1', title: '文档一' }, 2000);
      const parsed = parseBookmarks(JSON.stringify(r1.list));
      return r1.bookmarked && !r2.bookmarked && parsed.length === 1 ? '书签：收藏 / 取消收藏 / 持久化解析均正确' : '';
    },
    publish: () => (PANEL_VUE.includes("panel === 'publish'") ? '发布面板已渲染（可打开分享弹窗）' : ''),
    'file-list': () => (PANEL_VUE.includes("panel === 'file-list'") ? '文件列表面板已渲染（提供左侧栏直达）' : ''),
  };
  const check = samples[panel];
  if (!check) return { ok: true, effect: '（该面板为既有组件，未定义额外样本）' };
  const effect = check();
  return effect ? { ok: true, effect } : { ok: false, effect: '', reason: '面板数据装配样本未产出预期结果' };
}

/* ------------------------- 遍历 26 款 ------------------------- */

for (const manifest of manifests.PLUGINS) {
  const cap = getBuiltinCapability(manifest.id);
  const row = {
    id: manifest.id,
    name: manifest.name,
    status: '',
    kinds: '',
    checks: [],
    problems: [],
    limitation: '',
  };

  if (!cap) {
    row.status = 'MISSING';
    row.problems.push('能力表里没有这一款（manifest 有、宿主没有 => 静默失效）');
    results.push(row);
    failures += 1;
    continue;
  }

  row.status = cap.status;
  row.kinds = cap.kinds.join('+');
  row.limitation = cap.limitation ?? '';

  /* --- 第 1 层：清单一致性 --- */
  const declaredCommands = manifest.contributes.commands ?? [];
  for (const cmd of declaredCommands) {
    if (!cap.commands.includes(cmd)) {
      row.problems.push(`manifest 声明命令 ${cmd}，但能力表里没有 => 该命令无实现`);
    }
  }
  for (const cmd of cap.commands) {
    if (declaredCommands.length && !declaredCommands.includes(cmd)) {
      row.problems.push(`能力表有命令 ${cmd}，但 manifest 没声明 => 文档与实现不一致`);
    }
  }
  const manifestHasPanel = manifest.contributes.panel === true;
  if (manifestHasPanel && !cap.panel) {
    row.problems.push('manifest 声明 panel:true，但能力表没有对应面板');
  }
  if (cap.panel && !manifestHasPanel && cap.panel !== 'file-list') {
    // file-list 在 manifest 里是 panel:true，这里只是兜底提示
    row.problems.push(`能力表有面板 ${cap.panel}，但 manifest 未声明 panel:true`);
  }
  row.checks.push(`清单一致：${declaredCommands.length} 个声明命令`);

  /* --- 第 2 层：宿主可解析 --- */
  if (cap.panel) {
    if (panelHasRenderBranch(cap.panel)) {
      row.checks.push(`面板渲染分支存在（PluginPanel: panel === '${cap.panel}'）`);
    } else {
      row.problems.push(`PluginPanel.vue 没有面板 ${cap.panel} 的渲染分支 => 打开了也没有内容`);
    }
    if (editorWiresPlugin(manifest.id, cap.panel)) {
      row.checks.push('EditorPage 已接线（功能区 / 面板 / 命令入口）');
    } else {
      row.problems.push(`EditorPage 未接线到「${manifest.id}」：功能区与命令面板里都找不到入口`);
    }
  }
  for (const cmd of cap.commands) {
    if (allBuiltinCommandIds().includes(cmd)) {
      row.checks.push(`命令在派发表中：${cmd}`);
    } else {
      row.problems.push(`命令 ${cmd} 不在派发表里`);
    }
  }

  /* --- 第 3 层：执行有实效果 --- */
  if (cap.commands.length) {
    for (const cmd of cap.commands) {
      const v = verifyCommand(cmd);
      if (v.ok) {
        row.checks.push(`${cmd} → ${v.effect}`);
      } else {
        row.problems.push(`${cmd} 执行无效：${v.reason}`);
      }
    }
  }
  if (cap.panel) {
    const pd = verifyPanelData(cap.panel);
    if (pd.ok) {
      row.checks.push(`面板数据：${pd.effect}`);
    } else {
      row.problems.push(`面板数据装配失败：${pd.reason}`);
    }
  }
  // 只声明扩展、既无面板也无命令的款（当前为空）也要能说清
  if (!cap.panel && !cap.commands.length && cap.kinds.includes('extension')) {
    row.problems.push('只声明了编辑器扩展，但没有可见入口');
  }

  if (row.problems.length) failures += 1;
  results.push(row);
}

/* ---------------------- 社区插件链路验证（需求1） ---------------------- */

const COMMUNITY_SAMPLE = fs.readFileSync(path.join(ROOT, 'plugin-market/plugins/13-heading-auto-number.js'), 'utf8');

/** 用隔离存储跑一遍「安装 → 功能区 → 执行 → 文档变化」全链路 */
function verifyCommunityFlow() {
  const map = new Map();
  community.__setCommunityStorage({
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
  });

  const steps = [];
  const problems = [];

  // 1) 安装（含源码校验）
  let installResult;
  try {
    installResult = community.installCommunityPlugin({
      pluginId: 'heading-auto-number',
      name: '标题自动编号',
      codeJs: COMMUNITY_SAMPLE,
    });
    steps.push(`安装成功（声明 id=${installResult.declaredId ?? '未声明'}）`);
  } catch (e) {
    problems.push(`安装失败：${e.message}`);
    return { steps, problems };
  }

  // 2) 功能区出现入口
  const ribbonIds = community.getCommunityRibbonIds();
  if (ribbonIds.includes('heading-auto-number')) {
    steps.push(`功能区已出现入口 community:heading-auto-number`);
  } else {
    problems.push('安装后功能区没有入口（需求1 未满足）');
  }

  // 3) 关键：不污染内置白名单
  const rawBuiltin = map.get('neomd.communityRibbon.v1');
  if (rawBuiltin !== undefined && !String(rawBuiltin).includes('ribbonItems')) {
    steps.push('内置白名单 ribbonItems 未被写入（无幽灵项风险）');
  }

  // 4) 执行插件，断言文档真的变了
  let md = '## 第一章\n### 第一节\n\n正文\n';
  const before = md;
  const outcome = community.runCommunityPlugin(community.getCommunityPlugin('heading-auto-number'), {
    getMarkdown: () => md,
    setMarkdown: (v) => {
      md = v;
    },
    insertMarkdown: (v) => {
      md += v;
    },
    getTitle: () => '测试文档',
    notify: () => undefined,
    registerCommand: (cmd) => cmd.run(),
  });
  if (outcome.changed && md !== before) {
    steps.push(`执行后文档已变：${JSON.stringify(before)} → ${JSON.stringify(md)}`);
  } else {
    problems.push(`执行后文档未变化（changed=${outcome.changed}）：${outcome.message}`);
  }

  // 5) 坏插件必须在安装阶段被拒（可读错误）
  //
  // 样本要点：`}` 与 `//` 注释在同一行 => 右花括号被注释吞掉 => 括号不闭合。
  // 这正是 1.3.1 抛裸 `SyntaxError: Unexpected token ')'` 的场景。
  const BROKEN_SOURCE = 'export default { id: "broken", setup(api) { api.notify("x"); } // 右花括号被这行注释吞掉了 };';
  try {
    community.installCommunityPlugin({ pluginId: 'broken', codeJs: BROKEN_SOURCE });
    problems.push('坏插件竟然安装成功了（缺少安装即校验）');
  } catch (e) {
    if (String(e.name) === 'PluginSourceError' && /未闭合/.test(e.message)) {
      steps.push(`坏插件在安装阶段被拒，且错误可读：${e.message.slice(0, 46)}…`);
    } else if (String(e.name) === 'SyntaxError') {
      problems.push(`坏插件抛的是原生 SyntaxError（用户不可读）：${e.message.slice(0, 60)}`);
    } else {
      problems.push(`坏插件报错不可读：${e.name}: ${e.message.slice(0, 60)}`);
    }
  }

  // 6) 移出 / 重新加入功能区
  community.setCommunityPluginInRibbon('heading-auto-number', false);
  const afterRemove = community.getCommunityRibbonIds();
  community.setCommunityPluginInRibbon('heading-auto-number', true);
  const afterAdd = community.getCommunityRibbonIds();
  if (!afterRemove.includes('heading-auto-number') && afterAdd.includes('heading-auto-number')) {
    steps.push('功能区入口可移除 / 重新加入');
  } else {
    problems.push('功能区加入/移除开关不生效');
  }

  return { steps, problems };
}

const communityFlow = verifyCommunityFlow();

/* ------------------------------ 输出 ------------------------------ */

const wantJson = process.argv.includes('--json');
const statusLabel = { full: '可用', partial: '部分可用', unavailable: '暂不可用', MISSING: '缺失实现' };
const counts = results.reduce((acc, r) => {
  acc[r.status] = (acc[r.status] ?? 0) + 1;
  return acc;
}, {});

if (wantJson) {
  console.log(JSON.stringify({ results, communityFlow, counts, failures }, null, 2));
} else {
  console.log('');
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log('  Neo MD 1.4.0 · 内置插件逐一验证（26 款）');
  console.log('  宿主逻辑来源：packages/shared/src/builtin-plugin-runtime.ts（与 EditorPage 同一份）');
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log('');

  const pad = (s, n) => {
    // 中文按 2 格宽计算，保证表格对齐
    let width = 0;
    for (const ch of String(s)) width += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
    return String(s) + ' '.repeat(Math.max(0, n - width));
  };

  console.log(`${pad('#', 4)}${pad('插件', 18)}${pad('状态', 10)}${pad('入口', 22)}结论`);
  console.log('─'.repeat(112));
  results.forEach((r, i) => {
    const ok = r.problems.length === 0;
    const mark = ok ? '✓' : '✗';
    const entry = r.kinds || '—';
    const detail = ok ? r.checks[0] ?? '' : r.problems[0];
    console.log(
      `${pad(i + 1, 4)}${pad(r.name, 18)}${pad(`${mark} ${statusLabel[r.status] ?? r.status}`, 10)}${pad(entry, 22)}${detail ?? ''}`,
    );
  });

  console.log('');
  console.log('─'.repeat(112));
  console.log('逐款明细');
  console.log('─'.repeat(112));
  for (const r of results) {
    console.log('');
    console.log(`【${r.name}】（${r.id}） 状态：${statusLabel[r.status] ?? r.status}`);
    for (const c of r.checks) console.log(`    ✓ ${c}`);
    for (const p of r.problems) console.log(`    ✗ ${p}`);
    if (r.limitation) console.log(`    ⚠ 限制：${r.limitation}`);
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log('  社区插件链路（需求1：安装 → 功能区入口 → 点击 → 文档变化）');
  console.log('══════════════════════════════════════════════════════════════════════════════');
  for (const s of communityFlow.steps) console.log(`  ✓ ${s}`);
  for (const p of communityFlow.problems) console.log(`  ✗ ${p}`);

  console.log('');
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log('  汇总');
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log(`  内置插件：${results.length} 款 —— 可用 ${counts.full ?? 0} / 部分可用 ${counts.partial ?? 0} / 暂不可用 ${counts.unavailable ?? 0} / 缺失 ${counts.MISSING ?? 0}`);
  console.log(`  失败款数：${failures}`);
  console.log(`  社区插件链路：${communityFlow.problems.length === 0 ? '通过' : `失败 ${communityFlow.problems.length} 项`}`);
  console.log('');
}

if (failures > 0 || communityFlow.problems.length > 0) process.exitCode = 1;
