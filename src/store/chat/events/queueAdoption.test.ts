import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpEvent, ScrollEntry } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { handleChatEvent } from '../events'
import { usePromptQueue, type QueuedPrompt } from '../../promptQueue'

vi.mock('../../../api/client', () => ({
  transport: {
    prompt: vi.fn(async () => undefined),
    queueRemove: vi.fn(async () => undefined),
    queueReleaseEdit: vi.fn(async () => undefined),
    queueEdit: vi.fn(async () => undefined),
    queueReorder: vi.fn(async () => undefined),
    queueClear: vi.fn(async () => undefined),
    queueHoldEdit: vi.fn(async () => undefined),
    onEvent: vi.fn(() => () => {}),
  },
}))

function row(id: string, text: string): QueuedPrompt {
  return { id, text, blocks: [{ type: 'text', text }], ts: 0 }
}

function makeStore(initial: Partial<ChatState> = {}) {
  let state = {
    entries: [] as ScrollEntry[],
    sessionId: 's1',
    conn: 'busy',
    turnStartedAt: Date.now() - 5000,
    currentPromptId: 'p-old',
    currentStreamStartMs: undefined,
    openAssistantId: undefined,
    openThoughtId: undefined,
    liveStream: null,
    awaitingNext: false,
    lastCompletedTurn: undefined,
    pendingOptimisticUserId: undefined,
    refreshSessionStats: () => {},
    ...initial,
  } as unknown as ChatState
  const set = vi.fn(
    (patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
    },
  )
  const get = () => state
  return { set: set as unknown as SetState, get, state: () => state }
}

/** x.ai/session/update carrier: prompt identity rides update.prompt_id, not meta. */
const liveTurnCompleted = (over: Record<string, unknown> = {}): AcpEvent =>
  ({
    type: 'turn_completed',
    sessionId: 's1',
    update: {
      sessionUpdate: 'turn_completed',
      prompt_id: 'p-old',
      stop_reason: 'cancelled',
      elapsed_ms: 5000,
      ...over,
    },
    meta: {
      eventId: 'e-1',
      agentTimestampMs: Date.now(),
      cancelTrigger: 'send_now',
      cancellationCategory: 'MidTurnAbort',
      cancellationContext: { trigger: 'send_now' },
    },
  }) as AcpEvent

const queueChangedTo = (id: string, text: string): AcpEvent =>
  ({
    type: 'queue_changed',
    sessionId: 's1',
    params: {
      sessionId: 's1',
      entries: [],
      runningPromptId: id,
      runningText: text,
      runningKind: 'prompt',
    },
  }) as AcpEvent

beforeEach(() => {
  usePromptQueue.setState({
    queues: {},
    queue: [],
    sending: false,
    drainedIds: new Set(),
    deletedRows: new Map(),
    editIndex: null,
    editDraft: '',
    editImages: [],
    sessionId: undefined,
  })
  vi.clearAllMocks()
})

