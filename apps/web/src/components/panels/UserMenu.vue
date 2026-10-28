<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { NmIcon } from '@neomd/ui';
import { formatCompactNumber } from '@neomd/shared';
import { detectRuntime, getBridge } from '@neomd/core';
import { useAuthStore } from '@/stores/auth';
import { useAppStore } from '@/stores/app';
import { useSettingsStore } from '@/stores/settings';
import { SITE_URL } from '@/env';

const props = defineProps<{ align?: 'left' | 'right' }>();
const emit = defineEmits<{ openSettings: [string?]; openAi: []; openStorage: []; openAdmin: [] }>();

const router = useRouter();
const auth = useAuthStore();
const app = useAppStore();
const settingsStore = useSettingsStore();
const runtime = detectRuntime();
const open = ref(false);
const loginOpen = ref(false);
const account = ref('');
const password = ref('');
const loginError = ref('');
const busy = ref(false);

const initial = computed(() => (auth.user?.nickname || auth.user?.username || '?').slice(0, 1).toUpperCase());
const avatar = computed(() => auth.user?.avatarUrl ?? '');

/** 数据私有化开关（仅桌面端可开启）：开启后不连服务器，登录入口需禁用 */
const privacyMode = computed(() => settingsStore.privacyMode);

function toggle(): void {
  if (privacyMode.value) {
    // 私有化模式下不提供登录：账号体系依赖服务端，直接给出说明而不是弹登录框
    app.notify('已开启数据私有化模式，登录与账号同步不可用', 'info');
    return;
  }
  if (!auth.isLoggedIn) {
    loginError.value = '';
    loginOpen.value = true;
    return;
  }
  open.value = !open.value;
}

async function doLogin(): Promise<void> {
  busy.value = true;
  loginError.value = '';
  const ok = await auth.login(account.value.trim(), password.value);
  busy.value = false;
  if (!ok) {
    loginError.value = auth.error || '登录失败';
    return;
  }
  loginOpen.value = false;
  account.value = '';
  password.value = '';
  await settingsStore.pullCloudSettings();
  await app.loadCredits();
}

async function logout(): Promise<void> {
  open.value = false;
  await auth.logout();
  app.credits = null;
  app.notify('已退出登录，本地功能继续可用', 'info');
}

/**
 * 打开应用设置（1.1.7）。
 *
 * 用户要求把「设置」从功能区移到用户菜单，因此这里关掉菜单并向上抛 `openSettings`，
 * 由 `EditorPage` 打开设置标签页。不在这里直接路由跳转：桌面端设置是应用内标签页，
 * 不是独立页面。
 */
function openSettingsFromMenu(): void {
  open.value = false;
  emit('openSettings');
}

function go(path: string): void {
  open.value = false;  if (runtime.platform === 'desktop' && path.startsWith('/account')) {
    const url = `${SITE_URL.replace(/\/+$/, '')}${path}`;
    const bridge = getBridge();
    if (bridge?.shell?.openExternal) {
      void bridge.shell.openExternal(url);
      return;
    }
    window.open(url, '_blank', 'noopener');
    return;
  }
  void router.push(path);
}

function goAccountSection(tab: 'profile' | 'ai' | 'storage' | 'plugins'): void {
  open.value = false;
  if (runtime.platform === 'web') {
    void router.push(`/account?tab=${tab}`);
    return;
  }
  if (tab === 'profile') {
    go('/account?tab=profile');
    return;
  }
  if (tab === 'ai') emit('openAi');
  else if (tab === 'storage') emit('openStorage');
}

function onDocClick(e: MouseEvent): void {
  if (!(e.target as HTMLElement).closest('.usermenu')) open.value = false;
}

onMounted(() => document.addEventListener('click', onDocClick));
onBeforeUnmount(() => document.removeEventListener('click', onDocClick));
</script>

