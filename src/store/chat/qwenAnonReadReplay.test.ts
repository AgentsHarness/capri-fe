import { beforeEach, describe, expect, it } from 'vitest'
import { useChatStore } from '../../store/chat'
import { replayUpdates, applyEntryMsgSeq, sortEntriesByMsgSeq } from '../../store/chat/history'
import { settleTurnEntries } from '../../store/chat/turnLifecycle'
import { extractToolDetail } from '../../scrollback/toolDetail'
import envs from './qwenAnonSliceFixture.json'

beforeEach(() => {
  useChatStore.setState({
    entries: [],
    toolIndex: {},
    selectedId: null,
    sessionId: '01a058f4-1701-7e23-b11c-2b4c705610ae',
    conn: 'ready',
    topTasks: [],
  })
})

describe('qwen 空 toolCallId 会话回放（01a058f4）', () => {
  it('回放后每条 read 行都有内容', () => {
    const get = () => useChatStore.getState()
    const replay = replayUpdates(get, envs as unknown[])
    const entries = sortEntriesByMsgSeq(
      applyEntryMsgSeq(settleTurnEntries(get().entries), replay.entryMsgSeq),
    )
    useChatStore.setState({ entries })
    const reads = entries.filter((e): e is Extract<import('../../api/types').ScrollEntry, { kind: 'tool' }> => {
      if (e.kind !== 'tool') return false
      const d = extractToolDetail(e.raw!, e.kindName)
      return d.kind === 'read'
    })
    expect(reads.length).toBeGreaterThan(0)
    const noContent = reads.filter((r) => {
      const d = extractToolDetail(r.raw!, r.kindName)
      return (d as { content?: string }).content == null && !(d as { error?: string }).error && (d as { media?: string }).media == null
    })
    // eslint-disable-next-line no-console
    console.log('read rows:', reads.length, '| no-content rows:', noContent.length)
    for (const r of reads) {
      const d = extractToolDetail(r.raw!, r.kindName)
      // eslint-disable-next-line no-console
      console.log(
        '  title:', r.title,
        '| status:', r.status,
        '| raw keys:', Object.keys(r.raw ?? {}).join(','),
        '| has rawOutput:', r.raw?.rawOutput != null,
        '| content:', (d as { content?: string }).content != null,
        '| error:', (d as { error?: string }).error,
      )
    }
    expect(noContent.length).toBe(0)
    // 行头路径必须保留：raw 合并不能丢掉 rawInput / title
    // （readPathOf 靠 raw.rawInput 显示文件名）。
    const lostTitle = reads.filter((r) => {
      const ri = (r.raw?.rawInput ?? {}) as Record<string, unknown>
      return !(ri.target_file ?? ri.targetFile ?? ri.path ?? r.title)
    })
    // eslint-disable-next-line no-console
    console.log('lost-title rows:', lostTitle.length)
    expect(lostTitle.length).toBe(0)
  })
})