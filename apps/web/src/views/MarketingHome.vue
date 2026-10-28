<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { NmIcon, NmModal } from '@neomd/ui';
import { useAuthStore } from '@/stores/auth';
import { APP_NAME, DOWNLOADS } from '@/env';
import { downloadApi } from '@/api/client';
import { formatBytes } from '@neomd/shared';

const router = useRouter();
const auth = useAuthStore();

const loginOpen = ref(false);
const registerOpen = ref(false);
const downloadOpen = ref(false);
const userMenuOpen = ref(false);
const account = ref('');
const password = ref('');
const email = ref('');
const username = ref('');
const formError = ref('');
const navOpen = ref(false);
const files = ref<Array<{ file: string; title: string; platform: string; size: number; url: string }>>([]);

const pillars = [
  {
    icon: 'zap',
    badge: '本地优先架构',
    title: '毫秒级响应，数据主权 100% 归己',
    desc: '笔记始终以标准明文 .md 存储于本地文件夹或您专属的对象存储桶中，索引与正文解耦，十万字长文秒开不卡顿。',
  },
  {
    icon: 'cloud',
    badge: '企业级多云同步',
    title: '六大云对象存储原生直连',
    desc: '内置阿里云 OSS、腾讯云 COS、火山引擎 TOS、百度云 BOS、京东云、金山云 KS3，采用内容寻址与三方合并，跨端零配置自动实时同步。',
  },
  {
    icon: 'sparkles',
    badge: '多模型 AI 引擎',
    title: '平台积分代付 + 七大主流模型矩阵',
    desc: '支持使用平台积分即开即用，或接入自有 DeepSeek、小米 MiMo、通义千问、智谱、混元、方舟、千帆 Key，赋能智能命名、润色与结构化排版。',
  },
  {
    icon: 'layers',
    badge: '开放插件生态',
    title: '24 款内置扩展 + 插件开发开放平台',
    desc: '内置关系图谱、白板、幻灯片、数据库等 24 个可开关插件；提供标准化 Plugin SDK 与开发指南，支持借助 AI 编写、导入、发布插件并查看下载统计。',
  },
  {
    icon: 'history',
    badge: '全生命周期留痕',
    title: '智能版本快照与跨设备溯源',
    desc: '支持按修改时长或修改字数自动生成历史快照，清晰记录每次变更对应的设备平台，支持时间线对比与一键无损回滚。',
  },
  {
    icon: 'share',
    badge: '安全外发与协同',
    title: '密码保护分享与划词批注评论',
    desc: '一键生成高颜值在线阅读页，支持访问密码保护、自定义品牌样式、访客选中任意段落划词评论，以及静态 HTML 网页发布。',
  },
];

const compareRows = [
  {
    dim: '数据主权与存储格式',
    neomd: '本地明文 .md + 自有 S3/OSS 云端双持，永不锁定',
    obsidian: '本地明文 .md，官方多端同步需付费订阅',
    notion: '私有云端数据库存储，离线与导出受限',
    typora: '仅本地单文件编辑，无内置云同步与知识库管理',
  },
  {
    dim: '跨平台实时自动同步',
    neomd: '登录同一账号自动同步设置与正文（Win / Android / Web）',
    obsidian: '需按月订阅官方 Sync 或繁琐配置第三方插件',
    notion: '纯在线同步，本地文件夹无法直接关联映射',
    typora: '依赖第三方网盘手动同步，易产生文件覆盖冲突',
  },
  {
    dim: '编辑视图与保真能力',
    neomd: '所见即所得 / 源码 / 对照 / 阅读 四模式无损往返切换',
    obsidian: '实时预览与源码切换，复杂表格编辑体验较弱',
    notion: '仅块级富文本，非原生 Markdown 往返',
    typora: '所见即所得与源码切换，无双栏实时对照模式',
  },
  {
    dim: 'AI 创作与计费灵活性',
    neomd: '支持平台积分即开即用 + 7 家大模型自带 Key + 自定义命名提示词',
    obsidian: '无官方原生 AI，依赖第三方社区插件各自配置',
    notion: '绑定官方 Notion AI 按月高价订阅，不可换国内模型',
    typora: '无内置 AI 写作与自动命名能力',
  },
  {
    dim: '插件开发与开放生态',
    neomd: '内置 24 款核心插件 + 网页端插件开放平台（支持 AI 生成代码一键导入与发布统计）',
    obsidian: '社区插件丰富，但开发需配置 TypeScript 编译脚手架',
    notion: '仅支持外部 API 集成，无法扩展编辑器内部能力',
    typora: '不支持插件扩展体系',
  },
  {
    dim: '在线分享、密码保护与划词评论',
    neomd: '原生支持一键分享、访问密码、自定义品牌页眉与段落划词评论',
    obsidian: 'Obsidian Publish 需额外高额付费且不支持访客划词批注',
    notion: '支持公开页面，但国内访问慢且无法自定义独立存储',
    typora: '仅支持导出本地静态文件，无在线分享与互动评论',
  },
];

