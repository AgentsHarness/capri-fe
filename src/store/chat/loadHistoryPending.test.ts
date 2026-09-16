import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingReq } from '../../api/types'
import { transport } from '../../api/client'
import { useChatStore } from '../chat'
import { clearHistoryWindowBuffer } from './globals'

vi.mock('../../api/client', () => ({ transport: {
  loadSessionHistory: vi.fn(),
  queueStatus: vi.fn().mockResolvedValue({ queue: [] }),
  onEvent: vi.fn(() => () => {}),
  getConnectionMode: vi.fn(() => 'local'),
} }))

const request = (requestId: string, sessionId: string, method = 'session/request_permission'): PendingReq => ({
  requestId, sessionId, method, params: { sessionId },
})

describe('历史加载期间的审批快照', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearHistoryWindowBuffer()
    useChatStore.setState({
      sessionId: 'A', cwd: '/tmp', entries: [], historyLoading: false,
      pending: [request('permission-A', 'A'), request('permission-B', 'B')],
      xaiRequests: [request('question-A', 'A', 'x.ai/ask_user_question')],
    })
    vi.mocked(transport.loadSessionHistory).mockResolvedValue({
      updates: [], totalCount: 0, hasMore: false,
    } as never)
  })

  it('保留 hello 恢复的当前会话审批和问题，排除其他会话', async () => {
    await useChatStore.getState().loadHistory('A', '/tmp')
    expect(useChatStore.getState().pending.map(r => r.requestId)).toEqual(['permission-A'])
    expect(useChatStore.getState().xaiRequests.map(r => r.requestId)).toEqual(['question-A'])
  })

  it('加载过程中收到已解决事件，历史完成不能复活旧卡片', async () => {
    let finish!: (value: never) => void
    vi.mocked(transport.loadSessionHistory).mockReturnValue(new Promise(resolve => { finish = resolve }) as never)
    const loading = useChatStore.getState().loadHistory('A', '/tmp')
    useChatStore.getState().handleEvent({ type: 'client_request_resolved', requestId: 'permission-A', sessionId: 'A' })
    useChatStore.getState().handleEvent({ type: 'client_request_resolved', requestId: 'question-A', sessionId: 'A' })
    finish({ updates: [], totalCount: 0, hasMore: false } as never)
    await loading
    expect(useChatStore.getState().pending).toEqual([])
    expect(useChatStore.getState().xaiRequests).toEqual([])
  })
})
