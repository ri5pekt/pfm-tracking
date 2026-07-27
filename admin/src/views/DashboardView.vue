<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import AdminLayout from '../layouts/AdminLayout.vue';
import { fetchDashboard, type DashboardData } from '../api';

const data = ref<DashboardData | null>(null);
const loading = ref(true);
const error = ref('');

onMounted(async () => {
  try {
    data.value = await fetchDashboard();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load dashboard';
  } finally {
    loading.value = false;
  }
});

function formatWhen(value: string | Date | null | undefined) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}
</script>

<template>
  <AdminLayout title="Dashboard">
    <p v-if="loading" class="muted">Loading…</p>
    <p v-else-if="error" class="error">{{ error }}</p>
    <template v-else-if="data">
      <section class="cards">
        <div class="card">
          <div class="card-label">All shipments</div>
          <div class="card-value">{{ data.counts.all }}</div>
        </div>
        <div class="card">
          <div class="card-label">In transit</div>
          <div class="card-value">{{ data.counts.in_transit }}</div>
        </div>
        <div class="card">
          <div class="card-label">Exception</div>
          <div class="card-value warn">{{ data.counts.exception }}</div>
        </div>
        <div class="card">
          <div class="card-label">Stalled</div>
          <div class="card-value warn">{{ data.counts.stalled }}</div>
        </div>
        <div class="card">
          <div class="card-label">Delivered</div>
          <div class="card-value ok">{{ data.counts.delivered }}</div>
        </div>
        <div class="card">
          <div class="card-label">Unmapped (14d)</div>
          <div class="card-value">{{ data.unmappedRecentEvents }}</div>
        </div>
        <div class="card">
          <div class="card-label">Ops health</div>
          <div class="card-value" :class="data.opsHealth?.ok ? 'ok' : 'warn'">
            {{ data.opsHealth?.ok ? 'OK' : 'Alert' }}
          </div>
        </div>
      </section>

      <section v-if="data.opsHealth" class="panel alerts" :data-ok="data.opsHealth.ok">
        <h2>Job lag / failures</h2>
        <p class="muted">
          Critical jobs alert when lag &gt; 2× schedule. Probe:
          <code>/health/ops</code>
        </p>
        <ul v-if="data.opsHealth.alerts.length" class="plain">
          <li v-for="(a, i) in data.opsHealth.alerts" :key="i">{{ a }}</li>
        </ul>
        <p v-else class="muted">No lag alerts.</p>
        <table v-if="data.opsHealth.jobs?.length" class="jobs">
          <thead>
            <tr>
              <th>Job</th>
              <th>Status</th>
              <th>Last success</th>
              <th>Lag</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="j in data.opsHealth.jobs" :key="j.jobName">
              <td>
                {{ j.jobName }}
                <span v-if="j.critical" class="tag">critical</span>
              </td>
              <td>
                <span class="run-status" :data-status="j.status">{{ j.status }}</span>
              </td>
              <td>{{ formatWhen(j.lastSuccessAt) }}</td>
              <td>
                {{
                  j.lagMs == null ? '—' : `${Math.round(j.lagMs / 60000)}m / ${j.lagThresholdMs / 60000}m`
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <div class="grid-2">
        <section class="panel">
          <h2>By source</h2>
          <ul class="plain">
            <li v-for="s in data.bySource" :key="s.source">
              <strong>{{ s.source }}</strong> — {{ s.n }}
            </li>
          </ul>
        </section>
        <section class="panel">
          <h2>Sync cursors</h2>
          <table v-if="data.cursors.length">
            <thead>
              <tr>
                <th>Job</th>
                <th>Last success</th>
                <th>Cursor</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in data.cursors" :key="c.job_name">
                <td>{{ c.job_name }}</td>
                <td>{{ formatWhen(c.last_success_at) }}</td>
                <td>{{ formatWhen(c.cursor_at) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted">No sync cursors yet.</p>
        </section>
      </div>

      <section class="panel">
        <div class="row-head">
          <h2>Recent job runs</h2>
          <RouterLink class="view-all" to="/sync-runs">View all →</RouterLink>
        </div>
        <table v-if="data.recentRuns.length">
          <thead>
            <tr>
              <th>Job</th>
              <th>Status</th>
              <th>Started</th>
              <th>Seen</th>
              <th>Upserted</th>
              <th>Events</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in data.recentRuns" :key="r.id">
              <td>{{ r.job_name }}</td>
              <td>
                <span class="run-status" :data-status="r.status">{{ r.status }}</span>
              </td>
              <td>{{ formatWhen(r.started_at) }}</td>
              <td>{{ r.records_seen }}</td>
              <td>{{ r.records_upserted }}</td>
              <td>{{ r.events_appended }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">No ingestion runs yet.</p>
      </section>

      <section class="panel">
        <h2>Reconcile findings</h2>
        <ul v-if="data.reconcile?.findings?.length" class="plain">
          <li v-for="f in data.reconcile.findings" :key="f.kind">
            <strong>{{ f.n }}</strong> — {{ f.detail }}
          </li>
        </ul>
        <p v-else class="muted">No reconcile issues flagged.</p>
      </section>

      <section class="panel">
        <h2>Notifications</h2>
        <table v-if="data.notifications.length">
          <thead>
            <tr>
              <th>Event</th>
              <th>Status</th>
              <th>Count</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="n in data.notifications" :key="`${n.eventType}-${n.status}`">
              <td>{{ n.eventType }}</td>
              <td>{{ n.status }}</td>
              <td>{{ n.n }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">No notification_log rows yet.</p>
      </section>
    </template>
  </AdminLayout>
</template>

<style scoped>
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}
.card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 14px;
}
.card-label {
  font-size: 0.8rem;
  color: #64748b;
  margin-bottom: 6px;
}
.card-value {
  font-size: 1.6rem;
  font-weight: 700;
  color: #0f172a;
}
.card-value.warn {
  color: #c2410c;
}
.card-value.ok {
  color: #15803d;
}
.grid-2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 14px;
  margin-bottom: 14px;
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
.row-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.row-head h2 {
  margin: 0;
}
.view-all {
  color: #1d4ed8;
  font-size: 0.88rem;
  text-decoration: none;
}
.view-all:hover {
  text-decoration: underline;
}
.plain {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
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
th {
  color: #64748b;
  font-weight: 600;
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
.run-status[data-status='lagging'],
.run-status[data-status='failed_recent'] {
  color: #b91c1c;
  font-weight: 600;
}
.run-status[data-status='missing'] {
  color: #b45309;
  font-weight: 600;
}
.run-status[data-status='ok'] {
  color: #15803d;
  font-weight: 600;
}
.alerts[data-ok='false'] {
  border-color: #fdba74;
  background: #fff7ed;
}
.tag {
  font-size: 0.7rem;
  color: #64748b;
  margin-left: 4px;
}
.jobs {
  margin-top: 10px;
}
.muted {
  color: #64748b;
}
.error {
  color: #b91c1c;
}
</style>
