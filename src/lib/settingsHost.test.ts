import { describe, expect, it } from 'vitest'
import { settingsHostTarget } from './settingsHost'

describe('settingsHostTarget', () => {
  it('页面自身是 capri-host 时以它为准', () => {
    expect(settingsHostTarget('', 'mba')).toBe('mba')
    // 手工改了 URL 也不能把设置页带去别的 Host。
    expect(settingsHostTarget('?host=mbp', 'mba')).toBe('mba')
  })

  it('页面没有自身近路时用 tray 带上的 host 兜底', () => {
    expect(settingsHostTarget('?host=mbp', null)).toBe('mbp')
    expect(settingsHostTarget('?host=%20mbp%20', null)).toBe('mbp')
  })

  it('两处都没有 → null（调用方保持现状）', () => {
    expect(settingsHostTarget('', null)).toBeNull()
    expect(settingsHostTarget('?host=', null)).toBeNull()
  })
})
