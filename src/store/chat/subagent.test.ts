import { describe, expect, it, vi } from 'vitest'
import {
  SUBAGENT_VIEW_PAGE_SIZE,
  sealSubagentStreaming,
  subagentFinishStatus,
  subagentViewPush,
} from './subagent'
import type { ScrollEntry } from '../../api/types'
import type { ChatState, SetState } from './types'

describe('subagent 聚合入口（./subagent）', () => {
  it('常量 + 各函数经聚合可用', () => {
    expect(SUBAGENT_VIEW_PAGE_SIZE).toBe(100)
    expect(subagentFinishStatus({ status: 'cancelled' })).toBe('cancelled')

    const items = [{ id: 'a', kind: 'user', text: 'x' }] as ScrollEntry[]
    expect(subagentViewPush(items, { id: 'b', kind: 'user', text: 'y' } as ScrollEntry)).toHaveLength(2)

    const sealed = sealSubagentStreaming([
      { id: 'a1', kind: 'assistant', text: 'x', streaming: true },
    ] as ScrollEntry[])
    expect(sealed[0]).toMatchObject({ streaming: false })

    // applySubagentFinish 端到端（经 ./subagent 入口）
    const state = { entries: [{ id: 'e1', kind: 'subagent', status: 'started', running: true }] } as Record<string, unknown>
    const ctxSet = vi.fn((partial: unknown) => {
      const patch =
        typeof partial === 'function'
          ? (partial as (s: ChatState) => Partial<ChatState>)(state as unknown as ChatState)
          : (partial as Partial<ChatState>)
      Object.assign(state, patch)
    })
    applySubagentFinish(
      (() => state) as unknown as () => ChatState,
      ctxSet as unknown as SetState,
      'e1',
      'completed',
      3000,
    )
    expect((state.entries as Array<Record<string, unknown>>)[0]).toMatchObject({
      status: 'completed',
      running: false,
      durationMs: 3000,
    })
  })
})

// 延迟 import 避免循环引用（聚合文件无循环，仅为让上方入口测试生效）
import { applySubagentFinish } from './subagentEvent'