import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpEvent } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { handleSessionNotification } from './sessionNotif'
import { resetUnconsumedWarningsForTest } from './sessionNotif'
import { dropsForeignEvent } from './attribution'
import {
  ACP_STANDARD_KINDS,
  EXTENSION_KINDS,
  FOREIGN_PROCESSED_TAGS,
  GLOBAL_TAGS,
  NOOP_TAGS,
  TYPED_PATH_KINDS,
  UNCONSUMED_KINDS,
  WEAK_KINDS,
} from './kinds'
import { handleChatEvent } from '../events'

function makeStore(initial: Partial<ChatState> = {}) {
  let state = {
    entries: [],
    sessionId: 's1',
    topTasks: [],
    scheduledTasks: [],
    bgTaskIndex: {},
    recapCache: {},
    mcpServers: [],
    layerErrors: {},
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

/** generic 形状（回放/未建模 kind 的载体）。 */
const generic = (tag: string, extra: Record<string, unknown> = {}, sid?: string) =>
  ({
    type: 'session_notification',
    ...(sid ? { sessionId: sid } : {}),
    params: { sessionUpdate: tag, ...extra },
  }) as AcpEvent

beforeEach(() => {
  resetUnconsumedWarningsForTest()
})

describe('归属守卫（分发层统一）', () => {
  it('外来会话的会话级 kind 一律丢弃', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['hook_run_started', { event_name: 'pre_tool_use' }],
      ['hook_execution', { event_name: 'pre_tool_use', runs: [] }],
      ['background_tasks', { tasks: [{ task_id: 't1', status: 'running' }] }],
      ['task_backgrounded', { task_id: 't1', command: 'sleep 1' }],
      ['task_completed', { task_snapshot: { task_id: 't1' } }],
      ['monitor_event', { task_id: 't1', event_text: 'x' }],
      ['scheduled_task_created', { task_id: 't1', prompt: 'p' }],
      ['scheduled_task_deleted', { task_id: 't1', reason: 'deleted' }],
      ['scheduled_task_fired', { task_id: 't1' }],
      ['subagent_progress', { subagent_id: 'sa1' }],
      ['goal_updated', { status: 'complete' }],
      ['workflow_updated', { run_id: 'r1', status: 'running' }],
      ['auto_compact_started', { percentage: 80 }],
      ['memory_files', { files: [] }],
      ['current_mode_update', { currentModeId: 'plan' }],
      ['model_changed', { model_id: 'm1' }],
    ]
    for (const [tag, extra] of cases) {
      const { set, get, state } = makeStore({ sessionId: 's1' })
      const handled = handleSessionNotification(set, get, generic(tag, extra, 'other'))
      expect(handled, tag).toBe(true)
      expect(state().runningHook ?? null, tag).toBeNull()
      expect(state().topTasks ?? [], tag).toEqual([])
      expect(state().scheduledTasks ?? [], tag).toEqual([])
      expect(state().planMode ?? false, tag).toBe(false)
      expect(state().statusText ?? '', tag).toBe('')
      expect(set, tag).not.toHaveBeenCalled()
    }
  })

  it('当前会话的同批 kind 正常生效（守卫未误伤）', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    handleSessionNotification(
      set,
      get,
      generic('hook_run_started', { event_name: 'pre_tool_use', count: 1 }, 's1'),
    )
    expect(state().runningHook).toMatchObject({ eventName: 'pre_tool_use' })

    handleSessionNotification(
      set,
      get,
      generic('background_tasks', { tasks: [{ task_id: 't1', status: 'running' }] }, 's1'),
    )
    expect(state().topTasks).toMatchObject([{ taskId: 't1' }])
  })

  it('全局 kind（yolo_mode_changed）带外来 sessionId 也应用', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    handleSessionNotification(
      set,
      get,
      generic('yolo_mode_changed', { yolo_mode: true }, 'other'),
    )
    expect(state().yoloMode).toBe(true)
  })

  it('recap 例外：外来会话的 recap 仍按会话缓存', () => {
    const { set, get, state } = makeStore({ sessionId: 's1' })
    handleSessionNotification(
      set,
      get,
      generic('session_recap', { summary: '上一次说到哪' }, 'other'),
    )
    expect(state().recapCache.other?.text).toBe('上一次说到哪')
    // 不污染当前视图
    expect(state().entries).toHaveLength(0)
  })

  it('外来会话的 hook_execution 不落生命周期条目', () => {
    const { set, get, state } = makeStore({
      sessionId: 's1',
      currentPromptId: 'p1',
      conn: 'busy',
    })
    handleSessionNotification(
      set,
      get,
      generic(
        'hook_execution',
        {
          event_name: 'session_start',
          runs: [{ name: 'boot', status: 'success' }],
        },
        'other',
      ),
    )
    expect(state().entries).toEqual([])
    expect(state().runningHook ?? null).toBeNull()
  })

  it('dropsForeignEvent 与分发层结论一致', () => {
    const ev = generic('hook_run_started', {}, 'other')
    expect(dropsForeignEvent(ev, 's1')).toBe(true)
    expect(dropsForeignEvent(generic('session_recap', {}, 'other'), 's1')).toBe(false)
    expect(dropsForeignEvent(generic('yolo_mode_changed', {}, 'other'), 's1')).toBe(false)
    expect(dropsForeignEvent(generic('hook_run_started', {}, 's1'), 's1')).toBe(false)
  })
})

