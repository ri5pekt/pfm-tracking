<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AdminLayout from '../layouts/AdminLayout.vue';
import {
  fetchIngestionRun,
  fetchIngestionRuns,
  type IngestionRunListItem,
} from '../api';

const router = useRouter();

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoIso(n: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const from = ref(daysAgoIso(7));
const to = ref(todayIso());
const source = ref('all');
const status = ref('');
const page = ref(1);
const loading = ref(true);
const error = ref('');
const total = ref(0);
const runs = ref<IngestionRunListItem[]>([]);

const detailId = ref<string | null>(null);
const detailLoading = ref(false);
const detailError = ref('');
const detail = ref<Awaited<ReturnType<typeof fetchIngestionRun>> | null>(null);
const itemPage = ref(1);
const itemAction = ref('');
const itemQ = ref('');

const sources = [
  { id: 'all', label: 'All' },
  { id: 'shipbob', label: 'ShipBob' },
  { id: 'klb', label: 'KLB' },
  { id: 'trackingmore', label: 'TrackingMore' },
  { id: 'system', label: 'System' },
];

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / 50)));

async function loadList() {
  loading.value = true;
  error.value = '';
  try {
    const data = await fetchIngestionRuns({
      from: from.value,
      to: to.value,
      source: source.value,
      status: status.value || undefined,
      page: page.value,
      limit: 50,
    });
    runs.value = data.items;
    total.value = data.total;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load';
  } finally {
    loading.value = false;
  }
}

async function loadDetail() {
  if (!detailId.value) return;
  detailLoading.value = true;
  detailError.value = '';
  try {
    detail.value = await fetchIngestionRun(detailId.value, {
      page: itemPage.value,
      limit: 100,
      action: itemAction.value || undefined,
      q: itemQ.value || undefined,
    });
  } catch (err) {
    detailError.value = err instanceof Error ? err.message : 'Failed to load run';
  } finally {
    detailLoading.value = false;
  }
}

onMounted(loadList);
watch([from, to, source, status], () => {
  page.value = 1;
  void loadList();
});
watch(page, () => void loadList());
watch([itemPage, itemAction], () => {
  if (detailId.value) void loadDetail();
});

function openRun(id: string) {
  detailId.value = id;
  itemPage.value = 1;
  itemAction.value = '';
  itemQ.value = '';
  detail.value = null;
  void loadDetail();
}

function closeDetail() {
  detailId.value = null;
  detail.value = null;
}

function formatWhen(value: string | null | undefined) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function formatDuration(ms: number | null | undefined) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function goShipments(orderNumber: string | null) {
  if (!orderNumber) return;
  void router.push({ path: '/shipments', query: { q: orderNumber } });
}

function searchItems() {
  itemPage.value = 1;
  void loadDetail();
}

const itemTotalPages = computed(() => {
  if (!detail.value) return 1;
  return Math.max(1, Math.ceil(detail.value.items.total / detail.value.items.limit));
});
</script>

