import { describe, expect, it, vi } from 'vitest'
import {
  handleTaskBackgrounded,
  handleTaskCompleted,
  parseScheduledTask,
  removeScheduledTask,
  scheduledTaskDeleteReason,
  scheduledTaskDeletedText,
  updateScheduledTaskFire,
  upsertScheduledTask,
} from './tasks'

describe('parseScheduledTask', () => {
  it('host 契约 envelope / 扁平 snake / camel 都解析', () => {
    expect(parseScheduledTask({ task: { taskId: 'a', prompt: 'p', interval: '5m', nextFireAt: 'x' } })).toEqual({
      taskId: 'a',
      prompt: 'p',
      interval: '5m',
      nextFireAt: 'x',
    })
    expect(parseScheduledTask({ task_id: 'b', description: 'd', interval_secs: 30 })).toEqual({
      taskId: 'b',
      prompt: 'd',
      interval: '30s',
    })
    expect(parseScheduledTask({ taskId: 'c', prompt: 'p', human_schedule: 'every 5m' })).toEqual({
      taskId: 'c',
      prompt: 'p',
      interval: 'every 5m',
    })
  })

  it('无 taskId → null；意外输入 → null', () => {
    expect(parseScheduledTask({})).toBeNull()
    expect(parseScheduledTask(undefined)).toBeNull()
    expect(parseScheduledTask('str' as never)).toBeNull()
  })
})

describe('upsert / remove / update fire', () => {
  const s0 = { scheduledTasks: [{ taskId: 'a', prompt: 'p1', interval: '1m' }] }

  it('upsert：存在则合并，不存在则追加', () => {
    const set = vi.fn()
    upsertScheduledTask(set as never, { taskId: 'a', prompt: 'p2', interval: '1m' })
    const partial = set.mock.calls[0][0] as (state: typeof s0) => typeof s0
    expect(partial(s0).scheduledTasks).toEqual([{ taskId: 'a', prompt: 'p2', interval: '1m' }])

    const set2 = vi.fn()
    upsertScheduledTask(set2 as never, { taskId: 'b', prompt: 'x', interval: '' })
    const partial2 = set2.mock.calls[0][0] as (state: typeof s0) => typeof s0
    expect(partial2(s0).scheduledTasks).toHaveLength(2)
  })

  it('移除按 taskId；空 id 不动', () => {
    const set = vi.fn()
    removeScheduledTask(set as never, 'a')
    const partial = set.mock.calls[0][0] as (state: typeof s0) => typeof s0
    expect(partial(s0).scheduledTasks).toHaveLength(0)

    const set2 = vi.fn()
    removeScheduledTask(set2 as never, '')
    expect(set2).not.toHaveBeenCalled()
  })

  it('updateScheduledTaskFire 只更新 nextFireAt', () => {
    const set = vi.fn()
    updateScheduledTaskFire(set as never, 'a', 'tomorrow')
    const partial = set.mock.calls[0][0] as (state: typeof s0) => typeof s0
    expect(partial(s0).scheduledTasks[0]).toMatchObject({ nextFireAt: 'tomorrow', prompt: 'p1' })
  })
})

describe('scheduledTaskDeleteReason / text', () => {
  it('原因回退链：顶层 → params → rawParams → unknown', () => {
    expect(scheduledTaskDeleteReason('expired')).toBe('expired')
    expect(scheduledTaskDeleteReason('', { reason: 'completed' })).toBe('completed')
    expect(scheduledTaskDeleteReason('', {}, { reason: 'deleted' })).toBe('deleted')
    expect(scheduledTaskDeleteReason('')).toBe('unknown')
  })

  it('文案映射', () => {
    expect(scheduledTaskDeletedText('expired')).toBe('定时任务已过期')
    expect(scheduledTaskDeletedText('completed')).toBe('定时任务已完成')
    expect(scheduledTaskDeletedText('deleted')).toBe('定时任务已删除')
    expect(scheduledTaskDeletedText('shutdown')).toContain('定时任务已暂停')
    expect(scheduledTaskDeletedText('whatever')).toBe('定时任务已移除')
  })
})

