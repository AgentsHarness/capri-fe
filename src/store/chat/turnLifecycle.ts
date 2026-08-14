import type { ContentBlock, ScrollEntry } from '../../api/types'
import { transport } from '../../api/client'
import type { ChatState, SetState } from './types'
import { nid } from './ids'
import { formatElapsed, toolVerb } from './format'
import {
  clearStreamBuf,
  flushLiveStream,
  flushStreamBuf,
  sealAssistantStream,
  sealThought,
} from './stream'
import { isTurnEndLine, turnIsLive, turnMarker } from './turnStatus'

/** Selectable row ids in display order (entries + synthetic group headers). */
export type StreamBufKind = 'thought' | 'assistant'
export function finalizeTurn(
  set: SetState,
  get: () => ChatState,
  stopReason: string | undefined,
): void {
  // 流式缓冲先落库：收口前的最后一段思考文本不能丢（兜底定时器路径
  // 不经 handleEvent，这里统一保证）。
  flushStreamBuf(set, get)
  const turnStart = get().turnStartedAt
  const failedTurn =
    stopReason === 'error' ||
    stopReason === 'rate_limit' ||
    stopReason === 'cancelled'
  // TUI prompt_origin.rs: no-output turns suppress the marker (had_output
  // → None); bash turns (the `!` shell-mode prompt) suppress it too.
  let bashTurn = false
  let hasOutput = false
  for (let i = get().entries.length - 1; i >= 0; i--) {
    const e = get().entries[i]
    if (e.kind === 'user') {
      bashTurn = (e as { isShell?: boolean }).isShell === true
      break
    }
    if (e.kind === 'assistant' || e.kind === 'thought' || e.kind === 'tool') {
      hasOutput = true
      break
    }
  }
  const marker =
    turnIsLive(get()) && !failedTurn && !bashTurn && hasOutput
      ? turnMarker(turnStart != null ? Date.now() - turnStart : undefined)
      : null
  set((s) => {
    // 收口前把 liveStream 文本并入对应条目（流式期间文本在 liveStream，
    // 回合终态必须落回 entry.text；flushLiveStream 同时清空 liveStream）。
    const flushed = flushLiveStream(s)
    return {
      conn: 'ready',
      // Blue "待处理" until the next user message.
      statusText: '待处理',
      awaitingNext: true,
      openAssistantId: undefined,
      openThoughtId: undefined,
      turnStartedAt: undefined,
      currentPromptId: undefined,
      // Turn end: the host resolved every outstanding permission request
      // (approval timeout / completion), so a non-empty pending queue
      // here is stale — drop it (TUI drain_permission_queue).
      pending: [],
      liveStream: null,
      entries: [
        ...settleTurnEntries(flushed.entries),
        ...(marker ? [marker] : []),
      ],
    }
  })
  // 回合终态：刷新 composer 状态条的会话统计（host 侧已把本回合的
  // usage / 耗时落盘，/api/session-stats 重新扫描即可拿到最新值）。
  void get().refreshSessionStats()
}

// ── 收养回合开始（server-authoritative drain）───────────────────────
// agent 在回合结束时自动 pop 队首并开下一回合，广播 queue_changed 带
// running_prompt_id；applyQueueChanged 命中本地镜像行后，这里渲染该
// prompt 的用户行（与 send() 的用户行渲染同款：seal 旧流、append user
// entry、conn busy、pendingOptimisticUserId 供 user_chunk echo 吸收）。
// 绝不调 transport.prompt —— 回合已经在 agent 侧运行，本端只收养显示。
// turnIsLive 守卫：若广播晚于第一批 chunk 到达（回合已在本端流式），
// 跳过渲染，避免双锚定 / 用户行顺序错乱。
export function adoptTurn(
  set: SetState,
  get: () => ChatState,
  adopted: { id: string; text: string; blocks?: ContentBlock[] },
): void {
  if (turnIsLive(get())) return
  flushStreamBuf(set, get)
  // Seal any leftover thought from prior turn, then append the user row.
  const sealedAsst = sealAssistantStream(get())
  const sealed = sealThought(sealedAsst)
  const userId = nid()
  const userEntry = {
    id: userId,
    kind: 'user' as const,
    text: adopted.text,
    ts: Date.now(),
  }
  set({
    ...sealed,
    entries: [...sealed.entries, userEntry],
    openAssistantId: undefined,
    openThoughtId: undefined,
    pendingOptimisticUserId: userId,
    conn: 'busy',
    statusText: 'Waiting for response…',
    awaitingNext: false,
    turnStartedAt: Date.now(),
    // 收养回合的身份 = 权威队列广播的 running_prompt_id（agent 侧
    // queue_meta 同 id）——终端事件按它 exact-pid 匹配。
    currentPromptId: adopted.id,
    // 新回合开始：上一回合的 suggestion chips 退役（与 send 同款）。
    followUps: undefined,
    followUpsResponseId: undefined,
    genRate: undefined,
  })
}

