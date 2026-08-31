import { useRef } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { ScrollEntry } from '../../api/types'
import { AccentRail } from '../AccentRail'
import { IconGlyph } from '../IconGlyph'
import { SelectionBox } from '../SelectionBox'
import { accentOpts } from '../../scrollback/accentOpts'
import { entryExpanded, isHeaderStyleBlock } from '../../scrollback/entryState'
import { resolveAccent } from '../../theme/accents'
import { Glyphs } from '../../theme/glyphs'
import { ACCENT_GAP_PX, ACCENT_W_PX } from '../../theme/layout'
import { HOVER_BG } from './constants'

/**
 * 整块单击不折叠的嵌套交互：链接、按钮、表单，以及自行处理点击的
 * 图片缩略图（`data-no-fold`）。它们的语义优先于「单击折叠」。
 */
const NO_FOLD_SELECTOR =
  'a[href], button, input, select, textarea, [role="button"], [data-no-fold]'

/** 按下到抬起的指针位移超过该值视为选词拖拽，不算单击。 */
const DRAG_THRESHOLD_PX = 6

/** 条目外壳：accent 竖条 + 选区/悬浮框 + 内容列（主 scrollback 与迷你
 *  scrollback 共用；hover/选中由调用方传入，mini 用组件内局部状态）。 */
export function EntryShell({
  e,
  selected,
  hovered,
  onHover,
  children,
  onSelect,
  pendingFreeze,
  now,
  /** Row sits inside a group span (expanded verb / truncation tail). */
  inGroup = false,
  /** This row is dense-packable (collapsed groupable). */
  dense = false,
  /** Next display row is also dense → gap_after = 0. */
  denseNext = false,
  /** Previous display row is dense → no top margin. */
  densePrev = false,
  /**
   * Full-bleed block background (user prompt band). Spans accent + content
   * so the elevated strip matches TUI BlockBackground::Light + accent_bg.
   */
  bandBg,
  onFold,
}: {
  e: ScrollEntry
  selected: boolean
  hovered: boolean
  onHover: (h: boolean) => void
  children: React.ReactNode
  onSelect: () => void
  pendingFreeze: boolean
  now: number
  inGroup?: boolean
  dense?: boolean
  denseNext?: boolean
  densePrev?: boolean
  bandBg?: string
  /** 整块单击折叠（标题行之外的正文/留白同样生效）。 */
  onFold?: () => void
}) {
  // Accent color follows hover/selected; height follows content only.
  const opts = accentOpts(e, selected, pendingFreeze, now, hovered, inGroup)
  const paint = resolveAccent(opts)

  const collapsed = !entryExpanded(e)
  // Selected collapsed tool/thought: full bg_dark
  const selectedBg = selected && isHeaderStyleBlock(e) && collapsed
  // Hover pre-select (skip when selected — selection wins): half-blend bg
  const hoverBg =
    hovered && !selected && isHeaderStyleBlock(e) && collapsed

  // Selection wins over hover frame (render_entry_hover skips selected)
  const showFrame = selected || hovered
  const frameVariant = selected ? 'selected' : 'hover'

  // Spacing: dense↔dense gap=0; otherwise leave a small prose gap
  // User prompts get vpad (has_vpad_for) — slightly more air than dense tools.
  const isUser = e.kind === 'user'
  const mt = dense && densePrev ? 'mt-0' : dense ? 'mt-0' : isUser ? 'mt-2' : 'mt-1.5'
  const mb = dense && denseNext ? 'mb-0' : dense ? 'mb-0' : isUser ? 'mb-2' : 'mb-1.5'
  const py = dense ? 'py-0' : isUser ? 'py-0' : 'py-[2px]'
  const contentPy = dense ? 'py-0' : isUser ? 'py-0' : 'py-0.5'

  const downAt = useRef<{ x: number; y: number } | null>(null)
  const blockHit = (ev: ReactMouseEvent<HTMLDivElement>) => {
    if (ev.defaultPrevented) return false
    const el = ev.target instanceof Element ? ev.target : null
    const control = el?.closest(NO_FOLD_SELECTOR)
    // 只排除块内嵌套控件；祖先上的交互元素不算（否则整块永远点不动）。
    if (control && ev.currentTarget.contains(control)) return false
    const d = downAt.current
    if (d && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > DRAG_THRESHOLD_PX) {
      return false
    }
    return true
  }

  return (
    <div
      data-entry-id={e.id}
      data-dense={dense ? '1' : undefined}
      data-streaming={'streaming' in e && e.streaming ? '1' : undefined}
      role="option"
      aria-selected={selected}
      onClick={(ev) => {
        if (onFold && blockHit(ev)) onFold()
        else onSelect()
      }}
      onMouseDown={(ev) => {
        downAt.current =
          ev.button === 0 ? { x: ev.clientX, y: ev.clientY } : null
      }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      // Tracks: accent + gap + content. Selection compact height === entry;
      // accent is self-stretch max-h-full so it never exceeds the frame.
      className={`relative grid ${mt} ${mb} ${py}`}
      style={{
        gridTemplateColumns: `${ACCENT_W_PX}px 1fr`,
        columnGap: ACCENT_GAP_PX,
        backgroundColor: bandBg
          ? bandBg
          : selectedBg
            ? 'var(--color-gn-bg-dark)'
            : hoverBg
              ? HOVER_BG
              : undefined,
      }}
    >
      {showFrame && (
        // Taller frame (OUTSET_Y) wraps the block; accent centers in 选区.
        <SelectionBox variant={frameVariant} />
      )}
      <AccentRail paint={paint} />
      <div className={`min-w-0 ${contentPy}`}>{children}</div>
    </div>
  )
}

export function Bullet({
  color,
  animated,
  glyph = Glyphs.diamondFilled,
  className = '',
}: {
  color: string
  animated?: boolean
  glyph?: string
  className?: string
}) {
  return (
    <IconGlyph glyph={glyph} color={color} animated={animated} className={className} />
  )
}

/**
 * Shared fixed icon column for row-level status marks: 16px wide, one line box
 * tall (1.35em of the parent text), 13px glyph centred. Same left track as
 * `Bullet`, so a row's text starts at the same x whichever status icon it
 * carries, and the mark stays centred on the first line when the text wraps.
 */
export function RowIcon({
  Icon,
  color,
}: {
  Icon: LucideIcon
  color: string
}) {
  return (
    <span
      className="flex h-[1.35em] w-4 shrink-0 items-center justify-center"
      style={{ color }}
      aria-hidden
    >
      <Icon size={13} strokeWidth={2} />
    </span>
  )
}
