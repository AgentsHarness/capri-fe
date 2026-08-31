import { describe, expect, it } from 'vitest'
import type { BtwHistoryRecord, ScrollEntry } from '../../api/types'
import { btwReplayEntry, spliceBtwEntries } from './btwReplay'

const tool = (msgSeq: number): ScrollEntry =>
  ({ id: `t${msgSeq}`, kind: 'tool', verb: 'Ran', msgSeq }) as ScrollEntry

const rec = (o: Partial<BtwHistoryRecord> = {}): BtwHistoryRecord => ({
  btwSessionId: 'btw-1',
  askedAt: 1500,
  question: '还有几步？',
  answer: '两步',
  success: true,
  afterMsgSeq: 0,
  ...o,
})

describe('btwReplayEntry', () => {
  it('映射为收口条目：stable id / 折叠 / msgSeq=锚点+0.5', () => {
    const e = btwReplayEntry(rec())
    expect(e.kind).toBe('btw')
    expect(e.id).toBe('btw_btw-1')
    expect(e.msgSeq).toBe(0.5)
    expect(
      (e as Extract<ScrollEntry, { kind: 'btw' }>).streaming,
    ).toBe(false)
    expect(
      (e as Extract<ScrollEntry, { kind: 'btw' }>).open,
    ).toBe(false)
  })

  it('失败记录 → error 态，无 answer；无 error 的失败不造空错误', () => {
    const e = btwReplayEntry(
      rec({ success: false, answer: '', error: '超时' }),
    ) as Extract<ScrollEntry, { kind: 'btw' }>
    expect(e.error).toBe('超时')
    expect(e.answer).toBeUndefined()
    const silent = btwReplayEntry(
      rec({ success: true, answer: '' }),
    ) as Extract<ScrollEntry, { kind: 'btw' }>
    expect(silent.error).toBeUndefined()
    expect(silent.answer).toBeUndefined()
  })
})

describe('spliceBtwEntries', () => {
  it('按锚点插入：锚点条目之后、更大 msgSeq 之前', () => {
    const entries = [tool(0), tool(1), tool(2)]
    const out = spliceBtwEntries(entries, [rec({ afterMsgSeq: 1, btwSessionId: 'x' })])
    expect(out.map((e) => e.id)).toEqual(['t0', 't1', 'btw_x', 't2'])
  })

  it('锚点 -1 置顶；无记录时原数组原样返回', () => {
    const entries = [tool(0), tool(1)]
    expect(spliceBtwEntries(entries, [rec({ afterMsgSeq: -1 })]).map((e) => e.id)).toEqual([
      'btw_btw-1',
      't0',
      't1',
    ])
    expect(spliceBtwEntries(entries, [])).toBe(entries)
  })

  it('按锚点升序稳定排布', () => {
    const entries = [tool(0), tool(1), tool(2), tool(3)]
    const out = spliceBtwEntries(entries, [
      rec({ afterMsgSeq: 2, btwSessionId: 'b' }),
      rec({ afterMsgSeq: 0, btwSessionId: 'a' }),
    ])
    expect(out.map((e) => e.id)).toEqual(['t0', 'btw_a', 't1', 't2', 'btw_b', 't3'])
  })

  it('稳定 id 去重：已并入的记录不重复', () => {
    const entries = [btwReplayEntry(rec({ afterMsgSeq: 0 })), tool(1)]
    const out = spliceBtwEntries(entries, [rec({ afterMsgSeq: 0 })])
    expect(out.map((e) => e.id)).toEqual(['btw_btw-1', 't1'])
  })

  it('内容去重：live 已回答的同问同答条目避免时间线双重渲染', () => {
    const live = {
      id: 'e_live',
      kind: 'btw',
      question: '还有几步？',
      answer: '两步',
      streaming: false,
    } as ScrollEntry
    const out = spliceBtwEntries([live], [rec({ afterMsgSeq: 0 })])
    expect(out.map((e) => e.id)).toEqual(['e_live'])
  })

  it('不同答案的同名问题不去重（两次真实提问）', () => {
    const live = {
      id: 'e_live',
      kind: 'btw',
      question: '还有几步？',
      answer: '两步',
      streaming: false,
    } as ScrollEntry
    const out = spliceBtwEntries([live], [rec({ afterMsgSeq: 0, answer: '三步了' })])
    expect(out.map((e) => e.id)).toEqual(['btw_btw-1', 'e_live'])
  })

  it('等值 msgSeq 时记录排在前（锚点+0.5 恒不撞整数）', () => {
    const entries = [tool(1)]
    const out = spliceBtwEntries(entries, [rec({ afterMsgSeq: 1 })])
    expect(out.map((e) => e.id)).toEqual(['t1', 'btw_btw-1'])
  })
})