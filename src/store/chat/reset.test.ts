import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSessionState } from './reset'
import { runtime, clearHistoryWindowBuffer } from './globals'

vi.mock('./turn', () => ({
  clearSubagentSettleTimer: vi.fn(),
  clearTurnBlipTimer: vi.fn(),
}))

import { clearSubagentSettleTimer, clearTurnBlipTimer } from './turn'

describe('resetSessionState', () => {
  beforeEach(() => {
    clearHistoryWindowBuffer()
    runtime.sessionSwitchGen = 0
    vi.clearAllMocks()
  })

  it('清空会话级状态并锚定空状态', () => {
    const set = vi.fn()
    resetSessionState(set as never)
    expect(runtime.sessionSwitchGen).toBe(1)
    const partial = set.mock.calls[0][0] as Record<string, unknown>
    expect(partial.entries).toEqual([])
    expect(partial.sessionId).toBeUndefined()
    expect(partial.cwd).toBeUndefined()
    expect(partial.liveStream).toBeNull()
    expect(partial.currentStreamStartMs).toBeUndefined()
    expect(partial.lastCompletedTurn).toBeUndefined()
    expect(partial.conn).toBe('ready')
    expect(partial.statusText).toBe('就绪')
    expect(partial.awaitingNext).toBe(false)
    expect(partial.planMode).toBe(false)
    expect(partial.pending).toEqual([])
    expect(partial.toolIndex).toEqual({})
    expect(partial.subagentIndex).toEqual({})
    expect(partial.pendingSubagentFinishes).toEqual({})
    expect(partial.subagentViews).toEqual({})
    expect(partial.bgTaskIndex).toEqual({})
    expect(partial.topTasks).toEqual([])
    expect(partial.historyHasMore).toBe(false)
    expect(partial.historyLoading).toBe(false)
    expect(partial.historyLoadingMore).toBe(false)
    expect(partial.historySessionId).toBeUndefined()
    expect(partial.sessionTitle).toBeUndefined()
    expect(partial.goalState).toBeUndefined()
    expect(partial.workflowRuns).toEqual({})
    expect(partial.turnStartedAt).toBeUndefined()
    expect(partial.currentPromptId).toBeUndefined()
    expect(partial.genRate).toBeUndefined()
    expect(partial.scheduledTasks).toEqual([])
    expect(partial.usage).toBeUndefined()
    expect(partial.sessionStats).toBeUndefined()
  })

  it('撤销在飞的子代理收口兜底与瞬断看门狗', () => {
    resetSessionState(vi.fn() as never)
    expect(clearSubagentSettleTimer).toHaveBeenCalledTimes(1)
    expect(clearTurnBlipTimer).toHaveBeenCalledTimes(1)
  })

  it('historyWindowBuffer 残留被清空', () => {
    runtime.historyWindowBuffer.push({ type: 'chunk', text: 'x' } as never)
    resetSessionState(vi.fn() as never)
    expect(runtime.historyWindowBuffer).toHaveLength(0)
  })
})