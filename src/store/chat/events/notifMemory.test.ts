import { describe, expect, it, vi } from 'vitest'
import type { AcpEvent, ScrollEntry } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { handleSessionNotification } from './sessionNotif'
import { entryExpanded, entryFoldable } from '../../../scrollback/entryState'

function makeStore(initial: Partial<ChatState> = {}) {
  let state = { entries: [], sessionId: 's1', ...initial } as unknown as ChatState
  const set = vi.fn(
    (patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
    },
  )
  return { set: set as unknown as SetState, get: () => state, state: () => state }
}

const generic = (tag: string, extra: Record<string, unknown> = {}) =>
  ({
    type: 'session_notification',
    sessionId: 's1',
    params: { sessionUpdate: tag, ...extra },
  }) as AcpEvent

const texts = (state: ChatState) =>
  (state.entries ?? []).map((e) => (e as { text?: string }).text)

/**
 * TUI：wire 的 flush / dream / session-end 通知与手工命令共用同一 tag，pager
 * 只在手工 /flush、/dream 的 RPC 响应上渲染结果行（后台自动运行一律静默，
 * docs 13-memory.md「Memory Notifications」）。FE 的结果行由 actions 生成，
 * 因此这些 tag 到分发层必须什么都不落。
 */
describe('记忆后台通知：滚动区保持静默', () => {
  it.each([
    ['memory_flush_started', {}],
    ['memory_flush_completed', { result: 'written' }],
    ['memory_dream_completed', { result: 'written (1200 chars)' }],
    ['memory_session_saved', { path: '/home/.grok/memory/ws/sessions/2026-01-15.md' }],
  ])('%s → 无条目（已 ack）', (tag, extra) => {
    const { set, get, state } = makeStore()
    expect(handleSessionNotification(set, get, generic(tag, extra))).toBe(true)
    expect(texts(state())).toEqual([])
  })
})

describe('memory_capture_activity', () => {
  it('v2 捕获生命周期 → 一行（回合范围 + 尝试次数 + 观察数）', () => {
    const { set, get, state } = makeStore()
    expect(
      handleSessionNotification(
        set,
        get,
        generic('memory_capture_activity', {
          activity: 'retry',
          from_turn: 2,
          through_turn: 4,
          attempt: 2,
          detail: 'boom',
          memories: [],
        }),
      ),
    ).toBe(true)
    expect(texts(state())).toEqual(['记忆捕获将重试：第 2-4 回合（第 2 次尝试）'])
  })

  it('完成且带调试观察 → 折叠态调试块（标题行 + 载荷），默认不出正文', () => {
    const { set, get, state } = makeStore()
    expect(
      handleSessionNotification(
        set,
        get,
        generic('memory_capture_activity', {
          activity: 'completed',
          from_turn: 2,
          through_turn: 4,
          attempt: 1,
          memories: [
            { statement: '用聚焦测试目标。', body: '全量套件很贵。', path: '/tmp/obs.md' },
          ],
        }),
      ),
    ).toBe(true)
    expect(state().entries).toHaveLength(1)
    expect(state().entries[0]).toMatchObject({
      kind: 'session_event',
      text: '模型生成的记忆调试输出：第 2-4 回合共 1 条观察',
      memoryCapture: {
        fromTurn: 2,
        throughTurn: 4,
        observations: [
          { statement: '用聚焦测试目标。', body: '全量套件很贵。', path: '/tmp/obs.md' },
        ],
      },
    })
    // 折叠态由条目 open 缺省决定（TUI default_display_mode = Collapsed）
    expect(entryExpanded(state().entries[0])).toBe(false)
    expect(entryFoldable(state().entries[0])).toBe(true)
  })

  it('缺回合范围（异常载荷）→ 不落行但已 ack', () => {
    const { set, get, state } = makeStore()
    expect(handleSessionNotification(set, get, generic('memory_capture_activity', { activity: 'running' }))).toBe(true)
    expect(texts(state())).toEqual([])
  })
})

describe('retry_state', () => {
  it('终态两条（failed / exhausted）→ 各一行 warning 横幅，带 retryBanner 标志位', () => {
    const { set, get, state } = makeStore()
    handleSessionNotification(
      set,
      get,
      generic('retry_state', { type: 'failed', errorType: 'auth', message: 'Unauthorized (401)' }),
    )
    handleSessionNotification(
      set,
      get,
      generic('retry_state', { type: 'exhausted', attempts: 3, reason: 'API error (429)', isRateLimited: true }),
    )

    const rows = state().entries as Extract<ScrollEntry, { kind: 'session_event' }>[]
    expect(rows).toHaveLength(2)
    // 标志位是 TurnFailed 标记让位的判据（见 turnFailureMarkerSuppressed）。
    expect(rows.map((e) => e.retryBanner)).toEqual([true, true])
    expect(rows.map((e) => e.warning)).toEqual([true, true])
  })

  it('retrying（非终态）不落行，只更新状态栏', () => {
    const { set, get, state } = makeStore()
    expect(
      handleSessionNotification(
        set,
        get,
        generic('retry_state', { type: 'retrying', attempt: 2, maxRetries: 5, reason: 'overloaded' }),
      ),
    ).toBe(true)
    expect(state().entries).toHaveLength(0)
    expect(state().statusText).toContain('2')
  })
})

describe('memory_files', () => {
  it('只更新模态列表，不写滚动区（TUI 同为只开模态）', () => {
    const { set, get, state } = makeStore()
    expect(
      handleSessionNotification(
        set,
        get,
        generic('memory_files', {
          files: [
            { path: '/ws/.grok/memory/MEMORY.md', source: 'workspace', size_bytes: 10, generated: true },
          ],
          enabled: true,
        }),
      ),
    ).toBe(true)
    expect(texts(state())).toEqual([])
    expect(state().memoryListing?.files.map((f) => f.path)).toEqual([
      '/ws/.grok/memory/MEMORY.md',
    ])
    expect(state().memoryStatus).toBe('ready')
  })
})
