import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      // Local mode: forward API/SSE to acp-host.
      // Hub mode: VITE_PROXY_TARGET=http://localhost:8787 npm run dev
      '/api': { target: process.env.VITE_PROXY_TARGET || 'http://localhost:8765', changeOrigin: true },
      '/events': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:8765',
        changeOrigin: true,
        ws: false,
      },
    },
  },
})
