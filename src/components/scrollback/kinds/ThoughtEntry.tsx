import type { ScrollEntry } from '../../../api/types'
import { thoughtDisplayMode } from '../../../scrollback/thoughtMode'
import { streamThoughtBody, truncatedThoughtLines } from '../../../scrollback/thoughtText'
import { Accents } from '../../../theme/accents'
import { Glyphs } from '../../../theme/glyphs'
import { Bullet, EntryShell } from '../EntryShell'
import { HeaderWithView } from '../ViewButton'
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
    toggleThought,
    thoughtText,
    bodyRef,
    openViewer,
  } = chrome
  const mode = thoughtDisplayMode(e)
  // 流式（未收口）也出「查看」——正文只渲染有界尾部，全文在查看器里 live 滚动。
  const showView = e.streaming || mode !== 'collapsed'
  // 流式思考展开正文（live 可见），收口后按 displayMode 折叠/展开——
  // 主 scrollback 与子代理弹窗共用同一行为。
  const showBody = e.streaming || mode !== 'collapsed'
  // Truncated (default after finish): header + head/tail preview, no
  // internal scroll (the tail must stay visible). Streaming/expanded:
  // full body in a capped scroll container.
  const truncated = mode === 'truncated' && !e.streaming
  return (
    <EntryShell {...shell}>
      <HeaderWithView
        className={rowBtn}
        title="click fold · 查看 / enter view"
        onFold={() => {
          if (e.streaming) {
            shell.onSelect()
            return
          }
          toggleThought(e.id)
        }}
        viewVisible={showView}
        onOpen={() => openViewer(e.id)}
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
      </HeaderWithView>
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
          {e.liteOmitted && e.liteState !== 'filled' && !e.streaming ? (
            <div className="text-[12px] text-gn-gutter italic">
              {e.liteState === 'loading'
                ? `思考加载中${Glyphs.ellipsis}`
                : e.liteState === 'error'
                  ? '思考加载失败，点击重试'
                  : '思考已省略'}
            </div>
          ) : thoughtText ? (
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
