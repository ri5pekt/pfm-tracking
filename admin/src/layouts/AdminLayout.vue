<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { fetchMe, fetchVersion, logout, type AdminUser } from '../api';

defineProps<{ title?: string }>();

const router = useRouter();
const user = ref<AdminUser | null>(null);
const version = ref<{ version: string; gitSha: string } | null>(null);

onMounted(async () => {
  const me = await fetchMe();
  user.value = me.user;
  version.value = await fetchVersion();
});

async function onLogout() {
  await logout();
  router.push('/login');
}
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">PFM Tracking</div>
      <RouterLink class="nav-link" to="/dashboard">Dashboard</RouterLink>
      <RouterLink class="nav-link" to="/shipments">Shipments</RouterLink>
      <RouterLink class="nav-link" to="/sync-runs">Sync runs</RouterLink>
      <RouterLink class="nav-link" to="/reports">Reports</RouterLink>
      <RouterLink class="nav-link" to="/status-mappings">Status maps</RouterLink>
      <RouterLink class="nav-link" to="/data-quality">Data quality</RouterLink>
      <RouterLink v-if="user?.role === 'admin'" class="nav-link" to="/users">Users</RouterLink>
    </aside>
    <div class="main">
      <header class="topbar">
        <strong>{{ title ?? 'Admin' }}</strong>
        <div style="display: flex; gap: 10px; align-items: center">
          <span style="color: var(--muted); font-size: 0.9rem">{{ user?.email }}</span>
          <button class="btn secondary" type="button" @click="onLogout">Log out</button>
        </div>
      </header>
      <div class="content">
        <slot />
      </div>
      <footer class="footer">
        v{{ version?.version ?? '…' }} · {{ version?.gitSha ?? '…' }}
      </footer>
    </div>
  </div>
</template>
