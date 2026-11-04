import { describe, expect, it } from 'vitest'
import type { ScrollEntry } from '../api/types'
import { ENTRY_ENTER_MAX_BATCH, enteringEntryIds } from './entryEnter'

const a = (id: string): ScrollEntry => ({ id, kind: 'assistant', text: '' })

const base = {
  enabled: true,
  initialized: true,
  historyLoadedAt: 100,
  lastHistoryLoadedAt: 100,
  historyLoading: false,
  historyLoadingMore: false,
}

describe('enteringEntryIds', () => {
  it('首帧只播种：已有条目不算新块', () => {
    expect(
      enteringEntryIds([a('a1'), a('a2')], new Set(), { ...base, initialized: false }),
    ).toEqual([])
  })

  it('实时 append 返回新增条目；已见条目不再返回', () => {
    expect(enteringEntryIds([a('a1'), a('a2')], new Set(['a1']), base)).toEqual(['a2'])
    expect(enteringEntryIds([a('a1'), a('a2')], new Set(['a1', 'a2']), base)).toEqual([])
  })

  it('历史页 prepend（新条目都落在首个旧条目之前）不播', () => {
    expect(
      enteringEntryIds([a('p1'), a('p2'), a('a1')], new Set(['a1']), base),
    ).toEqual([])
  })

  it('历史批次变化 / 加载中 / 开关关闭 → 不播', () => {
    const entries = [a('a1'), a('a2')]
    expect(
      enteringEntryIds(entries, new Set(['a1']), {
        ...base,
        historyLoadedAt: 101,
      }),
    ).toEqual([])
    expect(
      enteringEntryIds(entries, new Set(['a1']), { ...base, historyLoading: true }),
    ).toEqual([])
    expect(
      enteringEntryIds(entries, new Set(['a1']), { ...base, historyLoadingMore: true }),
    ).toEqual([])
    expect(enteringEntryIds(entries, new Set(['a1']), { ...base, enabled: false })).toEqual([])
  })

  it('空时间线出现首条（新会话发送）→ 播', () => {
    expect(enteringEntryIds([a('u1')], new Set(), base)).toEqual(['u1'])
  })

  it('一次新增超过批量上限 → 视为回放，不播', () => {
    const entries = Array.from(
      { length: ENTRY_ENTER_MAX_BATCH + 1 },
      (_, i) => a(`e${i}`),
    )
    expect(enteringEntryIds(entries, new Set(), base)).toEqual([])
  })
})
