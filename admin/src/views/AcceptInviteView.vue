<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { acceptInvite } from '../api';

const route = useRoute();
const router = useRouter();
const password = ref('');
const error = ref('');
const loading = ref(false);
const token = typeof route.query.token === 'string' ? route.query.token : '';

async function onSubmit() {
  error.value = '';
  if (!token) {
    error.value = 'Missing invite token.';
    return;
  }
  loading.value = true;
  try {
    await acceptInvite(token, password.value);
    await router.push('/shipments');
  } catch {
    error.value = 'Invite is invalid or expired.';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="auth-shell">
    <form class="auth-card" @submit.prevent="onSubmit">
      <h1>Accept invite</h1>
      <p>Choose a password to activate your admin account.</p>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="field">
        <label for="password">Password (min 8 characters)</label>
        <input
          id="password"
          v-model="password"
          type="password"
          required
          minlength="8"
          autocomplete="new-password"
        />
      </div>
      <button class="btn" type="submit" :disabled="loading || !token">
        {{ loading ? 'Activating…' : 'Activate account' }}
      </button>
    </form>
  </div>
</template>
