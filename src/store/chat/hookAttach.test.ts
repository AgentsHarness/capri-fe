import { describe, expect, it } from 'vitest'
import type { HookRun, ScrollEntry, ToolCall } from '../../api/types'
import {
  attachStopHooksToMarker,
  attachToolHooks,
  claimPendingToolHooks,
  isTurnTerminalMarker,
  lastToolCallEntryId,
  latestTurnMarkerAccepting,
  lifecycleEntry,
  toolHookTargetId,
  toolNameKeys,
} from './hookAttach'

const ok = (name = 'h'): HookRun => ({
  name,
  status: { type: 'success', elapsedMs: 1 },
})

function tool(over: Partial<Extract<ScrollEntry, { kind: 'tool' }>> = {}): ScrollEntry {
  return {
    id: over.id ?? 't1',
    kind: 'tool',
    title: over.title ?? 'list_dir',
    verb: 'Listed',
    status: over.status ?? 'completed',
    kindName: over.kindName ?? 'list_dir',
    raw: (over.raw ?? {
      title: 'list_dir',
      _meta: { 'x.ai/tool': { name: 'list_dir' } },
    }) as ToolCall,
    ...over,
  }
}

function marker(
  over: Partial<Extract<ScrollEntry, { kind: 'session_event' }>> = {},
): Extract<ScrollEntry, { kind: 'session_event' }> {
  return {
    id: over.id ?? 'm1',
    kind: 'session_event',
    text: over.text ?? 'Worked for 1.0s',
    ...over,
  }
}

describe('lastToolCallEntryId / tool names', () => {
  it('跳过 lifecycle 行，只认真正的 tool', () => {
    const life = lifecycleEntry('session_start', [ok()])
    expect(lastToolCallEntryId([tool({ id: 'a' }), life])).toBe('a')
    expect(lastToolCallEntryId([life])).toBeUndefined()
  })

  it('按 x.ai/tool.name / kindName 认领', () => {
    const e = tool() as Extract<ScrollEntry, { kind: 'tool' }>
    expect(toolNameKeys(e)).toContain('list_dir')
    expect(toolHookTargetId([tool({ id: 'a', status: 'completed' })], 'pre', 'list_dir')).toBe('a')
    expect(toolHookTargetId([tool({ id: 'a', status: 'completed' })], 'pre', 'execute')).toBeUndefined()
  })

  it('无名匹配只在 in-flight 行上回退位置', () => {
    expect(toolHookTargetId([tool({ id: 'a', status: 'completed' })], 'pre', 'other')).toBeUndefined()
    expect(
      toolHookTargetId([tool({ id: 'a', status: 'in_progress' })], 'pre', 'other'),
    ).toBe('a')
    expect(toolHookTargetId([tool({ id: 'a' })], 'pre')).toBe('a')
  })
})

describe('attachToolHooks / claimPendingToolHooks', () => {
  it('同 phase 覆盖而非追加', () => {
    const entries = [tool({ id: 'a', hooks: { pre: [ok('old')] } })]
    const next = attachToolHooks(entries, 'a', 'pre', [ok('new')])
    expect(next[0].kind === 'tool' && next[0].hooks).toEqual({ pre: [ok('new')] })
  })

  it('新行认领排队批次，留下别人的', () => {
    const entry = tool({ id: 'a' })
    const { entries, pending } = claimPendingToolHooks(
      [entry],
      entry,
      [
        { phase: 'pre', toolName: 'list_dir', runs: [ok('mine')] },
        { phase: 'post', toolName: 'execute', runs: [ok('other')] },
      ],
    )
    expect(entries[0].kind === 'tool' && entries[0].hooks).toEqual({ pre: [ok('mine')] })
    expect(pending).toEqual([{ phase: 'post', toolName: 'execute', runs: [ok('other')] }])
  })
})

