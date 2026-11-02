import { describe, expect, it, vi } from 'vitest'
import type { DetachedTask } from '../../api/types'
import {
  applyDetachedProbe,
  clearTopTaskTimer,
  detachedSignature,
  hasLiveRunningWork,
  parseDetachedTask,
  setTopTaskTimer,
} from './topTasks'

describe('parseDetachedTask', () => {
  it('归一化宿主 TaskEvent（含 pid）', () => {
    const t = parseDetachedTask({
      kind: 'task_backgrounded',
      taskId: 't-1',
      command: 'npm run dev',
      description: 'dev server',
      outputFile: '/tmp/t-1.log',
      pid: 4242,
      running: true,
    })
    expect(t).toEqual({
      taskId: 't-1',
      command: 'npm run dev',
      description: 'dev server',
      outputFile: '/tmp/t-1.log',
      pid: 4242,
    })
  })

  it('缺 taskId → null；pid 非正数 → 省略', () => {
    expect(parseDetachedTask({ command: 'x' })).toBeNull()
    expect(parseDetachedTask({ taskId: 't', pid: 0 })?.pid).toBeUndefined()
  })
})

describe('applyDetachedProbe', () => {
  const mk = (
    tasks: DetachedTask[],
    key: string | null,
    alive: string[] = [],
  ) => ({ detachedTasks: tasks, detachedHintKey: key, runningProbeTaskIds: alive })

  it('集合变化 → 写入列表并记录签名', () => {
    const get = vi.fn(() => mk([], null))
    const set = vi.fn()
    applyDetachedProbe(
      get as never,
      set as never,
      ['b', 'a', 'x'],
      [
        { taskId: 'b', command: 'sleep 60', pid: 7 },
        { taskId: 'a', monitorDescription: 'log tail' },
      ],
    )
    expect(set).toHaveBeenCalledWith({
      detachedTasks: [
        { taskId: 'b', command: 'sleep 60', pid: 7 },
        { taskId: 'a', monitorDescription: 'log tail' },
      ],
      detachedHintKey: 'a,b',
      // 存活集是原始探活数据，与提示的关闭状态无关
      runningProbeTaskIds: ['b', 'a', 'x'],
    })
  })

  it('同一集合再次上报 → 不动（被用户关掉后不再骚扰）', () => {
    // detachedTasks 已被 dismiss 清空，但 key 仍是这个集合的签名。
    const get = vi.fn(() => mk([], 'a,b', ['stale']))
    const set = vi.fn()
    applyDetachedProbe(get as never, set as never, ['a', 'b'], [
      { taskId: 'a' },
      { taskId: 'b' },
    ])
    // 提示保持关闭，但存活集仍要更新（历史回放靠它跳过悬空 started 行）
    expect(set).toHaveBeenCalledWith({
      detachedTasks: [],
      detachedHintKey: 'a,b',
      runningProbeTaskIds: ['a', 'b'],
    })
  })

  it('集合清空 → 撤销提示', () => {
    const get = vi.fn(() => mk([{ taskId: 'a' }], 'a', ['a']))
    const set = vi.fn()
    applyDetachedProbe(get as never, set as never, [], [])
    expect(set).toHaveBeenCalledWith({
      detachedTasks: [],
      detachedHintKey: '',
      runningProbeTaskIds: [],
    })
  })

  it('无 taskId 的条目被丢弃，不影响签名', () => {
    const get = vi.fn(() => mk([{ taskId: 'a' }], 'a', ['a']))
    const set = vi.fn()
    applyDetachedProbe(get as never, set as never, [], [{ taskId: 'a' }, { command: 'x' }])
    // 集合签名没变 → 提示列表原样不动（只是存活集被刷新）
    expect(set).toHaveBeenCalledWith({
      detachedTasks: [{ taskId: 'a' }],
      detachedHintKey: 'a',
      runningProbeTaskIds: [],
    })
  })
})

describe('detachedSignature', () => {
  it('与顺序无关', () => {
    expect(detachedSignature([{ taskId: 'b' }, { taskId: 'a' }])).toBe(
      detachedSignature([{ taskId: 'a' }, { taskId: 'b' }]),
    )
  })
})

describe('timer 管理', () => {
  it('set / clear', () => {
    clearTopTaskTimer()
    setTopTaskTimer(42 as never)
    clearTopTaskTimer()
  })
})

describe('hasLiveRunningWork（轮询收口判据）', () => {
  const base = { topTasks: [], detachedTasks: [], entries: [] }

  it('全空 → false：空闲会话不该继续每 10 秒问三个接口', () => {
    expect(hasLiveRunningWork(base)).toBe(false)
  })

  it('顶部任务条非空 → true', () => {
    expect(
      hasLiveRunningWork({ ...base, topTasks: [{ taskId: 't1', title: 'dev' }] }),
    ).toBe(true)
  })

  it('游离进程提示非空 → true', () => {
    expect(
      hasLiveRunningWork({ ...base, detachedTasks: [{ taskId: 'd1' }] }),
    ).toBe(true)
  })

  it('滚动区里有在跑的子代理 / 后台任务行 → true', () => {
    expect(
      hasLiveRunningWork({
        ...base,
        entries: [{ kind: 'subagent', id: 'e1', running: true }],
      } as never),
    ).toBe(true)
    expect(
      hasLiveRunningWork({
        ...base,
        entries: [{ kind: 'bg_task', id: 'e2', running: true }],
      } as never),
    ).toBe(true)
  })

  it('行还在但已收口（running:false）→ false', () => {
    expect(
      hasLiveRunningWork({
        ...base,
        entries: [{ kind: 'bg_task', id: 'e2', running: false }],
      } as never),
    ).toBe(false)
  })
})
