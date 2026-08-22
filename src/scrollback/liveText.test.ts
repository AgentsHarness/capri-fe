import { describe, expect, it } from 'vitest'
import { mergeLiveText } from './liveText'

describe('mergeLiveText', () => {
  it('base + live 后缀追加', () => {
    expect(mergeLiveText('base', 'tail')).toBe('basetail')
  })

  it('live 为 null / undefined 时只保留 base', () => {
    expect(mergeLiveText('base', null)).toBe('base')
    expect(mergeLiveText('base', undefined)).toBe('base')
  })

  it('live 与 base 都为空字符串', () => {
    expect(mergeLiveText('', '')).toBe('')
    expect(mergeLiveText('a', '')).toBe('a')
  })
})