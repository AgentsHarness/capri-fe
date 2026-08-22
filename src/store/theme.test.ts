import { describe, expect, it } from 'vitest'
import { useThemeStore } from './theme'

function stubMatchMedia(matches: boolean): () => void {
  const original = window.matchMedia
  window.matchMedia = (() => ({
    matches,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
  return () => {
    window.matchMedia = original
  }
}

describe('useThemeStore', () => {
  it('默认 groknight', () => {
    expect(useThemeStore.getState().preference).toBe('groknight')
    expect(useThemeStore.getState().resolved).toBe('groknight')
  })

  it('setTheme 持久化 + 应用主题 + 更新 dataset', () => {
    useThemeStore.getState().setTheme('grokday')
    const st = useThemeStore.getState()
    expect(st.preference).toBe('grokday')
    expect(st.resolved).toBe('grokday')
    expect(window.localStorage.getItem('capri-fe.theme')).toBe('grokday')
    expect(document.documentElement.dataset.theme).toBe('grokday')
    expect(document.documentElement.dataset.polarity).toBe('light')
  })

  it('setTheme(auto) → 解析到系统主题', () => {
    const restore = stubMatchMedia(true)
    try {
      useThemeStore.getState().setTheme('auto')
      expect(useThemeStore.getState().preference).toBe('auto')
      expect(useThemeStore.getState().resolved).toBe('groknight')
      expect(document.documentElement.dataset.theme).toBe('groknight')
    } finally {
      restore()
    }
  })

  it('syncSystem 仅 auto 时重新解析', () => {
    const restore = stubMatchMedia(false)
    try {
      useThemeStore.getState().setTheme('auto')
      expect(useThemeStore.getState().resolved).toBe('grokday')
      useThemeStore.getState().setTheme('tokyonight')
      // 非 auto → syncSystem 不动作
      useThemeStore.getState().syncSystem()
      expect(useThemeStore.getState().resolved).toBe('tokyonight')
    } finally {
      restore()
    }
  })

  it('init 从 localStorage 读取偏好并订阅系统变化', () => {
    window.localStorage.setItem('capri-fe.theme', 'rosepine-moon')
    const restore = stubMatchMedia(true)
    try {
      const off = useThemeStore.getState().init()
      expect(useThemeStore.getState().preference).toBe('rosepine-moon')
      expect(useThemeStore.getState().resolved).toBe('rosepine-moon')
      off()
    } finally {
      restore()
    }
  })

  it('init 缺省 → groknight', () => {
    window.localStorage.removeItem('capri-fe.theme')
    const restore = stubMatchMedia(false)
    try {
      useThemeStore.getState().init()
      expect(useThemeStore.getState().preference).toBe('groknight')
    } finally {
      restore()
    }
  })
})