describe('send_now 取消后的队列收养', () => {
  it('live turn_completed 用 update.prompt_id 匹配当前回合并收口', () => {
    const { set, get, state } = makeStore({
      entries: [{ id: 'u1', kind: 'user', text: 'old prompt' }],
    })
    handleChatEvent(set, get, liveTurnCompleted())
    expect(state().conn).toBe('ready')
    expect(state().currentPromptId).toBeUndefined()
    expect(state().turnStartedAt).toBeUndefined()
    // send_now 是取消并继续，不落 "Turn cancelled" / "Cancelled by trigger" 行
    expect(state().entries.filter((e) => e.kind === 'session_event')).toEqual([])
  })

  it('prompt_complete 的 send_now 取消同样不落取消行', () => {
    const { set, get, state } = makeStore({
      entries: [{ id: 'u1', kind: 'user', text: 'old prompt' }],
    })
    handleChatEvent(set, get, {
      type: 'prompt_complete',
      sessionId: 's1',
      params: {
        sessionId: 's1',
        promptId: 'p-old',
        stopReason: 'cancelled',
        cancelTrigger: 'send_now',
        cancellationContext: { trigger: 'send_now' },
      },
    } as AcpEvent)
    expect(state().conn).toBe('ready')
    expect(state().currentPromptId).toBeUndefined()
    expect(state().entries.filter((e) => e.kind === 'session_event')).toEqual([])
  })

  it('hook 级取消仍保留取消原因行', () => {
    const { set, get, state } = makeStore({
      entries: [{ id: 'u1', kind: 'user', text: 'old prompt' }],
    })
    handleChatEvent(set, get, {
      type: 'turn_completed',
      sessionId: 's1',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'p-old',
        stop_reason: 'cancelled',
        elapsed_ms: 5000,
      },
      meta: {
        eventId: 'e-hook',
        cancellationCategory: 'HookDenied',
        cancellationContext: { hook_name: 'pre_tool_use', reason: 'blocked' },
      },
    } as AcpEvent)
    expect(
      state().entries.filter(
        (e) => e.kind === 'session_event' && e.text === 'Cancelled by hook "pre_tool_use": blocked',
      ),
    ).toHaveLength(1)
  })

  it('queue_changed 先于旧回合终态时暂存，收口后补收养', () => {
    const { set, get, state } = makeStore({
      entries: [{ id: 'u1', kind: 'user', text: 'old prompt' }],
    })
    usePromptQueue.setState({ queue: [row('p-new', 'queued message')], sessionId: 's1' })

    handleChatEvent(set, get, queueChangedTo('p-new', 'queued message'))
    expect(usePromptQueue.getState().queue).toEqual([])
    expect(state().pendingRunningAdoption).toMatchObject({ id: 'p-new', text: 'queued message' })
    expect(state().entries.filter((e) => e.kind === 'user').map((e) => e.text)).toEqual([
      'old prompt',
    ])

    // prompt_complete 走 extMisc rail：finally 统一 flush 暂存收养。
    handleChatEvent(set, get, {
      type: 'prompt_complete',
      sessionId: 's1',
      params: {
        sessionId: 's1',
        promptId: 'p-old',
        stopReason: 'cancelled',
        cancelTrigger: 'send_now',
      },
    } as AcpEvent)
    expect(state().pendingRunningAdoption).toBeUndefined()
    expect(state().entries.filter((e) => e.kind === 'user').map((e) => e.text)).toContain(
      'queued message',
    )
    expect(state().conn).toBe('busy')
    expect(state().currentPromptId).toBe('p-new')
  })

  it('旧回合先收口，队列消息随后被收养为新回合并继续输出', () => {
    const { set, get, state } = makeStore({
      entries: [{ id: 'u1', kind: 'user', text: 'old prompt' }],
    })
    usePromptQueue.setState({ queue: [row('p-new', 'queued message')], sessionId: 's1' })

    // 真实顺序：turn_completed (send_now cancel) → queue_changed(running new) → user_chunk/chunk(new)
    handleChatEvent(set, get, liveTurnCompleted())
    handleChatEvent(set, get, queueChangedTo('p-new', 'queued message'))

    expect(usePromptQueue.getState().queue).toEqual([])
    expect(state().entries.filter((e) => e.kind === 'user').map((e) => e.text)).toContain(
      'queued message',
    )
    expect(state().conn).toBe('busy')
    expect(state().currentPromptId).toBe('p-new')

    handleChatEvent(set, get, {
      type: 'user_chunk',
      text: 'queued message',
      sessionId: 's1',
    } as AcpEvent)
    handleChatEvent(set, get, {
      type: 'chunk',
      text: 'answer text',
      streamStartMs: 777,
      turnStartMs: 700,
      sessionId: 's1',
    } as AcpEvent)

    expect(state().entries.filter((e) => e.kind === 'user')).toHaveLength(2)
    const assistant = state().entries.find((e) => e.kind === 'assistant')
    const rendered = assistant
      ? ('text' in assistant ? assistant.text : '') +
        (state().liveStream?.entryId === assistant.id ? state().liveStream?.text ?? '' : '')
      : ''
    expect(rendered).toContain('answer text')
  })
})
