<script setup lang="ts">
import { onMounted, ref } from 'vue';
import AdminLayout from '../layouts/AdminLayout.vue';
import { fetchShipments } from '../api';

const counts = ref<Record<string, number>>({});
const activeTab = ref('all');

const tabs = [
  { key: 'all', label: 'All' },
  { key: 'exception', label: 'Exception' },
  { key: 'stalled', label: 'Stalled' },
  { key: 'out_for_delivery', label: 'Out for delivery' },
  { key: 'in_transit', label: 'In transit' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'cancelled', label: 'Cancelled' },
];

onMounted(async () => {
  const data = await fetchShipments();
  counts.value = data.counts;
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
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
          <span>({{ counts[tab.key] ?? 0 }})</span>
        </button>
      </div>
      <div class="toolbar">
        <input type="search" placeholder="Search order #, email, or tracking #" disabled />
      </div>
      <div class="empty">
        No shipments yet. Phase 1 will sync ShipBob orders into this list.
      </div>
    </div>
  </AdminLayout>
</template>
