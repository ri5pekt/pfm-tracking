import { createRouter, createWebHashHistory } from 'vue-router';
import LoginView from './views/LoginView.vue';
import ShipmentsView from './views/ShipmentsView.vue';
import UsersView from './views/UsersView.vue';
import AcceptInviteView from './views/AcceptInviteView.vue';
import { fetchMe } from './api';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', component: LoginView, meta: { public: true } },
    { path: '/accept-invite', component: AcceptInviteView, meta: { public: true } },
    { path: '/', redirect: '/shipments' },
    { path: '/shipments', component: ShipmentsView },
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
