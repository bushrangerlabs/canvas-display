import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],
  // The SPA owns nested routes such as /display/scenes/:id. Root-relative
  // assets prevent those routes from resolving bundles under /display/scenes/assets.
  base: '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    // Always emit to web/dist. The release step copies this into core/public/.
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Proxy API calls to Core in dev.
      '/api': 'http://localhost:3100',
      '/health': 'http://localhost:3100',
      '/ws': { target: 'ws://localhost:3100', ws: true },
    },
  },
}))
