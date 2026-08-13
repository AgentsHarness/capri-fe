import { loadJSON, saveJSON } from '../lib/storage'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
} from 'react'
import { useChatStore, formatTurnDuration, stillRunningCue } from '../store/chat'
import { pushToast } from '../store/toast'
import { usePromptQueue } from '../store/promptQueue'
import { transport } from '../api/localTransport'
import type { ContentBlock, ScrollEntry } from '../api/types'
import {
  Glyphs,
  MONITOR_PULSE_FRAMES,
  MONITOR_PULSE_INTERVAL_MS,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  toolHeader,
} from '../theme/glyphs'
import {
  COMPOSER_BODY_PAD_LEFT_PX,
  CONTENT_COLUMN_CLASS,
  COLUMN_PAD_X_CLASS,
} from '../theme/layout'
import { IconGlyph } from './IconGlyph'
import { fmtTok } from '../format'
import { Accents } from '../theme/accents'
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

/** TUI MAX_ACTIVITY_SUBJECT_CHARS — wait/tool subject clamp in the status line. */
const MAX_ACTIVITY_SUBJECT_CHARS = 40

/**
 * Current activity of a busy turn — TUI turn_status.rs activity arm.
 * Priority mirrors the TUI tracker: blocking waits (WaitingReason) first,
 * then thinking, tools, streaming reply.
 *
 * - WaitingReason::Subagent   → "Waiting on subagent…"  (foreground subagent)
 * - WaitingReason::TaskOutput → "Waiting on <subject>…" / "Waiting on task output…"
 * - WaitingReason::TasksComplete → "Waiting on tasks…"  (multiple awaited tasks)
 * - WaitingReason::Sleep      → "Sleeping…"             (Await / Sleep tools)
 */
function currentActivity(
  entries: ScrollEntry[],
): { label: string; color: string; startedAt?: number } | null {
  // 1) Blocked on a foreground subagent (TUI tracker registers these when
  //    the task tool is NOT backgrounded). Only reachable while the agent
  //    itself is idle — thinking/tool/reply branches take precedence later.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'subagent' && e.running) {
      return {
        label: 'Waiting on subagent…',
        color: Accents.gray,
        startedAt: e.startedAt,
      }
    }
  }
  // 2) Awaiting background task output(s) (get_command_or_subagent_output /
  //    wait_commands_or_subagents…). One task → subject named (description /
  //    command, clamped like TUI MAX_ACTIVITY_SUBJECT_CHARS=40); several →
  //    "Waiting on tasks…".
  const runningTasks = entries.filter(
    (e): e is Extract<ScrollEntry, { kind: 'bg_task' }> =>
      e.kind === 'bg_task' && e.running === true,
  )
  if (runningTasks.length === 1) {
    const subject = (runningTasks[0].command || runningTasks[0].title || '')
      .trim()
      .slice(0, MAX_ACTIVITY_SUBJECT_CHARS)
    return {
      label: subject
        ? `Waiting on ${subject}…`
        : 'Waiting on task output…',
      color: Accents.gray,
    }
  }
  if (runningTasks.length > 1) {
    return { label: 'Waiting on tasks…', color: Accents.gray }
  }
  // 3) Explicit sleep (TUI blocking_wait_reason: Await / AwaitShell /
  //    "Await:…" / "Sleep …").
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'tool' && (e.status === 'pending' || e.status === 'in_progress')) {
      const title = (e.title || '').trim()
      if (
        title === 'Await' ||
        title === 'AwaitShell' ||
        title.startsWith('Await:') ||
        title.startsWith('Sleep ')
      ) {
        return {
          label: 'Sleeping…',
          color: Accents.gray,
          startedAt: e.startedAt,
        }
      }
      break // newest running tool only
    }
  }
  // 4) Thinking / tool / streaming reply (newest running entry wins).
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'thought' && e.streaming) {
      // TUI turn_status.rs: "Thinking…" (text_secondary).
      return { label: 'Thinking…', color: Accents.thinkingDefault, startedAt: e.startedAt }
    }
    if (e.kind === 'tool' && (e.status === 'pending' || e.status === 'in_progress')) {
      const verb = toolHeader(e.kindName, false).verb
      const target = (e.title || e.kindName || '').trim()
      // TUI turn_status.rs tool style: ask tools ("Ask: …") and tools
      // with a human description render muted (text_secondary); plain
      // invocations keep the green accent.
      const title = (e.title || '').trim()
      const isAsk = title.startsWith('Ask: ') || title.startsWith('Ask ')
      const raw = e.raw
      const rawInput =
        raw && typeof raw === 'object'
          ? ((raw as { rawInput?: unknown }).rawInput ??
            (raw as { raw_input?: unknown }).raw_input)
          : undefined
      const desc =
        rawInput && typeof rawInput === 'object'
          ? (rawInput as Record<string, unknown>).description
          : undefined
      const hasDesc = typeof desc === 'string' && desc.trim() !== ''
      return {
        label: `${verb} ${target}`.trim(),
        color: isAsk || hasDesc ? Accents.gray : Accents.success,
        // The tool's own start stamp (stamped on live running tools) —
        // the phase timer counts this entry's duration, not the whole
        // turn up to now.
        startedAt: e.startedAt,
      }
    }
    // Streaming reply: the assistant row's `ts` is its response start
    // (first chunk), so the phase timer is the reply's own duration —
    // not the whole turn. TUI: current_agent_msg → "Responding…".
    if (e.kind === 'assistant' && e.streaming) {
      return { label: 'Responding…', color: Accents.gray, startedAt: e.ts }
    }
  }
  return null
}

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

