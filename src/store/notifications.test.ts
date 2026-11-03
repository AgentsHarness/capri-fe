import { beforeAll, describe, expect, it, vi } from 'vitest'
import { useChatStore } from './chat'
import { initUiNotifications } from './notifications'

// 标题 / 通知配置按默认值走：settings 的 HTTP 拉取与本测试无关（其余
// 导出保持真实实现——store 的其它模块也从这里读密度等偏好）。
vi.mock('./settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./settings')>()
  return {
    ...actual,
    ensureUiSettings: async () => ({}),
    notificationsSettings: () => ({}),
    onUiSettingsReady: () => {},
  }
})

/** 一次会话名册行（busy 由 host 的 status.busy 表达）。 */
const row = (sessionId: string, busy: boolean) => ({
  sessionId,
  status: { state: busy ? ('active' as const) : ('idle' as const), busy },
})

// 订阅只装一次（inited 保护），与 App 挂载时同款。
beforeAll(() => initUiNotifications())

describe('完成提醒：sessions 状态转移的统一订阅', () => {
  it('busy true → false 的会话各记一次完成（当前会话除外）', async () => {
    useChatStore.setState({
      sessionId: 'cur',
      completedNotices: {},
      sessions: [row('cur', true), row('other', true)],
    } as never)

    useChatStore.setState({
      sessions: [row('cur', false), row('other', false), row('fresh', false)],
    } as never)
    await Promise.resolve()

    const notices = useChatStore.getState().completedNotices
    expect(Object.keys(notices)).toEqual(['other'])
  })

  it('没有 busy → idle 转移时不再新增提醒', async () => {
    useChatStore.setState({
      sessionId: 'cur',
      completedNotices: {},
      sessions: [row('cur', false), row('other', false)],
    } as never)
    useChatStore.setState({
      sessions: [row('cur', true), row('other', false)],
    } as never)
    await Promise.resolve()
    expect(useChatStore.getState().completedNotices).toEqual({})
  })

  it('会话从名册消失不算完成', async () => {
    useChatStore.setState({
      sessionId: 'cur',
      completedNotices: {},
      sessions: [row('gone', true)],
    } as never)
    useChatStore.setState({ sessions: [row('cur', false)] } as never)
    await Promise.resolve()
    expect(useChatStore.getState().completedNotices).toEqual({})
  })
})

describe('浏览器标题的已完成计数', () => {
  it('当前会话跑完不留"待查看"记录，切走后标题仍是空闲', async () => {
    useChatStore.setState({
      sessionId: 'cur',
      completedNotices: {},
      sessions: [row('cur', true)],
    } as never)
    useChatStore.setState({ sessions: [row('cur', false)] } as never)
    await Promise.resolve()
    // 当前会话的完成：用户已经看到，不记完成记录。
    expect(useChatStore.getState().completedNotices.cur).toBeUndefined()
    expect(document.title).toBe('[空闲] Agents Harness')

    // 切到别的会话后，不应凭空出现"已完成"。
    useChatStore.setState({ sessionId: 'other' } as never)
    expect(document.title).toBe('[空闲] Agents Harness')
  })
})
