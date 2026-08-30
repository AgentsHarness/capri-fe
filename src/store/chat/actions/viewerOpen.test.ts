import { describe, expect, it, vi, beforeEach } from 'vitest'
import { transport } from '../../../api/client'
import { useChatStore } from '../../chat'

vi.mock('../../../api/client', () => ({
  transport: {
    loadSessionHistory: vi.fn(),
    onEvent: vi.fn(),
  },
}))

const histMock = vi.mocked(transport.loadSessionHistory)

/** 最小包络（与 loadHistoryWindowDedup.test.ts 同款形状）。 */
const env = (sid: string, sessionUpdate: string, text: string) => ({
  timestamp: 1_700_000_000_000,
  method: 'session/update',
  params: {
    sessionId: sid,
    update: { sessionUpdate, content: { type: 'text', text } },
  },
})

beforeEach(() => {
  histMock.mockReset()
  useChatStore.setState({
    sessionId: 'parent',
    cwd: '/tmp',
    subagentViews: {},
  })
})

describe('loadMoreSubagentView — 绝对 offset 分页', () => {
  it('按绝对窗口 [loadedStart-PAGE, loadedStart) 请求，旧页前插不重叠', async () => {
    useChatStore.setState({
      subagentViews: {
        child1: {
          items: [{ id: 'newest', kind: 'user', text: 'newest' }],
          fetchState: 'loaded',
          loadedCount: 100,
          totalCount: 220,
          loadedStart: 120,
        },
      },
    })
    histMock.mockResolvedValue({
      updates: [env('child1', 'user_message_chunk', 'older prompt')],
      totalCount: 220,
    })
    const ok = await useChatStore.getState().loadMoreSubagentView('child1')
    expect(ok).toBe(true)
    // 绝对窗口 [120-100, 120) → offset 20 / limit 100；旧实现是
    // -(100+100)=-200，live 追加后整窗前移会与已加载区 [120,220) 重叠。
    expect(histMock).toHaveBeenCalledWith('child1', '/tmp', {
      offset: 20,
      limit: 100,
    })
    const v = useChatStore.getState().subagentViews.child1
    expect(v.loadedStart).toBe(20)
    expect(v.loadedCount).toBe(200)
    // 旧页（更早）在前，已加载区在后，顺序不破。
    expect(v.items[0]).toMatchObject({ kind: 'user', text: 'older prompt' })
    expect(v.items[v.items.length - 1]).toMatchObject({ id: 'newest' })
  })

  it('live 追加抬高 total 后窗口仍与已加载区严格相邻（不重叠）', async () => {
    // 首拉加载了最新 100 条，total=140 → loadedStart=40；
    // 两次加载之间 live 追加 40 条 → total 涨到 180（旧实现负 offset
    // 会整窗前移，把 [40,80) 的包络重复回放一遍）。
    useChatStore.setState({
      subagentViews: {
        child1: {
          items: [{ id: 'newest', kind: 'user', text: 'newest' }],
          fetchState: 'loaded',
          loadedCount: 100,
          totalCount: 140,
          loadedStart: 40,
        },
      },
    })
    histMock.mockResolvedValue({
      updates: [env('child1', 'user_message_chunk', 'older prompt')],
      totalCount: 180,
    })
    const ok = await useChatStore.getState().loadMoreSubagentView('child1')
    expect(ok).toBe(true)
    // 窗口 [0, 40)——仍然只覆盖已加载区之前的部分,不与 [40,180) 重叠。
    expect(histMock).toHaveBeenCalledWith('child1', '/tmp', {
      offset: 0,
      limit: 40,
    })
    const v = useChatStore.getState().subagentViews.child1
    expect(v.loadedStart).toBe(0)
    expect(v.loadedCount).toBe(180)
    expect(v.totalCount).toBe(180)
  })

  it('缺 loadedStart 的旧状态按 total - loaded 兜底换算', async () => {
    useChatStore.setState({
      subagentViews: {
        child1: {
          items: [{ id: 'newest', kind: 'user', text: 'newest' }],
          fetchState: 'loaded',
          loadedCount: 100,
          totalCount: 150,
        },
      },
    })
    histMock.mockResolvedValue({ updates: [], totalCount: 150 })
    const ok = await useChatStore.getState().loadMoreSubagentView('child1')
    expect(ok).toBe(false) // 空页 → 不再翻
    expect(histMock).toHaveBeenCalledWith('child1', '/tmp', {
      offset: 0,
      limit: 50,
    })
    const v = useChatStore.getState().subagentViews.child1
    // 空页不动游标（loadedStart 保持兜底换算值）。
    expect(v.loadedStart).toBe(50)
  })

  it('游标已到 0（无更早历史）→ 不发请求直接 false', async () => {
    useChatStore.setState({
      subagentViews: {
        child1: {
          items: [{ id: 'newest', kind: 'user', text: 'newest' }],
          fetchState: 'loaded',
          loadedCount: 100,
          totalCount: 100,
          loadedStart: 0,
        },
      },
    })
    const ok = await useChatStore.getState().loadMoreSubagentView('child1')
    expect(ok).toBe(false)
    expect(histMock).not.toHaveBeenCalled()
  })
})