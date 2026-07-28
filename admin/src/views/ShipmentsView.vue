<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import AdminLayout from '../layouts/AdminLayout.vue';
import { fetchShipmentDetail, fetchShipments, fetchTrackingLink, replayNotification, retrackShipment, type ShipmentListItem } from '../api';
import { statusLabel, statusTone } from '../status';
import { carrierLogo } from '../carriers';

const route = useRoute();
const counts = ref<Record<string, number>>({});
const items = ref<ShipmentListItem[]>([]);
const total = ref(0);
const activeTab = ref('all');
const search = ref('');
const loading = ref(false);
const page = ref(1);
const pageSize = ref(20);
const sortBy = ref('order_imported_at');
const sortDir = ref<'asc' | 'desc'>('desc');
const pageSizeOptions = [20, 50, 100];
const selectedId = ref<string | null>(null);
const detail = ref<{
  shipment: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
  notifications: Array<Record<string, unknown>>;
} | null>(null);
const timelineExpanded = ref(false);
const rawExpanded = ref(false);
const trackingLinkBusy = ref(false);
const retrackBusy = ref(false);
const replayBusyId = ref<string | null>(null);
const TIMELINE_PREVIEW = 5;

const tabs = [
  { key: 'all', label: 'All' },
  { key: 'order_received', label: 'Order confirmed' },
  { key: 'processing', label: 'Preparing' },
  { key: 'label_created', label: 'Label created' },
  { key: 'in_transit', label: 'In transit' },
  { key: 'out_for_delivery', label: 'Out for delivery' },
  { key: 'exception', label: 'Exception' },
  { key: 'stalled', label: 'Stalled' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'returned_to_sender', label: 'Returning' },
  { key: 'cancelled', label: 'Cancelled' },
];

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
const rangeLabel = computed(() => {
  if (total.value === 0) return '0–0 of 0';
  const from = (page.value - 1) * pageSize.value + 1;
  const to = Math.min(page.value * pageSize.value, total.value);
  return `${from}–${to} of ${total.value}`;
});

const visibleEvents = computed(() => {
  const events = detail.value?.events ?? [];
  if (timelineExpanded.value || events.length <= TIMELINE_PREVIEW) return events;
  return events.slice(0, TIMELINE_PREVIEW);
});

const hiddenEventCount = computed(() => {
  const n = detail.value?.events.length ?? 0;
  return Math.max(0, n - TIMELINE_PREVIEW);
});

async function load() {
  loading.value = true;
  try {
    const data = await fetchShipments({
      q: search.value || undefined,
      status: activeTab.value,
      page: page.value,
      pageSize: pageSize.value,
      sortBy: sortBy.value,
      sortDir: sortDir.value,
    });
    counts.value = data.counts;
    items.value = data.items;
    total.value = data.total;
    page.value = data.page;
    pageSize.value = data.pageSize;
  } finally {
    loading.value = false;
  }
}

function onSearch() {
  page.value = 1;
  void load();
}

function onTab(key: string) {
  activeTab.value = key;
  page.value = 1;
  void load();
}

function onPageSizeChange() {
  page.value = 1;
  void load();
}

function goPage(next: number) {
  page.value = Math.min(Math.max(1, next), totalPages.value);
  void load();
}

function toggleSort(column: string) {
  if (sortBy.value === column) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortBy.value = column;
    sortDir.value = column === 'order_number' || column === 'tracking_number' ? 'asc' : 'desc';
  }
  page.value = 1;
  void load();
}

function sortIndicator(column: string) {
  if (sortBy.value !== column) return '';
  return sortDir.value === 'asc' ? ' ↑' : ' ↓';
}

async function openDetail(id: string) {
  selectedId.value = id;
  timelineExpanded.value = false;
  rawExpanded.value = false;
  detail.value = await fetchShipmentDetail(id);
}

function closeDetail() {
  selectedId.value = null;
  detail.value = null;
}

