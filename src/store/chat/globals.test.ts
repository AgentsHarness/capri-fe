import { beforeEach, describe, expect, it } from 'vitest'
import {
  NOTICE_DEDUP_WINDOW_MS,
  HISTORY_WINDOW_BUFFER_CAP,
  runtime,
  captureAsyncScope,
  isAsyncScopeCurrent,
  bufferHistoryWindowEvent,
  clearHistoryWindowBuffer,
  clearContinueSessionTimer,
  clearPeerSessionLoad,
  dropLiveCoveredBySnapshot,
} from './globals'
import type { ChatState } from './types'

const fakeState = (patch: Record<string, unknown>) => patch as unknown as ChatState

describe('globals 常量', () => {
  it('通知去重窗口与缓冲上限', () => {
    expect(NOTICE_DEDUP_WINDOW_MS).toBe(30_000)
    expect(HISTORY_WINDOW_BUFFER_CAP).toBe(2000)
  })
})

describe('captureAsyncScope / isAsyncScopeCurrent', () => {
  beforeEach(() => {
    runtime.sessionSwitchGen = 0
  })

  it('捕获 generation + host/session/cwd 身份', () => {
    const get = () =>
      fakeState({ selectedHostId: 'h1', hostId: 'h1', sessionId: 's1', cwd: '/w' })
    expect(captureAsyncScope(get, 's1', '/w')).toEqual({
      generation: 0,
      selectedHostId: 'h1',
      hostId: 'h1',
      sessionId: 's1',
      cwd: '/w',
    })
    // 不传 session/cwd 时不带这两个键
    expect(captureAsyncScope(get)).toEqual({
      generation: 0,
      selectedHostId: 'h1',
      hostId: 'h1',
    })
  })

  it('generation 变化 → 失效', () => {
    const get = () => fakeState({ sessionId: 's1', cwd: '/w' })
    const scope = captureAsyncScope(get, 's1', '/w')
    runtime.sessionSwitchGen = 1
    expect(isAsyncScopeCurrent(get, scope)).toBe(false)
  })

  it('host 切换 → 失效；session/cwd 不符 → 失效', () => {
    const scope = captureAsyncScope(() => fakeState({}), 's1', '/w')
    expect(isAsyncScopeCurrent(() => fakeState({ selectedHostId: 'h2' }), scope)).toBe(false)
    expect(isAsyncScopeCurrent(() => fakeState({ hostId: 'h2' }), scope)).toBe(false)
    expect(
      isAsyncScopeCurrent(() => fakeState({ sessionId: 's2' }), scope),
    ).toBe(false)
    expect(isAsyncScopeCurrent(() => fakeState({ cwd: '/x' }), scope)).toBe(false)
  })

  it('全部一致 → 有效', () => {
    const get = () => fakeState({ hostId: 'h1', sessionId: 's1', cwd: '/w' })
    const scope = captureAsyncScope(get, 's1', '/w')
    expect(isAsyncScopeCurrent(get, scope)).toBe(true)
  })
})

describe('historyWindowBuffer', () => {
  beforeEach(() => clearHistoryWindowBuffer())

  it('入队 + 超限丢弃', () => {
    bufferHistoryWindowEvent({ type: 'chunk', text: 'a' } as never)
    expect(runtime.historyWindowBuffer).toHaveLength(1)
    for (let i = 0; i < HISTORY_WINDOW_BUFFER_CAP; i++) {
      bufferHistoryWindowEvent({ type: 'chunk', text: 'x' } as never)
    }
    expect(runtime.historyWindowBuffer).toHaveLength(HISTORY_WINDOW_BUFFER_CAP)
  })

  it('clearHistoryWindowBuffer 清空缓冲与快照态', () => {
    bufferHistoryWindowEvent({ type: 'chunk', text: 'a' } as never)
    runtime.historySnapTail = 123
    runtime.historySnapEventKeys.set('k', 1)
    clearHistoryWindowBuffer()
    expect(runtime.historyWindowBuffer).toHaveLength(0)
    expect(runtime.historySnapTail).toBeUndefined()
    expect(runtime.historySnapEventKeys.size).toBe(0)
  })
})

describe('dropLiveCoveredBySnapshot', () => {
  beforeEach(() => clearHistoryWindowBuffer())

  it('有 sessionId 且 ts ≤ snapTail 的 live chunk 丢弃；无 sid 的回放放行', () => {
    runtime.historySnapTail = 1000
    expect(
      dropLiveCoveredBySnapshot({
        type: 'chunk',
        text: 'x',
        sessionId: 's1',
        agentTimestampMs: 1000,
      } as never),
    ).toBe(true)
    expect(
      dropLiveCoveredBySnapshot({
        type: 'chunk',
        text: 'x',
        agentTimestampMs: 1000,
      } as never),
    ).toBe(false)
    expect(
      dropLiveCoveredBySnapshot({
        type: 'chunk',
        text: 'new',
        sessionId: 's1',
        agentTimestampMs: 1001,
      } as never),
    ).toBe(false)
    expect(
      dropLiveCoveredBySnapshot({
        type: 'done',
        sessionId: 's1',
        agentTimestampMs: 1,
      } as never),
    ).toBe(false)
  })
})

describe('clearContinueSessionTimer / clearPeerSessionLoad', () => {
  beforeEach(() => {
    clearContinueSessionTimer()
  })

  it('清空 continue 定时器', () => {
    runtime.continueSessionTimer = 123 as never
    clearContinueSessionTimer()
    expect(runtime.continueSessionTimer).toBeNull()
    // 再清一次也安全
    clearContinueSessionTimer()
  })

  it('清空 peer session load 标记', () => {
    runtime.peerSessionLoadSid = 'sid'
    clearPeerSessionLoad()
    expect(runtime.peerSessionLoadSid).toBeNull()
  })
})