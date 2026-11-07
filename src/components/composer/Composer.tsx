import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useChatStore } from '../../store/chat'
import { pushToast } from '../../store/toast'
import { usePromptQueue } from '../../store/promptQueue'
import {
  applyUiSettings,
  onUiSettingsChange,
  onUiSettingsReady,
  uiString,
} from '../../store/settings'
import { transport } from '../../api/client'
import type { ContentBlock } from '../../api/types'
import { escapeSlash, literalSlashPayload, registerModelMenuOpener } from '../../commands/registry'
import {
  CONTENT_COLUMN_CLASS,
  COLUMN_PAD_X_CLASS,
  COMPOSER_BODY_PAD_LEFT_PX,
} from '../../theme/layout'
import { useTouchUi } from '../../hooks/useTouchUi'
import { useScrollbarGutter } from '../../hooks/useScrollbarGutter'
import { useEscLadder } from './useEscLadder'
import { clearEscArm, escArmTimestamp } from '../../hooks/useScrollbackKeys'
import { useModelMenu } from './useModelMenu'
import { useModeMenu } from './useModeMenu'
import {
  loadPromptHistory,
  savePromptHistory,
  HISTORY_MAX,
  type HistoryItem,
} from './promptHistory'
import { autoRestoreAfterSend, type PromptStashSlot } from './promptStash'
import { useQueueNav } from './useQueueNav'
import { useSlashMenu } from './useSlashMenu'
import { useAtPicker } from './useAtPicker'
import { useComposerDraft } from './useComposerDraft'
import { useComposerKeydown } from './useComposerKeydown'
import { useSendQueuedItem } from './useSendQueuedItem'
import { noteLocalPrompt } from './localPrompt'
import { TurnStatusLine } from './TurnStatusLine'
import { ComposerFooter } from './ComposerFooter'
import { ComposerPrompt } from './ComposerPrompt'
import { ModeSwitchBanner } from './ModeSwitchBanner'
import { QueueStrip } from './QueueStrip'
import { QueueEditModal } from './QueueEditModal'
import { InterjectConfirmModal } from './InterjectConfirmModal'

