// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ScrollEntry } from '../api/types'
import { groupPreviewPatch } from './groupPreview'
import { isDensePackable } from './verbGroup'

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

describe('groupPreviewPatch', () => {
  it('折叠工具 → 行内截断预览；重复调用返回同一对象', () => {
    const e = tool('t1', { displayMode: 'collapsed' })
    const patch = groupPreviewPatch(e, true)
    expect(patch).toEqual({ displayMode: 'truncated', expanded: true })
    expect(groupPreviewPatch(e, true)).toBe(patch)
  })

  it('用户钉过 / 已经展开的工具不覆盖', () => {
    expect(
      groupPreviewPatch(tool('t1', { displayMode: 'collapsed', foldPinned: true }), true),
    ).toBe(undefined)
    expect(
      groupPreviewPatch(tool('t2', { displayMode: 'expanded', expanded: true }), true),
    ).toBe(undefined)
  })

  it('非工具 / preview=false 一律不 patch', () => {
    const thought: ScrollEntry = {
      id: 'th',
      kind: 'thought',
      text: 'hmm',
      displayMode: 'collapsed',
    }
    expect(groupPreviewPatch(thought, true)).toBe(undefined)
    expect(groupPreviewPatch(tool('t1'), false)).toBe(undefined)
  })

  it('补丁后的工具行按展开态行距排版（非 dense）', () => {
    const t = tool('t1')
    const patchedTool = { ...t, ...groupPreviewPatch(t, true)! } as ScrollEntry
    expect(isDensePackable(t)).toBe(true)
    expect(isDensePackable(patchedTool)).toBe(false)
  })
})
