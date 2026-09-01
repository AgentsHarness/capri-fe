import { beforeEach, describe, expect, it, vi } from 'vitest'
import { liveTaskActions } from './liveTasks'
import type { ChatState, SetState } from '../types'

vi.mock('../../../api/client', () => ({
  transport: {
    taskOutput: vi.fn().mockResolvedValue({ taskId: 't1', output: 'new log' }),
  },
}))

import { transport } from '../../../api/client'

function makeState(patch: Partial<ChatState> = {}): ChatState {
  return {
    sessionId: 's1',
    cwd: '/w',
    entries: [],
    bgTaskIndex: {},
    viewerTask: undefined,
    ...patch,
  } as unknown as ChatState
}

/**
 * 模拟真实 zustand：`get()` 每次返回**不可变快照**，`set()` 生成新对象。
 * 只有这样才能复现「await 前取的旧快照」被整体写回的行为——若 get()/state
 * 共用同一个可变对象，旧快照与新状态永远是同一个引用，测不出覆盖。
 */
function bind(initial: ChatState) {
  let current = initial
  const set: SetState = (partial) => {
    current = { ...current, ...(typeof partial === 'function' ? partial(current) : partial) }
  }
  return {
    actions: liveTaskActions(set, () => current) as Pick<ChatState, 'refreshTaskOutput'>,
    snapshot: () => current,
    patch: (p: Partial<ChatState>) => {
      current = { ...current, ...p }
    },
  }
}

const bgRow = {
  id: 'e1',
  kind: 'bg_task',
  title: 'task',
  taskId: 't1',
  running: true,
  output: 'old',
} as never

describe('refreshTaskOutput', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(transport.taskOutput as ReturnType<typeof vi.fn>).mockResolvedValue({
      taskId: 't1',
      output: 'fresh log line',
    })
  })

  it('请求期间新追加的行不能被请求前的旧快照顶掉', async () => {
    const h = bind(makeState({ entries: [bgRow], bgTaskIndex: { t1: 'e1' } }))
    let release!: (v: unknown) => void
    ;(transport.taskOutput as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((res) => { release = res }),
    )
    const p = h.actions.refreshTaskOutput('t1', 's1', '/w')
    // 在途期间 agent 流式追加了一行（同一会话，isAsyncScopeCurrent 不会拦）。
    h.patch({ entries: [...h.snapshot().entries, { id: 'e2', kind: 'assistant', text: 'hi' } as never] })
    release({ taskId: 't1', output: 'fresh log line' })
    await p

    expect(h.snapshot().entries.map((e) => e.id)).toEqual(['e1', 'e2'])
    expect((h.snapshot().entries[0] as { output?: string }).output).toBe('fresh log line')
  })

  it('请求期间才建的 bg_task 行也能被回写（索引在 await 之后取）', async () => {
    const h = bind(makeState({ entries: [], bgTaskIndex: {} }))
    const p = h.actions.refreshTaskOutput('t1', 's1', '/w')
    h.patch({ entries: [bgRow], bgTaskIndex: { t1: 'e1' } })
    await p
    expect((h.snapshot().entries[0] as { output?: string }).output).toBe('fresh log line')
  })

  it('请求期间切了会话 → 什么都不写', async () => {
    const h = bind(makeState({ entries: [bgRow], bgTaskIndex: { t1: 'e1' } }))
    const p = h.actions.refreshTaskOutput('t1', 's1', '/w')
    h.patch({ sessionId: 'other' })
    await p
    expect((h.snapshot().entries[0] as { output?: string }).output).toBe('old')
  })

  it('无 bg_task 行时仍回写打开中的任务查看器', async () => {
    const h = bind(
      makeState({
        entries: [],
        bgTaskIndex: {},
        viewerTask: { taskId: 't1', output: 'old', running: true },
      }),
    )
    await h.actions.refreshTaskOutput('t1', 's1', '/w')
    expect(h.snapshot().viewerTask).toMatchObject({ output: 'fresh log line' })
  })
})
