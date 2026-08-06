import { create } from 'zustand'
import type { AcpEvent, HostInfo, PendingReq, ScrollEntry, SessionInfo, ToolCall } from '../api/types'
import { transport } from '../api/localTransport'
import { toolHeader } from '../theme/glyphs'
import {
  projectDisplayRows,
  scanGroups,
  spanContaining,
} from '../scrollback/verbGroup'
let entrySeq = 0
const nid = () => `e_${++entrySeq}_${Date.now()}`

function toolVerb(kind?: string, running?: boolean) {
  return toolHeader(kind, !!running).verb
}

function formatElapsed(ms: number): string {
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = Math.floor(secs / 60)
  const rem = secs - mins * 60
  return `${mins}m${rem.toFixed(0)}s`
}

function extractTarget(tc: ToolCall): string {
  const ri = tc.rawInput
  if (!ri) return tc.title || ''
  const s =
    (ri.path as string) ||
    (ri.filePath as string) ||
    (ri.command as string) ||
    (ri.query as string) ||
    (ri.url as string) ||
    (ri.pattern as string) ||
    tc.title ||
    ''
  return String(s)
}

type ConnState = 'connecting' | 'ready' | 'busy' | 'error' | 'offline'
export type FocusMode = 'prompt' | 'scrollback'

/** One MCP server row for the MCP panel (x.ai/mcp/server_status). */
export type McpServerInfo = {
  name: string
  source?: string
  status?: string
  reason?: string
  detail?: string
}