type HistoryItem = { text: string; ts: number; shell?: boolean }

function loadPromptHistory(): HistoryItem[] {
  const arr = loadJSON<unknown>(HISTORY_KEY, [])
  if (!Array.isArray(arr)) return []
  const out: HistoryItem[] = []
  for (const x of arr) {
    if (x && typeof x.text === 'string' && x.text.trim()) {
      out.push({
        text: x.text,
        ts: typeof x.ts === 'number' ? x.ts : Date.now(),
        shell: x.shell === true,
      })
      if (out.length >= HISTORY_MAX) break
    }
  }
  return out
}

function savePromptHistory(items: HistoryItem[]): void {
  saveJSON(HISTORY_KEY, items.slice(0, HISTORY_MAX))
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
  // Pending caret position to restore after a programmatic text edit —
  // state (not a ref) so the restore effect runs on the post-edit render.
  const [pendingCaret, setPendingCaret] = useState<number | null>(null)
  // Live caret position — textarea selection changes don't re-render, so
  // onSelect/keyup/mouseup mirror it here for the paste preview overlay.
  const [caretPos, setCaretPos] = useState(0)
  const send = useChatStore((s) => s.send)
  const conn = useChatStore((s) => s.conn)
  // 会话切换加载中：turn status 整行显示「回放中…」，加载完毕再按
  // 真实状态渲染（busy 臂 / 已切换文案，见 Scrollback 的加载覆盖层）。
  // historyLoading 覆盖 loadHistory 全程 + 宽限窗口，直至新会话数据
  // 就绪——目标会话 busy/ready 由 host 的 /api/sessions roster 提前
  // 可知（refreshSessions），回放期间状态行保持可见。
  const historyLoading = useChatStore((s) => s.historyLoading)
  const usage = useChatStore((s) => s.usage)
  const genRate = useChatStore((s) => s.genRate)
  const statusText = useChatStore((s) => s.statusText)
  /** /recap 等待指示：仅当发起会话仍是当前活动会话时显示（切换会话
   *  不残留——recapPendingFor 绑定发起会话 id）。 */
  const recapPending = useChatStore(
    (s) => s.recapPendingFor != null && s.recapPendingFor === s.sessionId,
  )
  const modeBanner = useChatStore((s) => s.modeBanner)
  const clearModeBanner = useChatStore((s) => s.clearModeBanner)
  const awaitingNext = useChatStore((s) => s.awaitingNext)
  /** TUI FollowUps state — turn-end suggestion chips (x.ai/follow_ups). */
  const followUps = useChatStore((s) => s.followUps)
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
  // 模型菜单「设为默认」勾选：切换模型时同时写入 config.toml 默认。
  const [setAsDefault, setSetAsDefault] = useState(false)
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

  // ── Scrollbar gutter alignment ────────────────────────────────────
  // The scrollback box reserves its scrollbar gutter via
  // scrollbar-gutter: stable so its centered column never jumps when the
  // scrollbar appears. The composer must reserve the SAME width on its
  // right side or its prompt column sits ~5px off the transcript column.
  // scrollbar-gutter only takes effect on scroll containers, and the
  // composer wrapper must NOT be one — overflow-y:auto there clipped the
  // floating slash menu / queue panel / portaled question card (their
  // tops extend far above the wrapper's padding box). So measure the
  // gutter with a hidden probe and reserve it as padding-right instead.
  const [gutterPx, setGutterPx] = useState(0)
  useEffect(() => {
    const measure = () => {
      const probe = document.createElement('div')
      probe.style.cssText =
        'position:fixed;visibility:hidden;top:0;left:0;width:100px;height:50px;overflow-y:auto;scrollbar-gutter:stable'
      document.body.appendChild(probe)
      const w = probe.clientWidth
      probe.remove()
      setGutterPx(100 - w)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // ── TUI rewind prompt stash (views/rewind.rs StashedPrompt) ──
  // While the /rewind picker is open the draft is parked in the store
  // (stashedDraft) and restored when it closes — a rewind reloads the
  // session history and must not eat the user's in-progress text.
  const rewindOpen = useChatStore((s) => s.rewindOpen)

  // ── TUI prompt history recall (↑ on empty input) ──
  const [history, setHistory] = useState<HistoryItem[]>(loadPromptHistory)
  const [histOpen, setHistOpen] = useState(false)
  // Panel list is newest-first; sel 0 = newest. ↑ walks older (TUI).
  const [histSel, setHistSel] = useState(0)
  const histPanelRef = useRef<HTMLDivElement>(null)

  // ── TUI mid-turn send queue (Enter during a turn → queued) ──
  const queue = usePromptQueue((s) => s.queue)
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

  const pushHistory = (sentText: string, isShell = false) => {
    const t = sentText.trim()
    if (!t) return
    setHistory((prev) => {
      if (prev[0]?.text === t && prev[0]?.shell === isShell) return prev // same as latest → skip
      const next = [{ text: t, ts: Date.now(), shell: isShell }, ...prev].slice(0, HISTORY_MAX)
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
    setPendingCaret(pos + joined.length)
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
   * TUI ↑ history recall: fill the buffer with the recalled prompt.
   * Recalled `!` shell commands RE-ENTER shell mode (docs: "Recalled !
   * shell commands re-enter shell mode") — the `!` lives in the prefix,
   * the buffer holds only the command.
   */
  const recallHistory = (item: HistoryItem) => {
    setText(item.text)
    setShellMode(item.shell === true)
    setHistOpen(false)
    setPendingCaret(item.text.length)
    taRef.current?.focus()
  }

  /**
   * TUI follow-up chip click (mouse.rs → Action::SubmitFollowUp →
   * dispatch_send_prompt_inner literal=true): the suggestion is sent
   * IMMEDIATELY as a literal model prompt — no busy gating (the TUI does
   * not intercept mid-turn either). send() retires the chips (turn
   * start), so the row disappears as the new turn begins.
   */
  const sendFollowUp = (label: string) => {
    void useChatStore.getState().send(label)
  }

  /**
   * TUI double-Enter / [发送现在]: drain the queue head immediately.
   * Server-authoritative semantics (TUI 对齐):
   * - 队首行已确认（有 version，来自 queue_changed 广播）→
   *   x.ai/queue/interject {id, expectedVersion}：agent 版本校验后把该行
   *   提升为下一个运行（send_now=true，插到 front），不取消当前回合
   *   （已知行 send_now_cancels_running_turn=false）。行保留在本地镜像
   *   （广播是校正通道）；版本不符/未知 id → agent no-op 并重广播，
   *   行原样保留。收养广播（running_prompt_id）到达时移除并渲染用户行。
   * - 队首行非降级（乐观回显 / 已确认但广播无 version）→ agent-owned：
   *   agent 已在跑/已排队，FE 绝不 cancel-then-send（那会
   *   把同一条消息再发一遍），等收养广播即可（TUI
   *   send_now_awaiting_confirm 语义）。
   * - 队首行是 RPC 失败降级（degraded，无 version，agent 从没见过）→
   *   保留 cancel-then-send 兜底：取消运行中回合（后台任务继续），再
   *   发送队首。降级行重发时带同一 promptId 保持身份。
   * `sending` 是互斥锁，与 Enter 竞态共享；锁只覆盖
   * cancel→dequeue→send-start 窗口：send() 同步置 conn=busy 后立即释放，
   * 否则整回合（send 在回合完成时才 resolve）期间 onSubmit 的 sending
   * 守卫会把 Enter 静默吞掉。
   */
  const sendQueuedHead = async () => {
    const q = usePromptQueue.getState()
    if (q.sending) return
    // Stale-queue guard: the queue is tagged with the session it was
    // queued in. If that session is no longer active (a sessionId change
    // path missed the tracking subscription, or the host switched
    // sessions), NEVER deliver it here — swap to the active session's
    // queue instead (the stray queue stays stashed under its own id).
    const activeSession = useChatStore.getState().sessionId ?? ''
    if (q.sessionId != null && q.sessionId !== activeSession) {
      q.switchSession(activeSession || undefined)
      return
    }
    const head = q.queue[0]
    if (!head) return
    q.setSending(true)
    try {
      if (head.version != null) {
        // 已确认行 → send-now via interject（agent 提升，不取消回合）。
        // 错误忽略：广播是校正通道，行保留在镜像，显示可能短暂陈旧。
        try {
          await transport.queueInterject(
            { id: head.id, expectedVersion: head.version },
            activeSession,
          )
        } catch {
          /* fire-and-forget 语义：agent no-op 或传输失败都靠重广播校正 */
        }
        return
      }
      if (!head.degraded) {
        // 非降级行都是 agent-owned：
        // - 乐观回显（prompt RPC 已发出且被接受）：agent 正在跑或已排进
        //   权威队列，收养广播（running_prompt_id）会移除镜像行并渲染
        //   用户行；
        // - 已确认但广播没带 version 的旧行：同样在 agent 权威队列里，
        //   回合结束由 agent 自动 pop。
        // FE 若在此 cancel-then-send 会把同一条消息再发一遍——agent 先
        // 跑完在飞的那条、再跑这条，视觉上就是「第一条消息被当作
        // queued 再次发送」。这里只等广播/收养（TUI
        // send_now_awaiting_confirm 语义）。
        return
      }
      // RPC 失败降级行（FE-owned，agent 从没见过）→ cancel-then-send
      // 兜底：取消运行中回合（后台任务继续），然后发送队首作为下一回合。
      if (useChatStore.getState().conn === 'busy') {
        await useChatStore.getState().cancel()
        // Let the cancelled SSE land first so it can't clobber the new
        // turn's busy state (bounded wait; no-op when already idle).
        for (
          let i = 0;
          i < 50 && useChatStore.getState().conn === 'busy';
          i++
        ) {
          await new Promise((r) => setTimeout(r, 10))
        }
      }
      // 取消等待窗口内收养广播可能已把当初按下的队首移除（乐观行被
      // agent 收养、新回合已开始）——队首已不是该行时放弃手动发送，
      // 交给广播收养流程，绝不把别的行误发出去。
      if (usePromptQueue.getState().queue[0]?.id !== head.id) return
      const popped = q.dequeue()
      if (!popped) return
      try {
        const sendPromise = useChatStore.getState().send(popped.text, popped.blocks, {
          // 降级行重发保持同一 promptId（agent queue_meta 身份一致）。
          promptId: popped.degraded ? popped.id : undefined,
        })
        // 竞态窗口已过：send() 同步置 conn=busy——立即释放锁（见函数头
        // 注释）。
        q.setSending(false)
        await sendPromise
        if (useChatStore.getState().conn !== 'error') pushHistory(popped.text)
      } catch {
        // 发送被拒（host 409「上一条消息还在处理中」——cancel 尚未落到
        // host 侧 / 传输失败）：队首已出队，必须放回当前会话队首，否则
        // 该条永久丢失。错误已由 send() 渲染成 scrollback 行，不重复
        // 处理。
        const active = useChatStore.getState().sessionId
        if (active) usePromptQueue.getState().requeueFront(active, popped)
      } finally {
        q.setSending(false)
      }
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
   * TUI `!` mode: run the command DIRECTLY in a piped terminal and render
   * `$ cmd` + the raw output locally — NOT sent to the agent as a prompt
   * (the TUI executes the shell command itself and streams its result).
   * Exits shell mode back to plain input.
   */
  const submitShell = async (cmd: string) => {
    setText('')
    setShellMode(false)
    setChips([])
    const st = useChatStore.getState()
    try {
      const { terminalId } = await transport.terminalCreate({
        command: cmd,
        cwd: st.cwd || undefined,
      })
      // Block until the process exits so we can show the final output.
      await transport.terminalWaitForExit(terminalId)
      const out = await transport.terminalOutput(terminalId)
      // `$ cmd` row, then the raw output below it (rendered with ANSI color
      // via the shared <Ansi> component — not stripped).
      st.appendLocalEntry({ kind: 'user', text: cmd, isShell: true })
      const output = out.output ?? ''
      if (output.trim()) st.appendLocalEntry({ kind: 'session_event', text: output, ansi: true })
      const code = out.exitStatus?.exitCode
      if (code != null && code !== 0) {
        st.appendLocalEntry({ kind: 'session_event', text: `exit ${code}` })
      }
      await transport.terminalRelease(terminalId).catch(() => {})
    } catch (e) {
      st.appendLocalEntry({
        kind: 'error',
        text: `命令执行失败: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
    // Record history only when the host accepted the command — shell
    // submissions are tagged so recalling them re-enters shell mode.
    if (useChatStore.getState().conn !== 'error') pushHistory(cmd, true)
    taRef.current?.focus()
  }

  /**
   * TUI queue semantics: Enter during a turn queues; empty Enter sends head.
   *
   * ── 补全入口（预留）──────────────────────────────────────────────
   * transport.suggest() / transport.suggestPrompt()（x.ai/suggest /
   * x.ai/suggestPrompt）已就绪。将来在此处挂补全候选 UI：输入暂停后调
   * suggest({text, cwd, cursor, limit, generation, includeAi, aiModel,
   * tokenOnly}) 取候选行渲染在输入框下方（generation 由 suggestPrompt
   * 递增轮换），当前不做完整补全 UI — Composer 保持纯手输。
   */
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
      // TUI: Enter during a running turn → server-authoritative enqueue：
      // 立即 fire-and-forget 发 prompt RPC（`_meta.promptId`，agent 把它
      // 插进权威队列），本地插乐观回显行；RPC 失败（含竞态 409）→
      // 行保留 degraded（手动重发）+ 渲染错误行。
      const { expandedText, blocks } = buildBlocks(text, chips)
      setText('')
      setChips([])
      // Tag the queue with the active session so drains stay session-scoped.
      // 失败不滚 scrollback 错误行：行标记 degraded 后由队列面板的红色
      // 徽标提示（失败原因作 tooltip），主回合输出不被打断。
      q.enqueue({ text: expandedText, blocks }, st.sessionId ?? '')
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
  // Agent-advertised commands (ACP available_commands_update) feed the
  // menu — subscribed here so the list refreshes when they arrive.
  const agentCommands = useChatStore((s) => s.agentCommands)
  const slashMatches = useMemo(
    () => (slashOpen ? filterSlashCommands(text, agentCommands) : []),
    [slashOpen, text, agentCommands],
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
  }, [histOpen, queuePanelOpen, queueEditIndex, setQueuePanelOpen])

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

  // TUI queue: server-authoritative drain — the AGENT pops the queue head
  // at turn end (auto-drain) and broadcasts running_prompt_id for
  // adoption; the FE never auto-sends queue rows (legacy 409 auto-retry
  // removed). Agent-owned rows (optimistic in-flight / confirmed) are
  // adopted via the broadcast; FE-owned degraded rows (RPC 失败保留) are
  // sent MANUALLY via 双 Enter / [发送现在] (sendQueuedHead). The
  // `sending` mutex guards against Enter races.

  // TUI rewind draft custody: the /rewind picker stashes the prompt while
  // open and restores it on close. The store value doubles as the guard —
  // a remount mid-stash can't clobber the parked draft, and an empty
  // buffer stashes as '' (restored as a no-op).
  useEffect(() => {
    const st = useChatStore.getState()
    if (rewindOpen) {
      if (st.stashedDraft != null) return
      st.setStashedDraft(text)
      setText('')
    } else {
      const t = st.stashedDraft
      if (t == null) return
      st.setStashedDraft(null)
      setText(t)
    }
    // text intentionally excluded: the buffer is only moved at open/close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rewindOpen])

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
    // 「设为默认」勾选时：写入 config.toml 的 [models] default（+effort），
    // 与切换动作一起生效（agent 热加载，TUI /model <name> <effort> 语义）。
    if (setAsDefault) {
      void transport
        .setDefaultModel(modelId, reasoningEffort, useChatStore.getState().sessionId)
        .then(() => pushToast(`已设为默认模型`))
        .catch((e) => pushToast(`设为默认失败: ${e instanceof Error ? e.message : String(e)}`))
    }
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
  // Busy arm: dynamic activity label (newest running tool / thinking /
  // streaming reply) with its phase timer — TUI turn_status.rs activity
  // arm. Falls back to the static statusText when nothing is running.
  // Phase timer anchors: the activity's own start stamp when it has one
  // (thought / tool / subagent / streaming reply); stamp-less phases
  // (bg-task waits, no-activity "Waiting for response…" windows) anchor
  // at the moment the phase became current — so a mid-turn wait counts
  // from when the last entry ended, not from the turn start.
  const activity = useMemo(() => currentActivity(entries), [entries])
  // Phase identity for anchor tracking: activity label (+ entry stamp)
  // while something runs, else the status text of the wait window. When
  // it changes (a new entry arrived / a new wait began), the anchor is
  // reset so the timer starts counting the new phase from zero.
  const phaseKey =
    activity != null
      ? `a:${activity.label}:${activity.startedAt ?? ''}`
      : busy
        ? `w:${statusText}`
        : recapPending
          ? 'r:recap'
          : ''
  const lastPhaseKey = useRef('')
  const phaseAnchor = useRef<number | undefined>(undefined)
  if (phaseKey !== lastPhaseKey.current) {
    lastPhaseKey.current = phaseKey
    phaseAnchor.current = phaseKey !== '' ? Date.now() : undefined
  }
  const phaseStart =
    activity?.startedAt ??
    (busy || recapPending ? (phaseAnchor.current ?? turnStartedAt) : undefined)
  // [↓] send-to-background (TUI DemoteToBackground): shown while a
  // running execute tool exists — demotes that command to a background
  // task via x.ai/terminal/background (the agent then reports it through
  // task_backgrounded and the bg_task machinery takes over).
  const runningExecute = useMemo(() => {
    if (!busy) return null
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (
        e.kind === 'tool' &&
        (e.status === 'pending' || e.status === 'in_progress') &&
        e.kindName === 'execute' &&
        e.toolCallId
      ) {
        return e
      }
    }
    return null
  }, [busy, entries])
  // 会话切换加载中（historyLoading）状态行固定显示「回放中…」而不是
  // 旧会话的 busy/状态（避免加载期间显示误导性的活动标签）：见下方
  // 状态行渲染。statusVisible 只决定「加载结束后」该不该显示——加载
  // 期间内容就是回放臂，加载完毕立即切换真实状态。
  const statusVisible =
    !historyLoading &&
    (busy ||
      conn === 'connecting' ||
      conn === 'error' ||
      conn === 'offline' ||
      recapPending ||
      idleCueVisible)
  // 生成速度（状态行总时间右侧）：host 推送的 gen_rate（估算 tok/s），
  // 流式期间实时更新，工具阶段/回合结束冻结终值。
  const genRateLabel =
    genRate != null && genRate > 0 ? Math.round(genRate) : undefined
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  // 回放中（historyLoading）也要转 spinner：会话切换加载期间状态行
  // 显示「回放中…」，与 busy 臂共用同一旋转动画。
  useEffect(() => {
    if (!statusVisible && !historyLoading) return
    const t = window.setInterval(
      () => setSpinnerFrame((v) => (v + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    )
    return () => window.clearInterval(t)
  }, [statusVisible, historyLoading])
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

  // 固定高度：composer 始终保持在编辑状态的单行高度，不再随焦点/内容
  // 动态伸缩（移除 TUI PromptViewConfig.collapse_unfocused 折叠与
  // max_prompt_height 半视口增长）——多行内容在输入框内部滚动
  // （gn-no-scrollbar 隐藏滚动条，光标由原生 textarea 保持可见）。
  // 此前的高度 effect（collapsed ? 20px : min(scrollHeight, 视口/2)）
  // 已整体移除。

  // Restore the caret after a programmatic text edit (chip insert/expand).
  // Runs once per pending request (deps on pendingCaret) — the request is
  // set in the same batch as the text edit, so the textarea is up to date.
  useEffect(() => {
    const el = taRef.current
    if (!el || pendingCaret == null) return
    el.selectionStart = el.selectionEnd = pendingCaret
    setCaretPos(pendingCaret)
    setPendingCaret(null)
  }, [pendingCaret])

  // Keep focus in sync with store focusMode (Tab toggles) — but skip the
  // initial mount so a page refresh doesn't steal focus into the composer.
  const focusInitRef = useRef(true)
  useEffect(() => {
    if (focusInitRef.current) {
      focusInitRef.current = false
      return
    }
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
    setPendingCaret(at.start + at.chip.content.length)
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
    setPendingCaret(start + label.length)
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
    // Plan mode (Shift+Tab cycle / /plan) — TUI prompt mode flag. The
    // plan·auto / plan·always overlays (/auto & /always while in plan)
    // render as compound chips, like the TUI's stacked mode flags.
    const inPlan = planMode === true || permissionMode === 'plan'
    // Permission mode (TUI prompt flag: ask / auto / always-approve).
    // Store already overlays config.toml `[ui] permission_mode` when the
    // host hello is still the spawn default `ask` — so a settings default
    // of always-approve shows here. Only non-ask modes are surfaced.
    // A stale default permissionMode ('ask'/'default') must NOT shadow the
    // optimistic local yoloMode/autoMode flags set by /auto & friends.
    const permMode =
      permissionMode && !['ask', 'default', 'plan'].includes(permissionMode)
        ? permissionMode
        : yoloMode
          ? 'always-approve'
          : autoMode
            ? 'auto'
            : undefined
    // Wire spelling variants (always_approve / yolo) render as the single
    // canonical display name 'always-approve'.
    const permChip =
      permMode === 'always-approve' || permMode === 'always_approve' || permMode === 'yolo'
        ? 'always-approve'
        : permMode
    if (inPlan && permChip) {
      out.push({ text: `plan·${permChip}`, color: 'var(--color-gn-cyan)' })
    } else if (inPlan) {
      out.push({ text: 'plan', color: 'var(--color-gn-cyan)' })
    } else if (permChip) {
      out.push({ text: permChip, color: 'var(--color-gn-cyan)' })
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

  // ── TUI queue hint (turn_status.rs: `· N queued`) ──
  // 队列状态不进状态行（右侧簇在窄屏会挤）——独立一行，字号与 busy
  // 状态块一致（13.5px / tabular-nums / 灰色），纵向尽量收窄。
  const queueRow =
    queue.length > 0 && (
      <div
        // Same vertical rhythm as the status line: pb-2 below the row,
        // no extra top margin — spacing to the row above comes from that
        // row's own bottom padding (8px between stacked rows, 8px before
        // the chrome).
        className="flex min-h-4 items-center gap-1.5 pb-2 pr-0.5 font-ui text-[13.5px] leading-[1.4] select-none"
        style={{ paddingLeft: COMPOSER_BODY_PAD_LEFT_PX }}
      >
        <button
          ref={queuePillRef}
          type="button"
          onClick={() => setQueuePanelOpen(!queuePanelOpen)}
          className="inline-flex min-h-5 items-center rounded px-1 tabular-nums text-gn-gray transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg sm:min-h-0"
          title="点击查看发送队列（发送现在 / 删除 / 编辑）"
        >
          {/* 有降级（发送失败）行：红点提示，面板打开后行上徽标说明。 */}
          {queue.some((q) => q.degraded) && (
            <span
              className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-gn-red"
              title="有消息发送失败，点击查看并重发"
            />
          )}
          · {queue.length} queued
        </button>
      </div>
    )

  return (
    // In-flow bottom area (no overlay). Deliberately NOT a scroll
    // container: the slash menu / queue panel float above the chrome and
    // the question card portals into the anchor above the input — all of
    // them extend far above this box's top edge, and an overflow-y:auto
    // here would clip them (only a thin sliver of the panels stayed
    // visible; elementFromPoint showed the scrollback covering them).
    // Column alignment with the scrollback's gutter is kept via the
    // runtime-measured paddingRight (gutterPx) instead — see the
    // measurement effect above.
    <div
      className="safe-pb bg-gn-bg-base pt-1"
      style={gutterPx ? { paddingRight: `${gutterPx}px` } : undefined}
    >
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
        {/* x.ai/ask_user_question card mounts here: QuestionModal portals
            its inline card into this anchor so it sits above the input. */}
        <div id="acp-xai-question-anchor" />
        {/* ── TUI turn status line (turn_status.rs) ──
            Busy: `⠧ Run command 0.2s  1m20s ⇣12k [stop]` — the label is
            the dynamic activity (newest running tool / thinking) with its
            phase timer, falling back to the status text. Idle with
            watchers: `○ 2 commands still running` — a persistent status,
            never a scrollback line. Hidden when truly idle.
            会话切换加载中（historyLoading，含 continueSession 的宽限
            窗口）显示「回放中…」——目标会话 busy/ready 由 host 的
            /api/sessions roster 提前可知，回放期间状态行保持可见，
            加载完毕立即按真实状态渲染（busy 臂 / 已切换文案），不再
            整行淡出。空态（真正空闲）时外层容器零高度，不占布局。 */}
        <div>
          {(statusVisible || historyLoading) && (
          <div
            className="flex min-h-5 items-center gap-1.5 pb-2 pr-0.5 font-ui text-[13.5px] leading-[1.4] select-none"
            style={{ paddingLeft: COMPOSER_BODY_PAD_LEFT_PX }}
          >
            {historyLoading ? (
              // 回放中：session/load 重放历史期间（loadHistory + 宽限
              // 窗口）的状态行内容，加载完毕立即切换真实状态。
              <>
                <span className="inline-flex w-[1.25em] shrink-0 items-center justify-center leading-none text-gn-muted">
                  {SPINNER_FRAMES[spinnerFrame]}
                </span>
                <span className="truncate text-gn-gray-dim">回放中…</span>
                <span className="flex-1" />
              </>
            ) : idleCueVisible ? (
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
                  {busy || conn === 'connecting' || recapPending ? (
                    SPINNER_FRAMES[spinnerFrame]
                  ) : (
                    <span className="h-[7px] w-[7px] rounded-full bg-gn-red" />
                  )}
                </span>
                {busy ? (
                  // Busy arm: activity label (colored per activity type) +
                  // phase timer — dynamic, replaces the static statusText.
                  // The no-activity fallback renders the status text; the
                  // cancelling window is red (TUI Cancelling… accent_error).
                  <>
                    <span
                      className="truncate"
                      style={{
                        color:
                          activity?.color ??
                          (statusText === 'Cancelling…'
                            ? 'var(--color-gn-red)'
                            : 'var(--color-gn-gray-dim)'),
                      }}
                    >
                      {activity?.label ?? statusText}
                    </span>
                    {phaseStart != null && (
                      <span className="shrink-0 tabular-nums text-gn-gray">
                        {formatTurnDuration(Date.now() - phaseStart)}
                      </span>
                    )}
                  </>
                ) : recapPending ? (
                  // /recap 等待臂：请求已发出（fire-and-forget），等
                  // session_recap / session_recap_unavailable 返回后
                  // 清除（chat.ts 事件处理置 false）。
                  <>
                    <span className="truncate text-gn-gray-dim">
                      正在生成摘要…
                    </span>
                    {phaseStart != null && (
                      <span className="shrink-0 tabular-nums text-gn-gray">
                        {formatTurnDuration(Date.now() - phaseStart)}
                      </span>
                    )}
                  </>
                ) : (
                  <span
                    className={`truncate ${
                      conn === 'error' || conn === 'offline'
                        ? 'text-gn-red'
                        : 'text-gn-muted'
                    }`}
                  >
                    {statusText}
                  </span>
                )}
                <span className="flex-1" />
                {busy && turnStartedAt != null && (
                  <span className="tabular-nums text-gn-gray">
                    {formatTurnDuration(Date.now() - turnStartedAt)}
                  </span>
                )}
                {/* 生成速度（估算 tok/s）：host 推送的 gen_rate（流式实时，工具/回合结束冻结）。 */}
                {busy && genRateLabel != null && (
                  <span
                    className="tabular-nums text-gn-gray"
                    title={`生成速度 ≈${genRateLabel} tok/s（host 推送的 gen_rate 估算；流式期间实时更新，工具执行/回合结束冻结）`}
                  >
                    ⇣{genRateLabel}t
                  </span>
                )}
                {/* [↓] send-to-background (TUI DemoteToBackground) — hover
                    label "send to bg", accent_running on hover. */}
                {runningExecute && (
                  <button
                    type="button"
                    title="将当前命令转入后台继续运行（TUI [send to bg]）"
                    onClick={() => {
                      const toolCallId = runningExecute.toolCallId!
                      void transport
                        .terminalBackground(toolCallId)
                        .then(() => {
                          useChatStore.setState({ statusText: '已转入后台…' })
                        })
                        .catch((e) => {
                          useChatStore.getState().appendLocalEntry({
                            kind: 'error',
                            text: `转后台失败: ${e instanceof Error ? e.message : String(e)}`,
                          })
                        })
                    }}
                    className="rounded px-1.5 py-[2px] text-gn-gray hover:bg-gn-bg-highlight hover:text-gn-cyan min-h-6 sm:min-h-0"
                  >
                    [↓]
                  </button>
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
        </div>
        {/* TUI queue hint 独立一行（不挤状态行）：排队中/空闲有剩余条目时
            都显示，点击展开队列面板。 */}
        {queueRow}
        {/* ── TUI follow-up suggestion chips (x.ai/follow_ups, follow_ups.rs) ──
          Turn-end suggestions rendered as a transient row between the
          scrollback and the prompt (TUI: `[ label ]` chips above the prompt
          line). Shown only when the turn is over and nothing is in flight;
          hidden while busy (TUI clears the chips at turn start). Click sends
          the suggestion immediately as a literal model prompt.
        */}
        {followUps && followUps.length > 0 && !busy && (
          <div
            className="mb-1.5 flex min-h-6 flex-wrap items-center gap-1.5"
            style={{ paddingLeft: COMPOSER_BODY_PAD_LEFT_PX }}
          >
            {followUps.map((f, i) => (
              <button
                key={`${i}-${f.label}`}
                type="button"
                onClick={() => sendFollowUp(f.label)}
                className="inline-flex max-w-full min-h-6 items-center rounded-full border border-gn-prompt-border bg-gn-bg-dark px-2.5 text-[11px] leading-none transition-colors hover:border-gn-prompt-border-active hover:bg-gn-bg-highlight hover:text-gn-fg sm:min-h-0"
                title="发送该建议"
              >
                <span className="truncate text-gn-fg2">{f.label}</span>
              </button>
            ))}
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
                          {/* RPC 失败降级行：红色徽标提示手动重发（失败
                              原因作 tooltip）；不再滚 scrollback 错误行。 */}
                          {q.degraded && (
                            <span
                              className="shrink-0 rounded border border-gn-red/40 bg-gn-diff-del-bg/60 px-1 py-[1px] text-[10px] leading-none font-semibold text-gn-red"
                              title={
                                q.errorText
                                  ? `${q.errorText}\n双 Enter / [发送现在] 重发`
                                  : '发送失败：双 Enter / [发送现在] 重发'
                              }
                            >
                              发送失败
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              usePromptQueue.getState().moveUp(i)
                              setQueueSel(Math.max(0, i - 1))
                            }}
                            className="shrink-0 rounded px-1 text-gn-gray transition-opacity hover:bg-gn-bg-highlight hover:text-gn-fg sm:opacity-0 sm:group-hover:opacity-100"
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
                            className="shrink-0 rounded px-1 text-gn-gray transition-opacity hover:bg-gn-bg-highlight hover:text-gn-fg sm:opacity-0 sm:group-hover:opacity-100"
                            title="下移 (Shift+J / Ctrl+↓)"
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            onClick={() => usePromptQueue.getState().startEdit(i)}
                            className="shrink-0 rounded px-1 text-gn-gray transition-opacity hover:bg-gn-bg-highlight hover:text-gn-fg sm:opacity-0 sm:group-hover:opacity-100"
                            title="编辑 (e)"
                          >
                            e
                          </button>
                          <button
                            type="button"
                            onClick={() => usePromptQueue.getState().removeAt(q.id)}
                            className="shrink-0 rounded px-1 text-gn-gray transition-opacity hover:bg-gn-bg-highlight hover:text-gn-red sm:opacity-0 sm:group-hover:opacity-100"
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
                {/* 键盘快捷键提示仅桌面显示——触屏没有 hover/快捷键，窄屏
                    也放不下（10px × 90 字 ≈ 460px）。 */}
                <span className="hidden text-[10px] text-gn-gray sm:inline">
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
                    onClick={() => recallHistory(h)}
                    onMouseEnter={() => setHistSel(i)}
                    className={`block w-full truncate px-3 py-1 text-left text-[11.5px] transition-colors ${
                      i === histSel
                        ? 'bg-gn-bg-highlight text-gn-fg'
                        : 'text-gn-fg2'
                    }`}
                    title={`${h.shell ? '! ' : ''}${h.text}\n${new Date(h.ts).toLocaleString()}`}
                  >
                    {h.shell ? (
                      <span className="text-gn-cyan">! </span>
                    ) : null}
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
            className="flex min-w-0 items-start gap-1.5 py-1 pr-3"
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
                      setSlashSel((s) => Math.min(s + 1, slashList.length - 1))
                    }
                    return
                  }
                  if (histOpen) {
                    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
                      e.preventDefault()
                      const item = history[histSel]
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
                    : // 占位提示只看真实焦点（focused），不看 store 的
                      // focusMode：后者默认就是 'prompt' 且失焦不清，
                      // 用它判断会导致「Build anything」几乎永远不显示。
                      focused
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
                  <div className="sticky bottom-0 flex items-center gap-2 border-t border-gn-prompt-border bg-gn-bg-dark px-3 py-1.5">
                    <input
                      id="set-as-default-model"
                      type="checkbox"
                      checked={setAsDefault}
                      onChange={(e) => setSetAsDefault(e.target.checked)}
                      className="accent-gn-magenta"
                    />
                    <label
                      htmlFor="set-as-default-model"
                      className="text-[10.5px] text-gn-muted"
                      title="切换时同时写入 ~/.grok/config.toml 的 [models] default（+effort），新会话默认使用"
                    >
                      设为默认模型（写入 config.toml）
                    </label>
                  </div>
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
