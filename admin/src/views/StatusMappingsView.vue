<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import AdminLayout from '../layouts/AdminLayout.vue';
import {
  createStatusMapping,
  deleteStatusMapping,
  fetchMe,
  fetchStatusMappings,
  type AdminUser,
  type StatusMapping,
} from '../api';

const route = useRoute();
const user = ref<AdminUser | null>(null);
const items = ref<StatusMapping[]>([]);
const internalStatuses = ref<string[]>([]);
const loading = ref(true);
const error = ref('');
const msg = ref('');

const form = ref({
  source: 'trackingmore',
  raw_status: '',
  raw_substatus_code: '',
  internal_status: 'IN_TRANSIT',
  status_rank: 40,
  notes: '',
});

const ranks: Record<string, number> = {
  ORDER_RECEIVED: 10,
  PROCESSING: 20,
  LABEL_CREATED: 30,
  IN_TRANSIT: 40,
  OUT_FOR_DELIVERY: 50,
  EXCEPTION: 55,
  DELIVERED: 90,
  RETURNED_TO_SENDER: 90,
  CANCELLED: 90,
};

const canEdit = computed(() => user.value?.role === 'admin');
const filter = ref('');

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return items.value;
  return items.value.filter(
    (i) =>
      i.source.toLowerCase().includes(q) ||
      i.raw_status.toLowerCase().includes(q) ||
      (i.raw_substatus_code ?? '').toLowerCase().includes(q) ||
      i.internal_status.toLowerCase().includes(q),
  );
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    user.value = (await fetchMe()).user;
    const data = await fetchStatusMappings();
    items.value = data.items;
    internalStatuses.value = data.internalStatuses;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load';
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await load();
  const q = route.query;
  if (typeof q.source === 'string') form.value.source = q.source;
  if (typeof q.raw_status === 'string') form.value.raw_status = q.raw_status;
  if (typeof q.raw_substatus_code === 'string') {
    form.value.raw_substatus_code = q.raw_substatus_code;
  }
});

function onInternalChange() {
  form.value.status_rank = ranks[form.value.internal_status] ?? 40;
}

async function onCreate() {
  if (!canEdit.value) return;
  msg.value = '';
  try {
    await createStatusMapping({
      source: form.value.source as 'shipbob' | 'trackingmore' | 'system',
      raw_status: form.value.raw_status,
      raw_substatus_code: form.value.raw_substatus_code || null,
      internal_status: form.value.internal_status,
      status_rank: form.value.status_rank,
      notes: form.value.notes || null,
    });
    msg.value = 'Mapping created.';
    form.value.raw_status = '';
    form.value.raw_substatus_code = '';
    form.value.notes = '';
    await load();
  } catch (err) {
    msg.value = err instanceof Error ? err.message : 'Create failed';
  }
}

async function onDelete(id: string) {
  if (!canEdit.value) return;
  if (!window.confirm('Delete this mapping?')) return;
  await deleteStatusMapping(id);
  await load();
}
</script>

<template>
  <AdminLayout title="Status mappings">
    <p class="lede">
      Config table for raw carrier statuses → internal status. Prefer editing here over hard-coded
      fallbacks. Staff can view; admins can edit.
    </p>

    <section v-if="canEdit" class="panel">
      <h2>Add mapping</h2>
      <form class="form" @submit.prevent="onCreate">
        <label>
          Source
          <select v-model="form.source">
            <option value="shipbob">shipbob</option>
            <option value="trackingmore">trackingmore</option>
            <option value="system">system</option>
          </select>
        </label>
        <label>
          Raw status
          <input v-model="form.raw_status" required placeholder="e.g. transit" />
        </label>
        <label>
          Substatus (optional)
          <input v-model="form.raw_substatus_code" placeholder="e.g. transit001" />
        </label>
        <label>
          Internal status
          <select v-model="form.internal_status" @change="onInternalChange">
            <option v-for="s in internalStatuses" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
        <label>
          Rank
          <input v-model.number="form.status_rank" type="number" min="0" max="100" required />
        </label>
        <label class="wide">
          Notes
          <input v-model="form.notes" placeholder="Optional" />
        </label>
        <button class="btn" type="submit">Create</button>
      </form>
      <p v-if="msg" class="muted">{{ msg }}</p>
    </section>

    <section class="panel">
      <div class="row">
        <h2>All mappings</h2>
        <input v-model="filter" class="search" placeholder="Filter…" />
      </div>
      <p v-if="loading" class="muted">Loading…</p>
      <p v-else-if="error" class="error">{{ error }}</p>
      <table v-else>
        <thead>
          <tr>
            <th>Source</th>
            <th>Raw</th>
            <th>Substatus</th>
            <th>Internal</th>
            <th>Rank</th>
            <th>Notes</th>
            <th v-if="canEdit" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in filtered" :key="row.id">
            <td>{{ row.source }}</td>
            <td>{{ row.raw_status }}</td>
            <td>{{ row.raw_substatus_code ?? '—' }}</td>
            <td>{{ row.internal_status }}</td>
            <td>{{ row.status_rank }}</td>
            <td class="notes">{{ row.notes ?? '' }}</td>
            <td v-if="canEdit">
              <button class="link" type="button" @click="onDelete(row.id)">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </AdminLayout>
</template>

<style scoped>
.lede {
  color: #64748b;
  margin: 0 0 14px;
}
.panel {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 14px 16px;
  margin-bottom: 14px;
}
.panel h2 {
  margin: 0 0 10px;
  font-size: 1rem;
}
.form {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 10px;
  align-items: end;
}
.form label {
  display: grid;
  gap: 4px;
  font-size: 0.82rem;
  font-weight: 600;
  color: #475569;
}
.form .wide {
  grid-column: 1 / -1;
}
.form input,
.form select {
  padding: 8px 10px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font: inherit;
  font-weight: 400;
}
.btn {
  border: 0;
  border-radius: 8px;
  background: #0f172a;
  color: #fff;
  padding: 9px 14px;
  cursor: pointer;
  height: 38px;
}
.row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  margin-bottom: 8px;
}
.search {
  padding: 8px 10px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  min-width: 180px;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.86rem;
}
th,
td {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 1px solid #eef2f7;
}
.notes {
  color: #64748b;
  max-width: 220px;
}
.link {
  border: 0;
  background: transparent;
  color: #b91c1c;
  cursor: pointer;
  font: inherit;
}
.muted {
  color: #64748b;
}
.error {
  color: #b91c1c;
}
</style>
