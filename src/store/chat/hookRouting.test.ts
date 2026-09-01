import { describe, expect, it } from 'vitest'
import type { HookRun, ScrollEntry, ToolCall } from '../../api/types'
import {
  MAX_PENDING_TOOL_HOOKS,
  clearPendingToolHooks,
  drainPendingStopHooks,
  emptyHookRouting,
  routeHookBatch,
  stashStopBatch,
  withTurnTerminalMarker,
} from './hookRouting'

const ok = (name = 'h'): HookRun => ({
  name,
  status: { type: 'success', elapsedMs: 1 },
})

function tool(id = 't1'): ScrollEntry {
  return {
    id,
    kind: 'tool',
    title: 'list_dir',
    verb: 'Listed',
    status: 'completed',
    kindName: 'list_dir',
    raw: { title: 'list_dir', _meta: { 'x.ai/tool': { name: 'list_dir' } } } as unknown as ToolCall,
  }
}

function marker(id = 'm1', over: Partial<Extract<ScrollEntry, { kind: 'session_event' }>> = {}): ScrollEntry {
  return { id, kind: 'session_event', text: 'Worked for 1.0s', ...over }
}

const live = { turnActive: true, currentPromptId: 'p1' }
const idle = { turnActive: false, currentPromptId: 'p1' }

describe('routeHookBatch', () => {
  it('pre/post 挂到匹配工具行，否则排队', () => {
    const hit = routeHookBatch(
      [tool()],
      emptyHookRouting(),
      { event: 'pre_tool_use', toolName: 'list_dir', runs: [ok()] },
      live,
    )
    expect(hit.target).toBe('tool')
    expect(hit.entries[0].kind === 'tool' && hit.entries[0].hooks?.pre).toEqual([ok()])

    const queued = routeHookBatch(
      [],
      emptyHookRouting(),
      { event: 'post_tool_use', toolName: 'list_dir', runs: [ok()] },
      live,
    )
    expect(queued.target).toBe('tool-queued')
    expect(queued.routing.pendingToolHooks).toHaveLength(1)
  })

  it('排队超过 MAX_PENDING_TOOL_HOOKS 截尾', () => {
    let routing = emptyHookRouting()
    let entries: ScrollEntry[] = []
    for (let i = 0; i < MAX_PENDING_TOOL_HOOKS + 3; i++) {
      const r = routeHookBatch(
        entries,
        routing,
        { event: 'pre_tool_use', toolName: `t${i}`, runs: [ok(`h${i}`)] },
        live,
      )
      routing = r.routing
      entries = r.entries
    }
    expect(routing.pendingToolHooks).toHaveLength(MAX_PENDING_TOOL_HOOKS)
  })

  it('live 回合的 stop 进 stash；idle 且有可收标记才直接挂', () => {
    const stashed = routeHookBatch(
      [tool()],
      emptyHookRouting(),
      { event: 'stop', promptId: 'p1', runs: [ok()] },
      live,
    )
    expect(stashed.target).toBe('stash')
    expect(stashed.routing.pendingStopHooks?.groups).toHaveLength(1)
    expect(stashed.routing.pendingStopHooks?.promptId).toBe('p1')

    const onMarker = routeHookBatch(
      [marker('m', { promptId: 'p1' })],
      emptyHookRouting(),
      { event: 'stop', promptId: 'p1', runs: [ok()] },
      idle,
    )
    expect(onMarker.target).toBe('marker')
    expect(
      onMarker.entries[0].kind === 'session_event' && onMarker.entries[0].stopHooks?.[0].event,
    ).toBe('stop')
  })

  it('live 且已有标记仍 stash（TUI 先 stash 再认 marker）', () => {
    const r = routeHookBatch(
      [marker('m', { promptId: 'p1' })],
      emptyHookRouting(),
      { event: 'stop', promptId: 'p1', runs: [ok()] },
      live,
    )
    expect(r.target).toBe('stash')
    expect(r.entries[0].kind).toBe('session_event')
    expect(
      r.entries[0].kind === 'session_event' && r.entries[0].stopHooks,
    ).toBeUndefined()
    expect(r.routing.pendingStopHooks?.groups).toHaveLength(1)
  })

  it('回放期 stop 一律 lifecycle，不 stash', () => {
    const r = routeHookBatch(
      [tool()],
      emptyHookRouting(),
      { event: 'stop', promptId: 'p1', runs: [ok()] },
      { ...live, isReplay: true },
    )
    expect(r.target).toBe('lifecycle')
    expect(r.entries[1]).toMatchObject({ kind: 'lifecycle', event: 'stop' })
    expect(r.routing.pendingStopHooks).toBeUndefined()
  })

  it('wake 批次不视为 foreign、不进 stash；有匹配标记才挂', () => {
    const wake = 'task-completed-abc'
    const noMarker = routeHookBatch(
      [tool()],
      emptyHookRouting(),
      { event: 'stop', promptId: wake, runs: [ok()] },
      live,
    )
    expect(noMarker.target).toBe('lifecycle')
    expect(noMarker.routing.pendingStopHooks).toBeUndefined()

    const onMarker = routeHookBatch(
      [marker('m', { promptId: wake })],
      emptyHookRouting(),
      { event: 'stop', promptId: wake, runs: [ok()] },
      live,
    )
    expect(onMarker.target).toBe('marker')
  })

  it('stash pid 兜底 currentPromptId；无 batch pid 不可同名合并', () => {
    const r = routeHookBatch(
      [tool()],
      emptyHookRouting(),
      { event: 'stop', runs: [ok()] },
      live,
    )
    expect(r.target).toBe('stash')
    expect(r.routing.pendingStopHooks?.promptId).toBe('p1')
    expect(r.routing.pendingStopHooks?.mergeSameName).toBe(false)
  })

  it('外回合 pid / 非 stop 生命周期 → lifecycle 行', () => {
    const foreign = routeHookBatch(
      [],
      emptyHookRouting(),
      { event: 'stop', promptId: 'other', runs: [ok()] },
      live,
    )
    expect(foreign.target).toBe('lifecycle')
    expect(foreign.entries[0]).toMatchObject({ kind: 'lifecycle', event: 'stop' })

    const start = routeHookBatch(
      [],
      emptyHookRouting(),
      { event: 'session_start', runs: [ok()] },
      live,
    )
    expect(start.target).toBe('lifecycle')
    expect(start.entries[0]).toMatchObject({ kind: 'lifecycle', event: 'session_start' })
  })

  it('idle 且没有可收标记 → lifecycle（不丢）', () => {
    const r = routeHookBatch(
      [tool()],
      emptyHookRouting(),
      { event: 'stop', runs: [ok()] },
      idle,
    )
    expect(r.target).toBe('lifecycle')
  })
})

