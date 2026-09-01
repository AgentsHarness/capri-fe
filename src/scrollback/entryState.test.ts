import { describe, expect, it } from 'vitest'
import type { ScrollEntry, ToolCall } from '../api/types'
import { FINISH_FLASH_MS } from '../theme/wave'
import { Glyphs } from '../theme/glyphs'
import {
  entryAtMinFold,
  entryExpanded,
  entryFailed,
  entryFlashActive,
  entryFoldable,
  entryRunning,
  expandableGlyph,
  isHeaderStyleBlock,
  toolHasExpandableBody,
} from './entryState'

describe('entryRunning', () => {
  it('assistant / thought / session_event 看 streaming', () => {
    expect(entryRunning({ id: '1', kind: 'assistant', text: 'x', streaming: true })).toBe(true)
    expect(entryRunning({ id: '1', kind: 'assistant', text: 'x' })).toBe(false)
    expect(entryRunning({ id: '2', kind: 'thought', text: 'x', streaming: true })).toBe(true)
    expect(entryRunning({ id: '3', kind: 'session_event', text: 'x', streaming: true })).toBe(true)
  })

  it('tool 看 pending / in_progress', () => {
    const tool = (status?: string): ScrollEntry => ({
      id: 't',
      kind: 'tool',
      title: 't',
      verb: 'v',
      status,
    })
    expect(entryRunning(tool('pending'))).toBe(true)
    expect(entryRunning(tool('in_progress'))).toBe(true)
    expect(entryRunning(tool('completed'))).toBe(false)
  })

  it('subagent / workflow / bg_task 看 running', () => {
    expect(entryRunning({ id: 's', kind: 'subagent', title: 's', status: 'started', running: true })).toBe(true)
    expect(entryRunning({ id: 's', kind: 'subagent', title: 's', status: 'completed' })).toBe(false)
    expect(entryRunning({ id: 'w', kind: 'workflow', title: 'w', status: 'running', running: true })).toBe(true)
    expect(entryRunning({ id: 'b', kind: 'bg_task', title: 'b', status: 'started', running: true })).toBe(true)
  })

  it('其余 kind 恒 false', () => {
    expect(entryRunning({ id: 'u', kind: 'user', text: 'x' })).toBe(false)
    expect(entryRunning({ id: 'e', kind: 'error', text: 'x' })).toBe(false)
  })
})

describe('entryFailed', () => {
  it('error 恒真；tool 看 failed / error', () => {
    expect(entryFailed({ id: 'e', kind: 'error', text: 'boom' })).toBe(true)
    const tool = (status?: string): ScrollEntry => ({
      id: 't',
      kind: 'tool',
      title: 't',
      verb: 'v',
      status,
    })
    expect(entryFailed(tool('failed'))).toBe(true)
    expect(entryFailed(tool('error'))).toBe(true)
    expect(entryFailed(tool('completed'))).toBe(false)
  })

  it('subagent failed/cancelled、workflow failed、bg_task failed', () => {
    expect(entryFailed({ id: 's', kind: 'subagent', title: 's', status: 'failed' })).toBe(true)
    expect(entryFailed({ id: 's', kind: 'subagent', title: 's', status: 'cancelled' })).toBe(true)
    expect(entryFailed({ id: 'w', kind: 'workflow', title: 'w', status: 'failed' })).toBe(true)
    expect(entryFailed({ id: 'b', kind: 'bg_task', title: 'b', status: 'failed' })).toBe(true)
    expect(entryFailed({ id: 'a', kind: 'assistant', text: 'x' })).toBe(false)
  })
})

