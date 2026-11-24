import { afterEach, describe, expect, it, vi } from 'vitest'
import { idempotentBody, newIdempotencyKey } from './idempotency'

describe('newIdempotencyKey', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('优先 UUID v4', () => {
    expect(newIdempotencyKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('无 crypto.randomUUID 时回退到随机串 + 计数器（满足 1..128 且不重复）', () => {
    vi.stubGlobal('crypto', {})
    const a = newIdempotencyKey()
    const b = newIdempotencyKey()
    expect(a).toMatch(/^idem_[a-z0-9-]+$/)
    expect(a.length).toBeGreaterThan(0)
    expect(a.length).toBeLessThanOrEqual(128)
    expect(b).not.toBe(a)
  })
})

describe('idempotentBody', () => {
  it('拆出调用方键，其余字段原样作为 body', () => {
    expect(idempotentBody({ cwd: '/w', idempotencyKey: 'k-1' })).toEqual({
      body: { cwd: '/w' },
      idempotencyKey: 'k-1',
    })
  })

  it('没有键就现 mint，且键不进 body', () => {
    const { body, idempotencyKey } = idempotentBody({ cwd: '/w' })
    expect(body).toEqual({ cwd: '/w' })
    expect(body).not.toHaveProperty('idempotencyKey')
    expect(idempotencyKey).toEqual(expect.any(String))
  })
})
