import { describe, expect, it } from 'vitest'
import { hostState, hostStateLabel, type HostState } from './hostState'

const base = { hostId: 'h1', hostName: 'H', online: true }

describe('hostState', () => {
  it('在线且无任何实时旗标 → idle（v2 hub 空闲时省略 busy/booting/pendingCount）', () => {
    expect(hostState(base)).toBe('idle')
    expect(hostState({ ...base, ready: true })).toBe('idle')
    expect(hostStateLabel(undefined)).toBeUndefined()
  })

  it('离线始终无状态（不显示思考中/待处理）', () => {
    expect(hostState({ ...base, online: false, busy: true })).toBeUndefined()
  })

  it('优先级：booting > busy > pending > idle', () => {
    expect(hostState({ ...base, booting: true, busy: true, pendingCount: 1 })).toBe('booting')
    expect(hostState({ ...base, busy: true, pendingCount: 1 })).toBe('thinking')
    expect(hostState({ ...base, busy: false, pendingCount: 1 })).toBe('pending')
    expect(hostState({ ...base, busy: false, pendingCount: 0 })).toBe('idle')
  })

  it('ready=false 视为启动中（agent 未就绪）', () => {
    expect(hostState({ ...base, ready: false, busy: false })).toBe('booting')
    expect(hostState({ ...base, ready: false, busy: true })).toBe('booting')
  })

  it('label 映射完整', () => {
    const want: Record<HostState, string> = {
      thinking: '思考中',
      pending: '待处理',
      booting: '启动中',
      idle: '空闲',
    }
    for (const [s, label] of Object.entries(want)) {
      expect(hostStateLabel(s as HostState)).toBe(label)
    }
  })
})