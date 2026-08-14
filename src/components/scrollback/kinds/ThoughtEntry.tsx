import type { ScrollEntry } from '../../../api/types'
import { thoughtDisplayMode } from '../../../scrollback/thoughtMode'
import { streamThoughtBody, truncatedThoughtLines } from '../../../scrollback/thoughtText'
import { Accents } from '../../../theme/accents'
import { Glyphs } from '../../../theme/glyphs'
import { Bullet, EntryShell } from '../EntryShell'
import type { EntryChrome } from '../chrome'

export function ThoughtEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'thought' }>
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
    toggleThought,
    thoughtText,
    bodyRef,
  } = chrome
  const mode = thoughtDisplayMode(e)
  // 流式思考展开正文（live 可见），收口后按 displayMode 折叠/展开——
  // 主 scrollback 与子代理弹窗共用同一行为。
  const showBody = e.streaming || mode !== 'collapsed'
  // Truncated (default after finish): header + head/tail preview, no
  // internal scroll (the tail must stay visible). Streaming/expanded:
  // full body in a capped scroll container.
  const truncated = mode === 'truncated' && !e.streaming
  return (
    <EntryShell {...shell}>
      <button
        type="button"
        onClick={(ev) => {
          ev.stopPropagation()
          if (e.streaming) {
            shell.onSelect()
            return
          }
          onHeaderClick(() => toggleThought(e.id))
        }}
        onDoubleClick={(ev) => {
          ev.stopPropagation()
          ev.preventDefault()
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
        {e.streaming ? (
          <span className="font-bold" style={{ color: Accents.thinkingDefault }}>
            Thinking{Glyphs.ellipsis}
          </span>
        ) : (
          <>
            <span className="font-bold text-gn-muted">Thought</span>
            {e.elapsed && (
              <span className="text-gn-muted"> for {e.elapsed}</span>
            )}
          </>
        )}
      </button>
      {showBody && (
        <div
          ref={bodyRef}
          className={
            truncated
              ? 'mt-1 border-l pl-3 text-[12.5px] leading-relaxed'
              : 'mt-1 min-h-[1.2em] max-h-[6.5em] overflow-hidden border-l pl-3 text-[12.5px] leading-relaxed'
          }
          style={{ borderColor: 'color-mix(in srgb, var(--color-gn-gray-dim) 40%, transparent)' }}
        >
          {thoughtText ? (
            <div className="italic text-gn-muted whitespace-pre-wrap break-words">
              {/* thoughtText = e.text + liveStream delta（additive merge）。 */}
              {e.streaming
                ? streamThoughtBody(thoughtText)
                : truncated
                  ? truncatedThoughtLines(thoughtText).join('\n')
                  : thoughtText}
              {e.streaming && (
                <span
                  className="ml-0.5 inline-block h-[0.9em] w-[0.4em] translate-y-[1px] animate-pulse align-text-bottom"
                  style={{ backgroundColor: Accents.thinkingDefault, opacity: 0.6 }}
                />
              )}
            </div>
          ) : e.streaming ? (
            <div className="text-[12px] text-gn-gutter italic">
              reasoning{Glyphs.ellipsis}
            </div>
          ) : null}
        </div>
      )}
    </EntryShell>
  )
}
