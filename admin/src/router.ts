import { createRouter, createWebHashHistory } from 'vue-router';
import LoginView from './views/LoginView.vue';
import DashboardView from './views/DashboardView.vue';
import DataQualityView from './views/DataQualityView.vue';
import StatusMappingsView from './views/StatusMappingsView.vue';
import ReportsView from './views/ReportsView.vue';
import ShipmentsView from './views/ShipmentsView.vue';
import SyncRunsView from './views/SyncRunsView.vue';
import UsersView from './views/UsersView.vue';
import AcceptInviteView from './views/AcceptInviteView.vue';
import { fetchMe } from './api';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', component: LoginView, meta: { public: true } },
    { path: '/accept-invite', component: AcceptInviteView, meta: { public: true } },
    { path: '/', redirect: '/dashboard' },
    { path: '/dashboard', component: DashboardView },
    { path: '/shipments', component: ShipmentsView },
    { path: '/sync-runs', component: SyncRunsView },
    { path: '/reports', component: ReportsView },
    { path: '/status-mappings', component: StatusMappingsView },
    { path: '/data-quality', component: DataQualityView },
    { path: '/users', component: UsersView },
  ],
});

router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  try {
    await fetchMe();
    return true;
  } catch {
    return { path: '/login', query: { redirect: to.fullPath } };
  }
});
