import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ScrollEntry } from '../../api/types'
import { streamClockNow } from '../../scrollback/streamTextFade'
import { isDensePackable } from '../../scrollback/verbGroup'
import { AnimatedCollapse } from '../ui/AnimatedCollapse'
import { EntryView } from './EntryView'
import type { AbsorbingEntry } from './useAbsorbingEntries'

/**
 * 正文折回标题行的时长：与 ToolEntry / ThoughtEntry 内部 AnimatedCollapse
 * 的 0.2s 高度过渡对齐，留一点余量后再开始整行淡出。
 */
const FOLD_MS = 220

/**
 * 块被收进聚合组的退出快照：按入组前的状态渲染，工具先把正文折回
 * 标题行（内部 AnimatedCollapse 收起），再把这一行淡出。放在旧位置，
 * 避免整块内容在一帧内消失。
 *
 * 刚结束流式的思考会先等正文淡入完全落定（onStreamSettledAt）再折；
 * 工具与已收口的思考（单行表头）下一帧直接开始。
 *
 * 不可交互：它只是短命的视觉残影（pointer-events / aria-hidden）。
 */
export function AbsorbingEntryRow({
  ghost,
  pendingFreeze,
  now,
}: {
  ghost: AbsorbingEntry
  pendingFreeze: boolean
  now: number
}) {
  const [folded, setFolded] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const timerRef = useRef<number | null>(null)
  const frameRef = useRef<number | null>(null)

  const cancelPending = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (frameRef.current != null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [])

  const startFold = useCallback(() => {
    cancelPending()
    setFolded(true)
    if (!ghost.patch) {
      // 本来就是折叠行（用户钉过）：不用等正文收起，下一帧直接淡出。
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        setLeaving(true)
      })
      return
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setLeaving(true)
    }, FOLD_MS)
  }, [cancelPending, ghost.patch])

  const handleSettledAt = useCallback(
    (at: number) => {
      cancelPending()
      const wait = at - streamClockNow()
      if (wait > 8) {
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null
          startFold()
        }, wait + 16)
      } else {
        startFold()
      }
    },
    [cancelPending, startFold],
  )

  useEffect(() => {
    if (ghost.waitForFade) return
    startFold()
    return cancelPending
  }, [ghost.waitForFade, startFold, cancelPending])

  useEffect(() => cancelPending, [cancelPending])

  const rendered = useMemo<ScrollEntry>(() => {
    if (folded || !ghost.patch) return ghost.entry
    return { ...ghost.entry, ...ghost.patch } as ScrollEntry
  }, [folded, ghost])

  return (
    <div aria-hidden inert className="pointer-events-none select-none">
      <AnimatedCollapse
        open={!leaving}
        // 折正文阶段外层高度跟着内部收起走，不加自己的过渡；淡出阶段才
        // 由 .gn-absorb 接管高度/透明度。
        animate={leaving}
        className="gn-absorb"
      >
        <EntryView
          e={rendered}
          selected={false}
          pendingFreeze={pendingFreeze}
          now={now}
          // 与退出前的展开预览一致：工具/思考按展开态的行距，用户钉住
          // 的折叠行保持 dense。折起后随之回到 collapsed 行距。
          dense={isDensePackable(rendered)}
          revealStreamInitial={false}
          onStreamSettledAt={ghost.waitForFade ? handleSettledAt : undefined}
        />
      </AnimatedCollapse>
    </div>
  )
}