const modes = [
  { name: '所见即所得', desc: '像写现代文档一样流畅撰写 Markdown，标题、表格、任务列表与代码块即时渲染呈现。' },
  { name: '源码模式', desc: '基于 CodeMirror 6 提供完整语法高亮、行号显示与精准控制，深受技术写作者青睐。' },
  { name: '对照模式', desc: '左栏源码、右栏实时渲染预览，双向滚动同步，长文校对与排版一目了然。' },
  { name: '阅读视图', desc: '收起编辑干扰，提供纯净书刊级排版与大纲目录导航，适合沉浸研读与演示。' },
];

const stats = [
  { value: '6 大', label: '主流云对象存储原生适配' },
  { value: '8 类', label: '平台积分 + 七大 AI 供应商' },
  { value: '24+', label: '官方核心插件 + 开放市场' },
  { value: '100%', label: '标准 Markdown 明文保真' },
];

const downloadList = computed(() =>
  DOWNLOADS.map((d) => {
    const remote = files.value.find((f) => f.file === d.file);
    return { ...d, size: remote?.size ?? 0 };
  }),
);

function sizeLabel(bytes: number): string {
  return bytes > 0 ? formatBytes(bytes) : '';
}

function openLogin(): void {
  navOpen.value = false;
  formError.value = '';
  loginOpen.value = true;
}

function openRegister(): void {
  navOpen.value = false;
  formError.value = '';
  registerOpen.value = true;
}

async function doLogin(): Promise<void> {
  formError.value = '';
  const ok = await auth.login(account.value.trim(), password.value);
  if (!ok) {
    formError.value = auth.error || '登录失败';
    return;
  }
  loginOpen.value = false;
  void router.push('/app');
}

async function doRegister(): Promise<void> {
  formError.value = '';
  if (password.value.length < 8) {
    formError.value = '密码至少 8 位';
    return;
  }
  const ok = await auth.register(email.value.trim(), username.value.trim(), password.value);
  if (!ok) {
    formError.value = auth.error || '注册失败';
    return;
  }
  registerOpen.value = false;
  void router.push('/app');
}

async function doLogout(): Promise<void> {
  userMenuOpen.value = false;
  await auth.logout();
}

function onDocClick(e: MouseEvent): void {
  if (!(e.target as HTMLElement | null)?.closest('.nav__user-wrap')) {
    userMenuOpen.value = false;
  }
}

const isLoggedIn = computed(() => auth.isLoggedIn);
const userLabel = computed(() => auth.user?.nickname || auth.user?.username || '');

onMounted(async () => {
  document.addEventListener('mousedown', onDocClick);
  await auth.restore();
  try {
    const res = await downloadApi.list();
    files.value = res.files;
  } catch {
    files.value = [];
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick);
});
</script>

