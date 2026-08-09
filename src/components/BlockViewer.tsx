/**
 * Fullscreen block viewer (TUI OpenBlockViewer / Ctrl-F / Enter).
 *
 * Shows untruncated content for the selected scrollback entry.
 * Esc / backdrop click / close button dismisses.
 *
 * BgTask: live stdout (TUI BlockViewerPane::for_bg_task) — polled via
 * x.ai/task/list while the task is still running.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { formatTurnDuration, planTodos, useChatStore, type ViewerTask } from '../store/chat'
import type { ScrollEntry } from '../api/types'
import { subagentMeta } from '../format'
import { ToolDetail } from './ToolDetail'
import { Markdown } from './Markdown'
import { Glyphs, toolHeader } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'
import { TodoMark } from './todoMark'
import { fmtBytes, fmtTok } from '../format'
import { extractToolDetail } from '../scrollback/toolDetail'
import { mergeLiveText } from '../scrollback/liveText'
import {
  EntryView,
  GroupHeaderView,
  type EntryViewActions,
} from './Scrollback'
import {
  displayRowKey,
  isDensePackableRow,
  projectDisplayRows,
  scanGroups,
  spanContaining,
} from '../scrollback/verbGroup'
import { COLUMN_PAD_X_CLASS, CONTENT_COLUMN_CLASS } from '../theme/layout'

/** Poll interval for live bg_task stdout while the viewer is open. */
const BG_TASK_POLL_MS = 1500

/** Synthesize a bg_task entry from a task-only view (top strip / replay). */
function taskViewToEntry(v: ViewerTask): ScrollEntry {
  return {
    id: `task_${v.taskId}`,
    kind: 'bg_task',
    title: v.title || `Task ${v.taskId.slice(0, 8)}`,
    status: v.failed ? 'failed' : v.running || !v.completed ? 'started' : 'completed',
    running: !!v.running,
    taskId: v.taskId,
    command: v.command,
    outputFile: v.outputFile,
    output: v.output ?? '',
  }
}

export function BlockViewer() {
  const viewerId = useChatStore((s) => s.viewerEntryId)
  const taskView = useChatStore((s) => s.viewerTask)
  const entries = useChatStore((s) => s.entries)
  const liveStream = useChatStore((s) => s.liveStream)
  const closeViewer = useChatStore((s) => s.closeViewer)
  const refreshTaskOutput = useChatStore((s) => s.refreshTaskOutput)
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyScrollRef = useRef<HTMLDivElement>(null)

  const entry = viewerId
    ? entries.find((e) => e.id === viewerId) ?? null
    : null
  // Live-streamed text lives OUT of entries as a delta/suffix buffer —
  // merge additively for the viewer (same formula as EntryView /
  // mergeLiveText). Never replace entry.text with liveStream.text alone.
  const liveDelta =
    entry && liveStream?.entryId === entry.id ? liveStream.text : undefined
  const liveEntry =
    entry && liveDelta != null && 'text' in entry
      ? { ...entry, text: mergeLiveText(entry.text, liveDelta) }
      : entry
  // Task-only view (top strip / history replay): the log lives in
  // viewerTask, fetched session-scoped — one code path with bg_task rows.
  const active = taskView ? taskViewToEntry(taskView) : liveEntry

  // Focus trap + Esc
  useEffect(() => {
    if (!viewerId && !taskView) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeViewer()
      }
    }
    // Capture so we beat scrollback keys
    window.addEventListener('keydown', onKey, true)
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [viewerId, taskView, closeViewer])

  // Lock body scroll while open
  useEffect(() => {
    if (!viewerId && !taskView) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [viewerId, taskView])

  // Live-poll stdout while a running bg_task is open (TUI tick_bg_task).
  // Task-only views poll through the host's session-scoped reconstruction.
  const bgTaskId =
    active?.kind === 'bg_task' && active.running && active.taskId
      ? active.taskId
      : null
  const bgTaskSessionId = taskView?.sessionId
  const bgTaskCwd = taskView?.cwd
  useEffect(() => {
    if (!bgTaskId) return
    void refreshTaskOutput(bgTaskId, bgTaskSessionId, bgTaskCwd)
    const t = window.setInterval(() => {
      void refreshTaskOutput(bgTaskId, bgTaskSessionId, bgTaskCwd)
    }, BG_TASK_POLL_MS)
    return () => window.clearInterval(t)
  }, [bgTaskId, bgTaskSessionId, bgTaskCwd, refreshTaskOutput])

  // Stick to bottom while a running bg_task streams new output.
  const bgOutputLen =
    active?.kind === 'bg_task' ? (active.output?.length ?? 0) : 0
  const bgRunning = active?.kind === 'bg_task' ? !!active.running : false
  useEffect(() => {
    if (!bgRunning) return
    const el = bodyScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [bgRunning, bgOutputLen])

  if ((!viewerId || !entry) && !taskView) return null
  if (!active) return null

  const { title, subtitle } = viewerChrome(active)

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/55 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeViewer()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="m-0 flex h-full w-full max-w-[960px] flex-col bg-gn-bg-base shadow-2xl outline-none sm:m-4 sm:h-[calc(100%-2rem)] sm:rounded border border-gn-prompt-border-active sm:border"
      >
        {/* Title bar */}
        <header className="flex shrink-0 items-center gap-2 border-b border-gn-prompt-border bg-gn-bg-dark px-3 py-2 sm:rounded-t">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-bold text-gn-fg">{title}</div>
            {subtitle ? (
              <div className="truncate font-mono text-[11px] text-gn-muted">
                {subtitle}
              </div>
            ) : null}
          </div>
          <span className="hidden text-[10px] text-gn-gutter sm:inline">
            esc close · scroll to read
          </span>
          <button
            type="button"
            onClick={() => closeViewer()}
            className="shrink-0 rounded border border-transparent px-2 py-1 text-[12px] text-gn-muted hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8"
            aria-label="Close viewer"
          >
            <span className="mr-1 inline-flex items-center">
              <IconGlyph glyph={Glyphs.ballotX} color="currentColor" />
            </span>
            close
          </button>
        </header>

        {/* Full content — no truncation */}
        <div
          ref={bodyScrollRef}
          className="gn-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4"
        >
          <ViewerBody entry={active} />
        </div>
      </div>
    </div>
  )
}

