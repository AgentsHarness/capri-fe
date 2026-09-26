import { describe, expect, it } from 'vitest'
import {
  autoRestoreAfterSend,
  draftHasContent,
  isStashChord,
  isUndoKey,
  parkDraft,
  takeUndoArm,
  type ComposerDraft,
} from './promptStash'

const draft = (over: Partial<ComposerDraft> = {}): ComposerDraft => ({
  text: 'half typed',
  chips: [],
  shellMode: false,
  ...over,
})

describe('prompt stash', () => {
  it('parks text and images, and refuses an empty composer', () => {
    const parked = parkDraft(draft({ shellMode: true }), 'chord')
    expect(parked?.text).toBe('half typed')
    expect(parked?.shellMode).toBe(true)
    expect(parked?.undoArmed).toBe(true)
    expect(parkDraft(draft({ text: '' }), 'chord')).toBeNull()
    expect(draftHasContent(draft({ text: '', chips: [{ id: '1', label: 'p', content: 'x' }] }))).toBe(true)
  })

  it('the next key consumes the undo arm; only undo while empty pops', () => {
    const parked = parkDraft(draft(), 'chord')
    const taken = takeUndoArm(parked)
    expect(taken.armed).toBe(true)
    expect(taken.slot?.undoArmed).toBe(false)
    expect(takeUndoArm(taken.slot).armed).toBe(false)
    expect(isUndoKey({ key: 'z', ctrlKey: true, metaKey: false, altKey: false })).toBe(true)
    expect(isUndoKey({ key: 'z', ctrlKey: false, metaKey: true, altKey: false })).toBe(true)
    expect(isStashChord({ key: 's', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(true)
    expect(isStashChord({ key: 's', ctrlKey: false, metaKey: false, altKey: true, shiftKey: false })).toBe(true)
    expect(isStashChord({ key: 's', ctrlKey: true, metaKey: true, altKey: false, shiftKey: false })).toBe(false)
  })

  it('a chord stash returns after send; a double-Esc clear does not', () => {
    expect(autoRestoreAfterSend(parkDraft(draft(), 'chord'), false)?.text).toBe('half typed')
    expect(autoRestoreAfterSend(parkDraft(draft(), 'cleared'), false)).toBeNull()
    expect(autoRestoreAfterSend(parkDraft(draft(), 'chord'), true)).toBeNull()
  })
})
