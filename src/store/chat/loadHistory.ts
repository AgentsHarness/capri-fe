import type { ScrollEntry } from '../../api/types'
import { transport } from '../../api/client'
import { applyQueueChanged } from '../promptQueue'
import type { ChatState, SetState } from './types'
import { nid } from './ids'
import {
  clearHistoryWindowBuffer,
  captureAsyncScope,
  isAsyncScopeCurrent,
  runtime,
} from './globals'
import { restorePlanMode } from './modeFlags'
import { formatTurnDuration } from './format'
import { clearSuppressedTools } from './tools'
import { clearStreamBuf, flushLiveStream, sealThought } from './stream'
import { settleTurnEntries } from './turn'
import { spliceBtwEntries } from './btwReplay'
import {
  INITIAL_TURN_LIMIT,
  INITIAL_TURNS,
  applyEntryLiteStats,
  applyEntryMsgSeq,
  findMsgSeqGap,
  historyHasMorePage,
  replayUpdates,
  sortEntriesByMsgSeq,
} from './history'
import {
  historyDetailParam,
  noteHistoryProjection,
  resetToolFillCache,
  schedulePageFill,
} from './historyFill'
import { entryTimestamp } from './entries'
import {
  envelopeAgentTimestampMs,
  envelopeTimestamp,
  eventAgentTimestampMs,
  replayEnvelopeKeys,
  replayEventKeys,
} from './envelopeParse'

/**
 * Replay events received while rebuilding a history snapshot. Timestamp is
 * only a fast path: stored timestamps are normalized to epoch ms, and keys
 * cover tools, plans, images, and other non-text updates without timestamps.
 */
export function replayHistoryWindowBuffer(get: () => ChatState): void {
  const buffered = runtime.historyWindowBuffer
  runtime.historyWindowBuffer = []
  if (buffered.length === 0) return
  const snapTail = runtime.historySnapTail
  const snapshotKeys = runtime.historySnapEventKeys
  for (const ev of buffered) {
    const keys = replayEventKeys(ev)
    let knownInSnapshot = false
    for (const key of keys) {
      const count = snapshotKeys.get(key) ?? 0
      if (count > 0) {
        snapshotKeys.set(key, count - 1)
        knownInSnapshot = true
        break
      }
    }
    if (knownInSnapshot) continue
    const ts = eventAgentTimestampMs(ev)
    if (snapTail != null && ts != null && ts <= snapTail) continue
    // With no comparable timestamp or key, retaining the event is safer than
    // silently losing a tool/plan/image update during the load window.
    get().handleEvent(ev)
  }
}