function viewerChrome(e: ScrollEntry): { title: string; subtitle?: string } {
  if (e.kind === 'tool') {
    const running = e.status === 'pending' || e.status === 'in_progress'
    const { verb } = toolHeader(e.kindName, running)
    let subtitle = e.title
    if (e.raw) {
      try {
        const d = extractToolDetail(e.raw, e.kindName)
        if (d.kind === 'read') subtitle = d.path
        else if (d.kind === 'execute')
          subtitle = d.command || d.description || e.title
        else if (d.kind === 'edit') subtitle = d.path
        else if (d.kind === 'search') subtitle = d.pattern
        else if (d.kind === 'list_dir') subtitle = d.path
        else if (d.kind === 'fetch') subtitle = d.url
        else if (d.kind === 'web_search') subtitle = d.query
        else if (d.kind === 'use_tool') subtitle = d.toolName
      } catch {
        /* keep title */
      }
    }
    return { title: verb, subtitle }
  }
  if (e.kind === 'thought') {
    return {
      title: e.streaming ? 'Thinking' : 'Thought',
      subtitle: e.elapsed ? `for ${e.elapsed}` : undefined,
    }
  }
  if (e.kind === 'user') return { title: 'User prompt' }
  if (e.kind === 'assistant') return { title: 'Assistant' }
  if (e.kind === 'image') return { title: 'Image', subtitle: e.mimeType }
  if (e.kind === 'error') return { title: 'Error' }
  if (e.kind === 'plan') return { title: 'Plan' }
  if (e.kind === 'bg_task') {
    const verb =
      e.status === 'started'
        ? 'Task running'
        : e.status === 'completed'
          ? 'Task completed'
          : 'Task failed'
    return {
      title: verb,
      subtitle: e.command || e.title,
    }
  }
  if (e.kind === 'subagent') {
    return {
      title: e.running ? 'Agent running' : `Agent ${e.status}`,
      subtitle: e.title,
    }
  }
  return { title: e.kind }
}

