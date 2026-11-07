import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowDownToLine,
  ShieldQuestion,
} from 'lucide-react'
import { formatTurnDuration, stillRunningCue, useChatStore } from '../../store/chat'
import { tailAlreadyTurnEnded } from '../../store/chat/turnLifecycle'
import { transport } from '../../api/client'
import {
  MONITOR_PULSE_FRAMES,
  MONITOR_PULSE_INTERVAL_MS,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
} from '../../theme/glyphs'
import { COMPOSER_BODY_PAD_LEFT_PX } from '../../theme/layout'
import { Spinner } from '../ui/Spinner'
import { guestWaitingLabel, guestWaitingSince as guestWaitingSinceOf } from './guestStatus'
import { currentActivity, HOOK_REVEAL_DELAY_MS } from './activity'
import { SILENCE_PROBE_AFTER_MS, probeHostHeartbeat } from '../../store/chat/actions/hosts'
import { isLastLocalPrompt } from './localPrompt'

/**
 * 显示阈值：hub→host 这一跳可能静默死掉。hub 的 preflight/ack 应在
 * 1.5–3 秒内失败，超过这个窗口仍没回执就把「等响应」改成「等确认」——
 * 判定归 hub，这里只负责别让用户误以为模型在思考。
 */
const SEND_ACK_GRACE_MS = 3_000
/** 静默期间的心跳复探间隔：跟随 busy 心跳一拍一次，误报能被尽快撤掉。
 *  只在 probeDue（busy 且已静默）后生效，空闲时不会打 /api/hosts。 */
const HEARTBEAT_REPROBE_MS = 1_000

