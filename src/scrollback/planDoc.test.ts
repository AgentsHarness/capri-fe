import { describe, expect, it } from 'vitest'
import type { PendingReq, ScrollEntry } from '../api/types'
import { planDocFromEntries, planDocFromRequests } from './planDoc'

function tool(rawOutput: unknown): ScrollEntry {
  return {
    id: 't',
    kind: 'tool',
    title: 'x',
    verb: 'x',
    status: 'completed',
    kindName: 'other',
    raw: { rawOutput },
  } as unknown as ScrollEntry
}

describe('planDocFromEntries', () => {
  it('ExitPlanMode/PlanReady 的 plan_content（snake_case wire）', () => {
    expect(
      planDocFromEntries([tool({ type: 'ExitPlanMode', PlanReady: { plan_content: '# P' } })]),
    ).toBe('# P')
  })

  it('camelCase 变体与裸 planContent 也认', () => {
    expect(planDocFromEntries([tool({ planContent: '# C' })])).toBe('# C')
    expect(planDocFromEntries([tool({ planReady: { planContent: '# D' } })])).toBe('# D')
  })

  it('取最近一条（新→旧扫描）', () => {
    const entries = [
      tool({ type: 'ExitPlanMode', PlanReady: { plan_content: '# 旧' } }),
      tool({ type: 'ExitPlanMode', PlanReady: { plan_content: '# 新' } }),
    ]
    expect(planDocFromEntries(entries)).toBe('# 新')
  })

  it('空正文/非对象输出 → undefined（不拿空白冒充 plan）', () => {
    expect(
      planDocFromEntries([tool({ PlanReady: { plan_content: '   ' } })]),
    ).toBeUndefined()
    expect(planDocFromEntries([tool('text')])).toBeUndefined()
    expect(
      planDocFromEntries([
        { id: 'a', kind: 'assistant', text: '# 不算' } as ScrollEntry,
      ]),
    ).toBeUndefined()
  })
})

describe('planDocFromRequests', () => {
  it('只认 exit_plan_mode 请求的 planContent', () => {
    const reqs = [
      { requestId: '1', method: 'x.ai/ask_user_question', params: { planContent: '不算' } },
      { requestId: '2', method: 'x.ai/exit_plan_mode', params: { planContent: '# 计划' } },
    ] as unknown as PendingReq[]
    expect(planDocFromRequests(reqs)).toBe('# 计划')
  })

  it('无请求或空白 → undefined', () => {
    expect(planDocFromRequests([])).toBeUndefined()
    expect(
      planDocFromRequests([
        { requestId: '1', method: 'x.ai/exit_plan_mode', params: {} },
      ] as unknown as PendingReq[]),
    ).toBeUndefined()
  })
})
