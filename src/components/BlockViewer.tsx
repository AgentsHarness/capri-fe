/**
 * Fullscreen block viewer (TUI OpenBlockViewer / Ctrl-F / Enter).
 *
 * Shows untruncated content for the selected scrollback entry.
 * Esc / backdrop click / close button dismisses.
 */

import { useEffect, useRef } from 'react'
import { useChatStore } from '../store/chat'
import type { ScrollEntry } from '../api/types'
import { ToolDetail } from './ToolDetail'
import { Markdown } from './Markdown'
import { Glyphs, toolHeader } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'
import { extractToolDetail } from '../scrollback/toolDetail'

export function BlockViewer() {
  const viewerId = useChatStore((s) => s.viewerEntryId)
  const entries = useChatStore((s) => s.entries)
  const closeViewer = useChatStore((s) => s.closeViewer)
  const panelRef = useRef<HTMLDivElement>(null)

  const entry = viewerId
    ? entries.find((e) => e.id === viewerId) ?? null
    : null

  // Focus trap + Esc
  useEffect(() => {
    if (!viewerId) return
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
  }, [viewerId, closeViewer])

  // Lock body scroll while open
  useEffect(() => {
    if (!viewerId) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [viewerId])

  if (!viewerId || !entry) return null

  const { title, subtitle } = viewerChrome(entry)

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
        <div className="gn-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4">
          <ViewerBody entry={entry} />
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
  if (e.kind === 'error') return { title: 'Error' }
  if (e.kind === 'plan') return { title: 'Plan' }
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
  if (entry.kind === 'thought' || entry.kind === 'user' || entry.kind === 'error') {
    return (
      <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-gn-fg font-ui">
        {entry.text || <span className="text-gn-muted">(empty)</span>}
      </div>
    )
  }
  if (entry.kind === 'assistant') {
    return <Markdown source={entry.text} streaming={entry.streaming} />
  }
  if (entry.kind === 'plan') {
    return (
      <pre className="whitespace-pre-wrap font-mono text-[12px] text-gn-muted">
        {JSON.stringify(entry.entries, null, 2)}
      </pre>
    )
  }
  return (
    <pre className="whitespace-pre-wrap font-mono text-[12px] text-gn-muted">
      {JSON.stringify(entry, null, 2)}
    </pre>
  )
}
