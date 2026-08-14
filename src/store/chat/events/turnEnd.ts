import type { AcpEvent, ScrollEntry } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { nid } from '../ids'
import { formatTurnDuration, toolVerb } from '../format'
import {
  clearStreamBuf,
  flushLiveStream,
  sealThought,
} from '../stream'
import {
  adoptLiveTurnStart,
  finalizeTurn,
  promptIdMismatch,
  settleTurnEntries,
  tailAlreadyTurnEnded,
  turnEndMarkerText,
  turnIsLive,
} from '../turn'
import { appendEntry } from '../entries'
export function handleTurnEndEvent(
  set: SetState,
  get: () => ChatState,
  ev: AcpEvent,
): boolean {
  switch (ev.type) {
      case 'done': {
        // Live done events carry the owning sessionId. A turn finished in
        // a DIFFERENT session → completion notice + sidebar ✓ only; the
        // seal below belongs to THIS session's turn (without this guard
        // another session's done would wrongly finalize the active one).
        if (ev.sessionId && ev.sessionId !== get().sessionId) {
          get().noteSessionCompleted(ev.sessionId)
          break
        }
        // 无 sid 的 done + 当前无 live 回合 = 别的会话的收口（host 未附
        // sessionId，见模块头 sessionIdFrom 错标注释）——不能 finalize
        // 本视图：本端没有可收的回合，finalize 的副作用（awaitingNext /
        // pending 清空 / statusText 覆盖）都不该落在已完成的会话上。
        if (!ev.sessionId && !turnIsLive(get())) break
        // 回合身份校验：done 的 `meta` = prompt-result `_meta`（agent 回显
        // 客户端 mint 的 promptId）。带非空 pid 且与当前回合不符 → 上一
        // 个回合的迟到 done（RPC 与 live 通道乱序 / hub 缓冲重放）——
        // 不能收口新回合：finalize 的清锚副作用会打断刚发送的回合。
        // 无 pid（旧 host 丢弃 / 旧 shell）→ 退回 legacy 行为。
        if (promptIdMismatch((ev as { meta?: unknown }).meta, get().currentPromptId)) break
        // TUI TurnCompleted marker ("Worked for 2.0s") — the last scrollback
        // line above the composer, mirroring turn_completion.rs. Idempotent:
        // prompt_complete may race ahead and finalize the turn first.
        // NOT for failed/cancelled turns: error/rate_limit get the
        // TurnFailed marker from the x.ai turn_completed rail, cancelled
        // gets its own TurnCancelled marker from the host's cancelled
        // event (TUI prompt_origin.rs stop_reason mapping) — neither
        // renders a "Worked for" line.
        finalizeTurn(set, get, ev.stopReason)
        break
      }
      case 'turn_completed': {
        // Live events carry the owning sessionId. A completion from a
        // DIFFERENT session (that session's turn finished while the user
        // is here) → completion notice + sidebar ✓ only — never touch
        // this session's turn (seal / awaitingNext belong to the active
        // conversation). Replayed history events have no sessionId and
        // fall through to the seal path below.
        //
        // stop_reason: hosts relay it nested in the x.ai `update`; replay
        // normalizes it flat (turnCompletedEvent).
        const upd = ev.update
        const stopReason =
          ev.stopReason ??
          (typeof upd?.stop_reason === 'string' ? upd.stop_reason : undefined)
        const agentResult =
          ev.agentResult ??
          (typeof upd?.agent_result === 'string' ? upd.agent_result : undefined)
        if (ev.sessionId) {
          if (ev.sessionId !== get().sessionId) {
            get().noteSessionCompleted(ev.sessionId)
            break
          }
          // 带当前 sid 的 live 收口但本视图没有 live 回合：host 可能把别的
          // 会话的收口错标成当前会话（sessionIdFrom active 回退，见模块头）。
          // 成功收口直接跳过（finalize 的副作用——awaitingNext/pending 清空
          // ——不该落在已完成的会话上）；失败收口放行——done 对失败回合不
          // 追加标记，本 rail 的 TurnFailed 标记是唯一来源，必须照常渲染。
          if (!turnIsLive(get()) && stopReason !== 'error' && stopReason !== 'rate_limit') {
            break
          }
          // LIVE turn_completed —— 宿主转发的 x.ai 持久化回合终态（rail）。
          // 任务 2：此前该分支只 settle 流式条目、把收口留给 `done`
          // （session/prompt RPC 结果）。但子代理完成后的注入回合
          // （subagent-complete / 调度注入）不经过 ACP session/prompt
          // RPC——`done` 与 `prompt_complete` 都不会来，主对话因此永远
          // 卡在 "Responding…"（实测：父会话在子代理 spawn 后 ~14s 结束
          // 自身回合，随后 agent 以注入 prompt 唤醒父会话产出最终答复，
          // 该注入回合只有 turn_completed、没有 done）。改为在这里直接
          // 收口（rail 收口）；`done` 到达时 turnIsLive 已为 false，
          // finalizeTurn 的标记被守卫跳过，不会出现双标记（幂等）。
          //
          // 失败回合的 TurnFailed 标记仍是本 rail 的职责（done 对
          // error/rate_limit 不追加 "Worked for"，见 finalizeTurn）：
          // 收口后补失败标记，tailAlreadyTurnEnded 去重。
          // 权威回合开始修正：turn_completed 的 update 原样携带 shell
          // 盖章的 turnStartMs —— 队列收养的回合若在收养后立即完成
          // （没有 chunk/thought 可修正），在这里修正后再 finalize，
          // marker 才是真实时长而非 "Worked for 0.0s"。
          // 回合身份校验：live turn_completed 的 `meta` = params._meta
          // （agent 在每个 SessionNotification 上回显 promptId）。带非空
          // pid 且与当前回合不符 → 上一个回合的迟到收口（乱序 / hub 缓冲
          // 重放）——绝不能收养/收口新回合（adoptLiveTurnStart 会把新
          // 回合的锚错改成旧回合的开始时间，时长虚高）。
          if (promptIdMismatch((ev as { meta?: unknown }).meta, get().currentPromptId)) break
          adoptLiveTurnStart(set, get, ev)
          const railEndTs = get().turnStartedAt
          finalizeTurn(set, get, stopReason)
          if (stopReason === 'error' || stopReason === 'rate_limit') {
            if (!tailAlreadyTurnEnded(get().entries)) {
              const { text, warning } = turnEndMarkerText(
                stopReason,
                agentResult,
                railEndTs != null ? Date.now() - railEndTs : undefined,
              )
              appendEntry(set, {
                kind: 'session_event',
                text,
                ...(warning ? { warning } : {}),
              })
            }
          }
          break
        }
        // Replayed history: seal the finished turn's streaming blocks
        // (live turns finalize via `done`). Idempotent — no-op when the
        // turn was already settled (stored history may carry both
        // response_completed and turn_completed for one turn; the
        // tailAlreadyTurnEnded guard skips the duplicate).
        //
        // One marker per closed turn, typed by the stored stop_reason:
        // failed → "Turn failed …", cancelled → "Turn cancelled …",
        // success → "Worked for X" when the envelope meta carries the
        // turn's real start (replayUpdates injects it), plain
        // "Turn completed." otherwise — replay must not fabricate live
        // timing. The idle watcher cue ("N commands still running") is
        // NOT a scrollback line — it lives in the composer turn-status
        // line (TUI turn_status.rs idle arm), gated on awaitingNext.
        // 回合收口：assistant 的 liveStream 文本先并入条目（sealThought
        // 只处理思考；不 flush 的话文本滞留 liveStream，切会话即丢）。
        const flushed = flushLiveStream(get())
        const sealed = sealThought(flushed)
        const settled = settleTurnEntries(sealed.entries)
        if (tailAlreadyTurnEnded(settled)) {
          set({
            ...sealed,
            openAssistantId: undefined,
            openThoughtId: undefined,
            entries: settled,
          })
          break
        }
        const elapsedMs =
          ev.turnStartedAt != null &&
          ev.endMs != null &&
          ev.endMs >= ev.turnStartedAt
            ? ev.endMs - ev.turnStartedAt
            : undefined
        const { text, warning } = turnEndMarkerText(
          stopReason,
          agentResult,
          elapsedMs,
        )
        set({
          ...sealed,
          openAssistantId: undefined,
          openThoughtId: undefined,
          // Idle until the next user message — lets the turn-status line
          // show the still-running cue after a replayed history load.
          awaitingNext: true,
          entries: [
            ...settled,
            {
              id: nid(),
              kind: 'session_event',
              text,
              ...(warning ? { warning } : {}),
            },
          ],
        })
        break
      }
      case 'cancelled': {
        // 多会话广播（host withSid 约定）：非当前会话的 cancelled 直接忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // 无 sid 的 cancelled + 当前无 live 回合 = 别的会话的取消（host
        // 未附 sessionId，见模块头错标注释）：跳过——否则会把本会话的
        // pending/x.ai 卡清空、awaitingNext 置位（副作用属于别人）。
        if (!ev.sessionId && !turnIsLive(get())) break
        // TUI TurnCancelled marker ("Turn cancelled by user in 2.0s.").
        // Idempotent: prompt_complete may have already finalized the turn.
        const turnStart = get().turnStartedAt
        const marker: ScrollEntry | null = turnIsLive(get())
          ? {
              id: nid(),
              kind: 'session_event',
              text:
                turnStart != null
                  ? `Turn cancelled by user in ${formatTurnDuration(Date.now() - turnStart)}.`
                  : 'Turn cancelled.',
            }
          : null
        set((s) => {
          // Merge any live text into its entry first (cancel rewrites the
          // streaming entries; without the flush the text would be lost).
          const flushed = flushLiveStream(s)
          return {
            conn: 'ready',
            statusText: '待处理',
            awaitingNext: true,
            openAssistantId: undefined,
            openThoughtId: undefined,
            turnStartedAt: undefined,
            currentPromptId: undefined,
            xaiRequests: [], // host answered every pending x.ai request already
            pending: [], // …and every pending permission request (turn cancelled)
            // flushLiveStream's liveStream: null rides on the entry merge —
            // zustand set() shallow-merges, so carry it explicitly.
            liveStream: null,
            entries: [
              ...flushed.entries.map((e) => {
              if (e.kind === 'assistant' && e.streaming) {
                return { ...e, streaming: false }
              }
              if (e.kind === 'thought' && e.streaming) {
                return {
                  ...e,
                  streaming: false,
                  finishedAt: Date.now(),
                  displayMode: 'collapsed' as const,
                }
              }
              if (
                e.kind === 'tool' &&
                (e.status === 'pending' || e.status === 'in_progress')
              ) {
                return {
                  ...e,
                  status: 'cancelled',
                  verb: toolVerb(e.kindName, false),
                  finishedAt: Date.now(),
                }
              }
              return e
            }),
            ...(marker ? [marker] : []),
          ],
          }
        })
        // 取消也是回合终态：刷新 composer 状态条统计（usage 已随
        // turn_completed 落盘，取消回合照常计入——host 全量扫描）。
        void get().refreshSessionStats()
        break
      }
      case 'error': {
        // 多会话广播（host withSid 约定）：非当前会话的 error 直接忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // Host withSid 约定：带 sessionId 的 error 是 agent 回合失败——
        // host 只是透传 agent 的错误（如模型 API 400 "Internal Error"），
        // host 本身没坏。渲染成 scrollback 错误行即可，不翻转连接状态、
        // 不进横幅。不带 sessionId 的 error 才是 host 级错误（boot 失败：
        // agent 进程起不来 / initialize / authenticate 失败），进横幅。
        if (ev.sessionId) {
          const s = get()
          set({
            conn: s.conn === 'busy' ? 'ready' : s.conn,
            // source='transport'：host↔agent 传输断了（agent 可能已
            // 不可用）——host 不再自动重启，错误行带「重启」动作按钮；
            // 'agent'/缺省：agent 报错，直接显示错误文本。
            statusText:
              ev.source === 'transport'
                ? 'agent 连接异常，可重启 agent'
                : ev.message,
            turnStartedAt: undefined,
            currentPromptId: undefined,
            entries: [
              ...s.entries,
              {
                id: nid(),
                kind: 'error',
                text: ev.message,
                // 传输级失败的唯一恢复动作是重启 agent，行内可直接触发。
                ...(ev.source === 'transport' ? { action: 'restart-agent' as const } : {}),
              },
            ],
          })
          break
        }
        // Host 级错误（boot 失败等）：横幅是唯一权威位置，时间线不再
        // 追加（全局状态不属于会话历史），statusText 也不写错误文本
        // （stat/composer 不参与，避免三处重复；conn: 'error' 已足以
        // 禁用发送）。statusText 清空是防止 stat 的 status 行在错误态
        // 残留陈旧的连接文案（如"连接中…"）。丢弃未落库的流式缓冲并
        // 取消 rAF（clearStreamBuf 同时 cancelAnimationFrame），避免
        // 残留 flush 在错误态之后把 conn 重新顶回 busy。
        clearStreamBuf()
        get().setLayerError('host', {
          level: 'error',
          message: ev.message,
          at: Date.now(),
        })
        set({
          conn: 'error',
          statusText: '',
          turnStartedAt: undefined,
          currentPromptId: undefined,
        })
        break
      }
      case 'status': {
        // 多会话广播（host withSid 约定）：非当前会话的 status 直接忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        if (ev.sessionId) {
          // 回合级提示（如"连接已断开，本次回复已取消"）：只进 composer
          // 状态行，不进横幅。
          set({ statusText: ev.text })
          break
        }
        // Host 连接级 status（如"连接HOST异常"）：只进横幅 warning，
        // stat/composer 不参与（与 host 错误同政策）。host 侧可带
        // action（如 restart-agent）——该条状态的唯一恢复动作。
        get().setLayerError('host', {
          level: 'warning',
          message: ev.text,
          ...(ev.action === 'restart-agent' ? { action: 'restart-agent' as const } : {}),
          at: Date.now(),
        })
        break
      }
    default:
      return false
  }
  return true
}
