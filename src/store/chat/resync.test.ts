import { describe, expect, it, vi } from 'vitest'
import { handleResyncRebuild } from './resync'
import type { ChatState } from './types'

describe('handleResyncRebuild', () => {
  it('重建中（historyLoading）→ 忽略', () => {
    const loadHistory = vi.fn()
    handleResyncRebuild(
      (() => ({ historyLoading: true, historyLoadingMore: false, sessionId: 's', cwd: '/w', loadHistory })) as unknown as () => ChatState,
    )
    expect(loadHistory).not.toHaveBeenCalled()
  })

  it('翻页中（historyLoadingMore）→ 忽略', () => {
    const loadHistory = vi.fn()
    handleResyncRebuild(
      (() => ({ historyLoading: false, historyLoadingMore: true, sessionId: 's', cwd: '/w', loadHistory })) as unknown as () => ChatState,
    )
    expect(loadHistory).not.toHaveBeenCalled()
  })

  it('无活动会话 / 无 cwd → 忽略', () => {
    const loadHistory = vi.fn()
    handleResyncRebuild(
      (() => ({ historyLoading: false, historyLoadingMore: false, sessionId: undefined, cwd: undefined, loadHistory })) as unknown as () => ChatState,
    )
    expect(loadHistory).not.toHaveBeenCalled()
    handleResyncRebuild(
      (() => ({ historyLoading: false, historyLoadingMore: false, sessionId: 's', cwd: undefined, loadHistory })) as unknown as () => ChatState,
    )
    expect(loadHistory).not.toHaveBeenCalled()
  })

  it('正常路径 → 探活与快照一起发，回放等探活落地', () => {
    const loadHistory = vi.fn()
    const probeP = Promise.resolve()
    const replayRunningTasks = vi.fn(() => probeP)
    const startTopTaskPolling = vi.fn()
    const state = {
      historyLoading: false,
      historyLoadingMore: false,
      sessionId: 's1',
      cwd: '/w',
      loadHistory,
      replayRunningTasks,
      startTopTaskPolling,
      topTasks: [{ taskId: 't1' }],
    } as unknown as ChatState
    handleResyncRebuild(() => state)
    expect(replayRunningTasks).toHaveBeenCalledWith('s1', '/w')
    expect(loadHistory).toHaveBeenCalledWith('s1', '/w', {
      awaitBeforeReplay: probeP,
    })
  })

  it('探活查到在跑任务才开轮询；空闲会话不留 10s 定时器', async () => {
    const mk = (topTasks: unknown[]) => {
      const state = {
        historyLoading: false,
        historyLoadingMore: false,
        sessionId: 's1',
        cwd: '/w',
        loadHistory: vi.fn(),
        replayRunningTasks: vi.fn(() => Promise.resolve()),
        startTopTaskPolling: vi.fn(),
        topTasks,
      } as unknown as ChatState
      return state
    }
    const busy = mk([{ taskId: 't1' }])
    handleResyncRebuild(() => busy)
    await Promise.resolve()
    await Promise.resolve()
    expect(busy.startTopTaskPolling).toHaveBeenCalledWith('s1', '/w')

    const idle = mk([])
    handleResyncRebuild(() => idle)
    await Promise.resolve()
    await Promise.resolve()
    expect(idle.startTopTaskPolling).not.toHaveBeenCalled()
  })

  it('探活落地前会话已被切走 → 不开轮询', async () => {
    let settle!: () => void
    const state = {
      historyLoading: false,
      historyLoadingMore: false,
      sessionId: 's1',
      cwd: '/w',
      loadHistory: vi.fn(),
      replayRunningTasks: vi.fn(() => new Promise<void>((r) => (settle = r))),
      startTopTaskPolling: vi.fn(),
      topTasks: [{ taskId: 't1' }],
    } as unknown as ChatState
    handleResyncRebuild(() => state)
    // 切到别的会话后再让探活回来
    ;(state as unknown as { sessionId: string }).sessionId = 'other'
    settle()
    await Promise.resolve()
    await Promise.resolve()
    expect(state.startTopTaskPolling).not.toHaveBeenCalled()
  })
})