import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    // Build-stamped version (set by scripts/deploy-fe-hub.sh; 'dev' otherwise).
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION || 'dev'),
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      // Local mode: forward API/SSE to capri-host.
      // Hub mode: VITE_PROXY_TARGET=http://localhost:8787 npm run dev
      '/api': { target: process.env.VITE_PROXY_TARGET || 'http://localhost:8765', changeOrigin: true },
      // Hub live stream (WebSocket). Local host has no /ws/fe — FE falls back to SSE.
      '/ws/fe': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:8765',
        changeOrigin: true,
        ws: true,
      },
      // Local capri-host live stream (SSE).
      '/events': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:8765',
        changeOrigin: true,
        ws: false,
      },
    },
  },
})
