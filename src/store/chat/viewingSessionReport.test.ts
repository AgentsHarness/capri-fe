import { beforeEach, describe, expect, it, vi } from 'vitest'
import { transport } from '../../api/client'
import { useChatStore } from '../chat'

/**
 * 在线订阅者面板的「正在查看」列：会话切到哪，store 就把哪报给 hub。
 *
 * 这条订阅挂在 store 的 sessionId 变化上（见 store.ts 的 prompt-queue
 * 订阅块）。它很容易失效：改一次 reset 顺序、或者把访客守卫写成
 * 「有 guestSessions 就不报」，管理员页面就会永远停在旧会话名上。
 */
vi.mock('../../api/client', () => ({
  transport: {
    reportViewingSession: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    getConnectionMode: vi.fn(() => 'hub'),
  },
}))

const report = vi.mocked(transport.reportViewingSession)

beforeEach(() => {
  // 先把状态摆到已知起点（这一步本身会触发一次上报），再清空记录。
  useChatStore.setState({
    mode: 'hub',
    guestIdentity: undefined,
    sessionId: 's-init',
  })
  report.mockClear()
})

describe('订阅者台账：当前会话上报', () => {
  it('sessionId 换到新会话就上报，切回空状态报 null', () => {
    useChatStore.setState({ sessionId: 's-new' })
    expect(report).toHaveBeenLastCalledWith('s-new')

    useChatStore.setState({ sessionId: undefined })
    expect(report).toHaveBeenLastCalledWith(null)
  })

  it('同一会话内的其他状态变化不重复上报', () => {
    useChatStore.setState({ sessionId: 's1' })
    report.mockClear()
    useChatStore.setState({ statusText: '工作中…', conn: 'busy' })
    expect(report).not.toHaveBeenCalled()
  })

  it('访客身份不上报（hub 的访客会话走带白名单校验的 subscribe 帧）', () => {
    useChatStore.setState({
      guestIdentity: {
        role: 'guest',
        guest: { id: 'g_1', label: '小王', expiresAt: 0 },
        sessions: [{ hostId: 'h1', sessionId: 's1' }],
      },
    })
    useChatStore.setState({ sessionId: 's1' })
    expect(report).not.toHaveBeenCalled()
  })

  it('local 模式不上报（没有 hub 台账可写）', () => {
    useChatStore.setState({ mode: 'local', sessionId: 's1' })
    expect(report).not.toHaveBeenCalled()
  })
})