<template>
  <AdminLayout title="Sync runs">
    <p class="lede">
      Each ShipBob / KLB / TrackingMore job run. Open a row to see which orders and trackings were
      touched.
    </p>

    <div class="toolbar">
      <label>
        From
        <input v-model="from" type="date" />
      </label>
      <label>
        To
        <input v-model="to" type="date" />
      </label>
      <label>
        Status
        <select v-model="status">
          <option value="">All</option>
          <option value="success">success</option>
          <option value="partial">partial</option>
          <option value="failed">failed</option>
          <option value="running">running</option>
        </select>
      </label>
    </div>

    <div class="tabs">
      <button
        v-for="s in sources"
        :key="s.id"
        type="button"
        class="tab"
        :class="{ active: source === s.id }"
        @click="source = s.id"
      >
        {{ s.label }}
      </button>
    </div>

    <p v-if="loading" class="muted">Loading…</p>
    <p v-else-if="error" class="error">{{ error }}</p>
    <template v-else>
      <table class="runs">
        <thead>
          <tr>
            <th>Started</th>
            <th>Source</th>
            <th>Job</th>
            <th>Status</th>
            <th>Seen</th>
            <th>Upserted</th>
            <th>Events</th>
            <th>Items</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in runs"
            :key="r.id"
            class="clickable"
            @click="openRun(r.id)"
          >
            <td>{{ formatWhen(r.startedAt) }}</td>
            <td>{{ r.source }}</td>
            <td>{{ r.jobName }}</td>
            <td>
              <span class="run-status" :data-status="r.status">{{ r.status }}</span>
            </td>
            <td>{{ r.recordsSeen }}</td>
            <td>{{ r.recordsUpserted }}</td>
            <td>{{ r.eventsAppended }}</td>
            <td>{{ r.itemCount }}</td>
            <td>{{ formatDuration(r.durationMs) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="!runs.length" class="muted">No runs in this range.</p>
      <div v-if="totalPages > 1" class="pager">
        <button type="button" :disabled="page <= 1" @click="page -= 1">Prev</button>
        <span>Page {{ page }} / {{ totalPages }} ({{ total }})</span>
        <button type="button" :disabled="page >= totalPages" @click="page += 1">Next</button>
      </div>
    </template>

    <div v-if="detailId" class="slide-over-backdrop" @click.self="closeDetail">
      <aside class="slide-over">
        <header class="slide-over-header">
          <div>
            <h2>{{ detail?.run.jobName ?? 'Run' }}</h2>
            <p class="muted">{{ formatWhen(detail?.run.startedAt) }}</p>
          </div>
          <button type="button" class="btn secondary" @click="closeDetail">Close</button>
        </header>
        <div class="slide-over-body">
          <p v-if="detailLoading" class="muted">Loading…</p>
          <p v-else-if="detailError" class="error">{{ detailError }}</p>
          <template v-else-if="detail">
            <div class="stat-row">
              <div>
                <div class="label">Status</div>
                <div>
                  <span class="run-status" :data-status="detail.run.status">{{
                    detail.run.status
                  }}</span>
                </div>
              </div>
              <div>
                <div class="label">Seen</div>
                <div>{{ detail.run.recordsSeen }}</div>
              </div>
              <div>
                <div class="label">Upserted</div>
                <div>{{ detail.run.recordsUpserted }}</div>
              </div>
              <div>
                <div class="label">Events</div>
                <div>{{ detail.run.eventsAppended }}</div>
              </div>
              <div>
                <div class="label">Duration</div>
                <div>{{ formatDuration(detail.run.durationMs) }}</div>
              </div>
            </div>

            <p v-if="Object.keys(detail.actionCounts).length" class="actions-summary">
              <span v-for="(n, a) in detail.actionCounts" :key="a" class="chip">{{ a }}: {{ n }}</span>
            </p>

            <section v-if="detail.run.errors" class="errors-block">
              <h3>Errors</h3>
              <pre>{{ JSON.stringify(detail.run.errors, null, 2) }}</pre>
            </section>

            <div class="item-filters">
              <select v-model="itemAction">
                <option value="">All actions</option>
                <option value="created">created</option>
                <option value="updated">updated</option>
                <option value="skipped">skipped</option>
                <option value="error">error</option>
                <option value="unchanged">unchanged</option>
              </select>
              <input
                v-model="itemQ"
                placeholder="Search order / tracking…"
                @keyup.enter="searchItems"
              />
              <button type="button" class="btn" @click="searchItems">Search</button>
            </div>

            <table class="items">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Tracking</th>
                  <th>Action</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in detail.items.rows" :key="row.id">
                  <td>
                    <button
                      v-if="row.orderNumber"
                      type="button"
                      class="link"
                      @click="goShipments(row.orderNumber)"
                    >
                      {{ row.orderNumber }}
                    </button>
                    <span v-else>—</span>
                  </td>
                  <td class="mono">{{ row.trackingNumber ?? '—' }}</td>
                  <td>
                    <span class="action" :data-action="row.action">{{ row.action }}</span>
                  </td>
                  <td class="detail">{{ row.detail ?? '' }}</td>
                </tr>
              </tbody>
            </table>
            <p v-if="!detail.items.rows.length" class="muted">
              No item rows (older runs before this feature, or no-ops only).
            </p>
            <div v-if="itemTotalPages > 1" class="pager">
              <button type="button" :disabled="itemPage <= 1" @click="itemPage -= 1">Prev</button>
              <span>Page {{ itemPage }} / {{ itemTotalPages }} ({{ detail.items.total }})</span>
              <button
                type="button"
                :disabled="itemPage >= itemTotalPages"
                @click="itemPage += 1"
              >
                Next
              </button>
            </div>
          </template>
        </div>
      </aside>
    </div>
  </AdminLayout>
</template>

<style scoped>
.lede {
  color: #64748b;
  margin: 0 0 12px;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
}
.toolbar label {
  display: grid;
  gap: 4px;
  font-size: 0.82rem;
  font-weight: 600;
  color: #475569;
}
.toolbar input,
.toolbar select,
.item-filters input,
.item-filters select {
  padding: 8px 10px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font: inherit;
  font-weight: 400;
}
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.tab {
  border: 1px solid #e5e7eb;
  background: #fff;
  border-radius: 999px;
  padding: 6px 12px;
  cursor: pointer;
  font: inherit;
}
.tab.active {
  background: #0f172a;
  color: #fff;
  border-color: #0f172a;
}
.runs,
.items {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
  background: #fff;
}
.runs th,
.runs td,
.items th,
.items td {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 1px solid #eef2f7;
}
.clickable {
  cursor: pointer;
}
.clickable:hover {
  background: #f8fafc;
}
.run-status[data-status='success'] {
  color: #15803d;
  font-weight: 600;
}
.run-status[data-status='failed'] {
  color: #b91c1c;
  font-weight: 600;
}
.run-status[data-status='partial'] {
  color: #b45309;
  font-weight: 600;
}
.pager {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-top: 12px;
}
.pager button,
.btn {
  border: 0;
  border-radius: 8px;
  background: #0f172a;
  color: #fff;
  padding: 8px 12px;
  cursor: pointer;
}
.btn.secondary,
.pager button:disabled {
  background: #e2e8f0;
  color: #0f172a;
}
.muted {
  color: #64748b;
}
.error {
  color: #b91c1c;
}
.slide-over-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.35);
  z-index: 40;
  display: flex;
  justify-content: flex-end;
}
.slide-over {
  width: min(560px, 100%);
  background: #fff;
  height: 100%;
  display: flex;
  flex-direction: column;
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.12);
}
.slide-over-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  padding: 16px;
  border-bottom: 1px solid #e5e7eb;
}
.slide-over-header h2 {
  margin: 0;
  font-size: 1.05rem;
}
.slide-over-body {
  padding: 16px;
  overflow: auto;
  flex: 1;
}
.stat-row {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}
.label {
  font-size: 0.75rem;
  color: #64748b;
}
.actions-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 12px;
}
.chip {
  background: #f1f5f9;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 0.8rem;
}
.errors-block {
  margin-bottom: 12px;
}
.errors-block h3 {
  margin: 0 0 6px;
  font-size: 0.9rem;
}
.errors-block pre {
  margin: 0;
  background: #fef2f2;
  border-radius: 8px;
  padding: 10px;
  font-size: 0.75rem;
  overflow: auto;
  max-height: 160px;
}
.item-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
.link {
  border: 0;
  background: none;
  color: #1d4ed8;
  cursor: pointer;
  padding: 0;
  font: inherit;
  text-decoration: underline;
}
.mono {
  font-family: ui-monospace, monospace;
  font-size: 0.8rem;
}
.detail {
  color: #64748b;
  max-width: 160px;
}
.action[data-action='created'] {
  color: #15803d;
  font-weight: 600;
}
.action[data-action='error'] {
  color: #b91c1c;
  font-weight: 600;
}
.action[data-action='skipped'] {
  color: #64748b;
}
</style>
