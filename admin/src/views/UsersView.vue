<script setup lang="ts">
import { onMounted, ref } from 'vue';
import AdminLayout from '../layouts/AdminLayout.vue';
import { inviteUser, listUsers } from '../api';

const users = ref<
  Array<{
    id: string;
    email: string;
    role: string;
    status: string;
    last_login_at: string | null;
    created_at: string;
  }>
>([]);
const email = ref('');
const role = ref<'admin' | 'staff'>('staff');
const error = ref('');
const inviteResult = ref<{ acceptUrl: string; acceptToken: string } | null>(null);
const loading = ref(false);

async function refresh() {
  const data = await listUsers();
  users.value = data.users;
}

onMounted(refresh);

async function onInvite() {
  error.value = '';
  inviteResult.value = null;
  loading.value = true;
  try {
    const result = await inviteUser(email.value, role.value);
    inviteResult.value = { acceptUrl: result.acceptUrl, acceptToken: result.acceptToken };
    email.value = '';
    await refresh();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Invite failed';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <AdminLayout title="Users">
    <div class="panel" style="padding: 16px; margin-bottom: 16px">
      <h2 style="margin: 0 0 12px; font-size: 1.05rem">Invite user</h2>
      <p v-if="error" class="error">{{ error }}</p>
      <form
        style="display: flex; gap: 10px; flex-wrap: wrap; align-items: end"
        @submit.prevent="onInvite"
      >
        <div class="field" style="margin: 0; flex: 1; min-width: 200px">
          <label for="invite-email">Email</label>
          <input id="invite-email" v-model="email" type="email" required />
        </div>
        <div class="field" style="margin: 0; min-width: 140px">
          <label for="invite-role">Role</label>
          <select id="invite-role" v-model="role">
            <option value="staff">Staff</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <button class="btn" type="submit" :disabled="loading">
          {{ loading ? 'Sending…' : 'Create invite' }}
        </button>
      </form>
      <div v-if="inviteResult" class="invite-box">
        Share this one-time link (also shown once in the API response):
        <br />
        <a :href="inviteResult.acceptUrl">{{ inviteResult.acceptUrl }}</a>
      </div>
    </div>

    <div class="panel">
      <table class="table">
        <thead>
          <tr>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
            <th>Last login</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td>{{ u.email }}</td>
            <td>{{ u.role }}</td>
            <td>{{ u.status }}</td>
            <td>{{ u.last_login_at ? new Date(u.last_login_at).toLocaleString() : '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </AdminLayout>
</template>