type ChatState = {
  entries: ScrollEntry[]
  conn: ConnState
  statusText: string
  sessionId?: string
  hostId?: string
  hostName?: string
  hosts: HostInfo[]
  /** Historical sessions for the history picker (from session/list). */
  sessions: SessionInfo[]
  historyOpen: boolean
  historyLoading: boolean
  /** Bumped when a history load finishes; Scrollback re-follows the bottom. */
  historyLoadedAt?: number
  /** Active history timeline (scroll-up pagination state). */
  historySessionId?: string
  historyCwd?: string
  historyTotalCount?: number
  historyLoadedCount: number
  historyHasMore: boolean
  historyLoadingMore: boolean
  /** Bumped when an older page is prepended; Scrollback restores position. */
  historyPrependedAt?: number
  historyAnchorId?: string
  usage?: { used?: number; size?: number }
  pending: PendingReq[]
  modes?: unknown
  error?: string
  /** Session title (top prompt border caption). */
  sessionTitle?: string
  /** Current model label for prompt info line (TUI model_name). */
  modelName?: string
  /** Reasoning effort suffix, e.g. "high". */
  reasoningEffort?: string
  // ── x.ai/* extension state ────────────────────────────────────────
  /** Forwarded agent → client x.ai/* requests (ask_user_question, exit_plan_mode…). */
  xaiRequests: PendingReq[]
  /** subagent_id → entry id (session_notification subagent_spawned/finished). */
  subagentIndex: Record<string, string>
  /** task_id → entry id (task_backgrounded / task_completed). */
  bgTaskIndex: Record<string, string>
  /** Git head from x.ai/git_head_changed (TUI status-bar branch). */
  gitInfo?: { branch?: string | null; isWorktree?: boolean; mainRepo?: string | null }
  /** Permission mode from x.ai/yolo_mode_changed (TUI permission banner). */
  yoloMode?: boolean
  autoMode?: boolean
  permissionMode?: string
  /** MCP server statuses from x.ai/mcp/server_status (TUI MCP panel). */
  mcpServers: McpServerInfo[]
  /** Bumped on mcp tools_changed / servers_updated so panels can refresh. */
  mcpVersion: number
  // streaming pointers
  openAssistantId?: string
  openThoughtId?: string
  toolIndex: Record<string, string> // toolCallId -> entry id
  /** TUI focus: Tab toggles prompt ↔ scrollback */
  focusMode: FocusMode
  /** Selected entry id (or synthetic `gh_<anchorId>` group header) */
  selectedId: string | null
  /**
   * Manually expanded verb / truncation groups, keyed by the first entry id
   * of the run (TUI expanded_groups).
   */
  expandedGroups: ReadonlySet<string>
  /**
   * Block viewer (TUI OpenBlockViewer): entry id currently shown fullscreen.
   * Enter / double-click open; Esc closes. Independent of inline expand.
   */
  viewerEntryId: string | null

  init: () => () => void
  send: (text: string) => Promise<void>
  cancel: () => Promise<void>
  respondPermission: (requestId: string, optionId?: string, cancelled?: boolean) => Promise<void>
  /** Respond to a forwarded x.ai/* request with a raw result (or error). */
  respondXai: (requestId: string, result?: Record<string, unknown>, error?: string) => Promise<void>
  /** Cancel a forwarded x.ai/* request (outcome:cancelled / error). */
  dismissXai: (requestId: string) => Promise<void>
  /** x.ai/recap — fire-and-forget "where was I" summary. */
  requestRecap: () => Promise<void>
  /** x.ai/session/fork — fork the current session. */
  forkSession: (opts?: Record<string, unknown>) => Promise<void>
  /** x.ai/session/rename. */
  renameSession: (title: string) => Promise<void>
  /** x.ai/subagent/cancel. */
  cancelSubagent: (subagentId: string) => Promise<void>
  /** x.ai/task/kill — kill a background task. */
  killTask: (taskId: string) => Promise<void>
  /** x.ai/sessions/changed — refresh the history list. */
  refreshSessions: () => Promise<void>
  newSession: () => Promise<void>
  refreshHosts: () => Promise<void>
  /** History picker: fetch session list and open the overlay. */
  openHistory: () => Promise<void>
  closeHistory: () => void
  /** Load a historical session's updates; the host replays them via SSE. */
  loadHistory: (sessionId: string, cwd: string) => Promise<void>
  /** Fetch the next older page of the active history and prepend it. */
  loadMoreHistory: (anchorId?: string) => Promise<void>
  /** Switch the active session to a historical one and load its tail. */
  continueSession: (sessionId: string, cwd: string) => Promise<void>
  handleEvent: (ev: AcpEvent) => void
  toggleTool: (id: string) => void
  toggleThought: (id: string) => void
  /** Expand/collapse long user prompts (←/→ / click). */
  toggleUser: (id: string) => void
  setFocus: (mode: FocusMode) => void
  selectEntry: (id: string | null) => void
  selectDelta: (delta: number) => void
  /** → expand / ← collapse selected foldable block or group */
  setExpanded: (expanded: boolean) => void
  /**
   * Inline fold toggle for selected (←/→/click path). Not the viewer.
   * Kept for Space / group headers; tools use setExpanded via arrows/click.
   */
  toggleSelected: () => void
  /** Open TUI block viewer for entry (Enter / double-click). */
  openViewer: (id?: string | null) => void
  closeViewer: () => void
  toggleGroupExpansion: (anchorId: string) => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  entries: [],
  conn: 'connecting',
  statusText: '连接中…',
  hosts: [],
  sessions: [],
  historyOpen: false,
  historyLoading: false,
  historyLoadedCount: 0,
  historyHasMore: false,
  historyLoadingMore: false,
  pending: [],
  xaiRequests: [],
  subagentIndex: {},
  bgTaskIndex: {},
  mcpServers: [],
  mcpVersion: 0,
  toolIndex: {},
  focusMode: 'prompt',
  selectedId: null,
  expandedGroups: new Set(),
  viewerEntryId: null,

  init: () => {
    const unsub = transport.onEvent((ev) => {
      const s = get()
      // While switching to a historical session (historyLoading), the agent
      // re-streams the whole conversation as part of session/load (recap).
      // Drop those SSE events — loadHistory rebuilds the scrollback from
      // paginated updates instead. Status events still pass through.
      if (s.historyLoading && ev.type !== 'hello' && ev.type !== 'ready') return
      s.handleEvent(ev)
    })
    transport.connect()
    void get().refreshHosts()
    return () => {
      unsub()
      transport.disconnect()
    }
  },

  refreshHosts: async () => {
    try {
      const hosts = await transport.listHosts()
      set({ hosts })
    } catch {
      /* ignore */
    }
  },

  openHistory: async () => {
    const s = get()
    if (s.sessions.length === 0) {
      try {
        const sessions = await transport.listSessions()
        set({ sessions })
      } catch {
        /* ignore */
      }
    }
    set({ historyOpen: true })
  },

  closeHistory: () => set({ historyOpen: false }),

  loadHistory: async (sessionId: string, cwd: string) => {
    // Reset the scrollback; load only the newest page — older pages are
    // fetched on scroll-up (loadMoreHistory).
    set({
      historyOpen: false,
      historyLoading: true,
      historyLoadedAt: undefined,
      historySessionId: sessionId,
      historyCwd: cwd,
      historyTotalCount: undefined,
      historyLoadedCount: 0,
      historyHasMore: false,
      historyLoadingMore: false,
      historyPrependedAt: undefined,
      historyAnchorId: undefined,
      entries: [],
      openAssistantId: undefined,
      openThoughtId: undefined,
      toolIndex: {},
      pending: [],
      xaiRequests: [],
      subagentIndex: {},
      bgTaskIndex: {},
      gitInfo: undefined,
      yoloMode: undefined,
      autoMode: undefined,
      permissionMode: undefined,
      mcpServers: [],
      selectedId: null,
      focusMode: 'prompt',
      expandedGroups: new Set(),
      viewerEntryId: null,
      error: undefined,
      usage: undefined,
    })
    try {
      const r = await transport.loadSessionHistory(sessionId, cwd, {
        offset: -HISTORY_PAGE_SIZE,
        limit: HISTORY_PAGE_SIZE,
      })
      replayUpdates(get, r.updates ?? [])
      const loaded = Math.min(r.totalCount ?? 0, (r.updates ?? []).length)
      set({
        historyLoading: false,
        historyTotalCount: r.totalCount,
        historyLoadedCount: loaded,
        historyHasMore: (r.totalCount ?? 0) > loaded,
        statusText: `历史已加载 (共 ${r.totalCount ?? '?'} 条更新)`,
        historyLoadedAt: Date.now(),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        historyLoading: false,
        statusText: '历史加载失败',
        entries: [...get().entries, { id: nid(), kind: 'error', text: msg }],
      })
    }
  },

  continueSession: async (sessionId: string, cwd: string) => {
    if (get().historyLoading || get().historyLoadingMore) return
    set({ historyOpen: false, historyLoading: true })
    try {
      // 1) Make this session the active one (session/load); 2) load its tail.
      await transport.loadSession(sessionId, cwd)
      await get().loadHistory(sessionId, cwd)
      // Grace window: session/load recap events stream over SSE and may still
      // be in flight (SSE and fetch are separate channels) — keep dropping
      // them briefly before reopening the live pipeline.
      set({ historyLoading: true })
      window.setTimeout(() => {
        set({
          historyLoading: false,
          statusText: `已切换到会话 ${sessionId.slice(0, 8)}，可继续对话`,
        })
      }, 500)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        historyLoading: false,
        statusText: '切换会话失败',
        entries: [...get().entries, { id: nid(), kind: 'error', text: msg }],
      })
    }
  },

  loadMoreHistory: async (anchorId?: string) => {
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
    set({ historyLoadingMore: true, historyAnchorId: anchorId })
    const loaded = s.historyLoadedCount
    try {
      const r = await transport.loadSessionHistory(s.historySessionId, s.historyCwd, {
        offset: -(loaded + HISTORY_PAGE_SIZE),
        limit: HISTORY_PAGE_SIZE,
      })
      const fetched = r.updates?.length ?? 0
      // Replay appends; remember where the previous timeline started so the
      // new (older) page can be moved in front of it afterwards.
      const split = get().entries.length
      replayUpdates(get, r.updates ?? [])
      const after = get()
      let oldEntries = after.entries.slice(0, split)
      const newEntries = after.entries.slice(split).map((e, i, arr) =>
        i === arr.length - 1 && e.kind === 'assistant' ? { ...e, streaming: false } : e,
      )
      // Page boundaries can cut an assistant message in half; stitch the
      // continuation (first old entry) onto the new page's last entry.
      const lastNew = newEntries[newEntries.length - 1]
      const firstOld = oldEntries[0]
      if (lastNew?.kind === 'assistant' && firstOld?.kind === 'assistant') {
        newEntries[newEntries.length - 1] = { ...lastNew, text: lastNew.text + firstOld.text }
        oldEntries = oldEntries.slice(1)
      }
      const total = r.totalCount ?? s.historyTotalCount ?? loaded + fetched
      const loadedNew = fetched === 0 ? total : Math.min(loaded + fetched, total)
      set({
        entries: [...newEntries, ...oldEntries],
        openAssistantId: undefined,
        openThoughtId: undefined,
        historyLoadingMore: false,
        historyTotalCount: total,
        historyLoadedCount: loadedNew,
        historyHasMore: total > loadedNew,
        historyPrependedAt: Date.now(),
      })
    } catch {
      set({ historyLoadingMore: false })
    }
  },

  handleEvent: (ev) => {
    switch (ev.type) {
      case 'hello': {
        const agentModel = extractModelFromAgentInfo(ev.agentInfo)
        const reqs = ev.pendingRequests || []
        set({
          conn: ev.ready ? 'ready' : ev.error ? 'error' : 'connecting',
          statusText: ev.error || (ev.ready ? '就绪' : '启动中…'),
          sessionId: ev.sessionId,
          hostId: ev.hostId,
          hostName: ev.hostName,
          pending: reqs.filter((r) => !r.method.startsWith('x.ai/')),
          xaiRequests: reqs.filter((r) => r.method.startsWith('x.ai/')),
          modes: ev.modes,
          error: ev.error,
          ...(agentModel ? { modelName: agentModel } : {}),
        })
        if (ev.busy) set({ conn: 'busy', statusText: '生成中…' })
        break
      }
      case 'ready': {
        const agentModel = extractModelFromAgentInfo(ev.agentInfo)
        set({
          conn: 'ready',
          statusText: '就绪',
          sessionId: ev.sessionId,
          hostId: ev.hostId,
          hostName: ev.hostName,
          modes: ev.modes,
          error: undefined,
          ...(agentModel ? { modelName: agentModel } : {}),
        })
        void get().refreshHosts()
        break
      }
      case 'busy': {
        // TUI pre-creates Thinking… before first thought delta arrives
        // (tracker.rs ensure_thinking / pre-create thinking block).
        const s = get()
        if (!s.openThoughtId) {
          const id = nid()
          set({
            conn: 'busy',
            statusText: 'Thinking…',
            openThoughtId: id,
            openAssistantId: undefined,
            entries: [
              ...s.entries,
              {
                id,
                kind: 'thought',
                text: '',
                open: true, // live: show flowing body
                streaming: true,
                startedAt: Date.now(),
              },
            ],
          })
        } else {
          set({ conn: 'busy', statusText: 'Thinking…' })
        }
        break
      }
      case 'user_message': {
        // Replayed from session history: one event per user message.
        const text = ev.text || ''
        if (!text) break
        const sealed = sealThought(get())
        const entries = sealed.entries.map((e) =>
          e.id === sealed.openAssistantId && e.kind === 'assistant'
            ? { ...e, streaming: false }
            : e,
        )
        set({
          ...sealed,
          openAssistantId: undefined,
          entries: [...entries, { id: nid(), kind: 'user', text, expanded: false }],
        })
        break
      }
      case 'chunk': {
        const text = ev.text || ''
        // seal open thought when assistant starts speaking
        const sealed = sealThought(get())
        const { openAssistantId, entries } = sealed
        if (openAssistantId) {
          set({
            ...sealed,
            statusText: 'Responding…',
            entries: entries.map((e) =>
              e.id === openAssistantId && e.kind === 'assistant'
                ? { ...e, text: e.text + text, streaming: true }
                : e,
            ),
          })
        } else {
          const id = nid()
          set({
            ...sealed,
            statusText: 'Responding…',
            openAssistantId: id,
            openThoughtId: undefined,
            entries: [...entries, { id, kind: 'assistant', text, streaming: true }],
          })
        }
        break
      }
      case 'thought': {
        const text = ev.text || ''
        if (!text) break
        const s = get()
        let openThoughtId = s.openThoughtId
        let entries = s.entries

        // If placeholder missing (reconnect mid-turn), create one
        if (!openThoughtId || !entries.some((e) => e.id === openThoughtId && e.kind === 'thought')) {
          const id = nid()
          openThoughtId = id
          entries = [
            ...entries,
            {
              id,
              kind: 'thought',
              text: '',
              open: true,
              streaming: true,
              startedAt: Date.now(),
            },
          ]
        }

        set({
          conn: 'busy',
          statusText: 'Thinking…',
          openThoughtId,
          openAssistantId: undefined,
          entries: entries.map((e) =>
            e.id === openThoughtId && e.kind === 'thought'
              ? {
                  ...e,
                  text: e.text + text,
                  streaming: true,
                  open: true, // keep body visible while flowing
                }
              : e,
          ),
        })
        break
      }
      case 'tool_call': {
        const sealed = sealThought(get())
        const tc = ev.toolCall || {}
        const toolCallId = tc.toolCallId as string | undefined
        const status = (tc.status as string) || 'pending'
        const kindName = (tc.kind as string) || 'other'
        const running = status === 'pending' || status === 'in_progress'
        const title = extractTarget(tc) || (tc.title as string) || kindName
        const id = nid()
        const entry: ScrollEntry = {
          id,
          kind: 'tool',
          toolCallId,
          title,
          verb: toolVerb(kindName, running),
          status,
          kindName,
          detail: tc.title as string | undefined,
          expanded: false,
          raw: tc,
        }
        const toolIndex = { ...get().toolIndex }
        if (toolCallId) toolIndex[toolCallId] = id
        set({
          ...sealed,
          openAssistantId: undefined,
          openThoughtId: undefined,
          toolIndex,
          entries: [...sealed.entries, entry],
        })
        break
      }
      case 'tool_call_update': {
        const tc = ev.toolCallUpdate || {}
        const toolCallId = tc.toolCallId as string | undefined
        if (!toolCallId) break
        const entryId = get().toolIndex[toolCallId]
        if (!entryId) {
          // treat as new
          get().handleEvent({ type: 'tool_call', toolCall: tc })
          break
        }
        set({
          entries: get().entries.map((e) => {
            if (e.id !== entryId || e.kind !== 'tool') return e
            const merged: ToolCall = { ...(e.raw || {}), ...tc }
            const status = (merged.status as string) || e.status
            const kindName = (merged.kind as string) || e.kindName || 'other'
            const running = status === 'pending' || status === 'in_progress'
            const wasRunning =
              e.status === 'pending' || e.status === 'in_progress'
            // Finish flash: stamp finishedAt when a running tool settles
            const finishedAt =
              wasRunning && !running ? Date.now() : e.finishedAt
            return {
              ...e,
              status,
              kindName,
              verb: toolVerb(kindName, running),
              title: extractTarget(merged) || e.title,
              raw: merged,
              finishedAt,
            }
          }),
        })
        break
      }
      case 'plan':
        set({
          openAssistantId: undefined,
          entries: [...get().entries, { id: nid(), kind: 'plan', entries: ev.entries }],
        })
        break
      case 'usage':
        set({ usage: { used: ev.used as number | undefined, size: ev.size as number | undefined } })
        break
      case 'done':
        set((s) => ({
          conn: 'ready',
          statusText: `${ev.stopReason || 'end_turn'}`,
          openAssistantId: undefined,
          openThoughtId: undefined,
          entries: s.entries.map((e) => {
            if (e.kind === 'assistant' && e.streaming) return { ...e, streaming: false }
            if (e.kind === 'thought' && e.streaming) {
              const elapsed =
                e.startedAt != null ? formatElapsed(Date.now() - e.startedAt) : e.elapsed
              return {
                ...e,
                streaming: false,
                elapsed,
                open: false,
                finishedAt: Date.now(),
              }
            }
            // Settle any still-running tools on turn end (finish flash)
            if (
              e.kind === 'tool' &&
              (e.status === 'pending' || e.status === 'in_progress')
            ) {
              return {
                ...e,
                status: 'completed',
                verb: toolVerb(e.kindName, false),
                finishedAt: Date.now(),
              }
            }
            return e
          }),
        }))
        break
      case 'cancelled':
        set((s) => ({
          conn: 'ready',
          statusText: 'cancelled',
          openAssistantId: undefined,
          openThoughtId: undefined,
          xaiRequests: [], // host answered every pending x.ai request already
          entries: s.entries.map((e) => {
            if (e.kind === 'thought' && e.streaming) {
              return { ...e, streaming: false, finishedAt: Date.now(), open: false }
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
        }))
        break
      case 'error':
        set({
          conn: 'error',
          statusText: ev.message,
          error: ev.message,
          entries: [...get().entries, { id: nid(), kind: 'error', text: ev.message }],
        })
        break
      case 'status':
        set({
          entries: [...get().entries, { id: nid(), kind: 'status', text: ev.text }],
        })
        break
      case 'client_request': {
        const method = ev.method || ''
        if (method.startsWith('x.ai/')) {
          // Only interactive extension requests get UI; everything else is
          // answered immediately so the agent never hangs on a timeout.
          const SUPPORTED = new Set(['x.ai/ask_user_question', 'x.ai/exit_plan_mode'])
          if (!SUPPORTED.has(method)) {
            void get().respondXai(
              ev.requestId,
              undefined,
              `前端不支持方法 ${method}`,
            )
            break
          }
          set({
            xaiRequests: [
              ...get().xaiRequests.filter((r) => r.requestId !== ev.requestId),
              { requestId: ev.requestId, method, params: ev.params },
            ],
          })
        } else {
          set({
            pending: [
              ...get().pending.filter((p) => p.requestId !== ev.requestId),
              { requestId: ev.requestId, method: ev.method, params: ev.params },
            ],
          })
        }
        break
      }
      // ── x.ai/* extension notifications ────────────────────────────
      case 'session_notification': {
        const { tag, fields } = extractSessionUpdate(ev.params)
        if (!tag) break
        switch (tag) {
          case 'subagent_spawned':
          case 'subagent_finished':
            handleSubagentEvent(get, set, tag, fields)
            break
          case 'task_backgrounded':
            handleTaskBackgrounded(get, set, fields)
            break
          case 'task_completed':
            handleTaskCompleted(get, set, fields)
            break
          case 'response_started': {
            // A new LLM response started — finish any in-flight thought.
            const sealed = sealThought(get())
            set({ ...sealed, statusText: 'Thinking…' })
            break
          }
          case 'reasoning_completed':
            set({ statusText: 'Responding…' })
            break
          case 'auto_compact_started': {
            const pct = fields.percentage as number | undefined
            appendEntry(set, {
              kind: 'session_event',
              text: `自动压缩上下文… (${pct ?? '?'}%)`,
              streaming: false,
            })
            break
          }
          case 'auto_compact_completed': {
            appendEntry(set, { kind: 'session_event', text: '自动压缩完成' })
            break
          }
          case 'auto_compact_failed': {
            appendEntry(set, {
              kind: 'session_event',
              text: `自动压缩失败: ${String(fields.error ?? '未知错误')}`,
              warning: true,
            })
            break
          }
          case 'auto_compact_cancelled':
            appendEntry(set, { kind: 'session_event', text: '自动压缩已取消' })
            break
          case 'auto_continue_completed': {
            const tokens = fields.total_tokens as number | undefined
            appendEntry(set, {
              kind: 'session_event',
              text: `继续生成${tokens != null ? ` (共 ${tokens} tokens)` : ''}`,
            })
            break
          }
          case 'image_compressed':
            appendEntry(set, {
              kind: 'session_event',
              text: `图片已压缩${fields.message ? `: ${String(fields.message)}` : ''}`,
            })
            break
          case 'session_recap': {
            const summary = typeof fields.summary === 'string' ? fields.summary : ''
            if (!summary.trim()) break
            appendEntry(set, {
              kind: 'session_event',
              text: `摘要: ${summary}`,
              recap: true,
              open: false,
            })
            break
          }
          case 'session_recap_unavailable':
            appendEntry(set, {
              kind: 'session_event',
              text: '暂无会话摘要（尚无对话内容）',
              recap: true,
              open: false,
            })
            break
          default:
            break
        }
        break
      }
      case 'task_backgrounded':
        handleTaskBackgrounded(get, set, extractSessionUpdate(ev.params).fields)
        break
      case 'task_completed':
        handleTaskCompleted(get, set, extractSessionUpdate(ev.params).fields)
        break
      case 'monitor_event': {
        const { fields } = extractSessionUpdate(ev.params)
        const taskId = String(fields.task_id ?? '')
        const entryId = taskId ? get().bgTaskIndex[taskId] : undefined
        const text = typeof fields.event_text === 'string' ? fields.event_text : ''
        if (entryId && text) {
          set({
            entries: get().entries.map((e) =>
              e.id === entryId && e.kind === 'bg_task'
                ? {
                    ...e,
                    detail: e.detail ? `${e.detail}\n${text}` : text,
                  }
                : e,
            ),
          })
        }
        break
      }
      case 'git_head_changed': {
        const p = ev.params ?? {}
        const branch = p.branch == null ? undefined : String(p.branch)
        set({
          gitInfo: {
            branch: branch === '' ? '(detached)' : branch,
            isWorktree: !!p.isWorktree,
            mainRepo: p.mainRepo == null ? undefined : String(p.mainRepo),
          },
        })
        break
      }
      case 'yolo_mode_changed': {
        const p = ev.params ?? {}
        const yolo = typeof p.yoloMode === 'boolean' ? p.yoloMode : undefined
        const auto = typeof p.autoMode === 'boolean' ? p.autoMode : undefined
        const perm =
          typeof p.permissionMode === 'string' && p.permissionMode
            ? p.permissionMode
            : undefined
        set({ yoloMode: yolo, autoMode: auto, permissionMode: perm })
        break
      }
      case 'mcp_server_status': {
        const p = ev.params ?? {}
        const name = p.name ? String(p.name) : ''
        if (!name) break
        const existing = get().mcpServers.find((s) => s.name === name)
        const row: McpServerInfo = {
          name,
          source: existing?.source ?? (p.source ? String(p.source) : undefined),
          status: p.status ? String(p.status) : existing?.status,
          reason: p.reason ? String(p.reason) : existing?.reason,
          detail: p.detail ? String(p.detail) : existing?.detail,
        }
        set({
          mcpServers: [
            ...get().mcpServers.filter((s) => s.name !== name),
            row,
          ],
        })
        break
      }
      case 'mcp_tools_changed':
      case 'mcp_servers_updated':
        set({ mcpVersion: get().mcpVersion + 1 })
        break
      case 'sessions_changed':
        void get().refreshSessions()
        break
      case 'models_update': {
        // Best-effort: payload may carry {modelId, modelName} or {models:[…]}.
        const p = ev.params ?? {}
        const name =
          (typeof p.modelName === 'string' && p.modelName) ||
          (typeof p.modelId === 'string' && p.modelId) ||
          (typeof p.model === 'string' && p.model)
        if (name) set({ modelName: name })
        break
      }
      case 'scheduled_task_fired': {
        const p = ev.params ?? {}
        const taskId = p.taskId ? String(p.taskId) : undefined
        appendEntry(set, {
          kind: 'status',
          text: `定时任务触发${taskId ? ` (${taskId})` : ''}`,
        })
        break
      }
      case 'scheduled_task_inject_prompt': {
        const p = ev.params ?? {}
        const taskId = p.taskId ? String(p.taskId) : undefined
        appendEntry(set, {
          kind: 'status',
          text: `定时任务注入提示词${taskId ? ` (${taskId})` : ''}`,
        })
        break
      }
      case 'prompt_complete': {
        // A prompt finished server-side (scheduled injection); seal leftovers.
        const sealed = sealThought(get())
        set(sealed)
        break
      }
      case 'ext_notification': {
        // Unknown x.ai/* notification — render a dim status line so nothing
        // is silently dropped (matches the host's generic forwarding).
        appendEntry(set, {
          kind: 'status',
          text: `扩展通知: ${ev.method ?? 'x.ai/*'}`,
        })
        break
      }
      case 'modes_update':
        set({ modes: ev.modes })
        break
      case 'session_info':
        if (ev.title != null && String(ev.title).trim()) {
          set({ sessionTitle: String(ev.title).trim() })
        }
        break
      case 'model': {
        const name =
          (ev.modelName && String(ev.modelName).trim()) ||
          (ev.modelId && String(ev.modelId).trim()) ||
          undefined
        set({
          modelName: name,
          reasoningEffort: ev.reasoningEffort
            ? String(ev.reasoningEffort)
            : get().reasoningEffort,
        })
        break
      }
      case 'config_options_update': {
        // Best-effort: ACP config options may carry current model id/name.
        const opts = ev.configOptions as
          | Array<{ id?: string; type?: string; currentValue?: unknown; options?: Array<{ value?: string; name?: string }> }>
          | { model?: string; modelId?: string; modelName?: string }
          | undefined
        if (!opts) break
        if (Array.isArray(opts)) {
          const modelOpt = opts.find(
            (o) =>
              o?.id === 'model' ||
              o?.type === 'model' ||
              String(o?.id || '').toLowerCase().includes('model'),
          )
          if (modelOpt?.currentValue != null) {
            const cv = String(modelOpt.currentValue)
            const named = modelOpt.options?.find((x) => x.value === cv)?.name
            set({ modelName: (named && String(named)) || cv })
          }
        } else {
          const name =
            (opts.modelName && String(opts.modelName)) ||
            (opts.modelId && String(opts.modelId)) ||
            (opts.model && String(opts.model))
          if (name) set({ modelName: name })
        }
        break
      }
      default:
        break
    }
  },

  send: async (text: string) => {
    const t = text.trim()
    if (!t) return
    // Seal any leftover thought from prior turn, then append user + Thinking… shell
    const sealed = sealThought(get())
    const thoughtId = nid()
    set({
      ...sealed,
      entries: [
        ...sealed.entries,
        { id: nid(), kind: 'user', text: t },
        {
          id: thoughtId,
          kind: 'thought',
          text: '',
          open: true,
          streaming: true,
          startedAt: Date.now(),
        },
      ],
      openAssistantId: undefined,
      openThoughtId: thoughtId,
      conn: 'busy',
      statusText: 'Thinking…',
    })
    try {
      await transport.prompt([{ type: 'text', text: t }])
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // drop empty thinking shell on failure
      const after = sealThought(get())
      set({
        ...after,
        conn: 'error',
        statusText: msg,
        entries: [...after.entries, { id: nid(), kind: 'error', text: msg }],
      })
    }
  },

  cancel: async () => {
    await transport.cancel()
  },

  respondPermission: async (requestId, optionId, cancelled) => {
    await transport.respondPermission(requestId, optionId, cancelled)
    set({ pending: get().pending.filter((p) => p.requestId !== requestId) })
  },

  respondXai: async (requestId, result, error) => {
    try {
      await transport.respondClientRequest(requestId, result, error)
    } finally {
      set({ xaiRequests: get().xaiRequests.filter((r) => r.requestId !== requestId) })
    }
  },

  dismissXai: async (requestId) => {
    await get().respondXai(requestId, { outcome: 'cancelled' })
  },

  requestRecap: async () => {
    try {
      await transport.recap(false)
      set({ statusText: '正在生成摘要…' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        statusText: '摘要失败',
        entries: [...get().entries, { id: nid(), kind: 'error', text: msg }],
      })
    }
  },

  forkSession: async (opts) => {
    try {
      const r = await transport.forkSession(opts ?? {})
      const newId =
        (r.result as Record<string, unknown> | undefined)?.newSessionId as
          | string
          | undefined
      appendEntry(set, {
        kind: 'status',
        text: newId ? `已 fork 新会话 ${newId.slice(0, 8)}…` : '已 fork 新会话',
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `fork 失败: ${msg}` }],
      })
    }
  },

  renameSession: async (title) => {
    try {
      await transport.renameSession(title)
      set({ sessionTitle: title, statusText: `已重命名为「${title}」` })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `重命名失败: ${msg}` }],
      })
    }
  },

  cancelSubagent: async (subagentId) => {
    try {
      await transport.cancelSubagent(subagentId)
      set({ statusText: '正在取消子代理…' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `取消子代理失败: ${msg}` }],
      })
    }
  },

  killTask: async (taskId) => {
    try {
      await transport.killTask(taskId)
      set({ statusText: '正在终止后台任务…' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        entries: [...get().entries, { id: nid(), kind: 'error', text: `终止任务失败: ${msg}` }],
      })
    }
  },

  refreshSessions: async () => {
    try {
      const sessions = await transport.listSessions()
      set({ sessions })
    } catch {
      /* ignore */
    }
  },

  newSession: async () => {
    set({
      entries: [],
      openAssistantId: undefined,
      openThoughtId: undefined,
      toolIndex: {},
      pending: [],
      xaiRequests: [],
      subagentIndex: {},
      bgTaskIndex: {},
      gitInfo: undefined,
      yoloMode: undefined,
      autoMode: undefined,
      permissionMode: undefined,
      mcpServers: [],
      selectedId: null,
      focusMode: 'prompt',
      expandedGroups: new Set(),
      viewerEntryId: null,
      historySessionId: undefined,
      historyCwd: undefined,
      historyTotalCount: undefined,
      historyLoadedCount: 0,
      historyHasMore: false,
      historyLoadingMore: false,
      historyPrependedAt: undefined,
      historyAnchorId: undefined,
    })
    await transport.newSession()
  },

  toggleTool: (id) => {
    set({
      entries: get().entries.map((e) =>
        e.id === id && e.kind === 'tool' ? { ...e, expanded: !e.expanded } : e,
      ),
      selectedId: id,
      focusMode: 'scrollback',
    })
  },

  toggleThought: (id) => {
    set({
      entries: get().entries.map((e) =>
        e.id === id && e.kind === 'thought' ? { ...e, open: !e.open } : e,
      ),
      selectedId: id,
      focusMode: 'scrollback',
    })
  },

  toggleUser: (id) => {
    set({
      entries: get().entries.map((e) =>
        e.id === id && e.kind === 'user' ? { ...e, expanded: !e.expanded } : e,
      ),
      selectedId: id,
      focusMode: 'scrollback',
    })
  },

  setFocus: (mode) => {
    const s = get()
    if (mode === 'scrollback') {
      const ids = selectableRowIds(s.entries, s.expandedGroups)
      const id =
        s.selectedId && ids.includes(s.selectedId)
          ? s.selectedId
          : (ids[ids.length - 1] ?? null)
      set({ focusMode: 'scrollback', selectedId: id })
    } else {
      set({ focusMode: 'prompt' })
    }
  },

  selectEntry: (id) => set({ selectedId: id, focusMode: id ? 'scrollback' : get().focusMode }),

  selectDelta: (delta) => {
    const { entries, selectedId, expandedGroups } = get()
    const ids = selectableRowIds(entries, expandedGroups)
    if (ids.length === 0) return
    const idx = selectedId ? ids.indexOf(selectedId) : -1
    let next = idx < 0 ? (delta > 0 ? 0 : ids.length - 1) : idx + delta
    next = Math.max(0, Math.min(ids.length - 1, next))
    set({ selectedId: ids[next], focusMode: 'scrollback' })
  },

  toggleGroupExpansion: (anchorId) => {
    const next = new Set(get().expandedGroups)
    if (next.has(anchorId)) next.delete(anchorId)
    else next.add(anchorId)
    set({ expandedGroups: next, focusMode: 'scrollback', selectedId: `gh_${anchorId}` })
  },

  setExpanded: (expanded) => {
    const { selectedId, entries, expandedGroups } = get()
    if (!selectedId) return

    // Group header (synthetic gh_<anchorId>): expand/collapse the whole run
    if (selectedId.startsWith('gh_')) {
      const anchorId = selectedId.slice(3)
      const next = new Set(expandedGroups)
      if (expanded) next.add(anchorId)
      else next.delete(anchorId)
      set({ expandedGroups: next, focusMode: 'scrollback' })
      return
    }

    const idx = entries.findIndex((e) => e.id === selectedId)
    const entry = idx >= 0 ? entries[idx] : undefined
    if (!entry) return

    const memberCollapsed =
      (entry.kind === 'tool' && !entry.expanded) ||
      (entry.kind === 'thought' && !entry.open)

    // ← on already-collapsed member inside an expanded group → fold the group
    if (!expanded && memberCollapsed) {
      const spans = scanGroups(entries, expandedGroups)
      const span = spanContaining(spans, idx)
      if (span?.expanded) {
        const next = new Set(expandedGroups)
        next.delete(span.anchorId)
        set({
          expandedGroups: next,
          selectedId: `gh_${span.anchorId}`,
          focusMode: 'scrollback',
        })
      }
      return
    }

    if (entry.kind === 'tool') {
      if (!!entry.expanded === expanded) return
      set({
        entries: entries.map((e) =>
          e.id === selectedId && e.kind === 'tool' ? { ...e, expanded } : e,
        ),
        focusMode: 'scrollback',
      })
      return
    }
    if (entry.kind === 'thought') {
      if (!!entry.open === expanded) return
      set({
        entries: entries.map((e) =>
          e.id === selectedId && e.kind === 'thought' ? { ...e, open: expanded } : e,
        ),
        focusMode: 'scrollback',
      })
      return
    }
    if (entry.kind === 'user') {
      if (!!entry.expanded === expanded) return
      set({
        entries: entries.map((e) =>
          e.id === selectedId && e.kind === 'user' ? { ...e, expanded } : e,
        ),
        focusMode: 'scrollback',
      })
      return
    }
    if (entry.kind === 'session_event' && entry.recap) {
      set({
        entries: entries.map((e) =>
          e.id === selectedId && e.kind === 'session_event'
            ? { ...e, open: expanded }
            : e,
        ),
        focusMode: 'scrollback',
      })
    }
  },

  toggleSelected: () => {
    const { selectedId, entries, expandedGroups } = get()
    if (!selectedId) return
    if (selectedId.startsWith('gh_')) {
      const anchorId = selectedId.slice(3)
      get().toggleGroupExpansion(anchorId)
      return
    }
    const e = entries.find((x) => x.id === selectedId)
    if (!e) return
    // Inline fold only (←/→/click/Space). Enter uses openViewer instead.
    if (e.kind === 'tool') get().setExpanded(!e.expanded)
    else if (e.kind === 'thought') get().setExpanded(!e.open)
    else if (e.kind === 'user') get().setExpanded(!e.expanded)
    else if (e.kind === 'session_event' && e.recap) get().setExpanded(!e.open)
    else {
      const idx = entries.findIndex((x) => x.id === selectedId)
      const spans = scanGroups(entries, expandedGroups)
      const span = spanContaining(spans, idx)
      if (span && !span.expanded) get().toggleGroupExpansion(span.anchorId)
    }
  },

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
      e.kind !== 'plan'
    ) {
      return
    }
    if (e.kind === 'tool' && !e.raw && !e.title) return
    set({
      viewerEntryId: target,
      selectedId: target,
      focusMode: 'scrollback',
    })
  },

  closeViewer: () => {
    set({ viewerEntryId: null })
  },
}))

