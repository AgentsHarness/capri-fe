import type { ScrollEntry } from '../../api/types'
import { transport } from '../../api/client'
import { applyQueueChanged } from '../promptQueue'
import type { ChatState, SetState } from './types'
import { nid } from './ids'
import {
  clearHistoryWindowBuffer,
  runtime,
} from './globals'
import { restorePlanMode } from './modeFlags'
import { formatTurnDuration } from './format'
import { clearSuppressedTools } from './tools'
import { clearStreamBuf, flushLiveStream, sealThought } from './stream'
import { settleTurnEntries } from './turn'
import {
  INITIAL_TURN_LIMIT,
  INITIAL_TURNS,
  historyHasMorePage,
  replayUpdates,
} from './history'
import { entryTimestamp } from './entries'

/**
 * 快照重建完成后回放窗口期缓冲的 live 内容事件（见 globals.ts）。
 * 过滤规则：仅回放带 agentTimestampMs 且生成时刻晚于快照末尾写盘
 * 时间戳的事件（同一 agent 时钟域，必然不在快照里）；无有效快照
 * 基准（snapTail 非 number）或事件无时间戳 / 早于快照末尾时无法
 * 判定是否已入快照，全部丢弃（不重复渲染，也不比旧行为更差）。
 */
export function replayHistoryWindowBuffer(get: () => ChatState): void {
  const buffered = runtime.historyWindowBuffer
  runtime.historyWindowBuffer = []
  if (buffered.length === 0) return
  const snapTail = runtime.historySnapTail
  if (typeof snapTail !== 'number') return
  for (const ev of buffered) {
    const ts = (ev as { agentTimestampMs?: unknown }).agentTimestampMs
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue
    if (ts <= snapTail) continue
    get().handleEvent(ev)
  }
}

export async function loadHistory(
  set: SetState,
  get: () => ChatState,
  sessionId: string,
  cwd: string
): Promise<void> {
    // Reset the scrollback; load only the newest turn (turnIndex: 1).
    // Older turns load on scroll-up via loadMoreHistory — one turn per
    // gesture. Sticky pins the user prompt when it scrolls away; after
    // a prepend it pins the newly loaded turn's user (no pre-fetch of
    // the previous turn for sticky).
    clearSuppressedTools()
    // 流式缓冲丢弃：换会话后旧流的文本绝不能落进新 scrollback。
    clearStreamBuf()
    // 本次加载的会话锚：加载期间视图可能已切走（newSession / resetToEmpty /
    // switchHost / 窗口期 hello 重锚）——完成时校验，绝不把旧会话的历史
    // 与 turnStartedAt 灌进新会话的空白时间线（否则新会话第一条消息会被
    // turnIsLive 误判而错误排队；历史本身也会污染新会话视图）。
    const loadSid = sessionId
    const staleLoad = () => get().sessionId !== loadSid
    // 入口即校验：调用方（hello / continueSession / rewind / peer）都在
    // 调用前锚定了 sessionId，这里不匹配说明调用后、执行前会话已被切走
    // （newSession / resetToEmpty / switchHost）——连 entries 清空都不该
    // 发生，直接收口标志返回。
    if (staleLoad()) {
      clearHistoryWindowBuffer()
      set({ historyLoading: false, historyLoadingMore: false })
      return
    }
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
      entries: [],
      liveStream: null,
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
      gitInfo: undefined,
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
      let replayMeta: { turnStartedAt?: number; turnOpen: boolean } = {
        turnOpen: false,
      }
      // 加载期间会话被切走：放弃本次加载（historyLoading 由下方
      // stale 分支收口），绝不把旧会话的页灌进新视图。
      if (staleLoad()) {
        clearHistoryWindowBuffer()
        set({ historyLoading: false, historyLoadingMore: false })
        return
      }
      // turnIndex only — no limit. Capping at INITIAL_TURN_LIMIT used to
      // cut the END of long last turns (agent returns [start, start+limit)),
      // so assistant text / turn_completed after the cap never appeared
      // between that user message and the next. Older turns still page via
      // loadMoreHistory (previousTurnWindow / offset fallback).
      const r = await transport.loadSessionHistory(sessionId, cwd, {
        turnIndex: INITIAL_TURNS,
      })
      if (staleLoad()) {
        set({ historyLoading: false, historyLoadingMore: false })
        return
      }
      promptStarts = r.promptStarts
      turnIdx =
        promptStarts && promptStarts.length > 0
          ? Math.max(0, promptStarts.length - INITIAL_TURNS)
          : 0
      const updates = r.updates ?? []
      const fetched = updates.length
      const total = r.totalCount ?? 0
      // 快照末尾 envelope 的写盘时间戳（agent 时钟域）：窗口期缓冲
      // 回放的去重基准——live 事件生成时刻晚于它的必然不在快照里
      // （落盘 ≥ 生成），可安全回放；早于它的可能已在快照中，跳过。
      let snapTail: number | undefined
      for (let i = updates.length - 1; i >= 0; i--) {
        const u = updates[i] as { timestamp?: unknown } | undefined
        if (u && typeof u.timestamp === 'number' && Number.isFinite(u.timestamp)) {
          snapTail = u.timestamp
          break
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
      // 已结束的回合：settle + 清流式指针。仍 open（真·进行中）时保留
      // open*，但 liveStream 已 flush，文本不会丢。
      const entries = replayMeta.turnOpen
        ? sealed.entries
        : settleTurnEntries(sealed.entries)
      // 按轮次模式：还有更早轮次 ⟺ 游标 > 0；按条数兜底：loadedStart > 0。
      const hasMore = turnBased
        ? turnIdx > 0
        : loadedStart > 0 && historyHasMorePage(total || undefined, loaded, fetched, INITIAL_TURN_LIMIT)
      set({
        historyTotalCount: total || undefined,
        historyLoadedCount: loaded,
        historyLoadedStart: total > 0 || fetched > 0 ? loadedStart : undefined,
        historyHasMore: hasMore,
        historyPromptStarts: promptStarts,
        historyTurnIdx: turnIdx,
        conn: 'ready',
        entries,
        liveStream: null,
        openAssistantId: replayMeta.turnOpen ? sealed.openAssistantId : undefined,
        openThoughtId: replayMeta.turnOpen ? sealed.openThoughtId : undefined,
      })
      if (staleLoad()) {
        // 会话已切走：只收口 loading 标志，不动 entries / conn /
        // turnStartedAt / statusText ——新会话的状态由自己的锚定负责。
        clearHistoryWindowBuffer()
        set({ historyLoading: false, historyLoadingMore: false })
        return
      }
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
      runtime.historySnapTail = snapTail
      if (!staleLoad()) {
        replayHistoryWindowBuffer(get)
      } else {
        clearHistoryWindowBuffer()
      }
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
        // 会话已切走：失败信息属于旧会话，收口标志即可，不渲染错误行。
        clearHistoryWindowBuffer()
        set({ historyLoading: false, historyLoadingMore: false })
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

