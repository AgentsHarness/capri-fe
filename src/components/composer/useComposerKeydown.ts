import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { ContentBlock } from '../../api/types'
import { useChatStore } from '../../store/chat'
import { usePromptQueue } from '../../store/promptQueue'
import { pushToast } from '../../store/toast'
import { transport } from '../../api/client'
import { isMultilineEnabled } from '../../commands/registry'
import { chipOccurrenceAt, type PasteChip } from './pasteChips'
import type { HistoryItem } from './promptHistory'
import type { PromptStashSlot } from './promptStash'
import {
  isStashChord,
  isUndoKey,
  parkDraft,
  takeUndoArm,
} from './promptStash'

type ComposerKeydownOptions = {
  guest: boolean
  taRef: RefObject<HTMLTextAreaElement | null>
  text: string
  chips: PasteChip[]
  shellMode: boolean
  setText: Dispatch<SetStateAction<string>>
  setChips: Dispatch<SetStateAction<PasteChip[]>>
  setShellMode: Dispatch<SetStateAction<boolean>>
  setPendingCaret: Dispatch<SetStateAction<number | null>>
  buildBlocks: (
    text: string,
    chips: PasteChip[],
  ) => { expandedText: string; blocks: ContentBlock[] }
  onSubmit: () => Promise<void>
  sendNow: () => Promise<void>
  consumeDraftForSend: () => void
  stashRef: RefObject<PromptStashSlot | null>
  noteStash: (slot: PromptStashSlot | null) => void
  queueEditIndex: number | null
  busy: boolean
  disarmEsc: () => void
  armEsc: (kind: 'clear' | 'rewind') => void
  escArmAtRef: RefObject<number>
  clearEscArm: () => void
  escArmTimestamp: () => number
  histOpen: boolean
  histSel: number
  histItems: HistoryItem[]
  setHistOpen: Dispatch<SetStateAction<boolean>>
  setHistSel: Dispatch<SetStateAction<number>>
  recallHistory: (item: HistoryItem) => void
  slashOpen: boolean
  slashLiteral: boolean
  slashRowCount: number
  setSlashSel: Dispatch<SetStateAction<number>>
  setSlashDismissed: Dispatch<SetStateAction<boolean>>
  acceptSelected: () => void
  slashEnter: (index?: number) => boolean
  atOpen: boolean
  fileSearch?: { matches: { path: string }[] } | null
  atSel: number
  setAtSel: Dispatch<SetStateAction<number>>
  closeAtPicker: () => void
  pickAtMatch: (path: string) => void
  queueFocus: boolean
  queue: { length: number }
  queueSel: number
  setQueueSel: Dispatch<SetStateAction<number>>
  setQueuePanelOpen: (open: boolean) => void
  setQueueFocus: (focus: boolean) => void
  clampCaret: (dir: 'start' | 'end' | 'nearest') => void
  expandChipAt: (at: { chip: PasteChip; start: number; end: number }) => void
  partiallyOverlapsChip: (start: number, end: number) => boolean
}

