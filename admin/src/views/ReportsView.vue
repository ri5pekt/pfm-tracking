<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import AdminLayout from '../layouts/AdminLayout.vue';
import { fetchDeliveryReport, type DeliveryReport } from '../api';

const days = ref(30);
const data = ref<DeliveryReport | null>(null);
const loading = ref(true);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await fetchDeliveryReport(days.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(days, load);

function maxDaily() {
  if (!data.value?.deliveredDaily.length) return 1;
  return Math.max(...data.value.deliveredDaily.map((d) => d.n), 1);
}
</script>

<template>
  <AdminLayout title="Delivery performance">
    <div class="toolbar">
      <label>
        Window
        <select v-model.number="days">
          <option :value="7">7 days</option>
          <option :value="30">30 days</option>
          <option :value="90">90 days</option>
        </select>
      </label>
    </div>

    <p v-if="loading" class="muted">Loading…</p>
    <p v-else-if="error" class="error">{{ error }}</p>
    <template v-else-if="data">
      <section class="cards">
        <div class="card">
          <div class="label">Shipments</div>
          <div class="value">{{ data.summary.total }}</div>
        </div>
        <div class="card">
          <div class="label">Delivered</div>
          <div class="value ok">{{ data.summary.delivered }}</div>
        </div>
        <div class="card">
          <div class="label">Exception rate</div>
          <div class="value warn">{{ data.summary.exceptionRatePct }}%</div>
        </div>
        <div class="card">
          <div class="label">Avg transit days</div>
          <div class="value">{{ data.summary.avgTransitDays ?? '—' }}</div>
        </div>
        <div class="card">
          <div class="label">Stalled</div>
          <div class="value warn">{{ data.summary.stalled }}</div>
        </div>
      </section>

      <section class="panel">
        <h2>Delivered per day</h2>
        <div class="bars">
          <div v-for="d in data.deliveredDaily" :key="d.day" class="bar-col" :title="`${d.day}: ${d.n}`">
            <div class="bar-track">
              <div
                class="bar"
                :style="{ height: `${Math.max(4, (d.n / maxDaily()) * 100)}%` }"
              />
            </div>
            <div class="bar-label">{{ d.day.slice(5) }}</div>
          </div>
          <p v-if="!data.deliveredDaily.length" class="muted">No deliveries in this window.</p>
        </div>
      </section>

      <section class="panel">
        <h2>By carrier</h2>
        <table>
          <thead>
            <tr>
              <th>Carrier</th>
              <th>Delivered</th>
              <th>Exceptions</th>
              <th>In flight</th>
              <th>Avg days</th>
              <th>On-time</th>
              <th>Late vs EDD</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in data.byCarrier" :key="r.carrier">
              <td>{{ r.carrier }}</td>
              <td>{{ r.delivered }}</td>
              <td>{{ r.exceptions }}</td>
              <td>{{ r.inFlight }}</td>
              <td>{{ r.avgTransitDays ?? '—' }}</td>
              <td>{{ r.onTime }}</td>
              <td>{{ r.late }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="panel">
        <h2>By source</h2>
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Total</th>
              <th>Delivered</th>
              <th>Exceptions</th>
              <th>Stalled</th>
              <th>Avg days</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in data.bySource" :key="r.source">
              <td>{{ r.source }}</td>
              <td>{{ r.total }}</td>
              <td>{{ r.delivered }}</td>
              <td>{{ r.exceptions }}</td>
              <td>{{ r.stalled }}</td>
              <td>{{ r.avgTransitDays ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </AdminLayout>
</template>

<style scoped>
.toolbar {
  margin-bottom: 12px;
}
.toolbar label {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  font-size: 0.9rem;
  font-weight: 600;
}
.toolbar select {
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid #d1d5db;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}
.card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 14px;
}
.label {
  font-size: 0.8rem;
  color: #64748b;
}
.value {
  font-size: 1.5rem;
  font-weight: 700;
  margin-top: 4px;
}
.value.ok {
  color: #15803d;
}
.value.warn {
  color: #c2410c;
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
.bars {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  overflow-x: auto;
  padding-bottom: 4px;
}
.bar-col {
  flex: 0 0 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.bar-track {
  width: 100%;
  height: 120px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
}
.bar {
  width: 12px;
  min-height: 4px;
  background: linear-gradient(180deg, #86efac, #15803d);
  border-radius: 4px 4px 0 0;
}
.bar-label {
  flex: 0 0 40px;
  width: 100%;
  margin-top: 6px;
  font-size: 0.55rem;
  color: #94a3b8;
  writing-mode: vertical-rl;
  transform: rotate(180deg);
  overflow: hidden;
  text-align: left;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}
th,
td {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 1px solid #eef2f7;
}
.muted {
  color: #64748b;
}
.error {
  color: #b91c1c;
}
</style>
