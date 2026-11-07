import { useEffect, useRef } from 'react'
import { useChatStore } from '../../store/chat'
import type { ScrollEntry } from '../../api/types'
import { hasOpenLightbox } from '../../lib/lightboxState'
import { useStickToBottom } from '../../hooks/useStickToBottom'
import { Glyphs } from '../../theme/glyphs'
import { IconGlyph } from '../ui/IconGlyph'
import { viewerChrome } from '../../scrollback/viewerChrome'
import { ViewerBody } from './BlockViewerBody'

/**
 * 单条目全文弹窗（子代理迷你时间线「查看」复用）：与主 BlockViewer 同一套
 * viewerChrome + ViewerBody 渲染，但条目来自子代理视图（不在主 entries 里，
 * 主 viewer 查找不到）。Esc 的 window capture 监听注册晚于外层主子代理
 * viewer——嵌入打开时按 Esc 由外层优先处理（连同主弹窗一起关），此处的
 * Esc 只在无外层时兜底；按钮 / 背景点击总是可用。
 */
export function BlockBodyDialog({ entry, onClose }: { entry: ScrollEntry; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const sessionCwd = useChatStore((s) => s.historyCwd ?? s.cwd)
  const { title, subtitle } = viewerChrome(entry, sessionCwd)
  const { onScroll: onBodyScroll } = useStickToBottom(bodyRef, {
    initialFollowing: entry.kind === 'thought',
    resetKey: entry.id,
    smooth: entry.kind === 'thought',
  })

  useEffect(() => {
    panelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (hasOpenLightbox()) return
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
        <div
          ref={bodyRef}
          onScroll={onBodyScroll}
          className="gn-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4"
        >
          <ViewerBody entry={entry} />
        </div>
      </div>
    </div>
  )
}
