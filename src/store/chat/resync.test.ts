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
    const prefetchRunningTasks = vi.fn(() => probeP)
    const startTopTaskPolling = vi.fn()
    const state = {
      historyLoading: false,
      historyLoadingMore: false,
      sessionId: 's1',
      cwd: '/w',
      loadHistory,
      prefetchRunningTasks,
      startTopTaskPolling,
      topTasks: [{ taskId: 't1' }],
      detachedTasks: [],
      detachedHintKey: null,
    } as unknown as ChatState
    handleResyncRebuild(() => state)
    expect(prefetchRunningTasks).toHaveBeenCalledWith('s1', '/w')
    expect(loadHistory).toHaveBeenCalledWith('s1', '/w', {
      awaitBeforeReplay: probeP,
    })
  })

  it('探活查到在跑任务才开轮询；空闲会话不留 10s 定时器', async () => {
    const mk = (topTasks: unknown[], detachedTasks: unknown[] = []) => {
      const state = {
        historyLoading: false,
        historyLoadingMore: false,
        sessionId: 's1',
        cwd: '/w',
        loadHistory: vi.fn(),
        prefetchRunningTasks: vi.fn(() => Promise.resolve()),
        startTopTaskPolling: vi.fn(),
        topTasks,
        detachedTasks,
        detachedHintKey: null,
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

    // 只剩游离进程提示时也值得继续轮询：提示要跟着集合变化收敛
    const onlyDetached = mk([], [{ taskId: 'd1', pid: 9 }])
    handleResyncRebuild(() => onlyDetached)
    await Promise.resolve()
    await Promise.resolve()
    expect(onlyDetached.startTopTaskPolling).toHaveBeenCalledWith('s1', '/w')
  })

  it('探活落地前会话已被切走 → 不开轮询', async () => {
    let settle!: () => void
    const state = {
      historyLoading: false,
      historyLoadingMore: false,
      sessionId: 's1',
      cwd: '/w',
      loadHistory: vi.fn(),
      prefetchRunningTasks: vi.fn(() => new Promise<void>((r) => (settle = r))),
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