export async function loadHistory(
  set: SetState,
  get: () => ChatState,
  sessionId: string,
  cwd: string,
  opts: { awaitBeforeReplay?: Promise<void> } = {},
): Promise<void> {
    const loadSid = sessionId
    const scope = captureAsyncScope(get, sessionId, cwd)
    const staleLoad = () =>
      !isAsyncScopeCurrent(get, scope) ||
      get().sessionId !== loadSid ||
      get().cwd !== cwd
    if (staleLoad()) return
    // Reset the scrollback; load only the newest turn (turnIndex: 1).
    // Older turns load on scroll-up via loadMoreHistory — one turn per
    // gesture. Sticky pins the user prompt when it scrolls away; after
    // a prepend it pins the newly loaded turn's user (no pre-fetch of
    // the previous turn for sticky).
    clearSuppressedTools()
    // lite 补全的区间去重集合按「这一批条目」为作用域：重建快照即全部作废
    // （切会话 / rewind 重载 / 刷新都走这里），在途的后台补全一并取消。
    resetToolFillCache()
    // 流式缓冲丢弃：换会话后旧流的文本绝不能落进新 scrollback。
    clearStreamBuf()
    // 调用前锚定了 sessionId，这里不匹配说明调用后、执行前会话已被切走
    // （newSession / resetToEmpty / switchHost）——连 entries 清空都不该
    // 发生，直接收口标志返回。
    if (staleLoad()) return
    set({
      historyOpen: false,
      historyLoading: true,
      historyLoadedAt: undefined,
      historySessionId: sessionId,
      historyCwd: cwd,
      historyTotalCount: undefined,
      historyLoadedCount: 0,
      historyLoadedStart: undefined,
      historyHasMore: false,
      historyLoadingMore: false,
      historyPromptStarts: undefined,
      historyTurnIdx: 0,
      historyLoadError: undefined,
      historyPrependedAt: undefined,
      historyAnchorId: undefined,
      historyProjected: undefined,
      historyOmittedBytes: undefined,
      liteFillBusy: 0,
      entries: [],
      liveStream: null,
      currentStreamStartMs: undefined,
      lastCompletedTurn: undefined,
      openAssistantId: undefined,
      openThoughtId: undefined,
      pendingOptimisticUserId: undefined,
      toolIndex: {},
      pending: [],
      xaiRequests: [],
      diffReview: undefined,
      diffReviewOpen: false,
      memoryFiles: undefined,
      memoryOpen: false,
      subagentIndex: {},
      pendingSubagentFinishes: {},
      subagentChildIndex: {},
      subagentViews: {},
      bgTaskIndex: {},
      // NOTE: topTasks is NOT reset here — continueSession probes the
      // still-running set BEFORE loadHistory, and replayUpdates needs it
      // populated to skip "Task started" rows of running tasks (those
      // live in the top strip only). applyTopTaskProbe replaces the
      // strip contents wholesale (alive filter + additions), so stale
      // entries from a previous session cannot linger.
      // NOTE: gitInfo is NOT reset here. continueSession (and the hello
      // handler) fires refreshGitInfo in parallel with this load, so the
      // branch usually arrives BEFORE this reset runs — wiping it here
      // lost the branch with nothing left to restore it, since a resumed
      // idle session never emits git_head_changed (only a real HEAD change
      // does). Switches blank it up front instead: continueSession's entry
      // set and the hello re-anchor.
      // Permission mode is process-global (follows the agent) — do NOT
      // reset it when swapping sessions. loadHistory used to blank the
      // composer badge for the duration of replay, then only restore
      // localStorage (empty after an agent-restart clear, so a config
      // default of always-approve never came back).
      planMode: false,
      mcpServers: [],
      mcpInit: undefined,
      selectedId: null,
      focusMode: 'prompt',
      expandedGroups: new Set(),
      viewerEntryId: null,
      viewerTask: undefined,
      followUps: undefined,
      followUpsResponseId: undefined,
      // 新会话上下文：清空分层横幅。
      layerErrors: {},
      usage: undefined,
      todoCounts: undefined,
      todos: undefined,
      turnStartedAt: undefined,
      currentPromptId: undefined,
      genRate: undefined,
      // 换会话复位：旧会话的「待处理」标记绝不能在新会话触发 Composer
      // 自动发送；标题/目标/工作流同理是会话级状态，须一并清空。
      awaitingNext: false,
      sessionTitle: undefined,
      goalState: undefined,
      workflowRuns: {},
      scheduledTasks: [],
    })
    try {
      // 首页始终只拉最后 1 轮（turnIndex: INITIAL_TURNS），渲染这一轮。
      // 上一条由用户上滑 loadMoreHistory 按需加载——不再为 sticky 预取
      // 多轮。宿主不返回 promptStarts 时 hasMore 走按条数 offset 兜底。
      let promptStarts: number[] | undefined
      let turnIdx = 0
      // Turn metadata of the newest replayed page (real start time + open
      // flag), used below to restore the in-flight turn timer.
      let replayMeta: {
        turnStartedAt?: number
        turnOpen: boolean
        entryMsgSeq?: Map<string, number>
        entryMsgSeqEnd?: Map<string, number>
        entryLiteOmitted?: Map<string, number>
      } = {
        turnOpen: false,
      }
      // 加载期间会话被切走：放弃本次加载（historyLoading 由下方
      // stale 分支收口），绝不把旧会话的页灌进新视图。
      if (staleLoad()) return
      // turnIndex only — no limit. Capping at INITIAL_TURN_LIMIT used to
      // cut the END of long last turns (agent returns [start, start+limit)),
      // so assistant text / turn_completed after the cap never appeared
      // between that user message and the next. Older turns still page via
      // loadMoreHistory (previousTurnWindow / offset fallback).
      const detail = historyDetailParam(get)
      const r = await transport.loadSessionHistory(sessionId, cwd, {
        turnIndex: INITIAL_TURNS,
        ...(detail ? { detail } : {}),
      })
      if (staleLoad()) return
      // 能力回显：请求过 lite 却没回 projected = 旧 host（本页就是全量，
      // 条目自然不带 lite 字段），停用该 host 的 lite。
      noteHistoryProjection(get, detail != null, r)
      // 并行切会话（continueSession）：快照 fetch 与任务探活同时发出，
      // 但回放应用必须等探活结果（replayUpdates 跳过仍在跑任务的
      // started 行）。探活失败已被调用方内部消化，await 不会抛。
      if (opts.awaitBeforeReplay) {
        await opts.awaitBeforeReplay
        if (staleLoad()) return
      }
      promptStarts = r.promptStarts
      turnIdx =
        promptStarts && promptStarts.length > 0
          ? Math.max(0, promptStarts.length - INITIAL_TURNS)
          : 0
      const updates = r.updates ?? []
      // 页内 msgSeq 连续性自检：页来自 turnIndex 切片，host 归一化序号
      // 会话内密集，正常必须连续（断裂说明 host 归一化/切片异常）。
      if (import.meta.env.DEV) {
        const gap = findMsgSeqGap(updates)
        if (gap) console.warn(`[acp history] 页内 msgSeq 不连续：${gap}`)
      }
      const fetched = updates.length
      const total = r.totalCount ?? 0
      // Normalize every stored timestamp to epoch milliseconds before comparing
      // it with live agentTimestampMs. Build semantic keys as the fallback for
      // events whose payload has no comparable timestamp.
      // 边界必须取 envelope 自己的 _meta.agentTimestampMs（毫秒级）：shell
      // 写盘的粗粒度 timestamp 是秒级取整，最新 envelope 内 chunk 的毫秒
      // 时间戳可能晚于该取整点——刷新时 hub 缓冲回放的细粒度 chunk（与
      // 快照聚合 envelope 关于同一内容）语义键永远不相等，若兜底边界仍用
      // 秒级戳，最新 envelope 覆盖的最后 ~1 秒内容会漏过去重被再次回放，
      // 表现为最后一条 assistant 文本重复。_meta.agentTimestampMs 是该
      // envelope 批内最新 chunk 的时间，批内所有细粒度 chunk 均 <= 它，
      // 边界因此覆盖整个快照；无 _meta 的旧日志回退粗粒度写盘戳。
      let snapTail: number | undefined
      runtime.historySnapEventKeys.clear()
      for (const update of updates) {
        const keyTime =
          envelopeAgentTimestampMs(update) ??
          envelopeTimestamp(update as Parameters<typeof envelopeTimestamp>[0])
        if (keyTime != null && (snapTail == null || keyTime > snapTail)) {
          snapTail = keyTime
        }
        const key = replayEnvelopeKeys(update)
        for (const eventKey of key) {
          runtime.historySnapEventKeys.set(
            eventKey,
            (runtime.historySnapEventKeys.get(eventKey) ?? 0) + 1,
          )
        }
      }
      // Newest page: rebuild from scratch. This page carries the
      // session's FINAL context usage (newest envelope) — the only
      // page allowed to update the context chip.
      replayMeta = replayUpdates(get, updates)
      // 绝对游标：按轮次时最老已加载行 = promptStarts[turnIdx]；
      // 否则视作从尾部加载了 fetched 条 → start = total - fetched。
      // 后续 loadMore 一律用绝对 offset，live 追加抬高 total 也不会重叠。
      const turnBased =
        promptStarts != null && promptStarts.length > 0 && total > 0
      const loadedStart = turnBased
        ? promptStarts![turnIdx]!
        : fetched === 0
          ? total || 0
          : Math.max(0, (total || fetched) - fetched)
      const loaded =
        total > 0 ? Math.max(0, total - loadedStart) : fetched
      // 先把 liveStream 文本并入条目，再按是否仍 open 收口。
      // 切勿在未 flush 时 liveStream:null——thought/assistant 流式期间
      // 正文只在 liveStream，直接清空会留下 text:'' 的空壳；随后
      // loadMore 的首条 user 触发 sealThought 会删掉空壳，length 收缩，
      // 新 user 落入「已加载区」被 merge 甩到时间线末尾。
      const flushed = flushLiveStream(get())
      const sealed = sealThought(flushed)
      // 回放条目补盖信封 msgSeq；全部带 msgSeq 时按其稳定排序（契约：
      // 任一条目缺失则完全保持现有行为，不排序）。lite 投影过的工具行再补
      // 盖 msgSeqEnd / liteOmitted（展开时按区间回拉全量正文的坐标）。
      const stampedEntries = applyEntryLiteStats(
        applyEntryMsgSeq(sealed.entries, replayMeta.entryMsgSeq),
        replayMeta.entryMsgSeqEnd,
        replayMeta.entryLiteOmitted,
      )
      const sortedEntries = sortEntriesByMsgSeq(stampedEntries)
      // 已结束的回合：settle + 清流式指针。仍 open（真·进行中）时保留
      // open*，但 liveStream 已 flush，文本不会丢。
      // /btw 回放记录：host 初始页按窗口附带（btw_history.jsonl），按锚点
      // 缝进时间线；本页窗口之外的锚点随更早页加载（loadMoreHistory）。
      const entries = spliceBtwEntries(
        replayMeta.turnOpen
          ? sortedEntries
          : settleTurnEntries(sortedEntries),
        r.btw ?? [],
      )
      // 按轮次模式：还有更早轮次 ⟺ 游标 > 0；按条数兜底：loadedStart > 0。
      const hasMore = turnBased
        ? turnIdx > 0
        : loadedStart > 0 && historyHasMorePage(total || undefined, loaded, fetched, INITIAL_TURN_LIMIT)
      if (staleLoad()) return
      // snapTail 必须在 historyLoading 落回 false 之前生效：刷新走
      // hello → loadHistory，门控一落，hub gap-pull 的上一轮 live
      // 事件会当新事件进 handleEvent；水位晚于门控的话最后一条会再
      // 画一遍（user_chunk 还会清掉 lastCompletedTurn，整轮复读）。
      runtime.historySnapTail = snapTail
      set({
        historyTotalCount: total || undefined,
        historyLoadedCount: loaded,
        historyLoadedStart: total > 0 || fetched > 0 ? loadedStart : undefined,
        historyHasMore: hasMore,
        historyPromptStarts: promptStarts,
        historyTurnIdx: turnIdx,
        historyProjected: r.projected,
        historyOmittedBytes: r.omittedBytes,
        conn: 'ready',
        entries,
        liveStream: null,
        currentStreamStartMs: replayMeta.turnOpen
          ? get().currentStreamStartMs
          : undefined,
        openAssistantId: replayMeta.turnOpen ? sealed.openAssistantId : undefined,
        openThoughtId: replayMeta.turnOpen ? sealed.openThoughtId : undefined,
      })
      set({
        historyLoading: false,
        // Replay of stored thought chunks drives conn to 'busy'; history is
        // not a live turn — the user must be able to type right away.
        conn: 'ready',
        // In-flight session (replayed tail has no turn_completed): restore
        // the REAL turn start from the envelope timestamps so the timer
        // reads "已进行 Xs" instead of anchoring at replay time. Live
        // events arriving after the replay keep this start (busy keeps
        // turnStartedAt via ??). Closed turns clear it.
        // 恢复回合的 pid 无法从回放推导：置空走 legacy 匹配——残留的
        // 旧 pid 会把该回合自己的 live 终端事件误判成迟到事件（pid
        // 不符被忽略 → 回合卡死）。
        ...(replayMeta.turnOpen
          ? {
              turnStartedAt: replayMeta.turnStartedAt,
              currentPromptId: undefined,
              statusText: replayMeta.turnStartedAt
                ? `回合进行中（已进行 ${formatTurnDuration(
                    Date.now() - replayMeta.turnStartedAt,
                  )}）`
                : '回合进行中',
            }
          : {
              turnStartedAt: undefined,
              currentPromptId: undefined,
              statusText: `历史已加载 (共 ${get().historyTotalCount ?? '?'} 条更新)`,
            }),
        historyLoadedAt: Date.now(),
        // 权限徽标是进程级、只信 agent 回声，历史回放不覆盖。
        // plan 是会话态，从 per-session 副本补充。
        ...restorePlanMode(sessionId),
      })
      // 方案 A：快照重建完成，回放窗口期（historyLoading 期间）缓冲的
      // live 内容事件——busy 会话切换时快照拉取间隙产生的 chunk/
      // thought 不丢。会话已切走时丢弃残留（回放会污染新会话视图）。
      if (staleLoad()) {
        clearHistoryWindowBuffer()
        return
      }
      replayHistoryWindowBuffer(get)
      // 会话级 recap 缓存回填：该会话最近一次摘要（display-only、不
      // 持久化）在跨会话期间到达时只进了 cache——这里在历史重建后
      // 按生成时间就近插回对应对话位置（会话中间生成的 recap 显示在
      // 中间，而不是贴在最末尾）。滚动区已含同文本 recap（live 事件
      // 刚 append 过）则跳过，避免同一视图内重复；entries 重建后
      // 每次都会重新回填，重复加载始终可见。
      const cachedRecap = get().recapCache[loadSid]
      if (
        cachedRecap &&
        !staleLoad() &&
        !get().entries.some(
          (e) =>
            e.kind === 'session_event' && e.recap === true && e.text === cachedRecap.text,
        )
      ) {
        const recapEntry: ScrollEntry = {
          id: nid(),
          kind: 'session_event',
          text: cachedRecap.text,
          recap: true,
          open: true,
        }
        // 定位插入点：最后一条时间戳 <= 生成时刻的条目之后（条目
        // 时间取 ts / startedAt；无时间戳的条目跳过，天然落到邻近
        // 有时间的条目之间）。找不到则插到开头；等于末尾则贴末尾。
        const at = cachedRecap.at
        let insertIdx = -1
        const entries = get().entries
        for (let i = 0; i < entries.length; i++) {
          const t = entryTimestamp(entries[i])
          if (t != null && t <= at) insertIdx = i
        }
        set({
          entries: [
            ...entries.slice(0, insertIdx + 1),
            recapEntry,
            ...entries.slice(insertIdx + 1),
          ],
        })
      }
      // 队列状态不随历史回放（agent 不持久化 pending_inputs、load 不
      // 回放 queue_changed）：主动向 host 拉最近一次广播快照对齐镜像
      // （覆盖断线期间错过的 pop/adoption 广播）。静默失败 —— 拉取只是
      // 尽力纠偏，host 无缓存（agent 重启过）或请求失败时保持现状，
      // 后续 live 广播仍会纠正。拉取发出后若有更新的 live 广播到达
      // （runtime.lastLiveQueueChangedAt > 发出时刻），说明状态已前进，丢弃
      // 旧快照等下一次广播。adoption 返回值忽略：历史回放已渲染过该
      // 回合的用户行，这里只应用镜像更新，绝不重复 adoptTurn。
      const queuePullSentAt = Date.now()
      // 精简回放的后台补全（契约 [E]）：首帧渲染已落，idle 期按同一窗口再拉
      // 一份 detail=full，只把工具正文填回现有行（无预算闸门，失败静默）。
      schedulePageFill(set, get, r, { turnIndex: INITIAL_TURNS })
      void transport
        .queueStatus(sessionId, cwd)
        .then((qr) => {
          if (staleLoad()) return
          if (runtime.lastLiveQueueChangedAt > queuePullSentAt) return
          const qsnap = qr.queue
          if (qsnap && typeof qsnap === 'object') {
            applyQueueChanged(qsnap, sessionId)
          }
        })
        .catch(() => {})
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (staleLoad()) {
        clearHistoryWindowBuffer()
        return
      }
      // 快照失败：无回放基准（continueSession 的 grace timer 会再触发
      // 一次回放，缓冲必须为空才不会误渲染）。重试由调用方重新缓冲。
      clearHistoryWindowBuffer()
      set({
        historyLoading: false,
        conn: 'ready',
        statusText: '历史加载失败',
        historyLoadError: msg,
        ...restorePlanMode(sessionId),
        // 已加载出内容时保留内容 + 内联错误行（就地重试语义）；完全没
        // 加载出来时保持空列表，由 scrollback 中央"加载失败"覆盖层显示。
        entries:
          get().entries.length > 0
            ? [...get().entries, { id: nid(), kind: 'error', text: msg }]
            : [],
      })
    }
  }

