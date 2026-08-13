import type { AcpEvent, ScrollEntry } from '../../api/types'
import {
  projectDisplayRows,
  scanGroups,
} from '../../scrollback/verbGroup'
import type { ChatState, SetState } from './types'
import { nid } from './ids'
import { formatTurnDuration } from './format'

/** Selectable row ids in display order (entries + synthetic group headers). */
export function selectableRowIds(
  entries: ScrollEntry[],
  expandedGroups: ReadonlySet<string>,
): string[] {
  const spans = scanGroups(entries, expandedGroups)
  const rows = projectDisplayRows(entries, spans)
  return rows.map((r) => (r.type === 'entry' ? r.entry.id : r.id))
}

/** Whether a turn is currently live and needs a terminal marker/finalize. */
export function turnIsLive(s: ChatState): boolean {
  return s.turnStartedAt != null || s.conn === 'busy' || s.openThoughtId != null
}

/**
 * Roster corroboration for the turn-status line: the host's session list
 * (`sessions[].status.busy`, refreshed on sessions_changed / on demand)
 * says the given session has an in-flight turn. Used to attribute
 * status-rail events (busy/done) whose sessionId the host may have
 * mis-tagged — the host's sessionIdFrom falls back to the ACTIVE session
 * during multi-session switching (see the module header), so an event
 * tagged like the current session (or untagged) can actually belong to a
 * background session. Envelope-backed events (chunk/thought/tool_call/…)
 * carry the session id from the update envelope and are trustworthy; the
 * synthesized status rails are the ones that need this check.
 */
export function rosterSessionBusy(s: ChatState, sessionId?: string): boolean {
  if (!sessionId) return false
  return s.sessions.some(
    (x) => x.sessionId === sessionId && x.status?.busy === true,
  )
}

/**
 * Whether a `busy` notification plausibly belongs to the CURRENT view.
 * Busy events are host-synthesized; their sessionId can be missing or
 * mis-tagged as the active session while the busy turn actually belongs
 * to a background session. Only accept when the current view really has
 * a turn in flight: a live local turn (turnIsLive — send() / adoptTurn /
 * streaming already armed it), a send awaiting its first echo
 * (pendingOptimisticUserId), or the roster corroborating that the
 * current session is busy. Otherwise the busy is another session's —
 * applying it would paint that session's turn status (spinner + phase
 * timer) onto e.g. a completed conversation, stuck until the foreign
 * turn's done arrives.
 */
export function busyPlausibleForView(s: ChatState): boolean {
  return (
    turnIsLive(s) ||
    s.pendingOptimisticUserId != null ||
    rosterSessionBusy(s, s.sessionId)
  )
}

/**
 * 从 live 事件提取 shell 盖章的权威回合开始时间（`turnStartMs`，epoch
 * ms）。live wire 载体：chunk / user_chunk / thought 由 host 从
 * params._meta 显式透传为顶层 `turnStartMs`；turn_completed 的 `meta`
 * 即 params._meta（NotificationMeta），直接读它。与回放路径同源 ——
 * agent 在每个流式 update 上盖章。
 */
export function liveTurnStartMs(ev: AcpEvent): number | undefined {
  const anyEv = ev as {
    turnStartMs?: unknown
    fullUpdate?: { _meta?: unknown }
    meta?: unknown
    update?: { _meta?: unknown }
  }
  let raw: unknown = anyEv.turnStartMs
  if (raw == null) {
    const meta =
      anyEv.meta ?? anyEv.fullUpdate?._meta ?? anyEv.update?._meta
    if (meta && typeof meta === 'object') {
      const m = meta as Record<string, unknown>
      raw = m.turnStartMs ?? m.turn_start_ms
    }
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw
  if (typeof raw === 'string') {
    const p = Date.parse(raw)
    if (Number.isFinite(p) && p > 0) return p
  }
  return undefined
}

/**
 * 采纳权威回合开始时间（live 通道）。shell 盖的 turnStartMs 只在回合
 * 锚定期内生效（turnStartedAt 非空，防收口后迟到事件污染下一回合）：
 * 修正 adoptTurn / 断线重连用本地时刻锚定的误差 —— 队列收养的回合
 * 真实开始远早于收养时刻（agent 早就 pop 开跑），不修正会渲染
 * "Worked for 0.0s" 之类的假时长。
 */
export function adoptLiveTurnStart(
  set: SetState,
  get: () => ChatState,
  ev: AcpEvent,
): void {
  const ts = liveTurnStartMs(ev)
  if (ts == null || get().turnStartedAt == null) return
  set({ turnStartedAt: ts })
}

/**
 * 从终端事件载体提取回合 pid（agent 在 PromptResponse 与每个
 * SessionNotification 的 `_meta` 上回显客户端 mint 的 promptId）：
 * - done：顶层 `meta` = prompt-result `_meta`（host 原样透传）
 * - prompt_complete：params 顶层 `promptId`/`prompt_id`，或 `_meta` 内
 * - live turn_completed：顶层 `meta` = params._meta
 * 空 / 缺失 = 旧 shell（lost-response fix 之前），无回合身份信息。
 */
export function eventPromptId(root: unknown): string | undefined {
  const read = (o: unknown): string | undefined => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined
    const rec = o as Record<string, unknown>
    for (const k of ['promptId', 'prompt_id']) {
      const v = rec[k]
      if (typeof v === 'string' && v) return v
    }
    return undefined
  }
  if (!root || typeof root !== 'object') return undefined
  const o = root as Record<string, unknown>
  return read(o) ?? read(o._meta) ?? read(o.meta)
}

