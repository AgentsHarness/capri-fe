import { memo, useState } from 'react'
import { useChatStore } from '../../store/chat'
import { accentOpts } from '../../scrollback/accentOpts'
import { displayRowToEntry } from '../../scrollback/displayRow'
import type { DisplayRow } from '../../scrollback/verbGroup'
import { Accents, resolveBullet } from '../../theme/accents'
import { Glyphs } from '../../theme/glyphs'
import { Bullet, EntryShell } from './EntryShell'

export type GroupHeaderViewProps = {
  row: Extract<DisplayRow, { type: 'group_header' }>
  selected: boolean
  pendingFreeze: boolean
  now: number
  onToggle: () => void
  dense?: boolean
  denseNext?: boolean
  densePrev?: boolean
  /** 迷你 scrollback 局部选中（缺省主 store selectEntry）。 */
  selectRow?: (id: string) => void
}

/** Group headers have no finish-flash — `now` clock ticks never re-render. */
function groupHeaderEqual(
  prev: GroupHeaderViewProps,
  next: GroupHeaderViewProps,
): boolean {
  return (
    prev.row === next.row &&
    prev.selected === next.selected &&
    prev.pendingFreeze === next.pendingFreeze &&
    prev.onToggle === next.onToggle &&
    prev.dense === next.dense &&
    prev.denseNext === next.denseNext &&
    prev.densePrev === next.densePrev &&
    prev.selectRow === next.selectRow
  )
}

export const GroupHeaderView = memo(function GroupHeaderView({
  row,
  selected,
  pendingFreeze,
  now,
  onToggle,
  dense = true,
  denseNext = false,
  densePrev = false,
  selectRow,
}: GroupHeaderViewProps) {
  const storeSelectEntry = useChatStore((s) => s.selectEntry)
  const selectEntry = selectRow ?? storeSelectEntry
  const e = displayRowToEntry(row)
  const [hovered, setHovered] = useState(false)
  const toggle = () => {
    selectEntry(row.id)
    onToggle()
  }
  const shell = {
    e,
    selected,
    hovered,
    onHover: setHovered,
    onSelect: () => selectEntry(row.id),
    onFold: toggle,
    pendingFreeze,
    now,
    dense,
    denseNext,
    densePrev,
  }
  const opts = accentOpts(e, selected, pendingFreeze, now, hovered)
  const bullet = resolveBullet(opts)
  // › when collapsed group is selected/hovered
  const caret =
    !row.span.expanded && (selected || hovered) ? Glyphs.chevron : null
  // Expanded verb header uses ⌄ on hover (TUI point_down)
  const glyph =
    caret ||
    (row.span.expanded && (selected || hovered)
      ? Glyphs.chevronDown
      : Glyphs.diamondDotted)

  return (
    <EntryShell {...shell}>
      <button
        type="button"
        onClick={(ev) => {
          ev.stopPropagation()
          selectEntry(row.id)
          onToggle()
        }}
        className="flex w-full items-center gap-1.5 text-left py-0 text-[13px] leading-[1.35]"
      >
        <Bullet
          color={bullet.color}
          animated={bullet.animated && !caret}
          glyph={glyph}
        />
        <span
          className="min-w-0 truncate font-bold leading-[1.35]"
          style={{
            color: row.label.failed
              ? Accents.error
              : row.label.running
                ? Accents.running
                : 'var(--color-gn-gray)',
          }}
        >
          {row.label.text}
        </span>
        {/* 官方 density 预览：聚合头右侧的彩色 diffstat（`+1 -1`）。
            增删都为 0（纯新建空文件）时不摆一对 0。 */}
        {row.label.diffstat &&
        (row.label.diffstat.insertions > 0 || row.label.diffstat.deletions > 0) ? (
          <span className="shrink-0 font-mono text-[12px] leading-[1.35]">
            <span className="text-gn-green">+{row.label.diffstat.insertions}</span>{' '}
            <span className="text-gn-red">-{row.label.diffstat.deletions}</span>
          </span>
        ) : null}
      </button>
    </EntryShell>
  )
}, groupHeaderEqual)
