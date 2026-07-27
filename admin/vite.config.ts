import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/admin': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/t': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/lookup': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/go': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/products': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/brand': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