/**
 * 回合身份校验（TUI finalize_turn_from_terminal / arm_driver_turn_end_reconcile
 * 的 exact-pid 匹配语义）：事件带非空 pid、本端也知道当前回合 pid、
 * 两者不符 → 上一个回合的迟到/错标终端事件，调用方必须忽略（否则会
 * 把刚锚定的新回合立即收口——finalize 的清锚副作用 + "Worked for 0.0s"
 * 假标记）。任一缺失 → 无法判定，放行 legacy 行为。
 */
export function promptIdMismatch(
  root: unknown,
  currentPid: string | undefined,
): boolean {
  if (!currentPid) return false
  const evPid = eventPromptId(root)
  return evPid != null && evPid !== '' && evPid !== currentPid
}

/**
 * TUI "Worked for Xs" marker entry. `elapsedMs` undefined → plain
 * "Turn completed." (TUI TurnCompleted with no elapsed).
 */
export function turnMarker(elapsedMs: number | undefined): ScrollEntry {
  return {
    id: nid(),
    kind: 'session_event',
    text:
      elapsedMs != null
        ? `Worked for ${formatTurnDuration(elapsedMs)}`
        : 'Turn completed.',
  }
}

/**
 * Turn-end marker text for a finished turn — TUI session_event message()
 * parity (session_event.rs): TurnFailed / TurnCancelled / TurnCompleted
 * forms, each with or without an elapsed duration. Failed turns carry the
 * warning accent (amber), same as the x.ai notification rail.
 */
export function turnEndMarkerText(
  stopReason: string | undefined,
  agentResult: string | undefined,
  elapsedMs: number | undefined,
): { text: string; warning?: boolean } {
  if (stopReason === 'error' || stopReason === 'rate_limit') {
    const err =
      stopReason === 'error' ? agentResult || 'unknown error' : 'rate limited'
    return {
      text:
        elapsedMs != null
          ? `Turn failed in ${formatTurnDuration(elapsedMs)}: ${err}`
          : `Turn failed: ${err}`,
      warning: true,
    }
  }
  if (stopReason === 'cancelled') {
    return {
      text:
        elapsedMs != null
          ? `Turn cancelled by user in ${formatTurnDuration(elapsedMs)}.`
          : 'Turn cancelled.',
    }
  }
  return {
    text:
      elapsedMs != null
        ? `Worked for ${formatTurnDuration(elapsedMs)}`
        : 'Turn completed.',
  }
}

/** Whether a scrollback entry is a turn-end marker or still-running cue. */
export function isTurnEndLine(e: ScrollEntry): boolean {
  return (
    e.kind === 'session_event' &&
    (e.text === 'Turn completed.' ||
      e.text.startsWith('Turn cancelled') ||
      e.text.startsWith('Turn failed') ||
      e.text.startsWith('Worked for ') ||
      e.text.endsWith(' still running'))
  )
}

// ── 流式文本合并缓冲（rAF flush）────────────────────────────
// Pipeline: SSE → streamBuf (rAF) → liveStream → flushLiveStream → entry.text
//
// 移动端思考/回答流渲染卡顿主因：每个 SSE chunk 一次 set() + 一次完整
// 渲染 + 两次强制布局。chunk 文本先落进模块级缓冲，requestAnimationFrame
// 统一落库（每帧至多一次 set()）。顺序保证：handleEvent 入口对"非同类
// 流式事件"强制先 flush——tool_call/chunk/回合终态等收口类事件处理前，
// 缓冲的思考文本必已写入 liveStream（再由边界路径 flushLiveStream 入条目）。
