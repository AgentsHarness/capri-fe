import { describe, expect, it } from 'vitest'
import { pickLayerError } from './layerErr'
import type { LayerErr } from '../store/chat/types'

function err(over: Partial<LayerErr> = {}): LayerErr {
  return { level: 'warning', message: 'm', at: 1, ...over }
}

describe('pickLayerError', () => {
  it('两层都空 → null', () => {
    expect(pickLayerError({})).toBeNull()
  })

  it('error 优先于 warning，与 at 无关', () => {
    const picked = pickLayerError({
      hub: err({ level: 'warning', message: '旧警告', at: 900 }),
      host: err({ level: 'error', message: '新错误', at: 1 }),
    })
    expect(picked?.layer).toBe('host')
    expect(picked?.err.message).toBe('新错误')
  })

  it('同为 warning 时取 at 较新的一条', () => {
    const picked = pickLayerError({
      hub: err({ message: 'hub 旧', at: 100 }),
      host: err({ message: 'host 新', at: 200 }),
    })
    expect(picked?.layer).toBe('host')
    expect(picked?.err.message).toBe('host 新')
  })

  it('只有一层有错 → 取该层', () => {
    expect(pickLayerError({ hub: err({ level: 'error' }) })?.layer).toBe('hub')
  })
})
