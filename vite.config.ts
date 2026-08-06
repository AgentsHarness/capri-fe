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
      // Local mode: forward API/SSE to acp-host
      '/api': { target: 'http://localhost:8765', changeOrigin: true },
      '/events': { target: 'http://localhost:8765', changeOrigin: true, ws: false },
    },
  },
})
