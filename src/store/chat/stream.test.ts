import { describe, expect, it } from 'vitest'
import { sealThought, sealThoughtVisual } from './stream'
import type { ChatState } from './types'
import type { ScrollEntry } from '../../api/types'

function stateWith(thought: Partial<Extract<ScrollEntry, { kind: 'thought' }>>): ChatState {
  const entry: ScrollEntry = {
    id: 'th',
    kind: 'thought',
    text: 'thinking…',
    streaming: true,
    displayMode: 'expanded',
    ...thought,
  } as ScrollEntry
  return {
    entries: [entry],
    openThoughtId: 'th',
    openAssistantId: undefined,
    liveStream: null,
  } as unknown as ChatState
}

const sealed = (s: { entries: ScrollEntry[] }) =>
  s.entries.find(
    (e): e is Extract<ScrollEntry, { kind: 'thought' }> => e.kind === 'thought',
  )!

describe('sealThought — foldPinned（TUI display_mode_pinned）豁免', () => {
  it('未钉住：收口折回 collapsed（原有行为）', () => {
    const s = sealThought(stateWith({}))
    expect(sealed(s).displayMode).toBe('collapsed')
    expect(sealed(s).finishedAt).toBeTruthy()
  })

  it('手动展开过（foldPinned）：收口保留 expanded，不丢用户手势', () => {
    const s = sealThought(stateWith({ foldPinned: true }))
    expect(sealed(s).streaming).toBe(false)
    expect(sealed(s).displayMode).toBe('expanded')
    expect(sealed(s).finishedAt).toBeTruthy()
  })

  it('手动折成 truncated（foldPinned）：收口保留 truncated', () => {
    const s = sealThought(
      stateWith({ displayMode: 'truncated', foldPinned: true }),
    )
    expect(sealed(s).displayMode).toBe('truncated')
  })

  it('sealThoughtVisual 同款豁免', () => {
    const kept = sealThoughtVisual(stateWith({ foldPinned: true }))
    expect(sealed(kept).displayMode).toBe('expanded')
    const folded = sealThoughtVisual(stateWith({}))
    expect(sealed(folded).displayMode).toBe('collapsed')
  })
})
