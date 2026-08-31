import { describe, expect, it } from 'vitest'
import { hostState, hostStateLabel, type HostState } from './hostState'

const base = { hostId: 'h1', hostName: 'H', online: true }

describe('hostState', () => {
  it('旧 hub（无 busy/booting/pendingCount 字段）不派生状态，退回原样', () => {
    expect(hostState(base)).toBeUndefined()
    expect(hostState({ ...base, ready: true })).toBeUndefined()
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