function ViewerBody({ entry }: { entry: ScrollEntry }) {
  if (entry.kind === 'tool' && entry.raw) {
    return (
      <ToolDetail
        raw={entry.raw}
        kindName={entry.kindName}
        full
        className="mt-0"
      />
    )
  }
  if (entry.kind === 'tool') {
    return (
      <pre className="whitespace-pre-wrap break-all font-mono text-[12px] text-gn-muted">
        {JSON.stringify(entry, null, 2)}
      </pre>
    )
  }
  if (entry.kind === 'user') {
    return (
      <div className="space-y-3">
        <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-gn-fg font-ui">
          {entry.text || <span className="text-gn-muted">(empty)</span>}
        </div>
        {entry.images?.length ? <ViewerImages images={entry.images} /> : null}
      </div>
    )
  }
  if (entry.kind === 'thought' || entry.kind === 'error') {
    return (
      <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-gn-fg font-ui">
        {entry.text || <span className="text-gn-muted">(empty)</span>}
      </div>
    )
  }
  if (entry.kind === 'assistant') {
    return (
      <div className="space-y-3">
        <Markdown source={entry.text} />
        {entry.images?.length ? <ViewerImages images={entry.images} /> : null}
      </div>
    )
  }
  if (entry.kind === 'image') {
    return <ViewerImages images={[{ data: entry.data, mimeType: entry.mimeType }]} />
  }
  if (entry.kind === 'plan') {
    // Same structured todo list as the scrollback block (TUI todo pane).
    const items = planTodos(entry.entries).items
    return (
      <div className="space-y-[3px]">
        {items.length === 0 ? (
          <div className="text-[11px] text-gn-muted">（空计划）</div>
        ) : (
          items.map((t, i) => (
            <div key={t.id ?? i} className="flex items-start gap-2 text-[13px] leading-snug">
              <span className="mt-[1px] shrink-0 font-mono text-[11px]" aria-hidden>
                <TodoMark status={t.status} />
              </span>
              <span
                className={`min-w-0 flex-1 break-words ${
                  t.status === 'completed' || t.status === 'cancelled'
                    ? 'text-gn-muted'
                    : 'text-gn-fg'
                }`}
              >
                {t.content}
              </span>
              {t.priority && (
                <span className="shrink-0 text-[10px] text-gn-gutter">{t.priority}</span>
              )}
            </div>
          ))
        )}
      </div>
    )
  }
  if (entry.kind === 'bg_task') {
    // TUI for_bg_task: command preamble + stdout lines.
    const stdout = entry.output ?? ''
    return (
      <div className="space-y-3">
        {(entry.command || entry.title) && (
          <div className="rounded border border-gn-prompt-border bg-gn-bg-dark px-3 py-2 font-mono text-[12px] leading-relaxed text-gn-fg">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-gn-gutter">
              command
            </div>
            <div className="whitespace-pre-wrap break-all">
              {entry.command || entry.title}
            </div>
            {entry.outputFile && (
              <div className="mt-1.5 truncate text-[10px] text-gn-muted" title={entry.outputFile}>
                log · {entry.outputFile}
              </div>
            )}
          </div>
        )}
        <div>
          <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-gn-gutter">
            <span>stdout</span>
            {entry.running && (
              <span className="normal-case tracking-normal text-gn-accent-running">
                live
              </span>
            )}
          </div>
          {stdout ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.45] text-gn-fg">
              {stdout}
            </pre>
          ) : (
            <div className="text-[12px] text-gn-muted">
              {entry.running
                ? 'Waiting for output…'
                : '(no output)'}
            </div>
          )}
        </div>
      </div>
    )
  }
  if (entry.kind === 'subagent') {
    return <SubagentView entry={entry} />
  }
  return (
    <pre className="whitespace-pre-wrap font-mono text-[12px] text-gn-muted">
      {JSON.stringify(entry, null, 2)}
    </pre>
  )
}

/** Re-render every second while a running subagent is open (live elapsed). */
function useLiveTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [active])
  return now
}

/**
 * Subagent block-viewer body — TUI tasks-pane / dashboard parity for live
 * progress (xai-grok-pager):
 * - live elapsed: running → wall-clock since spawn (wire duration_ms
 *   fallback), finished → authoritative SubagentFinished duration_ms
 *   (SubagentInfo::display_elapsed)
 * - context mini gauge: context_usage_pct + tokens_used /
 *   context_window_tokens (dashboard row context_pct)
 * - live turns / tools / tokens / error_count (SubagentProgress ticks)
 * - tools_used list (dashboard "Running: {last tool}" source)
 */
