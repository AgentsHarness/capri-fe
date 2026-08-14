import type { ScrollEntry } from '../../../api/types'
import { mergeLiveText } from '../../../scrollback/liveText'
import { Markdown } from '../../Markdown'
import { EntryShell } from '../EntryShell'
import { InlineImages } from '../InlineImages'
import { PromptTime } from '../PromptTime'
import type { EntryChrome } from '../chrome'

export function AssistantEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'assistant' }>
  chrome: EntryChrome
}) {
  const { shell, liveText, onHeaderDblClick, openViewer } = chrome
  // liveText = liveStream delta/suffix for this entry only (not a full
  // replacement). Additive merge works for both store shapes:
  // entry.text '' + live full stream, or base + later chunks in liveStream.
  const displayText = mergeLiveText(e.text, liveText)
  // Prefer liveText presence for settle-on-flush; also keep plain-text
  // path while e.streaming (e.g. mid-tool after live cleared into entry).
  const streamActive = liveText != null || !!e.streaming
  return (
    <EntryShell {...shell}>
      {/* Reserve the short-form time's width (TUI ts_reserved=10 cols; sm:
          only — the time itself is hidden on mobile) so text never runs
          under it; the hover expansion still overlays content by design. */}
      <div
        className="group relative min-w-0 sm:pr-9"
        title="dblclick / enter · view"
        onDoubleClick={(ev) => {
          ev.stopPropagation()
          ev.preventDefault()
          onHeaderDblClick()
        }}
      >
        <Markdown source={displayText} streaming={streamActive} />
        {/* Agent-embedded images render below the text. */}
        {e.images?.length ? (
          <div className="mt-1.5">
            <InlineImages
              images={e.images}
              size="assistant"
              onOpen={() => openViewer(e.id)}
            />
          </div>
        ) : null}
        {/* TUI right-aligned message time; tool/thought blocks get none.
            Hidden on mobile (sm: = desktop), unlike user prompt times. */}
        <PromptTime ts={e.ts} className="top-[3.5px] hidden sm:inline" />
      </div>
    </EntryShell>
  )
}
