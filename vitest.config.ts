import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// 独立于 vite.config.ts：主配置面向 rolldown 产物拆包（vendor chunk 分组、
// dev proxy），测试运行不需要也不应解析它们。vitest.config.ts 存在时
// vitest 优先使用本文件（vite.config.ts 完全被忽略）。
export default defineConfig({
  plugins: [react()],
  define: {
    // SettingsModal 等组件读取构建注入的版本号；测试环境给固定值。
    __APP_VERSION__: JSON.stringify('test'),
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/**/*.d.ts', 'src/test/**'],
      reporter: ['text', 'html', 'lcov'],
      // 以分支覆盖为准的棘轮：行覆盖只证明代码被执行过，分支才区分条件。
      // 历史上两者曾相差 10 个百分点（行 73% / 分支 63%），大量用例只
      // 走了 happy path。门槛钉在当前实测值下方一点点，只允许往上走。
      // 提升覆盖率时请同步抬高这两个数字。
      thresholds: {
        lines: 73,
        branches: 63,
      },
    },
  },
})