/** Selectable row ids in display order (entries + synthetic group headers). */
function selectableRowIds(
  entries: ScrollEntry[],
  expandedGroups: ReadonlySet<string>,
): string[] {
  const spans = scanGroups(entries, expandedGroups)
  const rows = projectDisplayRows(entries, spans)
  return rows.map((r) => (r.type === 'entry' ? r.entry.id : r.id))
}

// ── history envelope replay ───────────────────────────────────────
//
// A stored update is the JSONL envelope {timestamp, method, params} with
// params = {sessionId, update}. Mirrors the host's session/update mapping.

/** Updates per history page; older pages load on scroll-up. */
const HISTORY_PAGE_SIZE = 100

/** Replay raw history envelopes through the live event pipeline. */
function replayUpdates(getStore: () => ChatState, updates: unknown[]): void {
  let userBuf = ''
  const flushUser = () => {
    if (userBuf) {
      getStore().handleEvent({ type: 'user_message', text: userBuf })
      userBuf = ''
    }
  }
  for (const env of updates) {
    const ev = envelopeToEvent(env)
    if (!ev) continue
    if (ev.type === 'user_message') {
      userBuf += ev.text
      continue
    }
    flushUser()
    getStore().handleEvent(ev)
  }
  flushUser()
}

type RawEnvelope = {
  method?: string
  params?: { sessionId?: string; update?: Record<string, unknown> }
}

