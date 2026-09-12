import { describe, expect, it, vi } from 'vitest'
import { handleChatEvent } from './events'
import type { AcpEvent } from '../../api/types'
import type { ChatState, SetState } from './types'
import {
  handleTaskBackgrounded,
  handleTaskCompleted,
  handleBackgroundTasks,
  parseScheduledTask,
  removeScheduledTask,
  scheduledTaskDeleteReason,
  scheduledTaskDeletedText,
  TASK_KILL_STATUS_TEXT,
  topTaskFrom,
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

  it('kill 结算后熄灭「正在终止后台任务…」（不得当成持续计时的新阶段）', () => {
    const get = vi.fn(() => ({
      ...s0,
      conn: 'busy',
      awaitingNext: false,
      statusText: TASK_KILL_STATUS_TEXT,
    }))
    const set = vi.fn()
    handleTaskCompleted(get as never, set as never, {
      task_snapshot: { task_id: 't1', explicitly_killed: true, signal: 'killed' },
    })
    const statuses = set.mock.calls
      .map((c) => (c[0] as { statusText?: string }).statusText)
      .filter((v): v is string => v !== undefined)
    expect(statuses).toEqual(['Waiting for response…'])
  })

  it('空闲会话 kill 结算后回到空闲文案', () => {
    for (const [awaitingNext, want] of [
      [false, '就绪'],
      [true, '待处理'],
    ] as const) {
      const get = vi.fn(() => ({
        ...s0,
        conn: 'ready',
        awaitingNext,
        statusText: TASK_KILL_STATUS_TEXT,
      }))
      const set = vi.fn()
      handleTaskCompleted(get as never, set as never, {
        task_snapshot: { task_id: 't1', explicitly_killed: true },
      })
      const statuses = set.mock.calls
        .map((c) => (c[0] as { statusText?: string }).statusText)
        .filter((v): v is string => v !== undefined)
      expect(statuses).toEqual([want])
    }
  })

  it('无关完成（非 kill）不动其它瞬态状态文案', () => {
    const get = vi.fn(() => ({ ...s0, conn: 'busy', statusText: 'Compacting…' }))
    const set = vi.fn()
    handleTaskCompleted(get as never, set as never, {
      task_snapshot: { task_id: 't1', exit_code: 0 },
    })
    expect(
      set.mock.calls.every(
        (c) => !('statusText' in ((c[0] ?? {}) as Record<string, unknown>)),
      ),
    ).toBe(true)
  })
})

describe('handleBackgroundTasks — 全量快照驱动', () => {
  it('running 任务只进 topTasks（不补滚动区条目），终态只回填已有条目', () => {
    const s0 = {
      topTasks: [],
      bgTaskIndex: { 't-2': 'e-2' } as Record<string, string>,
      entries: [
        { id: 'e-2', kind: 'bg_task', taskId: 't-2', running: true, status: 'started' },
      ] as Array<Record<string, unknown>>,
    }
    const get = vi.fn(() => s0)
    const set = vi.fn()

    handleBackgroundTasks(get as never, set as never, {
      tasks: [
        {
          task_id: 't-1',
          command: 'npm run build',
          status: 'running',
          description: 'build app',
        },
        {
          task_id: 't-2',
          command: 'npm test',
          status: 'completed',
        },
      ],
    })

    const patch = set.mock.calls[0][0] as {
      topTasks: Array<{ taskId: string; title: string }>
      entries: Array<{ id: string; kind: string; status: string; running: boolean }>
      bgTaskIndex: Record<string, string>
    }

    expect(patch.topTasks).toHaveLength(1)
    expect(patch.topTasks[0]).toMatchObject({ taskId: 't-1', title: 'build app' })
    // running 行只由 task_backgrounded 产生：快照不为 t-1 补行，
    // 否则任务消失后就是一条没有收口路径的僵尸行。
    expect(patch.entries).toHaveLength(1)
    expect(patch.entries[0]).toMatchObject({ id: 'e-2', running: false, status: 'completed' })
    expect(patch.bgTaskIndex['t-2']).toBeUndefined()
  })

  it('truncated 快照只增改：不据缺失删 topTasks / 条目索引', () => {
    const s0 = {
      topTasks: [{ taskId: 't-keep', title: 'keep', command: 'sleep 99' }],
      bgTaskIndex: { 't-keep': 'e-keep' },
      entries: [] as Array<Record<string, unknown>>,
    }
    const get = vi.fn(() => s0)
    const set = vi.fn()

    handleBackgroundTasks(get as never, set as never, {
      truncated: true,
      tasks: [{ task_id: 't-new', command: 'ls', status: 'running' }],
    })

    const patch = set.mock.calls[0][0] as {
      topTasks: Array<{ taskId: string }>
      bgTaskIndex: Record<string, string>
    }
    expect(patch.topTasks.map((t) => t.taskId).sort()).toEqual(['t-keep', 't-new'])
    expect(patch.bgTaskIndex['t-keep']).toBe('e-keep')
  })

  it('空快照 tasks: [] 清空 topTasks', () => {
    const s0 = {
      topTasks: [{ taskId: 't-old', title: 'old task' }],
      bgTaskIndex: { 't-old': 'e-old' },
      entries: [{ id: 'e-old', kind: 'bg_task', running: true, status: 'started' }],
    }
    const get = vi.fn(() => s0)
    const set = vi.fn()

    handleBackgroundTasks(get as never, set as never, {
      tasks: [],
    })

    const patch = set.mock.calls[0][0] as {
      topTasks: Array<unknown>
    }
    expect(patch.topTasks).toHaveLength(0)
  })

  it('monitor 任务带 kind=monitor → 顶栏行标 isMonitor', () => {
    const s0 = { topTasks: [], bgTaskIndex: {}, entries: [] }
    const get = vi.fn(() => s0)
    const set = vi.fn()

    handleBackgroundTasks(get as never, set as never, {
      tasks: [
        {
          task_id: 'm-1',
          command: 'tail -f log',
          status: 'running',
          kind: 'monitor',
          description: 'watch log',
        },
      ],
    })

    const patch = set.mock.calls[0][0] as { topTasks: Array<{ isMonitor?: boolean }> }
    expect(patch.topTasks[0]).toMatchObject({ isMonitor: true })
  })

  it('已有直播行的任务不再进顶栏（同一任务只由一处承载，计数不翻倍）', () => {
    const s0 = {
      topTasks: [{ taskId: 't-1', title: '遗留的顶栏行' }],
      bgTaskIndex: { 't-1': 'e-1' } as Record<string, string>,
      entries: [
        { id: 'e-1', kind: 'bg_task', taskId: 't-1', running: true, status: 'started' },
      ] as Array<Record<string, unknown>>,
    }
    const get = vi.fn(() => s0)
    const set = vi.fn()

    handleBackgroundTasks(get as never, set as never, {
      tasks: [
        { task_id: 't-1', command: 'sleep 99', status: 'running' },
        { task_id: 't-2', command: 'npm run dev', status: 'running' },
      ],
    })

    const patch = set.mock.calls[0][0] as { topTasks: Array<{ taskId: string }> }
    // t-1 已有 bg_task 行（直播 task_backgrounded 产生）：快照不得再把它
    // 画进顶栏，否则 TopBar 的 running 计数（行数 + topTasks 数）翻倍，
    // 且重放时 started 行会被跳过、数量又变回 1。
    expect(patch.topTasks.map((t) => t.taskId)).toEqual(['t-2'])
  })
})