async function openTrackingPage() {
  if (!selectedId.value || trackingLinkBusy.value) return;
  trackingLinkBusy.value = true;
  try {
    const { url } = await fetchTrackingLink(selectedId.value);
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    window.alert('Could not open tracking page for this shipment.');
  } finally {
    trackingLinkBusy.value = false;
  }
}

async function onRetrack() {
  if (!selectedId.value || retrackBusy.value) return;
  retrackBusy.value = true;
  try {
    const result = await retrackShipment(selectedId.value);
    detail.value = await fetchShipmentDetail(selectedId.value);
    window.alert(
      `Retrack complete. Status: ${result.deliveryStatus ?? 'unknown'}; checkpoints: ${result.checkpointCount}; new events: ${result.eventsInserted}.`,
    );
  } catch (err) {
    const msg =
      err && typeof err === 'object' && 'body' in err
        ? String((err as { body?: { error?: string } }).body?.error ?? 'retrack_failed')
        : 'retrack_failed';
    window.alert(`Retrack failed: ${msg}`);
  } finally {
    retrackBusy.value = false;
  }
}

const canRetrack = computed(() => {
  const s = detail.value?.shipment;
  return s?.aggregator === 'trackingmore' && Boolean(s.tracking_number);
});

const DISPLAY_TZ = 'Asia/Jerusalem';

function formatWhen(value: string | null | undefined) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { timeZone: DISPLAY_TZ });
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: DISPLAY_TZ,
  });
}

function formatDateParts(value: string | null | undefined): { date: string; time: string | null } {
  if (!value) return { date: '—', time: null };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { date: '—', time: null };
  return {
    date: d.toLocaleDateString('en-GB', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: DISPLAY_TZ,
    }),
    time: d.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: DISPLAY_TZ,
    }),
  };
}

function formatDateGmt(value: string | null | undefined) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const date = d.toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: DISPLAY_TZ,
  });
  const time = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: DISPLAY_TZ,
  });
  return `${date} ${time} (Israel)`;
}

function formatTimelineWhen(value: string | null | undefined) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: DISPLAY_TZ,
  });
  const time = d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: DISPLAY_TZ,
  });
  return `${date} at ${time}`;
}

function eventTitle(ev: Record<string, unknown>) {
  const description = typeof ev.description === 'string' ? ev.description.trim() : '';
  if (description) return description;
  const raw = typeof ev.raw_substatus === 'string' ? ev.raw_substatus.trim() : '';
  if (raw) return raw;
  return statusLabel(String(ev.internal_status ?? ''));
}

function eventMeta(ev: Record<string, unknown>) {
  const when = formatTimelineWhen(String(ev.occurred_at ?? ''));
  const loc = typeof ev.location === 'string' ? ev.location.trim() : '';
  if (when && loc) return `${when} · ${loc}`;
  return when || loc || '';
}

function notificationHint(n: Record<string, unknown>) {
  const payload = n.payload;
  if (!payload || typeof payload !== 'object') return '';
  const p = payload as Record<string, unknown>;
  const bits = [
    p.dryRun ? 'dry-run' : null,
    typeof p.email === 'string' ? p.email : null,
    typeof p.trackingNumber === 'string' ? p.trackingNumber : null,
  ].filter(Boolean);
  return bits.join(' · ');
}

async function onReplayNotification(id: string) {
  if (replayBusyId.value) return;
  replayBusyId.value = id;
  try {
    const result = await replayNotification(id);
    if (selectedId.value) {
      detail.value = await fetchShipmentDetail(selectedId.value);
    }
    window.alert(`Replay ${result.status}`);
  } catch (err) {
    const msg =
      err && typeof err === 'object' && 'body' in err
        ? String((err as { body?: { error?: string } }).body?.error ?? 'replay_failed')
        : 'replay_failed';
    window.alert(`Replay failed: ${msg}`);
  } finally {
    replayBusyId.value = null;
  }
}

