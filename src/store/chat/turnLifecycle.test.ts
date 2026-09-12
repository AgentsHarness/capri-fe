import { describe, expect, it } from 'vitest'
import type { HookRun, ScrollEntry } from '../../api/types'
import type { ChatState, SetState } from './types'
import { finalizeTurn } from './turnLifecycle'

const ok = (name = 'h'): HookRun => ({
  name,
  status: { type: 'success', elapsedMs: 1 },
})

function makeStore(seed: Partial<ChatState> = {}) {
  const state = {
    sessionId: 's1',
    entries: [] as ScrollEntry[],
    pendingToolHooks: [],
    pendingStopHooks: undefined,
    currentPromptId: 'p1',
    currentStreamStartMs: undefined,
    turnStartedAt: undefined,
    openThoughtId: undefined,
    openAssistantId: undefined,
    conn: 'ready',
    liveStream: null,
    awaitingNext: false,
    refreshSessionStats: () => {},
    ...seed,
  } as unknown as ChatState
  const get = () => state
  const set: SetState = ((partial: unknown) => {
    const patch =
      typeof partial === 'function' ? (partial as (s: ChatState) => object)(state) : partial
    Object.assign(state, patch)
  }) as SetState
  return { state, get, set }
}

describe('finalizeTurn hook stash 出清', () => {
  it('shell 回合（无标记）结束立即把 stash 出清为 lifecycle 行（TUI push_turn_terminal_marker(None)）', () => {
    const { get, set } = makeStore({
      conn: 'busy',
      turnStartedAt: Date.now() - 5000,
      currentPromptId: 'p1',
      currentStreamStartMs: 123,
      entries: [{ id: 'u1', kind: 'user', text: '!ls', isShell: true }],
      pendingToolHooks: [{ phase: 'pre', runs: [ok()] }],
      pendingStopHooks: {
        promptId: 'p1',
        groups: [{ event: 'stop', runs: [ok()] }],
        mergeSameName: true,
      },
    })
    finalizeTurn(set, get, 'end_turn')
    expect(get().entries.at(-1)).toMatchObject({ kind: 'lifecycle', event: 'stop' })
    expect(get().pendingStopHooks).toBeUndefined()
    // 工具队列一并作废（等不到行的 pre 批次不悬留到下一回合）。
    expect(get().pendingToolHooks).toEqual([])
    expect(get().conn).toBe('ready')
  })

  it('失败回合保留 stash——标记由 turnEnd rail 补并折叠', () => {
    const { get, set } = makeStore({
      conn: 'busy',
      turnStartedAt: Date.now() - 5000,
      currentPromptId: 'p1',
      currentStreamStartMs: 123,
      entries: [{ id: 'u1', kind: 'user', text: 'hi' }],
      pendingToolHooks: [],
      pendingStopHooks: {
        promptId: 'p1',
        groups: [{ event: 'stop', runs: [ok()] }],
        mergeSameName: true,
      },
    })
    finalizeTurn(set, get, 'error')
    expect(get().entries).toHaveLength(1)
    expect(get().pendingStopHooks).toMatchObject({
      promptId: 'p1',
      groups: [{ event: 'stop' }],
    })
  })
})

describe('finalizeTurn 幂等（多载体重复收尾）', () => {
  it('第二次收尾不抹掉已盖的 turnStartMs / streamStartMs', () => {
    const { get, set } = makeStore({
      conn: 'busy',
      awaitingNext: false,
      turnStartedAt: 500,
      currentPromptId: 'p1',
      currentStreamStartMs: 1000,
      entries: [{ id: 'u1', kind: 'user', text: 'hi' }],
    })
    // 第一次收口（turn_completed / prompt_complete / done 三载体的任意一个）
    finalizeTurn(set, get, 'end_turn')
    expect(get().lastCompletedTurn).toMatchObject({ turnStartMs: 500, streamStartMs: 1000 })
    // 第二次：锚点已被第一次清空，若照常重写会只剩 {endMs}，
    // 让 rejectClosedTurnAgentOutput 丢掉下一个自动唤醒轮的直播。
    finalizeTurn(set, get, 'end_turn')
    expect(get().lastCompletedTurn).toMatchObject({ turnStartMs: 500, streamStartMs: 1000 })
  })
})