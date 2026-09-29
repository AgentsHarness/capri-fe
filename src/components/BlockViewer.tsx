/**
 * Fullscreen block viewer (TUI OpenBlockViewer / Ctrl-F / Enter).
 *
 * Shows untruncated content for the selected scrollback entry.
 * Esc / backdrop click / close button dismisses.
 *
 * BgTask: live stdout (TUI BlockViewerPane::for_bg_task) — polled via
 * x.ai/task/list while the task is still running.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Check, X } from 'lucide-react'
import { formatTurnDuration, planTodos, useChatStore, type ViewerTask } from '../store/chat'
import { ProgressBar } from './ProgressBar'
import type { ScrollEntry } from '../api/types'
import { subagentMeta } from '../format'
import { LiteToolFill } from './scrollback/LiteToolFill'
import { toolEntryLitePending } from '../store/chat/historyFill'
import { ToolDetail } from './ToolDetail'
import { Markdown } from './Markdown'
import { Ansi } from './Ansi'
import { Glyphs, SPINNER_FRAMES, toolHeader } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'
import { TodoMark } from './todoMark'
import { fmtBytes, fmtTok } from '../format'
import { contextUrgencyColor } from '../theme/contextColor'
import { Accents } from '../theme/accents'
import { toolDisplayMode } from '../scrollback/entryState'
import { toolHeaderExtra } from '../scrollback/toolHeaderExtra'
import { mergeLiveText } from '../scrollback/liveText'
import { useSessionSpinner } from '../hooks/sessionState'
import { useStickToBottom } from '../hooks/useStickToBottom'
import {
  EntryView,
  GroupHeaderView,
  type EntryViewActions,
} from './Scrollback'
import { fallbackStickyBandH, pickStickyPin } from '../scrollback/stickyPin'
import {
  USER_COLLAPSED_MAX_LINES,
  collapseUserText,
} from '../scrollback/userText'
import {
  displayRowKey,
  isDensePackableRow,
  projectDisplayRows,
  scanGroups,
  spanContaining,
} from '../scrollback/verbGroup'
import { useFePrefs } from '../store/historyPins'
import { useJunctionDissolve } from './scrollback/useJunctionDissolve'
import { useScrollbarGutter } from '../hooks/useScrollbarGutter'
import {
  COLUMN_PAD_X_CLASS,
  COMPOSER_BODY_PAD_LEFT_PX,
  CONTENT_COLUMN_CLASS,
} from '../theme/layout'

/** Poll interval for live bg_task stdout while the viewer is open. */
const BG_TASK_POLL_MS = 1500

/**
 * BgTaskBlock::preamble 的 description 预处理（bg_task.rs）：逐行裁掉行尾空白，
 * 连续空行折叠成一个空行，避免多行描述把 preamble 撑长。
 */
