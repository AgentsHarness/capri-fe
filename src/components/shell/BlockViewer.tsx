/**
 * Fullscreen block viewer (TUI OpenBlockViewer / Ctrl-F / Enter).
 *
 * Shows untruncated content for the selected scrollback entry.
 * Esc / backdrop click / close button dismisses.
 *
 * BgTask: live stdout (TUI BlockViewerPane::for_bg_task) — polled via
 * x.ai/task/list while the task is still running.
 */

import { useEffect, useRef } from 'react'
import { useChatStore } from '../../store/chat'
import { Glyphs } from '../../theme/glyphs'
import { IconGlyph } from '../ui/IconGlyph'
import { hasOpenLightbox } from '../../lib/lightboxState'
import { mergeLiveText } from '../../scrollback/liveText'
import { useSessionSpinner } from '../../hooks/sessionState'
import { useStickToBottom } from '../../hooks/useStickToBottom'
import { useLiveTick } from '../../hooks/useLiveTick'
import { taskViewToEntry } from '../../scrollback/bgTaskView'
import { viewerChrome } from '../../scrollback/viewerChrome'
import { subagentChrome } from './SubagentChrome'
import { ViewerBody } from './BlockViewerBody'

/** Poll interval for live bg_task stdout while the viewer is open. */
const BG_TASK_POLL_MS = 1500

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
        // 图片放大预览叠在本弹窗上：这一下 Esc 只关预览。
        if (hasOpenLightbox()) return
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
  // 思考全文弹窗默认打开在最新处（长思考先看尾部），并继续跟随流式增长；
  // 运行中的 bg_task 同理。其他条目保持从顶部开始。
  const openAtTail = liveLogTail || active?.kind === 'thought'
  const { onScroll: onBodyScroll } = useStickToBottom(bodyScrollRef, {
    enabled: bodyScrollable,
    initialFollowing: openAtTail,
    resetKey: viewerId ?? taskView?.taskId ?? null,
    smooth: active?.kind === 'thought',
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

export { SubagentComposer } from './SubagentComposer'
