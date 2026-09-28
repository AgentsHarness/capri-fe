import { describe, expect, it } from 'vitest'
import type { ScrollEntry } from '../../api/types'
import type { ChatState, SetState } from './types'
import {
  finalizeTurn,
  tailAlreadyTurnEnded,
  turnFailureMarkerSuppressed,
} from './turnLifecycle'

function makeStore(seed: Partial<ChatState> = {}) {
  const state = {
    sessionId: 's1',
    entries: [] as ScrollEntry[],
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

describe('finalizeTurn 与 hook 运行批', () => {
  it('shell 回合（无标记）不产生 hook 附加行 —— 成功批次不落任何行', () => {
    const { get, set } = makeStore({
      conn: 'busy',
      turnStartedAt: Date.now() - 5000,
      currentPromptId: 'p1',
      currentStreamStartMs: 123,
      entries: [{ id: 'u1', kind: 'user', text: '!ls', isShell: true }],
    })
    finalizeTurn(set, get, 'end_turn')
    // 1.0.41 起不再有 lifecycle 行，条目只有原有那条 user 行。
    expect(get().entries).toEqual([{ id: 'u1', kind: 'user', text: '!ls', isShell: true }])
    expect(get().conn).toBe('ready')
  })

  it('失败回合不额外挂行（失败标记由 turnEnd rail 补）', () => {
    const { get, set } = makeStore({
      conn: 'busy',
      turnStartedAt: Date.now() - 5000,
      currentPromptId: 'p1',
      currentStreamStartMs: 123,
      entries: [{ id: 'u1', kind: 'user', text: 'hi' }],
    })
    finalizeTurn(set, get, 'error')
    expect(get().entries).toHaveLength(1)
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

describe('turnFailureMarkerSuppressed（TUI terminal_marker 抑制臂）', () => {
  const banner: ScrollEntry = {
    id: 'b',
    kind: 'session_event',
    text: '推理失败（server）: boom',
    warning: true,
    retryBanner: true,
  }
  const content: ScrollEntry = { id: 'u', kind: 'user', text: 'hi' }

  it('error / rate_limit + 尾部横幅 → 抑制；无横幅 → 照常画标记', () => {
    expect(turnFailureMarkerSuppressed([content, banner], 'error')).toBe(true)
    expect(turnFailureMarkerSuppressed([content, banner], 'rate_limit')).toBe(true)
    expect(turnFailureMarkerSuppressed([content], 'error')).toBe(false)
    expect(turnFailureMarkerSuppressed([content], 'rate_limit')).toBe(false)
  })

  it('cancelled 不受横幅影响（TUI TurnCancelled 不被错误横幅抑制）', () => {
    expect(turnFailureMarkerSuppressed([content, banner], 'cancelled')).toBe(false)
  })

  it('成功回合的横幅不影响收口判据，收口标记照旧抑制重复标记', () => {
    expect(turnFailureMarkerSuppressed([banner], 'end_turn')).toBe(false)
    expect(
      turnFailureMarkerSuppressed(
        [{ id: 'm', kind: 'session_event', text: 'Turn completed.' }],
        'end_turn',
      ),
    ).toBe(true)
  })

  it('横幅之后已进入下一回合（有内容条目）→ 不抑制', () => {
    expect(turnFailureMarkerSuppressed([banner, content], 'error')).toBe(false)
    expect(tailAlreadyTurnEnded([banner, content])).toBe(false)
  })
})