function preambleDescLines(desc: string): string[] {
  const whole = desc.trim()
  if (!whole) return []
  const out: string[] = []
  let prevBlank = false
  for (const line of whole.split('\n')) {
    const trimmed = line.replace(/\s+$/, '')
    if (!trimmed) {
      if (prevBlank) continue
      prevBlank = true
    } else {
      prevBlank = false
    }
    out.push(trimmed)
  }
  return out
}

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
  // 工具行路径打印基准目录（fullscreen surface 的相对/规范化解析）。
  const sessionCwd = useChatStore((s) => s.historyCwd ?? s.cwd)
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

  // 子代理弹窗 live 时钟：运行中每秒刷新（标题栏 elapsed + 状态区统计），
  // 同一时钟驱动标题栏状态图标（spinner / ✓ / ✗）。
  const subRunning = active?.kind === 'subagent' && !!active.running
  const now = useLiveTick(subRunning)
  const spinnerFrame = useSessionSpinner(subRunning)

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

  // Follow the tail while content keeps arriving (streaming thought /
  // assistant text, live bg_task stdout): pinned at the bottom the view
  // tracks growth; scrolled up it stays put until the user returns.
  // Subagent rows scroll inside SubagentView, which has its own follow.
  const bodyKind = active?.kind
  const bodyScrollable = bodyKind !== undefined && bodyKind !== 'subagent'
  const liveLogTail = active?.kind === 'bg_task' && !!active.running
  const { onScroll: onBodyScroll } = useStickToBottom(bodyScrollRef, {
    enabled: bodyScrollable,
    // A running bg_task is a live log — open on its tail, then follow the
    // user's lead. Everything else opens at the top, disarmed.
    initialFollowing: liveLogTail,
    resetKey: viewerId ?? taskView?.taskId ?? null,
  })

  if ((!viewerId || !entry) && !taskView) return null
  if (!active) return null

  // 子代理标题栏：状态图标 + 状态动词 + 任务描述 + 耗时，次行汇总模型/统计/进度。
  const subChrome =
    active.kind === 'subagent'
      ? subagentChrome(active, now, spinnerFrame)
      : null
  const { title, subtitle } = subChrome
    ? {
        title: subChrome.label,
        subtitle: subChrome.description,
      }
    : viewerChrome(active, sessionCwd)

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center gn-modal-dim"
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
        className="m-0 flex h-full w-full max-w-[960px] flex-col gn-modal-panel sm:m-4 sm:h-[calc(100%-2rem)]"
      >
        {/* Title bar */}
        <header className={subChrome ? 'gn-modal-header py-1.5' : 'gn-modal-header'}>
          {subChrome ? (
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                {subChrome.icon}
                <span
                  className={`shrink-0 text-[12.5px] font-bold ${
                    subtitle ? subChrome.statusColor : 'text-gn-fg'
                  }`}
                >
                  {title}
                </span>
                {subtitle ? (
                  <span
                    className="min-w-0 flex-1 truncate text-[13px] font-bold text-gn-fg"
                    title={subtitle}
                  >
                    {subtitle}
                  </span>
                ) : null}
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  {subChrome.elapsed ? (
                    <span className="font-mono text-[11.5px] tabular-nums text-gn-muted">
                      {subChrome.elapsed}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => closeViewer()}
                    className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                    aria-label="Close viewer"
                  >
                    <IconGlyph glyph={Glyphs.ballotX} color="currentColor" />
                    close
                  </button>
                </div>
              </div>
              {subChrome.hasSecondRow ? (
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-[19px] font-mono text-[11px] tabular-nums text-gn-gutter">
                  {subChrome.metaSegments.map((seg, i) => (
                    <span key={i} className="inline-flex items-center gap-2">
                      {i > 0 && <span aria-hidden>·</span>}
                      <span
                        className={
                          seg.tone === 'error'
                            ? 'text-gn-red'
                            : seg.tone === 'muted'
                              ? 'text-gn-muted'
                              : undefined
                        }
                      >
                        {seg.text}
                      </span>
                    </span>
                  ))}
                  {subChrome.contextGauge}
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-bold text-gn-fg">{title}</div>
                {subtitle ? (
                  <div className="truncate font-mono text-[11px] text-gn-muted">
                    {subtitle}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => closeViewer()}
                className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8"
                aria-label="Close viewer"
              >
                <IconGlyph glyph={Glyphs.ballotX} color="currentColor" />
                close
              </button>
            </>
          )}
        </header>

        {/* Full content — no truncation. 子代理：外层不滚动（px/py 由
            SubagentView 内部布局负责），时间线自身占满剩余区域滚动。 */}
        <div
          ref={bodyScrollRef}
          onScroll={onBodyScroll}
          className={
            active.kind === 'subagent'
              ? 'min-h-0 flex-1 overflow-hidden'
              : 'gn-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4'
          }
        >
          <ViewerBody entry={active} now={now} />
        </div>
      </div>
    </div>
  )
}

/** 迷你时间线点「查看」可弹全文的条目种类（主 scrollback openViewer 同款
 *  集合 + image：图片块全文即大图展示）。 */
const MINI_VIEWABLE_KINDS = new Set([
  'tool',
  'thought',
  'user',
  'assistant',
  'error',
  'plan',
  'image',
  'btw',
  'bg_task',
  'workflow',
  'subagent',
])

/**
 * 单条目全文弹窗（子代理迷你时间线「查看」复用）：与主 BlockViewer 同一套
 * viewerChrome + ViewerBody 渲染，但条目来自子代理视图（不在主 entries 里，
 * 主 viewer 查找不到）。Esc 的 window capture 监听注册晚于外层主子代理
 * viewer——嵌入打开时按 Esc 由外层优先处理（连同主弹窗一起关），此处的
 * Esc 只在无外层时兜底；按钮 / 背景点击总是可用。
 */
function BlockBodyDialog({ entry, onClose }: { entry: ScrollEntry; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null)
  const sessionCwd = useChatStore((s) => s.historyCwd ?? s.cwd)
  const { title, subtitle } = viewerChrome(entry, sessionCwd)

  useEffect(() => {
    panelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center gn-modal-dim"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="m-0 flex h-full w-full max-w-[960px] flex-col gn-modal-panel sm:m-4 sm:h-[calc(100%-2rem)]"
      >
        <header className="gn-modal-header">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-bold text-gn-fg">{title}</div>
            {subtitle ? (
              <div className="truncate font-mono text-[11px] text-gn-muted">
                {subtitle}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8"
            aria-label="Close viewer"
          >
            <IconGlyph glyph={Glyphs.ballotX} color="currentColor" />
            close
          </button>
        </header>

        {/* Full content — no truncation (mini 条目不含 subagent，外层滚动)。 */}
        <div className="gn-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4">
          <ViewerBody entry={entry} />
        </div>
      </div>
    </div>
  )
}

function viewerChrome(e: ScrollEntry, cwd?: string): { title: string; subtitle?: string } {
  if (e.kind === 'tool') {
    const running = e.status === 'pending' || e.status === 'in_progress'
    const failed = e.status === 'failed' || e.status === 'error'
    const { verb } = toolHeader(e.kindName, running)
    if (e.raw) {
      // Fullscreen surface: same rule set as the row header, only the path
      // paint differs (normalized absolute path, no collapsed suffixes).
      const extra = toolHeaderExtra(e.raw, e.kindName, failed, e.mergedRaws, {
        surface: 'fullscreen',
        cwd,
        status: e.status,
      })
      if (extra?.bare) return { title: extra.bare }
      if (extra) {
        const sub = `${extra.head ?? ''}${extra.target ?? ''}`
        return { title: extra.verb ?? verb, subtitle: sub || e.title }
      }
    }
    return { title: verb, subtitle: e.title }
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
  if (e.kind === 'btw') return { title: '/btw', subtitle: e.question }
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
  if (e.kind === 'workflow') {
    return {
      title: 'Workflow',
      subtitle: e.running ? 'running' : e.status,
    }
  }
  return { title: e.kind }
}

interface SubagentMetaSegment {
  text: string
  tone: 'muted' | 'gutter' | 'error'
}

/**
 * 子代理标题栏：
 * - 首行：状态图标（spinner / ✓ / ✗）+ 状态标签（着色）+ 加粗任务描述 + 右侧耗时与关闭按钮
 * - 次行（按需渲染）：去重后的角色/类型与模型 + 回合/工具/token/错误计数 + 当前运行工具 + 上下文进度条
 */
function subagentChrome(
  e: Extract<ScrollEntry, { kind: 'subagent' }>,
  now: number,
  spinnerFrame: number,
): {
  icon: ReactNode
  label: string
  statusColor: string
  description?: string
  elapsed?: string
  metaSegments: SubagentMetaSegment[]
  contextGauge: ReactNode
  hasSecondRow: boolean
} {
  const running = !!e.running
  const label = running
    ? 'Agent running'
    : e.status === 'completed'
      ? 'Agent done'
      : e.status === 'cancelled'
        ? 'Agent cancelled'
        : 'Agent failed'
  const statusColor = running
    ? 'text-gn-accent-running'
    : e.status === 'completed'
      ? 'text-gn-green'
      : e.status === 'cancelled'
        ? 'text-gn-yellow'
        : 'text-gn-red'
  const icon = running ? (
    <span
      className="flex w-[13px] shrink-0 items-center justify-center text-gn-accent-running"
      aria-hidden
    >
      {SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]}
    </span>
  ) : (
    <span
      className={`flex w-[13px] shrink-0 items-center justify-center ${statusColor}`}
      aria-hidden
    >
      {e.status === 'completed' ? (
        <Check size={13} strokeWidth={2.5} />
      ) : (
        <X size={13} strokeWidth={2.5} />
      )}
    </span>
  )

  const rawTitle = e.title?.trim() ?? ''
  const description =
    rawTitle && rawTitle !== e.subagentId ? rawTitle : undefined

  const elapsedMs = running
    ? e.startedAt != null
      ? Math.max(0, now - e.startedAt)
      : e.durationMs
    : e.durationMs
  const elapsed =
    elapsedMs != null ? formatTurnDuration(elapsedMs) : undefined

  const cleanType = e.subagentType?.trim()
  const fallbackRole =
    !e.persona?.trim() &&
    !e.role?.trim() &&
    cleanType &&
    cleanType.toLowerCase() !== 'general-purpose' &&
    cleanType.toLowerCase() !== description?.toLowerCase()
      ? cleanType
      : e.role
  const rawMeta = subagentMeta(
    e.persona,
    fallbackRole,
    e.model,
    e.reasoningEffort,
  ).trim()
  const identity =
    rawMeta.startsWith('(') && rawMeta.endsWith(')')
      ? rawMeta.slice(1, -1)
      : rawMeta

  const hasContextGauge =
    running &&
    e.contextWindowTokens != null &&
    e.contextWindowTokens > 0

  const metaSegments: SubagentMetaSegment[] = []
  if (identity) {
    metaSegments.push({ text: identity, tone: 'muted' })
  }
  if (e.turns != null && e.turns > 0) {
    metaSegments.push({
      text: `${e.turns} ${e.turns === 1 ? 'turn' : 'turns'}`,
      tone: 'gutter',
    })
  }
  if (e.toolCalls != null && e.toolCalls > 0) {
    metaSegments.push({
      text: `${e.toolCalls} ${e.toolCalls === 1 ? 'tool' : 'tools'}`,
      tone: 'gutter',
    })
  }
  if (!hasContextGauge && e.tokensUsed != null && e.tokensUsed > 0) {
    metaSegments.push({
      text: `${fmtTok(e.tokensUsed)} tok`,
      tone: 'gutter',
    })
  }
  if (e.errorCount != null && e.errorCount > 0) {
    metaSegments.push({
      text: `${e.errorCount} ${e.errorCount === 1 ? 'error' : 'errors'}`,
      tone: 'error',
    })
  }
  if (running && e.toolsUsed?.length) {
    metaSegments.push({
      text: `Running: ${e.toolsUsed[e.toolsUsed.length - 1]}`,
      tone: 'muted',
    })
  }

  const pct = e.contextUsagePct
  const gaugeColor =
    pct == null ? undefined : contextUrgencyColor(Math.min(100, pct))
  const contextGauge = hasContextGauge ? (
    <span className="ml-auto inline-flex items-center gap-2">
      <span
        className={`inline-flex items-center gap-1 leading-none ${pct == null ? 'text-gn-gutter' : ''}`}
        style={gaugeColor ? { color: gaugeColor } : undefined}
        title={`上下文 ${Math.round(pct ?? 0)}%`}
      >
        <ProgressBar pct={pct ?? 0} cols={10} />
        <span>{Math.round(pct ?? 0)}%</span>
      </span>
      <span>
        {e.tokensUsed != null
          ? `${fmtTok(e.tokensUsed)} / ${fmtTok(e.contextWindowTokens!)} tok`
          : `${fmtTok(e.contextWindowTokens!)} tok`}
      </span>
    </span>
  ) : null

  return {
    icon,
    label,
    statusColor,
    description,
    elapsed,
    metaSegments,
    contextGauge,
    hasSecondRow: metaSegments.length > 0 || hasContextGauge,
  }
}

function ViewerBody({
  entry,
  now,
}: {
  entry: ScrollEntry
  now?: number
}) {
  if (entry.kind === 'tool' && entry.raw) {
    if (toolEntryLitePending(entry)) {
      // 正文被 lite 裁掉：全文视图同样只给占位行（打开查看器已触发按需
      // 补全，这里是补回来之前的过渡态）。失败才出现 [重试]。
      return (
        <LiteToolFill
          bytes={entry.liteOmitted}
          state={entry.liteState}
          onFill={() => void useChatStore.getState().fillToolEntryDetail(entry.id)}
          className="mt-0"
        />
      )
    }
    return (
      <ToolDetail
        raw={entry.raw}
        kindName={entry.kindName}
        full
        mergedRaws={entry.mergedRaws}
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
  if (entry.kind === 'btw') {
    // same content as the scrollback block's expanded form: golden header +
    // error / markdown answer / waiting hint.
    return (
      <div className="space-y-2">
        <div
          className="text-[13.5px] font-bold leading-[1.35] break-words"
          style={{ color: Accents.plan }}
        >
          /btw {entry.question}
        </div>
        {entry.error ? (
          <div
            className="whitespace-pre-wrap break-words text-[13px] leading-[1.45]"
            style={{ color: Accents.error }}
          >
            {entry.error}
          </div>
        ) : entry.answer ? (
          <Markdown source={entry.answer} />
        ) : entry.streaming ? (
          <div className="text-[12.5px] text-gn-muted">等待回答…</div>
        ) : null}
      </div>
    )
  }
  if (entry.kind === 'session_event') {
    return (
      <div className="space-y-2">
        <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-gn-fg font-ui">
          {entry.text}
        </div>
      </div>
    )
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
    // TUI BgTaskBlock::preamble：description（primary 色逐行，行尾空白裁掉、
    // 连续空行折叠）+ 空行 + `$ command`（bash 高亮 FE 暂无，保持纯色）。
    const stdout = entry.output ?? ''
    const descLines = preambleDescLines(entry.title)
    return (
      <div className="space-y-3">
        {(entry.title || entry.command) && (
          <div className="rounded border border-gn-prompt-border bg-gn-bg-dark px-3 py-2 font-mono text-[12px] leading-relaxed text-gn-fg">
            {descLines.length > 0 && (
              <div>
                {descLines.map((line, i) => (
                  <div key={i} className="whitespace-pre-wrap break-words">
                    {line || '\u00a0'}
                  </div>
                ))}
              </div>
            )}
            {entry.command ? (
              <div className={descLines.length > 0 ? 'mt-2' : ''}>
                <span className="whitespace-pre text-gn-gray-dim">$ </span>
                <span className="whitespace-pre-wrap break-all">
                  {entry.command}
                </span>
              </div>
            ) : null}
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
              <Ansi text={stdout} />
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
    return <SubagentView entry={entry} now={now ?? Date.now()} />
  }
  if (entry.kind === 'workflow') {
    return (
      <div className="space-y-3">
        <div className="rounded border border-gn-prompt-border bg-gn-bg-dark px-3 py-2 font-mono text-[12px] leading-relaxed text-gn-fg">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-gn-gutter">
            status
          </div>
          <div className="whitespace-pre-wrap break-words">
            {entry.status}
            {entry.running ? ' · running' : ''}
          </div>
        </div>
        {entry.detail && (
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-gn-gutter">
              detail
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.45] text-gn-fg">
              {entry.detail}
            </pre>
          </div>
        )}
        {entry.title && entry.title !== entry.detail && (
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-gn-gutter">
              name
            </div>
            <div className="text-[12.5px] text-gn-fg">{entry.title}</div>
          </div>
        )}
      </div>
    )
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
 * Subagent block-viewer body：
 * - 顶部标题栏（subagentChrome）已收敛状态图标、描述、模型、统计、当前工具与上下文进度条
 * - 正文仅在存在错误时置顶渲染错误提示，其余空间由活动时间线占满并独立滚动
 */
function SubagentView({
  entry,
  now,
}: {
  entry: Extract<ScrollEntry, { kind: 'subagent' }>
  now: number
}) {
  const subagentViews = useChatStore((s) => s.subagentViews)
  // 迷你 scrollback 按 child_session_id 取数（宿主转发的子代理会话事件流）。
  const childSid = entry.childSessionId
  const view = childSid ? subagentViews[childSid] : undefined

  return (
    <div className="flex h-full min-h-0 flex-col">
      {entry.error && (
        <div
          className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} shrink-0 pt-2.5`}
        >
          <div className="rounded border border-gn-red/40 bg-gn-diff-del-bg px-2.5 py-1.5 font-mono text-[12px] text-gn-red">
            {entry.error}
          </div>
        </div>
      )}

      {/* 活动时间线占满剩余区域（flex-1 自行滚动）。 */}
      {childSid && (
        <SubagentTimeline
          childSid={childSid}
          items={view?.items ?? []}
          running={!!entry.running}
          now={now}
          prompt={entry.title && entry.title !== entry.subagentId ? entry.title : ''}
        />
      )}

      {/* 子代理 composer 暂不渲染（组件本体保留在下方 SubagentComposer，
          供 agent 侧支持后直接接回）。原因：它走 x.ai/subagent/message，
          该方法被 Feature::ActiveAgentMessages 门控（agent 侧
          extensions/subagent_message.rs，默认 active_agent_messages =
          false），不进注册表，调用必然返回 Method not found；即便开启，
          它要的也是 coordinator 铸的不透明 agentAddress（aa1.<hex>），
          而非 subagentId / childSessionId（本地子代理两者同为一个
          UUIDv7），且 SubagentSpawned.agentAddress 被
          without_live_agent_address 在 SessionUpdate 序列化与落盘两处
          抹掉，客户端拿不到该地址。
          重开条件：1) agent 默认启用 active_agent_messages；
          2) 客户端能拿到子代理的 agent address（或改由 host 代持、提供
          按 subagentId 寻址的通道）。届时在此处渲染
          <SubagentComposer agentAddress={...} disabled={!entry.running} />，
          地址用那时可得的真实值。 */}
    </div>
  )
}

/**
 * 弹窗底部 composer：与主页面 prompt 同一套 chrome——圆角 1px 边框
 * （未聚焦 prompt-border、聚焦 prompt-border-active）、❯ 落在与时间线
 * 相同的图标轨（CONTENT_COLUMN + COMPOSER_BODY_PAD_LEFT）、失焦正文
 * 整体减光 0.72（主 prompt 的 blend_area 同款）。子代理已结束时整块
 * 再减一档亮度表示不可用，边框不另换色。
 *
 * 当前无渲染点（见 SubagentView 里的说明），整块保留以备重接。
 * 保留就要付出未使用告警：noUnusedLocals 下 tsc -b 会报 TS6133，
 * 故导出一次（同文件内的自引用不消解该检查）。
 */
export function SubagentComposer({
  agentAddress,
  disabled,
}: {
  agentAddress: string
  disabled?: boolean
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // 与主 composer 同法：右留出滚动条槽宽度，输入框列才与上方时间线对齐
  // （时间线滚动容器用 scrollbar-gutter: stable 预留了同样的槽）。
  const gutterPx = useScrollbarGutter()
  const sendSubagentMessage = useChatStore((s) => s.sendSubagentMessage)

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const trimmed = text.trim()
      if (!trimmed || sending || !agentAddress) return
      setSending(true)
      sendSubagentMessage(agentAddress, trimmed)
        .then(() => {
          setText('')
        })
        .finally(() => {
          setSending(false)
        })
    }
  }

  const borderColor = focused
    ? 'var(--color-gn-prompt-border-active)'
    : 'var(--color-gn-prompt-border)'
  const prefixColor = focused
    ? 'var(--color-gn-accent-user)'
    : 'var(--color-gn-gray-dim)'

  return (
    <div
      className={`safe-pb shrink-0 bg-gn-bg-base pt-1 touch-pan-x overscroll-none ${
 disabled ? 'opacity-60' : ''
      }`}
      style={gutterPx ? { paddingRight: `${gutterPx}px` } : undefined}
    >
      <div className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS}`}>
        <div
          className="relative rounded-[6px] border pt-[4px] pb-[4px] font-ui transition-colors"
          style={{ borderColor }}
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest('button')) return
            inputRef.current?.focus()
          }}
        >
          <div
            className="flex min-w-0 items-start gap-1.5 py-1 pr-3"
            style={{
              paddingLeft: COMPOSER_BODY_PAD_LEFT_PX - 1,
              // 失焦减光 0.72（主 prompt 的 blend_area 同款）；禁用态由
              // 外层整块减光承担，避免两层叠加过暗。
              opacity: disabled || focused ? 1 : 0.72,
            }}
          >
            <span className="mt-[2px] shrink-0">
              <IconGlyph glyph={Glyphs.promptArrow} color={prefixColor} />
            </span>
            <input
              ref={inputRef}
              type="text"
              className="gn-no-scrollbar min-h-[20px] min-w-0 flex-1 bg-transparent font-ui text-[13.5px] leading-[1.55] text-gn-fg outline-none placeholder:text-gn-gray disabled:cursor-default"
              placeholder={disabled ? '子代理已结束' : '向子代理发送消息… (Enter 发送)'}
              value={text}
              disabled={disabled || sending || !agentAddress}
              onChange={(e) => setText(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={handleKeyDown}
            />
          </div>
        </div>
      </div>
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
 * 与主 scrollback 一致）。选中/折叠/双击全文弹窗用组件内局部状态
 * （expandedGroups/folds/viewerId 局部化），不接主 store 的
 * selectEntry/openViewer——mini 条目不在主 entries 里，主 viewer 找不到
 * 目标，双击用 BlockBodyDialog 在组件内弹同一套全文内容。
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
  const loadMoreSubagentView = useChatStore((s) => s.loadMoreSubagentView)
  const view = useChatStore((s) =>
    childSid ? s.subagentViews[childSid] : undefined,
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  const collapseToolGroups = useFePrefs((s) => s.fePrefs.collapseToolGroups)
  // 迷你视图的折叠/选中全部局部化：主 scrollback 的 expandedGroups /
  // selectedId 不接（mini 条目不在主 entries 里）。
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // DOM 全量挂载 items（与主 scrollback 一致，无渲染窗口上限）。
  const renderItems = items

  // 打开时若尚未回放过（idle），按 child_session_id 拉取该子代理会话的更新
  // 回放（TUI replay_inherited_updates 同款）。不看 items 是否为空——即使
  // live 已捕获到正在输出的 thinking，也以磁盘回放的完整历史为基线重建。
  useEffect(() => {
    if (view && view.fetchState !== 'loading' && view.fetchState !== 'loaded') {
      void fetchSubagentView(childSid)
    }
  }, [childSid, view, fetchSubagentView])

  // 上滑分页门控：仅回放填充的视图（loadedCount > 0）提供；宿主给了
  // totalCount 时严格比较，否则拉完一页即停。
  const loadedCount = view?.loadedCount ?? 0
  const hasMore =
    loadedCount > 0 &&
    (view?.totalCount != null ? loadedCount < view.totalCount : false)
  const loadingMore = view?.fetchState === 'loading' && items.length > 0

  // 内容不满视口（无滚动条）时自动补宿主历史——否则 onScroll 永远不触发。
  const autoFillStopped = useRef(false)
  useEffect(() => {
    autoFillStopped.current = false
  }, [childSid])
  useEffect(() => {
    if (autoFillStopped.current) return
    if (loadingMore) return
    const el = scrollRef.current
    if (!el || el.scrollHeight > el.clientHeight + 1) return
    if (!hasMore) return
    void loadMoreSubagentView(childSid).then((ok) => {
      autoFillStopped.current = !ok
    })
  }, [hasMore, loadingMore, renderItems, childSid, loadMoreSubagentView])

  // stick-to-bottom 跟随：与块查看弹窗正文共用 useStickToBottom——距底
  // 48px 内随内容增长钉尾，用户上滑立即让位，滑回尾部恢复。运行中的子代理
  // 打开即跟随；已结束的从顶部读起，除非用户自己滑到底。
  const {
    onScroll: measureFollow,
    pin: pinTimelineTail,
    isFollowing: timelineFollowsTail,
  } = useStickToBottom(scrollRef, {
    initialFollowing: running,
    resetKey: childSid,
  })
  // 流式条目的正文自滚交给外层容器统一滚底：mini 传一个恒空 ref
  // （streamBodyRef 存在即跳过 EntryView 的条目自滚），body 内上滑
  // 不会被"自滚拉回"。
  const miniStreamBodyRef = useRef<HTMLDivElement | null>(null)

  // ── TUI sticky prompt header（主 scrollback sticky.rs 同款）────────
  // Overlay-safe：钉最后一条完全越过顶的 user；下一条顶进 sticky 带则让路。
  // scrollTop === 0 不钉。
  const userById = useMemo(() => {
    const m = new Map<string, ScrollEntry>()
    for (const e of renderItems) if (e.kind === 'user') m.set(e.id, e)
    return m
  }, [renderItems])
  const userEls = useRef<Map<string, HTMLElement>>(new Map())
  const stickyBandElRef = useRef<HTMLDivElement | null>(null)
  const lastPushYRef = useRef(0)
  const [pinnedId, setPinnedId] = useState<string | null>(null)
  const updatePinned = useCallback(() => {
    const box = scrollRef.current
    const els = userEls.current
    if (!box || els.size === 0 || box.scrollTop <= 0) {
      lastPushYRef.current = 0
      if (stickyBandElRef.current) stickyBandElRef.current.style.transform = ''
      setPinnedId((prev) => (prev == null ? prev : null))
      return
    }
    const scrollTop = box.scrollTop
    const boxTop = box.getBoundingClientRect().top
    const stickyH =
      stickyBandElRef.current?.offsetHeight ||
      fallbackStickyBandH(7, 12.5)
    const list: { id: string; top: number; bottom: number }[] = []
    for (const [id, el] of els) {
      const top = el.getBoundingClientRect().top - boxTop + scrollTop
      list.push({ id, top, bottom: top + el.offsetHeight })
    }
    const pick = pickStickyPin(list, scrollTop, stickyH)
    lastPushYRef.current = pick.pushY
    if (stickyBandElRef.current) {
      stickyBandElRef.current.style.transform = pick.pushY
        ? `translateY(${pick.pushY}px)`
        : ''
    }
    setPinnedId((prev) => (prev === pick.id ? prev : pick.id))
  }, [])
  // 缓存 user 条目 DOM 元素；条目/折叠布局变化时重算钉选。
  useEffect(() => {
    const box = scrollRef.current
    const map = new Map<string, HTMLElement>()
    if (box) {
      for (const id of userById.keys()) {
        const el = box.querySelector(`[data-entry-id="${id}"]`)
        if (el instanceof HTMLElement) map.set(id, el)
      }
    }
    userEls.current = map
    updatePinned()
  }, [userById, updatePinned, folds])
  const pinnedUser = pinnedId ? (userById.get(pinnedId) ?? null) : null

  // 上滑到顶 → 加载更早的一页；加载前记住距底部距离，prepend 后恢复
  // 视口位置（内容插在顶部，距底距离不变 = 视觉位置稳定）。
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    measureFollow()
    updatePinned()
    if (el.scrollTop > 8 || loadingMore) return
    if (!hasMore) return
    const distFromBottom = el.scrollHeight - el.scrollTop
    void loadMoreSubagentView(childSid).then(() => {
      requestAnimationFrame(() => {
        const el2 = scrollRef.current
        if (el2) el2.scrollTop = el2.scrollHeight - distFromBottom
      })
    })
  }

  // items 变化时同步钉一次（ResizeObserver 回调晚一帧），异步撑高
  // （mermaid / 图片 / markdown 回流）由 useStickToBottom 的观察器兜住。
  // 流式思考的 4 行预览是 overflow:hidden——没有滚动条但可程序滚动，
  // 要显式钉到尾部才显示最新几行，EntryView 收口时会把该 ref 置空。
  useEffect(() => {
    pinTimelineTail()
    const bodyEl = miniStreamBodyRef.current
    if (bodyEl && timelineFollowsTail()) bodyEl.scrollTop = bodyEl.scrollHeight
  }, [running, items, pinTimelineTail, timelineFollowsTail])

  // 主 scrollback 同款分组管线：scanGroups → projectDisplayRows。
  // 只用渲染窗口内的条目（renderItems），DOM 保持扁平。
  const { rows, spans } = useMemo(() => {
    const spans = scanGroups(renderItems, expandedGroups, {
      defaultExpanded: !collapseToolGroups,
    })
    return { rows: projectDisplayRows(renderItems, spans), spans }
  }, [renderItems, expandedGroups, collapseToolGroups])

  // 折叠覆盖（按条目 id）：工具/用户折叠与思考 displayMode 本地化——
  // 不写回 store，渲染时以 patch 合并进条目（EntryView 的 patch 语义）。
  // 思考块不默认折叠：流式思考展开正文、收口后折叠（与主 live scrollback
  // 完全一致）；用户点击只切换已收口思考的展开态。
  // 兜底：子代理已结束（running:false）但视图里仍有 streaming 思考条目
  // （回放分页截断 / 终态事件缺失）→ 展示为已收口（"Thought" + 折叠）。
  // patch 对象按 (id, kind, value, running, streaming) 缓存，保证引用
  // 稳定——EntryView 的 memo 比较（entryViewEqual 的 patch === patch）
  // 才不会失效。
  const foldPatchCache = useRef(new Map<string, Partial<ScrollEntry>>())
  const foldPatch = (e: ScrollEntry): Partial<ScrollEntry> | undefined => {
    const v = folds.get(e.id)
    // 未折叠过、也无已结束兜底需要 → 不 patch（走条目自身状态）。
    if (v == null && !(e.kind === 'thought' && !running && e.streaming)) {
      return undefined
    }
    const cache = foldPatchCache.current
    const key = `${e.id}:${e.kind}:${String(v)}:${String(running)}:${'streaming' in e ? String(e.streaming) : 'none'}`
    let p = cache.get(key)
    if (!p) {
      if (e.kind === 'thought') {
        p = {
          displayMode: v ? 'expanded' : 'collapsed',
          ...(!running && e.streaming ? { streaming: false } : {}),
        } as Partial<ScrollEntry>
        cache.set(key, p)
      } else if (
        (e.kind === 'session_event' || e.kind === 'btw') &&
        v != null
      ) {
        p = { open: v } as Partial<ScrollEntry>
        cache.set(key, p)
      } else if (e.kind === 'tool' && v != null) {
        p = {
          displayMode: v ? 'expanded' : 'collapsed',
          expanded: v,
        } as Partial<ScrollEntry>
        cache.set(key, p)
      } else if (v != null) {
        p = { expanded: v } as Partial<ScrollEntry>
        cache.set(key, p)
      }
    }
    return p
  }

  // 「查看」全文弹窗（局部状态）：mini 条目不在主 entries 里，主 viewer 找
  // 不到目标——弹窗用 BlockBodyDialog 在组件内渲染同一套全文内容。
  const [viewerId, setViewerId] = useState<string | null>(null)
  const viewerEntry = useMemo(() => {
    const e = viewerId ? renderItems.find((x) => x.id === viewerId) : undefined
    return e && MINI_VIEWABLE_KINDS.has(e.kind) ? e : undefined
  }, [viewerId, renderItems])

  // 局部动作：折叠写本地 folds；「查看」打开局部全文弹窗；选中局部化。缺省值
  // 仍是主 store 动作（EntryView 内部取 actions ?? store），此处全部覆盖。
  const renderItemsRef = useRef(renderItems)
  renderItemsRef.current = renderItems
  const actions: EntryViewActions = useMemo(
    () => ({
      toggleTool: (id) => {
        const base = renderItemsRef.current.find((x) => x.id === id)
        const cur =
          folds.get(id) ??
          (base && base.kind === 'tool' ? toolDisplayMode(base) !== 'collapsed' : false)
        const next = !cur
        setFolds((m) => new Map(m).set(id, next))
        // 展开 = 要看正文：lite 裁掉的行按需补全（非 lite / 已补全 no-op）。
        if (next) void useChatStore.getState().fillToolEntryDetail(id)
      },
      toggleThought: (id) => {
        const next = !(folds.get(id) ?? false)
        setFolds((m) => new Map(m).set(id, next))
        if (next) void useChatStore.getState().fillToolEntryDetail(id)
      },
      toggleUser: (id) =>
        setFolds((m) => new Map(m).set(id, !(m.get(id) ?? false))),
      toggleSessionEvent: (id) =>
        setFolds((m) => new Map(m).set(id, !(m.get(id) ?? false))),
      openViewer: (id) => {
        // 「查看」全文同样要先有正文（fillToolEntryDetail 会按 id 找到本
        // 子代理视图里的条目）。
        void useChatStore.getState().fillToolEntryDetail(id)
        setViewerId(id)
      },
      selectEntry: (id) => setSelectedId(id),
    }),
    [folds],
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

  const timelineContentRef = useRef<HTMLDivElement>(null)
  const junctionDissolveRef = useRef<HTMLDivElement>(null)
  // 时间线底缘与 composer 的交界：主 scrollback 同一套溶解带（下方还有
  // 内容时把尾行化进底色，贴底则抬升）。
  useJunctionDissolve(scrollRef, timelineContentRef, junctionDissolveRef)

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {loadingMore && (
        <div
          className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} shrink-0 pt-1.5 text-[11px] text-gn-muted`}
        >
          加载更早…
        </div>
      )}
      {/* 平铺无边框盒（主 scrollback 同款）：滚动容器占满弹窗剩余区域
          （flex-1），自行滚动——不再固定 35vh。上滑到顶触发更早分页。 */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="gn-scroll min-h-0 flex-1 overflow-y-auto pb-2"
        // 预留滚动条槽（主 scrollback 同款）：底部 composer 按同一宽度留白，
        // 两列才不会在滚动条出现时错开。
        style={{ scrollbarGutter: 'stable' }}
      >
        {/* 常驻包装层：溶解带要观察内容高度变化，空态⇄时间线切换时
            观察目标不能换元素（否则 ResizeObserver 盯的是旧节点）。 */}
        <div ref={timelineContentRef}>
          {renderItems.length === 0 ? (
            <div
              className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} space-y-1.5 py-2`}
            >
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
              {/* TUI sticky prompt header（主 scrollback sticky.rs 同款）：与
                  rows 同父级才能获得整列高度作为 sticky 滚动范围。零高度
                  sticky 壳 + absolute 条：吸附不改文档流，避免抖动。 */}
              <div
                className="pointer-events-none sticky top-0 z-10 h-0 overflow-visible"
                aria-hidden={pinnedUser?.kind !== 'user'}
              >
                {pinnedUser?.kind === 'user' && (
                  <div
                    ref={(el) => {
                      stickyBandElRef.current = el
                      if (el && lastPushYRef.current) {
                        el.style.transform = `translateY(${lastPushYRef.current}px)`
                      }
                    }}
                    className="pointer-events-auto absolute inset-x-0 top-0 border-b border-gn-prompt-border/40 font-ui text-[12.5px] leading-[1.35] text-gn-fg select-none"
                    style={{ backgroundColor: 'var(--color-gn-bg-highlight)' }}
                  >
                    <div className="flex items-start gap-1.5 px-2.5 py-[7px]">
                      <span
                        className="mt-[1.5px] shrink-0"
                        style={{ color: 'var(--color-gn-accent-user)' }}
                        aria-hidden
                      >
                        {Glyphs.promptArrow}
                      </span>
                      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                        {collapseUserText(pinnedUser.text, USER_COLLAPSED_MAX_LINES).text}
                      </div>
                    </div>
                  </div>
                )}
              </div>
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
                    streamBodyRef={miniStreamBodyRef}
                  />
                )
              })}
            </div>
          )}
        </div>
      </div>
      {/* 时间线 ⇄ composer 交界溶解带（主 scrollback 同款）：视口底缘的
          尾行不再被硬切，化进底色。武装条件与滚动条槽宽度由
          useJunctionDissolve 写在元素上。 */}
      <div
        ref={junctionDissolveRef}
        aria-hidden
        className="gn-junction-dissolve pointer-events-none absolute inset-x-0 bottom-0 z-[2] h-7"
      />
      {viewerEntry ? (
        <BlockBodyDialog entry={viewerEntry} onClose={() => setViewerId(null)} />
      ) : null}
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
