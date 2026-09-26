import { describe, expect, it } from 'vitest'
import type { ScrollEntry } from '../../api/types'
import { Accents } from '../../theme/accents'
import { HOOK_REVEAL_DELAY_MS, currentActivity } from './activity'

const hook = (over: Partial<NonNullable<Parameters<typeof currentActivity>[1]>> = {}) => ({
  eventName: 'pre_tool_use',
  count: 1,
  startedAt: 1_000,
  ...over,
})

describe('currentActivity — hook batch 相位（TUI HOOK_REVEAL_DELAY）', () => {
  it('批次未活过 300ms 不亮相位 —— 快 hook 一闪而过', () => {
    // 刚武装：状态行里看不到任何 hook 文案。
    expect(currentActivity([], hook(), 1_000)).toBeNull()
    // 差 1ms 到揭示阈值仍然不亮。
    expect(currentActivity([], hook(), 1_000 + HOOK_REVEAL_DELAY_MS - 1)).toBeNull()
  })

  it('越过阈值后按 TUI 文案揭示，且计时锚在批次开始而非揭示时刻', () => {
    // 单 hook：单数 `hook`；多 hook：复数 `hooks` 且带上数量。
    expect(currentActivity([], hook(), 1_000 + HOOK_REVEAL_DELAY_MS)).toEqual({
      label: 'Running pre_tool_use hook…',
      color: Accents.gray,
      // 锚点是批次开始的 1000，不是 1300 —— 慢 hook 显示完整等待。
      startedAt: 1_000,
    })
    expect(
      currentActivity([], hook({ eventName: 'stop', count: 3 }), 5_000)?.label,
    ).toBe('Running 3 stop hooks…')
  })

  it('没有 runningHook 时不产生 hook 相位', () => {
    expect(currentActivity([], null, 10_000)).toBeNull()
    expect(currentActivity([], undefined, 10_000)).toBeNull()
  })

  it('有批次时 hook 相位优先于工具 / 思考活动', () => {
    const entries = [
      { id: 'th', kind: 'thought', text: 'x', streaming: true, startedAt: 5 } as ScrollEntry,
      {
        id: 't',
        kind: 'tool',
        title: 'list_dir',
        verb: 'List',
        kindName: 'list_dir',
        status: 'in_progress',
      } as ScrollEntry,
    ]
    expect(currentActivity(entries, hook(), 9_000)?.label).toBe('Running pre_tool_use hook…')
    // 批次一消失就回落到工具活动。
    const fallback = currentActivity(entries, null, 9_000)
    expect(fallback?.label).toContain('list_dir')
    expect(fallback?.startedAt).toBeUndefined()
  })

  it('未揭示的批次也让位给真实活动，而不是把状态行留空', () => {
    const entries = [
      { id: 'th', kind: 'thought', text: 'x', streaming: true, startedAt: 5 } as ScrollEntry,
    ]
    expect(currentActivity(entries, hook(), 1_050)?.label).toBe('Thinking…')
  })
})