<template>
  <div class="landing">
    <header class="nav">
      <div class="nav__inner">
        <a class="brand" href="/" @click.prevent="router.push('/')">
          <span class="brand__mark">N</span>
          <span class="brand__text">{{ APP_NAME }}</span>
          <span class="brand__tag">Enterprise</span>
        </a>
        <nav class="nav__links" :class="{ 'is-open': navOpen }">
          <a href="#value" @click="navOpen = false">核心价值</a>
          <a href="#compare" @click="navOpen = false">产品对比</a>
          <a href="#ecosystem" @click="navOpen = false">插件开放平台</a>
          <a href="#download" @click="navOpen = false">客户端下载</a>
          <a href="#faq" @click="navOpen = false">常见问题</a>
        </nav>
        <div class="nav__actions">
          <template v-if="isLoggedIn">
            <div class="nav__user-wrap">
              <button
                class="nav__user"
                type="button"
                title="点击打开账户菜单"
                @click="userMenuOpen = !userMenuOpen"
              >
                <span class="nav__avatar">
                  <img v-if="auth.user?.avatarUrl" :src="auth.user.avatarUrl" alt="" />
                  <template v-else>{{ userLabel.slice(0, 1).toUpperCase() }}</template>
                </span>
                <span class="nav__username">{{ userLabel }}</span>
                <NmIcon name="chevronDown" :size="12" />
              </button>
              <div v-if="userMenuOpen" class="nav__dropdown" @mousedown.stop>
                <button class="nav__drop-item" type="button" @click="userMenuOpen = false; router.push('/account')">
                  <NmIcon name="user" :size="14" />
                  <span>用户中心</span>
                </button>
                <button
                  v-if="auth.isAdmin"
                  class="nav__drop-item"
                  type="button"
                  @click="userMenuOpen = false; router.push('/admin')"
                >
                  <NmIcon name="shield" :size="14" />
                  <span>管理后台</span>
                </button>
                <div class="nav__drop-sep" />
                <button class="nav__drop-item nav__drop-item--danger" type="button" @click="doLogout">
                  <NmIcon name="logout" :size="14" />
                  <span>退出登录</span>
                </button>
              </div>
            </div>
            <button class="nm-btn nm-btn--primary" type="button" @click="router.push('/app')">进入工作台</button>
          </template>
          <template v-else>
            <button class="nm-btn nm-btn--ghost" type="button" @click="openLogin">登录</button>
            <button class="nm-btn nm-btn--primary" type="button" @click="openRegister">免费注册</button>
          </template>
          <button class="nav__burger" type="button" aria-label="菜单" @click="navOpen = !navOpen">
            <NmIcon name="menu" :size="20" />
          </button>
        </div>
      </div>
    </header>

    <main>
      <!-- 商务 Hero 区 -->
      <section class="hero">
        <div class="hero__glow" aria-hidden="true"></div>
        <div class="hero__inner">
          <span class="hero__badge">
            <NmIcon name="zap" :size="13" />
            本地优先 · 多云实时同步 · AI 驱动 · 插件开放生态
          </span>
          <h1 class="hero__title">
            新一代商务级 Markdown<br />
            <span>个人与团队知识生产力平台</span>
          </h1>
          <p class="hero__sub">
            兼顾本机明文文件夹的极致速度与云端多设备无缝协同。内置多模型 AI 助手、可配置工具栏、密码级文档分享批注，以及人人可参与的插件开放平台。
          </p>
          <div class="hero__cta">
            <button class="nm-btn nm-btn--primary nm-btn--lg" type="button" @click="router.push('/app')">
              立即进入在线工作台<NmIcon name="chevronRight" :size="16" />
            </button>
            <button class="nm-btn nm-btn--lg" type="button" @click="downloadOpen = true">
              <NmIcon name="download" :size="16" />下载 Windows / Android 客户端
            </button>
            <button class="nm-btn nm-btn--lg" type="button" @click="router.push('/account?tab=plugins')">
              <NmIcon name="layers" :size="16" />插件开放平台
            </button>
          </div>
          <p class="hero__note">注册即赠平台 AI 积分 · Windows x64 绿色版/安装版 · Android · Web 全端打通</p>

          <div class="stats">
            <div v-for="s in stats" :key="s.label" class="stat">
              <span class="stat__value">{{ s.value }}</span>
              <span class="stat__label">{{ s.label }}</span>
            </div>
          </div>

          <div class="hero__preview">
            <div class="preview__bar">
              <span class="dot dot--r"></span><span class="dot dot--o"></span><span class="dot dot--b"></span>
              <span class="preview__title">Neo MD Enterprise Workspace — 季度战略规划与架构评审.md</span>
              <span class="preview__tag">实时云同步已就绪</span>
            </div>
            <div class="preview__body">
              <aside class="preview__side">
                <div class="side__group">企业知识库</div>
                <div class="side__item is-active"><NmIcon name="file" :size="14" />季度战略规划</div>
                <div class="side__item"><NmIcon name="file" :size="14" />AI 插件开发规范</div>
                <div class="side__item"><NmIcon name="file" :size="14" />多云存储架构</div>
                <div class="side__group">知识大纲</div>
                <div class="side__item"><NmIcon name="outline" :size="14" />一、核心业务指标</div>
                <div class="side__item"><NmIcon name="outline" :size="14" />二、技术演进路线</div>
              </aside>
              <div class="preview__doc">
                <h2>2026 季度战略规划与架构评审</h2>
                <p>通过「本地文件夹映射 + 对象存储内容寻址」，实现跨终端毫秒级打开与零冲突协同。</p>
                <ul>
                  <li><strong>四视图无损编辑</strong>：所见即所得、源码、双栏对照、专注阅读一键切换</li>
                  <li><strong>AI 智能增效</strong>：选中段落即可润色、提炼摘要、生成标题与知识标签</li>
                  <li><strong>开放插件体系</strong>：支持开发者使用标准 JS 或借助 AI 快速构建并发布扩展</li>
                </ul>
                <blockquote>所有正文均以标准 Markdown 明文保存，任何时候都由您完全掌控。</blockquote>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- 核心能力矩阵 -->
      <section id="value" class="section">
        <div class="section__inner">
          <div class="section__eyebrow">CORE CAPABILITIES</div>
          <h2 class="section__title">为高要求创作者与专业团队打造的核心能力</h2>
          <p class="section__sub">从底层存储引擎、编辑体验到 AI 赋能与插件扩展，每一处细节均面向真实办公与知识沉淀场景打磨。</p>
          <div class="grid grid--3">
            <article v-for="f in pillars" :key="f.title" class="card">
              <div class="card__top">
                <span class="card__icon"><NmIcon :name="f.icon" :size="18" /></span>
                <span class="card__badge">{{ f.badge }}</span>
              </div>
              <h3 class="card__title">{{ f.title }}</h3>
              <p class="card__desc">{{ f.desc }}</p>
            </article>
          </div>
        </div>
      </section>

      <!-- 四大编辑模式 -->
      <section class="section section--alt">
        <div class="section__inner">
          <div class="section__eyebrow">EDITING EXPERIENCE</div>
          <h2 class="section__title">四种专业视图模式，随心切换不丢格式</h2>
          <p class="section__sub">自研 Markdown 双向保真桥接引擎，支持五套护眼配色与自定义主题、可折叠格式化工具栏及分屏对照。</p>
          <div class="grid grid--4">
            <article v-for="(m, i) in modes" :key="m.name" class="mode-card">
              <span class="mode-card__index">{{ String(i + 1).padStart(2, '0') }}</span>
              <h3 class="mode-card__title">{{ m.name }}</h3>
              <p class="mode-card__desc">{{ m.desc }}</p>
            </article>
          </div>
        </div>
      </section>

      <!-- 同类产品横向对比表 -->
      <section id="compare" class="section">
        <div class="section__inner">
          <div class="section__eyebrow">COMPETITIVE ADVANTAGE</div>
          <h2 class="section__title">为什么选择 Neo MD？与同类主流产品全方位对比</h2>
          <p class="section__sub">集本地编辑器的极速安全、云笔记的无缝协同与现代 AI 知识工作台于一体。</p>

          <div class="compare-wrap">
            <table class="compare-table">
              <thead>
                <tr>
                  <th>核心维度</th>
                  <th class="is-highlight">Neo MD（本产品）</th>
                  <th>Obsidian</th>
                  <th>Notion</th>
                  <th>Typora</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in compareRows" :key="row.dim">
                  <td class="compare-dim">{{ row.dim }}</td>
                  <td class="is-highlight">
                    <span class="check-badge">✓</span>
                    <strong>{{ row.neomd }}</strong>
                  </td>
                  <td>{{ row.obsidian }}</td>
                  <td>{{ row.notion }}</td>
                  <td>{{ row.typora }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <!-- 插件生态与开放平台 -->
      <section id="ecosystem" class="section section--alt">
        <div class="section__inner">
          <div class="section__eyebrow">OPEN PLUGIN PLATFORM</div>
          <h2 class="section__title">插件市场与插件开发开放平台</h2>
          <p class="section__sub">
            开发插件扩展是 Neo MD 的核心价值之一。我们提供极简的 JavaScript Plugin API 与完整开发指南，您可以自己编写或直接将指南喂给 AI 生成插件代码，一键导入运行或发布到插件市场。
          </p>
          <div class="grid grid--3">
            <article class="card">
              <span class="card__icon"><NmIcon name="sparkles" :size="18" /></span>
              <h3 class="card__title">AI 友好的插件开发规范</h3>
              <p class="card__desc">无需繁琐打包工具链，单文件 ESM 脚本即可注册命令、操作正文、调用通知与弹窗。复制开发指南给 AI 即可在 30 秒内定制专属插件。</p>
            </article>
            <article class="card">
              <span class="card__icon"><NmIcon name="upload" :size="18" /></span>
              <h3 class="card__title">本地一键导入与 PC 端运行</h3>
              <p class="card__desc">支持通过 `.js / .json` 文件或粘贴代码直接导入插件，在网页端与 Windows 客户端即时挂载到功能区与命令面板运行。</p>
            </article>
            <article class="card">
              <span class="card__icon"><NmIcon name="globe" :size="18" /></span>
              <h3 class="card__title">开发者发布、更新与数据看板</h3>
              <p class="card__desc">登录用户中心即可进入「插件开放平台」，发布原创插件、推送版本更新，并实时查看插件的累计安装量与用户点赞数据。</p>
            </article>
          </div>
          <div style="text-align: center; margin-top: 28px;">
            <button class="nm-btn nm-btn--primary nm-btn--lg" type="button" @click="router.push('/account?tab=plugins')">
              前往插件开放平台与开发指南<NmIcon name="chevronRight" :size="16" />
            </button>
          </div>
        </div>
      </section>

      <!-- 下载区 -->
      <section id="download" class="section">
        <div class="section__inner">
          <div class="section__eyebrow">MULTI-PLATFORM CLIENTS</div>
          <h2 class="section__title">全平台客户端下载</h2>
          <p class="section__sub">Windows 绿色解压版即开即用，安装版自动关联 .md 文件；大文件由对象存储高速直出。</p>
          <div class="grid grid--3 downloads">
            <article v-for="d in downloadList" :key="d.file" class="dl-card" :class="{ 'dl-card--accent': d.primary }">
              <span class="dl-card__icon"><NmIcon name="download" :size="20" /></span>
              <h3>{{ d.title }}</h3>
              <p>{{ d.desc }}</p>
              <div class="dl-card__row">
                <a class="nm-btn nm-btn--primary nm-btn--sm" :href="d.url">{{
                  d.platform === 'android' ? '下载 APK' : '立即下载'
                }}</a>
                <span v-if="d.size" class="dl-card__size">{{ sizeLabel(d.size) }}</span>
              </div>
            </article>
          </div>
        </div>
      </section>

      <section id="faq" class="section section--alt">
        <div class="section__inner">
          <h2 class="section__title">常见问题</h2>
          <div class="faq">
            <details>
              <summary>不登录能使用完整编辑功能吗？</summary>
              <p>可以。Windows 桌面端、Android 端与网页版均支持免登录使用；登录后自动开启跨设备云同步、平台积分 AI 与分享协作。</p>
            </details>
            <details>
              <summary>没有自己的 AI API Key 可以使用 AI 助手吗？</summary>
              <p>可以。在用户中心将 AI 供应商切换为「平台积分」，即可直接使用管理员配置的模型矩阵，新用户注册与每日登录均可获赠积分。</p>
            </details>
            <details>
              <summary>如何自己或借助 AI 开发一个 Neo MD 插件？</summary>
              <p>进入「用户中心 → 插件开放平台」，点击「查看插件开发指南」并复制提示词模板发给任意 AI，生成的脚本可一键导入本地运行或发布到插件市场。</p>
            </details>
            <details>
              <summary>不同电脑和网页端登录同一账号，文件和设置怎么保持一致？</summary>
              <p>系统采用全自动同步机制，无需手动点击同步按钮；联网状态下修改设置或保存文档即刻同步至云端，多端并发修改时提供智能合并或另存为新文件。</p>
            </details>
          </div>
        </div>
      </section>

      <section class="cta">
        <div class="cta__inner">
          <h2>掌控你的知识资产，开启高效 Markdown 创作体验</h2>
          <p>立即在线使用网页工作台，或下载 Windows / Android 原生客户端。</p>
          <div class="cta__row">
            <button class="nm-btn nm-btn--primary nm-btn--lg" type="button" @click="router.push('/app')">进入在线工作台</button>
            <button class="nm-btn nm-btn--lg" type="button" @click="downloadOpen = true">下载客户端</button>
          </div>
        </div>
      </section>
    </main>

    <footer class="footer">
      <div class="footer__inner">
        <div class="footer__brand">
          <span class="brand__mark brand__mark--sm">N</span><span>{{ APP_NAME }}</span>
        </div>
        <p class="footer__note">企业级本地优先 Markdown 知识协同平台 · md.zhengl.vip</p>
      </div>
    </footer>

    <NmModal v-model="loginOpen" title="登录 Neo MD" :width="420">
      <div class="form">
        <label class="nm-label" for="login-account">邮箱或用户名</label>
        <input id="login-account" v-model="account" class="nm-input" autocomplete="username" @keyup.enter="doLogin" />
        <label class="nm-label mt" for="login-password">密码</label>
        <input id="login-password" v-model="password" class="nm-input" type="password" autocomplete="current-password" @keyup.enter="doLogin" />
        <p v-if="formError" class="form__error">{{ formError }}</p>
        <p class="nm-hint">登录后，对象存储、AI 设置、仓库文档与积分会在您的所有设备间自动同步。</p>
      </div>
      <template #footer>
        <button class="nm-btn" type="button" @click="loginOpen = false">取消</button>
        <button class="nm-btn nm-btn--primary" type="button" :disabled="auth.loading" @click="doLogin">
          {{ auth.loading ? '登录中…' : '登录' }}
        </button>
      </template>
    </NmModal>

    <NmModal v-model="registerOpen" title="创建账号" :width="440">
      <div class="form">
        <label class="nm-label" for="reg-email">邮箱</label>
        <input id="reg-email" v-model="email" class="nm-input" type="email" autocomplete="email" />
        <label class="nm-label mt" for="reg-user">用户名</label>
        <input id="reg-user" v-model="username" class="nm-input" autocomplete="username" />
        <p class="nm-hint">用户名用于对象存储中的个人目录，注册后不可修改。</p>
        <label class="nm-label mt" for="reg-pass">密码</label>
        <input id="reg-pass" v-model="password" class="nm-input" type="password" autocomplete="new-password" />
        <p v-if="formError" class="form__error">{{ formError }}</p>
      </div>
      <template #footer>
        <button class="nm-btn" type="button" @click="registerOpen = false">取消</button>
        <button class="nm-btn nm-btn--primary" type="button" :disabled="auth.loading" @click="doRegister">
          {{ auth.loading ? '创建中…' : '创建账号' }}
        </button>
      </template>
    </NmModal>

    <NmModal v-model="downloadOpen" title="下载客户端" :width="520">
      <div class="dl-list">
        <a v-for="d in downloadList" :key="d.file" class="dl-item" :href="d.url">
          <NmIcon name="download" :size="18" />
          <div>
            <strong>{{ d.title }}</strong>
            <span>{{ d.desc }}</span>
          </div>
        </a>
      </div>
      <p class="nm-hint">安装包未做商业代码签名，首次运行系统若弹出提示，选择「更多信息 → 仍要运行」即可。</p>
      <p class="nm-hint">大体积安装包由对象存储预签名直链分发，高速稳定。</p>
    </NmModal>
  </div>
</template>

<style scoped>
.landing { min-height: 100%; height: 100%; overflow-y: auto; background: var(--bg); }
.nav { position: sticky; top: 0; z-index: 60; backdrop-filter: saturate(180%) blur(16px); background: color-mix(in srgb, var(--bg) 86%, transparent); border-bottom: 1px solid var(--border); }
.nav__inner { max-width: 1200px; margin: 0 auto; height: 64px; padding: 0 24px; display: flex; align-items: center; gap: 24px; }
.brand { display: flex; align-items: center; gap: 10px; color: var(--fg); font-weight: 700; font-size: 16px; letter-spacing: -0.01em; }
.brand__mark { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; background: linear-gradient(135deg, #1677ff, #4a9bff); color: #fff; font-size: 15px; font-weight: 700; box-shadow: 0 2px 8px rgba(22,119,255,.32); }
.brand__mark--sm { width: 22px; height: 22px; font-size: 12px; border-radius: 6px; }
.brand__tag { font-size: 10.5px; font-weight: 600; padding: 2px 7px; border-radius: 999px; background: var(--accent-weak); color: var(--accent); }
.nav__links { display: flex; gap: 24px; margin-left: 12px; font-size: 13.5px; font-weight: 500; }
.nav__links a { color: var(--fg-2); }
.nav__links a:hover { color: var(--accent); }
.nav__actions { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.nav__user-wrap { position: relative; }
.nav__user { display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 11px 0 5px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg-elevated); font-size: 12.5px; font-weight: 550; color: var(--fg); }
.nav__user:hover { border-color: var(--accent); color: var(--accent); }
.nav__avatar { width: 24px; height: 24px; border-radius: 50%; overflow: hidden; display: grid; place-items: center; background: linear-gradient(135deg, #1677ff, #4a9bff); color: #fff; font-size: 11px; font-weight: 700; }
.nav__avatar img { width: 100%; height: 100%; object-fit: cover; }
.nav__dropdown { position: absolute; right: 0; top: calc(100% + 6px); min-width: 156px; padding: 5px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg-elevated); box-shadow: var(--shadow-3); z-index: 120; }
.nav__drop-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border-radius: 7px; font-size: 12.5px; color: var(--fg); text-align: left; }
.nav__drop-item:hover { background: var(--bg-hover); color: var(--accent); }
.nav__drop-item--danger { color: #d93025; }
.nav__drop-item--danger:hover { background: rgba(217, 48, 37, 0.08); color: #d93025; }
.nav__drop-sep { height: 1px; background: var(--border); margin: 4px 2px; }
.nav__burger { display: none; width: 34px; height: 34px; border-radius: 8px; place-items: center; }

.hero { position: relative; padding: 76px 24px 48px; overflow: hidden; }
.hero__glow { position: absolute; inset: -20% -10% auto -10%; height: 560px; background: radial-gradient(60% 60% at 50% 0%, rgba(22,119,255,.16), transparent 72%); pointer-events: none; }
.hero__inner { position: relative; max-width: 1160px; margin: 0 auto; display: flex; flex-direction: column; align-items: center; text-align: center; }
.hero__badge { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 14px; border-radius: 999px; background: var(--accent-weak); color: var(--accent); font-size: 12px; font-weight: 600; }
.hero__title { margin: 22px 0 0; font-size: clamp(32px, 5.2vw, 54px); line-height: 1.15; letter-spacing: -0.025em; font-weight: 750; color: var(--fg); }
.hero__title span { background: linear-gradient(135deg, #1677ff, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.hero__sub { margin: 18px 0 0; max-width: 740px; font-size: 15.5px; line-height: 1.78; color: var(--fg-2); }
.hero__cta { margin-top: 28px; display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }
.nm-btn--lg { height: 44px; padding: 0 22px; font-size: 14px; border-radius: 10px; font-weight: 600; }
.hero__note { margin-top: 14px; font-size: 12.5px; color: var(--fg-3); }

.stats { margin-top: 36px; width: 100%; max-width: 960px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; padding: 20px 24px; border-radius: 14px; background: var(--bg-elevated); border: 1px solid var(--border); box-shadow: var(--shadow-1); }
.stat { text-align: center; }
.stat__value { display: block; font-size: 26px; font-weight: 750; letter-spacing: -0.02em; color: var(--accent); }
.stat__label { font-size: 12px; color: var(--fg-3); margin-top: 2px; }

.hero__preview { margin-top: 32px; width: 100%; max-width: 960px; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow-3); overflow: hidden; text-align: left; }
.preview__bar { display: flex; align-items: center; gap: 7px; height: 40px; padding: 0 16px; border-bottom: 1px solid var(--border); background: var(--bg); }
.dot { width: 10px; height: 10px; border-radius: 50%; }
.dot--r { background: #ff5f57; }
.dot--o { background: #febc2e; }
.dot--b { background: #28c840; }
.preview__title { margin-left: 10px; font-size: 12px; font-weight: 550; color: var(--fg-2); }
.preview__tag { margin-left: auto; font-size: 11px; color: #16a34a; background: rgba(22,163,74,.1); padding: 2px 8px; border-radius: 999px; }
.preview__body { display: grid; grid-template-columns: 200px 1fr; min-height: 280px; }
.preview__side { border-right: 1px solid var(--border); padding: 14px 10px; background: var(--bg-sidebar); font-size: 12.5px; }
.side__group { font-size: 11px; font-weight: 700; color: var(--fg-3); text-transform: uppercase; letter-spacing: .06em; padding: 10px 8px 6px; }
.side__item { display: flex; align-items: center; gap: 7px; padding: 6px 8px; border-radius: 6px; color: var(--fg-2); }
.side__item.is-active { background: var(--bg-active); color: var(--accent); font-weight: 600; }
.preview__doc { padding: 24px 30px; font-size: 13.5px; line-height: 1.8; }
.preview__doc h2 { margin: 0 0 10px; font-size: 19px; }
.preview__doc p { margin: 0 0 10px; color: var(--fg-2); }
.preview__doc ul { margin: 0 0 12px; padding-left: 18px; color: var(--fg-2); }
.preview__doc blockquote { margin: 0; padding: 9px 14px; border-left: 3px solid var(--accent); background: var(--accent-weak-2); border-radius: 0 6px 6px 0; color: var(--fg-2); font-size: 12.5px; }

.section { padding: 80px 24px; }
.section--alt { background: linear-gradient(180deg, transparent, var(--accent-weak-2) 40%, transparent); }
.section__inner { max-width: 1140px; margin: 0 auto; }
.section__eyebrow { text-align: center; font-size: 11.5px; font-weight: 700; letter-spacing: 0.1em; color: var(--accent); margin-bottom: 8px; }
.section__title { font-size: clamp(24px, 3.2vw, 34px); letter-spacing: -0.02em; margin: 0; text-align: center; font-weight: 700; }
.section__sub { margin: 12px auto 0; max-width: 680px; text-align: center; color: var(--fg-2); font-size: 14.5px; line-height: 1.75; }

.grid { display: grid; gap: 18px; margin-top: 40px; }
.grid--3 { grid-template-columns: repeat(3, 1fr); }
.grid--4 { grid-template-columns: repeat(4, 1fr); }
.card, .mode-card, .dl-card { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 14px; padding: 24px; transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease; }
.card:hover, .mode-card:hover, .dl-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-2); border-color: var(--border-strong); }
.card__top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.card__icon { width: 38px; height: 38px; border-radius: 10px; display: grid; place-items: center; background: var(--accent-weak); color: var(--accent); }
.card__badge { font-size: 11px; font-weight: 600; color: var(--accent); background: var(--accent-weak-2); padding: 3px 9px; border-radius: 999px; }
.card__title { margin: 16px 0 8px; font-size: 16px; font-weight: 650; }
.card__desc { margin: 0; font-size: 13px; line-height: 1.75; color: var(--fg-2); }

.mode-card__index { font-family: var(--font-mono); font-size: 12px; color: var(--accent); font-weight: 700; }
.mode-card__title { margin: 10px 0 8px; font-size: 15.5px; font-weight: 650; }
.mode-card__desc { margin: 0; font-size: 12.5px; line-height: 1.75; color: var(--fg-2); }

.compare-wrap { margin-top: 38px; overflow-x: auto; border: 1px solid var(--border); border-radius: 14px; background: var(--bg-elevated); box-shadow: var(--shadow-2); }
.compare-table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 760px; }
.compare-table th, .compare-table td { padding: 14px 16px; text-align: left; border-bottom: 1px solid var(--border); line-height: 1.6; }
.compare-table thead th { font-size: 13.5px; font-weight: 700; background: var(--bg-sidebar); color: var(--fg); }
.compare-table tbody tr:last-child td { border-bottom: none; }
.compare-dim { font-weight: 650; color: var(--fg); width: 170px; }
.compare-table .is-highlight { background: color-mix(in srgb, var(--accent) 7%, var(--bg-elevated)); color: var(--fg); }
.compare-table thead .is-highlight { background: var(--accent); color: #fff; }
.check-badge { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: var(--accent); color: #fff; font-size: 11px; font-weight: 700; margin-right: 6px; }

.dl-card__icon { width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; background: var(--sky); color: var(--accent); }
.dl-card h3 { margin: 14px 0 8px; font-size: 15.5px; }
.dl-card p { margin: 0 0 16px; font-size: 12.5px; line-height: 1.7; color: var(--fg-2); min-height: 44px; }
.dl-card__row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dl-card__size { font-size: 11.5px; color: var(--fg-3); }
.dl-card--accent { border-color: color-mix(in srgb, var(--accent) 36%, var(--border)); background: linear-gradient(180deg, var(--accent-weak-2), var(--bg-elevated)); }

.faq { margin-top: 32px; display: grid; gap: 10px; }
.faq details { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 10px; padding: 15px 18px; }
.faq summary { cursor: pointer; font-size: 14px; font-weight: 600; list-style: none; }
.faq summary::-webkit-details-marker { display: none; }
.faq summary::before { content: '+'; color: var(--accent); margin-right: 8px; font-weight: 700; }
.faq details[open] summary::before { content: '−'; }
.faq p { margin: 10px 0 0 18px; font-size: 13px; line-height: 1.75; color: var(--fg-2); }

.cta { padding: 24px; }
.cta__inner { max-width: 1140px; margin: 0 auto; padding: 56px 24px; border-radius: 18px; text-align: center; background: linear-gradient(135deg, #1677ff, #3d8bff 55%, #5aa2ff); color: #fff; box-shadow: 0 18px 48px rgba(22,119,255,.28); }
.cta__inner h2 { margin: 0; font-size: clamp(22px, 3vw, 30px); letter-spacing: -0.02em; }
.cta__inner p { margin: 12px 0 0; opacity: .92; font-size: 14.5px; }
.cta__row { margin-top: 26px; display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
.cta__row .nm-btn { background: #fff; color: var(--accent); border-color: #fff; }
.cta__row .nm-btn--primary { background: rgba(255,255,255,.16); color: #fff; border-color: rgba(255,255,255,.5); }

.footer { border-top: 1px solid var(--border); padding: 28px 24px 40px; }
.footer__inner { max-width: 1140px; margin: 0 auto; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.footer__brand { display: flex; align-items: center; gap: 8px; font-weight: 650; font-size: 13.5px; }
.footer__note { margin: 0 0 0 auto; font-size: 12px; color: var(--fg-3); }
.form .mt { margin-top: 14px; }
.form__error { margin: 12px 0 0; font-size: 12.5px; color: #d93025; }
.dl-list { display: grid; gap: 10px; }
.dl-item { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--border); color: var(--fg); }
.dl-item:hover { background: var(--bg-hover); border-color: var(--accent); }
.dl-item div { display: flex; flex-direction: column; }
.dl-item strong { font-size: 13.5px; }
.dl-item span { font-size: 12px; color: var(--fg-3); }
@media (max-width: 960px) {
  .grid--3, .grid--4 { grid-template-columns: repeat(2, 1fr); }
  .stats { grid-template-columns: repeat(2, 1fr); gap: 16px; }
}
@media (max-width: 760px) {
  .nav__links { position: absolute; top: 64px; left: 0; right: 0; flex-direction: column; gap: 0; padding: 8px 16px 16px; background: var(--bg-elevated); border-bottom: 1px solid var(--border); box-shadow: var(--shadow-2); display: none; }
  .nav__links.is-open { display: flex; }
  .nav__links a { padding: 11px 4px; font-size: 14px; }
  .nav__burger { display: grid; }
  .nav__inner { padding: 0 16px; gap: 12px; }
  .hero { padding: 44px 16px 24px; }
  .preview__body { grid-template-columns: 1fr; }
  .preview__side { display: none; }
  .grid--3, .grid--4 { grid-template-columns: 1fr; }
  .section { padding: 52px 16px; }
  .footer__note { margin-left: 0; }
}
</style>
