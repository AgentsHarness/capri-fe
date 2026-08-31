import { describe, expect, it } from 'vitest'
import type { ScrollEntry } from '../../../api/types'
import { viewerOpenActions } from './viewerOpen'
import type { ChatState, SetState } from '../types'

/** 最小 ChatState：openViewer 只触碰这里列出的字段。 */
function makeState(patch: Partial<ChatState> = {}): ChatState {
  const state = {
    entries: [] as ScrollEntry[],
    selectedId: null,
    viewerEntryId: null,
    viewerTask: undefined,
    focusMode: 'scrollback',
    bgTaskIndex: {},
    refreshTaskOutput: () => {},
    openTaskViewer: () => {},
    ...patch,
  } as unknown as ChatState
  return state
}

function bind(state: ChatState) {
  const set: SetState = (partial) => {
    Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
  }
  return viewerOpenActions(set, () => state) as Pick<ChatState, 'openViewer'>
}

const btw = (o: Partial<ScrollEntry> = {}): ScrollEntry =>
  ({ id: 'b1', kind: 'btw', question: '还有几步？', ...o }) as ScrollEntry

describe('openViewer — btw 允许弹窗查看', () => {
  it('btw 条目 → viewerEntryId 命中', () => {
    const state = makeState({ entries: [btw()] })
    bind(state).openViewer('b1')
    expect(state.viewerEntryId).toBe('b1')
    expect(state.selectedId).toBe('b1')
    expect(state.focusMode).toBe('scrollback')
  })

  it('btw 无 answer/error 也允许（含 streaming 中）', () => {
    const state = makeState({ entries: [btw({ streaming: true })] })
    bind(state).openViewer('b1')
    expect(state.viewerEntryId).toBe('b1')
  })

  it('group_header（gh_ 前缀）仍被拒绝', () => {
    const state = makeState({ entries: [] })
    bind(state).openViewer('gh_x')
    expect(state.viewerEntryId).toBeNull()
  })

  it('不在白名单的种类（session_event）仍被拒绝', () => {
    const state = makeState({
      entries: [{ id: 'se1', kind: 'session_event', text: 'hi' } as ScrollEntry],
    })
    bind(state).openViewer('se1')
    expect(state.viewerEntryId).toBeNull()
  })
})