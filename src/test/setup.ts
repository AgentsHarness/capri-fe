import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// React 19 的 act 环境标记。threads 池下 RTL 不会替我们设置，
// 缺了会让组件测试刷出大量 "not configured to support act(...)"。
const reactTestEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
reactTestEnv.IS_REACT_ACT_ENVIRONMENT = true

// vitest 以 globals:false 运行时 RTL 不会自动注册 cleanup，手动挂上。
// 纯逻辑测试跑在 node 环境（没有 window），只跳过 DOM 清理部分。
afterEach(() => {
  cleanup()
  if (typeof window === 'undefined') return
  // storage.ts 的 KV 缓存直连 jsdom localStorage，逐测试清空以防
  // historyPins / theme 等持久化键跨测试串味。
  window.localStorage.clear()
  window.sessionStorage.clear()
})
