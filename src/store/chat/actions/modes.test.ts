import { beforeEach, describe, expect, it, vi } from 'vitest'
import { modeActions } from './modes'
import type { ChatState, SetState } from '../types'

vi.mock('../../../api/client', () => ({
  transport: {
    respondClientRequest: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue({ ok: true }),
  },
}))

vi.mock('../../toast', () => ({
  pushToast: vi.fn(),
}))

vi.mock('../modeFlags', () => ({
  bumpReseedGen: vi.fn(() => 1),
  currentReseedGen: vi.fn(() => 1),
  drainPendingForYolo: vi.fn().mockResolvedValue(undefined),
  ENABLE_ALWAYS_APPROVE_OPTION_ID: '__always_approve__',
  markPlanExitApproved: vi.fn(),
  persistConfirmedPermission: vi.fn(),
  turnOnAlwaysApprove: vi.fn().mockResolvedValue(true),
}))

import { transport } from '../../../api/client'
import { pushToast } from '../../toast'

function makeState(patch: Partial<ChatState> = {}): ChatState {
  return {
    sessionId: 's1',
    cwd: '/w',
    xaiRequests: [],
    pending: [],
    entries: [],
    planMode: false,
    ...patch,
  } as unknown as ChatState
}

function bind(state: ChatState) {
  const set: SetState = (partial) => {
    Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
  }
  return modeActions(set, () => state)
}

const card = (requestId: string, method = 'x.ai/ask_user_question') => ({
  requestId,
  method,
  params: { questions: [] },
})

describe('respondXai', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(transport.respondClientRequest as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    )
  })

  it('成功 → 卡片移除且不弹 toast', async () => {
    const state = makeState({ xaiRequests: [card('r1')] })
    await bind(state).respondXai('r1', { outcome: 'accepted' })
    expect(state.xaiRequests).toEqual([])
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('回执失败（网络抖动 / ok:false）→ 保留卡片可重试 + toast', async () => {
    ;(transport.respondClientRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('client response failed'),
    )
    const state = makeState({ xaiRequests: [card('r1')] })
    await bind(state).respondXai('r1', { outcome: 'accepted' })
    expect(state.xaiRequests.map((r) => r.requestId)).toEqual(['r1'])
    expect(pushToast).toHaveBeenCalledWith(expect.stringContaining('回执发送失败'))
  })

  it('请求已被其他端应答 / 已过期 → 静默清卡（不留僵尸 UI、不弹 toast）', async () => {
    ;(transport.respondClientRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('pending request 不存在或已过期'),
    )
    const state = makeState({ xaiRequests: [card('r1')] })
    await bind(state).respondXai('r1', { outcome: 'accepted' })
    expect(state.xaiRequests).toEqual([])
    expect(pushToast).not.toHaveBeenCalled()
  })

  it('程序化拒绝（显式 error）失败 → 不弹 toast，也保留卡片', async () => {
    ;(transport.respondClientRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('offline'),
    )
    const state = makeState({ xaiRequests: [card('r1')] })
    await bind(state).respondXai('r1', undefined, '前端不支持方法 x.ai/nope')
    expect(pushToast).not.toHaveBeenCalled()
    expect(state.xaiRequests.map((r) => r.requestId)).toEqual(['r1'])
  })

  it('失败 → 不提前退出 plan 模式（回执没送达，agent 仍在 plan 里）', async () => {
    ;(transport.respondClientRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('client response failed'),
    )
    const state = makeState({
      planMode: true,
      xaiRequests: [card('r2', 'x.ai/exit_plan_mode')],
    })
    await expect(
      bind(state).respondXai('r2', { outcome: 'approved' }),
    ).resolves.toBeUndefined()
    expect(state.planMode).toBe(true)
  })

  it('成功应答 exit_plan_mode → 清掉本地 plan 标记', async () => {
    const state = makeState({
      planMode: true,
      permissionMode: 'plan',
      xaiRequests: [card('r2', 'x.ai/exit_plan_mode')],
    })
    await bind(state).respondXai('r2', { outcome: 'approved' })
    expect(state.planMode).toBe(false)
    expect(state.permissionMode).toBeUndefined()
  })
})

describe('togglePlanMode & selectMode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(transport.setMode as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
  })

  it('togglePlanMode: 未在 plan 模式时进入 plan 模式', async () => {
    const state = makeState({ planMode: false, showModeBanner: vi.fn() })
    await bind(state).togglePlanMode()
    expect(state.planMode).toBe(true)
    expect(transport.setMode).toHaveBeenCalledWith('plan', 's1')
  })

  it('togglePlanMode: 已在 plan 模式时退出 plan 模式并切回 normal', async () => {
    const state = makeState({ planMode: true, showModeBanner: vi.fn() })
    await bind(state).togglePlanMode()
    expect(state.planMode).toBe(false)
    expect(transport.setMode).toHaveBeenCalledWith('normal', 's1')
  })

  it('selectMode: 可在 normal / plan / auto 之间自由切换', async () => {
    const state = makeState({ planMode: false, autoMode: false, showModeBanner: vi.fn() })
    
    // 切换到 auto
    await bind(state).selectMode('auto')
    expect(state.autoMode).toBe(true)
    expect(state.planMode).toBe(false)
    expect(transport.setMode).toHaveBeenCalledWith('auto', 's1')

    // 切换到 plan
    await bind(state).selectMode('plan')
    expect(state.planMode).toBe(true)
    expect(state.autoMode).toBe(false)
    expect(transport.setMode).toHaveBeenCalledWith('plan', 's1')

    // 切换回 normal
    await bind(state).selectMode('normal')
    expect(state.planMode).toBe(false)
    expect(state.autoMode).toBe(false)
    expect(transport.setMode).toHaveBeenCalledWith('normal', 's1')
  })
})