/** Extract text from an ACP content value (string | {text} | nested | array). */
function contentText(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(contentText).join('')
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.text === 'string') return o.text
    return contentText(o.content)
  }
  return ''
}

/** Strip <fork-context>/<resume-context> wrappers from user message text. */
function stripContextWrappers(text: string): string {
  for (const tag of ['fork-context', 'resume-context']) {
    const open = `<${tag}>`
    const closeTag = `</${tag}>`
    for (;;) {
      const s = text.indexOf(open)
      if (s < 0) break
      const rel = text.slice(s + open.length).indexOf(closeTag)
      if (rel < 0) break
      const end = s + open.length + rel
      text = text.slice(0, s) + text.slice(end + closeTag.length).trimStart()
    }
  }
  return text
}

/**
 * Convert one stored session/update envelope into the AcpEvent the live
 * pipeline understands, or null when it carries no renderable content.
 */
function envelopeToEvent(env: unknown): AcpEvent | null {
  const e = env as RawEnvelope
  if (!e || (e.method !== 'session/update' && e.method !== '_x.ai/session/update')) {
    return null
  }
  const up = e.params?.update
  if (!up) return null
  switch (up.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = contentText(up.content)
      return text ? { type: 'chunk', text } : null
    }
    case 'agent_thought_chunk': {
      const text = contentText(up.content)
      return text ? { type: 'thought', text } : null
    }
    case 'user_message_chunk': {
      const text = contentText(up.content)
      return text ? { type: 'user_message', text: stripContextWrappers(text) } : null
    }
    case 'tool_call':
      return { type: 'tool_call', toolCall: up as unknown as ToolCall }
    case 'tool_call_update':
      return { type: 'tool_call_update', toolCallUpdate: up as unknown as ToolCall }
    case 'plan':
      return { type: 'plan', entries: up.entries }
    case 'usage_update':
      return {
        type: 'usage',
        used: up.used as number | undefined,
        size: up.size as number | undefined,
        cost: up.cost,
      }
    case 'current_mode_update':
      return { type: 'modes_update', modes: up.modeState }
    case 'config_option_update':
      return { type: 'config_options_update', configOptions: up.configOptions }
    case 'session_info_update':
      return { type: 'session_info', title: up.title as string | undefined }
    default:
      return null
  }
}

