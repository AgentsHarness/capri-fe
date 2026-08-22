import { describe, expect, it, vi } from 'vitest'
import {
  MAX_FOLLOW_UP_LABEL,
  MAX_FOLLOW_UPS,
  applyFollowUps,
  applyMcpInitProgress,
  sanitizeFollowUpLabel,
} from './followUps'

describe('sanitizeFollowUpLabel', () => {
  it('剥控制字符 / bidi 格式字符，保留表情符号，trim 并限长', () => {
    expect(sanitizeFollowUpLabel('  hello \u200bworld  ')).toBe('hello world')
    expect(sanitizeFollowUpLabel('a\u001bb\u007fc\u202ed')).toBe('abcd')
    expect(sanitizeFollowUpLabel('emoji 👍 ok')).toBe('emoji 👍 ok')
    expect(sanitizeFollowUpLabel('x'.repeat(300)).length).toBe(MAX_FOLLOW_UP_LABEL)
  })
})

describe('applyMcpInitProgress', () => {
  it('total/connected 解析写入 mcpInit', () => {
    const set = vi.fn()
    applyMcpInitProgress(set as never, { total: 2, connectedCount: 1 })
    const partial = set.mock.calls[0][0] as { mcpInit: { total: number; connected: number; startedAt: number } }
    expect(partial.mcpInit.total).toBe(2)
    expect(partial.mcpInit.connected).toBe(1)
    expect(partial.mcpInit.startedAt).toEqual(expect.any(Number))
  })

  it('缺失字段 / 非法值 → 不写', () => {
    const set = vi.fn()
    applyMcpInitProgress(set as never, { total: 2 })
    expect(set).not.toHaveBeenCalled()
    applyMcpInitProgress(set as never, { total: -1, connected: 1 })
    expect(set).not.toHaveBeenCalled()
    applyMcpInitProgress(set as never, null)
    expect(set).not.toHaveBeenCalled()
  })
})

describe('applyFollowUps', () => {
  const empty = { followUpsResponseId: undefined, followUps: undefined } as {
    followUpsResponseId: string | undefined
    followUps?: Array<{ label: string }> | undefined
  }

  it('新 response 采纳建议（限 6 条 + 清洗）', () => {
    const get = vi.fn(() => empty as never)
    const set = vi.fn()
    applyFollowUps(
      get as never,
      set as never,
      { response_id: 'r1', suggestions: [{ label: ' 继续 ' }, { label: '\u200b\u200bbad' }, { label: 'ok' }] },
    )
    const partial = set.mock.calls[0][0] as { followUpsResponseId: string; followUps: Array<{ label: string }> }
    expect(partial.followUpsResponseId).toBe('r1')
    // \u200b 被清洗但文本保留
    expect(partial.followUps).toEqual([{ label: '继续' }, { label: 'bad' }, { label: 'ok' }])
  })

  it('同 response 幂等；空建议撤回 chips', () => {
    const get = vi.fn(() => ({ followUpsResponseId: 'r1', followUps: [{ label: 'x' }] }) as never)
    const set = vi.fn()
    applyFollowUps(get as never, set as never, { response_id: 'r1', suggestions: [{ label: 'y' }] })
    expect(set).not.toHaveBeenCalled()

    get.mockReturnValue(empty as never)
    applyFollowUps(get as never, set as never, { responseId: 'r2', suggestions: [] })
    const partial = set.mock.calls[0][0] as { followUps: undefined; followUpsResponseId: string }
    expect(partial.followUpsResponseId).toBe('r2')
    expect(partial.followUps).toBeUndefined()
  })

  it('字符串 params 容错；损坏 JSON / 非对象 / 缺 id → 忽略', () => {
    const get = vi.fn(() => empty)
    const set = vi.fn()
    applyFollowUps(get as never, set as never, JSON.stringify({ response_id: 'r3', suggestions: [{ label: 'a' }] }) as never)
    expect(set).toHaveBeenCalledTimes(1)

    applyFollowUps(get as never, set as never, '{bad json' as never)
    applyFollowUps(get as never, set as never, undefined)
    applyFollowUps(get as never, set as never, { suggestions: [{ label: 'a' }] })
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('全部清洗掉 → 撤回 chips；超过 MAX_FOLLOW_UPS 截断', () => {
    const get = vi.fn(() => empty)
    const set = vi.fn()
    const many = Array.from({ length: 10 }, (_, i) => ({ label: `s${i}` }))
    applyFollowUps(get as never, set as never, { response_id: 'r4', suggestions: many })
    const partial = set.mock.calls[0][0] as { followUps: Array<{ label: string }> }
    expect(partial.followUps).toHaveLength(MAX_FOLLOW_UPS)

    const set2 = vi.fn()
    applyFollowUps(get as never, set2 as never, { response_id: 'r5', suggestions: [{ label: '\u200b' }] })
    const partial2 = set2.mock.calls[0][0] as { followUps: undefined }
    expect(partial2.followUps).toBeUndefined()
  })
})