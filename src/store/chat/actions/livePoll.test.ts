import { describe, expect, it, vi } from 'vitest'
import type { ChatState, SetState } from '../types'
import { livePollActions } from './livePoll'

/**
 * 轮询收口：刷新一轮后如果没有可盯的活，定时器必须停下。
 *
 * 这里不做「拉一次 store 看有没有真停」的间接断言——直接驱动
 * refreshRunningTasks，检查它调用了 stopTopTaskPolling。缺陷的本体正是
 * 「这条路径从不调 stop」，那个断言能把它抓红。
 */
describe('refreshRunningTasks 收口', () => {
  function harness(state: Partial<ChatState>) {
    const stop = vi.fn()
    const syncLiveTasks = vi.fn().mockResolvedValue(undefined)
    const syncLiveSubagents = vi.fn().mockResolvedValue([])
    const st = {
      sessionId: 's1',
      cwd: '/w',
      topTasks: [],
      detachedTasks: [],
      entries: [],
      syncLiveTasks,
      syncLiveSubagents,
      stopTopTaskPolling: stop,
      ...state,
    } as unknown as ChatState
    const set: SetState = (partial) => {
      Object.assign(st, typeof partial === 'function' ? partial(st) : partial)
    }
    const actions = livePollActions(set, () => st)
    return { st, actions, stop, syncLiveTasks, syncLiveSubagents }
  }

  it('没有活可盯 → 停轮询', async () => {
    const { actions, stop } = harness({})
    await actions.refreshRunningTasks?.('s1', '/w')
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('顶部任务条还有任务 → 不停', async () => {
    const { actions, stop } = harness({
      topTasks: [{ taskId: 't1', title: 'dev server' }],
    })
    await actions.refreshRunningTasks?.('s1', '/w')
    expect(stop).not.toHaveBeenCalled()
  })

  it('还有游离进程提示 → 不停', async () => {
    const { actions, stop } = harness({ detachedTasks: [{ taskId: 'd1' }] })
    await actions.refreshRunningTasks?.('s1', '/w')
    expect(stop).not.toHaveBeenCalled()
  })

  it('本轮注册表补出在跑任务 → 不停（定时器一停就再也没有收口来源）', async () => {
    const { st, actions, stop, syncLiveTasks } = harness({})
    syncLiveTasks.mockImplementation(async () => {
      st.topTasks = [{ taskId: 't1', title: 'dev' }] as never
    })
    await actions.refreshRunningTasks?.('s1', '/w')
    expect(stop).not.toHaveBeenCalled()
  })

  it('本轮子代理注册表发现活 → 不停', async () => {
    const { actions, stop, syncLiveSubagents } = harness({})
    syncLiveSubagents.mockResolvedValue([{ subagentId: 'sa1' }] as never)
    await actions.refreshRunningTasks?.('s1', '/w')
    expect(stop).not.toHaveBeenCalled()
  })

  it('本轮开始时还有活、结束时收口 → 本轮不停，留一轮观察窗口', async () => {
    const { st, actions, stop, syncLiveTasks } = harness({
      topTasks: [{ taskId: 't1', title: 'dev' }] as never,
    })
    syncLiveTasks.mockImplementation(async () => {
      st.topTasks = []
    })
    await actions.refreshRunningTasks?.('s1', '/w')
    expect(stop).not.toHaveBeenCalled()
  })
})
