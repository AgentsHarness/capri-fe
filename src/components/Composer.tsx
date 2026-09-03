import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
} from 'react'
import { useChatStore, formatTurnDuration, stillRunningCue } from '../store/chat'
import { tailAlreadyTurnEnded } from '../store/chat/turnLifecycle'
import { pushToast } from '../store/toast'
import { usePromptQueue } from '../store/promptQueue'
import { onUiSettingsChange, onUiSettingsReady, uiString } from '../store/settings'
import { transport } from '../api/client'
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
import { X } from 'lucide-react'
import { fmtTok } from '../format'
import { SlashMenu } from './SlashMenu'
import { FilePickerMenu } from './FilePickerMenu'
import { isMultilineEnabled, registerModelMenuOpener, escapeSlash, literalSlashPayload } from '../commands/registry'
import {
  chipId,
  chipOccurrenceAt,
  chipOccurrenceAtCaret,
  contentLines,
  expandChips,
  fileToDataUrl,
  normalizeCr,
  pasteChipLabel,
  pruneChips,
  utf8Len,
  CHIP_DISPLAY_BYTES,
  CHIP_MIN_LINES,
  type PasteChip,
} from './composer/pasteChips'
import {
  loadPromptHistory,
  savePromptHistory,
  HISTORY_MAX,
  type HistoryItem,
} from './composer/promptHistory'
import { currentActivity } from './composer/activity'
import { useEscLadder } from './composer/useEscLadder'
// 跨焦点 Esc 阶梯：scrollback 侧首个 idle Esc 的臂定时间戳（useScrollbackKeys）
import { clearEscArm, escArmTimestamp } from '../hooks/useScrollbackKeys'
import { useModelMenu } from './composer/useModelMenu'
import { ModelMenu } from './composer/ModelMenu'
import { PromptHistoryMenu } from './composer/PromptHistoryMenu'
import { QueueStrip } from './composer/QueueStrip'
import { useQueueNav } from './composer/useQueueNav'
import { useSlashMenu } from './composer/useSlashMenu'
import { useAtPicker } from './composer/useAtPicker'

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
  // ── Global Ctrl+C draft custody (TUI Ctrl+C ladder, hook side) ──
  // The global key handler clears the draft BEFORE cancelling a running
  // turn: it reads composerDraftLen (mirrored below) and bumps
  // composerClearNonce; this effect clears the local buffer on the bump.
  const composerClearNonce = useChatStore((s) => s.composerClearNonce)
  const clearNonceRef = useRef(composerClearNonce)
  useEffect(() => {
    if (composerClearNonce === clearNonceRef.current) return
    clearNonceRef.current = composerClearNonce
    setText('')
    setChips([])
    setHistOpen(false)
    taRef.current?.focus()
  }, [composerClearNonce])
  // Mirror the draft length for the global handler (write-only store
  // field — nothing subscribes, so per-keystroke updates cost no render).
  useEffect(() => {
    useChatStore.setState({ composerDraftLen: text.length })
  }, [text])
  const send = useChatStore((s) => s.send)
  const conn = useChatStore((s) => s.conn)
  // 会话切换加载中：turn status 整行显示「回放中…」，加载完毕再按
  // 真实状态渲染（busy 臂 / 已切换文案，见 Scrollback 的加载覆盖层）。
  // historyLoading 覆盖 loadHistory 全程 + 宽限窗口，直至新会话数据
  // 就绪——目标会话 busy/ready 由 host 的 /api/sessions roster 提前
  // 可知（refreshSessions），回放期间状态行保持可见。
  const historyLoading = useChatStore((s) => s.historyLoading)
  // 建会话 POST 在飞（目录右键"在此目录新建会话" / /new / 空状态首条
  // 消息自动创建）：输入不锁（内容照常可打可贴可插入），但发送要等就绪
  // ——submitCurrent 在 newSessionPending 期间把内容收起挂起，POST 收口
  // （成功锚定 / 失败落平）后按序补发；直接放行会让首条消息误触发第二次
  // 建会话 POST，且丢失右键指定的 cwd。
  const newSessionPending = useChatStore((s) => s.newSessionPending)
  // 建会话在飞期间的发送挂起桶：内容先收起（不吞、不丢），创建收口后
  // 逐条补发。创建失败时由 send() 的无会话分支自理（再试建一次或渲染
  // 错误行），挂起内容不会丢。
  const pendingSendsRef = useRef<Array<{ text: string; blocks: ContentBlock[] }>>([])
  useEffect(() => {
    if (newSessionPending || pendingSendsRef.current.length === 0) return
    const batch = pendingSendsRef.current
    pendingSendsRef.current = []
    // 逐条补发：send 首条同步置 conn=busy，后续条目走忙分支进 agent
    // 权威队列（与 Enter 忙时行为一致），不会并行开回合。
    for (const p of batch) void send(p.text, p.blocks)
  }, [newSessionPending, send])
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
  const openThoughtId = useChatStore((s) => s.openThoughtId)
  const openAssistantId = useChatStore((s) => s.openAssistantId)
  const models = useChatStore((s) => s.models)

  const taRef = useRef<HTMLTextAreaElement>(null)
  const busy = conn === 'busy'

  // ── /model 模型菜单（开关/定位/切换）— composer/useModelMenu.ts ──
  const modelMenu = useModelMenu()
  const {
    modelOpen,
    setModelOpen,
    modelMenuPos,
    modelRef,
    modelBtnRef,
  } = modelMenu

  // ── 队首去向徽标（follow_up_behavior 对齐）─────────────────────────
  // 队列第一行在「立即发送」左侧标注队首的下一个去向：
  // - busy + [ui].follow_up_behavior=steer → 「引导」：agent 在下一个
  //   工具/模型安全间隙把队首注入运行中回合，不取消回合（shell 侧
  //   drain_interjections_at_safe_point 的 promote_queued_as_interjections）。
  // - 其余（queue 默认 / 空闲）→ 「队列」：等当前回合结束后作为下一
  //   回合运行（steer 提升仅在回合运行中生效，空闲时队首同样按回合跑）。
  // settings 缓存是模块级非响应式状态，随 ApprovalStrip 惯用法订阅变更
  // 强制重渲；degraded 队首不标注（agent 从没见过该行，两个去向都
  // 不适用）。
  const [, forceQueueBadgeRender] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    onUiSettingsReady(() => forceQueueBadgeRender())
    return onUiSettingsChange(() => forceQueueBadgeRender())
  }, [])
  const headSteer = busy && uiString('follow_up_behavior') === 'steer'

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
  // Panel 渲染顺序是 TUI 的：最旧在顶、最新在底（history_search.rs 把
  // 存储的 newest-first 数组反转），打开时选中最新一条（底部）。
  const histItems = useMemo(() => [...history].reverse(), [history])
  const [histSel, setHistSel] = useState(0)

  // ── TUI mid-turn send queue (Enter during a turn → queued) —
  // 选择/焦点/拖拽/键盘操作状态机 — composer/useQueueNav.ts ──
  const queueNav = useQueueNav()
  const {
    queue,
    setQueuePanelOpen,
    queueEditIndex,
    queueSel,
    setQueueSel,
    queueFocus,
    setQueueFocus,
  } = queueNav

  // ── TUI Esc ladder (prompt.rs try_handle_esc_policy, idle side) —
  // composer/useEscLadder.ts ──
  const { escArmAtRef, escHint, disarmEsc, armEsc } = useEscLadder()

  // ── TUI shell mode (`! ` prefix; command goes to the agent as a prompt) ──
  const [shellMode, setShellMode] = useState(false)
  /** Composer chrome frame — outside clicks dismiss the slash menu / @ picker. */
  const composerChromeRef = useRef<HTMLDivElement>(null)
  /** Counter for clipboard images without a filename (TUI `[Image #N]`). */
  const unnamedImgRef = useRef(0)

  // ── TUI slash command menu (`/` prefix) — composer/useSlashMenu.ts ──
  const {
    slashOpen,
    slashLiteral,
    slashMatches,
    setSlashSel,
    slashSelClamped,
    slashList,
    runSlashCommand,
    resolveSlashLine,
    setSlashDismissed,
  } = useSlashMenu({
    text,
    setText,
    taRef,
    composerChromeRef,
    shellMode,
    clearChips: () => setChips([]),
  })

  // /model (no args) opens the composer's own model menu.
  // setModelOpen 是 useState setter（恒稳定），列入 deps 仅为满足 lint。
  useEffect(() => {
    registerModelMenuOpener(() => setModelOpen(true))
    return () => registerModelMenuOpener(null)
  }, [setModelOpen])

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
   * Build the wire blocks for the current buffer: the text block (text
   * chips expanded) followed by image blocks in chip order. Image chips
   * never occupy the buffer — the text block carries only what the user
   * typed, and each image travels as its own ContentBlock.
   */
  const buildBlocks = (
    textValue: string,
    chipList: PasteChip[],
  ): { expandedText: string; blocks: ContentBlock[] } => {
    const expandedText = expandChips(textValue, chipList)
    const blocks: ContentBlock[] = [{ type: 'text', text: expandedText }]
    for (const c of chipList) {
      if (c.image) {
        blocks.push({ type: 'image', data: c.image.data, mimeType: c.image.mimeType })
      }
    }
    return { expandedText, blocks }
  }

  /**
   * Add pasted/dropped files as always-expanded image chips — the
   * thumbnail row above the textarea, no `[Image: …]` label in the
   * buffer. The label is kept on the chip as a display fallback
   * (queue row text for image-only prompts).
   */
  const insertImageChips = async (files: File[]) => {
    const newChips: PasteChip[] = []
    for (const f of files) {
      try {
        const { data, mimeType } = await fileToDataUrl(f)
        const name = f.name.trim() || String(++unnamedImgRef.current)
        newChips.push({
          id: chipId(),
          label: `[Image: ${name}]`,
          content: '',
          image: { data, mimeType, name, size: f.size },
        })
      } catch {
        // Unreadable file — skip (rare).
      }
    }
    if (newChips.length === 0) return
    setChips((cs) => [...cs, ...newChips])
  }

  /** Send the current buffer as an agent prompt (submit / Ctrl+Enter). */
  const submitCurrent = async () => {
    const trimmed = text.trim()
    if (!trimmed && !chips.some((c) => c.image)) return
    // 建会话 POST 在飞：不吞内容，发送挂起——收起本轮内容（含图片
    // chips），等创建收口后按序补发（见 pendingSendsRef 的 effect）。
    // 直接放行会让 send 的无会话分支再触发一次建会话，丢失右键 cwd。
    if (newSessionPending) {
      const { expandedText, blocks } = buildBlocks(literalSlashPayload(text), chips)
      setText('')
      setChips([])
      pendingSendsRef.current.push({ text: expandedText, blocks })
      taRef.current?.focus()
      return
    }
    // 原文发送写法（`\/…` / 行首空白 + `/…`）的前缀是 composer 语法，
    // 发给 agent 前去掉；未命中的 `/…` 行到这里已是纯文本，原样保留。
    const { expandedText, blocks } = buildBlocks(literalSlashPayload(text), chips)
    setText('')
    setChips([])
    await send(expandedText, blocks)
    // Record history only when the host accepted the prompt (send
    // swallows transport errors into conn: 'error'). History keeps the
    // `\`, so recalling a literal `/…` prompt does not run a command.
    if (useChatStore.getState().conn !== 'error') pushHistory(escapeSlash(expandedText))
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
   * 空输入双 Enter（队首）或行内「立即发送」（指定 id）。
   * Server-authoritative semantics (TUI 对齐):
   * - 队首行已确认（有 version，来自 queue_changed 广播）→
   *   x.ai/queue/interject {id, expectedVersion}：agent 版本校验后把该行
   *   提升为下一个运行（send_now=true，插到 front）。运行中回合 front
   *   已提交时 agent 会取消它、该行立即开跑（send_now_cancels_running_turn
   *   ——goal 活跃或 front 未提交则豁免）。行保留在本地镜像
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
  const sendQueuedItem = async (id?: string) => {
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
    const item = id ? q.queue.find((x) => x.id === id) : q.queue[0]
    if (!item) return
    q.setSending(true)
    try {
      if (!item.degraded) {
        // agent-owned 行（乐观回显 / 已确认）→ send-now via interject
        // （提升为下一个运行；运行中回合可能被 agent 取消、该行立即
        // 开跑）。错误忽略：广播是校正通道，行保留在镜像。
        try {
          await transport.queueInterject(
            {
              id: item.id,
              ...(item.version != null ? { expectedVersion: item.version } : {}),
            },
            activeSession,
          )
        } catch {
          /* fire-and-forget 语义：agent no-op 或传输失败都靠重广播校正 */
        }
        return
      }
      // RPC 失败降级行（FE-owned，agent 从没见过）→ cancel-then-send
      // 兜底：取消运行中回合（后台任务继续），然后发送该行。
      if (useChatStore.getState().conn === 'busy') {
        await useChatStore.getState().cancel()
        for (
          let i = 0;
          i < 50 && useChatStore.getState().conn === 'busy';
          i++
        ) {
          await new Promise((r) => setTimeout(r, 10))
        }
      }
      if (!usePromptQueue.getState().queue.some((x) => x.id === item.id)) return
      q.removeAt(item.id)
      try {
        // Resend the wire text from the blocks (image-only rows stash
        // `[Image: …]` display labels in item.text — never to the agent).
        const firstBlock = item.blocks[0]
        // ContentBlock has an open `{ type: string; … }` arm — cast after
        // the discriminant check to get the string-typed text.
        const resendText =
          firstBlock && firstBlock.type === 'text'
            ? (firstBlock as { type: 'text'; text: string }).text
            : item.text
        const sendPromise = useChatStore.getState().send(resendText, item.blocks, {
          promptId: item.id,
        })
        q.setSending(false)
        await sendPromise
        // Re-arm the `\/` escape in history (queued text is already
        // unescaped; a leading `/` here can only be a literal prompt).
        if (useChatStore.getState().conn !== 'error') pushHistory(escapeSlash(item.text))
      } catch {
        const active = useChatStore.getState().sessionId
        if (active) usePromptQueue.getState().requeueFront(active, item)
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
    // Image-only prompts are sendable: the images are the content (no
    // `[Image: …]` text in the buffer). Empty input with no images still
    // means Double-Enter → send the queue head now.
    if (!trimmed && !chips.some((c) => c.image)) {
      if (q.queue.length > 0) void sendQueuedItem()
      return
    }
    if (shellMode) {
      void submitShell(trimmed)
      return
    }
    const st = useChatStore.getState()
    if (st.conn === 'busy' && st.sessionId) {
      // TUI: Enter during a running turn → server-authoritative enqueue。
      // 走 send() 的忙分支（共享实现）：只入 agent 权威队列，不进
      // transcript——排队消息本身由 composer 上方的内联队列区展示
      // （默认展开，可收起为 "N queued"）；回合收口后 agent pop 队首，
      // 收养广播把该条渲染为用户行。RPC 失败 → 行保留 degraded（队列
      // 区红点 + 失败徽标，可手动重发）。
      const { expandedText, blocks } = buildBlocks(literalSlashPayload(text), chips)
      // Queue-row display text: the buffer holds no `[Image: …]` markers,
      // so image-only prompts fall back to the joined labels (display
      // only — the wire blocks carry the images).
      const queueText =
        expandedText !== ''
          ? expandedText
          : chips.filter((c) => c.image).map((c) => c.label).join('')
      setText('')
      setChips([])
      void useChatStore.getState().send(queueText, blocks)
      taRef.current?.focus()
      return
    }
    await submitCurrent()
  }

  // ── TUI @ file picker (fuzzy file search) — composer/useAtPicker.ts ──
  // Typing `@` (word start) opens the file popover; the token after `@`
  // is the fuzzy query. Matches stream through the store's `fileSearch`
  // state (search_fuzzy_status SSE event) — the change RPC itself only
  // arms the query. Enter/Tab insert `@path ` at the token, Esc/whitespace
  // close. Mutually exclusive with the slash menu (token detection runs
  // only when it's closed) and shell mode.
  const {
    fileSearch,
    atOpen,
    atQuery,
    atSel,
    setAtSel,
    detectAtToken,
    pickAtMatch,
    closeAtPicker,
  } = useAtPicker({
    text,
    setText,
    setChips,
    setPendingCaret,
    taRef,
    composerChromeRef,
    shellMode,
    slashOpen,
  })

  /** Always-expanded image chips → thumbnail row above the textarea. */
  const imageChips = useMemo(() => chips.filter((c) => c.image), [chips])

  // Close the recall panel on outside-the-composer click (same chrome-scope
  // dismissal as the slash menu; Esc is handled in the textarea key handler
  // — the panel opens from ↑ with the textarea focused, so the key always
  // lands there). Queue 已内联进 composer，不再有弹窗可关。
  useEffect(() => {
    if (!histOpen) return
    const onDown = (e: MouseEvent) => {
      if (
        composerChromeRef.current &&
        !composerChromeRef.current.contains(e.target as Node)
      ) {
        setHistOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [histOpen, composerChromeRef])

  // TUI queue: server-authoritative drain — the AGENT pops the queue head
  // at turn end (auto-drain) and broadcasts running_prompt_id for
  // adoption; the FE never auto-sends queue rows (legacy 409 auto-retry
  // removed). Agent-owned rows (optimistic in-flight / confirmed) are
  // adopted via the broadcast; FE-owned degraded rows (RPC 失败保留) are
  // sent MANUALLY via 双 Enter / 行内「立即发送」 (sendQueuedItem). The
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
  // 本地真相兜底（spurious ready / host 状态丢失）：传输侧宣称空闲
  // （conn ready）但本地仍有活动流或未终止的回合计时——hub 重连竞态 /
  // 多会话错标 / host 丢态都可能触发。状态行按本地活动显示真实状态，
  // 不随 conn 熄灭，附注让传输异常可见（服务端守卫见 conn.ts
  // turnLiveLocally，这里是显示层最后防线）。真实终态时间线必带回合
  // 终止标记，不会误亮。
  const localLive =
    !busy &&
    conn === 'ready' &&
    (openThoughtId != null ||
      openAssistantId != null ||
      (turnStartedAt != null &&
        entries.length > 0 &&
        !tailAlreadyTurnEnded(entries)))
  // Phase identity for anchor tracking: activity label (+ entry stamp)
  // while something runs, else the status text of the wait window. When
  // it changes (a new entry arrived / a new wait began), the anchor is
  // reset so the timer starts counting the new phase from zero.
  const phaseKey =
    activity != null
      ? `a:${activity.label}:${activity.startedAt ?? ''}`
      : busy
        ? `w:${statusText}`
        : localLive
          ? 'l:local'
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
    (busy || recapPending || localLive
      ? (phaseAnchor.current ?? turnStartedAt)
      : undefined)
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
  // 期间内容就是回放臂，加载完毕立即切换真实状态。error/offline 不在
  // 其中：host/hub 错误只进顶部横幅（ErrorBanner），composer 状态行
  // 不参与，避免与横幅重复。
  const statusVisible =
    !historyLoading &&
    (busy ||
      conn === 'connecting' ||
      recapPending ||
      newSessionPending ||
      idleCueVisible ||
      localLive)
  // 生成速度（状态行总时间右侧）：host 推送的 gen_rate（字符/秒），
  // 只在输出过程中显示——流式期间实时更新，输出结束（工具阶段/回合
  // 结束）host 广播 active:false 清除。
  const genRateLabel =
    genRate != null && genRate > 0 ? Math.round(genRate) : undefined
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  // 回放中（historyLoading）也要转 spinner：会话切换加载期间状态行
  // 显示「回放中…」，与 busy 臂共用同一旋转动画。
  useEffect(() => {
    if (!statusVisible && !historyLoading && !newSessionPending) return
    const t = window.setInterval(
      () => setSpinnerFrame((v) => (v + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    )
    return () => window.clearInterval(t)
  }, [statusVisible, historyLoading, newSessionPending])
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

  // 输入框随内容增高，最高到半个视口（TUI PromptViewConfig
  // max_prompt_height 半视口增长）；超出部分在输入框内部滚动
  // （gn-no-scrollbar 隐藏滚动条，光标由原生 textarea 保持可见）。
  // 失焦不折叠（collapse_unfocused 保持移除），清空后回落单行。
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    const remeasure = () => {
      // Reset height first so scrollHeight reports the full content.
      el.style.height = 'auto'
      const max = Math.floor(window.innerHeight / 2)
      el.style.height = `${Math.min(el.scrollHeight, max)}px`
    }
    remeasure()
    window.addEventListener('resize', remeasure)
    return () => window.removeEventListener('resize', remeasure)
  }, [text, chips])

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
   *  Image chips never carry a label in the buffer — they are always
   *  expanded as thumbnails and removed with the X button instead. */
  const expandChipAt = (at: { chip: PasteChip; start: number; end: number }) => {
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
      if (c.image) return false // image chips are not text-anchored
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
    // Image paste: clipboard items with image/* types (screenshots,
    // copied images) become always-expanded thumbnails above the
    // textarea — no `[Image: …]` label enters the buffer. When images
    // are present they win over any coexisting text (browser copies
    // often carry both).
    const imageFiles: File[] = []
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) imageFiles.push(f)
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault()
      void insertImageChips(imageFiles)
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
      if (chip.image) continue // image chips are always expanded, never in text
      let from = 0
      for (;;) {
        const start = text.indexOf(chip.label, from)
        if (start === -1) break
        if (caretPos === start) return { chip, onChip: true }
        from = start + chip.label.length
      }
    }
    for (const chip of chips) {
      if (chip.image) continue
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
    // Store is the agent-confirmed live mode (hello / yolo_mode_changed /
    // a setMode that already succeeded) — config.toml is not painted here.
    // Only non-ask modes are surfaced. A stale permissionMode
    // ('ask'/'default') must NOT shadow the optimistic local
    // yoloMode/autoMode flags set by /auto & friends.
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
    // error/offline 不在这里回显：host/hub 错误只进顶部横幅
    // （ErrorBanner），model 槽的 disconnected 已表达连接态。
    return out
    // statusText 是 /multiline 命令的变更信号（命令只写 localStorage +
    // statusText，多行 chip 靠这个 dep 重算）——非多余依赖。
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [usage, statusText, permissionMode, yoloMode, autoMode, planMode])

  // ── Inline queue strip：忙时 Enter 只入队，消息正文在 composer 上方。
  // 渲染归 composer/QueueStrip.tsx（状态归 useQueueNav）。

  // ── TUI Esc ladder hint (prompt.rs "press again to clear") ──
  // Transient row between the status area and the prompt; auto-expires
  // with the 800ms arm TTL (armEsc's timer clears the state).
  const escHintRow = escHint && (
    <div
      className="flex min-h-4 items-center gap-1.5 pb-2 pr-0.5 font-ui text-[12px] leading-[1.4] text-gn-gray select-none"
      style={{ paddingLeft: COMPOSER_BODY_PAD_LEFT_PX }}
    >
      {escHint === 'clear'
        ? '再按一次 Esc 清空草稿（回合不受影响）'
        : '再按一次 Esc 打开 rewind 选择器'}
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
        <div id="capri-xai-question-anchor" />
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
          {(statusVisible || historyLoading || newSessionPending) && (
          <div
            className="flex min-h-5 items-center gap-1.5 pb-2 pr-0.5 font-ui text-[13.5px] leading-[1.4] select-none"
            style={{ paddingLeft: COMPOSER_BODY_PAD_LEFT_PX }}
          >
            {newSessionPending ? (
              // 建会话 POST 在飞：状态行提示创建中——输入可用，发送会
              // 挂起到创建收口后自动补发（见 submitCurrent / pendingSendsRef）。
              <>
                <span className="inline-flex w-[1.25em] shrink-0 items-center justify-center leading-none text-gn-muted">
                  {SPINNER_FRAMES[spinnerFrame]}
                </span>
                <span className="truncate text-gn-gray-dim">正在创建会话…</span>
                <span className="flex-1" />
              </>
            ) : historyLoading ? (
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
                  {SPINNER_FRAMES[spinnerFrame]}
                </span>
                {busy || localLive ? (
                  // Busy arm: activity label (colored per activity type) +
                  // phase timer — dynamic, replaces the static statusText.
                  // The no-activity fallback renders the status text; the
                  // cancelling window is red (TUI Cancelling… accent_error).
                  // localLive（conn 已被 spurious ready 打回但本地仍有活动）
                  // 显示真实活动并附注 host 状态缺失。
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
                      {activity?.label ?? (localLive && !busy ? '回合进行中' : statusText)}
                    </span>
                    {phaseStart != null && (
                      <span className="shrink-0 tabular-nums text-gn-gray">
                        {formatTurnDuration(Date.now() - phaseStart)}
                      </span>
                    )}
                    {localLive && !busy && (
                      <span
                        className="shrink-0 text-gn-gutter"
                        title="host 状态缺失（可能是 hub/host 传输异常）——按本地活动显示真实状态"
                      >
                        · host 状态缺失
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
                  // 空闲臂：静态 statusText（连接中 / 会话操作反馈）。
                  // error/offline 不在此渲染（错误只进顶部横幅）——此
                  // 分支可达时 conn 必为 connecting。
                  <span className="truncate text-gn-muted">
                    {statusText}
                  </span>
                )}
                <span className="flex-1" />
                {busy && turnStartedAt != null && (
                  <span className="tabular-nums text-gn-gray">
                    {formatTurnDuration(Date.now() - turnStartedAt)}
                  </span>
                )}
                {/* 生成速度（字符/秒）：host 推送的 gen_rate（流式实时，输出结束清除）。 */}
                {busy && genRateLabel != null && (
                  <span
                    className="tabular-nums text-gn-gray"
                    title={`生成速度 ≈${genRateLabel} 字符/s（host 推送的 gen_rate 字符吞吐；只在输出过程中显示，输出结束清除）`}
                  >
                    ⇣{genRateLabel}c
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
        {/* 内联发送队列（无弹窗）：排队消息正文 + 行内操作。 */}
        <QueueStrip nav={queueNav} sendQueuedItem={(id) => void sendQueuedItem(id)} headSteer={headSteer} />
        {escHintRow}
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
            // Clicking chrome focuses the textarea (don't steal from buttons).
            if ((e.target as HTMLElement).closest('button, a')) return
            taRef.current?.focus()
          }}
        >
          {/* Prompt history recall panel (TUI ↑ on empty input) — 交互与
              斜杠/文件浮层对齐：行样式、位置计数、选中行随动、Enter/Tab 填入。
              列表顺序与 TUI 一致（最旧在顶、最新在底，histItems 已反转）。 */}
          {histOpen && histItems.length > 0 && (
            <PromptHistoryMenu
              history={histItems}
              selected={histSel}
              onHover={setHistSel}
              onPick={recallHistory}
            />
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
              onLiteral={() => {
                // Prepend the escape: `/xyz` → `\/xyz`, caret back at the
                // end, menu closes (the line no longer starts with "/").
                setText(`\\${text}`)
                setPendingCaret(text.length + 1)
                taRef.current?.focus()
              }}
            />
          )}
          {/* TUI @ file picker — floats above the composer while an `@`
              token is being typed (fuzzy file search; Enter/Tab inserts
              `@path ` over the token). Mutually exclusive with the slash
              menu (token detection is skipped while it's open). */}
          {atOpen && !slashOpen && (
            <FilePickerMenu
              query={atQuery}
              matches={fileSearch?.matches ?? []}
              done={fileSearch?.done ?? true}
              total={fileSearch?.total}
              selected={Math.min(atSel, Math.max(0, (fileSearch?.matches.length ?? 1) - 1))}
              onHover={setAtSel}
              onPick={pickAtMatch}
            />
          )}
          {/* Image chips — always-expanded thumbnails above the textarea
              (paste/drop lands here directly; X removes the image).
              pt clears the chrome's 4px top padding plus the remove button's
              -top-1.5 overflow so neither rides the border. */}
          {imageChips.length > 0 && (
            <div className="flex flex-wrap items-end gap-2 px-3 pt-2.5 pb-1">
              {imageChips.map((c) => (
                <div key={c.id} className="group relative">
                  <img
                    src={`data:${c.image!.mimeType};base64,${c.image!.data}`}
                    alt={c.image!.name}
                    className="max-h-24 w-auto max-w-[160px] rounded border border-gn-prompt-border object-contain"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setChips((cs) => cs.filter((x) => x.id !== c.id))
                    }
                    className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-gn-bg-dark text-gn-gray shadow transition-colors hover:text-gn-red"
                    title="移除图片"
                  >
                    <X size={10} strokeWidth={2.5} aria-hidden />
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
                  // @ token under the (post-edit) caret arms/closes the
                  // file picker — runs after every buffer edit.
                  detectAtToken(v, e.target.selectionStart ?? v.length)
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
                      const { expandedText } = buildBlocks(text, chips)
                      void transport
                        .interject({ text: expandedText })
                        .catch(() => {
                          pushToast('插话发送失败')
                        })
                      setText('')
                      setChips([])
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
                      setSlashSel((s) => Math.min(s + 1, slashList.length - 1))
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
                      // Everything else falls through and goes out as plain
                      // text: the `\/…` / leading-space literals, and lines
                      // whose first word matches no command at all (the TUI
                      // appends an error row there — the FE lets it pass).
                      if (
                        !shellMode &&
                        !slashLiteral &&
                        text.trimStart().startsWith('/')
                      ) {
                        const hit = resolveSlashLine(text)
                        if (hit) {
                          void runSlashCommand(hit.cmd, hit.args)
                          return
                        }
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
                }}
                onBeforeInput={(e) => {
                  // IME / drag-drop inserts into a chip label are swallowed.
                  const el = taRef.current
                  if (!el) return
                  if (partiallyOverlapsChip(el.selectionStart, el.selectionEnd)) {
                    e.preventDefault()
                  }
                }}
                onPaste={(e) => {
                  onPaste(e)
                }}
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
                  void insertImageChips(files)
                }}
                onSelect={() => {
                  // Mirror the live caret (selectionchange) for the preview.
                  const t = taRef.current
                  if (t) {
                    setCaretPos(t.selectionStart)
                    // Caret moves re-check the @ token (moving out of one
                    // closes the picker; moving within re-queries).
                    detectAtToken(text, t.selectionStart)
                  }
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
              {slashLiteral && (
                // 转义生效的即时回执：这行不会被当命令执行，Enter 原样发出。
                <span className="mt-[3px] shrink-0 self-start rounded border border-gn-prompt-border-active px-1 font-mono text-[10px] leading-[14px] text-gn-muted">
                  原文发送
                </span>
              )}
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
                <ModelMenu models={models} pos={modelMenuPos} menu={modelMenu} />
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
              above the prompt frame while the caret is on/after a text
              chip: first/last 3 lines with a ⋮ separator + expand hint.
              Image chips are always expanded, so no preview is needed. */}
          {preview &&
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
            )}
        </div>

      </div>
    </div>
  )
}
