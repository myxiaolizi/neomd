import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { detectRuntime } from '@neomd/core';
import App from './App.vue';
import '../../../packages/ui/src/styles/index.css';
import '../../../packages/ui/src/styles/content.css';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('./views/MarketingHome.vue'),
    meta: { public: true, title: 'Neo MD - 企业级本地优先 Markdown 知识协同平台' },
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('./views/LoginPage.vue'),
    meta: { public: true, title: 'Neo MD-登录与注册' },
  },
  {
    path: '/app',
    name: 'editor',
    component: () => import('./views/EditorPage.vue'),
    meta: { title: 'Neo MD-工作台' },
  },
  {
    path: '/account',
    name: 'account',
    component: () => import('./views/AccountPage.vue'),
    meta: { title: 'Neo MD-个人中心' },
  },
  {
    path: '/admin',
    name: 'admin',
    component: () => import('./views/AdminPage.vue'),
    meta: { requiresAdmin: true, title: 'Neo MD-管理后台' },
  },
  {
    path: '/s/:token',
    name: 'share',
    component: () => import('./views/SharePage.vue'),
    meta: { public: true, title: '文档分享' },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

// 进入需要管理员权限的页面前先恢复会话；本机端（Desktop/Android）直接进入编辑器，不展示营销首页
router.beforeEach(async (to) => {
  const rt = detectRuntime();
  if (rt.native && (to.path === '/' || to.path === '/index.html')) {
    return { path: '/app' };
  }
  if (!to.meta.requiresAdmin) return true;
  const { useAuthStore } = await import('./stores/auth');
  const auth = useAuthStore();
  await auth.restore();
  if (!auth.isAdmin) {
    return { path: '/login', query: { redirect: to.fullPath } };
  }
  return true;
});

router.afterEach((to) => {
  if (typeof document !== 'undefined' && typeof to.meta.title === 'string') {
    document.title = to.meta.title;
  }
});

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');

/*
 * 标题栏拖拽回退（2.1.0）。
 *
 * Electron 会把 CSS 的 `-webkit-app-region: drag` 翻译成窗口拖动，
 * 但另外四个桌面壳用的都是普通浏览器控件，不认识这个属性 ——
 * 表现为「标题栏看得见、能点，就是按住拖不动窗口」。
 * 这里给这些壳挂一个捕获阶段的 mousedown 监听，改走原生 `win.startDrag()`。
 *
 * 必须在 mount 之后安装：此时 document 已就绪，且不会拖慢首帧。
 */
void (async () => {
  try {
    const { installTitlebarDragFallback } = await import('./composables/useDesktopWindow');
    installTitlebarDragFallback();
  } catch {
    /* 网页端 / 动态导入失败时静默跳过，不影响主流程 */
  }
})();

export { router };
