<script setup lang="ts">
/**
 * 后台 · 积分与兑换码（1.1.9 从 AdminPage.vue 拆出）。
 *
 * 兑换码生成 / 列表 / 删除。生成后明文只在这一刻能看到（库里存的是码本身，
 * 但一旦离开页面就要靠「复制全部」留存），所以生成结果用一个高亮区块常驻显示。
 */
import { onMounted, ref } from 'vue';
import { NmIcon } from '@neomd/ui';
import { adminApiV2 } from '@/api/client';
import { fmtTime } from './shared';

const emit = defineEmits<{
  notify: [string];
  fail: [string];
}>();

const codes = ref<Array<Record<string, unknown>>>([]);
const count = ref(10);
const credits = ref(1000);
const generated = ref<string[]>([]);
const loading = ref(false);
const creating = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    codes.value = (await adminApiV2.redeemCodes()).items;
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    loading.value = false;
  }
}

async function generate(): Promise<void> {
  creating.value = true;
  try {
    const res = await adminApiV2.createCodes({ count: count.value, credits: credits.value });
    // 兼容两种响应形状：新接口回 codes 数组，老接口回 items
    const list = Array.isArray(res.codes) ? res.codes : Array.isArray(res.items) ? res.items.map((x) => x.code) : [];
    generated.value = list;
    codes.value = (await adminApiV2.redeemCodes()).items;
    emit('notify', `已生成 ${list.length} 个兑换码`);
  } catch (e) {
    emit('fail', (e as Error).message);
  } finally {
    creating.value = false;
  }
}

async function remove(id: number): Promise<void> {
  try {
    await adminApiV2.deleteCode(id);
    codes.value = (await adminApiV2.redeemCodes()).items;
  } catch (e) {
    emit('fail', (e as Error).message);
  }
}

function copyAll(): void {
  void navigator.clipboard?.writeText(generated.value.join('\n'));
  emit('notify', '兑换码已复制到剪贴板');
}

/** 兼容后端 snake_case 与前端 camelCase 两种字段名 */
function usedBy(c: Record<string, unknown>): string {
  return String(c.usedByUsername ?? c.used_by ?? '—');
}
function isUsed(c: Record<string, unknown>): boolean {
  return Boolean(c.usedBy ?? c.used_by);
}

onMounted(load);
defineExpose({ reload: load });
</script>

<template>
  <div class="cred">
    <header class="adm-page-head">
      <div>
        <h2>积分与兑换码</h2>
        <p>批量生成一次性兑换码，用户在个人中心「积分与兑换」输入即可充值。已使用的兑换码不可删除（保留对账痕迹）。</p>
      </div>
    </header>

    <section class="adm-card" style="margin-bottom: 22px;">
      <div class="adm-card__head">
        <div>
          <h3 class="adm-card__title">批量生成</h3>
          <p class="adm-card__sub">单次最多 100 个</p>
        </div>
      </div>
      <div class="adm-card__body">
        <div class="gen-row">
          <input v-model.number="count" class="nm-input adm-toolbar__num" type="number" min="1" max="100" aria-label="生成数量" />
          <span class="adm-muted">个兑换码，每个</span>
          <input v-model.number="credits" class="nm-input adm-toolbar__num" type="number" min="1" aria-label="每个积分" />
          <span class="adm-muted">积分</span>
          <button class="nm-btn nm-btn--sm nm-btn--primary" :disabled="creating" @click="generate">
            <NmIcon name="plus" :size="12" />{{ creating ? '生成中…' : '生成' }}
          </button>
          <button v-if="generated.length" class="nm-btn nm-btn--sm" @click="copyAll">复制全部</button>
        </div>

        <pre v-if="generated.length" class="codes">{{ generated.join('\n') }}</pre>
      </div>
    </section>

    <table class="adm-table">
      <thead>
        <tr>
          <th>兑换码</th>
          <th class="adm-right" style="width: 110px;">积分</th>
          <th style="width: 110px;">状态</th>
          <th style="width: 150px;">使用者</th>
          <th style="width: 160px;">创建时间</th>
          <th class="adm-right" style="width: 90px;">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="c in codes" :key="String(c.id)">
          <td class="adm-mono adm-strong">{{ c.code }}</td>
          <td class="adm-right">{{ c.credits }}</td>
          <td>
            <span class="adm-badge" :class="isUsed(c) ? 'adm-badge--muted' : 'adm-badge--ok'">
              {{ isUsed(c) ? '已使用' : '未使用' }}
            </span>
          </td>
          <td class="adm-muted">{{ usedBy(c) }}</td>
          <td class="adm-muted">{{ fmtTime(c.createdAt ?? c.created_at) }}</td>
          <td class="adm-right">
            <button v-if="!isUsed(c)" class="adm-rowbtn adm-rowbtn--danger" @click="remove(Number(c.id))">删除</button>
          </td>
        </tr>
        <tr v-if="!codes.length">
          <td colspan="6" class="adm-empty">{{ loading ? '加载中…' : '还没有兑换码' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.gen-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.codes {
  margin: 16px 0 0;
  padding: 14px 16px;
  border-radius: 10px;
  background: #f7f8fa;
  border: 1px solid #e5e7eb;
  font-family: var(--font-mono, ui-monospace, Consolas, monospace);
  font-size: 12px;
  line-height: 1.9;
  max-height: 200px;
  overflow: auto;
  color: #1f2329;
}
</style>
