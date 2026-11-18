import { describe, expect, it } from 'vitest'
import type { ScrollEntry } from '../api/types'
import type { ToolCallDensity } from '../api/transport'
import {
  GROUP_HOLD_DEFAULT_MS,
  clampGroupHoldMs,
  previewToolIds,
} from './groupHold'

const T0 = 1_000_000

function tool(
  id: string,
  over: Partial<Extract<ScrollEntry, { kind: 'tool' }>> = {},
): ScrollEntry {
  return {
    id,
    kind: 'tool',
    title: 'Read a.py',
    kindName: 'read',
    status: 'completed',
    expanded: false,
    ...over,
  } as ScrollEntry
}

function ids(
  entries: ScrollEntry[],
  density: ToolCallDensity = 'compact-all-grouped',
  now = T0 + 100,
  suppressed?: Map<string, number>,
) {
  return previewToolIds(
    entries,
    now,
    GROUP_HOLD_DEFAULT_MS,
    density,
    suppressed,
  )
}

describe('previewToolIds', () => {
  it('运行中的默认折叠工具预览；结束后按 finishedAt 起算停留窗口', () => {
    const running = tool('run', { kindName: 'execute', status: 'in_progress' })
    expect(ids([running]).ids.has('run')).toBe(true)
    expect(ids([running]).nextAt).toBeNull()

    const recent = tool('recent', { finishedAt: T0 - 100 })
    expect(ids([recent]).ids.has('recent')).toBe(true)
    expect(ids([recent]).nextAt).toBe(T0 - 100 + GROUP_HOLD_DEFAULT_MS)

    expect(
      ids([tool('old', { finishedAt: T0 - GROUP_HOLD_DEFAULT_MS - 1 })]).ids.size,
    ).toBe(0)
    expect(ids([tool('no-ts')]).ids.size).toBe(0)
  })

  it('detailed：探查类默认折叠仍预览；编辑/命令默认展开不预览', () => {
    const entries = [
      tool('read', { finishedAt: T0 - 100 }),
      tool('edit', { kindName: 'edit', finishedAt: T0 - 100 }),
      tool('cmd', { kindName: 'execute', finishedAt: T0 - 100 }),
    ]
    expect([...ids(entries, 'detailed').ids]).toEqual(['read'])
  })

  it('diff focus：命令与探查类预览，默认展开的编辑不预览', () => {
    const entries = [
      tool('read', { finishedAt: T0 - 100 }),
      tool('edit', { kindName: 'edit', finishedAt: T0 - 100 }),
      tool('cmd', { kindName: 'execute', finishedAt: T0 - 100 }),
    ]
    expect([...ids(entries, 'compact-shells').ids].sort()).toEqual([
      'cmd',
      'read',
    ])
  })

  it('balanced / grouped：编辑与命令不入组时同样预览', () => {
    for (const density of ['compact-ungrouped', 'compact-grouped'] as const) {
      const entries = [
        tool('edit', { kindName: 'edit', finishedAt: T0 - 100 }),
        tool('cmd', { kindName: 'execute', finishedAt: T0 - 100 }),
      ]
      expect([...ids(entries, density).ids].sort()).toEqual(['cmd', 'edit'])
    }
  })

  it('手动折叠 / 手动展开 / 抑制表命中 → 不预览', () => {
    const entries = [
      tool('pinned', { finishedAt: T0 - 100, foldPinned: true }),
      tool('open', {
        finishedAt: T0 - 100,
        displayMode: 'expanded',
        expanded: true,
      }),
      tool('suppressed', { finishedAt: T0 - 100 }),
    ]
    const suppressed = new Map([['suppressed', T0 + 5000]])
    expect(ids(entries, 'compact-all-grouped', T0 + 100, suppressed).ids.size).toBe(
      0,
    )
  })

  it('停留时长可配置；0 表示不预览', () => {
    const entries = [tool('t', { finishedAt: T0 })]
    expect(previewToolIds(entries, T0 + 100, 0, 'compact-all-grouped').ids.size).toBe(0)
    expect(
      previewToolIds(entries, T0 + 100, 2000, 'compact-all-grouped').ids.size,
    ).toBe(1)
  })
})

describe('clampGroupHoldMs', () => {
  it('非法值回落默认，越界夹到范围，小数取整', () => {
    expect(clampGroupHoldMs(undefined)).toBe(GROUP_HOLD_DEFAULT_MS)
    expect(clampGroupHoldMs('not-a-number')).toBe(GROUP_HOLD_DEFAULT_MS)
    expect(clampGroupHoldMs(-1)).toBe(0)
    expect(clampGroupHoldMs(99_999)).toBe(5000)
    expect(clampGroupHoldMs(250.6)).toBe(251)
  })
})
