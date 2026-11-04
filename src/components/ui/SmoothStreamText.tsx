import { Fragment, useLayoutEffect, useState } from 'react'
import {
  advanceStreamTextView,
  EMPTY_STREAM_TEXT_VIEW,
  type StreamTextView,
} from '../../scrollback/streamTextFade'

let partSeq = 0
const nextPartId = () => ++partSeq

/** 不带动画、直接整体可见的初始视图（弹窗打开已有内容时用）。 */
function stableView(text: string): StreamTextView {
  return {
    source: text,
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
  }
}

/**
 * 流式正文半透明淡入：每次文本更新只让新增部分从半透明渐显，旧文本
 * 保持不透明。思考块的首包很大也适用——首包会按行切成小段错峰淡入。
 *
 * 不延迟文本本身（目标文本立即显示），因此不会落后于网络流；纯呈现层
 * 的动画只作用在新片段的 opacity 上。
 */
export function SmoothStreamText({
  text,
  enabled,
  className,
  revealInitial = true,
}: {
  text: string
  enabled: boolean
  className?: string
  /** 首次挂载的已有文本是否也淡入；弹窗打开时通常只让后续新增文字淡入。 */
  revealInitial?: boolean
}) {
  const [view, setView] = useState<StreamTextView>(() => {
    if (!enabled) return { source: text, parts: [] }
    return revealInitial
      ? advanceStreamTextView(EMPTY_STREAM_TEXT_VIEW, text, Date.now(), nextPartId)
      : stableView(text)
  })

  useLayoutEffect(() => {
    if (!enabled) return
    setView((prev) => {
      if (prev.source === text) {
        if (prev.parts.length > 0 || text === '') return prev
        return revealInitial
          ? advanceStreamTextView(EMPTY_STREAM_TEXT_VIEW, text, Date.now(), nextPartId)
          : stableView(text)
      }
      return advanceStreamTextView(prev, text, Date.now(), nextPartId)
    })
  }, [text, enabled, revealInitial])

  if (!enabled) return <span className={className}>{text}</span>

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