// ── 子代理回合收口兜底（任务 2）────────────────────────────────────
// 主回合的终态事件（done/turn_completed/cancelled/prompt_complete）理论
// 上恒带父会话 sid；但若 agent/宿主把父回合终态归属到子代理会话（已知
// child sid），init 守卫会把它路由进子代理迷你 scrollback，主回合永远
// 等不到自己的 done —— 卡在 "Responding…"。这里在已知子代理 sid 的
// 终态事件到达且父回合仍 live、无未决父活动时，武装一个延迟收口：15 秒
// 内父会话有任何推进事件（chunk/thought/tool/…）即取消（正常流程中父
// 会在子代理结束后继续输出，或自己的终态先到），只有父回合确实被遗留
// 时才触发收口。

export const SUBAGENT_SETTLE_GRACE_MS = 15_000

/** 回合收口事件类型（FE 侧 turn 终态）。 */
export const TURN_TERMINAL_TYPES = new Set([
  'done',
  'turn_completed',
  'cancelled',
  'prompt_complete',
])

/**
 * 父会话自身推进事件：任一到达即视为父回合仍在活动（子代理收口兜底
 * 据此取消）。子代理自身的通知（subagent_spawned/progress/finished）与
 * 连接层事件（hello/ready/status/…）不在此列。
 */
export const PARENT_TURN_ACTIVITY_TYPES = new Set([
  'chunk',
  'thought',
  'tool_call',
  'tool_call_update',
  'image',
  'plan',
  'usage',
  'response_started',
  'reasoning_completed',
  'user_message',
  'user_chunk',
  'done',
  'turn_completed',
  'cancelled',
  'prompt_complete',
  'client_request',
  'client_request_resolved',
  'busy',
  'error',
])

/**
 * 子代理会话自身的推进事件：任一到达即视为该子代理仍在活动（多回合
 * 子代理的下一回合）——撤消上一终态武装的兜底。usage/status 等旁路事件
 * 不算（回合终态后紧跟的 usage 提取不能取消刚武装的兜底）。
 */
export const SUBAGENT_VIEW_ACTIVITY_TYPES = new Set([
  'chunk',
  'thought',
  'tool_call',
  'tool_call_update',
  'user_message',
  'user_chunk',
  'plan',
  'image',
  'response_started',
  'reasoning_completed',
])

export let subagentSettleTimer: number | null = null

export function clearSubagentSettleTimer(): void {
  if (subagentSettleTimer != null) {
    window.clearTimeout(subagentSettleTimer)
    subagentSettleTimer = null
  }
}

/** 父回合是否有未决活动（open 流式条目 / 运行中工具 / 运行中 workflow）。 */
export function parentTurnHasOpenActivity(s: ChatState): boolean {
  if (s.openAssistantId != null || s.openThoughtId != null) return true
  return s.entries.some(
    (e) =>
      (e.kind === 'tool' && (e.status === 'pending' || e.status === 'in_progress')) ||
      (e.kind === 'workflow' && e.running) ||
      (e.kind === 'thought' && e.streaming),
  )
}

/**
 * 武装兜底：已知子代理会话的收口事件到达且父回合 live、无未决父活动时，
 * 延迟收口父回合（触发时再复核一次同样的条件）。同一等待窗口内重复的
 * 终态事件不重复武装。
 */
export function armSubagentTurnSettleFallback(
  set: SetState,
  get: () => ChatState,
): void {
  const s = get()
  if (!turnIsLive(s) || parentTurnHasOpenActivity(s)) return
  if (subagentSettleTimer != null) return
  // 武装时捕获兜底所属的父会话：定时器可能在会话切换之后才触发，而
  // finalizeTurn 作用于当前会话的 conn/entries/streamBuf——跨会话触发
  // 会把刚切换的新会话的活跃回合错误收口。
  const armedSessionId = s.sessionId
  subagentSettleTimer = window.setTimeout(() => {
    subagentSettleTimer = null
    const cur = get()
    // 会话已切换：兜底属于离开的会话，绝不为当前会话收口。
    if (cur.sessionId !== armedSessionId) return
    if (!turnIsLive(cur) || parentTurnHasOpenActivity(cur)) return
    finalizeTurn(set, get, undefined)
  }, SUBAGENT_SETTLE_GRACE_MS)
}

/**
 * HTTP 通道瞬断看门狗（回合级，对应 sendPrompt catch 的路径 2）：POST
 * /api/prompt 的 fetch 在回合中途被网络层拒绝（"Failed to fetch" / 代理
 * reset），但 live 通道（SSE/WS）仍在为同一回合输送事件——错误行是假
 * 警报，回合实际会正常收口，故武装一个兜底：若宽限期内同一回合仍
 * live 且 live 通道已断开（host 真不可达、回合卡死），才补上原错误态
 * （error 行 + conn:'error'）；回合已收口 / 会话已切换 / 新回合已开始 /
 * 通道仍开 → no-op（瞬断自愈或结果已由 live 通道渲染）。
 */
