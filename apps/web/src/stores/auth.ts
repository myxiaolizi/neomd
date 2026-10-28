import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { authApi, setTokens, getAccessToken, type UserDto } from '@/api/client';

const USER_CACHE_KEY = 'neomd.user.cache';

function loadCachedUser(): UserDto | null {
  try {
    if (!getAccessToken()) return null;
    const raw = localStorage.getItem(USER_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UserDto;
    return parsed && typeof parsed === 'object' && parsed.username ? parsed : null;
  } catch {
    return null;
  }
}

function saveCachedUser(u: UserDto | null): void {
  try {
    if (u) localStorage.setItem(USER_CACHE_KEY, JSON.stringify(u));
    else localStorage.removeItem(USER_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

export const useAuthStore = defineStore('auth', () => {
  // 首帧直接从本地缓存恢复用户信息（配合 token），使编辑器启动零网络等待即可获知登录态
  const user = ref<UserDto | null>(loadCachedUser());
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
          saveCachedUser(null);
          return;
        }
        const fresh = await authApi.me();
        user.value = fresh;
        saveCachedUser(fresh);
      } catch {
        // 若没有缓存用户才清理；网络暂时不可达时保留本地缓存避免离线启动丢失身份
        if (!user.value) {
          setTokens(null, null);
          saveCachedUser(null);
        }
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
      saveCachedUser(res.user);
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
      saveCachedUser(res.user);
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
    saveCachedUser(null);
    restored.value = true;
  }

  return { user, loading, error, restored, isLoggedIn, isAdmin, restore, login, register, logout };
});
