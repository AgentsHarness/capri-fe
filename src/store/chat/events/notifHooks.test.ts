import { describe, expect, it } from 'vitest'
import type { ScrollEntry } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { handleNotifHooks, appendTurnMarker } from './notifHooks'

function makeStore(seed: Partial<ChatState> = {}) {
  const state = {
    sessionId: 's1',
    entries: [] as ScrollEntry[],
    pendingToolHooks: [],
    pendingStopHooks: undefined,
    currentPromptId: 'p1',
    conn: 'busy',
    historyLoading: false,
    ...seed,
  } as unknown as ChatState
  const get = () => state
  const set: SetState = ((partial: unknown) => {
    const patch = typeof partial === 'function' ? (partial as (s: ChatState) => object)(state) : partial
    Object.assign(state, patch)
  }) as SetState
  return { state, get, set }
}

describe('handleNotifHooks', () => {
  it('hook_annotation → 普通 session_event 行（TUI 非 warning banner）', () => {
    const { set, get } = makeStore()
    const ok = handleNotifHooks(
      set,
      get,
      { type: 'session_notification', sessionId: 's1' } as never,
      'hook_annotation',
      { message: '⚠ `run_terminal_command` blocked by hook `global/probe`' },
    )
    expect(ok).toBe(true)
    expect(get().entries).toHaveLength(1)
    expect(get().entries[0]).toMatchObject({
      kind: 'session_event',
      text: '⚠ `run_terminal_command` blocked by hook `global/probe`',
    })
    // TUI `is_warning_banner()` excludes HookAnnotation → muted, no accent rail.
    expect(get().entries[0]).not.toMatchObject({ warning: true })
  })

  it('空 message 不追加', () => {
    const { set, get } = makeStore()
    handleNotifHooks(set, get, { type: 'session_notification' } as never, 'hook_annotation', {
      message: '  ',
    })
    expect(get().entries).toEqual([])
  })

  it('session_start 批次落 lifecycle 行', () => {
    const { set, get } = makeStore()
    handleNotifHooks(
      set,
      get,
      { type: 'session_notification', sessionId: 's1' } as never,
      'hook_execution',
      {
        event_name: 'session_start',
        runs: [{ name: 'boot', status: { status: 'success', elapsed_ms: 2 } }],
      },
    )
    expect(get().entries[0]).toMatchObject({
      kind: 'lifecycle',
      event: 'session_start',
      expanded: false,
    })
  })

  it('回放期 stop 落 lifecycle 行，不进 stash', () => {
    const { set, get } = makeStore({ historyLoading: true, conn: 'busy' })
    handleNotifHooks(
      set,
      get,
      { type: 'session_notification', sessionId: 's1' } as never,
      'hook_execution',
      {
        event_name: 'stop',
        prompt_id: 'p1',
        runs: [{ name: 'h', status: { status: 'success', elapsed_ms: 1 } }],
      },
    )
    expect(get().entries[0]).toMatchObject({ kind: 'lifecycle', event: 'stop' })
    expect(get().pendingStopHooks).toBeUndefined()
  })

  it('load-more 窗口内的重放批次（带 msgSeq）仍走 lifecycle', () => {
    const { set, get } = makeStore({ historyLoadingMore: true, turnStartedAt: Date.now() })
    handleNotifHooks(
      set,
      get,
      { type: 'session_notification', sessionId: 's1', msgSeq: 42 } as never,
      'hook_execution',
      {
        event_name: 'stop',
        prompt_id: 'p1',
        runs: [{ name: 'h', status: { status: 'success', elapsed_ms: 1 } }],
      },
    )
    expect(get().entries[0]).toMatchObject({ kind: 'lifecycle', event: 'stop' })
    expect(get().pendingStopHooks).toBeUndefined()
  })

  it('load-more 期间的 live 批次（无 msgSeq）正常进 stash，不被降级', () => {
    const { set, get } = makeStore({ historyLoadingMore: true, turnStartedAt: Date.now() })
    handleNotifHooks(
      set,
      get,
      { type: 'session_notification', sessionId: 's1' } as never,
      'hook_execution',
      {
        event_name: 'stop',
        prompt_id: 'p1',
        runs: [{ name: 'h', status: { status: 'success', elapsed_ms: 1 } }],
      },
    )
    expect(get().entries).toEqual([])
    expect(get().pendingStopHooks).toMatchObject({
      promptId: 'p1',
      groups: [{ event: 'stop' }],
    })
  })

  it('别的会话的 hook_execution 忽略', () => {
    const { set, get } = makeStore()
    handleNotifHooks(
      set,
      get,
      { type: 'session_notification', sessionId: 'other' } as never,
      'hook_execution',
      {
        event_name: 'session_start',
        runs: [{ name: 'boot', status: 'success' }],
      },
    )
    expect(get().entries).toEqual([])
  })
})

describe('appendTurnMarker', () => {
  it('把 stash 的 stop 批次折进标记', () => {
    const { set, get } = makeStore({
      pendingStopHooks: {
        promptId: 'p1',
        groups: [
          {
            event: 'stop',
            runs: [{ name: 'h', status: { type: 'success', elapsedMs: 1 } }],
          },
        ],
        mergeSameName: true,
      },
    })
    appendTurnMarker(set, get, { kind: 'session_event', text: 'Worked for 1.0s' } as never, 'p1')
    const last = get().entries.at(-1)
    expect(last).toMatchObject({
      kind: 'session_event',
      text: 'Worked for 1.0s',
      stopHooks: [{ event: 'stop' }],
      open: false,
    })
    expect(get().pendingStopHooks).toBeUndefined()
  })
})
