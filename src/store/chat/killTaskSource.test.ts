import { beforeEach, describe, expect, it, vi } from 'vitest'
import { transport } from '../../api/client'
import { useChatStore } from '../chat'

vi.mock('../../api/client', () => ({
  transport: {
    killTask: vi.fn(async () => 'killed'),
    cancel: vi.fn(async () => ({})),
    onEvent: vi.fn(() => () => {}),
    getConnectionMode: vi.fn(() => 'local'),
    prefsOrigin: vi.fn(() => ''),
    getPrefs: vi.fn(async () => ({ prefs: {} })),
    putPrefs: vi.fn(async () => ({})),
    connect: vi.fn(),
    disconnect: vi.fn(),
    status: vi.fn(),
  },
}))

const killTaskRpc = vi.mocked(transport.killTask)

/**
 * killTask 的 notifyAgent → wire source 映射：这是"点 kill 时能不能选择
 * 要不要通知 agent"唯一的落点，agent 侧只看这一个字段。
 */
describe('killTask notifyAgent → source', () => {
  beforeEach(() => {
    killTaskRpc.mockClear()
    useChatStore.setState({ sessionId: 's-1' })
  })

  it('缺省（不传 opts）走 clientUi，与 agent 的缺省一致', async () => {
    await useChatStore.getState().killTask('t-1')
    expect(killTaskRpc).toHaveBeenCalledWith('t-1', 's-1', 'clientUi')
  })

  it('notifyAgent: true → clientUi', async () => {
    await useChatStore.getState().killTask('t-1', { notifyAgent: true })
    expect(killTaskRpc).toHaveBeenCalledWith('t-1', 's-1', 'clientUi')
  })

  it('notifyAgent: false → teardown（agent 不再为这条任务被唤醒）', async () => {
    await useChatStore.getState().killTask('t-1', { notifyAgent: false })
    expect(killTaskRpc).toHaveBeenCalledWith('t-1', 's-1', 'teardown')
  })
})

/**
 * 取消回合的 stop-all 属于 agent 文档里的 teardown 场景（TUI dashboard
 * stop-all 同样发 teardown）：一次取消不该给模型堆 N 条「用户终止了」。
 */
describe('cancelTurn({stopTasks}) 走 teardown', () => {
  beforeEach(() => {
    killTaskRpc.mockClear()
    useChatStore.setState({
      sessionId: 's-1',
      entries: [
        { id: 'e1', kind: 'bg_task', title: 'sleep', status: 'started', running: true, taskId: 't-1' },
        { id: 'e2', kind: 'bg_task', title: 'done', status: 'completed', taskId: 't-2' },
      ],
      topTasks: [{ taskId: 't-3', title: 'held' }],
    })
  })

  it('运行中的条目与顶栏恢复任务都静默杀，已结束的不动', async () => {
    await useChatStore.getState().cancelTurn({ stopTasks: true })
    expect(killTaskRpc).toHaveBeenCalledWith('t-1', 's-1', 'teardown')
    expect(killTaskRpc).toHaveBeenCalledWith('t-3', 's-1', 'teardown')
    expect(killTaskRpc.mock.calls.map((c) => c[0])).toEqual(['t-1', 't-3'])
  })
})
