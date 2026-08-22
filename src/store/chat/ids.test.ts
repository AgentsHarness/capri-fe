import { describe, expect, it } from 'vitest'
import { nid } from './ids'

describe('nid', () => {
  it('生成 e_ 前缀 + 递增序号 + 时间戳', () => {
    const a = nid()
    const b = nid()
    expect(a).toMatch(/^e_\d+_\d+$/)
    expect(b).toMatch(/^e_\d+_\d+$/)
    expect(a).not.toBe(b)
  })
})