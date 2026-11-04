import { useLayoutEffect, useRef } from 'react'
import type { ScrollEntry } from '../../../api/types'
import { useFePrefs } from '../../../store/historyPins'
import { cancelSmoothScroll, smoothScrollTop } from '../../../lib/smoothScroll'
import { thoughtDisplayMode } from '../../../scrollback/thoughtMode'
import { thoughtStreamWindow, truncatedThoughtLines } from '../../../scrollback/thoughtText'
import { Accents } from '../../../theme/accents'
import { Glyphs } from '../../../theme/glyphs'
import { SmoothStreamText } from '../../ui/SmoothStreamText'
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
  const smoothStream = useFePrefs((s) => s.fePrefs.streamTextSmooth)
  const thoughtLines = useFePrefs((s) => s.fePrefs.thoughtLines)
  const mode = thoughtDisplayMode(e)
  // 流式正文用滚动缓冲窗口，而不是每个 chunk 替换固定行数尾窗：
  // 窗口先增长，攒够一个 block 才裁一次，正文才有真实的 scrollHeight
  // 增长可供平滑追底。省略号单独静态渲染，避免干扰 commonOverlap。
  const streamWindow = e.streaming
    ? thoughtStreamWindow(thoughtText ?? '')
    : null
  const streamText = streamWindow?.text ?? thoughtText
  // 流式（未收口）也出「查看」——正文只渲染有界滚动窗口，全文在查看器里 live 滚动。
  const showView = e.streaming || mode !== 'collapsed'
  // 流式思考展开正文（live 可见），收口后按 displayMode 折叠/展开——
  // 主 scrollback 与子代理弹窗共用同一行为。
  const showBody = e.streaming || mode !== 'collapsed'
  // Truncated (default after finish): header + head/tail preview, no
  // internal scroll (the tail must stay visible). Streaming/expanded:
  // body in a capped scroll container; `leading-relaxed` = 1.625em per
  // line, so the configured line count maps directly to max-height.
  const truncated = mode === 'truncated' && !e.streaming
  const bodyMaxHeight = truncated ? undefined : `${thoughtLines * 1.625}em`
  const contentRef = useRef<HTMLDivElement>(null)
  const hasThoughtText = !!thoughtText
  // 正文在 SmoothStreamText 提交后仍可能继续撑高（它自己也有一个 layout
  // effect），所以监听正文节点本身，在每次实际高度变化后重新平滑钉底。
  // 第一帧直接落底，避免打开已有长思考时从顶部慢慢扫下来。
  useLayoutEffect(() => {
    if (!e.streaming || !hasThoughtText) return
    const body = bodyRef.current
    const content = contentRef.current
    if (!body || !content) return
    let first = true
    const pin = () => {
      const target = Math.max(0, body.scrollHeight - body.clientHeight)
      if (first) {
        first = false
        cancelSmoothScroll(body)
        body.scrollTop = target
      } else {
        smoothScrollTop(body, target, { isActive: () => true })
      }
      body.toggleAttribute('data-top-fade', target > 0)
    }
    pin()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(pin)
    ro.observe(content)
    return () => {
      ro.disconnect()
      cancelSmoothScroll(body)
    }
  }, [bodyRef, e.streaming, hasThoughtText, thoughtLines])
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
              : 'gn-thought-scroll mt-1 min-h-[1.2em] overflow-hidden border-l pl-3 text-[12.5px] leading-relaxed'
          }
          style={{
            borderColor: 'color-mix(in srgb, var(--color-gn-gray-dim) 40%, transparent)',
            maxHeight: bodyMaxHeight,
          }}
          onScroll={(ev) => {
            ev.currentTarget.toggleAttribute(
              'data-top-fade',
              ev.currentTarget.scrollTop > 0,
            )
          }}
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
            <div
              ref={contentRef}
              className="italic text-gn-muted whitespace-pre-wrap break-words"
            >
              {/* thoughtText = e.text + liveStream delta（additive merge）。
                  流式时按帧铺开，正文只渲染滚动缓冲窗口。 */}
              {e.streaming ? (
                <>
                  {streamWindow != null && streamWindow.start > 0 && (
                    <>
                      {Glyphs.ellipsis}
                      {'\n'}
                    </>
                  )}
                  <SmoothStreamText
                    text={streamText ?? ''}
                    enabled={smoothStream}
                  />
                </>
              ) : truncated ? (
                truncatedThoughtLines(thoughtText).join('\n')
              ) : (
                thoughtText
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
