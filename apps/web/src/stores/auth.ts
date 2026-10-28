import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { authApi, setTokens, getAccessToken, type UserDto } from '@/api/client';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<UserDto | null>(null);
  const loading = ref(false);
  const error = ref('');
  /** 会话恢复是否已完成（含"无 token"的情况） */
  const restored = ref(false);
  let restoring: Promise<void> | null = null;

  const isLoggedIn = computed(() => Boolean(user.value && getAccessToken()));
  const isAdmin = computed(() => user.value?.role === 'admin');

  /** 幂等：并发调用共享同一次恢复 */
  async function restore(): Promise<void> {
    if (restored.value) return;
    if (restoring) return restoring;
    restoring = (async () => {
      try {
        if (!getAccessToken()) {
          user.value = null;
          return;
        }
        user.value = await authApi.me();
      } catch {
        user.value = null;
        setTokens(null, null);
      } finally {
        restored.value = true;
        restoring = null;
      }
    })();
    return restoring;
  }

  async function login(account: string, password: string): Promise<boolean> {
    loading.value = true;
    error.value = '';
    try {
      const deviceId = localStorage.getItem('neomd.deviceId') ?? undefined;
      const res = await authApi.login({ account, password, deviceId });
      setTokens(res.accessToken, res.refreshToken);
      user.value = res.user;
      restored.value = true;
      return true;
    } catch (e) {
      error.value = (e as Error).message;
      return false;
    } finally {
      loading.value = false;
    }
  }

  async function register(email: string, username: string, password: string): Promise<boolean> {
    loading.value = true;
    error.value = '';
    try {
      const res = await authApi.register({ email, username, password });
      setTokens(res.accessToken, res.refreshToken);
      user.value = res.user;
      restored.value = true;
      return true;
    } catch (e) {
      error.value = (e as Error).message;
      return false;
    } finally {
      loading.value = false;
    }
  }

  async function logout(): Promise<void> {
    try {
      await authApi.logout();
    } catch {
      /* 忽略登出失败 */
    }
    setTokens(null, null);
    user.value = null;
    restored.value = true;
  }

  return { user, loading, error, restored, isLoggedIn, isAdmin, restore, login, register, logout };
});