/** Composer：底部输入区（草稿 / 队列 / 菜单 / 发送）。 */
export function Composer({ guest = false }: { guest?: boolean }) {
  const isTouch = useTouchUi()
  const taRef = useRef<HTMLTextAreaElement>(null)
  const conn = useChatStore((s) => s.conn)
  const busy = conn === 'busy'

  const draft = useComposerDraft({ taRef, guest, isTouch })
  const {
    text,
    setText,
    chips,
    setChips,
    setPendingCaret,
    shellMode,
    setShellMode,
    promptFocused,
    buildBlocks,
    expandChipAt,
    partiallyOverlapsChip,
    onPaste,
    clampCaret,
  } = draft

  const composerClearNonce = useChatStore((s) => s.composerClearNonce)
  const clearNonceRef = useRef(composerClearNonce)
  useEffect(() => {
    if (composerClearNonce === clearNonceRef.current) return
    clearNonceRef.current = composerClearNonce
    setText('')
    setChips([])
    setHistOpen(false)
    if (!isTouch) taRef.current?.focus()
  }, [composerClearNonce, isTouch, setText, setChips])
  // Mirror the draft length for the global handler (write-only store
  // field — nothing subscribes, so per-keystroke updates cost no render).
  useEffect(() => {
    useChatStore.setState({ composerDraftLen: text.length })
  }, [text])
  // 立即发送确认拦截（若有未决提问或权限审批，需弹窗确认才抢占）
  const [interjectTarget, setInterjectTarget] = useState<{ id?: string } | null>(null)
  // Keep focus in sync with store focusMode (Tab toggles on desktop) — but skip
  // initial mount & StrictMode remounts so page enter/refresh never steals focus.
  const focusMode = useChatStore((s) => s.focusMode)
  const prevFocusModeRef = useRef(focusMode)
  useEffect(() => {
    if (guest) return
    const prev = prevFocusModeRef.current
    prevFocusModeRef.current = focusMode
    if (prev === focusMode) return
    if (isTouch) {
      if (focusMode !== 'prompt') taRef.current?.blur()
      return
    }
    if (focusMode === 'prompt') {
      taRef.current?.focus()
    } else {
      taRef.current?.blur()
    }
  }, [focusMode, isTouch, guest])

  const send = useChatStore((s) => s.send)
  /**
   * 走 send() 并记下它同步锚定的回合身份。忙时 send 只入队、不锚定新
   * 回合（currentPromptId 不变），此时不覆盖记录——它必须始终描述
   * 「本端刚发出、还在等回执的那条」。
   */
  const sendLocal = useCallback(
    (...args: Parameters<typeof send>) => {
      const before = useChatStore.getState().currentPromptId
      const pending = send(...args)
      const after = useChatStore.getState().currentPromptId
      if (after != null && after !== before) noteLocalPrompt(after)
      return pending
    },
    [send],
  )
  // 建会话 POST 在飞：输入不锁，但发送要等就绪——内容先收起，收口后补发。
  const newSessionPending = useChatStore((s) => s.newSessionPending)
  const emptyWorktreeBusy = useChatStore((s) => s.emptyWorktreeBusy === true)
  const pendingSendsRef = useRef<Array<{ text: string; blocks: ContentBlock[] }>>([])
  useEffect(() => {
    if (newSessionPending || pendingSendsRef.current.length === 0) return
    const batch = pendingSendsRef.current
    pendingSendsRef.current = []
    for (const p of batch) void sendLocal(p.text, p.blocks)
  }, [newSessionPending, send, sendLocal])
  /** TUI FollowUps state — turn-end suggestion chips (x.ai/follow_ups). */
  const followUps = useChatStore((s) => s.followUps)
  // ── 队首去向徽标（follow_up_behavior 对齐）──
  const [, forceQueueBadgeRender] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    onUiSettingsReady(() => forceQueueBadgeRender())
    return onUiSettingsChange(() => forceQueueBadgeRender())
  }, [])
  const headSteer = busy && uiString('follow_up_behavior') === 'steer'

  const [togglingFollowUp, setTogglingFollowUp] = useState(false)
  const toggleFollowUpBehavior = useCallback(async () => {
    if (togglingFollowUp) return
    const current = uiString('follow_up_behavior') === 'steer' ? 'steer' : 'queue'
    const next = current === 'steer' ? 'queue' : 'steer'
    setTogglingFollowUp(true)
    try {
      const res = await transport.updateSettings({ follow_up_behavior: next })
      applyUiSettings(res.ui ?? {})
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e))
    } finally {
      setTogglingFollowUp(false)
    }
  }, [togglingFollowUp])


  const gutterPx = useScrollbarGutter()

  const rewindOpen = useChatStore((s) => s.rewindOpen)

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


  // ── TUI prompt history recall (↑ on empty input) ──
  const [history, setHistory] = useState<HistoryItem[]>(loadPromptHistory)
  const [histOpen, setHistOpen] = useState(false)
  // Panel 渲染顺序是 TUI 的：最旧在顶、最新在底（history_search.rs 把
  // 存储的 newest-first 数组反转），打开时选中最新一条（底部）。
  const histItems = useMemo(() => [...history].reverse(), [history])
  const [histSel, setHistSel] = useState(0)


  // ── TUI mid-turn send queue (Enter during a turn → queued) —
  // 选择/焦点/拖拽/键盘操作状态机 — composer/useQueueNav.ts ──
  const queueNav = useQueueNav({ readonly: guest })
  const {
    queue,
    setQueuePanelOpen,
    queueEditIndex,
    queueSel,
    setQueueSel,
    queueFocus,
    setQueueFocus,
  } = queueNav


  // ── TUI prompt stash (Ctrl+S / Alt+S, prompt_stash.rs) ──
  const stashRef = useRef<PromptStashSlot | null>(null)
  const [stashOn, setStashOn] = useState(false)
  const noteStash = (slot: PromptStashSlot | null) => {
    stashRef.current = slot
    setStashOn(slot != null)
  }
  /** A sent draft is gone. A chord stash then comes back into the empty composer. */
  const consumeDraftForSend = () => {
    const back = autoRestoreAfterSend(stashRef.current, queueEditIndex != null)
    if (back) {
      noteStash(null)
      setText(back.text)
      setChips(back.chips)
      setShellMode(back.shellMode)
      setPendingCaret(back.text.length)
      pushToast('已取回暂存的草稿')
      return
    }
    setText('')
    setChips([])
  }


  // ── TUI Esc ladder (prompt.rs try_handle_esc_policy, idle side) —
  // composer/useEscLadder.ts ──
  const { escArmAtRef, escHint, disarmEsc, armEsc } = useEscLadder()

  /** Composer chrome frame — outside clicks dismiss the slash menu / @ picker. */
  const composerChromeRef = useRef<HTMLDivElement>(null)
  /** 触控端的选图入口（移动端剪贴板基本不带图片数据，粘贴不是可行路径）。 */
  const imgPickRef = useRef<HTMLInputElement>(null)


  const slashState = useSlashMenu({
    text,
    setText,
    taRef,
    composerChromeRef,
    shellMode,
    clearChips: () => setChips([]),
    setPendingCaret,
  })
  const {
    slashOpen,
    slashLiteral,
    slashRowCount,
    setSlashSel,
    acceptSelected,
    slashEnter,
    setSlashDismissed,
  } = slashState


  const modelMenu = useModelMenu()

  const { modelOpen, setModelOpen, modelMenuPos, modelRef, modelBtnRef } = modelMenu

  const modeMenu = useModeMenu()

  const {
    modeOpen,
    setModeOpen,
    modeMenuPos,
    modeRef,
    modeBtnRef,
    currentModeLabel,
    currentModeShortLabel,
    inPlan,
  } = modeMenu

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


  /** Send the current buffer as an agent prompt (submit / Ctrl+Enter). */
  const submitCurrent = async () => {
    const trimmed = text.trim()
    if (!trimmed && !chips.some((c) => c.image)) return
    const st = useChatStore.getState()
    if (st.sessionId && st.historyLoading) {
      pushToast('正在切换会话，请稍候再发送')
      if (!isTouch) taRef.current?.focus()
      return
    }
    // 空状态首条消息正在建 worktree：不再触发一次发送（会白建第二个
    // worktree）。草稿原样留着，创建收口后再发。抢在 newSessionPending 的
    // 挂起分支之前：否则内容会被收起挂起，而 create 失败时没有创建可以
    // 「收口」，挂起的内容就没人补发了。
    if (emptyWorktreeBusy) {
      pushToast('正在创建 worktree，请稍候')
      return
    }
    // 建会话 POST 在飞：不吞内容，发送挂起——收起本轮内容（含图片
    // chips），等创建收口后按序补发（见 pendingSendsRef 的 effect）。
    // 直接放行会让 send 的无会话分支再触发一次建会话，丢失右键 cwd。
    if (newSessionPending) {
      const { expandedText, blocks } = buildBlocks(literalSlashPayload(text), chips)
      consumeDraftForSend()
      pendingSendsRef.current.push({ text: expandedText, blocks })
      if (isTouch) {
        taRef.current?.blur()
      } else {
        taRef.current?.focus()
      }
      return
    }
    // 原文发送写法（`\/…` / 行首空白 + `/…`）的前缀是 composer 语法，
    // 发给 agent 前去掉；未命中的 `/…` 行到这里已是纯文本，原样保留。
    const { expandedText, blocks } = buildBlocks(literalSlashPayload(text), chips)
    consumeDraftForSend()
    await sendLocal(expandedText, blocks)
    // Record history only when the host accepted the prompt (send
    // swallows transport errors into conn: 'error'). History keeps the
    // `\`, so recalling a literal `/…` prompt does not run a command.
    if (useChatStore.getState().conn !== 'error') pushHistory(escapeSlash(expandedText))
    if (isTouch) {
      taRef.current?.blur()
    } else {
      taRef.current?.focus()
    }
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
    if (!isTouch) taRef.current?.focus()
  }

  /**
   * TUI follow-up chip click (mouse.rs → Action::SubmitFollowUp →
   * dispatch_send_prompt_inner literal=true): the suggestion is sent
   * IMMEDIATELY as a literal model prompt — no busy gating (the TUI does
   * not intercept mid-turn either). send() retires the chips (turn
   * start), so the row disappears as the new turn begins.
   */
  const sendFollowUp = (label: string) => {
    const st = useChatStore.getState()
    if (st.sessionId && st.historyLoading) {
      pushToast('正在切换会话，请稍候再发送')
      return
    }
    void sendLocal(label)
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
    if (st.sessionId && st.historyLoading) {
      pushToast('正在切换会话，请稍候再发送')
      if (!isTouch) taRef.current?.focus()
      return
    }
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
   * TUI `!` mode: send the command to the host as a direct-bash prompt
   * (text block carries `_meta.bash_command`, TUI 同款 wire). The host runs
   * it outside the model loop and echoes back a `$ cmd` user row plus an
   * Execute tool call — so the command AND its output live in the session
   * transcript and survive a reload. Exits shell mode back to plain input.
   */
  const submitShell = async (cmd: string) => {
    if (!cmd.trim()) return
    setShellMode(false)
    consumeDraftForSend()
    // 忙时（含上一回合未收口）走 send() 的权威队列分支，与 TUI 的
    // bash 排队语义一致；blocks 原样入队，出队收养时仍认得是 shell 行。
    await sendLocal(cmd, [{ type: 'text', text: cmd, _meta: { bash_command: cmd } }], {
      fromShell: true,
    })
    // Record history only when the host accepted the command — shell
    // submissions are tagged so recalling them re-enters shell mode.
    if (useChatStore.getState().conn !== 'error') pushHistory(cmd, true)
    if (isTouch) {
      taRef.current?.blur()
    } else {
      taRef.current?.focus()
    }
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
    // 空状态首条消息正在建 worktree：任何发送入口都先拦住（shell 命令同理），
    // 草稿不被 consumeDraftForSend 收走，等创建收口后用户再发。
    if (useChatStore.getState().emptyWorktreeBusy) {
      pushToast('正在创建 worktree，请稍候')
      if (!isTouch) taRef.current?.focus()
      return
    }
    if (shellMode) {
      void submitShell(trimmed)
      return
    }
    const st = useChatStore.getState()
    if (st.sessionId && st.historyLoading) {
      pushToast('正在切换会话，请稍候再发送')
      if (!isTouch) taRef.current?.focus()
      return
    }
    if (st.conn === 'busy' && st.sessionId) {
      // TUI: Enter during a running turn → server-authoritative enqueue。
      // 走 send() 的忙分支（共享实现）：只入 agent 权威队列，不进
      // transcript——排队消息本身由 composer 上方的内联队列区展示
      // （默认展开，可收起为 "N queued"）；回合收口后 agent pop 队首，
      // 收养广播把该条渲染为用户行。RPC 失败 → 行保留 degraded（队列
      // 区红点 + 失败徽标，可手动重发）。
      const { expandedText, blocks } = buildBlocks(literalSlashPayload(text), chips)
      // 队列行的正文就是真正文（纯图片 prompt 为空串）——图片由 blocks
      // 说话：队列条按每张图渲染一个可点的 `[image]` 标记（QueueStrip）。
      consumeDraftForSend()
      void sendLocal(expandedText, blocks)
      if (isTouch) {
        taRef.current?.blur()
      } else {
        taRef.current?.focus()
      }
      return
    }
    await submitCurrent()
  }


  const atState = useAtPicker({
    text,
    setText,
    setChips,
    setPendingCaret,
    taRef,
    composerChromeRef,
    shellMode,
    slashOpen,
  })
  const {
    fileSearch,
    atOpen,
    atSel,
    setAtSel,
    detectAtToken,
    pickAtMatch,
    closeAtPicker,
  } = atState


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


  // ── Inline queue strip：忙时 Enter 只入队，消息正文在 composer 上方。
  // 渲染归 composer/QueueStrip.tsx（状态归 useQueueNav）。
  // 正在发送的那一行：store 的 `sending` 只是互斥锁，不知道是哪条，
  // 行内按钮要自己的转圈就得在这里记住目标 id。
  const [queueSendingId, setQueueSendingId] = useState<string | null>(null)


  // ── TUI Esc ladder hint (prompt.rs "press again to clear") ──
  // Transient row between the status area and the prompt; auto-expires
  // with the 800ms arm TTL (armEsc's timer clears the state).
  const escHintRow = escHint && (
    <div
      className="flex min-h-4 items-center gap-1.5 pb-2 pr-0.5 font-ui text-[12px] leading-[1.4] text-gn-gray select-none"
      style={{ paddingLeft: COMPOSER_BODY_PAD_LEFT_PX }}
    >
      {escHint === 'clear' ? (
        <span>
          再按一次 <span className="gn-kbd">Esc</span> 清空草稿（回合不受影响）
        </span>
      ) : (
        <span>
          再按一次 <span className="gn-kbd">Esc</span> 打开 rewind 选择器
        </span>
      )}
    </div>
  )


  const sendQueuedItem = useSendQueuedItem({
    sendLocal,
    pushHistory,
    setInterjectTarget,
  })

  const onKeyDown = useComposerKeydown({
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
    atSel,
    fileSearch,
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
  })

  return (
    <div
      className="safe-pb bg-gn-bg-base pt-1 touch-pan-x overscroll-none"
      style={gutterPx ? { paddingRight: `${gutterPx}px` } : undefined}
    >
      <div className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS}`}>
        <ModeSwitchBanner />
        <div id="capri-xai-question-anchor" />
        <TurnStatusLine guest={guest} />
        {/* 内联发送队列（无弹窗）：排队消息正文 + 行内操作。访客以只读态
            挂载——正文与附图可见，发送/编辑/删除/拖拽/队首模式都收起
            （顶栏 +N 芯片照常展开/收起这一块）。 */}
        <QueueStrip
          nav={queueNav}
          sendQueuedItem={(id) => {
            const target = id ?? usePromptQueue.getState().queue[0]?.id
            if (!target) return
            // 没接手就别转圈：点击被早退路径（切换会话中 / 别的行在发 /
            // 需要二次确认 / stale session）吞掉时不该先转再消。
            const sent = sendQueuedItem(id)
            if (!sent) return
            setQueueSendingId(target)
            void sent.finally(() =>
              setQueueSendingId((cur) => (cur === target ? null : cur)),
            )
          }}
          sendingId={queueSendingId ?? undefined}
          headSteer={headSteer}
          onToggleMode={() => void toggleFollowUpBehavior()}
          togglingMode={togglingFollowUp}
          readonly={guest}
        />
        {/* 排队消息正文的编辑弹窗（store 的 editIndex 打开它）。 */}
        <QueueEditModal />
        {/* 立即发送确认拦截弹窗（有未决提问或权限时二次确认） */}
        <InterjectConfirmModal
          open={interjectTarget != null}
          onClose={() => setInterjectTarget(null)}
          onConfirm={() => {
            const target = interjectTarget
            setInterjectTarget(null)
            if (target) void sendQueuedItem(target.id, true)
          }}
          hasQuestions={useChatStore.getState().xaiRequests.length > 0}
          hasPermissions={useChatStore.getState().pending.length > 0}
        />
        {escHintRow}
        {/* ── TUI follow-up suggestion chips (x.ai/follow_ups, follow_ups.rs) ──
          Turn-end suggestions rendered as a transient row between the
          scrollback and the prompt (TUI: `[ label ]` chips above the prompt
          line). Shown only when the turn is over and nothing is in flight;
          hidden while busy (TUI clears the chips at turn start). Click sends
          the suggestion immediately as a literal model prompt.
        */}
        {!guest && followUps && followUps.length > 0 && !busy && (
          <div
            className="mb-1.5 flex min-h-6 flex-wrap items-center gap-1.5"
            style={{ paddingLeft: COMPOSER_BODY_PAD_LEFT_PX }}
          >
            {followUps.map((f, i) => (
              <button
                key={`${i}-${f.label}`}
                type="button"
                onClick={() => sendFollowUp(f.label)}
                className="inline-flex max-w-full min-h-6 items-center rounded-full bg-gn-bg-dark px-2.5 text-[11px] leading-none transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg sm:min-h-0"
                title="发送该建议"
              >
                <span className="truncate text-gn-fg2">{f.label}</span>
              </button>
            ))}
          </div>
        )}
        <ComposerPrompt
          guest={guest}
          isTouch={isTouch}
          promptFocused={promptFocused}
          borderColor={
            inPlan
              ? promptFocused
                ? 'var(--color-gn-orange)'
                : 'color-mix(in srgb, var(--color-gn-orange) 85%, transparent)'
              : promptFocused
                ? 'var(--color-gn-prompt-border-active)'
                : 'var(--color-gn-prompt-border)'
          }
          captionColor={
            promptFocused
              ? 'color-mix(in srgb, var(--color-gn-fg2) 60%, var(--color-gn-bg-base))'
              : 'color-mix(in srgb, var(--color-gn-fg2) 40%, var(--color-gn-bg-base))'
          }
          prefixColor={
            promptFocused ? 'var(--color-gn-accent-user)' : 'var(--color-gn-gray-dim)'
          }
          stashOn={stashOn}
          composerChromeRef={composerChromeRef}
          taRef={taRef}
          imgPickRef={imgPickRef}
          draft={draft}
          slash={slashState}
          at={atState}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (guest) {
              e.preventDefault()
              return
            }
            onPaste(e)
          }}
          detectAtToken={detectAtToken}
          histOpen={histOpen}
          histItems={histItems}
          histSel={histSel}
          setHistSel={setHistSel}
          setHistOpen={setHistOpen}
          recallHistory={recallHistory}
        >
          <ComposerFooter
            guest={guest}
            promptFocused={promptFocused}
            modelMenu={modelMenu}
            modelOpen={modelOpen}
            setModelOpen={setModelOpen}
            modelMenuPos={modelMenuPos}
            modelRef={modelRef}
            modelBtnRef={modelBtnRef}
            modeMenu={modeMenu}
            modeOpen={modeOpen}
            setModeOpen={setModeOpen}
            modeMenuPos={modeMenuPos}
            modeRef={modeRef}
            modeBtnRef={modeBtnRef}
            currentModeLabel={currentModeLabel}
            currentModeShortLabel={currentModeShortLabel}
            inPlan={inPlan}
          />
        </ComposerPrompt>
      </div>
    </div>
  )
}