function SubagentView({
  entry,
}: {
  entry: Extract<ScrollEntry, { kind: 'subagent' }>
}) {
  const now = useLiveTick(!!entry.running)
  const meta = subagentMeta(entry.persona, entry.role, entry.model)
  const subagentViews = useChatStore((s) => s.subagentViews)
  // 迷你 scrollback 按 child_session_id 取数（宿主转发的子代理会话事件流）。
  const childSid = entry.childSessionId
  const view = childSid ? subagentViews[childSid] : undefined

  const elapsedMs = entry.running
    ? entry.startedAt != null
      ? now - entry.startedAt
      : entry.durationMs
    : entry.durationMs

  // Context mini gauge (TUI dashboard context_pct; urgency breakpoints
  // match the status-bar ContextChip: ≥90 red, ≥70 yellow, else cyan).
  const pct = entry.contextUsagePct
  const gaugeW = 20
  const filled =
    pct != null ? Math.min(gaugeW, Math.round((Math.min(100, pct) / 100) * gaugeW)) : 0
  const gaugeColor =
    pct == null
      ? 'text-gn-gutter'
      : pct >= 90
        ? 'text-gn-red'
        : pct >= 70
          ? 'text-gn-yellow'
          : 'text-gn-cyan'

  const live =
    entry.turns != null ||
    entry.toolCalls != null ||
    entry.tokensUsed != null ||
    entry.errorCount != null ||
    entry.toolsUsed?.length
  const stats = [
    entry.subagentType ? `type · ${entry.subagentType}` : undefined,
    entry.turns != null ? `turns · ${entry.turns}` : undefined,
    entry.toolCalls != null ? `tools · ${entry.toolCalls}` : undefined,
    entry.tokensUsed != null ? `tokens · ${fmtTok(entry.tokensUsed)}` : undefined,
    entry.errorCount != null && entry.errorCount > 0
      ? `errors · ${entry.errorCount}`
      : undefined,
    elapsedMs != null ? `elapsed · ${formatTurnDuration(elapsedMs)}` : undefined,
  ].filter((s): s is string => !!s)

  return (
    <div className="space-y-2">
      <div className="font-mono text-[12px] text-gn-fg">{entry.title}</div>
      {meta && <div className="font-mono text-[12px] text-gn-muted">{meta}</div>}

      {/* 状态区置顶：running 的 gauge/统计/tools_used + error + 结束态统计 */}
      <div className="space-y-1.5">
        {entry.running && (
          <>
            {/* Live context gauge — hidden until the host reports a window. */}
            {entry.contextWindowTokens != null && entry.contextWindowTokens > 0 && (
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1 font-mono text-[12px] leading-none ${gaugeColor}`}
                  title={`上下文 ${Math.round(pct ?? 0)}%`}
                >
                  <span aria-hidden className="whitespace-nowrap">
                    <span>{'█'.repeat(filled)}</span>
                    <span className="text-gn-gray-dim">{'░'.repeat(gaugeW - filled)}</span>
                  </span>
                  <span className="tabular-nums">
                    {(pct ?? 0).toFixed(1)}%
                  </span>
                </span>
                <span className="font-mono text-[11px] tabular-nums text-gn-gutter">
                  {entry.tokensUsed != null
                    ? `${fmtTok(entry.tokensUsed)} / ${fmtTok(entry.contextWindowTokens)} tok`
                    : `${fmtTok(entry.contextWindowTokens)} tok window`}
                </span>
              </div>
            )}
            {live && stats.length > 0 && (
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums text-gn-gutter">
                {stats.map((s) => (
                  <span key={s}>{s}</span>
                ))}
              </div>
            )}
            {entry.toolsUsed && entry.toolsUsed.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-1.5 font-mono text-[11px] text-gn-gutter">
                <span className="uppercase tracking-wide text-[10px]">tools</span>
                {entry.toolsUsed.map((t) => (
                  <span
                    key={t}
                    className="rounded border border-gn-prompt-border/60 px-1.5 py-0.5 text-gn-muted"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
        {entry.error && (
          <div className="rounded border border-gn-red/40 bg-gn-diff-del-bg px-2.5 py-1.5 font-mono text-[12px] text-gn-red">
            {entry.error}
          </div>
        )}
        {!entry.running && stats.length > 0 && (
          <div className="font-mono text-[11px] tabular-nums text-gn-gutter">
            {stats.join(' · ')}
          </div>
        )}
      </div>

      {/* 活动时间线（scrollback）置底：状态区之后、id 脚注之前 */}
      {childSid && (
        <SubagentTimeline
          childSid={childSid}
          items={view?.items ?? []}
          running={!!entry.running}
          now={now}
          prompt={entry.title && entry.title !== entry.subagentId ? entry.title : ''}
        />
      )}

      {entry.subagentId && (
        <div className="font-mono text-[11px] text-gn-gutter">
          id · {entry.subagentId}
        </div>
      )}
    </div>
  )
}

/**
 * 子代理的活动时间线（迷你 scrollback，TUI subagent_views 同款）。
 * 数据来自宿主转发的子代理会话事件流（live 捕获，store 侧
 * applySubagentViewEvent）或按需历史回放（fetchSubagentView）。
 * 打开时若视图为空（例如历史回放场景没有 live 捕获）会触发一次
 * 子代理会话 updates 拉取——动作内部有 loading/loaded 去重。
 *
 * 渲染直接复用主 scrollback 的体系（任务 1）：条目已是主模型 ScrollEntry，
 * 这里走同一条管线——scanGroups + projectDisplayRows → EntryView /
 * GroupHeaderView（内部即 EntryShell + AccentRail(resolveAccent) +
 * Bullet(resolveBullet)，accent 竖条/动词分组头/折叠展开/字体配色全部
 * 与主 scrollback 一致）。选中/折叠用组件内局部状态（expandedGroups
 * 局部化），不接主 store 的 selectEntry/openViewer——mini 条目不在主
 * entries 里，openViewer 会找不到目标。
 */
function SubagentTimeline({
  childSid,
  items,
  running,
  now,
  prompt,
}: {
  childSid: string
  items: ScrollEntry[]
  running: boolean
  now: number
  prompt: string
}) {
  const fetchSubagentView = useChatStore((s) => s.fetchSubagentView)
  const scrollRef = useRef<HTMLDivElement>(null)
  // 迷你视图的折叠/选中全部局部化：主 scrollback 的 expandedGroups /
  // selectedId 不接（mini 条目不在主 entries 里）。
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // 打开时若时间线为空，按 child_session_id 拉取该子代理会话的更新
  // 回放（TUI replay_inherited_updates 同款）。
  useEffect(() => {
    if (items.length === 0) void fetchSubagentView(childSid)
  }, [childSid, items, fetchSubagentView])

  // running 时自动滚到底（与 bg_task 的 stick-to-bottom 同款）。
  useEffect(() => {
    if (!running) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [running, items])

  // 主 scrollback 同款分组管线：scanGroups → projectDisplayRows。
  const { rows, spans } = useMemo(() => {
    const spans = scanGroups(items, expandedGroups)
    return { rows: projectDisplayRows(items, spans), spans }
  }, [items, expandedGroups])

  // 折叠覆盖（按条目 id）：工具/用户折叠与思考 displayMode 本地化——
  // 不写回 store，渲染时以 patch 合并进条目（EntryView 的 patch 语义）。
  // patch 对象按 (id, kind, value) 缓存，保证引用稳定——EntryView 的
  // memo 比较（entryViewEqual 的 patch === patch）才不会失效。
  const foldPatchCache = useRef(new Map<string, Partial<ScrollEntry>>())
  const foldPatch = (e: ScrollEntry): Partial<ScrollEntry> | undefined => {
    const v = folds.get(e.id)
    if (v == null) return undefined
    const cache = foldPatchCache.current
    const key = `${e.id}:${e.kind}:${String(v)}`
    let p = cache.get(key)
    if (!p) {
      p =
        e.kind === 'thought'
          ? ({ displayMode: v ? 'expanded' : 'collapsed' } as Partial<ScrollEntry>)
          : ({ expanded: v } as Partial<ScrollEntry>)
      cache.set(key, p)
    }
    return p
  }

  // 局部动作：折叠写本地 folds；双击不弹主 viewer；选中局部化。缺省值
  // 仍是主 store 动作（EntryView 内部取 actions ?? store），此处全部覆盖。
  const actions: EntryViewActions = useMemo(
    () => ({
      toggleTool: (id) => setFolds((m) => new Map(m).set(id, !(m.get(id) ?? false))),
      toggleThought: (id) =>
        setFolds((m) => new Map(m).set(id, !(m.get(id) ?? false))),
      toggleUser: (id) =>
        setFolds((m) => new Map(m).set(id, !(m.get(id) ?? false))),
      openViewer: () => {},
      selectEntry: (id) => setSelectedId(id),
    }),
    [],
  )

  const toggleGroupExpansion = (anchorId: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(anchorId)) next.delete(anchorId)
      else next.add(anchorId)
      return next
    })

  // 空态首条回退：spawn 携带的任务 prompt 作为第一条 user 条目（TUI
  // 同款：子代理 scrollback 首条是注入的任务 prompt）。id 用稳定的合成
  // id（只在本迷你视图内做 key/选中）。
  const promptEntry = useMemo(
    () =>
      prompt
        ? ({ id: '__mini_prompt__', kind: 'user', text: prompt, expanded: false } as const)
        : null,
    [prompt],
  )

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-gn-gutter">
        <span>activity</span>
        {running && (
          <span className="normal-case tracking-normal text-gn-accent-running">live</span>
        )}
      </div>
      {/* 平铺无边框盒（主 scrollback 同款）：滚动容器只保留 max-h / overflow 与滚动条样式 */}
      <div
        ref={scrollRef}
        className="gn-scroll max-h-[35vh] overflow-y-auto"
      >
        {items.length === 0 ? (
          <div className="space-y-1.5">
            {promptEntry && (
              <EntryView
                e={promptEntry}
                selected={promptEntry.id === selectedId}
                pendingFreeze={false}
                now={now}
                actions={actions}
              />
            )}
            <div className="text-[11px] text-gn-muted">
              {running
                ? '等待子代理活动上报…（数据来自宿主转发的子代理会话事件流）'
                : '（未捕获到子代理会话活动 — 无活动时间线）'}
            </div>
          </div>
        ) : (
          <div className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} py-1`}>
            {rows.map((row, i) => {
              const dense = isDensePackableRow(row)
              const densePrev = i > 0 && isDensePackableRow(rows[i - 1])
              const denseNext =
                i < rows.length - 1 && isDensePackableRow(rows[i + 1])
              if (row.type === 'group_header') {
                return (
                  <GroupHeaderView
                    key={displayRowKey(row)}
                    row={row}
                    selected={row.id === selectedId}
                    pendingFreeze={false}
                    now={now}
                    onToggle={() => toggleGroupExpansion(row.span.anchorId)}
                    dense={dense}
                    densePrev={densePrev}
                    denseNext={denseNext}
                    selectRow={setSelectedId}
                  />
                )
              }
              const e = row.entry
              return (
                <EntryView
                  key={displayRowKey(row)}
                  e={e}
                  selected={e.id === selectedId}
                  pendingFreeze={false}
                  now={now}
                  inGroup={spanContaining(spans, row.index) != null}
                  dense={dense}
                  densePrev={densePrev}
                  denseNext={denseNext}
                  actions={actions}
                  patch={foldPatch(e)}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/** Estimated decoded byte size of a data URI / base64 payload. */
function imageBytes(data: string): number {
  const comma = data.indexOf(',')
  const body = comma >= 0 ? data.slice(comma + 1) : data
  let padding = 0
  if (body.endsWith('==')) padding = 2
  else if (body.endsWith('=')) padding = 1
  return Math.max(0, Math.floor((body.length * 3) / 4) - padding)
}

/** "mimeType · 12.3 KB" caption for a viewer image. */
function imageMeta(img: { data: string; mimeType?: string }): string {
  const parts: string[] = []
  if (img.mimeType) parts.push(img.mimeType)
  parts.push(fmtBytes(imageBytes(img.data)))
  return parts.join(' · ')
}

/** Full-size images for assistant / user / standalone image entries. */
function ViewerImages({
  images,
}: {
  images: Array<{ data: string; mimeType?: string }>
}) {
  return (
    <div className="space-y-4">
      {images.map((img, i) => (
        <figure key={i} className="space-y-1">
          <img
            src={img.data}
            alt={img.mimeType ? `image (${img.mimeType})` : 'image'}
            className="max-h-[75vh] w-auto max-w-full rounded border border-gn-prompt-border object-contain"
          />
          <figcaption className="font-mono text-[11px] text-gn-muted">
            {imageMeta(img)}
          </figcaption>
        </figure>
      ))}
    </div>
  )
}