describe('stash / drain / marker', () => {
  it('同 pid 同名合并；不同 pid 冲刷旧 stash', () => {
    const a = stashStopBatch(
      undefined,
      { event: 'stop', runs: [ok('a')], promptId: 'p1' },
      { stashPromptId: 'p1', mergeSameName: true },
    )
    expect(a.stash.mergeSameName).toBe(true)
    const b = stashStopBatch(
      a.stash,
      { event: 'stop', runs: [ok('b')], promptId: 'p1' },
      { stashPromptId: 'p1', mergeSameName: true },
    )
    expect(b.flushed).toEqual([])
    expect(b.stash.groups[0].runs).toHaveLength(2)

    const c = stashStopBatch(
      b.stash,
      { event: 'stop', runs: [ok('c')], promptId: 'p2' },
      { stashPromptId: 'p2', mergeSameName: true },
    )
    expect(c.flushed).toHaveLength(1)
    expect(c.stash.promptId).toBe('p2')
  })

  it('无 pid 的同名不合并：保留旧 stash，新批次 standalone', () => {
    const a = stashStopBatch(
      undefined,
      { event: 'stop', runs: [ok('a')] },
      { stashPromptId: 'p1', mergeSameName: false },
    )
    expect(a.stash.mergeSameName).toBe(false)
    const b = stashStopBatch(
      a.stash,
      { event: 'stop', runs: [ok('b')] },
      { stashPromptId: 'p1', mergeSameName: false },
    )
    expect(b.flushed).toEqual([{ event: 'stop', runs: [ok('b')] }])
    expect(b.stash.groups[0].runs).toEqual([ok('a')])
  })

  it('drain：本回合 fold，外回合变 lifecycle 行', () => {
    const routing = {
      pendingToolHooks: [],
      pendingStopHooks: {
        promptId: 'p1',
        groups: [{ event: 'stop', runs: [ok()] }],
        mergeSameName: true,
      },
    }
    const mine = drainPendingStopHooks(routing, 'p1')
    expect(mine.fold).toHaveLength(1)
    expect(mine.standalone).toEqual([])

    const stale = drainPendingStopHooks(routing, 'p2')
    expect(stale.fold).toEqual([])
    expect(stale.standalone[0]).toMatchObject({ kind: 'lifecycle', event: 'stop' })
  })

  it('withTurnTerminalMarker 把 stash 折进标记', () => {
    const routing = {
      pendingToolHooks: [],
      pendingStopHooks: {
        promptId: 'p1',
        groups: [{ event: 'stop', runs: [ok()] }],
        mergeSameName: true,
      },
    }
    const tail = withTurnTerminalMarker(routing, marker('m') as Extract<ScrollEntry, { kind: 'session_event' }>, 'p1')
    expect(tail.entries).toHaveLength(1)
    expect(tail.entries[0]).toMatchObject({
      kind: 'session_event',
      stopHooks: [{ event: 'stop', runs: [ok()] }],
      open: false,
    })
    expect(tail.routing.pendingStopHooks).toBeUndefined()
  })

  it('withTurnTerminalMarker 无 fold 时标记也带上回合 pid（TUI push_end_marker_block）', () => {
    const tail = withTurnTerminalMarker(
      { pendingToolHooks: [] },
      marker('m') as Extract<ScrollEntry, { kind: 'session_event' }>,
      'p1',
    )
    expect(tail.entries).toHaveLength(1)
    expect(tail.entries[0]).toMatchObject({ id: 'm', promptId: 'p1' })
    expect((tail.entries[0] as { stopHooks?: unknown }).stopHooks).toBeUndefined()
    expect(tail.routing.pendingStopHooks).toBeUndefined()
  })

  it('clearPendingToolHooks 回合结束丢弃排队', () => {
    const r = clearPendingToolHooks({
      pendingToolHooks: [{ phase: 'pre', runs: [ok()] }],
    })
    expect(r.pendingToolHooks).toEqual([])
  })
})
