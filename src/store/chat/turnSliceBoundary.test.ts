import { beforeEach, describe, expect, it } from 'vitest'
import { useChatStore } from '../../store/chat'
import { replayUpdates, applyEntryMsgSeq, sortEntriesByMsgSeq } from '../../store/chat/history'
import { settleTurnEntries } from '../../store/chat/turnLifecycle'
import { extractToolDetail } from '../../scrollback/toolDetail'
import type { AcpEvent, ScrollEntry } from '../../api/types'
import envs from './turnSliceFixture.json'

beforeEach(() => {
  useChatStore.setState({
    entries: [],
    toolIndex: {},
    selectedId: null,
    sessionId: '01a053eb-33c3-7392-a2b9-ea4eb3ee3dda',
    conn: 'ready',
    topTasks: [],
  })
})

describe('真实回放切片（turnIndex:1）→ 工具行内容', () => {
  it('replayUpdates + settleTurnEntries 后 read 行仍有内容', () => {
    const get = () => useChatStore.getState()
    const replay = replayUpdates(get, envs as unknown[])
    const sealed = settleTurnEntries(get().entries)
    const stamped = applyEntryMsgSeq(sealed, replay.entryMsgSeq)
    const entries = sortEntriesByMsgSeq(stamped)
    useChatStore.setState({ entries })
    const readRow = entries.find(
      (e): e is Extract<ScrollEntry, { kind: 'tool' }> =>
        e.kind === 'tool' && e.toolCallId === 'call_9385c205fa3446c289c9a57d',
    )
    expect(readRow).toBeTruthy()
    const d = extractToolDetail(readRow!.raw!, 'read')
    expect(d.kind).toBe('read')
    expect((d as { content?: string }).content).toContain('deploy-capri')
  })
})

describe('分页边界拆分：rich update 与新页工具行各在不同抓取', () => {
  function toEvents(envsSlice: unknown[]): AcpEvent[] {
    const evs: AcpEvent[] = []
    for (const env of envsSlice) {
      const u = ((env as { params?: { update?: unknown } }).params?.update ?? {}) as Record<string, unknown>
      if (u.sessionUpdate === 'tool_call') {
        evs.push({ type: 'tool_call', toolCall: u as never })
      } else if (u.sessionUpdate === 'tool_call_update') {
        evs.push({ type: 'tool_call_update', toolCallUpdate: u as never })
      }
    }
    return evs
  }

  it('先回放含 rich update 的新页（无 tool_call），再回放旧页 tool_call → 并入既有行，不产生无内容重复行', () => {
    const call = 'call_9385c205fa3446c289c9a57d'
    const trio = (envs as unknown[]).filter((env) => {
      const u = ((env as { params?: { update?: unknown } }).params?.update ?? {}) as Record<string, unknown>
      return u.toolCallId === call
    })
    expect(trio.length).toBe(3)
    const rich = trio.find((env) => {
      const u = ((env as { params?: { update?: unknown } }).params?.update ?? {}) as Record<string, unknown>
      return u.sessionUpdate === 'tool_call_update' && u.rawOutput != null
    })!
    const old = trio.filter((env) => env !== rich)

    const get = () => useChatStore.getState()
    // 新页（loadHistory）先回放：只含 rich update → 行 A（有内容）
    for (const ev of toEvents([rich])) get().handleEvent(ev)
    const rowsA = get().entries.filter((e) => e.kind === 'tool' && e.toolCallId === call)
    expect(rowsA.length).toBe(1)
    // 旧页（loadMoreHistory）后回放：tool_call + 元数据 update → 并入行 A
    for (const ev of toEvents(old)) get().handleEvent(ev)
    const rows = get().entries.filter((e) => e.kind === 'tool' && e.toolCallId === call)
    expect(rows.length).toBe(1)
    const d = extractToolDetail((rows[0] as { raw: import('../../api/types').ToolCall }).raw!, 'read')
    expect((d as { content?: string }).content).toContain('deploy-capri')
  })
})