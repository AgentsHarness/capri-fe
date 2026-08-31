import type { MouseEvent as ReactMouseEvent } from 'react'
import type { ScrollEntry } from '../../../api/types'
import { toolHeaderExtra } from '../../../scrollback/toolHeaderExtra'
import { Accents } from '../../../theme/accents'
import { Glyphs, toolHeader } from '../../../theme/glyphs'
import { ToolDetail } from '../../ToolDetail'
import { Bullet, EntryShell } from '../EntryShell'
import type { EntryChrome } from '../chrome'

export function ToolEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'tool' }>
  chrome: EntryChrome
}) {
  const {
    shell,
    bullet,
    caret,
    bulletGlyph,
    rowBtn,
    onHeaderClick,
    onHeaderDblClick,
    toggleTool,
    openViewer,
    cwd,
  } = chrome
  const running = e.status === 'pending' || e.status === 'in_progress'
  const failed = e.status === 'failed' || e.status === 'error'
  const { verb } = toolHeader(e.kindName, running)
  const verbColor = failed
    ? Accents.error
    : e.expanded
      ? 'var(--color-gn-fg)'
      : Accents.gray
  const targetColor =
    e.expanded && !failed ? 'var(--color-gn-path)' : Accents.gray
  const detailColor = 'var(--color-gn-muted)'

  // TUI collapsed_line / header_line: the row noun, path paint and suffix all
  // depend on which surface this is — collapsed one-liner vs inline expand.
  const headerExtra = e.raw
    ? toolHeaderExtra(e.raw, e.kindName, failed, e.mergedRaws, {
        surface: e.expanded ? 'expanded' : 'collapsed',
        cwd,
        status: e.status,
      })
    : null
  const displayVerb = headerExtra?.verb ?? verb
  const bare = headerExtra?.bare
  const target = bare ? '' : (headerExtra?.target ?? e.title)
  const head = bare ? '' : headerExtra?.head
  const suffix = headerExtra?.suffix

  return (
    <EntryShell {...shell}>
      <button
        type="button"
        onClick={(ev: ReactMouseEvent) => {
          ev.stopPropagation()
          // Single click: inline fold (TUI ←/→)
          onHeaderClick(() => toggleTool(e.id))
        }}
        onDoubleClick={(ev) => {
          ev.stopPropagation()
          ev.preventDefault()
          // Double click: fullscreen viewer (TUI Enter / OpenBlockViewer)
          onHeaderDblClick()
        }}
        className={rowBtn}
        title="click fold · dblclick / enter view"
      >
        <Bullet
          color={bullet.color}
          animated={bullet.animated && !caret}
          glyph={bulletGlyph}
        />
        {bare ? (
          // TUI SentMessageToolCallBlock: one bold sentence, no noun/target split.
          <span
            className="min-w-0 truncate font-bold"
            style={{ color: verbColor }}
          >
            {bare}
          </span>
        ) : (
          <>
            <span
              className="shrink-0 font-bold"
              style={{ color: verbColor }}
            >
              {displayVerb}
            </span>
            {headerExtra?.marker ? (
              // TUI 的 (user) 幽灵标记：直连 bash 执行的命令行。
              <span
                className="shrink-0 text-[12px]"
                style={{ color: detailColor }}
              >
                {headerExtra.marker}
              </span>
            ) : null}
            <span className="flex min-w-0 flex-1 truncate font-mono text-[12.5px] leading-[1.35]">
              {head ? (
                // 目录前缀先被压缩，末段（文件名）固定——TUI 的
                // fit-to-width 规则在浏览器里的等价实现。
                <span
                  className="min-w-0 shrink truncate"
                  style={{ color: targetColor }}
                >
                  {head}
                </span>
              ) : null}
              <span className="shrink-0" style={{ color: targetColor }}>
                {target}
              </span>
            </span>
            {suffix ? (
              <span
                className="min-w-0 truncate text-[12px] leading-[1.35]"
                style={{ color: detailColor }}
              >
                {suffix}
              </span>
            ) : null}
          </>
        )}
        {running && (
          <span className="ml-auto shrink-0 text-[10px] text-gn-cyan tabular-nums">
            {Glyphs.ellipsis}
          </span>
        )}
      </button>
      {/* Inline expand = TUI Truncated preview; full body via Enter/dblclick. */}
      {e.expanded && e.raw ? (
        <div
          onDoubleClick={(ev) => {
            ev.stopPropagation()
            openViewer(e.id)
          }}
          title="double-click or enter for full view"
        >
          <ToolDetail
            raw={e.raw}
            kindName={e.kindName}
            full={false}
            mergedRaws={e.mergedRaws}
          />
        </div>
      ) : null}
    </EntryShell>
  )
}