export const TURN_BLIP_GRACE_MS = 10_000

export let turnBlipTimer: number | null = null

export function clearTurnBlipTimer(): void {
  if (turnBlipTimer != null) {
    window.clearTimeout(turnBlipTimer)
    turnBlipTimer = null
  }
}

/**
 * 武装瞬断看门狗。捕获武装时的回合身份（会话 + turnStartedAt）：触发
 * 时同一回合仍 live 才动作——回合已收口 / 新回合已开始 / 会话已切换
 * 都不该补错误态（那会污染已成功收口的视图）。
 */
export function armTurnBlipWatchdog(
  set: SetState,
  get: () => ChatState,
  msg: string,
): void {
  if (turnBlipTimer != null) return
  const armedSessionId = get().sessionId
  const armedTurnStart = get().turnStartedAt
  turnBlipTimer = window.setTimeout(() => {
    turnBlipTimer = null
    const cur = get()
    if (cur.sessionId !== armedSessionId || cur.turnStartedAt !== armedTurnStart) {
      return
    }
    if (!turnIsLive(cur)) return
    // 通道仍开：回合还在正常推进（长工具调用、静默期都可能）——不动。
    if (transport.isLiveOpen()) return
    clearStreamBuf()
    // 看门狗触发时 live 通道已断——live error 事件不会再来，横幅必须
    // 就地设置（host 级失败，会话无关，不进时间线、不写 statusText）。
    get().setLayerError('host', {
      level: 'error',
      message: msg,
      at: Date.now(),
    })
    set({
      ...sealThought(cur),
      pendingOptimisticUserId: undefined,
      conn: 'error',
      statusText: '',
      awaitingNext: false,
      turnStartedAt: undefined,
      currentPromptId: undefined,
    })
  }, TURN_BLIP_GRACE_MS)
}

/**
 * Whether the scrollback tail already ends with a turn-end marker/cue and
 * no content after it. Stored history may carry BOTH response_completed
 * and turn_completed for one turn (hook/recap notifications can sit
 * between them) — the duplicate must not append a second marker/cue.
 * Non-content chrome (status/error lines) is walked past; the first
 * content entry (user/thought/assistant/tool/task/…) ends the scan.
 */
export function tailAlreadyTurnEnded(entries: ScrollEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'status' || e.kind === 'error') continue
    if (e.kind === 'session_event') {
      if (isTurnEndLine(e)) return true
      continue
    }
    return false
  }
  return false
}

/**
 * TUI idle watcher cue (turn_status.rs format_still_running): counts-first,
 * "·"-joined, pluralized kinds, " still running" suffix — e.g.
 * `"2 commands · 1 monitor still running"`. Live rows (running) and
 * restored top-strip tasks (topTasks) count; the host only surfaces
 * liveness-probed tasks, so a restored task is a genuinely running one.
 *
 * A replayed 'started' row WITHOUT its completion is deliberately NOT
 * counted: history replay renders task_backgrounded as a display-only row
 * (running: false on purpose, so the ⠋N chip / running bar never count
 * settled history), and the session file can simply end with that event —
 * the task died with its owner and no task_completed was ever written.
 * The transcript can never settle such a row, so "no completion row" is
 * NOT liveness evidence; the host probe (topTasks) is the only authority
 * for restored tasks. Live rows always pair 'started' with running: true,
 * so counting `running` alone covers the live path.
/** Settle streaming/running entries at turn end (assistant/thought/tool). */
export function settleTurnEntries(entries: ScrollEntry[]): ScrollEntry[] {
  return entries.map((e) => {
    if (e.kind === 'assistant' && e.streaming) return { ...e, streaming: false }
    if (e.kind === 'thought' && e.streaming) {
      // Replay: prefer the server-reported original duration; live falls
      // back to the local startedAt timer (TUI ThinkingBlock::finish
      // freeze order — server time wins, local timer only when absent).
      const elapsed =
        e.elapsedMs != null
          ? formatElapsed(e.elapsedMs)
          : e.startedAt != null
            ? formatElapsed(Date.now() - e.startedAt)
            : e.elapsed
      return {
        ...e,
        streaming: false,
        elapsed,
        displayMode: 'collapsed',
        finishedAt: Date.now(),
      }
    }
    if (e.kind === 'tool' && (e.status === 'pending' || e.status === 'in_progress')) {
      return {
        ...e,
        status: 'completed',
        verb: toolVerb(e.kindName, false),
        finishedAt: Date.now(),
      }
    }
    // Subagents are deliberately NOT settled here, same as bg_task: a
    // subagent without a `subagent_finished` in the loaded history was
    // still running when the snapshot was taken (or its finish is parked
    // in pendingSubagentFinishes until the spawn page replays) — only the
    // finish event ends it. Sealing at turn end would rewrite a genuinely
    // in-flight subagent into a green "Agent done" and drop it from the
    // top running-chip / tasks bar, exactly what the TUI avoids by
    // tracking subagent_sessions independently of the parent turn.
    return e
  })
}
