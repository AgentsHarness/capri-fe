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
import { planTodos, useChatStore, type ViewerTask } from '../store/chat'
import type { ScrollEntry } from '../api/types'
import { ToolDetail, fmtBytes } from './ToolDetail'
import { Markdown } from './Markdown'
import { Glyphs, toolHeader } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'
import { todoMark } from './StatusChips'
import { extractToolDetail } from '../scrollback/toolDetail'

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
  const closeViewer = useChatStore((s) => s.closeViewer)
  const refreshTaskOutput = useChatStore((s) => s.refreshTaskOutput)
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyScrollRef = useRef<HTMLDivElement>(null)

  const entry = viewerId
    ? entries.find((e) => e.id === viewerId) ?? null
    : null
  // Task-only view (top strip / history replay): the log lives in
  // viewerTask, fetched session-scoped — one code path with bg_task rows.
  const active = taskView ? taskViewToEntry(taskView) : entry

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
                {todoMark(t.status)}
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
    return (
      <div className="space-y-2">
        <div className="font-mono text-[12px] text-gn-fg">{entry.title}</div>
        {entry.detail && (
          <div className="text-[12px] text-gn-muted">{entry.detail}</div>
        )}
        {entry.subagentId && (
          <div className="font-mono text-[11px] text-gn-gutter">
            id · {entry.subagentId}
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
