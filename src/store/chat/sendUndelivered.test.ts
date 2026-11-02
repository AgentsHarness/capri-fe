import { beforeEach, describe, expect, it, vi } from 'vitest'
import { transport } from '../../api/client'
import { useChatStore } from '../chat'

vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/transport')>(
    '../../api/transport',
  )
  return {
    AgentTurnError: actual.AgentTurnError,
    transport: {
      prompt: vi.fn(),
      cancel: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      getConnectionMode: vi.fn(() => 'hub'),
      lastLiveEventAt: vi.fn(() => undefined),
      setLayerErrorSource: undefined,
    },
  }
})

vi.mock('../toast', () => ({ pushToast: vi.fn(), dismissToast: vi.fn() }))

/**
 * host 被判离线时「发消息」的两条失败路径都要留下可重试的行内入口：
 *  1. hub 直接回 503（host 正在重连 / host 不可达）——prompt 根本没离开 hub；
 *  2. fetch 网络级拒绝——请求没送达。
 * 两者此前都清掉 currentPromptId 与用户行的身份，用户只能看到顶部一条
 * 「Host 已离线」，没有任何可点的恢复动作。
 */
describe('host 离线时发出的消息可重试', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      sessionId: 's1',
      cwd: '/repo',
      conn: 'ready',
      entries: [],
      historyLoading: false,
      currentPromptId: undefined,
      lastSentPromptId: undefined,
      turnStartedAt: undefined,
      layerErrors: {},
      pending: [],
    })
  })

  it('hub 回 503 → 用户行带 undelivered，错误行带 resend，身份保留', async () => {
    const { AgentTurnError } = await import('../../api/transport')
    vi.mocked(transport.prompt).mockRejectedValue(
      new AgentTurnError('unreachable', 'host mba 当前离线', 503),
    )

    await useChatStore.getState().send('这条没送出去')

    const state = useChatStore.getState()
    const userRow = state.entries.find((e) => e.kind === 'user')
    expect(userRow).toMatchObject({ undelivered: true })
    const errRow = state.entries.find((e) => e.kind === 'error')
    expect(errRow).toMatchObject({ action: 'resend' })
    // 身份留着：重发要用同一个 promptId，host 侧同号去重。
    expect(state.currentPromptId).toBeTruthy()
    expect(state.lastSentPromptId).toBe(userRow?.id)
  })

  it('503 只看 status、不看中文文案：rejected 分类同样标未送达并可重发', async () => {
    const { AgentTurnError } = await import('../../api/transport')
    // promptRpc 把非 502 的非 2xx 归为 rejected；hub 的 fast-503 正好落在
    // 这一类。判定必须按状态码，不能要求 kind === 'unreachable'。
    vi.mocked(transport.prompt).mockRejectedValue(
      new AgentTurnError('rejected', 'host 正在重连', 503),
    )

    await useChatStore.getState().send('重连时发的')

    const state = useChatStore.getState()
    const userRow = state.entries.find((e) => e.kind === 'user')
    expect(userRow).toMatchObject({ undelivered: true })
    const errRow = state.entries.find((e) => e.kind === 'error')
    expect(errRow).toMatchObject({ action: 'resend' })
    expect(errRow && 'text' in errRow ? errRow.text : '').toContain('消息未送达')
    const promptId = state.currentPromptId
    expect(promptId).toBeTruthy()

    expect(useChatStore.getState().resendUndeliveredPrompt()).toBe(true)
    await vi.waitFor(() => {
      expect(vi.mocked(transport.prompt)).toHaveBeenCalledTimes(2)
    })
    // 重发沿用同一条 promptId（host 侧同号去重）。
    expect(vi.mocked(transport.prompt).mock.calls[1]?.[1]).toMatchObject({
      promptId,
    })
  })

  it('重发把那一条回收重画，标记随之消失', async () => {
    const { AgentTurnError } = await import('../../api/transport')
    vi.mocked(transport.prompt)
      .mockRejectedValueOnce(
        new AgentTurnError('unreachable', 'host mba 当前离线', 503),
      )
      .mockResolvedValue(undefined as never)

    await useChatStore.getState().send('这条没送出去')
    expect(
      useChatStore.getState().entries.some(
        (e) => e.kind === 'user' && e.undelivered,
      ),
    ).toBe(true)

    expect(useChatStore.getState().resendUndeliveredPrompt()).toBe(true)
    // 重发是 fire-and-forget 的 send()，让它跑完。
    await vi.waitFor(() => {
      expect(vi.mocked(transport.prompt)).toHaveBeenCalledTimes(2)
    })
    await vi.waitFor(() => {
      const rows = useChatStore
        .getState()
        .entries.filter((e) => e.kind === 'user')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ text: '这条没送出去' })
      expect(rows[0]?.kind === 'user' && rows[0].undelivered).toBeFalsy()
    })
  })

  it('agent 拒绝（400）不是未送达：不留重试标记', async () => {
    const { AgentTurnError } = await import('../../api/transport')
    vi.mocked(transport.prompt).mockRejectedValue(
      new AgentTurnError('rejected', 'bad request', 400),
    )

    await useChatStore.getState().send('会被拒')

    const state = useChatStore.getState()
    expect(
      state.entries.some((e) => e.kind === 'user' && e.undelivered),
    ).toBe(false)
    expect(state.entries.some((e) => e.kind === 'error')).toBe(true)
  })
})