<template>
  <div class="usermenu">
    <!-- 数据私有化模式徽标：替代登录入口，明确告知不连服务器 -->
    <span
      v-if="privacyMode"
      class="privbadge"
      title="数据私有化模式已开启：编辑器不连接服务器，仅使用本地文件夹与对象存储同步"
    >
      <NmIcon name="shield" :size="13" />
      <span>私有化模式</span>
    </span>

    <button v-else-if="!auth.isLoggedIn" class="loginbtn" title="登录后可在多设备同步" @click="toggle">
      <NmIcon name="user" :size="13" />
      <span>登录</span>
    </button>

    <button v-else class="avatar" :title="auth.user?.username" @click="toggle">
      <img v-if="avatar" :src="avatar" alt="avatar" />
      <span v-else>{{ initial }}</span>
    </button>

    <div v-if="open && auth.isLoggedIn && !privacyMode" class="menu" :class="{ 'menu--left': props.align === 'left' }">
      <div class="menu__head">
        <div class="menu__avatar">
          <img v-if="avatar" :src="avatar" alt="avatar" />
          <span v-else>{{ initial }}</span>
        </div>
        <div class="menu__id">
          <strong>{{ auth.user?.nickname || auth.user?.username }}</strong>
          <span>{{ auth.user?.email }}</span>
        </div>
      </div>
      <div class="menu__credits">
        <NmIcon name="zap" :size="13" />
        <span>积分</span>
        <strong>{{ app.credits !== null ? formatCompactNumber(app.credits) : '—' }}</strong>
        <button class="menu__topup" @click="go('/account?tab=credits')">充值</button>
      </div>
      <div class="menu__sep" />
      <!--
        「设置」入口（1.1.7 需求）。
        用户要求：设置按钮从功能区移到用户菜单，点击头像后弹出即可进入。
        原先这里只有「个人中心 / AI 服务设置 / 对象存储设置」等分散入口，
        没有统一的应用设置入口，与需求不符，故补上该项并置于最前（最常用）。
        `openSettings` 事件早已在 emits 中声明，父组件也已接住，只是模板漏了按钮。
      -->
      <button class="menu__item" @click="openSettingsFromMenu()">
        <NmIcon name="settings" :size="14" /><span>设置</span>
      </button>
      <button class="menu__item" @click="goAccountSection('profile')">
        <NmIcon name="user" :size="14" /><span>个人中心（资料与改密）</span>
      </button>
      <button class="menu__item" @click="goAccountSection('ai')">
        <NmIcon name="sparkles" :size="14" /><span>AI 服务设置</span>
      </button>
      <button class="menu__item" @click="goAccountSection('storage')">
        <NmIcon name="cloud" :size="14" /><span>对象存储设置</span>
      </button>
      <button class="menu__item" @click="go('/account?tab=plugins')">
        <NmIcon name="layers" :size="14" /><span>插件开放平台</span>
      </button>
      <button class="menu__item" @click="go('/account?tab=shares')">
        <NmIcon name="share" :size="14" /><span>分享与备份记录</span>
      </button>
      <button v-if="auth.isAdmin" class="menu__item" @click="go('/admin')">
        <NmIcon name="shield" :size="14" /><span>管理后台</span>
      </button>
      <div class="menu__sep" />
      <button class="menu__item menu__item--danger" @click="logout">
        <NmIcon name="logout" :size="14" /><span>退出登录</span>
      </button>
    </div>
  </div>

  <Teleport to="body">
    <div v-if="loginOpen" class="loginmask" @mousedown.self="loginOpen = false">
      <div class="loginbox">
        <header class="loginbox__head">
          <h3>登录 Neo MD</h3>
          <button class="loginbox__close" @click="loginOpen = false"><NmIcon name="close" :size="15" /></button>
        </header>
        <div class="loginbox__body">
          <label class="nm-label" for="um-account">邮箱或用户名</label>
          <input id="um-account" v-model="account" class="nm-input" autocomplete="username" @keyup.enter="doLogin" />
          <label class="nm-label mt" for="um-pass">密码</label>
          <input id="um-pass" v-model="password" class="nm-input" type="password" autocomplete="current-password" @keyup.enter="doLogin" />
          <p v-if="loginError" class="loginbox__error">{{ loginError }}</p>
          <p class="nm-hint">不登录也可以正常写作；登录后设置、积分与分享会跟随账号。</p>
        </div>
        <footer class="loginbox__foot">
          <button class="nm-btn" @click="loginOpen = false">取消</button>
          <button class="nm-btn nm-btn--primary" :disabled="busy" @click="doLogin">
            {{ busy ? '登录中…' : '登录' }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.usermenu {
  position: relative;
}
.loginbtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 9px;
  border-radius: 5px;
  font-size: 11px;
  color: var(--accent);
  background: var(--accent-weak);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
}
.loginbtn:hover {
  background: var(--accent);
  color: #fff;
}
/* 数据私有化模式徽标（替代登录入口） */
.privbadge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 9px;
  border-radius: 5px;
  font-size: 11px;
  white-space: nowrap;
  color: #0e9f6e;
  background: rgba(14, 159, 110, 0.1);
  border: 1px solid rgba(14, 159, 110, 0.32);
  cursor: default;
  user-select: none;
}
.avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  overflow: hidden;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #1677ff, #4a9bff);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  padding: 0;
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 900;
  min-width: 240px;
  padding: 6px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-3);
}
.menu--left {
  right: auto;
  left: 0;
}
.menu__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px 10px;
}
.menu__avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  overflow: hidden;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #1677ff, #4a9bff);
  color: #fff;
  font-size: 15px;
  font-weight: 700;
  flex: 0 0 auto;
}
.menu__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.menu__id {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.menu__id strong {
  font-size: 13px;
}
.menu__id span {
  font-size: 11px;
  color: var(--fg-3);
  overflow: hidden;
  text-overflow: ellipsis;
}
.menu__credits {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 6px 6px;
  padding: 7px 9px;
  border-radius: 8px;
  background: var(--accent-weak-2);
  font-size: 11.5px;
  color: var(--fg-2);
}
.menu__credits strong {
  color: var(--accent);
  font-size: 13px;
}
.menu__topup {
  margin-left: auto;
  font-size: 11px;
  color: var(--accent);
  padding: 2px 8px;
  border-radius: 9px;
  border: 1px solid var(--accent);
}
.menu__item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 7px;
  font-size: 12.5px;
  color: var(--fg);
  text-align: left;
}
.menu__item:hover {
  background: var(--bg-hover);
}
.menu__item--danger {
  color: #d93025;
}
.menu__sep {
  height: 1px;
  background: var(--border);
  margin: 5px 4px;
}
.loginmask {
  position: fixed;
  inset: 0;
  z-index: 8800;
  display: grid;
  place-items: center;
  background: rgba(15, 23, 42, 0.42);
  backdrop-filter: blur(5px);
  padding: 20px;
}
.loginbox {
  width: min(400px, 100%);
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-3);
  overflow: hidden;
}
.loginbox__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px 8px;
}
.loginbox__head h3 {
  margin: 0;
  font-size: 15px;
}
.loginbox__close {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--fg-2);
}
.loginbox__body {
  padding: 0 18px 10px;
}
.mt {
  margin-top: 12px;
}
.loginbox__error {
  margin: 10px 0 0;
  font-size: 12px;
  color: #d93025;
}
.loginbox__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px 16px;
  border-top: 1px solid var(--border);
}
</style>