/** Pull a display model name from ACP agentInfo when present. */
function extractModelFromAgentInfo(info: unknown): string | undefined {
  if (!info || typeof info !== 'object') return undefined
  const o = info as Record<string, unknown>
  for (const k of ['modelName', 'model', 'modelId', 'name']) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  const models = o.models
  if (models && typeof models === 'object') {
    const m = models as Record<string, unknown>
    const cur = m.current ?? m.currentModel ?? m.selected
    if (typeof cur === 'string' && cur.trim()) return cur.trim()
    if (cur && typeof cur === 'object') {
      const c = cur as Record<string, unknown>
      for (const k of ['name', 'modelName', 'id', 'modelId']) {
        const v = c[k]
        if (typeof v === 'string' && v.trim()) return v.trim()
      }
    }
  }
  return undefined
}

/**
 * Finish an open thought block when content moves on.
 * Empty placeholder (busy fired but no thought chunks) is removed entirely.
 */
function sealThought(
  s: ChatState,
): Pick<ChatState, 'entries' | 'openAssistantId' | 'openThoughtId'> {
  if (!s.openThoughtId) {
    return {
      entries: s.entries,
      openAssistantId: s.openAssistantId,
      openThoughtId: s.openThoughtId,
    }
  }
  const tid = s.openThoughtId
  const existing = s.entries.find((e) => e.id === tid)
  // Drop empty Thinking… placeholder if agent never sent thought chunks
  if (existing?.kind === 'thought' && !existing.text.trim()) {
    return {
      openAssistantId: s.openAssistantId,
      openThoughtId: undefined,
      entries: s.entries.filter((e) => e.id !== tid),
    }
  }
  return {
    openAssistantId: s.openAssistantId,
    openThoughtId: undefined,
    entries: s.entries.map((e) => {
      if (e.id !== tid || e.kind !== 'thought') return e
      const elapsed =
        e.startedAt != null ? formatElapsed(Date.now() - e.startedAt) : e.elapsed
      // Collapse body after finish (TUI collapsed "Thought for Xs")
      // finishedAt drives the short finish-flash accent (EntryRenderer)
      return {
        ...e,
        streaming: false,
        elapsed,
        open: false,
        finishedAt: Date.now(),
      }
    }),
  }
}

