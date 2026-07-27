<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { login } from '../api';

const email = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);
const router = useRouter();
const route = useRoute();

async function onSubmit() {
  error.value = '';
  loading.value = true;
  try {
    await login(email.value, password.value);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/shipments';
    await router.push(redirect);
  } catch {
    error.value = 'Invalid email or password.';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="auth-shell">
    <form class="auth-card" @submit.prevent="onSubmit">
      <h1>PFM Tracking</h1>
      <p>Sign in to the admin dashboard. No self-signup.</p>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="field">
        <label for="email">Email</label>
        <input id="email" v-model="email" type="email" required autocomplete="username" />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input
          id="password"
          v-model="password"
          type="password"
          required
          autocomplete="current-password"
        />
      </div>
      <button class="btn" type="submit" :disabled="loading">
        {{ loading ? 'Signing in…' : 'Sign in' }}
      </button>
    </form>
  </div>
</template>
