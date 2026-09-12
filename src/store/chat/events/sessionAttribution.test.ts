import { describe, expect, it } from 'vitest'
import type { AcpEvent } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { handleChatEvent } from '../events'
import { isForeignSession, notifSessionId } from './wire'

function makeStore(seed: Partial<ChatState> = {}) {
  const state = {
    sessionId: 'mine',
    entries: [],
    bgTaskIndex: {},
    topTasks: [],
    mcpServers: [],
    layerErrors: {},
    recapCache: {},
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

/**
 * typed kind 事件在 handleChatEvent 里被重写成 generic session_notification
 * 形状；宿主 withSid 打上的顶层 sessionId 必须随事件转交，否则各 notif*
 * 的「非当前会话」守卫全部失效，别的会话的广播会画进本会话视图。
 */
describe('typed 事件的会话归属（handleChatEvent 全链路）', () => {
  it('外来会话的 hook_run_started 不点亮本会话 spinner', () => {
    const { get, set } = makeStore()
    handleChatEvent(set, get, {
      type: 'hook_run_started',
      sessionId: 'other',
      update: { sessionUpdate: 'hook_run_started', event_name: 'pre_tool_use', count: 1 },
    } as AcpEvent)
    expect(get().runningHook ?? null).toBeNull()
  })

  it('本会话的 hook_run_started 正常生效', () => {
    const { get, set } = makeStore()
    handleChatEvent(set, get, {
      type: 'hook_run_started',
      sessionId: 'mine',
      update: {
        sessionUpdate: 'hook_run_started',
        event_name: 'pre_tool_use',
        tool_name: 'bash',
        count: 2,
      },
    } as AcpEvent)
    expect(get().runningHook).toMatchObject({ eventName: 'pre_tool_use', toolName: 'bash', count: 2 })
  })

  it('外来会话的 background_tasks 不改本会话顶栏', () => {
    const { get, set } = makeStore()
    handleChatEvent(set, get, {
      type: 'background_tasks',
      sessionId: 'other',
      update: {
        sessionUpdate: 'background_tasks',
        tasks: [{ task_id: 't1', command: 'sleep 1', status: 'running', cwd: '/tmp' }],
      },
    } as AcpEvent)
    expect(get().topTasks).toEqual([])
  })

  it('本会话的 background_tasks 正常生效（含 foreign 守卫未误伤）', () => {
    const { get, set } = makeStore()
    handleChatEvent(set, get, {
      type: 'background_tasks',
      sessionId: 'mine',
      update: {
        sessionUpdate: 'background_tasks',
        tasks: [{ task_id: 't1', command: 'sleep 1', status: 'running', cwd: '/tmp' }],
      },
    } as AcpEvent)
    expect(get().topTasks).toMatchObject([{ taskId: 't1' }])
  })

  it('通用载体（params.sessionId）同样按归属过滤', () => {
    const { get, set } = makeStore()
    handleChatEvent(set, get, {
      type: 'session_notification',
      params: {
        sessionId: 'other',
        update: { sessionUpdate: 'hook_run_started', event_name: 'pre_tool_use' },
      },
    } as AcpEvent)
    expect(get().runningHook ?? null).toBeNull()
  })
})

describe('notifSessionId / isForeignSession', () => {
  it('顶层优先，回落到 params.sessionId', () => {
    expect(
      notifSessionId({ type: 'session_notification', sessionId: 'a', params: {} } as never),
    ).toBe('a')
    expect(
      notifSessionId({
        type: 'session_notification',
        params: { sessionId: 'b', update: {} },
      } as never),
    ).toBe('b')
    expect(notifSessionId({ type: 'session_notification', params: {} } as never)).toBeUndefined()
  })

  it('无 sid 的事件不算外来；视图未锚定时带 sid 的事件按外来处理', () => {
    const ev = { type: 'session_notification', sessionId: 'a' } as never
    expect(isForeignSession(ev, 'a')).toBe(false)
    expect(isForeignSession(ev, 'b')).toBe(true)
    expect(isForeignSession(ev, undefined)).toBe(true)
    expect(isForeignSession({ type: 'session_notification' } as never, 'a')).toBe(false)
  })
})
