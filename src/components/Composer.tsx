import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
} from 'react'
import { useChatStore, formatTurnDuration, stillRunningCue } from '../store/chat'
import { usePromptQueue } from '../store/promptQueue'
import type { ContentBlock } from '../api/types'
import {
  Glyphs,
  MONITOR_PULSE_FRAMES,
  MONITOR_PULSE_INTERVAL_MS,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
} from '../theme/glyphs'
import {
  COMPOSER_BODY_PAD_LEFT_PX,
  CONTENT_COLUMN_CLASS,
  COLUMN_PAD_X_CLASS,
} from '../theme/layout'
import { IconGlyph } from './IconGlyph'
import { fmtTok } from './StatusChips'
import { SlashMenu } from './SlashMenu'
import {
  filterSlashCommands,
  isMultilineEnabled,
  matchSlash,
  registerModelMenuOpener,
  type SlashCommand,
} from '../commands/registry'

/** ── TUI paste-chip port (PromptWidget::handle_paste) ──────────────────
 * Pastes at/above the chip threshold become an atomic `[Pasted: N lines]`
 * element instead of inline text; the full content is stashed and only
 * materialized on expand (enter / double-click / paste-again) or submit.
 */
const CHIP_MIN_LINES = 4 // TUI: 4, or 2 in compact mode (web has none)
const CHIP_DISPLAY_BYTES = 10_000

/**
 * Paste chip = text paste chip; image chip = pasted/dropped image behind
 * an `[Image: <name>]` label. Both share the same atomic-label mechanics
 * (prune / caret clamp / whole-chip delete / Enter expand); image chips
 * expand to an inline thumbnail instead of text, and their data leaves
 * as an image ContentBlock on submit.
 */
type PasteChip = {
  id: string
  label: string
  content: string
  /** Image chip: label stays in the text; data goes out as an image block. */
  image?: { data: string; mimeType: string; name: string; size: number }
  /** Image chip inline thumbnail expanded (Enter / double-click). */
  expanded?: boolean
}

/** ── Prompt history (TUI: ↑ on empty input recalls) ────────────────── */
const HISTORY_KEY = 'acpfe.promptHistory'
const HISTORY_MAX = 50

type HistoryItem = { text: string; ts: number }

function loadPromptHistory(): HistoryItem[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    const out: HistoryItem[] = []
    for (const x of arr) {
      if (x && typeof x.text === 'string' && x.text.trim()) {
        out.push({
          text: x.text,
          ts: typeof x.ts === 'number' ? x.ts : Date.now(),
        })
        if (out.length >= HISTORY_MAX) break
      }
    }
    return out
  } catch {
    return []
  }
}

function savePromptHistory(items: HistoryItem[]): void {
  try {
    window.localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify(items.slice(0, HISTORY_MAX)),
    )
  } catch {
    /* storage full / unavailable — history is best-effort */
  }
}

/** ── Image chips (paste / drop) ────────────────────────────────────── */
function fileToDataUrl(
  file: File,
): Promise<{ data: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => {
      const url = typeof fr.result === 'string' ? fr.result : ''
      const comma = url.indexOf(',')
      if (comma === -1) {
        reject(new Error('unreadable image'))
        return
      }
      // "data:<mime>;base64,<payload>" → mime (payload keeps NO data: prefix,
      // matching the ContentBlock image contract).
      const mimeType = url.slice(5, comma).split(';')[0] || file.type || 'image/png'
      resolve({ data: url.slice(comma + 1), mimeType })
    }
    fr.onerror = () => reject(fr.error ?? new Error('image read failed'))
    fr.readAsDataURL(file)
  })
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

/** Bare \r → \n, leaving \r\n pairs intact (PromptWidget::normalize_cr). */
function normalizeCr(text: string): string {
  return text.replace(/\r(?!\n)/g, '\n')
}

