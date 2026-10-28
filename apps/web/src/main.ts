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

export { router };