describe('handleTaskBackgrounded', () => {
  const s0 = {
    topTasks: [],
    bgTaskIndex: {} as Record<string, string>,
    entries: [] as Array<{ id: string; kind: string }>,
  }

  it('创建 bg_task 条目 + 索引；monitor 识别；[monitor] 前缀剥离', () => {
    const get = vi.fn(() => s0)
    const set = vi.fn()
    handleTaskBackgrounded(get as never, set as never, {
      task_id: 't1',
      command: 'npm run dev',
      description: 'dev server',
      output_file: '/tmp/log',
      monitor_description: 'watch files',
    })
    const partial = set.mock.calls[0][0] as (s: typeof s0) => typeof s0
    const next = partial({ ...s0 })
    expect(Object.keys(next.bgTaskIndex)).toEqual(['t1'])
    const row = next.entries[0] as unknown as { kind: string; taskId: string; command: string; outputFile: string; isMonitor: boolean; title: string; detail?: string }
    expect(row).toMatchObject({
      kind: 'bg_task',
      taskId: 't1',
      command: 'npm run dev',
      outputFile: '/tmp/log',
      isMonitor: true,
    })
    expect(row.title).toBe('watch files')
    expect(row.detail).toBe('npm run dev')
  })

  it('已跟踪 / 无 id → 不动', () => {
    const get = vi.fn(() => ({ topTasks: [], bgTaskIndex: { t1: 'e1' }, entries: [] }))
    const set = vi.fn()
    handleTaskBackgrounded(get as never, set as never, { task_id: 't1' })
    expect(set).not.toHaveBeenCalled()

    const set2 = vi.fn()
    handleTaskBackgrounded(vi.fn(() => s0) as never, set2 as never, {})
    expect(set2).not.toHaveBeenCalled()
  })

  it('top strip 中的任务转正：先移除 strip 再建条目', () => {
    const get = vi.fn(() => ({ topTasks: [{ taskId: 't1', title: 'x' }], bgTaskIndex: {}, entries: [] }))
    const set = vi.fn()
    handleTaskBackgrounded(get as never, set as never, { task_id: 't1', command: 'ls' })
    const calls = set.mock.calls
    expect(calls[0][0]).toEqual({ topTasks: [] })
  })
})

describe('handleTaskCompleted', () => {
  const s0 = {
    topTasks: [],
    bgTaskIndex: { t1: 'e1' },
    entries: [
      { id: 'e1', kind: 'bg_task', taskId: 't1', title: 'x', status: 'started', running: true, output: 'old' },
    ],
  }

  it('正常完成：settle 条目 + 输出择优', () => {
    const get = vi.fn(() => s0)
    const set = vi.fn()
    handleTaskCompleted(get as never, set as never, {
      task_snapshot: { task_id: 't1', output: 'longer output', exit_code: 0 },
    })
    const partial = set.mock.calls[0][0] as Partial<typeof s0 & { entries: Array<Record<string, unknown>> }>
    expect(partial.entries![0]).toMatchObject({ status: 'completed', running: false, output: 'longer output' })
    expect(partial.entries![0].finishedAt).toEqual(expect.any(Number))
  })

  it('非零 exit / signal / explicitly_killed → failed', () => {
    const get = vi.fn(() => s0)
    const set = vi.fn()
    handleTaskCompleted(get as never, set as never, { task_snapshot: { task_id: 't1', exit_code: 1 } })
    const partial = set.mock.calls[0][0] as { entries: Array<Record<string, unknown>> }
    expect(partial.entries[0].status).toBe('failed')
  })

  it('页面边界：无条目时补建孤儿行', () => {
    const get = vi.fn(() => ({ topTasks: [], bgTaskIndex: {}, entries: [] }))
    const set = vi.fn()
    handleTaskCompleted(get as never, set as never, {
      task_snapshot: { task_id: 't9', display_command: 'npm', description: 'task', exit_code: 0 },
    })
    const partial = set.mock.calls[0][0] as (s: { bgTaskIndex: Record<string, string>; entries: Array<Record<string, unknown>> }) => {
      bgTaskIndex: Record<string, string>
      entries: Array<Record<string, unknown>>
    }
    const next = partial({ bgTaskIndex: {}, entries: [] })
    expect(next.bgTaskIndex.t9).toBeDefined()
    expect(next.entries[0]).toMatchObject({ kind: 'bg_task', status: 'completed', title: 'task' })
  })
})