/** Content line count — Rust str::lines(): a trailing \n adds no line. */
function contentLines(text: string): number {
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

function utf8Len(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Chip label: `[Pasted: N lines]`, or byte size for >10 KB pastes. */
function pasteChipLabel(cleaned: string): string {
  const bytes = utf8Len(cleaned)
  if (bytes > CHIP_DISPLAY_BYTES) {
    const size =
      bytes >= 1_000_000
        ? `${(bytes / 1_000_000).toFixed(1)} MB`
        : bytes >= 1000
          ? `${Math.floor(bytes / 1000)} KB`
          : `${bytes} bytes`
    return `[Pasted: ${size}]`
  }
  const n = contentLines(cleaned)
  return `[Pasted: ${n} line${n === 1 ? '' : 's'}]`
}

/** Text range of the chip occurrence containing `pos` (or ending at it). */
function chipOccurrenceAt(
  text: string,
  chips: PasteChip[],
  pos: number,
  mode: 'inside' | 'end',
): { chip: PasteChip; start: number; end: number } | null {
  for (const chip of chips) {
    let from = 0
    for (;;) {
      const start = text.indexOf(chip.label, from)
      if (start === -1) break
      const end = start + chip.label.length
      if (mode === 'inside' ? pos >= start && pos < end : pos === end) {
        return { chip, start, end }
      }
      from = end
    }
  }
  return null
}

/**
 * Chip occurrence the caret is on (start edge), inside, or right after
 * (end edge) — TUI paste_element_for_preview + double-click expansion.
 */
function chipOccurrenceAtCaret(
  text: string,
  chips: PasteChip[],
  pos: number,
): { chip: PasteChip; start: number; end: number } | null {
  for (const chip of chips) {
    let from = 0
    for (;;) {
      const start = text.indexOf(chip.label, from)
      if (start === -1) break
      const end = start + chip.label.length
      if (pos >= start && pos <= end) return { chip, start, end }
      from = end
    }
  }
  return null
}

/** Expand every chip into its stashed content (submit path).
 *  Image chips keep their `[Image: …]` label in the text — the image
 *  itself travels as a ContentBlock, so the label must survive. */
function expandChips(text: string, chips: PasteChip[]): string {
  let out = text
  for (const chip of chips) {
    if (chip.image) continue
    const idx = out.indexOf(chip.label)
    if (idx !== -1) {
      out = out.slice(0, idx) + chip.content + out.slice(idx + chip.label.length)
    }
  }
  return out
}

/**
 * Drop chips whose label no longer appears in the text (user edits).
 * Occurrences are paired to chips in insertion order so a paste-then-edit
 * never leaves a stale chip that hijacks a later identical label.
 */
function pruneChips(text: string, chips: PasteChip[]): PasteChip[] {
  const kept: PasteChip[] = []
  let pos = 0
  for (const chip of chips) {
    const idx = text.indexOf(chip.label, pos)
    if (idx === -1) continue
    kept.push(chip)
    pos = idx + chip.label.length
  }
  return kept
}

function chipId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `chip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** ── Composer frame ───────────────────────────────────────────────────
 * Rounded border box (container border + radius) — no font glyphs, no
 * corner elements. The session title floats on the top border and the
 * model · flags caption on the bottom border, each masking the line
 * behind them with the base background ("断线").
 */
export function Composer() {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  // TUI paste chips: stashed multi-line content behind `[Pasted: N lines]`
  // labels in the textarea (PromptWidget::handle_paste).
  const [chips, setChips] = useState<PasteChip[]>([])
  // Pending caret position to restore after a programmatic text edit.
  const caretRef = useRef<{ pos: number } | null>(null)
  // Live caret position — textarea selection changes don't re-render, so
  // onSelect/keyup/mouseup mirror it here for the paste preview overlay.
  const [caretPos, setCaretPos] = useState(0)
  const send = useChatStore((s) => s.send)
  const conn = useChatStore((s) => s.conn)
  const usage = useChatStore((s) => s.usage)
  const statusText = useChatStore((s) => s.statusText)
  const modeBanner = useChatStore((s) => s.modeBanner)
  const clearModeBanner = useChatStore((s) => s.clearModeBanner)
  const awaitingNext = useChatStore((s) => s.awaitingNext)
  const entries = useChatStore((s) => s.entries)
  const topTasks = useChatStore((s) => s.topTasks)
  const tasksBarOpen = useChatStore((s) => s.tasksBarOpen)
  const setTasksBarOpen = useChatStore((s) => s.setTasksBarOpen)
  const modelName = useChatStore((s) => s.modelName)
  const reasoningEffort = useChatStore((s) => s.reasoningEffort)
  const permissionMode = useChatStore((s) => s.permissionMode)
  const yoloMode = useChatStore((s) => s.yoloMode)
  const autoMode = useChatStore((s) => s.autoMode)
  const planMode = useChatStore((s) => s.planMode)
  const focusMode = useChatStore((s) => s.focusMode)
  const turnStartedAt = useChatStore((s) => s.turnStartedAt)
  const models = useChatStore((s) => s.models)
  const setModel = useChatStore((s) => s.setModel)
  const [modelOpen, setModelOpen] = useState(false)
  const modelRef = useRef<HTMLSpanElement>(null)
  const modelBtnRef = useRef<HTMLButtonElement>(null)
  // Fixed-position menu rect so the picker stays inside the viewport on
  // mobile (absolute + max-h-[320px] was clipped by body { overflow:hidden }
  // when the composer sat at the bottom edge).
  const [modelMenuPos, setModelMenuPos] = useState<{
    bottom: number
    right: number
    maxH: number
    width: number
  } | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const busy = conn === 'busy'

  // ── TUI prompt history recall (↑ on empty input) ──
  const [history, setHistory] = useState<HistoryItem[]>(loadPromptHistory)
  const [histOpen, setHistOpen] = useState(false)
  // Panel list is newest-first; sel 0 = newest. ↑ walks older (TUI).
  const [histSel, setHistSel] = useState(0)
  const histPanelRef = useRef<HTMLDivElement>(null)

  // ── TUI mid-turn send queue (Enter during a turn → queued) ──
  const queue = usePromptQueue((s) => s.queue)
  const queueSending = usePromptQueue((s) => s.sending)
  // Queue dropdown visibility lives in the chat store so the global
  // scrollback keys can defer to it (TUI queue pane owns the keyboard).
  const queuePanelOpen = useChatStore((s) => s.queuePanelOpen)
  const setQueuePanelOpen = useChatStore((s) => s.setQueuePanelOpen)
  const queueEditIndex = usePromptQueue((s) => s.editIndex)
  const queueEditDraft = usePromptQueue((s) => s.editDraft)
  // Selected queue row (TUI queue pane selection; ↑↓/j/k move it).
  const [queueSel, setQueueSel] = useState(0)
  const queuePanelRef = useRef<HTMLDivElement>(null)
  const queuePillRef = useRef<HTMLButtonElement>(null)

  // ── TUI shell mode (`! ` prefix; command goes to the agent as a prompt) ──
  const [shellMode, setShellMode] = useState(false)
  // ── TUI slash command menu (`/` prefix; fuzzy menu + local execution) ──
  const [slashSel, setSlashSel] = useState(0)
  /** Menu dismissed (Esc / click outside); re-arms when input clears. */
  const [slashDismissed, setSlashDismissed] = useState(false)
  /** Composer chrome frame — outside clicks dismiss the slash menu. */
  const composerChromeRef = useRef<HTMLDivElement>(null)
  /** Counter for clipboard images without a filename (TUI `[Image #N]`). */
  const unnamedImgRef = useRef(0)

  const pushHistory = (sentText: string) => {
    const t = sentText.trim()
    if (!t) return
    setHistory((prev) => {
      if (prev[0]?.text === t) return prev // same as latest → skip
      const next = [{ text: t, ts: Date.now() }, ...prev].slice(0, HISTORY_MAX)
      savePromptHistory(next)
      return next
    })
  }

  /**
   * Build the wire blocks for the current buffer: the text block (paste
   * chips expanded, `[Image: …]` labels retained — TUI keeps the image
   * marker in the prompt) followed by image blocks in chip order.
   */
  const buildBlocks = (
    textValue: string,
    chipList: PasteChip[],
  ): { expandedText: string; blocks: ContentBlock[] } => {
    const expandedText = expandChips(textValue, chipList)
    const blocks: ContentBlock[] = [{ type: 'text', text: expandedText }]
    // pruneChips pairs labels to chips in document order — image blocks
    // follow the text in the same order the labels appear.
    for (const c of pruneChips(
      expandedText,
      chipList.filter((ch) => ch.image),
    )) {
      if (c.image) {
        blocks.push({ type: 'image', data: c.image.data, mimeType: c.image.mimeType })
      }
    }
    return { expandedText, blocks }
  }

  /** Insert `[Image: …]` chips for pasted/dropped files at `pos`. */
  const insertImageChips = async (files: File[], pos: number) => {
    const labels: string[] = []
    const newChips: PasteChip[] = []
    for (const f of files) {
      try {
        const { data, mimeType } = await fileToDataUrl(f)
        const name = f.name.trim() || String(++unnamedImgRef.current)
        const label = `[Image: ${name}]`
        labels.push(label)
        newChips.push({
          id: chipId(),
          label,
          content: '',
          image: { data, mimeType, name, size: f.size },
        })
      } catch {
        // Unreadable file — skip (rare).
      }
    }
    if (labels.length === 0) return
    const joined = labels.join('')
    setText((t) => t.slice(0, pos) + joined + t.slice(pos))
    setChips((cs) => [...cs, ...newChips])
    caretRef.current = { pos: pos + joined.length }
  }

  /** Send the current buffer as an agent prompt (submit / Ctrl+Enter). */
  const submitCurrent = async () => {
    const trimmed = text.trim()
    if (!trimmed) return
    const { expandedText, blocks } = buildBlocks(text, chips)
    setText('')
    setChips([])
    await send(expandedText, blocks)
    // Record history only when the host accepted the prompt (send
    // swallows transport errors into conn: 'error').
    if (useChatStore.getState().conn !== 'error') pushHistory(expandedText)
    taRef.current?.focus()
  }

  /**
   * TUI double-Enter / [发送现在]: drain the queue head immediately.
   * `sending` is the mutex shared with the auto-send effect — a user
   * gesture can never race the turn-end auto-send into a double prompt.
   */
  const sendQueuedHead = async () => {
    const q = usePromptQueue.getState()
    if (q.sending) return
    const head = q.dequeue()
    if (!head) return
    q.setSending(true)
    try {
      await useChatStore.getState().send(head.text, head.blocks)
      if (useChatStore.getState().conn !== 'error') pushHistory(head.text)
    } finally {
      q.setSending(false)
    }
  }

  /**
   * TUI Ctrl+Enter: send NOW — cancel the running turn (background tasks
   * keep running), then send the current input immediately.
   */
  const sendNow = async () => {
    const trimmed = text.trim()
    if (shellMode) {
      // Shell mode: Ctrl+Enter submits the command to the agent now.
      if (trimmed) void submitShell(trimmed)
      return
    }
    const st = useChatStore.getState()
    if (st.conn === 'busy') {
      await st.cancel()
      // Let the cancelled SSE land first so it can't clobber the new
      // turn's busy state (bounded wait; no-op when already idle).
      for (let i = 0; i < 50 && useChatStore.getState().conn === 'busy'; i++) {
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    await submitCurrent()
  }

  /**
   * TUI shell mode submit: the command goes to the agent as a normal
   * prompt (contract: store.send(text, undefined, { fromShell: true }) —
   * the merged store tags the user row so the scrollback renders it with
   * the TUI `$ ` prefix). The local store signature doesn't carry `opts`
   * yet (align/render does); the cast keeps this call contract-shaped.
   * Submit exits shell mode back to plain input.
   */
  const submitShell = async (cmd: string) => {
    setText('')
    setShellMode(false)
    setChips([])
    const st = useChatStore.getState()
    await (
      st.send as (
        t: string,
        b?: ContentBlock[],
        o?: { fromShell?: boolean },
      ) => Promise<void>
    )(cmd, undefined, { fromShell: true })
    // Record history only when the host accepted the prompt (send
    // swallows transport errors into conn: 'error') — same as submitCurrent.
    if (useChatStore.getState().conn !== 'error') pushHistory(cmd)
    taRef.current?.focus()
  }

  /** TUI queue semantics: Enter during a turn queues; empty Enter sends head. */
  const onSubmit = async () => {
    const q = usePromptQueue.getState()
    if (q.sending) return
    const trimmed = text.trim()
    if (!trimmed) {
      // Double-Enter: empty input + Enter → send the queue head now.
      if (q.queue.length > 0) void sendQueuedHead()
      return
    }
    if (shellMode) {
      void submitShell(trimmed)
      return
    }
    const st = useChatStore.getState()
    if (st.conn === 'busy') {
      // TUI: Enter during a running turn queues instead of sending.
      const { expandedText, blocks } = buildBlocks(text, chips)
      setText('')
      setChips([])
      q.enqueue({ text: expandedText, blocks })
      taRef.current?.focus()
      return
    }
    await submitCurrent()
  }

  // ── TUI slash commands (`/` prefix) ────────────────────────────────
  // Menu shows while the command word is being typed (no space yet) and
  // the input starts with "/" — shell mode is mutually exclusive. Busy
  // does NOT suppress it (commands are local actions).
  const slashOpen =
    !shellMode &&
    !slashDismissed &&
    text.startsWith('/') &&
    !text.slice(1).includes(' ')
  const slashMatches = useMemo(
    () => (slashOpen ? filterSlashCommands(text) : []),
    [slashOpen, text],
  )
  const slashList = useMemo(
    () => slashMatches.map((m) => m.cmd),
    [slashMatches],
  )
  const slashSelClamped = Math.min(slashSel, Math.max(0, slashList.length - 1))

  /** Execute a slash command (menu pick or typed line) — clears the buffer. */
  const runSlashCommand = async (cmd: SlashCommand, args: string) => {
    setSlashDismissed(true)
    setText('')
    setChips([])
    try {
      await cmd.run(args)
    } catch (e) {
      useChatStore.getState().appendLocalEntry({
        kind: 'error',
        text: `/${cmd.name} 执行失败: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
    taRef.current?.focus()
  }

  /**
   * Enter on a `/…` line: matched → execute; unknown → error row, the
   * input stays for editing and is NEVER sent to the agent (TUI).
   */
  const runSlashLine = async (input: string) => {
    const m = matchSlash(input)
    if (m) {
      await runSlashCommand(m.cmd, m.args)
      return
    }
    useChatStore.getState().appendLocalEntry({
      kind: 'error',
      text: `未知命令: ${input.split(/\s+/)[0]}。输入 /help 查看可用命令`,
    })
  }

  // /model (no args) opens the composer's own model menu.
  useEffect(() => {
    registerModelMenuOpener(() => setModelOpen(true))
    return () => registerModelMenuOpener(null)
  }, [])

  // Re-arm the menu when the input no longer starts with "/" (fresh
  // slash reopens; Esc/click dismissals survive continued typing).
  useEffect(() => {
    if (!text.startsWith('/')) setSlashDismissed(false)
  }, [text])

  // Click outside the composer chrome dismisses the slash menu.
  useEffect(() => {
    if (!slashOpen) return
    const onDown = (e: MouseEvent) => {
      if (
        composerChromeRef.current &&
        !composerChromeRef.current.contains(e.target as Node)
      ) {
        setSlashDismissed(true)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [slashOpen])

  /** Expanded image chips → inline thumbnail row above the textarea. */
  const expandedImgs = useMemo(
    () => chips.filter((c) => c.image && c.expanded),
    [chips],
  )

  // Close the recall / queue panels on outside click or Escape.
  useEffect(() => {
    if (!histOpen && !queuePanelOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (
        histOpen &&
        histPanelRef.current &&
        !histPanelRef.current.contains(t)
      ) {
        setHistOpen(false)
      }
      if (
        queuePanelOpen &&
        queuePanelRef.current &&
        !queuePanelRef.current.contains(t) &&
        !queuePillRef.current?.contains(t)
      ) {
        setQueuePanelOpen(false)
        // Closing the panel discards any in-progress row edit.
        usePromptQueue.getState().cancelEdit()
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (histOpen) setHistOpen(false)
      // While editing a row, Esc cancels the edit instead of closing the
      // panel (the edit textarea stops propagation itself; this is the
      // defense-in-depth for keys that bypass it).
      if (queuePanelOpen && queueEditIndex == null) setQueuePanelOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [histOpen, queuePanelOpen, queueEditIndex])

  // Keep the queue selection inside the current list (rows drain / get
  // deleted while the panel is open).
  useEffect(() => {
    setQueueSel((s) => Math.min(s, Math.max(0, queue.length - 1)))
  }, [queue.length])

  // ── Queue panel keyboard ops (TUI queue.rs): x delete, e/Enter edit,
  // ↑↓/j/k move the selection, Shift+K/↑ or Ctrl+↑ swap up, Shift+J/↓ or
  // Ctrl+↓ swap down. Active only while the panel is open and NOT while
  // editing or typing in the composer textarea — plain typing always
  // wins. Capture phase so the scrollback nav keys never see these.
  useEffect(() => {
    if (!queuePanelOpen || queueEditIndex != null || queue.length === 0) return
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      const t = e.target as HTMLElement | null
      if (
        !!t &&
        (t.tagName === 'TEXTAREA' ||
          t.tagName === 'INPUT' ||
          t.isContentEditable)
      ) {
        return // typing / editing — don't steal keys
      }
      if (e.metaKey || e.altKey) return
      const q = usePromptQueue.getState()
      const n = q.queue.length
      if (n === 0) return
      const sel = Math.min(queueSel, n - 1)
      let handled = true
      if (e.key === 'ArrowDown' || e.key === 'j') {
        setQueueSel(Math.min(n - 1, sel + 1))
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        setQueueSel(Math.max(0, sel - 1))
      } else if (e.key === 'x' || e.key === 'Delete' || e.key === 'Backspace') {
        q.removeAt(q.queue[sel].id)
      } else if (e.key === 'e' || e.key === 'Enter') {
        q.startEdit(sel)
      } else if (
        (e.shiftKey && (e.key === 'J' || e.key === 'ArrowDown')) ||
        (e.ctrlKey && e.key === 'ArrowDown')
      ) {
        // TUI SwapDown binding: Shift+J (queue.rs); Ctrl+↓ also works.
        q.moveDown(sel)
        setQueueSel(Math.min(n - 1, sel + 1))
      } else if (
        (e.shiftKey && (e.key === 'K' || e.key === 'ArrowUp')) ||
        (e.ctrlKey && e.key === 'ArrowUp')
      ) {
        // TUI SwapUp binding: Shift+K (queue.rs); Ctrl+↑ also works.
        q.moveUp(sel)
        setQueueSel(Math.max(0, sel - 1))
      } else {
        handled = false
      }
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [queuePanelOpen, queueEditIndex, queueSel, queue.length])

  // TUI queue: auto-send the head when the turn ends (conn busy → ready
  // && awaitingNext). The `sending` mutex guards against Enter races.
  useEffect(() => {
    if (queueSending) return
    if (queue.length === 0) return
    const st = useChatStore.getState()
    if (st.conn === 'ready' && st.awaitingNext) {
      void sendQueuedHead()
    }
  }, [conn, awaitingNext, queue.length, queueSending])

  // Model picker: close on outside click / Escape; pin to viewport.
  useEffect(() => {
    if (!modelOpen) {
      setModelMenuPos(null)
      return
    }
    const place = () => {
      const btn = modelBtnRef.current
      if (!btn) return
      const r = btn.getBoundingClientRect()
      const pad = 8
      const gap = 6
      const vw = window.innerWidth
      const vh = window.innerHeight
      // Open upward from the button; clamp height to free space above.
      const bottom = Math.max(pad, vh - r.top + gap)
      const maxH = Math.max(120, Math.min(320, r.top - pad))
      const width = Math.min(288, vw - pad * 2)
      // Prefer right-align to the button, then shift so left/right stay in view.
      let left = r.right - width
      left = Math.max(pad, Math.min(left, vw - pad - width))
      const right = vw - left - width
      setModelMenuPos({ bottom, right, maxH, width })
    }
    place()
    const onDown = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) {
        setModelOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModelOpen(false)
    }
    window.addEventListener('resize', place)
    // Capture scroll from nested scroll parents (scrollback).
    window.addEventListener('scroll', place, true)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [modelOpen])

  const switchModel = (modelId: string, reasoningEffort?: string) => {
    setModelOpen(false)
    void setModel(modelId, reasoningEffort)
  }

  /** Match current caption effort against a menu row (id or wire value). */
  const effortActive = (opt: { id: string; value: string }) => {
    const cur = (reasoningEffort || '').trim().toLowerCase()
    if (!cur) return false
    return (
      cur === opt.value.toLowerCase() ||
      cur === opt.id.toLowerCase() ||
      cur === opt.value.replace(/_/g, '').toLowerCase()
    )
  }

  const modelActive = (m: { modelId: string; name?: string }) => {
    const cur = (modelName || '').trim().toLowerCase()
    if (!cur) return false
    return (
      cur === m.modelId.toLowerCase() ||
      (m.name != null && cur === m.name.trim().toLowerCase())
    )
  }
  const promptFocused = focused || focusMode === 'prompt'

  // ── TUI turn status line (turn_status.rs) ──
  // `⠧ Thinking…  1m20s ⇣12k [stop]` while busy; hidden when idle —
  // EXCEPT the idle watcher cue ("2 commands still running"): when a turn
  // is over but background work is live, the line shows the pulsing
  // monitor cue (persistent status, never a scrollback line — it must not
  // scroll away). "待处理" lives only on the history sidebar state icons —
  // not here. Braille spinner at ~7.5fps; the same cadence drives the
  // turn-timer re-renders and the monitor pulse (half speed).
  const idleCue = useMemo(() => stillRunningCue(entries, topTasks), [entries, topTasks])
  const idleCueVisible = !busy && conn === 'ready' && awaitingNext && idleCue != null
  const statusVisible =
    busy ||
    conn === 'connecting' ||
    conn === 'error' ||
    conn === 'offline' ||
    idleCueVisible
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  useEffect(() => {
    if (!statusVisible) return
    const t = window.setInterval(
      () => setSpinnerFrame((v) => (v + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    )
    return () => window.clearInterval(t)
  }, [statusVisible])
  // TUI MONITOR_PULSE_DIVISOR = 2 × SPINNER_DIVISOR: the idle cue's
  // `○ ◎ ◉ ◎` breath runs at half the active spinner's cadence.
  const pulseFrame =
    Math.floor(
      spinnerFrame / (MONITOR_PULSE_INTERVAL_MS / SPINNER_INTERVAL_MS),
    ) % MONITOR_PULSE_FRAMES.length

  // ── TUI mode-switch banner (notices.rs) — "Switched to mode: X" above
  // the prompt: full visibility for 2 s, then a 0.3 s fade-out. ──
  const [modeBannerVisible, setModeBannerVisible] = useState(false)
  useEffect(() => {
    if (!modeBanner) {
      setModeBannerVisible(false)
      return
    }
    setModeBannerVisible(true)
    const t1 = window.setTimeout(() => setModeBannerVisible(false), 2000)
    const t2 = window.setTimeout(() => clearModeBanner(), 2300)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [modeBanner, clearModeBanner])

  // Collapse unfocused prompt height (PromptViewConfig.collapse_unfocused)
  const collapsed = !promptFocused && !text

  // TUI max_prompt_height = area.height / 2 (agent_view/render.rs):
  // the prompt grows to fit every wrapped line, capped at half the
  // viewport; beyond that the textarea scrolls internally with the
  // cursor kept visible (scrollbar hidden via gn-no-scrollbar).
  const [maxPromptH, setMaxPromptH] = useState(() =>
    Math.max(20, Math.round(window.innerHeight / 2)),
  )
  useEffect(() => {
    const onResize = () =>
      setMaxPromptH(Math.max(20, Math.round(window.innerHeight / 2)))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    const max = collapsed ? 20 : maxPromptH
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
  }, [text, collapsed, maxPromptH])

  // TUI collapsed render forces scroll to top (set_scroll_override(Some(0))).
  useEffect(() => {
    const el = taRef.current
    if (!el || !collapsed) return
    el.scrollTop = 0
  }, [collapsed])

  // Restore the caret after a programmatic text edit (chip insert/expand).
  useEffect(() => {
    const el = taRef.current
    if (!el || caretRef.current == null) return
    el.selectionStart = el.selectionEnd = caretRef.current.pos
    setCaretPos(caretRef.current.pos)
    caretRef.current = null
  })

  // Keep focus in sync with store focusMode (Tab toggles)
  useEffect(() => {
    if (focusMode === 'prompt') {
      taRef.current?.focus()
    } else {
      taRef.current?.blur()
    }
  }, [focusMode])

  /** Inline a chip's stashed content at its label range (TUI expand_element).
   *  Image chips toggle their inline thumbnail instead — the label stays
   *  in the text and the image travels as a ContentBlock on submit. */
  const expandChipAt = (at: { chip: PasteChip; start: number; end: number }) => {
    if (at.chip.image) {
      setChips((cs) =>
        cs.map((c) =>
          c.id === at.chip.id ? { ...c, expanded: !c.expanded } : c,
        ),
      )
      return
    }
    setText((t) => t.slice(0, at.start) + at.chip.content + t.slice(at.end))
    setChips((cs) => cs.filter((c) => c.id !== at.chip.id))
    caretRef.current = { pos: at.start + at.chip.content.length }
  }

  /**
   * True when [start,end) touches a chip label without fully covering it —
   * an edit that would corrupt the label. A selection fully covering a chip
   * is fine: the whole element goes (TUI expands selections to element
   * boundaries, so partial selections are widened, never half-edited).
   */
  const partiallyOverlapsChip = (start: number, end: number) =>
    chips.some((c) => {
      let from = 0
      for (;;) {
        const i = text.indexOf(c.label, from)
        if (i === -1) return false
        const e2 = i + c.label.length
        if (start < e2 && end > i && !(start <= i && end >= e2)) return true
        from = e2
      }
    })

  /**
   * TUI handle_paste port: short pastes fall through to the native inline
   * insert; at/above the chip threshold the text is replaced by an atomic
   * `[Pasted: …]` label and the content is stashed until expand/submit.
   * Pasting a chip's exact content again with the cursor right after it
   * expands it instead of duplicating (repaste-to-expand).
   */
  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    // TUI image paste: clipboard items with image/* types (screenshots,
    // copied images) become `[Image: …]` chips. When images are present
    // they win over any coexisting text (browser copies often carry both).
    const imageFiles: File[] = []
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) imageFiles.push(f)
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault()
      const el = taRef.current
      void insertImageChips(imageFiles, el ? el.selectionStart : text.length)
      return
    }
    const raw = e.clipboardData.getData('text')
    if (!raw) return // empty / image paste → native no-op
    const cleaned = normalizeCr(raw)
    const el = taRef.current
    if (!el) return
    const start = el.selectionStart
    const end = el.selectionEnd
    if (start === end) {
      const at = chipOccurrenceAt(text, chips, start, 'end')
      if (at && cleaned === at.chip.content) {
        e.preventDefault()
        expandChipAt(at)
        return
      }
    }
    if (
      contentLines(cleaned) < CHIP_MIN_LINES &&
      utf8Len(cleaned) <= CHIP_DISPLAY_BYTES
    ) {
      return // short paste → native inline insert
    }
    e.preventDefault()
    const label = pasteChipLabel(cleaned)
    setText((t) => t.slice(0, start) + label + t.slice(end))
    setChips((cs) => [...cs, { id: chipId(), label, content: cleaned }])
    caretRef.current = { pos: start + label.length }
  }

  /**
   * Push the caret out of any chip interior (TUI: chips are atomic blocks,
   * the caret never renders inside them — it sits on the start or end edge).
   * Directional moves clamp toward the edge they came from; clicks clamp to
   * the nearest edge.
   */
  const clampCaret = (dir: 'start' | 'end' | 'nearest') => {
    const el = taRef.current
    if (!el || el.selectionStart !== el.selectionEnd) return
    const inside = chipOccurrenceAt(text, chips, el.selectionStart, 'inside')
    if (!inside) return
    const pos = el.selectionStart
    const target =
      dir === 'start'
        ? inside.start
        : dir === 'end'
          ? inside.end
          : pos - inside.start <= inside.end - pos
            ? inside.start
            : inside.end
    el.setSelectionRange(target, target)
    setCaretPos(target)
  }

  /**
   * Paste preview overlay (TUI render_preview_overlay + paste_preview_hint):
   * show the stashed content while the caret is on (start edge) or right
   * after (end edge) a chip, prompt focused. On-chip wins over adjacent.
   */
  const preview = useMemo(() => {
    if (!promptFocused || chips.length === 0) return null
    for (const chip of chips) {
      let from = 0
      for (;;) {
        const start = text.indexOf(chip.label, from)
        if (start === -1) break
        if (caretPos === start) return { chip, onChip: true }
        from = start + chip.label.length
      }
    }
    for (const chip of chips) {
      let from = 0
      for (;;) {
        const start = text.indexOf(chip.label, from)
        if (start === -1) break
        if (caretPos === start + chip.label.length) {
          return { chip, onChip: false }
        }
        from = start + chip.label.length
      }
    }
    return null
  }, [text, chips, caretPos, promptFocused])

  // Preview content: first/last 3 lines with a dots separator when longer
  // (PreviewConfig.preview_lines = 3).
  const previewLines = useMemo(() => {
    if (!preview) return null
    const lines = preview.chip.content.split('\n')
    if (lines.length <= 6) return lines
    return [
      ...lines.slice(0, 3),
      `⋮ (${lines.length - 6} more lines)`,
      ...lines.slice(-3),
    ]
  }, [preview])

  const borderColor = promptFocused
    ? 'var(--color-gn-prompt-border-active)'
    : 'var(--color-gn-prompt-border)'

  // Caption opacity: focused 0.6 / unfocused 0.4 of text_secondary (chrome_caption_style)
  const captionColor = promptFocused
    ? 'color-mix(in srgb, var(--color-gn-fg2) 60%, var(--color-gn-bg-base))'
    : 'color-mix(in srgb, var(--color-gn-fg2) 40%, var(--color-gn-bg-base))'
  const sepColor = promptFocused
    ? 'var(--color-gn-gray-dim)'
    : 'color-mix(in srgb, var(--color-gn-gray-dim) 60%, var(--color-gn-bg-base))'
  const flagColor = promptFocused
    ? 'var(--color-gn-gray)'
    : 'color-mix(in srgb, var(--color-gn-gray) 50%, var(--color-gn-bg-base))'

  // Prefix: accent_user when focused, gray_dim when not (PromptStyle::accent_color)
  const prefixColor = promptFocused
    ? 'var(--color-gn-accent-user)'
    : 'var(--color-gn-gray-dim)'

  const modelLabel = useMemo(() => {
    // Offline / error: surface connection state in the model slot
    if (conn === 'offline' || conn === 'error') return 'disconnected'
    if (conn === 'connecting') return 'connecting…'
    const base = (modelName && modelName.trim()) || 'grok'
    if (reasoningEffort) return `${base} (${reasoningEffort})`
    return base
  }, [conn, modelName, reasoningEffort])

  const flags = useMemo(() => {
    const out: { text: string; color?: string }[] = []
    // Host name lives in the top-left switcher (with conn status), not here.
    if (usage?.used != null && usage?.size != null) {
      out.push({ text: `${fmtTok(usage.used)}/${fmtTok(usage.size)}` })
    }
    // Plan mode (Shift+Tab cycle / toggle-plan-mode) — TUI prompt mode flag.
    const inPlan = planMode === true || permissionMode === 'plan'
    if (inPlan) {
      out.push({ text: 'plan', color: 'var(--color-gn-cyan)' })
    }
    // Permission mode from x.ai/yolo_mode_changed (TUI prompt mode flag:
    // ask / auto / always-approve). Only non-default modes are surfaced.
    const mode =
      permissionMode ||
      (yoloMode ? 'always-approve' : undefined) ||
      (autoMode ? 'auto' : undefined)
    if (mode && mode !== 'plan' && mode !== 'ask' && mode !== 'default') {
      out.push({ text: mode, color: 'var(--color-gn-cyan)' })
    }
    // /multiline input mode (TUI /multiline) — persistent prompt hint.
    // statusText is a dep so the /multiline command's status update
    // refreshes this flag.
    if (isMultilineEnabled()) {
      out.push({ text: 'multiline', color: 'var(--color-gn-cyan)' })
    }
    // busy / 待处理 live in the history sidebar state icons — not the prompt flags.
    if (conn === 'error' || conn === 'offline') {
      out.push({ text: statusText || 'offline', color: 'var(--color-gn-red)' })
    }
    return out
  }, [usage, conn, statusText, permissionMode, yoloMode, autoMode, planMode])

  return (
    <div className="safe-pb bg-gn-bg-base pt-1">
      <div className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS}`}>
        {/* ── TUI mode-switch banner (notices.rs) — above the prompt,
            full brightness 2 s, fade-out 0.3 s. ── */}
        {modeBanner && (
          <div
            className={`flex min-h-5 items-center gap-1.5 pb-2 pr-0.5 font-ui text-[13px] leading-[1.4] select-none transition-opacity duration-300 ${
              modeBannerVisible ? 'opacity-100' : 'opacity-0'
            }`}
            style={{ paddingLeft: COMPOSER_BODY_PAD_LEFT_PX }}
          >
            <span className="text-gn-cyan" aria-hidden>
              <IconGlyph glyph={Glyphs.diamondFilled} color="currentColor" />
            </span>
            <span className="truncate text-gn-fg2">{modeBanner}</span>
          </div>
        )}
        {/* ── TUI turn status line (turn_status.rs) ──
            Busy: `⠧ Thinking…  1m20s ⇣12k [stop]`. Idle with watchers:
            `○ 2 commands still running` — a persistent status, never a
            scrollback line. Hidden when truly idle. */}
        {statusVisible && (
          <div
            className="flex min-h-5 items-center gap-1.5 pb-2 pr-0.5 font-ui text-[13.5px] leading-[1.4] select-none"
            style={{ paddingLeft: COMPOSER_BODY_PAD_LEFT_PX }}
          >
            {idleCueVisible ? (
              // TUI idle watcher cue (turn_status.rs idle arm): pulsing
              // monitor icon + counts label. Click toggles the sticky
              // task bar (the TUI opens the tasks pane on click).
              <>
                <button
                  type="button"
                  onClick={() => setTasksBarOpen(!tasksBarOpen)}
                  className="group inline-flex min-w-0 items-center gap-1.5 text-left"
                  title="查看运行中的任务"
                >
                  {/* Icon slot on the scrollback icon track — same 15px
                      inset as the composer ❯, lining up with SVG icons. */}
                  <span className="inline-flex w-[1.25em] shrink-0 items-center justify-center leading-none text-gn-accent-system">
                    {MONITOR_PULSE_FRAMES[pulseFrame]}
                  </span>
                  <span className="truncate text-gn-gray group-hover:text-gn-fg">
                    {idleCue}
                  </span>
                </button>
                <span className="flex-1" />
              </>
            ) : (
              <>
                <span className="inline-flex w-[1.25em] shrink-0 items-center justify-center leading-none text-gn-muted">
                  {busy || conn === 'connecting' ? (
                    SPINNER_FRAMES[spinnerFrame]
                  ) : (
                    <span className="h-[7px] w-[7px] rounded-full bg-gn-red" />
                  )}
                </span>
                <span
                  className={`truncate ${
                    conn === 'error' || conn === 'offline'
                      ? 'text-gn-red'
                      : 'text-gn-muted'
                  }`}
                >
                  {statusText}
                </span>
                <span className="flex-1" />
                {busy && turnStartedAt != null && (
                  <span className="tabular-nums text-gn-gray">
                    {formatTurnDuration(Date.now() - turnStartedAt)}
                  </span>
                )}
                {busy && usage?.used != null && (
                  <span className="tabular-nums text-gn-gray">
                    ⇣{fmtTok(usage.used)}
                  </span>
                )}
                {busy && (
                  <button
                    type="button"
                    onClick={() => void useChatStore.getState().requestCancelTurn()}
                    className="rounded px-1.5 py-[2px] text-gn-gray hover:bg-gn-bg-highlight hover:text-gn-red min-h-6 sm:min-h-0"
                  >
                    [stop]
                  </button>
                )}
              </>
            )}
          </div>
        )}
        {/* TUI queue pill — visible while prompts are queued mid-turn.
            Click toggles the queue panel (delete items / send now). */}
        {queue.length > 0 && (
          <div className="mb-1.5" style={{ paddingLeft: COMPOSER_BODY_PAD_LEFT_PX }}>
            <button
              ref={queuePillRef}
              type="button"
              onClick={() => setQueuePanelOpen((v) => !v)}
              className="inline-flex min-h-6 items-center gap-1.5 rounded-full border border-gn-prompt-border bg-gn-bg-dark px-2.5 text-[11px] leading-none transition-colors hover:border-gn-prompt-border-active sm:min-h-0"
              title="点击查看发送队列"
            >
              <span className="text-gn-cyan">已排队 {queue.length} 条</span>
              <span className="text-gn-gray">·</span>
              <span className="text-gn-gray">Ctrl+Enter 立即发送</span>
            </button>
          </div>
        )}
        {/*
          PromptWidget chrome — rounded border box:
          - border + radius on the container (focus recolors via borderColor)
          - model · flags caption floats on the bottom border, right-aligned
        */}
        <div
          ref={composerChromeRef}
          className="relative rounded-[6px] border pt-[4px] pb-[4px] font-ui transition-colors"
          style={{ borderColor }}
          data-prompt-focused={promptFocused ? '1' : '0'}
          onMouseDown={(e) => {
            // Clicking chrome focuses the textarea (don't steal from buttons)
            if ((e.target as HTMLElement).closest('button, a')) return
            taRef.current?.focus()
          }}
        >
          {/* Queue panel — floats above the composer; per-item delete,
              [发送现在] drains the head immediately. */}
          {queuePanelOpen && queue.length > 0 && (
            <div
              ref={queuePanelRef}
              className="absolute bottom-full left-0 right-0 z-40 mb-1 overflow-hidden rounded border border-gn-prompt-border-active bg-gn-bg-dark shadow-2xl"
            >
              <div className="flex items-center justify-between border-b border-gn-prompt-border px-3 py-1.5">
                <span className="text-[11px] font-bold text-gn-fg2">
                  发送队列 ({queue.length})
                </span>
                <span className="text-[10px] text-gn-gray">
                  回合结束后自动发送队首
                </span>
              </div>
              <div className="gn-no-scrollbar max-h-40 overflow-y-auto">
                {queue.map((q, i) => {
                  const editing = queueEditIndex === i
                  const selected = queueSel === i
                  return (
                    <div
                      key={q.id}
                      onMouseEnter={() => setQueueSel(i)}
                      onMouseDown={() => setQueueSel(i)}
                      className={`group flex items-center gap-2 border-b border-gn-prompt-border/40 px-3 py-1.5 ${
                        selected && !editing ? 'bg-gn-bg-highlight/50' : ''
                      }`}
                    >
                      <span className="shrink-0 text-[10px] tabular-nums text-gn-gray">
                        {i + 1}
                      </span>
                      {editing ? (
                        // TUI queue_edit.rs: the row becomes a textarea —
                        // Enter saves, Esc cancels, Shift+Enter newlines.
                        <textarea
                          autoFocus
                          rows={1}
                          value={queueEditDraft}
                          onChange={(e) =>
                            usePromptQueue.getState().setEditDraft(e.target.value)
                          }
                          onKeyDown={(e) => {
                            if (e.nativeEvent.isComposing) return
                            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
                              e.preventDefault()
                              e.stopPropagation()
                              usePromptQueue.getState().saveEdit()
                            } else if (e.key === 'Escape') {
                              e.preventDefault()
                              e.stopPropagation()
                              usePromptQueue.getState().cancelEdit()
                            }
                            // Shift+Enter → native newline
                          }}
                          className="gn-no-scrollbar min-h-[20px] flex-1 resize-none bg-transparent font-ui text-[11.5px] leading-[1.5] text-gn-fg outline-none"
                          spellCheck={false}
                        />
                      ) : (
                        <span
                          className="min-w-0 flex-1 truncate text-[11.5px] text-gn-fg"
                          title={q.text}
                          onDoubleClick={() =>
                            usePromptQueue.getState().startEdit(i)
                          }
                        >
                          {q.text}
                        </span>
                      )}
                      {!editing && (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              usePromptQueue.getState().moveUp(i)
                              setQueueSel(Math.max(0, i - 1))
                            }}
                            className="shrink-0 rounded px-1 text-gn-gray opacity-0 transition-opacity group-hover:opacity-100 hover:bg-gn-bg-highlight hover:text-gn-fg"
                            title="上移 (Shift+K / Ctrl+↑)"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              usePromptQueue.getState().moveDown(i)
                              setQueueSel(Math.min(queue.length - 1, i + 1))
                            }}
                            className="shrink-0 rounded px-1 text-gn-gray opacity-0 transition-opacity group-hover:opacity-100 hover:bg-gn-bg-highlight hover:text-gn-fg"
                            title="下移 (Shift+J / Ctrl+↓)"
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            onClick={() => usePromptQueue.getState().startEdit(i)}
                            className="shrink-0 rounded px-1 text-gn-gray opacity-0 transition-opacity group-hover:opacity-100 hover:bg-gn-bg-highlight hover:text-gn-fg"
                            title="编辑 (e)"
                          >
                            e
                          </button>
                          <button
                            type="button"
                            onClick={() => usePromptQueue.getState().removeAt(q.id)}
                            className="shrink-0 rounded px-1 text-gn-gray opacity-0 transition-opacity group-hover:opacity-100 hover:bg-gn-bg-highlight hover:text-gn-red"
                            title="从队列删除 (x)"
                          >
                            {Glyphs.ballotX}
                          </button>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="flex items-center gap-2 border-t border-gn-prompt-border px-3 py-1.5">
                <button
                  type="button"
                  onClick={() => void sendQueuedHead()}
                  className="rounded bg-gn-bg-highlight px-2 py-[2px] text-[11px] text-gn-cyan transition-colors hover:bg-gn-bg-hover"
                  title="立即发送队首"
                >
                  发送现在
                </button>
                <button
                  type="button"
                  onClick={() => usePromptQueue.getState().clear()}
                  className="rounded px-2 py-[2px] text-[11px] text-gn-gray transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
                >
                  清空
                </button>
                <span className="flex-1" />
                <span className="text-[10px] text-gn-gray">
                  {queueEditIndex != null
                    ? 'Enter 保存 · Shift+Enter 换行 · Esc 取消'
                    : 'x 删除 · e 编辑 · ↑↓ 选择 · Shift+K/↑ 上移 · Shift+J/↓ 下移 · Esc 关闭'}
                </span>
              </div>
            </div>
          )}
          {/* Prompt history recall panel (TUI ↑ on empty input). */}
          {histOpen && history.length > 0 && (
            <div
              ref={histPanelRef}
              className="absolute bottom-full left-0 right-0 z-30 mb-1 overflow-hidden rounded border border-gn-prompt-border-active bg-gn-bg-dark shadow-2xl"
            >
              <div className="border-b border-gn-prompt-border px-3 py-1.5 text-[11px] font-bold text-gn-fg2">
                提示历史
              </div>
              <div className="gn-no-scrollbar max-h-48 overflow-y-auto">
                {history.map((h, i) => (
                  <button
                    key={`${h.ts}-${i}`}
                    type="button"
                    onClick={() => {
                      setText(h.text)
                      setHistOpen(false)
                      caretRef.current = { pos: h.text.length }
                      taRef.current?.focus()
                    }}
                    onMouseEnter={() => setHistSel(i)}
                    className={`block w-full truncate px-3 py-1 text-left text-[11.5px] transition-colors ${
                      i === histSel
                        ? 'bg-gn-bg-highlight text-gn-fg'
                        : 'text-gn-fg2'
                    }`}
                    title={`${h.text}\n${new Date(h.ts).toLocaleString()}`}
                  >
                    {h.text}
                  </button>
                ))}
              </div>
              <div className="border-t border-gn-prompt-border px-3 py-[3px] text-[10px] text-gn-muted">
                ↑/↓ 选择 · Enter 填入 · Esc 关闭
              </div>
            </div>
          )}
          {/* TUI slash command menu — floats above the composer while the
              input starts with "/" (fuzzy filter, ↑/↓ + Enter/Tab pick). */}
          {slashOpen && (
            <SlashMenu
              input={text}
              selected={slashSelClamped}
              matches={slashMatches}
              onHover={setSlashSel}
              onPick={(cmd) => void runSlashCommand(cmd, '')}
            />
          )}
          {/* Expanded image chips — inline thumbnails above the textarea
              (TUI Enter expands `[Image #N]` to the rendered image). */}
          {expandedImgs.length > 0 && (
            <div className="flex flex-wrap items-end gap-2 px-3 pb-1">
              {expandedImgs.map((c) => (
                <div key={c.id} className="group relative">
                  <img
                    src={`data:${c.image!.mimeType};base64,${c.image!.data}`}
                    alt={c.image!.name}
                    className="max-h-24 w-auto max-w-[160px] rounded border border-gn-prompt-border object-contain"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setChips((cs) =>
                        cs.map((x) =>
                          x.id === c.id ? { ...x, expanded: false } : x,
                        ),
                      )
                    }
                    className="absolute -right-1.5 -top-1.5 rounded-full bg-gn-bg-dark px-1 text-[9px] leading-[1.3] text-gn-gray opacity-0 transition-opacity group-hover:opacity-100 hover:text-gn-red"
                    title="折叠"
                  >
                    {Glyphs.ballotX}
                  </button>
                  <div
                    className="max-w-24 truncate text-[9.5px] leading-tight text-gn-muted"
                    title={c.image!.name}
                  >
                    {c.image!.name}
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* ── Body: ❯ textarea ──
              The prompt frame has a 1px border, so the body inset must be
              ICON_COL_INSET - 1 for the ❯ box to land exactly on the
              scrollback icon track (matches the turn-status spinner). */}
          <div
            className={`flex min-w-0 items-start gap-1.5 pr-3 ${
              collapsed ? 'py-0' : 'py-1'
            }`}
            style={{
              paddingLeft: COMPOSER_BODY_PAD_LEFT_PX - 1,
              // Unfocused dim (blend_area 0.66 toward bg) for content only
              opacity: promptFocused ? 1 : 0.72,
            }}
          >
              <span
                className="mt-[2px] shrink-0"
                style={{
                  color: shellMode
                    ? 'var(--color-gn-cyan)'
                    : prefixColor,
                }}
              >
                {shellMode ? (
                  // TUI shell prompt: `! ` prefix (cyan) — Enter sends the
                  // command to the agent as a prompt (`$ ` user row).
                  <span className="inline-flex w-[1.25em] items-center justify-center font-bold leading-none">
                    {'! '}
                  </span>
                ) : (
                  <IconGlyph glyph={Glyphs.promptArrow} color={prefixColor} />
                )}
              </span>
              <textarea
                id="composer-input"
                ref={taRef}
                rows={1}
                value={text}
                onChange={(e) => {
                  const v = e.target.value
                  // TUI shell mode: typing `!` into an empty buffer enters
                  // shell mode — the `!` lives in the prefix, not the buffer.
                  if (!shellMode && v === '!' && text === '') {
                    setShellMode(true)
                    setHistOpen(false)
                    return
                  }
                  setText(v)
                  // Typing closes the recall panel (TUI buffer edit).
                  if (histOpen) setHistOpen(false)
                  // Slash filter changed → selection back to the top row.
                  setSlashSel(0)
                  // Keep chips in sync with the editable label text.
                  setChips((cs) => pruneChips(v, cs))
                }}
                onFocus={() => {
                  setFocused(true)
                  useChatStore.getState().setFocus('prompt')
                }}
                onBlur={() => setFocused(false)}
                onKeyDown={(e) => {
                  // IME composition (Chinese pinyin etc.): Enter commits the
                  // candidate and Backspace edits the composition — hand
                  // composition keys through untouched or Enter would send
                  // mid-composition. isComposing only (spec flag, all modern
                  // browsers): keyCode 229 lingers on some Chromium builds
                  // after composition ends and would swallow plain Enter.
                  if (e.nativeEvent.isComposing) return
                  // TUI Shift+Tab (prompt focused): cycle mode
                  // Normal → Plan → Always-approve (store.cycleMode).
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
                  // TUI slash menu: Tab executes the highlighted command
                  // (swallows the global Tab focus-toggle).
                  if (e.key === 'Tab' && slashOpen && slashList.length > 0) {
                    e.preventDefault()
                    e.stopPropagation()
                    void runSlashCommand(slashList[slashSelClamped], '')
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
                      if (e.key === 'ArrowUp') {
                        setHistSel((s) => Math.min(s + 1, history.length - 1))
                      } else if (histSel === 0) {
                        // ↓ past the newest item closes the panel (TUI).
                        setHistOpen(false)
                      } else {
                        setHistSel((s) => Math.max(0, s - 1))
                      }
                      return
                    }
                    if (e.key === 'ArrowUp' && text === '' && !shellMode) {
                      if (history.length > 0) {
                        e.preventDefault()
                        setHistSel(0)
                        setHistOpen(true)
                      }
                      return
                    }
                    // Non-empty input (or ↓): fall through — plain caret
                    // movement + chip edge clamping below.
                  }
                  // TUI slash menu: ↑/↓ walk the filtered command list.
                  if (slashOpen) {
                    e.preventDefault()
                    if (e.key === 'ArrowUp') {
                      setSlashSel((s) => Math.max(0, s - 1))
                    } else {
                      setSlashSel((s) => Math.min(s + 1, slashList.length - 1))
                    }
                    return
                  }
                  if (histOpen) {
                    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
                      e.preventDefault()
                      const item = history[histSel]
                      if (item) {
                        setText(item.text)
                        setHistOpen(false)
                        caretRef.current = { pos: item.text.length }
                      }
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
                      caretRef.current = { pos: at.start }
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
                      // TUI slash commands: `/…` input executes locally and
                      // is NEVER sent to the agent.
                      if (!shellMode && text.trimStart().startsWith('/')) {
                        if (slashOpen && slashList.length > 0) {
                          // Menu is up: Enter picks the highlighted row.
                          void runSlashCommand(slashList[slashSelClamped], '')
                        } else {
                          // Menu closed (space/dismissed) or no match — the
                          // typed line goes through matchSlash; unknown →
                          // error row, input kept for editing.
                          void runSlashLine(text)
                        }
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
                    if (queuePanelOpen) {
                      e.preventDefault()
                      e.stopPropagation()
                      setQueuePanelOpen(false)
                      // Closing the panel discards any in-progress edit.
                      usePromptQueue.getState().cancelEdit()
                      return
                    }
                    // TUI: Esc in shell mode with an empty input exits.
                    if (shellMode && text === '') {
                      e.preventDefault()
                      setShellMode(false)
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
                }}
                onBeforeInput={(e) => {
                  // IME / drag-drop inserts into a chip label are swallowed.
                  const el = taRef.current
                  if (!el) return
                  if (partiallyOverlapsChip(el.selectionStart, el.selectionEnd)) {
                    e.preventDefault()
                  }
                }}
                onPaste={onPaste}
                onDragOver={(e) => {
                  // Allow the drop so the browser doesn't navigate to the
                  // file (image drop → chip below).
                  e.preventDefault()
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  const files = Array.from(e.dataTransfer.files).filter((f) =>
                    f.type.startsWith('image/'),
                  )
                  if (files.length === 0) {
                    // Non-image files: browsers cannot expose local paths
                    // (web limitation) — ignore rather than insert a
                    // broken reference. TUI takes a path here.
                    return
                  }
                  const t = taRef.current
                  void insertImageChips(files, t ? t.selectionStart : text.length)
                }}
                onSelect={() => {
                  // Mirror the live caret (selectionchange) for the preview.
                  const t = taRef.current
                  if (t) setCaretPos(t.selectionStart)
                }}
                onKeyUp={() => {
                  const t = taRef.current
                  if (t) setCaretPos(t.selectionStart)
                }}
                onMouseUp={() => {
                  // Click inside a chip label snaps to its nearest edge.
                  clampCaret('nearest')
                  const t = taRef.current
                  if (t) setCaretPos(t.selectionStart)
                }}
                onDoubleClick={(e) => {
                  // TUI: double-click expands a paste chip (from either position).
                  const t = taRef.current
                  if (!t) return
                  const at = chipOccurrenceAtCaret(text, chips, t.selectionStart)
                  if (at) {
                    e.preventDefault()
                    expandChipAt(at)
                  }
                }}
                title={
                  chips.length > 0
                    ? 'enter / double-click / paste-again on a chip to expand'
                    : undefined
                }
                placeholder={
                  shellMode
                    ? '发送命令给 agent（! 前缀）'
                    : promptFocused
                      ? ''
                      : 'Build anything'
                }
                spellCheck={false}
                className="gn-no-scrollbar min-h-[20px] flex-1 resize-none bg-transparent font-ui text-[13.5px] leading-[1.55] text-gn-fg outline-none placeholder:text-gn-gray"
              />
            </div>

          {/* Model + flags on the bottom border (断线), right-aligned.
              Model menu uses position:fixed (viewport-pinned) so it is not
              clipped by body overflow on mobile. Flags get their own truncate. */}
          <div
            className="pointer-events-none absolute -bottom-[5px] right-2 flex max-w-[75%] items-center gap-0 text-[11px] leading-none"
            style={{
              background: 'var(--color-gn-bg-base)',
            }}
            title={[modelLabel, ...flags.map((f) => f.text)].join(' · ')}
          >
            <span ref={modelRef} className="relative z-30 inline-flex shrink-0">
              <button
                ref={modelBtnRef}
                type="button"
                onClick={() => setModelOpen((v) => !v)}
                className="pointer-events-auto max-w-[220px] truncate rounded px-0.5 transition-colors hover:bg-gn-bg-highlight"
                style={{ color: captionColor }}
                title={`${modelLabel} · 点击切换模型`}
              >
                {modelLabel}
              </button>
              {modelOpen && models.length > 0 && modelMenuPos && (
                <div
                  className="pointer-events-auto fixed z-50 overflow-y-auto rounded border border-gn-prompt-border-active bg-gn-bg-base shadow-2xl"
                  style={{
                    bottom: modelMenuPos.bottom,
                    right: modelMenuPos.right,
                    maxHeight: modelMenuPos.maxH,
                    width: modelMenuPos.width,
                  }}
                >
                  <div className="sticky top-0 z-10 border-b border-gn-prompt-border bg-gn-bg-dark px-3 py-1.5 text-[11px] font-bold text-gn-fg2">
                    切换模型
                  </div>
                  {models.map((m) => {
                    const efforts = m.reasoningEfforts ?? []
                    const active = modelActive(m)
                    const defEffort =
                      efforts.find((e) => e.default) ?? efforts[0]
                    return (
                      <div
                        key={m.modelId}
                        className={`border-b border-gn-prompt-border/40 px-3 py-1.5 ${
                          active ? 'bg-gn-bg-highlight/60' : ''
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            switchModel(
                              m.modelId,
                              // Keep current effort when re-picking same model
                              // if still offered; else fall back to default.
                              active && reasoningEffort
                                ? efforts.find(
                                    (e) =>
                                      e.value === reasoningEffort ||
                                      e.id === reasoningEffort,
                                  )?.value ?? defEffort?.value
                                : defEffort?.value,
                            )
                          }
                          className="block w-full text-left hover:opacity-90"
                        >
                          <span
                            className={`text-[12px] font-medium ${
                              active ? 'text-gn-magenta' : 'text-gn-fg'
                            }`}
                          >
                            {m.name || m.modelId}
                          </span>
                          {m.agentType && (
                            <span className="ml-1.5 text-[10px] text-gn-muted">
                              {m.agentType}
                            </span>
                          )}
                          {m.description && (
                            <div className="mt-0.5 text-[10px] leading-[1.4] text-gn-muted">
                              {m.description}
                            </div>
                          )}
                        </button>
                        {efforts.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {efforts.map((e) => {
                              const on = active && effortActive(e)
                              return (
                                <button
                                  key={e.id || e.value}
                                  type="button"
                                  onClick={() =>
                                    switchModel(m.modelId, e.value)
                                  }
                                  title={
                                    e.label !== e.value
                                      ? `${e.label} (${e.value})`
                                      : e.value
                                  }
                                  className={`rounded border px-1.5 py-[2px] text-[10px] leading-none transition-colors ${
                                    on
                                      ? 'border-gn-prompt-border-active bg-gn-bg-hover text-gn-magenta'
                                      : 'border-gn-prompt-border text-gn-muted hover:border-gn-prompt-border-active hover:bg-gn-bg-highlight hover:text-gn-fg'
                                  }`}
                                >
                                  {e.label || e.value}
                                </button>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </span>
            <span className="flex min-w-0 items-center truncate">
              {flags.map((f, i) => (
                <span key={i} className="inline-flex items-center">
                  <span style={{ color: sepColor }} className="px-1">
                    {Glyphs.middleDot}
                  </span>
                  <span
                    className="truncate"
                    style={{ color: f.color || flagColor }}
                  >
                    {f.text}
                  </span>
                </span>
              ))}
            </span>
          </div>

          {/* Paste preview overlay (TUI render_preview_overlay) — floats
              above the prompt frame while the caret is on/after a chip:
              text chips show first/last 3 lines with a ⋮ separator; image
              chips show the thumbnail + name + size, hint in the footer. */}
          {preview &&
            (preview.chip.image ? (
              <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 w-[75%] -translate-x-1/2 overflow-hidden rounded border border-gn-prompt-border-active bg-gn-bg-dark shadow-2xl">
                <div className="flex flex-col items-center gap-1 px-2 py-2">
                  <img
                    src={`data:${preview.chip.image.mimeType};base64,${preview.chip.image.data}`}
                    alt={preview.chip.image.name}
                    className="max-h-32 w-auto max-w-full rounded border border-gn-prompt-border object-contain"
                  />
                  <div className="max-w-full truncate text-[10.5px] text-gn-fg2">
                    {preview.chip.image.name} · {fmtBytes(preview.chip.image.size)}
                  </div>
                </div>
                <div className="border-t border-gn-prompt-border/60 px-2 py-[3px] text-[10px] text-gn-muted">
                  {preview.onChip ? 'enter' : 'double-click'} to expand
                </div>
              </div>
            ) : (
              previewLines && (
                <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 w-[75%] -translate-x-1/2 overflow-hidden rounded border border-gn-prompt-border-active bg-gn-bg-dark shadow-2xl">
                  <div className="gn-no-scrollbar max-h-44 overflow-y-auto py-0.5">
                    {previewLines.map((line, i) => (
                      <div
                        key={i}
                        className={`truncate px-2 font-mono text-[11.5px] leading-[1.5] ${
                          line.startsWith('⋮ (')
                            ? 'text-gn-gray-dim'
                            : 'text-gn-fg'
                        }`}
                      >
                        {line || ' '}
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-gn-prompt-border/60 px-2 py-[3px] text-[10px] text-gn-muted">
                    {preview.onChip ? 'enter' : 'paste again'} or double-click to
                    expand
                  </div>
                </div>
              )
            ))}
        </div>

      </div>
    </div>
  )
}