describe('turn-terminal marker attach', () => {
  it('识别回合收口文案，忽略 idle-watcher', () => {
    expect(isTurnTerminalMarker(marker())).toBe(true)
    expect(isTurnTerminalMarker(marker({ text: 'Turn completed.' }))).toBe(true)
    expect(isTurnTerminalMarker(marker({ text: 'Turn cancelled by user in 1.0s.' }))).toBe(true)
    expect(isTurnTerminalMarker(marker({ text: 'Turn failed: boom' }))).toBe(true)
    expect(isTurnTerminalMarker(marker({ text: 'Turn blocked by a hook in 1.0s.' }))).toBe(true)
    expect(
      isTurnTerminalMarker(
        marker({ text: 'Agent was unable to make progress. Turn ended in 2.0s.' }),
      ),
    ).toBe(true)
    expect(isTurnTerminalMarker(marker({ text: '… still running' }))).toBe(false)
  })

  it('unstamped 只认尾巴；同名拒绝；pid 匹配可跨间隔块', () => {
    const m = marker({ id: 'm', promptId: 'pid-new' })
    const extra: ScrollEntry = { id: 'x', kind: 'session_event', text: 'Context compacted → 10 tokens' }
    expect(latestTurnMarkerAccepting([m], 'stop', undefined)).toBe('m')
    expect(latestTurnMarkerAccepting([m, extra], 'stop', undefined)).toBeUndefined()
    expect(latestTurnMarkerAccepting([m, extra], 'stop', 'pid-new')).toBe('m')
    expect(latestTurnMarkerAccepting([m, extra], 'stop', 'pid-old')).toBeUndefined()

    const withStop = marker({
      id: 'm',
      stopHooks: [{ event: 'stop', runs: [ok()] }],
    })
    expect(latestTurnMarkerAccepting([withStop], 'stop', undefined)).toBeUndefined()
    expect(latestTurnMarkerAccepting([withStop], 'stop_failure', undefined)).toBe('m')
  })

  it('不跨过更新的回合标记', () => {
    const old = marker({ id: 'old', promptId: 'pid-old' })
    const newer = marker({ id: 'new', promptId: 'pid-new', text: 'Worked for 2.0s' })
    expect(latestTurnMarkerAccepting([old, newer], 'stop', 'pid-old')).toBeUndefined()
    expect(latestTurnMarkerAccepting([old, newer], 'stop', 'pid-new')).toBe('new')
  })

  it('attach 拒绝非标记 / 外回合 pid', () => {
    const m = marker({ id: 'm', promptId: 'pid-a' })
    expect(attachStopHooksToMarker([m], 'm', { event: 'stop', runs: [ok()] }, 'pid-b').attached).toBe(
      false,
    )
    const recap: ScrollEntry = { id: 'r', kind: 'session_event', text: 'sum', recap: true }
    expect(
      attachStopHooksToMarker([recap], 'r', { event: 'stop', runs: [ok()] }, undefined).attached,
    ).toBe(false)
    const okAttach = attachStopHooksToMarker([m], 'm', { event: 'stop', runs: [ok()] }, 'pid-a')
    expect(okAttach.attached).toBe(true)
    expect(okAttach.entries[0].kind === 'session_event' && okAttach.entries[0].stopHooks).toHaveLength(1)
    expect(okAttach.entries[0].kind === 'session_event' && okAttach.entries[0].open).toBe(false)
  })

  it('已展开的标记行 attach 保持展开（TUI display_mode_pinned 近似）', () => {
    const m = marker({ id: 'm', promptId: 'pid-a', open: true })
    const res = attachStopHooksToMarker([m], 'm', { event: 'stop', runs: [ok()] }, 'pid-a')
    expect(res.attached).toBe(true)
    const e = res.entries[0]
    expect(e.kind === 'session_event' && e.stopHooks).toHaveLength(1)
    expect(e.kind === 'session_event' && e.open).toBe(true)
  })
})