describe('entryExpanded / entryFoldable / entryAtMinFold', () => {
  const longText = `${'a'.repeat(70)}\n${'b'.repeat(70)}\n${'c'.repeat(70)}\n${'d'.repeat(70)}`

  it('user：短文本恒展开；可折叠文本默认折叠、expanded 才展开', () => {
    expect(entryExpanded({ id: 'u', kind: 'user', text: 'short' })).toBe(true)
    expect(entryExpanded({ id: 'u', kind: 'user', text: longText })).toBe(false)
    expect(entryExpanded({ id: 'u', kind: 'user', text: longText, expanded: true })).toBe(true)
    expect(entryFoldable({ id: 'u', kind: 'user', text: longText })).toBe(true)
    expect(entryFoldable({ id: 'u', kind: 'user', text: 'short' })).toBe(false)
    expect(entryAtMinFold({ id: 'u', kind: 'user', text: longText })).toBe(true)
    expect(entryAtMinFold({ id: 'u', kind: 'user', text: longText, expanded: true })).toBe(false)
    expect(entryAtMinFold({ id: 'u', kind: 'user', text: 'short' })).toBe(false)
  })

  it('thought：三态 displayMode 驱动展开；流式中不算最小折叠', () => {
    const th = (over: Partial<Extract<ScrollEntry, { kind: 'thought' }>>): ScrollEntry => ({
      id: 'th',
      kind: 'thought',
      text: 'x',
      ...over,
    })
    expect(entryExpanded(th({ displayMode: 'collapsed' }))).toBe(false)
    expect(entryExpanded(th({ displayMode: 'truncated' }))).toBe(true)
    expect(entryExpanded(th({ displayMode: 'expanded' }))).toBe(true)
    expect(entryFoldable(th({}))).toBe(true)
    expect(entryFoldable(th({ streaming: true }))).toBe(false)
    expect(entryAtMinFold(th({ streaming: true }))).toBe(false)
    expect(entryAtMinFold(th({ displayMode: 'collapsed' }))).toBe(true)
  })

  it('tool：foldable 需有 raw 且 raw 有可展开体；仅 hooks 也可折', () => {
    const tool = (raw?: ToolCall, over: Partial<Extract<ScrollEntry, { kind: 'tool' }>> = {}): ScrollEntry => ({
      id: 't',
      kind: 'tool',
      title: 't',
      verb: 'v',
      raw,
      ...over,
    })
    expect(entryFoldable(tool())).toBe(false)
    expect(entryFoldable(tool({ kind: 'execute' }))).toBe(false)
    expect(entryFoldable(tool({ kind: 'execute', content: 'out' }))).toBe(true)
    expect(
      entryFoldable(
        tool(undefined, {
          hooks: { pre: [{ name: 'h', status: { type: 'success', elapsedMs: 1 } }] },
        }),
      ),
    ).toBe(true)
  })

  it('lifecycle 默收可折；session_event 有 stopHooks 也可折', () => {
    const life: ScrollEntry = {
      id: 'l',
      kind: 'lifecycle',
      event: 'session_start',
      runs: [{ name: 'h', status: { type: 'success', elapsedMs: 1 } }],
    }
    expect(entryFoldable(life)).toBe(true)
    expect(entryExpanded(life)).toBe(false)
    expect(entryAtMinFold(life)).toBe(true)
    expect(entryExpanded({ ...life, expanded: true })).toBe(true)

    const marker: ScrollEntry = {
      id: 'm',
      kind: 'session_event',
      text: 'Worked for 1.0s',
      stopHooks: [{ event: 'stop', runs: [{ name: 'h', status: { type: 'success' } }] }],
    }
    expect(entryFoldable(marker)).toBe(true)
    expect(entryFoldable({ id: 's', kind: 'session_event', text: 'Worked for 1.0s' })).toBe(false)
    expect(entryFoldable({ id: 'r', kind: 'session_event', text: 'sum', recap: true })).toBe(true)
  })

  it('group_header：collapse 字段即展开态', () => {
    expect(entryExpanded({ id: 'g', kind: 'group_header', count: 3, collapse: true })).toBe(true)
    expect(entryAtMinFold({ id: 'g', kind: 'group_header', count: 3, collapse: true })).toBe(false)
    expect(entryAtMinFold({ id: 'g', kind: 'group_header', count: 3 })).toBe(true)
  })
})

describe('expandableGlyph', () => {
  const longText = `${'a'.repeat(70)}\n${'b'.repeat(70)}\n${'c'.repeat(70)}\n${'d'.repeat(70)}`

  it('active + foldable + 最小折叠 → chevron；否则 null', () => {
    expect(expandableGlyph({ id: 'u', kind: 'user', text: longText }, true)).toBe(Glyphs.chevron)
    expect(expandableGlyph({ id: 'u', kind: 'user', text: longText }, false)).toBeNull()
    expect(expandableGlyph({ id: 'u', kind: 'user', text: 'short' }, true)).toBeNull()
    expect(expandableGlyph({ id: 'a', kind: 'assistant', text: 'x' }, true)).toBeNull()
  })
})

describe('entryFlashActive', () => {
  it('完成闪仅在 FINISH_FLASH_MS 窗口内的 tool / thought', () => {
    const now = 10_000
    expect(
      entryFlashActive({ id: 't', kind: 'tool', title: 't', verb: 'v', finishedAt: now - 100 }, now),
    ).toBe(true)
    expect(
      entryFlashActive(
        { id: 't', kind: 'tool', title: 't', verb: 'v', finishedAt: now - FINISH_FLASH_MS },
        now,
      ),
    ).toBe(false)
    expect(
      entryFlashActive({ id: 'th', kind: 'thought', text: 'x', finishedAt: now - 1 }, now),
    ).toBe(true)
    expect(entryFlashActive({ id: 'u', kind: 'user', text: 'x' }, now)).toBe(false)
  })
})

describe('isHeaderStyleBlock', () => {
  it('tool / thought / group_header / lifecycle 为头部样式块', () => {
    expect(isHeaderStyleBlock({ id: 't', kind: 'tool', title: 't', verb: 'v' })).toBe(true)
    expect(isHeaderStyleBlock({ id: 'th', kind: 'thought', text: 'x' })).toBe(true)
    expect(isHeaderStyleBlock({ id: 'g', kind: 'group_header', count: 1 })).toBe(true)
    expect(
      isHeaderStyleBlock({ id: 'l', kind: 'lifecycle', event: 'session_start', runs: [] }),
    ).toBe(true)
    expect(isHeaderStyleBlock({ id: 'u', kind: 'user', text: 'x' })).toBe(false)
  })
})

describe('toolHasExpandableBody', () => {
  it('execute 有输出可展开，无输出不可', () => {
    expect(toolHasExpandableBody({ kind: 'execute', content: 'out' }, 'execute')).toBe(true)
    expect(toolHasExpandableBody({ kind: 'execute' }, 'execute')).toBe(false)
  })
})