describe('显式空操作与未消费清单', () => {
  it('NOOP_TAGS 一律 ack 且不产生状态变更', () => {
    for (const tag of NOOP_TAGS) {
      const { set, get } = makeStore({ sessionId: 's1' })
      const handled = handleSessionNotification(set, get, generic(tag, {}, 's1'))
      expect(handled, tag).toBe(true)
      expect(set, tag).not.toHaveBeenCalled()
    }
  })

  it('未消费 kind 不触发告警（已登记决策）；真正没人认领的新 kind 才告警且只打一次', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { set, get } = makeStore({ sessionId: 's1' })
    expect(handleSessionNotification(set, get, generic('last_turn_summary', {}, 's1'))).toBe(true)
    expect(warn).not.toHaveBeenCalled()

    // host 未来新增建模的 kind：归一后无人认领 → DEV 告警（一次）
    expect(handleSessionNotification(set, get, generic('brand_new_kind', {}, 's1'))).toBe(false)
    expect(handleSessionNotification(set, get, generic('brand_new_kind', {}, 's1'))).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('归一入口（handleChatEvent 全链路）', () => {
  it('params 形状的 typed 事件（x.ai 独立通道）走同一消费点', () => {
    const { get, set } = makeStore({ sessionId: 's1' })
    handleChatEvent(set, get, {
      type: 'task_backgrounded',
      sessionId: 's1',
      params: { task_id: 't1', command: 'some-cmd' },
    } as AcpEvent)
    expect(get().entries).toMatchObject([{ kind: 'bg_task', taskId: 't1' }])
  })

  it('params 形状的 yolo_mode_changed（原 extSession 分支）仍生效', () => {
    const { get, set } = makeStore({ sessionId: 's1' })
    handleChatEvent(set, get, {
      type: 'yolo_mode_changed',
      params: { yolo_mode: true, permission_mode: 'auto' },
    } as AcpEvent)
    expect(get().yoloMode).toBe(true)
    expect(get().permissionMode).toBe('auto')
  })

  it('宿主归一过的顶层载荷（scheduled_task_deleted）走同一消费点', () => {    const task = { taskId: 'task-123', prompt: 'p', interval: '1h', status: 'active' as const }
    const { get, set } = makeStore({ sessionId: 's1', scheduledTasks: [task] })
    handleChatEvent(set, get, {
      type: 'scheduled_task_deleted',
      sessionId: 's1',
      taskId: 'task-123',
      reason: 'deleted',
    } as AcpEvent)
    expect(get().scheduledTasks).toEqual([])
    expect(get().entries).toMatchObject([{ kind: 'session_event' }])
  })

  it('外来会话的 scheduled_task_deleted 不改本会话列表/滚动区', () => {
    const task = { taskId: 'task-123', prompt: 'p', interval: '1h', status: 'active' as const }
    const { get, set } = makeStore({ sessionId: 's1', scheduledTasks: [task] })
    handleChatEvent(set, get, {
      type: 'scheduled_task_deleted',
      sessionId: 'other',
      taskId: 'task-123',
      reason: 'deleted',
    } as AcpEvent)
    expect(get().scheduledTasks).toEqual([task])
    expect(get().entries).toHaveLength(0)
  })

  it('snake_case 载荷在入口获得 camelCase 别名（消费点只读一套字段名）', () => {
    const { get, set } = makeStore({ sessionId: 's1' })
    handleChatEvent(set, get, {
      type: 'subscription_probe_unknown_kind',
      update: {
        sessionUpdate: 'task_backgrounded',
        task_id: 't9',
        monitor_description: 'watch log',
      },
      sessionId: 's1',
    } as unknown as AcpEvent)
    expect(get().entries).toMatchObject([
      { kind: 'bg_task', taskId: 't9', isMonitor: true, title: 'watch log' },
    ])
  })
})

describe('覆盖度门禁（kinds ↔ 消费点）', () => {
  it('每个扩展 kind 都有消费点或明确登记为空操作/未消费', () => {
    const missing: string[] = []
    for (const tag of EXTENSION_KINDS) {
      const { set, get } = makeStore({ sessionId: 's1' })
      const handled = handleSessionNotification(set, get, generic(tag, {}, 's1'))
      if (!handled && !NOOP_TAGS.has(tag) && !UNCONSUMED_KINDS.has(tag) && !TYPED_PATH_KINDS.has(tag)) {
        missing.push(tag)
      }
    }
    expect(missing).toEqual([])
  })

  it('每个官方 ACP kind 要么在 notif* 分发，要么登记为 typed 链路/回放消费', () => {
    const missing: string[] = []
    for (const tag of ACP_STANDARD_KINDS) {
      if (TYPED_PATH_KINDS.has(tag)) continue
      const { set, get } = makeStore({ sessionId: 's1' })
      const handled = handleSessionNotification(set, get, generic(tag, {}, 's1'))
      if (!handled && !NOOP_TAGS.has(tag) && !UNCONSUMED_KINDS.has(tag)) missing.push(tag)
    }
    expect(missing).toEqual([])
  })

  it('清单互斥：NOOP / UNCONSUMED / GLOBAL / FOREIGN_PROCESSED 不重叠', () => {
    const sets: Array<[string, Iterable<string>]> = [
      ['NOOP', NOOP_TAGS],
      ['UNCONSUMED', [...UNCONSUMED_KINDS.keys()]],
      ['GLOBAL', GLOBAL_TAGS],
      ['FOREIGN_PROCESSED', FOREIGN_PROCESSED_TAGS],
    ]
    const seen = new Map<string, string>()
    for (const [name, tags] of sets) {
      for (const tag of tags) {
        expect(seen.has(tag), `${tag} 同时出现在 ${seen.get(tag)} 与 ${name}`).toBe(false)
        seen.set(tag, name)
      }
    }
  })

  it('弱实现清单（D6）里的 kind 都确有消费点（清单不能腐烂）', () => {
    for (const tag of WEAK_KINDS) {
      const { set, get } = makeStore({ sessionId: 's1' })
      expect(handleSessionNotification(set, get, generic(tag, {}, 's1')), tag).toBe(true)
    }
  })
})
