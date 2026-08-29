import { useEffect, useRef, useState, type RefObject } from 'react'
import { useChatStore } from '../../store/chat'
import { transport } from '../../api/client'
import { atTokenAt } from '../../lib/atToken'
import { pruneChips, type PasteChip } from './pasteChips'

type AtPickerOpts = {
  /** 当前草稿文本与 setter（token 替换要重写 buffer）。 */
  text: string
  setText: (updater: string | ((t: string) => string)) => void
  setChips: (updater: (cs: PasteChip[]) => PasteChip[]) => void
  /** 程序性文本编辑后的光标恢复回调。 */
  setPendingCaret: (pos: number) => void
  taRef: RefObject<HTMLTextAreaElement | null>
  /** Composer chrome 外点关闭判定用。 */
  composerChromeRef: RefObject<HTMLDivElement | null>
  /** 与 slash 菜单互斥（token 探测只在菜单关闭时运行）。 */
  shellMode: boolean
  slashOpen: boolean
}

/**
 * TUI @ file picker (fuzzy file search) — hook 形态。Typing `@` (word
 * start) opens the file popover; the token after `@` is the fuzzy query.
 * Matches stream through the store's `fileSearch` state
 * (search_fuzzy_status SSE event) — the change RPC itself only arms the
 * query. Enter/Tab insert `@path ` at the token, Esc/whitespace close.
 * Mutually exclusive with the slash menu (token detection runs only when
 * it's closed) and shell mode.
 */
export function useAtPicker(opts: AtPickerOpts) {
  const { text, setText, setChips, setPendingCaret, taRef, composerChromeRef, shellMode, slashOpen } = opts
  const fileSearch = useChatStore((s) => s.fileSearch)
  const cwd = useChatStore((s) => s.cwd)
  const [atOpen, setAtOpen] = useState(false)
  const [atQuery, setAtQuery] = useState('')
  const [atSel, setAtSel] = useState(0)
  const atTokenStartRef = useRef(-1)
  const atOpeningRef = useRef(false)
  const atTimerRef = useRef<number | null>(null)

  /** Arm/refresh the engine for `query`; no-op without a workspace. */
  const atSearch = (query: string) => {
    if (atTimerRef.current != null) {
      window.clearTimeout(atTimerRef.current)
      atTimerRef.current = null
    }
    if (query === '') return // engine requires a non-empty query
    const fire = async () => {
      let searchId = useChatStore.getState().fileSearch?.searchId
      if (!searchId) {
        if (atOpeningRef.current) return
        atOpeningRef.current = true
        try {
          const st = useChatStore.getState()
          const res = await transport.searchFuzzyOpen(
            st.cwd ? { cwd: st.cwd } : {},
          )
          const sid =
            res && typeof res === 'object' && typeof res.searchId === 'string'
              ? res.searchId
              : undefined
          if (!sid) return
          searchId = sid
          useChatStore.setState({
            fileSearch: { searchId, matches: [], done: true },
          })
        } catch {
          return // no engine (old host / no workspace) — picker stays empty
        } finally {
          atOpeningRef.current = false
        }
      }
      try {
        await transport.searchFuzzyChange({ searchId, query, limit: 20 })
      } catch {
        /* stale searchId or engine hiccup — next keystroke retries */
      }
    }
    // Debounce: the engine owns per-query versioning; this only limits
    // request spam while typing.
    atTimerRef.current = window.setTimeout(() => {
      atTimerRef.current = null
      void fire()
    }, 120)
  }

  /** Tear the engine session down and close the popover. */
  const closeAtPicker = () => {
    if (atTimerRef.current != null) {
      window.clearTimeout(atTimerRef.current)
      atTimerRef.current = null
    }
    const searchId = useChatStore.getState().fileSearch?.searchId
    useChatStore.setState({ fileSearch: null })
    if (searchId) void transport.searchFuzzyClose({ searchId }).catch(() => {})
    atOpeningRef.current = false
    atTokenStartRef.current = -1
    setAtOpen(false)
    setAtQuery('')
    setAtSel(0)
  }

  /**
   * Re-detect the @ token under the caret (text edits AND caret moves —
   * moving out of the token closes the picker, moving within re-queries).
   */
  const detectAtToken = (value: string, caret: number) => {
    if (shellMode || slashOpen) {
      if (atOpen) closeAtPicker()
      return
    }
    const tok = atTokenAt(value, caret)
    if (!tok) {
      if (atOpen) closeAtPicker()
      return
    }
    // Same token (onChange + onSelect both fire per edit) — nothing to do.
    if (atOpen && tok.start === atTokenStartRef.current && tok.query === atQuery) {
      return
    }
    atTokenStartRef.current = tok.start
    setAtOpen(true)
    setAtQuery(tok.query)
    setAtSel(0)
    atSearch(tok.query)
  }

  /** Insert the picked path in place of the `@token`, caret after it. */
  const pickAtMatch = (path: string) => {
    const el = taRef.current
    const start = atTokenStartRef.current
    if (start < 0) return
    const caret = el?.selectionStart ?? text.length
    const inserted = `@${path} `
    const next = text.slice(0, start) + inserted + text.slice(caret)
    setText(next)
    setChips((cs) => pruneChips(next, cs))
    setPendingCaret(start + inserted.length)
    closeAtPicker()
  }

  // Click outside the composer chrome dismisses the @ picker too.
  useEffect(() => {
    if (!atOpen) return
    const onDown = (e: MouseEvent) => {
      if (
        composerChromeRef.current &&
        !composerChromeRef.current.contains(e.target as Node)
      ) {
        closeAtPicker()
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atOpen])

  // Session switch / unmount: the engine session is tied to this
  // composer's workspace — release it.
  useEffect(() => {
    if (atOpen) closeAtPicker()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd])
  useEffect(() => closeAtPicker, [])

  return {
    fileSearch,
    atOpen,
    atQuery,
    atSel,
    setAtSel,
    detectAtToken,
    pickAtMatch,
    closeAtPicker,
  }
}