/** Composer 输入框键盘状态机（Esc 阶梯、队列/历史/斜杠/@ 菜单、chip 原子编辑）。 */
export function useComposerKeydown(options: ComposerKeydownOptions) {
  const {
    guest,
    taRef,
    text,
    chips,
    shellMode,
    setText,
    setChips,
    setShellMode,
    setPendingCaret,
    buildBlocks,
    onSubmit,
    sendNow,
    consumeDraftForSend,
    stashRef,
    noteStash,
    queueEditIndex,
    busy,
    disarmEsc,
    armEsc,
    escArmAtRef,
    clearEscArm,
    escArmTimestamp,
    histOpen,
    histSel,
    histItems,
    setHistOpen,
    setHistSel,
    recallHistory,
    slashOpen,
    slashLiteral,
    slashRowCount,
    setSlashSel,
    setSlashDismissed,
    acceptSelected,
    slashEnter,
    atOpen,
    fileSearch,
    atSel,
    setAtSel,
    closeAtPicker,
    pickAtMatch,
    queueFocus,
    queue,
    queueSel,
    setQueueSel,
    setQueuePanelOpen,
    setQueueFocus,
    clampCaret,
    expandChipAt,
    partiallyOverlapsChip,
  } = options

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                  if (guest) return
                  // IME composition (Chinese pinyin etc.): Enter commits the
                  // candidate and Backspace edits the composition — hand
                  // composition keys through untouched or Enter would send
                  // mid-composition. isComposing only (spec flag, all modern
                  // browsers): keyCode 229 lingers on some Chromium builds
                  // after composition ends and would swallow plain Enter.
                  if (e.nativeEvent.isComposing) return
                  // TUI prompt stash. The undo arm is consumed by the next
                  // key, whether or not that key is the pop.
                  {
                    const armed = takeUndoArm(stashRef.current)
                    if (armed.slot !== stashRef.current) noteStash(armed.slot)
                    if (isStashChord(e)) {
                      e.preventDefault()
                      if (queueEditIndex != null) {
                        pushToast('正在编辑排队消息，先完成或取消再暂存')
                        return
                      }
                      if (text.length > 0 || chips.length > 0) {
                        const parked = parkDraft({ text, chips, shellMode }, 'chord')
                        if (parked) {
                          noteStash(parked)
                          setText('')
                          setChips([])
                          setShellMode(false)
                          pushToast('草稿已暂存。再按 Ctrl+S 或 Alt+S 取回')
                        }
                        return
                      }
                      const slot = stashRef.current
                      if (!slot) return
                      noteStash(null)
                      setText(slot.text)
                      setChips(slot.chips)
                      setShellMode(slot.shellMode)
                      setPendingCaret(slot.text.length)
                      pushToast('已取回暂存的草稿')
                      return
                    }
                    if (
                      armed.armed &&
                      isUndoKey(e) &&
                      text.length === 0 &&
                      chips.length === 0 &&
                      queueEditIndex == null
                    ) {
                      const slot = stashRef.current
                      if (slot) {
                        e.preventDefault()
                        noteStash(null)
                        setText(slot.text)
                        setChips(slot.chips)
                        setShellMode(slot.shellMode)
                        setPendingCaret(slot.text.length)
                        pushToast('已取回暂存的草稿')
                        return
                      }
                    }
                  }
                  // Any non-Esc key disarms the idle Esc ladder.
                  if (e.key !== 'Escape') disarmEsc()
                  // TUI Ctrl+L (VS Code family mid-turn interject key):
                  // send the current draft as a mid-turn interjection —
                  // the agent injects it at the next tool/model safe gap
                  // WITHOUT cancelling the turn (x.ai/interject →
                  // {status:"queued"}; the session_interjection broadcast
                  // renders the echo row). Needs a running turn and a
                  // non-empty draft; Enter/queue paths are unaffected.
                  if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
                    if (busy && text.trim()) {
                      e.preventDefault()
                      const st = useChatStore.getState()
                      if (!st.sessionId) {
                        pushToast('没有活跃会话，无法插话')
                        return
                      }
                      if (st.historyLoading) {
                        pushToast('正在切换会话，请稍候再发送')
                        return
                      }
                      const { expandedText } = buildBlocks(text, chips)
                      void transport
                        .interject({ text: expandedText, sessionId: st.sessionId })
                        .catch(() => {
                          pushToast('插话发送失败')
                        })
                      consumeDraftForSend()
                      useChatStore.setState({
                        statusText: '插话已发送，将在安全间隙注入当前回合',
                      })
                    }
                    return
                  }
                  // TUI Shift+Tab (prompt focused): cycle mode
                  // Normal → Plan → Auto → Always → Normal (store.cycleMode).
                  if (e.key === 'Tab' && e.shiftKey) {
                    e.preventDefault()
                    e.stopPropagation()
                    void useChatStore.getState().cycleMode()
                    return
                  }
                  const el = taRef.current
                  // TUI Ctrl+Enter: send NOW (cancel the running turn,
                  // background tasks keep running).
                  if (e.key === 'Enter' && e.ctrlKey) {
                    e.preventDefault()
                    void sendNow()
                    return
                  }
                  // TUI shell mode: backspace on the empty buffer clears
                  // the leading `!` → exits shell mode.
                  if (e.key === 'Backspace' && shellMode && text === '') {
                    e.preventDefault()
                    setShellMode(false)
                    return
                  }
                  // TUI @ file picker: ↑/↓ walk the matches, Enter/Tab
                  // insert the path, Esc closes. Only these keys are
                  // consumed while the popover is open; with no matches
                  // (or an empty query) Enter/Esc still fall through to
                  // their usual handlers (submit / panel close).
                  if (atOpen) {
                    const atMatches = fileSearch?.matches ?? []
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      e.stopPropagation()
                      closeAtPicker()
                      return
                    }
                    if (atMatches.length > 0) {
                      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                        e.preventDefault()
                        if (e.key === 'ArrowUp') {
                          setAtSel((s) => Math.max(0, s - 1))
                        } else {
                          setAtSel((s) => Math.min(atMatches.length - 1, s + 1))
                        }
                        return
                      }
                      if (
                        (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) ||
                        e.key === 'Tab'
                      ) {
                        e.preventDefault()
                        e.stopPropagation()
                        pickAtMatch(atMatches[Math.min(atSel, atMatches.length - 1)].path)
                        return
                      }
                    }
                    // No matches / empty query: fall through (Enter submits,
                    // typing continues) — the picker stays open for edits.
                  }
                  // TUI slash menu: Tab accepts the highlighted row — text
                  // only, never executes (Enter is the executing key). It
                  // still swallows the global Tab focus-toggle.
                  if (e.key === 'Tab' && slashOpen && slashRowCount > 0) {
                    e.preventDefault()
                    e.stopPropagation()
                    acceptSelected()
                    return
                  }
                  // TUI prompt history recall: ↑ on an EMPTY input opens
                  // the panel; non-empty ↑ stays a plain caret move.
                  if (
                    (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
                    !e.ctrlKey &&
                    !e.metaKey &&
                    !e.altKey
                  ) {
                    if (histOpen) {
                      e.preventDefault()
                      // TUI history_search.rs: ↑ 沿列表向上走向更旧（最旧
                      // 在顶），↓ 向下走向更新，越过最新一条（底部）关闭。
                      if (e.key === 'ArrowUp') {
                        setHistSel((s) => Math.max(0, s - 1))
                      } else if (histSel >= histItems.length - 1) {
                        setHistOpen(false)
                      } else {
                        setHistSel((s) => Math.min(histItems.length - 1, s + 1))
                      }
                      return
                    }
                    // 队列获焦时 ↑/↓ 在行间移动（空输入；输入中不抢光标）。
                    if (queueFocus && queueEditIndex == null && queue.length > 0 && text === '') {
                      e.preventDefault()
                      const sel = Math.min(queueSel, queue.length - 1)
                      setQueueSel(
                        e.key === 'ArrowUp'
                          ? Math.max(0, sel - 1)
                          : Math.min(queue.length - 1, sel + 1),
                      )
                      return
                    }
                    if (e.key === 'ArrowUp' && text === '' && !shellMode) {
                      if (queue.length > 0) {
                        // 空输入 ↑：焦点进 composer 内联队列（最后一行），
                        // 没有排队消息才打开提示历史。
                        e.preventDefault()
                        setQueueSel(queue.length - 1)
                        setQueuePanelOpen(true)
                        setQueueFocus(true)
                      } else if (history.length > 0) {
                        e.preventDefault()
                        // 打开即选中最新一条（列表底部，TUI stick_to_bottom）。
                        setHistSel(histItems.length - 1)
                        setHistOpen(true)
                      }
                      return
                    }
                    // Non-empty input (or ↓): fall through — plain caret
                    // movement + chip edge clamping below.
                  }
                  // TUI slash menu: ↑/↓ walk the filtered command list.
                  // ONLY those two keys are consumed here — letters,
                  // Backspace, Enter, Esc, Tab etc. must fall through to
                  // their own handlers below (typing filters the menu,
                  // Enter executes the highlighted row, Esc dismisses).
                  // Swallowing every key made the input uneditable while
                  // the menu was open (typing stopped at "/").
                  if (
                    slashOpen &&
                    (e.key === 'ArrowUp' || e.key === 'ArrowDown')
                  ) {
                    e.preventDefault()
                    if (e.key === 'ArrowUp') {
                      setSlashSel((s) => Math.max(0, s - 1))
                    } else {
                      setSlashSel((s) => Math.min(s + 1, slashRowCount - 1))
                    }
                    return
                  }
                  if (histOpen) {
                    // Enter/Tab 填入（与斜杠菜单 Enter/Tab 执行同构）。
                    if (
                      (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) ||
                      e.key === 'Tab'
                    ) {
                      e.preventDefault()
                      const item = histItems[histSel]
                      if (item) recallHistory(item)
                      return
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      e.stopPropagation()
                      setHistOpen(false)
                      return
                    }
                  }
                  // Chip atomicity: a directional move that lands inside a
                  // chip label is clamped to the edge it came from (TUI
                  // renders the caret on the block edge, never inside).
                  if (
                    e.key === 'ArrowLeft' ||
                    e.key === 'ArrowUp' ||
                    e.key === 'Home' ||
                    e.key === 'PageUp'
                  ) {
                    requestAnimationFrame(() => clampCaret('start'))
                  }
                  if (
                    e.key === 'ArrowRight' ||
                    e.key === 'ArrowDown' ||
                    e.key === 'End' ||
                    e.key === 'PageDown'
                  ) {
                    requestAnimationFrame(() => clampCaret('end'))
                  }
                  // Whole-chip delete (TextArea element-at-cursor): Backspace
                  // at/after the label end, Delete at/inside its start — the
                  // entire chip goes in one step.
                  if (
                    (e.key === 'Backspace' || e.key === 'Delete') &&
                    el &&
                    el.selectionStart === el.selectionEnd
                  ) {
                    const at = chipOccurrenceAt(
                      text,
                      chips,
                      e.key === 'Backspace'
                        ? el.selectionStart - 1
                        : el.selectionStart,
                      'inside',
                    )
                    if (at) {
                      e.preventDefault()
                      setText((t) => t.slice(0, at.start) + t.slice(at.end))
                      setChips((cs) =>
                        cs.filter((c) => c.id !== at.chip.id),
                      )
                      setPendingCaret(at.start)
                      return
                    }
                  }
                  // Selection-based delete: a selection touching a chip
                  // without fully covering it is widened to the full chip
                  // boundary (TUI selection expands to element edges), then
                  // the native delete takes the whole elements. A fully
                  // covering selection (e.g. Cmd+A) passes through untouched.
                  if (
                    (e.key === 'Backspace' || e.key === 'Delete') &&
                    el &&
                    el.selectionStart !== el.selectionEnd
                  ) {
                    const selStart = el.selectionStart
                    const selEnd = el.selectionEnd
                    let lo = selStart
                    let hi = selEnd
                    for (;;) {
                      let changed = false
                      for (const c of chips) {
                        let from = 0
                        for (;;) {
                          const i = text.indexOf(c.label, from)
                          if (i === -1) break
                          const e2 = i + c.label.length
                          if (lo < e2 && hi > i) {
                            const nlo = Math.min(lo, i)
                            const nhi = Math.max(hi, e2)
                            if (nlo !== lo || nhi !== hi) {
                              lo = nlo
                              hi = nhi
                              changed = true
                            }
                          }
                          from = e2
                        }
                      }
                      if (!changed) break
                    }
                    if (lo !== selStart || hi !== selEnd) {
                      el.setSelectionRange(lo, hi)
                    }
                    // Fall through — native delete, onChange prunes chips.
                  } else if (
                    // TUI atomic chips: character edits that would land
                    // inside (partially cover) a chip label are swallowed.
                    el &&
                    e.key.length === 1 &&
                    !e.metaKey &&
                    !e.ctrlKey &&
                    !e.altKey &&
                    partiallyOverlapsChip(el.selectionStart, el.selectionEnd)
                  ) {
                    e.preventDefault()
                    return
                  }
                  if (e.key === 'Enter' && !e.ctrlKey) {
                    // TUI /multiline: on → Enter inserts a newline and
                    // Shift+Enter sends; off (default) → Enter sends and
                    // Shift+Enter is the newline. Shell mode overrides
                    // either way: Enter always sends, Shift+Enter newline.
                    const multiline = isMultilineEnabled()
                    const sendKey = shellMode
                      ? !e.shiftKey
                      : multiline
                        ? e.shiftKey
                        : !e.shiftKey
                    if (sendKey) {
                      // TUI: Enter ON a chip expands it (paste_preview_hint);
                      // anywhere else it keeps its normal submit behavior.
                      // Shell mode: Enter always submits the command.
                      if (!shellMode && el && el.selectionStart === el.selectionEnd) {
                        const at = chipOccurrenceAt(
                          text,
                          chips,
                          el.selectionStart,
                          'inside',
                        )
                        if (at) {
                          e.preventDefault()
                          expandChipAt(at)
                          return
                        }
                      } else if (!shellMode && el) {
                        // Selection spanning exactly one chip label → expand.
                        const sel = text.slice(el.selectionStart, el.selectionEnd)
                        const chip = chips.find((c) => c.label === sel)
                        if (chip) {
                          e.preventDefault()
                          expandChipAt({
                            chip,
                            start: el.selectionStart,
                            end: el.selectionEnd,
                          })
                          return
                        }
                      }
                      e.preventDefault()
                      // TUI slash commands: a `/…` line that resolves to a
                      // command runs locally and is NEVER sent to the agent.
                      // `slashEnter` also owns the two-level dropdown (it
                      // completes `/effort` into `/effort ` + the level list
                      // instead of running it). Everything it declines falls
                      // through and goes out as plain text: the `\/…` /
                      // leading-space literals, and lines whose first word
                      // matches no command at all (the TUI appends an error
                      // row there — the FE lets it pass).
                      if (
                        !shellMode &&
                        !slashLiteral &&
                        text.trimStart().startsWith('/') &&
                        slashEnter()
                      ) {
                        return
                      }
                      void onSubmit()
                      return
                    }
                    // Newline key (default Shift+Enter / multiline Enter):
                    // a bare Enter on a chip still expands it (TUI element
                    // interaction); otherwise the textarea inserts the
                    // newline natively.
                    if (!e.shiftKey && !shellMode && el) {
                      if (el.selectionStart === el.selectionEnd) {
                        const at = chipOccurrenceAt(
                          text,
                          chips,
                          el.selectionStart,
                          'inside',
                        )
                        if (at) {
                          e.preventDefault()
                          expandChipAt(at)
                          return
                        }
                      } else {
                        const sel = text.slice(el.selectionStart, el.selectionEnd)
                        const chip = chips.find((c) => c.label === sel)
                        if (chip) {
                          e.preventDefault()
                          expandChipAt({
                            chip,
                            start: el.selectionStart,
                            end: el.selectionEnd,
                          })
                          return
                        }
                      }
                    }
                    // fall through — native newline
                    return
                  }
                  if (e.key === 'Escape') {
                    // Slash menu closes first (swallowed like the panels).
                    if (slashOpen) {
                      e.preventDefault()
                      e.stopPropagation()
                      setSlashDismissed(true)
                      return
                    }
                    // Panels close first; Esc is swallowed so the global
                    // busy-cancel doesn't also fire.
                    if (histOpen) {
                      e.preventDefault()
                      e.stopPropagation()
                      setHistOpen(false)
                      return
                    }
                    if (queueEditIndex != null) {
                      e.preventDefault()
                      e.stopPropagation()
                      usePromptQueue.getState().cancelEdit()
                      return
                    }
                    if (queueFocus) {
                      e.preventDefault()
                      e.stopPropagation()
                      setQueueFocus(false)
                      return
                    }
                    // TUI: Esc in shell mode with an empty input exits.
                    if (shellMode && text === '') {
                      e.preventDefault()
                      setShellMode(false)
                      return
                    }
                    // TUI Esc ladder, idle side (prompt.rs
                    // try_handle_esc_policy): first Esc arms — a draft
                    // shows "press again to clear", an empty draft arms the
                    // rewind picker; the second Esc within the TTL executes.
                    // Busy keeps the pre-existing cancel flow below (the
                    // ladder never delays a cancel).
                    if (!busy) {
                      // 跨焦点臂定：scrollback 侧首个 idle Esc
                      // （useScrollbackKeys）臂定的时间戳同样算 armed——
                      // 2×Esc 从 scrollback 起步时，第二次按键落在这里
                      // 直达回退（TUI prompt.rs 2×Esc = /rewind）。
                      const armed =
                        Date.now() -
                          Math.max(escArmAtRef.current, escArmTimestamp()) <
                        800
                      const hasDraft = text !== '' || chips.length > 0
                      if (!armed) {
                        armEsc(hasDraft ? 'clear' : 'rewind')
                        e.preventDefault()
                        e.stopPropagation()
                        return
                      }
                      disarmEsc()
                      // 跨焦点臂定一并解除，避免残留臂定让下一次 Esc 误判为第二击。
                      clearEscArm()
                      e.preventDefault()
                      e.stopPropagation()
                      if (hasDraft) {
                        const parked = parkDraft({ text, chips, shellMode }, 'cleared')
                        if (parked) {
                          noteStash(parked)
                          pushToast('草稿已暂存。再按 Ctrl+S，或紧接着按 Ctrl+Z 取回')
                        }
                        setText('')
                        setChips([])
                        setHistOpen(false)
                        return
                      }
                      useChatStore.getState().openRewind()
                      return
                    }
                    // TUI: Esc while busy goes through the cancel flow —
                    // saved preference acts directly, running subagents
                    // open the cancel panel, otherwise cancel directly.
                    if (busy) {
                      e.preventDefault()
                      e.stopPropagation()
                      void useChatStore.getState().requestCancelTurn()
                    }
                  }
                  }
  return onKeyDown
}
