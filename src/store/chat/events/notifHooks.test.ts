import { describe, expect, it } from 'vitest'
import type { ScrollEntry } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { appendTurnMarker, handleNotifHooks } from './notifHooks'

function makeStore(seed: Partial<ChatState> = {}) {
  const state = {
    sessionId: 's1',
    entries: [] as ScrollEntry[],
    currentPromptId: 'p1',
    conn: 'busy',
    historyLoading: false,
    runningHook: null,
    ...seed,
  } as unknown as ChatState
  const get = () => state
  const set: SetState = ((partial: unknown) => {
    const patch = typeof partial === 'function' ? (partial as (s: ChatState) => object)(state) : partial
    Object.assign(state, patch)
  }) as SetState
  return { state, get, set }
}

const ev = { type: 'session_notification', sessionId: 's1' } as never

describe('handleNotifHooks — hook_run_started / hook_execution', () => {
  it('hook_run_started 记下批次与开始时刻，hook_execution 结束等待态', () => {
    const { set, get } = makeStore()
    const before = Date.now()
    const ok = handleNotifHooks(set, get, ev, 'hook_run_started', {
      event_name: 'pre_tool_use',
      tool_name: 'bash',
      count: 2,
      prompt_id: 'p1',
    })
    expect(ok).toBe(true)
    // startedAt 是状态行 300ms 揭示延迟与相位计时的锚点。
    expect(get().runningHook).toMatchObject({
      eventName: 'pre_tool_use',
      toolName: 'bash',
      count: 2,
      promptId: 'p1',
    })
    expect(get().runningHook!.startedAt).toBeGreaterThanOrEqual(before)
    expect(get().runningHook!.startedAt).toBeLessThanOrEqual(Date.now())

    handleNotifHooks(set, get, ev, 'hook_execution', {
      event_name: 'pre_tool_use',
      tool_name: 'bash',
      runs: [],
    })
    expect(get().runningHook).toBeNull()
  })

  it('批次带上 agent 时间戳，供「开闸前已排队正文」判定', () => {
    const { set, get } = makeStore()
    handleNotifHooks(
      set,
      get,
      { type: 'session_notification', sessionId: 's1', meta: { agentTimestampMs: 1_000 } } as never,
      'hook_run_started',
      { event_name: 'stop', count: 1 },
    )
    expect(get().runningHook!.startedAtMs).toBe(1_000)

    // generic / 回放载体把 meta 嵌在 params 里。
    const nested = makeStore()
    handleNotifHooks(
      nested.set,
      nested.get,
      {
        type: 'session_notification',
        sessionId: 's1',
        params: { _meta: { agentTimestampMs: 2_000 } },
      } as never,
      'hook_run_started',
      { event_name: 'stop', count: 1 },
    )
    expect(nested.get().runningHook!.startedAtMs).toBe(2_000)
  })

  it('无 agent 时间戳时不带该字段（旧 shell 退回立即释放）', () => {
    const { set, get } = makeStore()
    handleNotifHooks(set, get, ev, 'hook_run_started', { event_name: 'stop', count: 1 })
    expect(get().runningHook).not.toHaveProperty('startedAtMs')
  })

  it('只有武装该等待态的批次能结束它（另一工具 / 另一事件都不行）', () => {
    const arm = () =>
      makeStore({
        runningHook: {
          eventName: 'pre_tool_use',
          toolName: 'read_file',
          count: 2,
          startedAt: Date.now(),
        },
      })

    // 另一个工具的 pre_tool_use 结果与这道门无关。
    const other = arm()
    handleNotifHooks(other.set, other.get, ev, 'hook_execution', {
      event_name: 'pre_tool_use',
      tool_name: 'grep',
      runs: [{ name: 'global/x', status: { status: 'success', elapsed_ms: 2 } }],
    })
    expect(other.get().runningHook).toMatchObject({ toolName: 'read_file' })

    // 另一个事件的批次同样无关。
    const otherEvent = arm()
    handleNotifHooks(otherEvent.set, otherEvent.get, ev, 'hook_execution', {
      event_name: 'session_start',
      runs: [{ name: 'global/boot', status: { status: 'success', elapsed_ms: 2 } }],
    })
    expect(otherEvent.get().runningHook).toMatchObject({ eventName: 'pre_tool_use' })

    // 自己的批次结束它。
    const own = arm()
    handleNotifHooks(own.set, own.get, ev, 'hook_execution', {
      event_name: 'pre_tool_use',
      tool_name: 'read_file',
      runs: [{ name: 'global/x', status: { status: 'success', elapsed_ms: 2 } }],
    })
    expect(own.get().runningHook).toBeNull()
  })

  it('外来回合的批次不动当前等待态，但失败行照常渲染', () => {
    // 已取消回合的 stop_cancelled 报告可能落在下一个排队 prompt 开始之后。
    const { set, get } = makeStore({
      currentPromptId: 'p-new',
      runningHook: {
        eventName: 'user_prompt_submit',
        count: 1,
        startedAt: Date.now(),
      },
    })
    handleNotifHooks(set, get, ev, 'hook_execution', {
      event_name: 'stop_cancelled',
      prompt_id: 'p-old',
      runs: [
        {
          name: 'global/qa:stop_cancelled[0].hooks[0]',
          status: { status: 'failed', error: 'boom', elapsed_ms: 1, blocked: false },
        },
      ],
    })
    expect(get().runningHook).toMatchObject({ eventName: 'user_prompt_submit' })
    expect(get().entries).toHaveLength(1)
    expect(get().entries[0]).toMatchObject({
      kind: 'session_event',
      text: 'stop_cancelled hook (global/qa) failed, ignored: boom',
      hookOutcome: true,
    })
  })

  it('成功 / skipped 批次不落任何行；空批次只清等待态', () => {
    const { set, get } = makeStore({
      runningHook: { eventName: 'pre_tool_use', count: 1, startedAt: Date.now() },
    })
    handleNotifHooks(set, get, ev, 'hook_execution', {
      event_name: 'pre_tool_use',
      runs: [
        { name: 'global/lint', status: { status: 'success', elapsed_ms: 12 } },
        { name: 'global/off', status: { status: 'skipped' } },
      ],
    })
    expect(get().entries).toEqual([])
    expect(get().runningHook).toBeNull()
  })

  it('blocked（stop gate 判停）不重复报行 —— shell 的 annotation 已给原因', () => {
    const { set, get } = makeStore()
    handleNotifHooks(set, get, ev, 'hook_execution', {
      event_name: 'pre_tool_use',
      runs: [
        {
          name: 'global/policy',
          status: { status: 'failed', error: 'rm is not allowed', elapsed_ms: 5, blocked: true },
        },
      ],
    })
    expect(get().entries).toEqual([])
  })

  it('一批多个失败 → 每行一条，顺序与 wire 一致', () => {
    const { set, get } = makeStore()
    handleNotifHooks(set, get, ev, 'hook_execution', {
      event_name: 'post_tool_use',
      runs: [
        { name: 'global/ok', status: { status: 'success', elapsed_ms: 1 } },
        {
          name: 'global/qa:post_tool_use[1].hooks[0]',
          status: { status: 'failed', error: 'exit code 1: lint', elapsed_ms: 40 },
        },
        {
          name: 'requirements/system:post_tool_use[0].hooks[0]',
          status: { status: 'failed', error: 'timed out after 5000ms', elapsed_ms: 5000 },
        },
      ],
    })
    expect(get().entries.map((e) => (e as { text: string }).text)).toEqual([
      'post_tool_use hook (global/qa) failed, ignored: exit code 1: lint',
      'post_tool_use hook failed, ignored: timed out after 5000ms',
    ])
  })
})

