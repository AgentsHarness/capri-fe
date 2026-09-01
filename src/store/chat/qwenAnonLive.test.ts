import { beforeEach, describe, expect, it } from 'vitest'
import type { AcpEvent, ScrollEntry } from '../../api/types'
import { useChatStore } from '../../store/chat'
import { replayUpdates, applyEntryMsgSeq, sortEntriesByMsgSeq } from '../../store/chat/history'
import { settleTurnEntries } from '../../store/chat/turnLifecycle'
import { extractToolDetail } from '../../scrollback/toolDetail'
import envs from './qwenAnonSliceFixture.json'

/**
 * live（SSE 实时流）路径的 qwen 空 toolCallId 回归 —— 与
 * qwenAnonReadReplay.test.ts（历史回放路径）成对：两条入口共用
 * handleToolEvent / resolveAnonToolUpdate，坏一起坏、好一起好，所以两侧都
 * 要有锁。
 *
 * 事件形状按宿主 bridge 的 live 映射还原（acp-host
 * internal/acp/bridge.go dispatchSessionUpdateKind）：session/update 的
 * update 对象原样塞进 typed 事件广播（{type:"tool_call", toolCall:<update>}
 * / {type:"tool_call_update", toolCallUpdate:<update>}），与 JSONL 信封里的
 * update 字段完全一致，差别只有 live 带 sessionId、无 msgSeq。
 */
function toLiveEvents(env: {
  params?: { sessionId?: string; update?: Record<string, unknown> }
}): AcpEvent[] {
  const u = env.params?.update
  const sessionId = env.params?.sessionId
  if (!u) return []
  const text = (u.content as { text?: string } | undefined)?.text
  switch (u.sessionUpdate) {
    case 'tool_call':
      return [{ type: 'tool_call', toolCall: u, sessionId } as AcpEvent]
    case 'tool_call_update':
      return [{ type: 'tool_call_update', toolCallUpdate: u, sessionId } as AcpEvent]
    case 'agent_message_chunk':
      return text ? [{ type: 'chunk', text, sessionId } as AcpEvent] : []
    case 'agent_thought_chunk':
      return text ? [{ type: 'thought', text, sessionId } as AcpEvent] : []
    case 'user_message_chunk':
      return text ? [{ type: 'user_chunk', text, sessionId } as AcpEvent] : []
    case 'task_backgrounded':
    case 'task_completed':
    case 'turn_completed':
      return [{ type: u.sessionUpdate, update: u, sessionId } as AcpEvent]
    default:
      return [{
        type: 'session_notification',
        method: 'session/update',
        params: env.params,
      } as AcpEvent]
  }
}

/** 工具行的可比视图（live 与回放逐行对齐用；不含条目 id/时间戳等入口差异）。 */
function toolRows(entries: ScrollEntry[]) {
  return entries.filter((e) => e.kind === 'tool').map((e) => {
    const t = e as Extract<ScrollEntry, { kind: 'tool' }>
    const d = extractToolDetail(t.raw!, t.kindName)
    const content = (d as { content?: string }).content
    return {
      kindName: t.kindName,
      status: t.status,
      verb: t.verb,
      title: t.title,
      hasRawOutput: t.raw?.rawOutput != null,
      contentLines: content ? content.split('\n').length : 0,
    }
  })
}

function feedLive() {
  for (const env of envs as unknown[]) {
    for (const ev of toLiveEvents(env as never)) {
      useChatStore.getState().handleEvent(ev)
    }
  }
}

beforeEach(() => {
  useChatStore.setState({
    entries: [],
    toolIndex: {},
    selectedId: null,
    // live 流缓冲指向的条目随 entries 一起清掉，避免用例间串台。
    liveStream: null,
    openAssistantId: undefined,
    openThoughtId: undefined,
    currentStreamStartMs: undefined,
    sessionId: '01a058f4-1701-7e23-b11c-2b4c705610ae',
    conn: 'ready',
    topTasks: [],
  })
})

describe('qwen 空 toolCallId：live 实时流回放同一会话', () => {
  it('live 逐条派发后每条 read 行都有内容、标题保留路径', () => {
    feedLive()
    const reads = toolRows(useChatStore.getState().entries).filter(
      (r) => r.kindName === 'read',
    )
    expect(reads.length).toBeGreaterThan(0)
    // 内容缺失（raw 只有标题没有 rawOutput）—— 31fb477 修的症状。
    expect(reads.filter((r) => r.contentLines === 0)).toEqual([])
    // 终态未收口 —— 匿名 update 没被认领时行会一直 "Running"。
    expect(reads.filter((r) => r.status !== 'completed')).toEqual([])
  })

  it('live 与历史回放产出逐行一致的工具行', () => {
    const get = () => useChatStore.getState()
    const replay = replayUpdates(get, envs as unknown[])
    const replayRows = toolRows(
      sortEntriesByMsgSeq(applyEntryMsgSeq(settleTurnEntries(get().entries), replay.entryMsgSeq)),
    )

    useChatStore.setState({ entries: [], toolIndex: {} })
    feedLive()
    const liveRows = toolRows(get().entries)

    expect(liveRows.length).toBeGreaterThan(0)
    expect(liveRows).toEqual(replayRows)
  })
})
