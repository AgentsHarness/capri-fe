import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ScrollEntry } from '../../../api/types'
import type { EntryChrome } from '../chrome'
import { ErrorEntry } from './MiscEntries'

// AccentRail 依赖 ResizeObserver / matchMedia（jsdom 均未实现）。
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ROStub as unknown as typeof ResizeObserver
window.matchMedia = window.matchMedia ?? (() => ({ matches: false })) as never

function makeChrome(e: ScrollEntry): EntryChrome {
  return {
    shell: {
      e,
      selected: false,
      hovered: false,
      onHover: () => {},
      onSelect: () => {},
      pendingFreeze: false,
      now: 0,
      dense: false,
      denseNext: false,
      densePrev: false,
      inGroup: false,
    },
    bullet: { color: '#000' },
    caret: null,
    bulletGlyph: undefined,
    rowBtn: '',
    openViewer: vi.fn(),
    toggleTool: () => {},
    toggleThought: () => {},
    toggleUser: () => {},
    toggleBtw: () => {},
    cancelSubagent: () => {},
    killTask: () => {},
    liveText: undefined,
    thoughtText: undefined,
    bodyRef: { current: null },
    inMini: false,
  } as EntryChrome
}

const err = (
  o: Partial<Extract<ScrollEntry, { kind: 'error' }>> & { id: string },
): Extract<ScrollEntry, { kind: 'error' }> =>
  ({
    kind: 'error',
    text: 'agent unreachable',
    ...o,
  }) as Extract<ScrollEntry, { kind: 'error' }>

describe('ErrorEntry — 行内重启动作', () => {
  it('传输级错误行渲染 [重启] 纯文本动作（无外边框，不撑高行）', () => {
    const e = err({ id: 'e1', action: 'restart-agent' })
    render(<ErrorEntry e={e} chrome={makeChrome(e)} />)
    const btn = screen.getByRole('button', { name: '[重启]' })
    expect(btn.textContent).toBe('[重启]')
    expect(btn.className).not.toMatch(/border/)
    expect(btn.className).not.toMatch(/\bpy-/)
  })

  it('无 action 的普通错误行不渲染动作', () => {
    const e = err({ id: 'e2' })
    render(<ErrorEntry e={e} chrome={makeChrome(e)} />)
    expect(screen.queryByRole('button', { name: /重启/ })).toBeNull()
  })
})
