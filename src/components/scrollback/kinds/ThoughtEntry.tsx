import { useLayoutEffect, useRef } from 'react'
import type { ScrollEntry } from '../../../api/types'
import { useFePrefs } from '../../../store/historyPins'
import { cancelSmoothScroll } from '../../../lib/smoothScroll'
import { easeThoughtValue, thoughtBodyTarget } from '../../../scrollback/thoughtMotion'
import { thoughtDisplayMode } from '../../../scrollback/thoughtMode'
import { thoughtStreamWindow, truncatedThoughtLines } from '../../../scrollback/thoughtText'
import { Accents } from '../../../theme/accents'
import { Glyphs } from '../../../theme/glyphs'
import { AnimatedCollapse } from '../../ui/AnimatedCollapse'
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
  // 流式正文用滚动缓冲窗口，而不是每个 chunk 替换固定行数尾窗：
  // 窗口先增长，攒够一个 block 才裁一次，正文才有真实的滚动高度增长
  // 可供平滑追尾。省略号单独静态渲染，避免干扰 commonOverlap。
  // 窗口上限随「思考活动区行数」缩放，避免默认 4 行时也把整段长文铺进 DOM。
  const streamWindow = e.streaming
    ? thoughtStreamWindow(thoughtText ?? '', thoughtLines)
    : null
  const streamText = streamWindow?.text ?? thoughtText
  const contentRef = useRef<HTMLDivElement>(null)
  const hasThoughtText = !!thoughtText

  // 流式开始时先冻结当前高度：空白块从 1 行起长；挂载时已有长思考则
  // 从实际高度起，后续交给下面的运动 effect 平滑扩展/滚动。
  useLayoutEffect(() => {
    if (!e.streaming) return
    const body = bodyRef.current
    if (!body) return
    if (body.style.height === '') {
      const h = body.clientHeight
      if (h > 0) body.style.height = `${h}px`
    }
    return () => {
      body.style.height = ''
      body.scrollTop = 0
      body.removeAttribute('data-top-fade')
    }
  }, [bodyRef, e.streaming])

  // 高度和正文位移用同一条 rAF 缓动：
  // - 1 行 → 设置行数：容器高度逐帧长高，而不是每来一行跳约 20px；
  // - 超过设置行数：高度封顶，translateY 逐帧追赶，最新一行从底部滑入。
  // 位移走 transform（合成器友好），不再给滚动容器加 mask（mask 会丢掉
  // 滚动快速路径）。
  useLayoutEffect(() => {
    if (!e.streaming || !hasThoughtText) return
    const body = bodyRef.current
    const content = contentRef.current
    if (!body || !content || typeof ResizeObserver === 'undefined') return
    const maxHeight = Number.parseFloat(getComputedStyle(body).maxHeight)
    if (!Number.isFinite(maxHeight) || maxHeight <= 0) return

    let contentHeight = content.offsetHeight
    if (contentHeight <= 0) return
    let target = thoughtBodyTarget(contentHeight, maxHeight)
    const styledHeight = Number.parseFloat(body.style.height)
    let height = Number.isFinite(styledHeight)
      ? styledHeight
      : Math.min(body.clientHeight || target.height, maxHeight)
    height = Math.max(0, Math.min(height, maxHeight))
    // 首帧直接对到内容尾部（新块的首包可能已经很长）；高度从 1 行向上
    // 长时只是把尾部附近的行逐行露出来，不会从正文开头慢慢扫下去。
    let top = target.scrollTop
    let faded = body.hasAttribute('data-top-fade')
    let frame: number | null = null

    const apply = () => {
      const nextHeight = `${height}px`
      if (body.style.height !== nextHeight) body.style.height = nextHeight
      const nextTransform =
        top > 0.5 ? `translateY(-${Math.round(top)}px)` : ''
      if (content.style.transform !== nextTransform) {
        content.style.transform = nextTransform
      }
      const nextFaded = top > 0.5
      if (nextFaded !== faded) {
        faded = nextFaded
        body.toggleAttribute('data-top-fade', nextFaded)
      }
    }
    apply()
    cancelSmoothScroll(body)

    const tick = () => {
      frame = null
      const gapH = target.height - height
      const gapT = target.scrollTop - top
      if (Math.abs(gapH) <= 0.5 && Math.abs(gapT) <= 0.5) {
        height = target.height
        top = target.scrollTop
        apply()
        return
      }
      // 行数设置调小 / 窗口裁短：高度直接收，避免底部露出空白。
      height =
        gapH < -0.5
          ? target.height
          : easeThoughtValue(height, target.height, 0.22, 28)
      top = easeThoughtValue(top, target.scrollTop, 0.45, 48)
      top = Math.min(top, Math.max(0, contentHeight - height))
      apply()
      frame = requestAnimationFrame(tick)
    }
    const schedule = () => {
      if (frame == null) frame = requestAnimationFrame(tick)
    }

    const ro = new ResizeObserver(() => {
      const next = content.offsetHeight
      if (next <= 0) return
      const removed = contentHeight - next
      if (removed > 0) {
        // 滚动窗口裁掉头部：同步扣掉同高，尾部可见内容保持不动。
        top = Math.max(0, top - removed)
      }
      contentHeight = next
      target = thoughtBodyTarget(contentHeight, maxHeight)
      if (target.height < height) height = target.height
      if (target.scrollTop < top) top = target.scrollTop
      apply()
      schedule()
    })
    ro.observe(content)
    return () => {
      ro.disconnect()
      if (frame != null) cancelAnimationFrame(frame)
      content.style.transform = ''
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
      <AnimatedCollapse open={showBody} animate={!e.streaming}>
        <div
          ref={bodyRef}
          className={
            truncated
              ? 'mt-1 border-l pl-3 text-[12.5px] leading-relaxed'
              : 'gn-thought-scroll relative mt-1 min-h-[1.2em] overflow-hidden border-l pl-3 text-[12.5px] leading-relaxed'
          }
          style={{
            borderColor: 'color-mix(in srgb, var(--color-gn-gray-dim) 40%, transparent)',
            maxHeight: bodyMaxHeight,
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
              className={`italic text-gn-muted whitespace-pre-wrap break-words${e.streaming ? ' will-change-transform' : ''}`}
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
          {!truncated && (
            // 顶边渐隐：静态叠层，避免 mask-image 挂在滚动容器上拖慢合成。
            <div
              aria-hidden
              className="gn-thought-fade pointer-events-none absolute inset-x-0 top-0 h-[1.4em]"
            />
          )}
        </div>
      </AnimatedCollapse>
    </EntryShell>
  )
}
