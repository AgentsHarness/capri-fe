import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transport } from '../../api/client'
import { useChatStore } from '../chat'

vi.mock('../../api/client', () => ({
  transport: {
    newSession: vi.fn(),
    setModel: vi.fn(),
    setDefaultModel: vi.fn(),
    gitInfo: vi.fn(),
    sessionResume: vi.fn(),
    sessionStats: vi.fn(),
    sessionRunningTasks: vi.fn(),
    loadSessionHistory: vi.fn(),
    queueStatus: vi.fn(),
    status: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    getConnectionMode: vi.fn(() => 'local'),
    connect: vi.fn(),
    disconnect: vi.fn(),
    prefsOrigin: vi.fn(() => ''),
    getPrefs: vi.fn(),
    putPrefs: vi.fn(),
    prompt: vi.fn(),
  },
}))

const NEW_SID = 's-new'
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 空状态（无会话）选的模型在新会话里落地。
 *
 * host 的 /api/set-model 必须带 sessionId（无 sid 直接 400），所以空状态下
 * setModel 只能把选择记进 pendingModel；newSession 锚定 sid 后补发切换，
 * 用户直接发第一条消息就等于带着新模型开跑。
 */
describe('空状态选的模型随新会话下发', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      sessionId: undefined,
      cwd: undefined,
      entries: [],
      pending: [],
      historyLoading: false,
      models: [
        {
          modelId: 'grok-4',
          name: 'Grok 4',
          reasoningEfforts: [{ id: 'high', label: 'high', value: 'high', default: true }],
        },
      ],
      pendingModel: undefined,
    })
    vi.mocked(transport.newSession).mockResolvedValue({ sessionId: NEW_SID } as never)
    vi.mocked(transport.setModel).mockResolvedValue({ ok: true } as never)
    vi.mocked(transport.setDefaultModel).mockResolvedValue({ ok: true } as never)
    vi.mocked(transport.gitInfo).mockResolvedValue({ branch: 'b' } as never)
  })

  afterEach(() => {
    useChatStore.getState().stopTopTaskPolling()
  })

  it('先选模型再建会话 → 锚定后补发，pendingModel 清空', async () => {
    await useChatStore.getState().setModel('grok-4', undefined)
    expect(transport.setModel).not.toHaveBeenCalled()
    expect(useChatStore.getState().pendingModel).toEqual({
      modelId: 'grok-4',
      reasoningEffort: 'high',
    })

    await useChatStore.getState().newSession()

    expect(transport.setModel).toHaveBeenCalledWith('grok-4', 'high', NEW_SID)
    expect(useChatStore.getState().sessionId).toBe(NEW_SID)
    expect(useChatStore.getState().pendingModel).toBeUndefined()
    expect(useChatStore.getState().modelName).toBe('Grok 4')
  })

  it('勾了「设为默认」→ 补发切换后再落盘默认模型', async () => {
    await useChatStore.getState().setModel('grok-4', 'low', { asDefault: true })

    await useChatStore.getState().newSession()

    expect(transport.setModel).toHaveBeenCalledWith('grok-4', 'low', NEW_SID)
    expect(transport.setDefaultModel).toHaveBeenCalledWith('grok-4', 'low', NEW_SID)
  })

  it('没选过模型 → 建会话不发切换请求', async () => {
    await useChatStore.getState().newSession()
    expect(transport.setModel).not.toHaveBeenCalled()
    expect(transport.setDefaultModel).not.toHaveBeenCalled()
  })

  it('补发失败不阻塞建会话：会话照常锚定并滚一行错误', async () => {
    vi.mocked(transport.setModel).mockRejectedValueOnce(new Error('boom'))
    await useChatStore.getState().setModel('grok-4', undefined)

    await useChatStore.getState().newSession()
    await wait(0)

    expect(useChatStore.getState().sessionId).toBe(NEW_SID)
    expect(useChatStore.getState().pendingModel).toBeUndefined()
    const texts = useChatStore.getState().entries.map((e) => ('text' in e ? e.text : ''))
    expect(texts.some((t) => t.includes('切换模型失败: boom'))).toBe(true)
  })

  it('空状态选模型后直接发第一条消息 → 先切模型再发 prompt', async () => {
    vi.mocked(transport.prompt).mockResolvedValue(undefined as never)
    await useChatStore.getState().setModel('grok-4', undefined)

    await useChatStore.getState().send('hello world')

    expect(transport.setModel).toHaveBeenCalledWith('grok-4', 'high', NEW_SID)
    expect(transport.prompt).toHaveBeenCalledTimes(1)
    // 顺序才是关键：模型必须在回合开跑之前落到会话上。
    const setModelOrder = vi.mocked(transport.setModel).mock.invocationCallOrder[0]
    const promptOrder = vi.mocked(transport.prompt).mock.invocationCallOrder[0]
    expect(setModelOrder).toBeLessThan(promptOrder)
  })
})
