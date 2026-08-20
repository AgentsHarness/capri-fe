import { transport } from '../../api/client'
import type { ChatState, SetState } from './types'
import { flushLiveStream, flushStreamBuf, sealThought } from './stream'
import { settleTurnEntries } from './turnLifecycle'
import { captureAsyncScope, isAsyncScopeCurrent } from './globals'
import {
  MAX_AUTO_FETCH_ENTRIES,
  adaptivePageSize,
  countUserMessages,
  previousTurnWindow,
  remapTurnIdx,
  replayUpdates,
} from './history'

type LiveReplayState = Pick<
  ChatState,
  | 'entries'
  | 'liveStream'
  | 'openAssistantId'
  | 'openThoughtId'
  | 'currentStreamStartMs'
  | 'lastCompletedTurn'
  | 'conn'
  | 'statusText'
  | 'awaitingNext'
  | 'turnStartedAt'
  | 'currentPromptId'
  | 'pendingOptimisticUserId'
  | 'lastSentPromptId'
  | 'genRate'
  | 'pending'
  | 'xaiRequests'
  | 'usage'
  | 'todoCounts'
  | 'todos'
  | 'planMode'
  | 'followUps'
  | 'followUpsResponseId'
  | 'toolIndex'
>

function captureLiveReplayState(s: ChatState): LiveReplayState {
  return {
    entries: s.entries,
    liveStream: s.liveStream,
    openAssistantId: s.openAssistantId,
    openThoughtId: s.openThoughtId,
    currentStreamStartMs: s.currentStreamStartMs,
    lastCompletedTurn: s.lastCompletedTurn,
    conn: s.conn,
    statusText: s.statusText,
    awaitingNext: s.awaitingNext,
    turnStartedAt: s.turnStartedAt,
    currentPromptId: s.currentPromptId,
    pendingOptimisticUserId: s.pendingOptimisticUserId,
    lastSentPromptId: s.lastSentPromptId,
    genRate: s.genRate,
    pending: s.pending,
    xaiRequests: s.xaiRequests,
    usage: s.usage,
    todoCounts: s.todoCounts,
    todos: s.todos,
    planMode: s.planMode,
    followUps: s.followUps,
    followUpsResponseId: s.followUpsResponseId,
    toolIndex: s.toolIndex,
  }
}
export async function loadMoreHistory(
  set: SetState,
  get: () => ChatState,
  anchorId?: string,
  chainedPages?: number
): Promise<void> {
    const s = get()
    if (
      s.historyLoading ||
      s.historyLoadingMore ||
      !s.historyHasMore ||
      !s.historySessionId ||
      !s.historyCwd
    ) {
      return
    }
    // 续翻归属校验：链式翻页期间会话被切走（newSession 清 historySessionId）
    // 即停，绝不把旧会话的页继续灌进新会话。
    const sid = s.historySessionId
    const scope = captureAsyncScope(get, sid, s.historyCwd)
    const isCurrent = () =>
      isAsyncScopeCurrent(get, scope) &&
      get().historySessionId === sid &&
      get().historyCwd === s.historyCwd
    const chained = chainedPages ?? 0
    // 已加载区最老行（绝对下标）。缺失时用 total-loaded 兜底（旧状态）。
    const loadedStart =
      s.historyLoadedStart ??
      (typeof s.historyTotalCount === 'number' && s.historyTotalCount > 0
        ? Math.max(0, s.historyTotalCount - s.historyLoadedCount)
        : 0)
    if (loadedStart <= 0) {
      set({ historyHasMore: false })
      return
    }
    // 按轮次：一次拉「最老已加载轮次的前一轮」[promptStarts[k-1], promptStarts[k])，
    // 用**绝对** offset（不是 start-total 负 offset）——live 追加抬高 total
    // 时负 offset 会整窗前移，与已加载区重叠。窗口 end 钳到 loadedStart，
    // 杜绝任何与已加载区的交叉。
    const win = previousTurnWindow(
      s.historyPromptStarts,
      s.historyTurnIdx,
      loadedStart,
    )
    // 页大小自适应（adaptivePageSize）：按条数兜底分页目标固定为「加载
    // 到上一条 user 消息为止」——新页含 user 即停（下方续翻条件）；中间
    // 隔的长工具流段由翻倍页大小一次覆盖更多，而不是固定 100 条一页地
    // 多次续翻。
    const pageSize = win ? win.limit : adaptivePageSize(chained)
    // 绝对 offset 窗口，与已加载区 [loadedStart, ∞) 严格相接、不重叠。
    let reqOffset: number
    let reqLimit: number
    if (win) {
      reqOffset = win.offset
      reqLimit = win.limit
    } else {
      if (loadedStart <= pageSize) {
        reqOffset = 0
        reqLimit = loadedStart
      } else {
        reqOffset = loadedStart - pageSize
        reqLimit = pageSize
      }
    }
    if (reqLimit <= 0) {
      set({ historyHasMore: false })
      return
    }
    set({ historyLoadingMore: true, historyAnchorId: anchorId, historyLoadError: undefined })
    try {
      const r = await transport.loadSessionHistory(s.historySessionId, s.historyCwd, {
        offset: reqOffset,
        limit: reqLimit,
      })
      if (!isCurrent()) return
      const fetched = r.updates?.length ?? 0
      // 真·live 回合：本端发送中 / 已知 promptId / loadHistory 对仍 open
      // 回合恢复的 turnStartedAt。turnOpen 已收紧（completed 后 stray
      // thought 不再误开），故 turnStartedAt 可信——不得 settle 掉在流条目。
      // 在途 live 在回放前采样：回放会改 open*/conn，不能回放后再判。
      const liveLocal =
        get().pendingOptimisticUserId != null ||
        get().currentPromptId != null ||
        get().turnStartedAt != null
      const existingCompletedTurn = get().lastCompletedTurn
      let liveReplay: LiveReplayState | undefined
      if (liveLocal) {
        // Replay older history in an isolated entry/state slice. Otherwise a
        // historical turn_completed can settle the current live assistant or
        // thought, and its user/chunk events can steal the live pointers.
        flushStreamBuf(set, get)
        liveReplay = captureLiveReplayState(get())
        set({
          entries: [],
          liveStream: null,
          openAssistantId: undefined,
          openThoughtId: undefined,
          currentStreamStartMs: undefined,
          lastCompletedTurn: undefined,
          pendingOptimisticUserId: undefined,
          conn: 'ready',
          statusText: '历史回放中',
          awaitingNext: false,
          turnStartedAt: undefined,
          currentPromptId: undefined,
          genRate: undefined,
          pending: [],
          xaiRequests: [],
          toolIndex: {},
        })
      } else {
        // 回放前先把已加载区的 liveStream flush + 空 thought 收口，避免
        // 回放首条 user 触发 sealThought 删空壳时改写「已加载」集合。
        // （prepend 已改 id 集合差，删壳不再错位；这里仍清掉脏 open*，
        // 让回放在干净指针上起步。）
        const pre = sealThought(flushLiveStream(get()))
        set({
          entries: settleTurnEntries(pre.entries),
          openAssistantId: undefined,
          openThoughtId: undefined,
          currentStreamStartMs: undefined,
          liveStream: null,
          conn: 'ready',
        })
      }
      // Replay appends; split by entry id set（不是 length）。
      // length split 在回放过程中若删掉已加载区空 thought，新 user 会
      // 落进 old 段，merge 后甩到时间线末尾。
      // Older pages never update the context chip (applyUsage: false) —
      // only the newest page (loadHistory) carries the session's current usage.
      const priorIds = new Set(get().entries.map((e) => e.id))
      replayUpdates(get, r.updates ?? [], { applyUsage: false })
      // The last replay chunk may still be waiting in the module rAF buffer.
      // Commit it before taking the new-entry slice or settling the merge.
      flushStreamBuf(set, get)
      const after = get()
      let oldEntries = liveReplay
        ? liveReplay.entries
        : after.entries.filter((e) => priorIds.has(e.id))
      let newEntries = liveReplay
        ? after.entries.map((e, i, arr) =>
            i === arr.length - 1 && e.kind === 'assistant'
              ? { ...e, streaming: false }
              : e,
          )
        : after.entries
            .filter((e) => !priorIds.has(e.id))
            .map((e, i, arr) =>
              i === arr.length - 1 && e.kind === 'assistant'
                ? { ...e, streaming: false }
                : e,
            );
      // Page boundaries can cut an assistant message in half; stitch the
      // continuation (first old entry) onto the new page's last entry.
      const lastNew = newEntries[newEntries.length - 1]
      const firstOld = oldEntries[0]
      if (lastNew?.kind === 'assistant' && firstOld?.kind === 'assistant') {
        newEntries[newEntries.length - 1] = { ...lastNew, text: lastNew.text + firstOld.text }
        oldEntries = oldEntries.slice(1)
      }
      // 刷新 total / promptStarts（agent 每次都回；live 追加后 total 变大，
      // 旧负 offset 会漂——我们已改绝对 offset，这里只同步元数据）。
      const rawTotal = r.totalCount ?? s.historyTotalCount
      const total = rawTotal ?? loadedStart + fetched
      const newLoadedStart = fetched === 0 ? loadedStart : reqOffset
      const loadedNew =
        typeof total === 'number' && total > 0
          ? Math.max(0, total - newLoadedStart)
          : s.historyLoadedCount + fetched
      // 同步 promptStarts；win 路径游标 -1，offset 路径按边界行号 remap。
      const promptStarts =
        r.promptStarts && r.promptStarts.length > 0
          ? r.promptStarts
          : s.historyPromptStarts
      // win 路径：游标减 1。offset 兜底（超长回合）保持原 turnIdx——
      // 绝不能用 loadedStart 反查提前跳到更早轮，否则会跳过长回合未加载前缀。
      // promptStarts 因 live 新回合 append 变长时，旧下标仍指向同一 start 行。
      const nextTurnIdx = win
        ? Math.max(0, s.historyTurnIdx - 1)
        : remapTurnIdx(s.historyPromptStarts, s.historyTurnIdx, promptStarts)
      // Same settled-transcript rule as loadHistory: a tool that is still
      // running here never received its completion in any loaded page
      // (its update was dropped for an unknown id when the newer page
      // replayed first) — close it out instead of leaving "Running …"
      // stuck on a historical page boundary. Skipped only for true local
      // live turns (see liveLocal above).
      const merged = [...newEntries, ...oldEntries]
      // 回放后 openAssistantId/liveStream 常被「本页半截 assistant」填上，
      // 不代表真 live。历史分页一律 settle + conn ready；本端发送中则
      // 整段跳过，避免打掉正在流的条目 / 未合并的 liveStream。
      const streaming =
        liveLocal ||
        get().pendingOptimisticUserId != null ||
        get().currentPromptId != null
      const liveStatePatch = liveReplay
        ? {
            ...liveReplay,
            entries: merged,
            // The historical page was replayed in a clean slice; its tool
            // index must not replace the live turn's index.
            toolIndex: liveReplay.toolIndex,
          }
        : {}
      // hasMore：还有更早行（绝对游标 > 0）且本页非空。空页停翻，避免
      // 宿主异常时死循环。按轮次时 nextTurnIdx/promptStarts 只影响下一
      // 次 previousTurnWindow；是否可翻只看游标（含首轮前 preamble）。
      const hasMore = fetched > 0 && newLoadedStart > 0
      // 历史页回放可能把 conn/statusText 打成 busy/Responding…——非 live
      // 时强制收口（先 flush 再 settle，避免清空 liveStream 丢正文）。
      if (streaming) {
        set({
          ...liveStatePatch,
          entries: merged,
          historyLoadingMore: false,
          historyTotalCount: total,
          historyLoadedCount: loadedNew,
          historyLoadedStart: newLoadedStart,
          historyHasMore: hasMore,
          historyPromptStarts: promptStarts,
          historyTurnIdx: nextTurnIdx,
          historyLoadError: undefined,
          historyPrependedAt: Date.now(),
        })
      } else {
        const sealedMerged = sealThought(
          flushLiveStream({ ...get(), entries: merged }),
        )
        set({
          entries: settleTurnEntries(sealedMerged.entries),
          openAssistantId: undefined,
          openThoughtId: undefined,
          currentStreamStartMs: undefined,
          lastCompletedTurn: existingCompletedTurn,
          liveStream: null,
          // Replay of stored thought chunks drives conn to 'busy' — paging
          // history is not a live turn.
          conn: 'ready',
          historyLoadingMore: false,
          historyTotalCount: total,
          historyLoadedCount: loadedNew,
          historyLoadedStart: newLoadedStart,
          historyHasMore: hasMore,
          historyPromptStarts: promptStarts,
          historyTurnIdx: nextTurnIdx,
          historyLoadError: undefined,
          historyPrependedAt: Date.now(),
        })
      }
      // 自动续翻（仅按条数兜底路径；页大小随 chained 翻倍）：本页无
      // user（纯工具流段）就继续向后翻——分页目标固定为「加载到上一条
      // user 消息为止」。按轮次路径每页必含 user，无需续翻。或翻尽
      // （hasMore=false / 空页）/ 出错 / 达到 MAX_AUTO_FETCH_ENTRIES 累计
      // 条数上限。视口锚点由组件按 historyAnchorId 保持（每页 prepend 后
      // 把同一锚点滚回视口顶），续翻不打断阅读位置——「向上滚动加载更早
      // 历史」一次手势就能穿过整段工具流，落到真正的对话上；翻页间隙的
      // sticky 保证由 Scrollback 的回退钉选兜底（窗口上方最近一条 user）。
      if (
        !win &&
        countUserMessages(newEntries) === 0 &&
        hasMore &&
        loadedNew < MAX_AUTO_FETCH_ENTRIES &&
        isCurrent()
      ) {
        void get().loadMoreHistory(anchorId, chained + 1)
      }
    } catch (e) {
      if (!isCurrent()) return
      // 失败必须就地可见：静默吞掉会让「点击加载」看起来无效（按钮闪
      // 一下恢复、什么也没发生）。错误显示在加载按钮上，下次点击/上滑
      // 自动重试。
      set({
        historyLoadingMore: false,
        historyLoadError: `加载更早历史失败：${
          e instanceof Error ? e.message : String(e)
        }`,
      })
    }
  }
