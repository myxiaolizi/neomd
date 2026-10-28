<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NmIcon } from '@neomd/ui';
import { useAuthStore } from '@/stores/auth';
import { APP_NAME } from '@/env';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

const mode = ref<'login' | 'register'>('login');
const account = ref('');
const password = ref('');
const email = ref('');
const username = ref('');
const localError = ref('');

const returning = computed(() => typeof route.query.redirect === 'string');

onMounted(() => {
  if (route.query.mode === 'register') mode.value = 'register';
});

async function submit(): Promise<void> {
  localError.value = '';
  if (mode.value === 'login') {
    if (!account.value.trim() || !password.value) {
      localError.value = '请填写账号与密码';
      return;
    }
    const ok = await auth.login(account.value.trim(), password.value);
    if (!ok) {
      localError.value = auth.error || '登录失败';
      return;
    }
  } else {
    if (!email.value.trim() || !username.value.trim()) {
      localError.value = '请填写邮箱与用户名';
      return;
    }
    if (password.value.length < 8) {
      localError.value = '密码至少 8 位';
      return;
    }
    const ok = await auth.register(email.value.trim(), username.value.trim(), password.value);
    if (!ok) {
      localError.value = auth.error || '注册失败';
      return;
    }
  }
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/app';
  void router.push(redirect);
}

function backHome(): void {
  void router.push('/');
}
</script>

<template>
  <div class="auth">
    <div class="auth__bg" aria-hidden="true"></div>

    <header class="auth__nav">
      <button class="auth__brand" @click="backHome">
        <span class="mark">N</span>
        <span>{{ APP_NAME }}</span>
      </button>
      <button class="nm-btn nm-btn--ghost nm-btn--sm" @click="backHome">
        <NmIcon name="chevronLeft" :size="14" />
        返回首页
      </button>
    </header>

    <main class="auth__main">
      <div class="card">
        <div class="card__head">
          <h1>{{ mode === 'login' ? '登录' : '创建账号' }}</h1>
          <p>{{ mode === 'login' ? '继续你的写作与同步' : '注册后设置可跨设备同步' }}</p>
        </div>

        <form class="card__form" @submit.prevent="submit">
          <template v-if="mode === 'login'">
            <label class="nm-label" for="account">邮箱或用户名</label>
            <input id="account" v-model="account" class="nm-input" autocomplete="username" placeholder="you@example.com" />
            <label class="nm-label mt" for="password">密码</label>
            <input
              id="password"
              v-model="password"
              class="nm-input"
              type="password"
              autocomplete="current-password"
              placeholder="至少 8 位"
            />
          </template>
          <template v-else>
            <label class="nm-label" for="email">邮箱</label>
            <input id="email" v-model="email" class="nm-input" type="email" autocomplete="email" placeholder="you@example.com" />
            <label class="nm-label mt" for="username">用户名</label>
            <input id="username" v-model="username" class="nm-input" autocomplete="username" placeholder="用于个人存储目录，注册后不可修改" />
            <label class="nm-label mt" for="newpass">密码</label>
            <input
              id="newpass"
              v-model="password"
              class="nm-input"
              type="password"
              autocomplete="new-password"
              placeholder="至少 8 位"
            />
          </template>

          <p v-if="localError" class="card__error">{{ localError }}</p>

          <button class="nm-btn nm-btn--primary card__submit" type="submit" :disabled="auth.loading">
            {{ auth.loading ? '处理中…' : mode === 'login' ? '登录' : '创建账号' }}
          </button>
        </form>

        <div class="card__foot">
          <template v-if="mode === 'login'">
            还没有账号？
            <button class="link" @click="mode = 'register'; localError = ''">立即注册</button>
          </template>
          <template v-else>
            已有账号？
            <button class="link" @click="mode = 'login'; localError = ''">返回登录</button>
          </template>
        </div>

        <p v-if="returning" class="card__note">登录后将返回你刚才访问的页面。</p>
      </div>

      <p class="auth__tip">
        也可以不登录直接使用：
        <button class="link" @click="router.push('/app')">进入本机编辑器</button>
      </p>
    </main>
  </div>
</template>

<style scoped>
.auth {
  position: relative;
  min-height: 100%;
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.auth__bg {
  position: absolute;
  inset: -10% -10% auto -10%;
  height: 460px;
  background: radial-gradient(55% 55% at 50% 0%, rgba(22, 119, 255, 0.16), transparent 70%);
  pointer-events: none;
}
.auth__nav {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 24px;
}
.auth__brand {
  display: flex;
  align-items: center;
  gap: 9px;
  font-weight: 650;
  font-size: 14px;
  color: var(--fg);
}
.mark {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #1677ff, #4a9bff);
  color: #fff;
  font-size: 14px;
  font-weight: 700;
}
.auth__main {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 12px 20px 60px;
  gap: 16px;
}
.card {
  width: min(400px, 100%);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-2);
  padding: 26px 24px 20px;
}
.card__head h1 {
  margin: 0;
  font-size: 20px;
  letter-spacing: -0.02em;
}
.card__head p {
  margin: 6px 0 0;
  font-size: 12.5px;
  color: var(--fg-3);
}
.card__form {
  margin-top: 20px;
}
.mt {
  margin-top: 14px;
}
.card__error {
  margin: 12px 0 0;
  font-size: 12.5px;
  color: #d93025;
  line-height: 1.6;
}
.card__submit {
  width: 100%;
  height: 38px;
  margin-top: 18px;
  font-size: 14px;
}
.card__foot {
  margin-top: 16px;
  text-align: center;
  font-size: 12.5px;
  color: var(--fg-3);
}
.link {
  color: var(--accent);
  font-size: inherit;
  padding: 0 2px;
}
.link:hover {
  text-decoration: underline;
}
.card__note {
  margin: 12px 0 0;
  font-size: 11.5px;
  color: var(--fg-3);
  text-align: center;
}
.auth__tip {
  font-size: 12.5px;
  color: var(--fg-3);
}
</style>
