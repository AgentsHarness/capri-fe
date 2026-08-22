import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// vitest 以 globals:false 运行时 RTL 不会自动注册 cleanup，手动挂上
// （当前只写纯逻辑单测，组件测试落地后即生效）。
afterEach(() => {
  cleanup()
  // storage.ts 的 KV 缓存直连 jsdom localStorage，逐测试清空以防
  // historyPins / theme 等持久化键跨测试串味。
  window.localStorage.clear()
})
