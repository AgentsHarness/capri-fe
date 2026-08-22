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

  it('正常路径 → 触发 loadHistory 全量重建', () => {
    const loadHistory = vi.fn()
    handleResyncRebuild(
      (() => ({ historyLoading: false, historyLoadingMore: false, sessionId: 's1', cwd: '/w', loadHistory })) as unknown as () => ChatState,
    )
    expect(loadHistory).toHaveBeenCalledWith('s1', '/w')
  })
})