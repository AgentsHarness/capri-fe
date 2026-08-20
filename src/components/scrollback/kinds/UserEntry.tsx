import type { ScrollEntry } from '../../../api/types'
import {
  USER_COLLAPSED_MAX_LINES,
  collapseUserText,
  userIsFoldable,
} from '../../../scrollback/userText'
import { entryExpanded } from '../../../scrollback/entryState'
import { Glyphs } from '../../../theme/glyphs'
import { Bullet, EntryShell } from '../EntryShell'
import { InlineImages } from '../InlineImages'
import { PromptTime } from '../PromptTime'
import type { EntryChrome } from '../chrome'

export function UserEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'user' }>
  chrome: EntryChrome
}) {
  const { shell, onHeaderClick, onHeaderDblClick, toggleUser, openViewer } = chrome
  // UserPromptBlock: full-width bg_light band, accent_user ❯ prefix
  // (↻ for is_cron scheduled /loop fires), continuation indent, optional
  // collapse to 3 visual lines + " …".
  const foldable = userIsFoldable(e.text)
  const expanded = entryExpanded(e)
  const { text: body, truncated } = expanded
    ? { text: e.text, truncated: false }
    : collapseUserText(e.text, USER_COLLAPSED_MAX_LINES)
  // Selected prompts step up slightly (TUI selected → silver / stronger band)
  const band = shell.selected
    ? 'color-mix(in srgb, var(--color-gn-bg-highlight) 70%, var(--color-gn-bg-hover))'
    : 'var(--color-gn-bg-highlight)'
  const lines = body.split('\n')
  // Collapse chevron sits at the right edge; the time overlay shifts left
  // of it so the two never cover each other.
  const chevronShown = foldable && (shell.selected || shell.hovered) && !expanded
  // TUI: is_bash → "$ " (command color), is_cron → "↻  ", else prompt_arrow.
  // Shell-mode submissions carry the isShell marker from the store's send().
  const isShell = e.isShell === true
  const prefixGlyph = isShell ? '$' : e.isCron ? Glyphs.cronPrompt : Glyphs.promptArrow
  const prefixColor = isShell
    ? 'var(--color-gn-cyan)'
    : 'var(--color-gn-accent-user)'
  return (
    <EntryShell {...shell} bandBg={band}>
      <button
        type="button"
        onClick={(ev) => {
          ev.stopPropagation()
          onHeaderClick(() => {
            shell.onSelect()
            if (foldable) toggleUser(e.id)
          })
        }}
        onDoubleClick={(ev) => {
          ev.stopPropagation()
          ev.preventDefault()
          onHeaderDblClick()
        }}
        className="group relative flex w-full min-w-0 items-start gap-1.5 py-[11px] text-left font-ui text-[13.5px] leading-[1.35]"
        title={
          isShell
            ? 'shell command · click fold · dblclick / enter view'
            : e.isCron
              ? 'scheduled task · click fold · dblclick / enter view'
              : 'click fold · dblclick / enter view'
        }
      >
        {/* Same icon column as tool/thought bullets so ❯ / ↻ / ◆ / › line up.
            Icon box is 1.2em@13px = 15.6px; first text line is 13.5px×1.35 ≈ 18.2px.
            mt-[1.5px] centers prefix on the first line (items-start keeps multiline top-aligned). */}
        <Bullet
          color={prefixColor}
          glyph={prefixGlyph}
          className={`mt-[1.5px] ${isShell ? 'font-mono' : ''}`}
        />
        <div className="min-w-0 flex-1 text-gn-fg">
          {lines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-words">
              {/* Icon sits in a sibling column (flex gap); continuations already
                  share the first line's text start — no extra indent (TUI uses
                  prefix-width spaces only when prefix is inline on each line). */}
              {line || (i < lines.length - 1 ? '\u00A0' : '')}
            </div>
          ))}
          {truncated && foldable && (
            <span className="sr-only"> (collapsed, expand with →)</span>
          )}
        </div>
        {/* TUI right-aligned prompt time (scrollback_pane show_timestamps);
            absolute overlay: hover expansion never reflows the message. */}
        <PromptTime ts={e.ts} className="top-[14.5px]" shiftRight={chevronShown} />
        {chevronShown && (
          <span
            className="ml-1 shrink-0 self-start text-[12px] text-gn-gray-dim"
            aria-hidden
          >
            {Glyphs.chevron}
          </span>
        )}
      </button>
      {/* User-sent images (echoed back / attached): thumbnails under the
          prompt text, aligned with the text column (icon col + gap). */}
      {e.images?.length ? (
        <div className="pb-2 pl-[22px]">
          <InlineImages
            images={e.images}
            size="user"
            onOpen={() => openViewer(e.id)}
          />
        </div>
      ) : null}
    </EntryShell>
  )
}
