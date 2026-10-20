import { beforeEach, describe, expect, it } from 'vitest'
import {
  NOTICE_DEDUP_WINDOW_MS,
  HISTORY_WINDOW_BUFFER_CAP,
  runtime,
  captureAsyncScope,
  isAsyncScopeCurrent,
  bufferHistoryWindowEvent,
  claimLiveGapToast,
  clearHistoryWindowBuffer,
  clearContinueSessionTimer,
  clearPeerSessionLoad,
  dropLiveCoveredBySnapshot,
  liveReplayStreamKey,
  liveStreamPrefixMissingFromHistory,
} from './globals'
import type { ChatState } from './types'
import { replayEventKeys } from './envelopeParse'

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
    runtime.historySnapStreamKeys.add('chunk:1')
    runtime.historyLoadStartedAt = 99
    runtime.historyLiveJoinCheck = true
    runtime.historyLiveStreamSeen.add(1)
    clearHistoryWindowBuffer()
    expect(runtime.historyWindowBuffer).toHaveLength(0)
    expect(runtime.historySnapTail).toBeUndefined()
    expect(runtime.historySnapEventKeys.size).toBe(0)
    expect(runtime.historySnapStreamKeys.size).toBe(0)
    expect(runtime.historyLoadStartedAt).toBeUndefined()
    expect(runtime.historyLiveJoinCheck).toBe(false)
    expect(runtime.historyLiveStreamSeen.size).toBe(0)
  })

  it('切走再切回同一路流的缺口提醒只保留一份', () => {
    runtime.historyGapToastedKeys.clear()
    runtime.historyLoadStartedAt = 2000
    const ev = {
      type: 'chunk',
      text: '后半',
      sessionId: 's1',
      streamStartMs: 1000,
    } as never
    expect(claimLiveGapToast('s1', ev)).toBe(true)
    expect(claimLiveGapToast('s1', ev)).toBe(false)
    // 别的会话 / 另一路流不受影响
    expect(claimLiveGapToast('s2', ev)).toBe(true)
    expect(
      claimLiveGapToast('s1', {
        type: 'chunk',
        text: '后半',
        sessionId: 's1',
        streamStartMs: 3000,
      } as never),
    ).toBe(true)
    runtime.historyGapToastedKeys.clear()
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

  it('复用 eventId 但文本/时间戳都是新的 → 不丢', () => {
    runtime.historySnapTail = 1000
    runtime.historySnapEventKeys.set('chunk:{"text":"old","agentTimestampMs":1000}', 1)
    expect(
      dropLiveCoveredBySnapshot({
        type: 'chunk',
        text: 'brand new',
        sessionId: 's1',
        agentTimestampMs: 1001,
        eventId: 's1-75',
      } as never),
    ).toBe(false)
  })

  it('语义键命中快照（带计数）→ 丢弃，耗尽后不再因同一键丢弃', () => {
    runtime.historySnapTail = undefined
    const ev = {
      type: 'chunk',
      text: 'same',
      sessionId: 's1',
      agentTimestampMs: 50,
    } as never
    for (const key of replayEventKeys(ev)) {
      runtime.historySnapEventKeys.set(key, 1)
    }
    expect(dropLiveCoveredBySnapshot(ev)).toBe(true)
    expect(dropLiveCoveredBySnapshot(ev)).toBe(false)
  })
})

describe('liveStreamPrefixMissingFromHistory', () => {
  beforeEach(() => {
    clearHistoryWindowBuffer()
    runtime.historyGapToastedKeys.clear()
  })

  it('无 sessionId 的回放事件不判缺口', () => {
    runtime.historyLoadStartedAt = 2000
    expect(
      liveStreamPrefixMissingFromHistory({
        type: 'chunk',
        text: 'x',
        streamStartMs: 1000,
      } as never),
    ).toBe(false)
  })

  it('快照已有同一路流 → 历史含前缀，不判缺口', () => {
    runtime.historyLoadStartedAt = 2000
    runtime.historySnapStreamKeys.add('chunk:1000')
    expect(
      liveStreamPrefixMissingFromHistory({
        type: 'chunk',
        text: '后半',
        sessionId: 's1',
        streamStartMs: 1000,
      } as never),
    ).toBe(false)
  })

  it('流在本次回放开始之前开工且快照没有这一路 → 正文缺口', () => {
    runtime.historyLoadStartedAt = 2000
    expect(
      liveStreamPrefixMissingFromHistory({
        type: 'chunk',
        text: '后半',
        sessionId: 's1',
        streamStartMs: 1000,
      } as never),
    ).toBe(true)
  })

  it('思考块缺前半段不算缺口：只有正文才值得提示', () => {
    runtime.historyLoadStartedAt = 2000
    expect(
      liveStreamPrefixMissingFromHistory({
        type: 'thought',
        text: '后半',
        sessionId: 's1',
        streamStartMs: 1000,
      } as never),
    ).toBe(false)
  })

  it('接入后同流先看到过思考 → 正文段从接入后开始，不判缺口', () => {
    runtime.historyLoadStartedAt = 2000
    // 先来的是同一路流的 thought（直播），说明正文还没开始推送。
    runtime.historyLiveStreamSeen.add(1000)
    expect(
      liveStreamPrefixMissingFromHistory({
        type: 'chunk',
        text: '后半',
        sessionId: 's1',
        streamStartMs: 1000,
      } as never),
    ).toBe(false)
  })

  it('thought 与 assistant 按 kind 分路：快照有 thought 不挡住 assistant 缺口', () => {
    runtime.historyLoadStartedAt = 2000
    runtime.historySnapStreamKeys.add('thought:1000')
    expect(
      liveStreamPrefixMissingFromHistory({
        type: 'chunk',
        text: '后半',
        sessionId: 's1',
        streamStartMs: 1000,
      } as never),
    ).toBe(true)
  })

  it('流在本次回放开始之后才开工 → 能从头接到，不判缺口', () => {
    runtime.historyLoadStartedAt = 2000
    expect(
      liveStreamPrefixMissingFromHistory({
        type: 'chunk',
        text: '首包',
        sessionId: 's1',
        streamStartMs: 2500,
      } as never),
    ).toBe(false)
  })

  it('liveReplayStreamKey 只认 chunk/thought 的有限 streamStartMs', () => {
    expect(liveReplayStreamKey({ type: 'chunk', streamStartMs: 1 } as never)).toBe(
      'chunk:1',
    )
    expect(
      liveReplayStreamKey({ type: 'thought', streamStartMs: 2 } as never),
    ).toBe('thought:2')
    expect(liveReplayStreamKey({ type: 'done' } as never)).toBeUndefined()
    expect(
      liveReplayStreamKey({ type: 'chunk', streamStartMs: Number.NaN } as never),
    ).toBeUndefined()
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