import { describe, expect, it } from 'vitest'
import { THEMES, getTheme, resolveThemeId } from './palettes'
import { tokensToCssVars, applyTokens } from './tokens'

describe('THEMES 注册表', () => {
  it('五个主题，首个为 groknight（默认）', () => {
    expect(THEMES.map((t) => t.id)).toEqual([
      'groknight',
      'grokday',
      'tokyonight',
      'rosepine-moon',
      'oscura-midnight',
    ])
    expect(THEMES[0].polarity).toBe('dark')
    expect(THEMES[1].polarity).toBe('light')
  })

  it('每个主题 token 齐全（hex 格式）', () => {
    for (const t of THEMES) {
      expect(Object.keys(t.tokens).length).toBeGreaterThan(30)
      expect(t.tokens.bg).toMatch(/^#[0-9a-f]{6}$/)
      expect(t.tokens.fg).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})

describe('getTheme', () => {
  it('按 id 取主题；未知 id 回退默认', () => {
    expect(getTheme('tokyonight').name).toBe('Tokyo Night')
    expect(getTheme('groknight').id).toBe('groknight')
    // @ts-expect-error 未知 id
    expect(getTheme('nope').id).toBe('groknight')
  })
})

describe('resolveThemeId', () => {
  it('具体偏好原样返回', () => {
    expect(resolveThemeId('grokday')).toBe('grokday')
    expect(resolveThemeId('oscura-midnight')).toBe('oscura-midnight')
  })

  it('auto → 跟随 prefers-color-scheme', () => {
    const original = window.matchMedia
    const stub = (matches: boolean) => {
      window.matchMedia = (() => ({
        matches,
        addEventListener: () => {},
        removeEventListener: () => {},
      })) as unknown as typeof window.matchMedia
    }

    try {
      stub(true)
      expect(resolveThemeId('auto')).toBe('groknight')
      stub(false)
      expect(resolveThemeId('auto')).toBe('grokday')
    } finally {
      window.matchMedia = original
    }
  })
})

describe('tokensToCssVars / applyTokens', () => {
  it('映射 CSS 变量键名', () => {
    const vars = tokensToCssVars(THEMES[0].tokens)
    expect(vars['--color-gn-bg']).toBe(THEMES[0].tokens.bg)
    expect(vars['--color-gn-accent-running']).toBe(THEMES[0].tokens.magenta)
    expect(vars['--color-gn-warning']).toBe(THEMES[0].tokens.yellow)
  })

  it('applyTokens 写入 document 样式', () => {
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.appendChild(meta)
    applyTokens(THEMES[2].tokens, 'dark')
    const root = document.documentElement.style
    expect(root.getPropertyValue('--color-gn-bg')).toBe(THEMES[2].tokens.bg)
    expect(root.colorScheme).toBe('dark')
    // jsdom 会把 hex 序列化为 rgb
    expect(document.body.style.background).toBe('rgb(36, 40, 59)')
    expect(document.body.style.color).toBe('rgb(192, 202, 245)')
    expect(meta.getAttribute('content')).toBe(THEMES[2].tokens.bgDark)
    document.head.removeChild(meta)
  })
})