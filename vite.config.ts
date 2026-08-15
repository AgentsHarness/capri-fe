import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rolldownOptions: {
      output: {
        // 主 chunk 拆 vendor：react 系与 markdown 栈各归一组独立 chunk。
        // 收益在缓存——vendor 只在依赖升级时重下，日常发版只更新小的
        // 业务 chunk；顺带把主 chunk 压回 500 kB 警告线内。
        // 注意：test 必须精确到包名，绝不能用 /node_modules/ 裸匹配——
        // 会把 mermaid/katex 的懒加载 chunk 合并进 vendor，破坏按需加载。
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /node_modules[\\/](react|react-dom|scheduler|use-sync-external-store)[\\/]/,
            },
            {
              name: 'markdown-vendor',
              test: /node_modules[\\/](react-markdown|remark[^/]*|rehype[^/]*|micromark[^/]*|mdast-util-[^/]*|hast-util-[^/]*|unist-util-[^/]*|unified|vfile[^/]*|highlight\.js|lowlight|comma-separated-tokens|property-information|space-separated-tokens|stringify-entities|parse-entities|character-entities|decode-named-character-reference|ccount|escape-string-regexp|is-plain-obj|trough|bail|devlop|trim-lines|zwitch|html-void-elements)[\\/]/,
            },
          ],
        },
      },
    },
  },
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