function progressPercent(rank: unknown) {
  const n = Number(rank);
  if (!Number.isFinite(n) || n <= 0) return 8;
  return Math.min(100, Math.round((n / 90) * 100));
}

function detailValue(value: unknown) {
  if (value == null || value === '') return '—';
  return String(value);
}

function sourceDisplay(source: unknown) {
  if (source === 'shipbob') return 'ShipBob';
  if (source === 'klb') return 'Zenventory';
  return detailValue(source);
}

function sourceLogo(source: string): { src: string; alt: string; className: string } | null {
  if (source === 'shipbob') {
    return { src: '/logos/shipbob.png', alt: 'ShipBob', className: 'source-logo source-logo--shipbob' };
  }
  if (source === 'klb') {
    return {
      src: '/logos/zenventory.png',
      alt: 'Zenventory (KLB)',
      className: 'source-logo source-logo--zenventory',
    };
  }
  return null;
}

function locationChips(shipment: Record<string, unknown>): string[] {
  const chips = shipment.location_chips;
  if (Array.isArray(chips)) return chips.map(String).filter(Boolean);
  return [];
}

onMounted(() => {
  if (typeof route.query.q === 'string' && route.query.q) {
    search.value = route.query.q;
  }
  void load();
});
</script>

<template>
  <AdminLayout title="Shipments">
    <div class="panel">
      <div class="tabs">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="tab"
          :class="{ active: activeTab === tab.key }"
          type="button"
          @click="onTab(tab.key)"
        >
          {{ tab.label }}
          <span>({{ counts[tab.key] ?? 0 }})</span>
        </button>
      </div>
      <div class="toolbar">
        <input
          v-model="search"
          type="search"
          placeholder="Search order #, email, or tracking #"
          @keydown.enter="onSearch"
        />
        <button class="btn secondary" type="button" @click="onSearch">Search</button>
      </div>

      <div v-if="loading" class="empty">Loading…</div>
      <div v-else-if="items.length === 0" class="empty">No shipments match.</div>
      <div v-else class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th>
                <button class="th-btn" type="button" @click="toggleSort('tracking_number')">
                  Carrier / tracking{{ sortIndicator('tracking_number') }}
                </button>
              </th>
              <th>
                <button class="th-btn" type="button" @click="toggleSort('order_number')">
                  Order{{ sortIndicator('order_number') }}
                </button>
              </th>
              <th>
                <button class="th-btn" type="button" @click="toggleSort('internal_status')">
                  Status{{ sortIndicator('internal_status') }}
                </button>
              </th>
              <th>
                <button class="th-btn" type="button" @click="toggleSort('order_created_at')">
                  Order created{{ sortIndicator('order_created_at') }}
                </button>
              </th>
              <th>
                <button class="th-btn" type="button" @click="toggleSort('order_imported_at')">
                  Imported{{ sortIndicator('order_imported_at') }}
                </button>
              </th>
              <th>
                <button class="th-btn" type="button" @click="toggleSort('latest_event_at')">
                  Latest event{{ sortIndicator('latest_event_at') }}
                </button>
              </th>
              <th>
                <button class="th-btn" type="button" @click="toggleSort('source')">
                  Source{{ sortIndicator('source') }}
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in items"
              :key="row.id"
              style="cursor: pointer"
              @click="openDetail(row.id)"
            >
              <td>
                <div class="carrier-cell">
                  <img
                    v-if="carrierLogo(row.carrier_code)"
                    class="carrier-logo"
                    :src="carrierLogo(row.carrier_code)!"
                    :alt="row.carrier_name ?? row.carrier_code ?? 'Carrier'"
                    :title="row.carrier_name ?? row.carrier_code ?? ''"
                    width="36"
                    height="36"
                    loading="lazy"
                    decoding="async"
                  />
                  <div class="carrier-text">
                    <div>{{ row.carrier_name ?? row.carrier_code ?? '—' }}</div>
                    <strong>{{ row.tracking_number ?? '—' }}</strong>
                  </div>
                </div>
              </td>
              <td>
                <div>{{ row.order_number }}</div>
                <div class="muted">{{ row.customer_email ?? '—' }}</div>
              </td>
              <td>
                <span class="status-tag" :class="`status-tag--${statusTone(row.internal_status)}`">
                  {{ statusLabel(row.internal_status) }}
                </span>
                <span v-if="row.is_stalled" class="stalled-chip">Stalled</span>
              </td>
              <td class="date-cell">
                <div v-for="parts in [formatDateParts(row.order_created_at)]" :key="'oc-' + row.id">
                  <div>{{ parts.date }}</div>
                  <div v-if="parts.time" class="muted">{{ parts.time }}</div>
                </div>
              </td>
              <td class="date-cell">
                <div v-for="parts in [formatDateParts(row.order_imported_at)]" :key="'oi-' + row.id">
                  <div>{{ parts.date }}</div>
                  <div v-if="parts.time" class="muted">{{ parts.time }}</div>
                </div>
              </td>
              <td>
                <div>{{ row.latest_event_description ?? '—' }}</div>
                <div class="muted">
                  {{ row.latest_event_location ?? '' }}
                  <template v-if="row.latest_event_at">
                    · {{ formatWhen(row.latest_event_at) }}
                  </template>
                </div>
              </td>
              <td>
                <img
                  v-if="sourceLogo(row.source)"
                  :class="sourceLogo(row.source)!.className"
                  :src="sourceLogo(row.source)!.src"
                  :alt="sourceLogo(row.source)!.alt"
                  :title="sourceLogo(row.source)!.alt"
                />
                <span v-else>{{ row.source }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="pagination">
          <div class="pagination-left">
            <label>
              Per page
              <select v-model.number="pageSize" @change="onPageSizeChange">
                <option v-for="size in pageSizeOptions" :key="size" :value="size">{{ size }}</option>
              </select>
            </label>
            <span class="muted">{{ rangeLabel }}</span>
          </div>
          <div class="pagination-right">
            <button class="btn secondary" type="button" :disabled="page <= 1" @click="goPage(page - 1)">
              Previous
            </button>
            <span class="page-indicator">Page {{ page }} / {{ totalPages }}</span>
            <button
              class="btn secondary"
              type="button"
              :disabled="page >= totalPages"
              @click="goPage(page + 1)"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="detail" class="slide-over-backdrop" @click.self="closeDetail">
      <aside class="slide-over">
        <header class="slide-over-header">
          <div class="header-main">
            <div class="tracking-number">{{ detail.shipment.tracking_number }}</div>
            <div class="header-actions">
              <button
                class="link-btn"
                type="button"
                :disabled="trackingLinkBusy"
                @click="openTrackingPage"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
                  <path
                    d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"
                    stroke="currentColor"
                    stroke-width="1.8"
                  />
                  <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8" />
                </svg>
                {{ trackingLinkBusy ? 'Opening…' : 'View tracking page' }}
              </button>
              <button
                v-if="canRetrack"
                class="link-btn"
                type="button"
                :disabled="retrackBusy"
                @click="onRetrack"
              >
                {{ retrackBusy ? 'Retracking…' : 'Retrack' }}
              </button>
            </div>
          </div>
          <button class="icon-close" type="button" aria-label="Close" @click="closeDetail">×</button>
        </header>

        <div class="slide-over-body">
          <section class="detail-hero">
            <h2 class="detail-status-title">
              {{ statusLabel(String(detail.shipment.internal_status)) }}
            </h2>
            <div class="progress-track" aria-hidden="true">
              <div
                class="progress-fill"
                :style="{ width: `${progressPercent(detail.shipment.status_rank)}%` }"
              />
            </div>
            <div v-if="locationChips(detail.shipment).length" class="location-chips">
              <span
                v-for="chip in locationChips(detail.shipment)"
                :key="chip"
                class="location-chip"
                :title="chip"
              >
                {{ chip }}
              </span>
            </div>
          </section>

          <section class="timeline-section">
            <ol v-if="detail.events.length" class="timeline">
              <li
                v-for="(ev, idx) in visibleEvents"
                :key="String(ev.id)"
                class="timeline-item"
                :class="`timeline-item--${statusTone(String(ev.internal_status))}`"
              >
                <div class="timeline-rail" aria-hidden="true">
                  <span class="timeline-dot">
                    <svg
                      v-if="
                        ['LABEL_CREATED', 'PROCESSING', 'ORDER_RECEIVED'].includes(
                          String(ev.internal_status),
                        )
                      "
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <path
                        d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"
                        stroke="currentColor"
                        stroke-width="1.8"
                      />
                      <path d="M14 3v5h5" stroke="currentColor" stroke-width="1.8" />
                    </svg>
                    <svg
                      v-else-if="ev.internal_status === 'DELIVERED'"
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <path
                        d="M5 13l4 4L19 7"
                        stroke="currentColor"
                        stroke-width="2.2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                    <svg
                      v-else-if="
                        ['EXCEPTION', 'CANCELLED', 'RETURNED_TO_SENDER'].includes(
                          String(ev.internal_status),
                        )
                      "
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <path
                        d="M12 8v5m0 3h.01M12 3l9 16H3L12 3Z"
                        stroke="currentColor"
                        stroke-width="1.8"
                        stroke-linejoin="round"
                      />
                    </svg>
                    <svg v-else viewBox="0 0 24 24" fill="none">
                      <path
                        d="M3 7h11v10H3V7Zm11 3h4l3 3v4h-7V10Z"
                        stroke="currentColor"
                        stroke-width="1.8"
                        stroke-linejoin="round"
                      />
                      <circle cx="7.5" cy="17.5" r="1.5" fill="currentColor" />
                      <circle cx="16.5" cy="17.5" r="1.5" fill="currentColor" />
                    </svg>
                  </span>
                  <span
                    v-if="idx < visibleEvents.length - 1 || (!timelineExpanded && hiddenEventCount > 0)"
                    class="timeline-line"
                  />
                </div>
                <div class="timeline-content">
                  <div class="timeline-meta">{{ eventMeta(ev) }}</div>
                  <div class="timeline-title">{{ eventTitle(ev) }}</div>
                </div>
              </li>
            </ol>
            <button
              v-if="hiddenEventCount > 0"
              class="timeline-toggle"
              type="button"
              @click="timelineExpanded = !timelineExpanded"
            >
              <span class="timeline-toggle-dot" aria-hidden="true" />
              {{ timelineExpanded ? 'Show less' : `Show more updates (${hiddenEventCount})` }}
            </button>
            <p v-if="!detail.events.length" class="muted">No tracking events yet.</p>
          </section>

          <section class="details-card">
            <div class="details-card-header">
              <h3>Klaviyo / notifications</h3>
            </div>
            <ol v-if="detail.notifications?.length" class="notify-timeline">
              <li v-for="n in detail.notifications" :key="String(n.id)">
                <div class="notify-meta">
                  {{ formatWhen(String(n.created_at ?? '')) }}
                  ·
                  <span class="notify-status" :data-status="String(n.status)">{{
                    n.status
                  }}</span>
                  <button
                    class="link-btn notify-replay"
                    type="button"
                    :disabled="replayBusyId === String(n.id)"
                    @click="onReplayNotification(String(n.id))"
                  >
                    {{ replayBusyId === String(n.id) ? 'Replaying…' : 'Replay' }}
                  </button>
                </div>
                <div class="notify-title">{{ String(n.event_type) }}</div>
                <div v-if="notificationHint(n)" class="notify-hint">{{ notificationHint(n) }}</div>
              </li>
            </ol>
            <p v-else class="muted notify-empty">No notification events emitted yet.</p>
          </section>

          <section v-if="detail.events.some((e) => e.raw_payload)" class="details-card">
            <div class="details-card-header">
              <h3>Raw event payloads</h3>
              <button class="link-btn" type="button" @click="rawExpanded = !rawExpanded">
                {{ rawExpanded ? 'Hide' : 'Show' }}
              </button>
            </div>
            <div v-if="rawExpanded" class="raw-payload-list">
              <details v-for="ev in detail.events.filter((e) => e.raw_payload)" :key="String(ev.id)">
                <summary>
                  {{ formatWhen(String(ev.occurred_at ?? '')) }} ·
                  {{ eventTitle(ev) }}
                </summary>
                <pre>{{ JSON.stringify(ev.raw_payload, null, 2) }}</pre>
              </details>
            </div>
          </section>

          <p v-if="detail.shipment.destination_country" class="origin-line">
            Destination country is
            <strong>{{ String(detail.shipment.destination_country).toUpperCase() }}</strong>
          </p>

          <section class="details-card">
            <div class="details-card-header">
              <h3>Shipment details</h3>
            </div>
            <dl class="details-grid">
              <div class="details-row">
                <dt>Tracking number</dt>
                <dd>{{ detailValue(detail.shipment.tracking_number) }}</dd>
              </div>
              <div class="details-row">
                <dt>Courier code</dt>
                <dd>
                  {{
                    detailValue(
                      detail.shipment.trackingmore_code ||
                        detail.shipment.carrier_code ||
                        detail.shipment.carrier_code_resolved,
                    )
                  }}
                </dd>
              </div>
              <div class="details-row">
                <dt>Order number</dt>
                <dd>#{{ detailValue(detail.shipment.order_number) }}</dd>
              </div>
              <div class="details-row">
                <dt>Courier</dt>
                <dd class="courier-dd">
                  <img
                    v-if="carrierLogo(String(detail.shipment.carrier_code ?? ''))"
                    class="carrier-logo carrier-logo--sm"
                    :src="carrierLogo(String(detail.shipment.carrier_code ?? ''))!"
                    :alt="detailValue(detail.shipment.carrier_name || detail.shipment.carrier_code)"
                  />
                  <span>{{ detailValue(detail.shipment.carrier_name || detail.shipment.carrier_code) }}</span>
                </dd>
              </div>
              <div class="details-row">
                <dt>Source</dt>
                <dd>{{ sourceDisplay(detail.shipment.source) }}</dd>
              </div>
              <div class="details-row">
                <dt>Service code</dt>
                <dd>{{ detailValue(detail.shipment.carrier_service) }}</dd>
              </div>
              <div class="details-row">
                <dt>Create date</dt>
                <dd>{{ formatDateGmt(String(detail.shipment.created_at ?? '')) }}</dd>
              </div>
              <div class="details-row">
                <dt>Update date</dt>
                <dd>{{ formatDateGmt(String(detail.shipment.updated_at ?? '')) }}</dd>
              </div>
              <div class="details-row">
                <dt>Transit time</dt>
                <dd>
                  {{
                    detail.shipment.transit_days != null
                      ? `${detail.shipment.transit_days} days`
                      : '—'
                  }}
                </dd>
              </div>
              <div class="details-row">
                <dt>Delivered date</dt>
                <dd>{{ formatDate(String(detail.shipment.delivered_at ?? '')) }}</dd>
              </div>
              <div class="details-row">
                <dt>Pickup date</dt>
                <dd>{{ formatDate(String(detail.shipment.pickup_date ?? '')) }}</dd>
              </div>
              <div class="details-row">
                <dt>Order date</dt>
                <dd>{{ formatDate(String(detail.shipment.ordered_at ?? '')) }}</dd>
              </div>
              <div class="details-row">
                <dt>Estimate Delivery Date</dt>
                <dd>{{ formatDate(String(detail.shipment.edd ?? '')) }}</dd>
              </div>
              <div class="details-row">
                <dt>Customer</dt>
                <dd>
                  {{
                    detail.shipment.customer_name || detail.shipment.customer_email
                      ? [detail.shipment.customer_name, detail.shipment.customer_email]
                          .filter(Boolean)
                          .join(' · ')
                      : 'No customer'
                  }}
                </dd>
              </div>
              <div class="details-row">
                <dt>Destination</dt>
                <dd>
                  {{
                    [detail.shipment.destination_city, detail.shipment.destination_country]
                      .filter(Boolean)
                      .join(', ') || '—'
                  }}
                </dd>
              </div>
            </dl>
          </section>
        </div>
      </aside>
    </div>
  </AdminLayout>
</template>

<style scoped>
.muted {
  color: var(--muted);
  font-size: 0.85rem;
}
.table-scroll {
  overflow-x: auto;
}
.th-btn {
  border: 0;
  background: transparent;
  padding: 0;
  font: inherit;
  font-weight: 600;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.th-btn:hover {
  color: var(--accent);
}
.pagination {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 16px;
  border-top: 1px solid var(--line);
}
.pagination-left,
.pagination-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.pagination select {
  margin-left: 6px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 6px 8px;
  background: #fff;
}
.page-indicator {
  font-size: 0.9rem;
  color: var(--muted);
  min-width: 90px;
  text-align: center;
}
.date-cell {
  white-space: nowrap;
  font-size: 0.9rem;
  line-height: 1.35;
}
.date-cell .muted {
  font-size: 0.82rem;
}
.status-tag {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 600;
  white-space: nowrap;
}
.status-tag--ok {
  background: #e8f7ef;
  color: #0f7a3a;
}
.status-tag--info {
  background: #e8f1fb;
  color: #1d4f91;
}
.status-tag--accent {
  background: #e7f4f1;
  color: #0f6b5c;
}
.status-tag--warn {
  background: #fff4e5;
  color: #9a5b00;
}
.status-tag--danger {
  background: #fdeceb;
  color: #b42318;
}
.status-tag--neutral {
  background: #eef1f5;
  color: #44546a;
}
.stalled-chip {
  margin-left: 6px;
  font-size: 0.75rem;
  color: #9a3412;
}
.source-logo {
  display: block;
  width: auto;
  max-width: 130px;
  object-fit: contain;
}
.source-logo--shipbob {
  height: 22px;
}
.source-logo--zenventory {
  height: 36px;
}
.carrier-cell {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.carrier-logo {
  width: 36px;
  height: 36px;
  object-fit: contain;
  object-position: center;
  flex-shrink: 0;
  border-radius: 6px;
  background: #fff;
}
.carrier-logo--sm {
  width: 24px;
  height: 24px;
}
.carrier-text {
  min-width: 0;
}
.courier-dd {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.slide-over-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(16, 32, 51, 0.35);
  display: flex;
  justify-content: flex-end;
  z-index: 40;
}
.slide-over {
  width: min(460px, 100%);
  height: 100%;
  background: #fff;
  box-shadow: -12px 0 40px rgba(16, 32, 51, 0.12);
  display: flex;
  flex-direction: column;
}
.slide-over-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px 12px;
  border-bottom: 1px solid #eef1f4;
}
.header-main {
  min-width: 0;
}
.tracking-number {
  font-size: 0.98rem;
  font-weight: 500;
  word-break: break-all;
  color: #1a2332;
}
.header-actions {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.link-muted {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #94a3b8;
  font-size: 0.86rem;
}
.link-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  color: #2563eb;
  font: inherit;
  font-size: 0.86rem;
  cursor: pointer;
  padding: 0;
}
.link-btn:disabled {
  opacity: 0.6;
  cursor: wait;
}
.raw-payload-list {
  display: grid;
  gap: 8px;
  padding: 0 14px 14px;
}
.raw-payload-list details {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 8px 10px;
  background: #fafafa;
}
.raw-payload-list summary {
  cursor: pointer;
  font-size: 0.85rem;
  color: #334155;
}
.raw-payload-list pre {
  margin: 8px 0 0;
  max-height: 240px;
  overflow: auto;
  font-size: 0.75rem;
  white-space: pre-wrap;
  word-break: break-word;
}
.notify-timeline {
  list-style: none;
  margin: 0;
  padding: 0 14px 14px;
  display: grid;
  gap: 10px;
}
.notify-meta {
  font-size: 0.78rem;
  color: #64748b;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.notify-replay {
  margin-left: auto;
}
.notify-title {
  font-weight: 600;
  font-size: 0.92rem;
  color: #1e293b;
}
.notify-hint {
  font-size: 0.8rem;
  color: #64748b;
  margin-top: 2px;
}
.notify-status {
  text-transform: uppercase;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.notify-status[data-status='sent'] {
  color: #15803d;
}
.notify-status[data-status='pending'] {
  color: #b45309;
}
.notify-status[data-status='failed'] {
  color: #b91c1c;
}
.notify-empty {
  padding: 0 14px 14px;
}
.icon-close {
  border: 0;
  background: transparent;
  font-size: 1.6rem;
  line-height: 1;
  cursor: pointer;
  color: #667085;
  padding: 0 4px;
}
.slide-over-body {
  padding: 16px 18px 28px;
  overflow: auto;
}
.detail-hero {
  margin-bottom: 18px;
}
.detail-status-title {
  margin: 0 0 12px;
  font-size: 1.45rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.progress-track {
  height: 4px;
  border-radius: 999px;
  background: #e8edf2;
  overflow: hidden;
  margin-bottom: 12px;
}
.progress-fill {
  height: 100%;
  border-radius: 999px;
  background: #94a3b8;
}
.location-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.location-chip {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid #e5eaf0;
  background: #f8fafc;
  color: #475569;
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 0.78rem;
}
.timeline-section {
  padding-bottom: 8px;
}
.timeline {
  list-style: none;
  padding: 0;
  margin: 0;
}
.timeline-item {
  display: grid;
  grid-template-columns: 28px 1fr;
  gap: 12px;
}
.timeline-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.timeline-dot {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: #dbeafe;
  color: #2563eb;
  flex-shrink: 0;
}
.timeline-dot svg {
  width: 14px;
  height: 14px;
}
.timeline-item--ok .timeline-dot {
  background: #dcfce7;
  color: #15803d;
}
.timeline-item--warn .timeline-dot {
  background: #ffedd5;
  color: #c2410c;
}
.timeline-item--danger .timeline-dot {
  background: #fee2e2;
  color: #b91c1c;
}
.timeline-item--neutral .timeline-dot {
  background: #1d4ed8;
  color: #fff;
}
.timeline-line {
  width: 2px;
  flex: 1;
  min-height: 28px;
  background: #e2e8f0;
  margin: 4px 0;
}
.timeline-content {
  padding-bottom: 16px;
}
.timeline-meta {
  color: #94a3b8;
  font-size: 0.8rem;
  margin-bottom: 4px;
  line-height: 1.4;
}
.timeline-title {
  font-size: 0.98rem;
  font-weight: 700;
  color: #0f172a;
  line-height: 1.35;
}
.timeline-toggle {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  border: 0;
  background: transparent;
  color: #3b82f6;
  font-size: 0.88rem;
  cursor: pointer;
  padding: 4px 0 12px;
}
.timeline-toggle-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid #93c5fd;
  background: #fff;
  margin-left: 7px;
}
.origin-line {
  margin: 8px 0 18px;
  padding: 12px 0;
  border-top: 1px solid #eef1f4;
  border-bottom: 1px solid #eef1f4;
  color: #64748b;
  font-size: 0.9rem;
}
.details-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  padding: 14px 14px 0;
}
.details-card-header h3 {
  margin: 0;
  font-size: 1rem;
}
.details-grid {
  margin: 0;
}
.details-row {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid #f1f5f9;
  font-size: 0.9rem;
}
.details-row dt {
  color: #64748b;
}
.details-row dd {
  margin: 0;
  color: #0f172a;
  word-break: break-word;
  text-align: right;
}
</style>