// ── x.ai/* event helpers ──────────────────────────────────────────

type SetState = (
  partial:
    | Partial<ChatState>
    | ((s: ChatState) => Partial<ChatState>),
) => void

/**
 * Normalize an x.ai notification payload. The shell sends either the
 * SessionNotification envelope {"update": {"sessionUpdate": tag, …}} or a
 * flat {"sessionUpdate": tag, …} (headless wire form).
 */
function extractSessionUpdate(
  params?: Record<string, unknown>,
): { tag?: string; fields: Record<string, unknown> } {
  const u = (params?.update as Record<string, unknown> | undefined) ?? params ?? {}
  const tag = typeof u.sessionUpdate === 'string' ? u.sessionUpdate : undefined
  return { tag, fields: u }
}

/** Distributive Omit (works over the ScrollEntry union). */
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never
type EntryWithoutId = DistributiveOmit<ScrollEntry, 'id'>

/** Append a non-streaming entry to the scrollback. */
function appendEntry(set: SetState, entry: EntryWithoutId): void {
  set((s) => ({
    entries: [...s.entries, { id: nid(), ...entry } as ScrollEntry],
  }))
}

/** subagent_spawned / subagent_finished (session_notification carrier). */
function handleSubagentEvent(
  get: () => ChatState,
  set: SetState,
  tag: string,
  fields: Record<string, unknown>,
): void {
  const id = String(fields.subagent_id ?? fields.child_session_id ?? '')
  if (!id) return
  const entryId = get().subagentIndex[id]

  if (tag === 'subagent_spawned') {
    if (entryId) return // already tracked
    const title =
      (typeof fields.description === 'string' && fields.description) ||
      (typeof fields.subagent_type === 'string' && fields.subagent_type) ||
      id
    const eid = nid()
    set((s) => ({
      subagentIndex: { ...s.subagentIndex, [id]: eid },
      entries: [
        ...s.entries,
        {
          id: eid,
          kind: 'subagent',
          title,
          status: 'started',
          running: true,
          subagentId: id,
        },
      ],
    }))
    return
  }

  // finished
  if (!entryId) return
  const statusRaw = typeof fields.status === 'string' ? fields.status : 'completed'
  const status =
    statusRaw === 'completed' || statusRaw === 'failed' || statusRaw === 'cancelled'
      ? statusRaw
      : 'completed'
  const durMs = typeof fields.duration_ms === 'number' ? fields.duration_ms : undefined
  set({
    entries: get().entries.map((e) =>
      e.id === entryId && e.kind === 'subagent'
        ? {
            ...e,
            status,
            running: false,
            finishedAt: Date.now(),
            detail: durMs != null ? `${(durMs / 1000).toFixed(0)}s` : e.detail,
          }
        : e,
    ),
  })
}

