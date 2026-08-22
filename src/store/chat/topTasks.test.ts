import { describe, expect, it, vi } from 'vitest'
import { applyTopTaskProbe, clearTopTaskTimer, setTopTaskTimer } from './topTasks'

const s0 = {
  topTasks: [{ taskId: 'a', title: 'A', restored: true, command: 'cmd a' }],
  bgTaskIndex: {} as Record<string, string>,
}

describe('applyTopTaskProbe', () => {
  it('丢弃死亡任务、新增存活任务、跳过已跟踪/已在 strip 的', () => {
    const get = vi.fn(() => s0)
    const set = vi.fn()
    const events = [
      { kind: 'task_backgrounded', taskId: 'b', command: 'cmd b', description: 'B task' },
      { kind: 'task_backgrounded', taskId: 'c', monitorDescription: 'mon c' },
      { kind: 'task_completed', taskId: 'd' }, // 非 backgrounded 忽略
    ]
    applyTopTaskProbe(get as never, set as never, events as never)
    const partial = set.mock.calls[0][0] as { topTasks: Array<{ taskId: string }> }
    expect(partial.topTasks.map((t) => t.taskId)).toEqual(['b', 'c'])
  })

  it('无变化 → 不 set', () => {
    const get = vi.fn(() => s0)
    const set = vi.fn()
    applyTopTaskProbe(get as never, set as never, [{ kind: 'task_backgrounded', taskId: 'a' }])
    expect(set).not.toHaveBeenCalled()
  })

  it('已作为 live 条目跟踪的任务不进 strip', () => {
    const get = vi.fn(() => ({ topTasks: [], bgTaskIndex: { x: 'e1' } }))
    const set = vi.fn()
    applyTopTaskProbe(get as never, set as never, [{ kind: 'task_backgrounded', taskId: 'x' }])
    expect(set).not.toHaveBeenCalled()
  })
})

describe('timer 管理', () => {
  it('set / clear', () => {
    clearTopTaskTimer()
    setTopTaskTimer(42 as never)
    clearTopTaskTimer()
  })
})