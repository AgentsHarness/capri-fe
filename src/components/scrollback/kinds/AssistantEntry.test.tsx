import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useChatStore } from '../../../store/chat'
import type { ScrollEntry } from '../../../api/types'
import type { EntryChrome } from '../chrome'
import { AssistantEntry } from './AssistantEntry'

/** 最小 chrome：AssistantEntry 只消费 shell.selected / openViewer /
 *  onHeaderDblClick / liveText / inMini；其余字段给安全默认值。 */
function makeChrome(e: ScrollEntry, selected = true): EntryChrome {
  return {
    shell: {
      e,
      selected,
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
    onHeaderClick: () => {},
    onHeaderDblClick: () => {},
    openViewer: () => {},
    toggleTool: () => {},
    toggleThought: () => {},
    toggleUser: () => {},
    cancelSubagent: () => {},
    killTask: () => {},
    liveText: undefined,
    thoughtText: undefined,
    bodyRef: { current: null },
    inMini: false,
  } as EntryChrome
}

const entry = (o: Partial<ScrollEntry> & { id: string; kind: ScrollEntry['kind'] }): ScrollEntry =>
  o as ScrollEntry

/** AssistantEntry 的 e 只收 assistant 变体；测试数组混排 user/tool 行。 */
const asAssistant = (e: ScrollEntry) => e as Extract<ScrollEntry, { kind: 'assistant' }>

describe('AssistantEntry — 消息级 Fork', () => {
  beforeEach(() => {
    useChatStore.setState({ forkSession: vi.fn().mockResolvedValue(undefined) })
  })

  it('k = historyTurnIdx + 之前的 user 行数 − 1（排除 isShell 行）', () => {
    const entries: ScrollEntry[] = [
      entry({ id: 'u0', kind: 'user', text: 'first' }),
      entry({ id: 'a0', kind: 'assistant', text: 'reply 1' }),
      // shell `!` 直执行行不经 agent、不开新轮 → 不计数。
      entry({ id: 's0', kind: 'user', text: 'ls', isShell: true }),
      entry({ id: 'u1', kind: 'user', text: 'second' }),
      entry({ id: 'a1', kind: 'assistant', text: 'reply 2' }),
    ]
    const forkSession = useChatStore.getState().forkSession as ReturnType<typeof vi.fn>
    useChatStore.setState({ entries, historyTurnIdx: 3 })

    const a1 = entries[4]
    render(<AssistantEntry e={asAssistant(a1)} chrome={makeChrome(a1)} />)
    fireEvent.click(screen.getByRole('button', { name: /Fork/ }))
    expect(forkSession).toHaveBeenCalledWith({ targetPromptIndex: 4 })
  })

  it('首条回复 → k = historyTurnIdx（窗口基轮本身）', () => {
    const entries: ScrollEntry[] = [
      entry({ id: 'u0', kind: 'user', text: 'first' }),
      entry({ id: 'a0', kind: 'assistant', text: 'reply 1' }),
    ]
    const forkSession = useChatStore.getState().forkSession as ReturnType<typeof vi.fn>
    useChatStore.setState({ entries, historyTurnIdx: 7 })

    render(<AssistantEntry e={asAssistant(entries[1])} chrome={makeChrome(entries[1])} />)
    fireEvent.click(screen.getByRole('button', { name: /Fork/ }))
    expect(forkSession).toHaveBeenCalledWith({ targetPromptIndex: 7 })
  })

  it('未选中行不显示操作行（showActions 跟选中态走）', () => {
    const e = entry({ id: 'a0', kind: 'assistant', text: 'reply' })
    render(<AssistantEntry e={asAssistant(e)} chrome={makeChrome(e, false)} />)
    expect(screen.queryByRole('button', { name: /Fork/ })).not.toBeInTheDocument()
  })
})
