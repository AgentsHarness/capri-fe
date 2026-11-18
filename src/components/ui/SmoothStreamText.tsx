import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  advanceStreamTextView,
  EMPTY_STREAM_TEXT_VIEW,
  releaseStreamTextView,
  streamClockNow,
  streamViewSettledAt,
  type StreamTextView,
} from '../../scrollback/streamTextFade'
import {
  clearStreamFade,
  peekStreamFade,
  rememberStreamFade,
} from '../../scrollback/streamFadeCache'

let partSeq = 0
const nextPartId = () => ++partSeq

/** 不带动画、直接整体可见的视图（关闭平滑 / 弹窗打开已有内容时用）。 */
function stableView(text: string): StreamTextView {
  return {
    source: text,
    pending: [],
    parts:
      text === ''
        ? []
        : [
            {
              id: nextPartId(),
              text,
              fading: false,
              expiresAt: 0,
              delayMs: 0,
              durationMs: 0,
            },
          ],
    deadline: 0,
  }
}

/** prefers-reduced-motion：动画被 CSS 禁用时不要再用缓冲区拖慢正文。 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = () => setReduced(query.matches)
    apply()
    query.addEventListener?.('change', apply)
    return () => query.removeEventListener?.('change', apply)
  }, [])
  return reduced
}

/**
 * 流式正文半透明淡入。
 *
 * 新到文本先进入短缓冲（scrollback/streamTextFade 的 pending 队列），
 * 每帧只释放少量字素：慢 token 逐字淡入，成段文本拆成连续的小片段，
 * 首包再大也不会整块闪出。高吞吐时淡入时长按释放量自动缩短，半透明
 * 尾巴控制在两三行以内。显示最多落后目标文本一个很短的窗口，
 * 队列排空后动画片段自动并回稳定文本。
 */
export function SmoothStreamText({
  text,
  enabled,
  className,
  revealInitial = true,
  fadeKey,
  onSettledAt,
}: {
  text: string
  enabled: boolean
  className?: string
  /** 首次挂载的已有文本是否也淡入；弹窗打开时通常只让后续新增文字淡入。 */
  revealInitial?: boolean
  /**
   * 退出快照接手淡入进度的 key（思考收口时用 entry id）。给了就在挂载时
   * 读取淡入缓存，并把后续视图写回；不给则行为不变。
   */
  fadeKey?: string
  /**
   * 当前视图完全落定的时刻（streamClockNow 时钟）；没有动画时为 0。
   * 退出快照据此把「收高度」排在最后一段淡入结束之后。
   */
  onSettledAt?: (at: number) => void
}) {
  const reducedMotion = usePrefersReducedMotion()
  const animate = enabled && !reducedMotion
  const [view, setView] = useState<StreamTextView>(() => {
    if (!animate) return stableView(text)
    if (fadeKey) {
      const cached = peekStreamFade(fadeKey, streamClockNow())
      if (cached) {
        // 从直播行留下的 pending / fading 片段继续，不整块重播淡入。
        return advanceStreamTextView(cached, text, streamClockNow(), nextPartId)
      }
    }
    return revealInitial
      ? advanceStreamTextView(
          EMPTY_STREAM_TEXT_VIEW,
          text,
          streamClockNow(),
          nextPartId,
        )
      : stableView(text)
  })
  const textRef = useRef(text)

  // 关闭平滑时同步一份稳定视图，之后重新打开平滑仍能接着增量。
  // 动画期间的「吸收 + 释放」合并到同一个 rAF 提交里，避免每次文本
  // 更新都先走一次 layout effect 再走一次 rAF（每帧多出一次 React 提交）。
  useLayoutEffect(() => {
    textRef.current = text
    if (animate) return
    setView((prev) => {
      const settled =
        prev.source === text &&
        prev.pending.length === 0 &&
        !prev.parts.some((part) => part.fading)
      return settled ? prev : stableView(text)
    })
  }, [text, animate])

  // 一个 rAF 同时负责吸收最新文本和释放一批；pending 未排空时 effect
  // 随 view 变化继续排下一帧，排空后自然停下。
  useEffect(() => {
    if (!animate) return
    if (view.source === text && view.pending.length === 0) return
    const frame = requestAnimationFrame(() => {
      const target = textRef.current
      setView((prev) =>
        target !== prev.source
          ? advanceStreamTextView(prev, target, streamClockNow(), nextPartId)
          : releaseStreamTextView(prev, streamClockNow(), nextPartId),
      )
    })
    return () => cancelAnimationFrame(frame)
  }, [animate, text, view])

  // 挂载时先清掉旧归属，再把本实例的视图持续写回：直播行卸载后，
  // 退出快照按同一 key 接手剩下的淡入。
  useLayoutEffect(() => {
    if (!fadeKey) return
    clearStreamFade(fadeKey)
  }, [fadeKey])

  useEffect(() => {
    if (!fadeKey || !animate) return
    rememberStreamFade(fadeKey, view)
  }, [fadeKey, animate, view])

  const settledAt = streamViewSettledAt(view, streamClockNow())
  useEffect(() => {
    onSettledAt?.(settledAt)
  }, [onSettledAt, settledAt])

  if (!animate) return <span className={className}>{text}</span>

  return (
    <span className={className}>
      {view.parts.map((part) =>
        part.fading ? (
          <span
            key={part.id}
            className="gn-stream-fade"
            style={{
              animationDelay: `${part.delayMs}ms`,
              animationDuration: `${part.durationMs}ms`,
            }}
          >
            {part.text}
          </span>
        ) : (
          <Fragment key={part.id}>{part.text}</Fragment>
        ),
      )}
    </span>
  )
}