/** task_backgrounded — create or promote a bg_task entry. */
function handleTaskBackgrounded(
  get: () => ChatState,
  set: SetState,
  fields: Record<string, unknown>,
): void {
  const id = String(fields.task_id ?? '')
  if (!id) return
  if (get().bgTaskIndex[id]) return // already tracked
  const command =
    (typeof fields.command === 'string' && fields.command) || undefined
  const monitor =
    (typeof fields.monitor_description === 'string' && fields.monitor_description) ||
    undefined
  const notif =
    (typeof fields.notif_description === 'string' && fields.notif_description) ||
    undefined
  const eid = nid()
  set((s) => ({
    bgTaskIndex: { ...s.bgTaskIndex, [id]: eid },
    entries: [
      ...s.entries,
      {
        id: eid,
        kind: 'bg_task',
        title: monitor ?? command ?? `任务 ${id.slice(0, 8)}`,
        status: 'started',
        running: true,
        taskId: id,
        detail: notif,
      },
    ],
  }))
}

/** task_completed — settle a bg_task entry (finish flash). */
function handleTaskCompleted(
  get: () => ChatState,
  set: SetState,
  fields: Record<string, unknown>,
): void {
  // Envelope: {task_snapshot: {task_id, …}} (possibly nested in update).
  const snap = (fields.task_snapshot as Record<string, unknown> | undefined) ?? {}
  const id = String(snap.task_id ?? fields.task_id ?? '')
  if (!id) return
  const entryId = get().bgTaskIndex[id]
  if (!entryId) return
  set({
    entries: get().entries.map((e) =>
      e.id === entryId && e.kind === 'bg_task'
        ? {
            ...e,
            status: 'completed',
            running: false,
            finishedAt: Date.now(),
          }
        : e,
    ),
  })
}
