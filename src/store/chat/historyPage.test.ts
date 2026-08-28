import { describe, expect, it } from 'vitest'
import {
  HISTORY_PAGE_SIZE,
  INITIAL_TURN_LIMIT,
  MAX_PAGE_DOUBLE_STEPS,
  adaptivePageSize,
  countUserMessages,
  findMsgSeqGap,
  historyHasMorePage,
  mergeEntriesByMsgSeq,
  previousTurnWindow,
  remapTurnIdx,
  sortEntriesByMsgSeq,
} from './historyPage'
import type { ScrollEntry } from '../../api/types'

describe('adaptivePageSize', () => {
  it('起步 100，每次续翻翻倍，封顶 1600', () => {
    expect(adaptivePageSize(0)).toBe(100)
    expect(adaptivePageSize(1)).toBe(200)
    expect(adaptivePageSize(2)).toBe(400)
    expect(adaptivePageSize(3)).toBe(800)
    expect(adaptivePageSize(4)).toBe(1600)
    expect(adaptivePageSize(99)).toBe(1600)
    expect(HISTORY_PAGE_SIZE).toBe(100)
    expect(MAX_PAGE_DOUBLE_STEPS).toBe(4)
  })
})

describe('historyHasMorePage', () => {
  it('totalCount 优先；无 total 回退整页拉满', () => {
    expect(historyHasMorePage(200, 100, 100)).toBe(true)
    expect(historyHasMorePage(100, 100, 100)).toBe(false)
    expect(historyHasMorePage(undefined, 100, 100)).toBe(true)
    expect(historyHasMorePage(undefined, 100, 50)).toBe(false)
    expect(historyHasMorePage(undefined, 0, 0)).toBe(false)
    // 页大小自适应翻倍后按本次页大小比较
    expect(historyHasMorePage(undefined, 300, 300, 400)).toBe(false)
  })
})

describe('previousTurnWindow', () => {
  it('正常窗口 = [start(k-1), min(k, loadedStart))', () => {
    // k=1 → 第 0 轮 [0, 50)
    expect(previousTurnWindow([0, 50, 120], 1, 100)).toEqual({ offset: 0, limit: 50 })
    // k=2 → 第 1 轮 [50, min(120,100))
    expect(previousTurnWindow([0, 50, 120], 2, 100)).toEqual({ offset: 50, limit: 50 })
  })

  it('钳到 loadedStart（半轮兜底时只取未加载前缀）', () => {
    expect(previousTurnWindow([0, 50, 200], 1, 60)).toEqual({ offset: 0, limit: 50 })
    // loadedStart 落在回合中间 → [0, 40)
    expect(previousTurnWindow([0, 50, 200], 1, 40)).toEqual({ offset: 0, limit: 40 })
  })

  it('失效路径 → null', () => {
    expect(previousTurnWindow(undefined, 1, 100)).toBeNull()
    expect(previousTurnWindow([0, 50], 0, 100)).toBeNull()
    expect(previousTurnWindow([0, 50], 2, 100)).toBeNull()
    expect(previousTurnWindow([0, 50], 1, 0)).toBeNull()
    // 超过单请求上限
    expect(previousTurnWindow([0, 10_000], 1, 100_000)).toBeNull()
    expect(INITIAL_TURN_LIMIT).toBe(2000)
  })
})

describe('remapTurnIdx', () => {
  it('按旧的边界行号重新定位', () => {
    expect(remapTurnIdx([0, 50, 100], 1, [0, 50, 100, 150])).toBe(1)
  })

  it('找不到边界 → 钳到新数组范围', () => {
    expect(remapTurnIdx([0, 50], 1, [0, 200])).toBe(1)
    expect(remapTurnIdx([0, 50], 1, [])).toBe(1)
    expect(remapTurnIdx(undefined, 2, undefined)).toBe(2)
  })
})

describe('countUserMessages', () => {
  it('数 user 条目', () => {
    expect(
      countUserMessages([
        { id: '1', kind: 'user', text: 'a' },
        { id: '2', kind: 'assistant', text: 'b' },
        { id: '3', kind: 'user', text: 'c' },
      ]),
    ).toBe(2)
    expect(countUserMessages([])).toBe(0)
  })
})
describe('sortEntriesByMsgSeq', () => {
  const e = (id: string, msgSeq?: number): ScrollEntry =>
    ({ id, kind: 'user', text: id, ...(msgSeq != null ? { msgSeq } : {}) }) as ScrollEntry

  it('全带 msgSeq 时按其稳定排序（等值保持原相对序）', () => {
    const input = [e('c', 2), e('a', 0), e('b', 0), e('d', 1)]
    expect(sortEntriesByMsgSeq(input).map((x) => x.id)).toEqual(['a', 'b', 'd', 'c'])
  })

  it('任一条目缺 msgSeq → 原数组返回（不排序）', () => {
    const input = [e('b', 2), e('a')]
    expect(sortEntriesByMsgSeq(input)).toBe(input)
    expect(sortEntriesByMsgSeq([])).toEqual([])
  })
})

describe('mergeEntriesByMsgSeq', () => {
  const e = (id: string, msgSeq?: number): ScrollEntry =>
    ({ id, kind: 'user', text: id, ...(msgSeq != null ? { msgSeq } : {}) }) as ScrollEntry

  it('两侧按 msgSeq 稳定归并；等值取前插页（older）', () => {
    const older = [e('o0', 0), e('o2', 2), e('o4', 4)]
    const newer = [e('n1', 1), e('n2', 2), e('n5', 5)]
    expect(mergeEntriesByMsgSeq(older, newer)!.map((x) => x.id)).toEqual([
      'o0',
      'n1',
      'o2',
      'n2',
      'o4',
      'n5',
    ])
  })

  it('任一侧有条目缺 msgSeq → null（调用方回退现有拼接）', () => {
    expect(mergeEntriesByMsgSeq([e('o', 0)], [e('n')])).toBeNull()
    expect(mergeEntriesByMsgSeq([e('o')], [e('n', 0)])).toBeNull()
    expect(mergeEntriesByMsgSeq([], [])).toEqual([])
  })
})

describe('findMsgSeqGap', () => {
  const env = (msgSeq?: number) => ({ ...(msgSeq != null ? { msgSeq } : {}) })

  it('连续页 / 纯旧页（全不带 msgSeq）→ null', () => {
    expect(findMsgSeqGap([env(3), env(4), env(5)])).toBeNull()
    expect(findMsgSeqGap([env(), env(), env()])).toBeNull()
    expect(findMsgSeqGap([])).toBeNull()
  })

  it('断裂 / 重复 / 中途缺失 → 返回断裂描述', () => {
    expect(findMsgSeqGap([env(0), env(1), env(3)]))!.toContain('期望 2')
    expect(findMsgSeqGap([env(0), env(1), env(1)]))!.toContain('期望 2')
    expect(findMsgSeqGap([env(0), env(), env(2)]))!.toContain('缺失 msgSeq')
  })
})