/**
 * 直播序列还原：后台任务开始时 shell 同时发 task_backgrounded（两条载体）
 * 并立刻请求一次 background_tasks 全量快照；三者都必须只让任务出现一次。
 */
describe('直播序列 task_backgrounded → background_tasks 快照', () => {
  function makeStore() {
    const state = {
      sessionId: 's1',
      entries: [] as Array<Record<string, unknown>>,
      bgTaskIndex: {} as Record<string, string>,
      topTasks: [] as Array<Record<string, unknown>>,
    } as unknown as ChatState
    const set: SetState = ((partial: unknown) => {
      const patch =
        typeof partial === 'function'
          ? (partial as (s: ChatState) => object)(state)
          : partial
      Object.assign(state, patch)
    }) as SetState
    return { state, get: () => state, set }
  }

  it('行只建一条、顶栏不重复，重放与直播的任务数一致', () => {
    const { get, set, state } = makeStore()
    const update = (sessionUpdate: string, fields: Record<string, unknown>) => ({
      type: sessionUpdate,
      sessionId: 's1',
      update: { sessionUpdate, ...fields },
    })

    // 1) 直播 task_backgrounded（sessionUpdate 载体）
    handleChatEvent(set, get, update('task_backgrounded', {
      task_id: 't-1',
      command: 'sleep 99',
      description: '长任务',
    }) as AcpEvent)
    // 2) 同一事件的 x.ai 独立通道载体
    handleChatEvent(set, get, {
      type: 'task_backgrounded',
      sessionId: 's1',
      params: {
        session_id: 's1',
        update: { sessionUpdate: 'task_backgrounded', task_id: 't-1', command: 'sleep 99' },
      },
    } as AcpEvent)
    // 3) 后台化时立刻请求的全量快照
    handleChatEvent(set, get, update('background_tasks', {
      tasks: [{ task_id: 't-1', command: 'sleep 99', status: 'running' }],
    }) as AcpEvent)

    const runningRows = state.entries.filter(
      (e) => e.kind === 'bg_task' && e.running === true,
    )
    // 直播期间：一条 running 行 + 顶栏 0 条（任务只由行承载）
    expect(runningRows).toHaveLength(1)
    expect(state.topTasks).toEqual([])
  })
})

describe('topTaskFrom — 两个写者共用的字段推导', () => {
  it('display_command 优先于 command，description 当标题', () => {
    expect(
      topTaskFrom({
        task_id: 't',
        command: 'bash -lc ls',
        display_command: 'ls',
        description: 'list files',
        output_file: '/tmp/o',
      }),
    ).toEqual({ taskId: 't', title: 'list files', command: 'ls', outputFile: '/tmp/o' })
  })

  it('无描述 → 命令当标题；无 id → null', () => {
    expect(topTaskFrom({ taskId: 't', command: 'sleep 1' })).toEqual({
      taskId: 't',
      title: 'sleep 1',
      command: 'sleep 1',
    })
    expect(topTaskFrom({ taskId: 'abcdef1234', command: '' })).toMatchObject({
      title: 'Task abcdef12',
    })
    expect(topTaskFrom({})).toBeNull()
  })
})