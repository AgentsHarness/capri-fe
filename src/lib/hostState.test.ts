import { describe, expect, it } from 'vitest'
import {
  hostSignal,
  hostSignalLabel,
  hostState,
  hostStateLabel,
  otherHostsSignal,
  type HostSignal,
  type HostState,
} from './hostState'

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

describe('hostSignal（顶栏状态点）', () => {
  it('离线优先于 busy；在线时 busy → 正忙，否则空闲', () => {
    expect(hostSignal({ online: false, busy: true })).toBe('offline')
    expect(hostSignal({ online: true, busy: true })).toBe('busy')
    expect(hostSignal({ online: true, busy: false })).toBe('idle')
    expect(hostSignal({ online: true })).toBe('idle')
  })

  it('label 映射完整', () => {
    const want: Record<HostSignal, string> = {
      error: '错误',
      warning: '警告',
      busy: '正忙',
      idle: '空闲',
      offline: '离线',
    }
    for (const [s, label] of Object.entries(want)) {
      expect(hostSignalLabel(s as HostSignal)).toBe(label)
    }
  })
})

describe('otherHostsSignal（左侧聚合点）', () => {
  const h = (hostId: string, online: boolean, busy = false) => ({
    hostId,
    hostName: hostId,
    online,
    busy,
  })

  it('任意其他 Host 正忙 → 正忙（优先级最高，哪怕同时有离线）', () => {
    expect(
      otherHostsSignal([h('a', false, true), h('b', true), h('c', true, true)], 'a'),
    ).toBe('busy')
  })

  it('没有正忙但有在线 → 空闲', () => {
    expect(otherHostsSignal([h('a', true), h('b', true), h('c', false)], 'a')).toBe('idle')
  })

  it('没有其他 Host 或全部离线 → 离线', () => {
    expect(otherHostsSignal([], 'a')).toBe('offline')
    expect(otherHostsSignal([h('a', true)], 'a')).toBe('offline')
    expect(otherHostsSignal([h('a', true), h('b', false)], 'a')).toBe('offline')
  })

  it('排除当前 Host 自己的状态', () => {
    expect(otherHostsSignal([h('a', true, true), h('b', true)], 'a')).toBe('idle')
    expect(otherHostsSignal([h('a', true, true)], 'a')).toBe('offline')
  })
})
