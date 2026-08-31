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

  // TUI header suffixes: range / match count / entry count / exit etc.
  const headerExtra = e.raw
    ? toolHeaderExtra(e.raw, e.kindName, failed, e.mergedRaws)
    : null
  // TUI ReadToolCallBlock skill reads: header renders as "Skill {name}" —
  // no Read verb, no path, no range suffix.
  const skill = headerExtra?.skill
  const displayVerb = skill ? 'Skill' : verb
  const target = skill ?? headerExtra?.target ?? e.title
  const suffix = skill ? undefined : headerExtra?.suffix

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
        <span
          className="shrink-0 font-bold"
          style={{ color: verbColor }}
        >
          {displayVerb}
        </span>
        <span
          className="min-w-0 truncate font-mono text-[12.5px] leading-[1.35]"
          style={{ color: targetColor }}
        >
          {target}
        </span>
        {suffix ? (
          <span
            className="min-w-0 truncate text-[12px] leading-[1.35]"
            style={{ color: detailColor }}
          >
            {suffix}
          </span>
        ) : null}
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
