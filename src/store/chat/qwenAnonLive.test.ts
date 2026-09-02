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

/**
 * 并发匿名调用**乱序**回来（真实形状取自会话 01a06312 首轮 msgSeq 16..21）：
 * bash 与 grep 同时在跑，grep 的完成帧先到且不带 rawInput / command（算不出
 * 内容指纹），bash 的完成帧后到。此前两条开放匿名行 + 无指纹完成帧只能靠
 * FIFO 猜，正文要么进错行要么永久丢失；现在按 `rawOutput.type` 的工具族
 * （GrepSearch / Bash / ReadFile / SearchReplace）归属。
 */
function interleavedEnvs(): unknown[] {
  const T0 = 1_700_000_000_000
  let n = 0
  const env = (update: Record<string, unknown>) => {
    const msgSeq = n++
    return {
      msgSeq,
      timestamp: Math.floor(T0 / 1000) + msgSeq,
      method: 'session/update',
      params: {
        sessionId: '01a058f4-1701-7e23-b11c-2b4c705610ae',
        update: { toolCallId: '', ...update, _meta: { agentTimestampMs: T0 + msgSeq } },
        _meta: { agentTimestampMs: T0 + msgSeq, turnStartMs: T0 },
      },
    }
  }
  return [
    env({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '并发跑' } }),
    env({ sessionUpdate: 'tool_call', rawInput: { command: 'git branch' } }),
    env({
      sessionUpdate: 'tool_call_update',
      kind: 'execute',
      title: 'Execute `git branch`',
      rawInput: { command: 'git branch' },
    }),
    env({ sessionUpdate: 'tool_call', rawInput: { path: 'src' } }),
    env({
      sessionUpdate: 'tool_call_update',
      kind: 'search',
      title: 'grep',
      rawInput: { path: 'src' },
    }),
    env({
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      rawOutput: { type: 'GrepSearch', match_count: 2, stdout: 'GREP OUT' },
    }),
    env({
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      rawOutput: { type: 'Bash', command: 'git branch', output: 'BASH OUT' },
    }),
    env({ sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }),
  ]
}

describe('并发匿名调用乱序完成帧：live 与回放都按工具族归属', () => {
  const rowsByKind = (entries: ScrollEntry[]) =>
    entries
      .filter((e): e is Extract<ScrollEntry, { kind: 'tool' }> => e.kind === 'tool')
      .map((e) => ({
        kindName: e.kindName,
        status: e.status,
        rawOutput: e.raw?.rawOutput as Record<string, unknown> | undefined,
      }))

  it('历史回放：grep 行拿 grep 正文，bash 行拿 bash 正文', () => {
    const get = () => useChatStore.getState()
    const replay = replayUpdates(get, interleavedEnvs())
    const rows = rowsByKind(
      sortEntriesByMsgSeq(applyEntryMsgSeq(settleTurnEntries(get().entries), replay.entryMsgSeq)),
    )
    const byKind = new Map(rows.map((r) => [r.kindName, r]))
    expect(byKind.get('search')?.rawOutput?.stdout).toBe('GREP OUT')
    expect(byKind.get('execute')?.rawOutput?.output).toBe('BASH OUT')
    expect(rows.map((r) => r.status)).toEqual(['completed', 'completed'])
  })

  it('live 实时流：同一串事件产出同样的归属，且与回放逐行一致', () => {
    for (const env of interleavedEnvs()) {
      for (const ev of toLiveEvents(env as never)) useChatStore.getState().handleEvent(ev)
    }
    const rows = rowsByKind(useChatStore.getState().entries)
    const byKind = new Map(rows.map((r) => [r.kindName, r]))
    expect(byKind.get('search')?.rawOutput?.stdout).toBe('GREP OUT')
    expect(byKind.get('execute')?.rawOutput?.output).toBe('BASH OUT')
    expect(rows.map((r) => r.status)).toEqual(['completed', 'completed'])
  })
})