/** Composer 回合状态行：busy 活动 / 回放 / 建会话 / 访客等待 / 空闲回执。 */
export function TurnStatusLine({ guest = false }: { guest?: boolean }) {
  const conn = useChatStore((s) => s.conn)
  const historyLoading = useChatStore((s) => s.historyLoading)
  const newSessionPending = useChatStore((s) => s.newSessionPending)
  const genRate = useChatStore((s) => s.genRate)
  const phaseText = useChatStore((s) => s.phaseText)
  const statusText = useChatStore((s) => s.idleStatusLine())
  const recapPending = useChatStore(
    (s) => s.recapPendingFor != null && s.recapPendingFor === s.sessionId,
  )
  const memoryCommand = useChatStore((s) =>
    s.memoryCommandPending && s.memoryCommandPending.sessionId === s.sessionId
      ? s.memoryCommandPending
      : undefined,
  )
  const awaitingNext = useChatStore((s) => s.awaitingNext)
  const entries = useChatStore((s) => s.entries)
  const topTasks = useChatStore((s) => s.topTasks)
  const tasksBarOpen = useChatStore((s) => s.tasksBarOpen)
  const setTasksBarOpen = useChatStore((s) => s.setTasksBarOpen)
  const turnStartedAt = useChatStore((s) => s.turnStartedAt)
  const promptAcceptedAt = useChatStore((s) => s.promptAcceptedAt)
  const currentPromptId = useChatStore((s) => s.currentPromptId)
  const openThoughtId = useChatStore((s) => s.openThoughtId)
  const openAssistantId = useChatStore((s) => s.openAssistantId)
  const runningHook = useChatStore((s) => s.runningHook)
  const selectedHostId = useChatStore((s) => s.selectedHostId)
  const busy = conn === 'busy'
  // 这条请求是否绕 hub 中继。直连本机（纯 local / 本机近路）没有
  // hub→host 这一跳，host 按健康处理——「等回执」「等心跳」两件都只
  // 对中继有意义。
  const viaRelay =
    transport.getConnectionMode() === 'hub' && transport.isLocalDirect() !== true

  // 消息已发出但还没拿到 host 的受理回执（见 SEND_ACK_GRACE_MS）。
  // 必须同时是本端发出的那条回合：host 自己开跑的回合（队列收养 / 历史
  // 回放）没有 promptAcceptedAt，只看这一点会从宽限期起一直谎报在等回执。
  // 静默期没有 live 事件触发渲染，用每秒一拍的 now 推动两个时间判断。
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!busy || !viaRelay) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(t)
  }, [busy, viaRelay])
  const awaitingAck =
    viaRelay &&
    busy &&
    promptAcceptedAt == null &&
    turnStartedAt != null &&
    currentPromptId != null &&
    isLastLocalPrompt(currentPromptId)
  const unconfirmedSend =
    awaitingAck && now - (turnStartedAt ?? 0) > SEND_ACK_GRACE_MS

  /**
   * host 心跳探针（见 hosts.ts 的 SILENCE_PROBE_AFTER_MS）。
   *
   * 只在「busy 且已经很久没有 live 事件」时查 /api/hosts，用它区分
   * 「host 在思考」与「host 已经不出声了」。静默期间按拍复探，结论只影响
   * 提示文案，不改回合状态——判定归 hub，这里只是先于 host-offline 的
   * 宣告把「连接中断」告诉用户。
   */
  const lastLive = transport.lastLiveEventAt()
  const silenceBase = Math.max(turnStartedAt ?? 0, lastLive ?? 0)
  const silenceFor = busy && silenceBase > 0 ? now - silenceBase : 0
  // 心跳是 hub 维护的（lastSeen），直连本机不看它：默认 host 没问题。
  const probeDue = viaRelay && busy && silenceFor >= SILENCE_PROBE_AFTER_MS
  const [hostSilent, setHostSilent] = useState(false)
  const lastProbeAt = useRef(0)
  const probeSeq = useRef(0)
  useEffect(() => {
    if (!probeDue) {
      // 回合结束 / 事件恢复流动：下一次静默重新探。
      lastProbeAt.current = 0
      // 只在真有值时清，避免每次渲染都 setState 触发新一轮 effect。
      setHostSilent((v) => (v ? false : v))
      return
    }
    // 静默期间持续复探（跟随 busy 心跳一拍一次）：一次长 GC / 丢包 /
    // 睡眠唤醒不能让「连接中断」钉死在本回合剩余时间里；新心跳一到，下一次
    // 探针就翻回 alive 并撤掉提示。
    if (Date.now() - lastProbeAt.current < HEARTBEAT_REPROBE_MS) return
    lastProbeAt.current = Date.now()
    // 只让最新一次探针写结论：晚到的旧探针不能覆盖新结论。
    const seq = ++probeSeq.current
    void probeHostHeartbeat(selectedHostId).then((verdict) => {
      if (seq === probeSeq.current) setHostSilent(verdict === 'silent')
    })
  }, [probeDue, silenceBase, now, selectedHostId])

  /** 「转入后台」请求在飞：图标换成转圈，避免重复发同一笔。 */
  const [bgSending, setBgSending] = useState(false)
  /** 取消回合请求在飞（状态行的 `[stop]`）：图标换转圈并锁住重复点击。 */
  const [cancelling, setCancelling] = useState(false)

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
  // ── 访客状态（只读）──
  // 访客壳不挂审批/提问卡（他不是审批人），状态改由这一行承担：在跑 / 在等
  // 管理员 / 空闲。数据来自 hub 的 /api/status（按会话过滤过的摘要），刷新
  // 时机见 refreshGuestStatus 的调用点。管理员两条选择器恒为 undefined，
  // 下面的分支照旧走原来的活动臂。
  const guestSessionState = useChatStore((s) => s.guestSessionState)
  const refreshGuestStatus = useChatStore((s) => s.refreshGuestStatus)
  const sessionId = useChatStore((s) => s.sessionId)
  const guestWaitingNow = guestSessionState?.pendingInput != null
  const guestTick = useCallback(() => {
    void refreshGuestStatus()
  }, [refreshGuestStatus])
  useEffect(() => {
    if (!guest || !sessionId) return
    // 挂载 / 切会话立刻拉一次；之后等待中/运行中跟得快（下一秒可能变），
    // 空闲才降速。切回前台标签页补一次：后台期间定时器被浏览器节流，回来
    // 时那一屏状态可能已经是十几分钟前的。
    guestTick()
    const t = window.setInterval(guestTick, guestWaitingNow ? 5000 : 15000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') guestTick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [guest, sessionId, guestWaitingNow, guestTick])
  // Busy arm: dynamic activity label (newest running tool / thinking /
  // streaming reply) with its phase timer — TUI turn_status.rs activity
  // arm. Falls back to the static statusText when nothing is running.
  // Phase timer anchors: the activity's own start stamp when it has one
  // (thought / tool / subagent / streaming reply); stamp-less phases
  // (bg-task waits, no-activity "Waiting for response…" windows) anchor
  // at the moment the phase became current — so a mid-turn wait counts
  // from when the last entry ended, not from the turn start.
  //
  // A freshly armed hook batch is deliberately invisible until it outlives
  // HOOK_REVEAL_DELAY, so a fast hook never flashes a "Running … hook" phase.
  // `hookTick` only forces the re-render that lands on that deadline; the
  // rule itself lives in currentActivity.
  const [hookTick, setHookTick] = useState(0)
  useEffect(() => {
    if (!runningHook) return
    const wait = runningHook.startedAt + HOOK_REVEAL_DELAY_MS - Date.now()
    if (wait <= 0) return
    const t = window.setTimeout(() => setHookTick((v) => v + 1), wait)
    return () => window.clearTimeout(t)
  }, [runningHook])
  const activity = useMemo(
    () => currentActivity(entries, runningHook, Date.now()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, runningHook, hookTick],
  )
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
  // 访客唯一特殊的一段：会话卡在等客户端应答时，他没有卡片可点，只能看到
  // 一句话。其余（活动标签、相位计时、statusText 的每一处写入）与管理员的
  // 状态行完全共用——所以这里只替换文案与配色，不另起一套渲染。
  //
  // 回放/建会话优先：那两种状态下"等应答"是上一个会话的残留读数（切换时
  // resetSessionState 已清 guestSessionState，这里是双保险），不能盖住
  // 「回放中…」。
  const guestWaiting =
    guest && !historyLoading && !newSessionPending
      ? guestWaitingLabel(guestSessionState)
      : undefined
  const guestWaitingSince = guest ? guestWaitingSinceOf(guestSessionState) : undefined
  // 会话切换加载中（historyLoading）状态行固定显示「回放中…」而不是
  // 旧会话的 busy/状态（避免加载期间显示误导性的活动标签）：见下方
  // 状态行渲染。statusVisible 只决定「加载结束后」该不该显示——加载
  // 期间内容就是回放臂，加载完毕立即切换真实状态。error/offline 不在
  // 其中：host/hub 错误只进顶栏 host 提示（LayerErrNotice），composer 状态行
  // 不参与，避免与它重复。
  const statusVisible =
    !historyLoading &&
    (busy ||
      conn === 'connecting' ||
      recapPending ||
      memoryCommand != null ||
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


  return (
    <>
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
          {(statusVisible || historyLoading || newSessionPending || guestWaiting != null) && (
          <div
            className="flex min-h-5 items-center gap-1.5 pb-2 pr-0.5 font-ui text-[13.5px] leading-[1.4] select-none"
            style={{ paddingLeft: COMPOSER_BODY_PAD_LEFT_PX }}
            // 访客：等他之外的「Human」时这行是唯一可见反馈，标成 status /
            // polite 让读屏也能听到状态翻转。其余情况与管理员的渲染一致。
            {...(guest ? { role: 'status', 'aria-live': 'polite' as const } : {})}
          >
            {guestWaiting != null ? (
              // 访客的「等 Human」臂：管理员在这时看到的是审批/提问/计划
              // 卡片本身，访客没有那张卡，只能看到这一句。
              <>
                <span className="inline-flex w-[1.25em] shrink-0 items-center justify-center leading-none text-gn-yellow">
                  <ShieldQuestion size={12} strokeWidth={2.2} aria-hidden />
                </span>
                <span className="min-w-0 truncate text-gn-yellow" title={guestWaiting}>
                  {guestWaiting}
                </span>
                {guestWaitingSince != null && (
                  <span className="shrink-0 tabular-nums text-gn-gray">
                    {formatTurnDuration(Math.max(0, Date.now() - guestWaitingSince))}
                  </span>
                )}
                <span className="flex-1" />
                <span className="hidden shrink-0 text-[11px] text-gn-gutter sm:inline">
                  只读 · 由会话所有者应答
                </span>
              </>
            ) : newSessionPending ? (
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
                        color: hostSilent
                          ? 'var(--color-gn-warning)'
                          : activity?.color ??
                            (phaseText === 'Cancelling…'
                              ? 'var(--color-gn-red)'
                              : 'var(--color-gn-gray-dim)'),
                      }}
                    >
                      {hostSilent
                        ? // 心跳停了：直播大概率已经断了，只是 hub 还没宣告。
                          // 说清"没在等模型"，避免用户一直干等。
                          'Host 连接中断，正在重连…'
                        : activity?.label ??
                          (localLive && !busy
                            ? '回合进行中'
                            : // 已发出但 host 还没回 200：hub 中继要等 host 受理，
                              // 这一段没有 live 事件也没有 ack，与其显示
                              // "Waiting for response…"（看着像模型在思考），
                              // 不如直说在等确认。
                              unconfirmedSend
                              ? '等待 Host 确认送达…'
                              : phaseText)}
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
                ) : memoryCommand ? (
                  // TUI 命令状态行（turn_status.rs CommandRunning）：
                  // `Flushing memory…` / `Consolidating memory…` + 计时。
                  <>
                    <span className="truncate text-gn-gray-dim">
                      {memoryCommand.label}
                    </span>
                    <span className="shrink-0 tabular-nums text-gn-gray">
                      {formatTurnDuration(Date.now() - memoryCommand.startedAt)}
                    </span>
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
                  // 空闲臂：操作回执优先，没有回执才显示连接/阶段文案。
                  // error/offline 不在此渲染（错误只进顶栏 host 提示）。
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
                    className="flex items-center gap-0.5 tabular-nums text-gn-gray"
                    title={`生成速度 ≈${genRateLabel} 字符/s（host 推送的 gen_rate 字符吞吐；只在输出过程中显示，输出结束清除）`}
                  >
                    <ArrowDown size={10} aria-hidden />
                    {genRateLabel}c
                  </span>
                )}
                {/* [↓] send-to-background (TUI DemoteToBackground) — hover
                    label "send to bg", accent_running on hover. 访客只读：
                    转后台是写操作（x.ai/terminal/background），不渲染。 */}
                {runningExecute && !guest && (
                  <button
                    type="button"
                    title="将当前命令转入后台继续运行（TUI [send to bg]）"
                    disabled={bgSending}
                    onClick={() => {
                      const toolCallId = runningExecute.toolCallId!
                      setBgSending(true)
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
                        .finally(() => setBgSending(false))
                    }}
                    className="flex items-center rounded p-1 text-gn-gray hover:bg-gn-bg-highlight hover:text-gn-cyan min-h-6 sm:min-h-0 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="将当前命令转入后台"
                  >
                    {bgSending ? <Spinner size={12} /> : <ArrowDownToLine size={12} aria-hidden />}
                  </button>
                )}
                {busy && !guest && (
                  <button
                    type="button"
                    disabled={cancelling}
                    onClick={() => {
                      setCancelling(true)
                      // requestCancelTurn 在「有偏好 / 无子代理」时直接发
                      // cancel 请求，有子代理时只打开面板——两种都等它返回。
                      void Promise.resolve(useChatStore.getState().requestCancelTurn()).finally(
                        () => setCancelling(false),
                      )
                    }}
                    className="rounded px-1.5 py-[2px] text-gn-gray hover:bg-gn-bg-highlight hover:text-gn-red min-h-6 sm:min-h-0 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {cancelling ? <Spinner size={11} /> : '[stop]'}
                  </button>
                )}
              </>
            )}
          </div>
          )}
        </div>
    </>
  )
}