describe('handleNotifHooks — hook_annotation', () => {
  it('kind=tool_outcome 的行带工具 bullet 标记', () => {
    const { set, get } = makeStore()
    const ok = handleNotifHooks(set, get, ev, 'hook_annotation', {
      message: '`web_fetch` blocked by global/qa: no',
      kind: 'tool_outcome',
    })
    expect(ok).toBe(true)
    expect(get().entries[0]).toMatchObject({
      kind: 'session_event',
      text: '`web_fetch` blocked by global/qa: no',
      hookOutcome: true,
    })
    // TUI `is_warning_banner()` excludes HookOutcome → muted, no accent rail.
    expect(get().entries[0]).not.toMatchObject({ warning: true })
  })

  it('缺 kind（旧 shell 的注释行）当成普通 note，不取工具 bullet', () => {
    const { set, get } = makeStore()
    handleNotifHooks(set, get, ev, 'hook_annotation', {
      message: '⚠ Held 2 queued prompts',
    })
    expect(get().entries[0]).toMatchObject({
      kind: 'session_event',
      text: '⚠ Held 2 queued prompts',
    })
    expect(get().entries[0]).not.toMatchObject({ hookOutcome: true })
  })

  it('空 message 不追加', () => {
    const { set, get } = makeStore()
    handleNotifHooks(set, get, ev, 'hook_annotation', { message: '  ' })
    expect(get().entries).toEqual([])
  })
})

describe('appendTurnMarker', () => {
  it('追加标记行 —— 不再折叠 hook 批次、也不再盖章 pid', () => {
    const { set, get } = makeStore({ entries: [{ id: 'a', kind: 'status', text: 'x' }] })
    appendTurnMarker(set, get, { id: 'm', kind: 'session_event', text: 'Worked for 1.0s' })
    expect(get().entries).toEqual([
      { id: 'a', kind: 'status', text: 'x' },
      { id: 'm', kind: 'session_event', text: 'Worked for 1.0s' },
    ])
  })
})
