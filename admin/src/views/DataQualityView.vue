<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import AdminLayout from '../layouts/AdminLayout.vue';
import {
  fetchMe,
  fetchUnmappedStatuses,
  requestErasure,
  type AdminUser,
} from '../api';

const router = useRouter();
const user = ref<AdminUser | null>(null);
const items = ref<
  Array<{
    source: string;
    raw_status: string;
    raw_substatus_code: string | null;
    n: number;
    sample_description: string | null;
  }>
>([]);
const loading = ref(true);
const error = ref('');
const erasureEmail = ref('');
const erasureMsg = ref('');
const erasureBusy = ref(false);

onMounted(async () => {
  try {
    user.value = (await fetchMe()).user;
    const data = await fetchUnmappedStatuses();
    items.value = data.items;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load';
  } finally {
    loading.value = false;
  }
});

function mapTo(row: {
  source: string;
  raw_status: string;
  raw_substatus_code: string | null;
}) {
  void router.push({
    path: '/status-mappings',
    query: {
      source: row.source,
      raw_status: row.raw_status,
      raw_substatus_code: row.raw_substatus_code ?? '',
    },
  });
}

async function onErasure() {
  if (!erasureEmail.value || erasureBusy.value) return;
  if (!window.confirm(`Anonymise all orders for ${erasureEmail.value}?`)) return;
  erasureBusy.value = true;
  erasureMsg.value = '';
  try {
    const result = await requestErasure(erasureEmail.value);
    erasureMsg.value = `Done: ${result.ordersAffected} orders, ${result.eventsScrubbed} events scrubbed.`;
    erasureEmail.value = '';
  } catch (err) {
    erasureMsg.value = err instanceof Error ? err.message : 'Erasure failed';
  } finally {
    erasureBusy.value = false;
  }
}
</script>

<template>
  <AdminLayout title="Data quality">
    <section class="panel">
      <h2>Unmapped statuses (14 days)</h2>
      <p class="muted">
        Raw carrier statuses without a matching row in <code>status_mappings</code>. Use
        <strong>Map to…</strong> to open the editor prefilled.
      </p>
      <p v-if="loading" class="muted">Loading…</p>
      <p v-else-if="error" class="error">{{ error }}</p>
      <table v-else-if="items.length">
        <thead>
          <tr>
            <th>Source</th>
            <th>Raw status</th>
            <th>Substatus</th>
            <th>Count</th>
            <th>Sample</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, idx) in items" :key="`${row.source}-${row.raw_status}-${idx}`">
            <td>{{ row.source }}</td>
            <td>{{ row.raw_status }}</td>
            <td>{{ row.raw_substatus_code ?? '—' }}</td>
            <td>{{ row.n }}</td>
            <td class="sample">{{ row.sample_description ?? '—' }}</td>
            <td>
              <button class="btn-link" type="button" @click="mapTo(row)">Map to…</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">No unmapped statuses in the last 14 days.</p>
    </section>

    <section v-if="user?.role === 'admin'" class="panel">
      <h2>GDPR erasure</h2>
      <p class="muted">Anonymise customer PII for an email (orders kept for analytics).</p>
      <form class="erasure" @submit.prevent="onErasure">
        <input v-model="erasureEmail" type="email" required placeholder="customer@email.com" />
        <button class="btn" type="submit" :disabled="erasureBusy">
          {{ erasureBusy ? 'Working…' : 'Anonymise' }}
        </button>
      </form>
      <p v-if="erasureMsg" class="muted">{{ erasureMsg }}</p>
    </section>
  </AdminLayout>
</template>

<style scoped>
.panel {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 14px 16px;
  margin-bottom: 14px;
}
.panel h2 {
  margin: 0 0 8px;
  font-size: 1rem;
}
.muted {
  color: #64748b;
  font-size: 0.9rem;
}
.error {
  color: #b91c1c;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
  margin-top: 10px;
}
th,
td {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 1px solid #eef2f7;
  vertical-align: top;
}
.sample {
  max-width: 280px;
  color: #64748b;
}
.erasure {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.erasure input {
  flex: 1;
  min-width: 220px;
  padding: 8px 10px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
}
.btn {
  border: 0;
  border-radius: 8px;
  background: #0f172a;
  color: #fff;
  padding: 8px 14px;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.6;
}
.btn-link {
  border: 0;
  background: none;
  color: #1d4ed8;
  cursor: pointer;
  padding: 0;
  font-size: inherit;
  text-decoration: underline;
}
</style>
