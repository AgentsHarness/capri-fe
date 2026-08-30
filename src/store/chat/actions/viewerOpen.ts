import type { ScrollEntry } from '../../../api/types'
import { transport } from '../../../api/client'
import type { ChatState, SetState } from '../types'
import { envelopeToEvents } from '../history'
import {
  SUBAGENT_VIEW_PAGE_SIZE,
  subagentViewAppend,
} from '../subagent'

export function viewerOpenActions(set: SetState, get: () => ChatState) {
  return {
  openViewer: (id) => {
    const s = get()
    const target = id ?? s.selectedId
    if (!target || target.startsWith('gh_')) return
    const e = s.entries.find((x) => x.id === target)
    if (!e) return
    // Only view contentful blocks (TUI has_normal_fullscreen_viewer)
    if (
      e.kind !== 'tool' &&
      e.kind !== 'thought' &&
      e.kind !== 'user' &&
      e.kind !== 'assistant' &&
      e.kind !== 'error' &&
      e.kind !== 'plan' &&
      e.kind !== 'bg_task' &&
      e.kind !== 'subagent' &&
      e.kind !== 'workflow'
    ) {
      return
    }
    if (e.kind === 'tool' && !e.raw && !e.title) return
    if (e.kind === 'bg_task' && e.taskId) {
      // Live rows (bgTaskIndex) keep the entry-backed viewer + live poll.
      // Replay display rows are NOT in the index — open the task viewer
      // so the log is fetched session-scoped (host reconstructs it from
      // the persisted timeline + on-disk log, unaffected by pagination).
      if (s.bgTaskIndex[e.taskId]) {
        set({
          viewerEntryId: target,
          viewerTask: undefined,
          selectedId: target,
          focusMode: 'scrollback',
        })
        // BgTask: pull live stdout (TUI reads central store on open + tick).
        void get().refreshTaskOutput(e.taskId)
      } else {
        get().openTaskViewer(e.taskId, {
          title: e.title,
          command: e.command,
          outputFile: e.outputFile,
          output: e.output,
        })
      }
      return
    }
    set({
      viewerEntryId: target,
      viewerTask: undefined,
      selectedId: target,
      focusMode: 'scrollback',
    })
  },

  openTaskViewer: (taskId, opts) => {
    if (!taskId) return
    const s = get()
    // Live scrollback row: reuse the entry-backed viewer + live poll.
    const entryId = s.bgTaskIndex[taskId]
    if (entryId) {
      get().openViewer(entryId)
      return
    }
    // History replay / restored top-strip task: task-only view backed by
    // the host's session-scoped log reconstruction. The currently viewed
    // history session wins the scope; fall back to the live session.
    const sessionId = opts?.sessionId ?? s.historySessionId ?? s.sessionId
    const cwd = opts?.cwd ?? s.historyCwd ?? s.cwd
    set({
      viewerEntryId: null,
      selectedId: null,
      focusMode: 'scrollback',
      viewerTask: {
        taskId,
        title: opts?.title,
        command: opts?.command,
        outputFile: opts?.outputFile,
        output: opts?.output ?? '',
        running: false,
        sessionId,
        cwd,
      },
    })
    void get().refreshTaskOutput(taskId, sessionId, cwd)
  },

  closeViewer: () => {
    set({ viewerEntryId: null, viewerTask: undefined })
  },

  fetchSubagentView: async (childSessionId) => {
    const s = get()
    const view = s.subagentViews[childSessionId]
    // 打开即回放完整历史：不再因“已有 live 条目”而跳过。磁盘 updates.jsonl
    // 是权威完整来源，live 只是流式尾巴——live 捕获非空只代表“正在输出”，
    // 不代表历史完整。回放成功后以回放结果重建 items（见下方合并逻辑）。
    if (!view || view.fetchState === 'loading' || view.fetchState === 'loaded') {
      return
    }
    // 子代理与父会话同 cwd（宿主 session-updates 按 sessionId+cwd 分页）。
    const cwd = s.cwd
    if (!cwd) return
    set({
      subagentViews: {
        ...s.subagentViews,
        [childSessionId]: { ...view, fetchState: 'loading' },
      },
    })
    try {
      // 取最新一页（与 loadHistory 相同的负 offset 分页约定），按存储顺序
      // （时间正序）回放——同一 subagentViewAppend 处理器，live 与
      // 回放事件不会出现两套渲染逻辑。
      const r = await transport.loadSessionHistory(childSessionId, cwd, {
        offset: -SUBAGENT_VIEW_PAGE_SIZE,
        limit: SUBAGENT_VIEW_PAGE_SIZE,
      })
      // 先独立回放出一条基线（磁盘权威），再与现有 live 条目合并：
      // - 回放有内容 → 用它重建视图（丢弃 pre-loading 的 live 子集，避免重复/乱序）
      // - 回放为空（子代理会话无落盘 / 宿主未找到该子代理）→ 保留现有 live
      //   捕获，不丢流。
      let replayed: ScrollEntry[] = []
      for (const env of r.updates ?? []) {
        // 防御（任务 3）：存储包络带 params.sessionId——只有属于该子代理
        // 会话（或未带 sid 的旧格式）的包络才回放。若 x.ai/session/updates
        // 对子代理 sid 解析异常、回退到了别的会话（历史 bug：不同子代理
        // 弹窗拉到同一份内容），错配包络直接丢弃——弹窗显示空态
        // 「未捕获到活动」，绝不渲染出别的会话的对话。
        const envParams = (env as { params?: { sessionId?: unknown } } | null)
          ?.params
        const envSid = envParams?.sessionId
        if (typeof envSid === 'string' && envSid !== childSessionId) continue
        const events = envelopeToEvents(env)
        for (const ev of events) replayed = subagentViewAppend(replayed, ev)
      }
      // 记录分页游标（包络条数——与宿主负 offset 语义一致，过滤掉的非
      // scrollback 事件不占游标位）：回放填充的视图（loadedCount > 0）
      // 才支持上滑分页。
      const total = r.totalCount ?? (r.updates?.length ?? 0)
      set((st) => {
        const v = st.subagentViews[childSessionId]
        if (!v) return {}
        // 回放为权威基线：有内容则整体替换（含历史中被 live 抢先捕获的子集
        // 一并去重）；回放为空则保留现有 live 捕获，保证正在输出的流不丢。
        const items = replayed.length > 0 ? replayed : v.items
        return {
          subagentViews: {
            ...st.subagentViews,
            [childSessionId]: {
              ...v,
              items,
              fetchState: 'loaded',
              loadedCount: r.updates?.length ?? 0,
              totalCount: total,
              // 绝对最老行号（首拉 = 最新一页）：已加载区 = [start, total)。
              loadedStart: Math.max(0, total - (r.updates?.length ?? 0)),
            },
          },
        }
      })
    } catch {
      // 拉取失败（离线 / 宿主无该子代理会话）——保持空视图，结束状态置
      // loaded 防止弹窗打开期间的重试风暴。
    } finally {
      set((st) => {
        const v = st.subagentViews[childSessionId]
        if (!v) return {}
        return {
          subagentViews: {
            ...st.subagentViews,
            [childSessionId]: { ...v, fetchState: 'loaded' },
          },
        }
      })
    }
  },

  loadMoreSubagentView: async (childSessionId): Promise<boolean> => {
    const s = get()
    const view = s.subagentViews[childSessionId]
    if (!view || view.fetchState === 'loading') return false
    const loaded = view.loadedCount ?? 0
    // 权威游标 = 绝对最老行号 loadedStart；旧状态（缺字段）按
    // total - loaded 兜底换算。已加载区 = [loadedStart, totalCount)。
    const loadedStart =
      view.loadedStart ??
      (view.totalCount != null ? Math.max(0, view.totalCount - loaded) : 0)
    // 只有回放填充的视图提供上滑（纯 live 捕获历史已完整，回放会重复）。
    if (loaded <= 0 || loadedStart <= 0) return false
    const cwd = s.cwd
    if (!cwd) return false
    set({
      subagentViews: {
        ...s.subagentViews,
        [childSessionId]: { ...view, fetchState: 'loading' },
      },
    })
    try {
      // 绝对 offset 窗口 [loadedStart-PAGE, loadedStart)，与已加载区严格
      // 相邻、不重叠（主 scrollback loadMoreHistory 同款）——live 追加
      // 抬高 totalCount 时负 offset 会整窗前移、与已加载区重叠、同一批
      // 包络重复回放成重复行。
      const reqOffset = Math.max(0, loadedStart - SUBAGENT_VIEW_PAGE_SIZE)
      const reqLimit = loadedStart - reqOffset
      const r = await transport.loadSessionHistory(childSessionId, cwd, {
        offset: reqOffset,
        limit: reqLimit,
      })
      // 旧页在隔离数组里回放（主 scrollback loadMoreHistory 的隔离切片同
      // 款）：不经过现存视图，user_chunk 聚合 / 流切换收口只看本页边界，
      // 不会改写已加载区条目，再整体前插。
      let older: ScrollEntry[] = []
      for (const env of r.updates ?? []) {
        const envParams = (env as { params?: { sessionId?: unknown } } | null)
          ?.params
        const envSid = envParams?.sessionId
        if (typeof envSid === 'string' && envSid !== childSessionId) continue
        const events = envelopeToEvents(env)
        for (const ev of events) older = subagentViewAppend(older, ev)
      }
      const after = get().subagentViews[childSessionId]
      if (!after) return false
      let newItems = older
      let oldItems = after.items
      // 跨页截断缝合：assistant / thought 各半拼回一条（主 scrollback
      // loadMoreHistory 同款）；历史数据缝合后收口，不再停留流式态。
      const lastNew = newItems[newItems.length - 1]
      const firstOld = oldItems[0]
      if (lastNew?.kind === 'assistant' && firstOld?.kind === 'assistant') {
        newItems[newItems.length - 1] = {
          ...lastNew,
          text: lastNew.text + firstOld.text,
          streaming: false,
        }
        oldItems = oldItems.slice(1)
      } else if (lastNew?.kind === 'thought' && firstOld?.kind === 'thought') {
        newItems[newItems.length - 1] = {
          ...lastNew,
          text: lastNew.text + firstOld.text,
          streaming: false,
          displayMode: 'collapsed' as const,
          finishedAt: Date.now(),
        }
        oldItems = oldItems.slice(1)
      }
      // 更早的页在前拼接；不设条目上限——由用户上滑分页控制（不再丢弃最旧）。
      const merged = [...newItems, ...oldItems]
      const fetched = r.updates?.length ?? 0
      const total = r.totalCount ?? view.totalCount ?? loadedStart + fetched
      // 绝对游标推进：新页最老行 = reqOffset；空页不动游标（hasMore 停）。
      const newLoadedStart = fetched === 0 ? loadedStart : reqOffset
      const loadedNew =
        typeof total === 'number' && total > 0
          ? Math.max(0, total - newLoadedStart)
          : loaded + fetched
      set({
        subagentViews: {
          ...s.subagentViews,
          [childSessionId]: {
            ...after,
            items: merged,
            fetchState: 'loaded',
            loadedCount: loadedNew,
            totalCount: total,
            loadedStart: newLoadedStart,
          },
        },
      })
      return fetched > 0
    } catch {
      // 加载失败静默：恢复 loaded，下次上滑/自动补页重试（返回 false 让
      // 自动补页停止，避免无滚动条时无限重试）。
      set((st) => {
        const v = st.subagentViews[childSessionId]
        if (!v) return {}
        return {
          subagentViews: {
            ...st.subagentViews,
            [childSessionId]: { ...v, fetchState: 'loaded' },
          },
        }
      })
      return false
    }
  },
  } satisfies Partial<ChatState>
}
