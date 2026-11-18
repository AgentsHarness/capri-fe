import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ScrollEntry } from '../../api/types'
import { useFePrefs } from '../../store/historyPins'
import {
  absorbPlacements,
  buildAbsorbSnapshot,
  type AbsorbPlacement,
  type AbsorbSnapshot,
  type AbsorbingEntry,
} from '../../scrollback/absorbEntries'
import type { DisplayRow, GroupSpan } from '../../scrollback/verbGroup'

export type { AbsorbingEntry } from '../../scrollback/absorbEntries'

/**
 * 退出快照的兜底寿命：流式思考先等淡入落定（最多 ~0.6s），再播 0.3s
 * 的收高度/平移。到点后即使过渡回调没来也会从行列表摘掉，避免状态堆积。
 */
const ABSORB_GHOST_MAX_MS = 1800

function ghostFor(
  entry: ScrollEntry,
  p: AbsorbPlacement,
  wasPreviewed: boolean,
  noPreviewIds?: ReadonlySet<string>,
): AbsorbingEntry | null {
  let patch: Partial<ScrollEntry> | undefined
  let waitForFade = false
  if (entry.kind === 'thought') {
    if (p.wasStreaming) {
      // 流式思考的行在收口前本来就是展开正文，与密度无关。
      patch = { streaming: true }
      waitForFade = true
    }
    // 已收口的思考保持 store 的单行表头；不再为入组预览把正文铺开。
  } else if (entry.kind === 'tool') {
    // 只有上一帧真的处于新块预览时才保留正文；从未预览过的折叠行按
    // 原样收，避免收组时闪一下没看过的内容。
    if (
      wasPreviewed &&
      !p.foldPinned &&
      !entry.foldPinned &&
      !noPreviewIds?.has(entry.id)
    ) {
      patch = { displayMode: 'truncated', expanded: true }
    }
  } else {
    return null
  }
  return {
    entry,
    afterKey: p.afterKey,
    patch,
    waitForFade,
  }
}

/**
 * 块被折叠分组收走时的退出动画状态（自动入组 + 用户手动收起分组）。
 *
 * 判定见 scrollback/absorbEntries.ts。返回的每条都要在旧位置补渲染
 * 一行收起前的快照，等淡入（若有）落定后再收高度/平移淡出；这里只做
 * 兜底清理（ABSORB_GHOST_MAX_MS）。
 * 关闭「展开/弹窗动画」或条目重新可见时立即不播 / 摘掉。
 */
export function useAbsorbingEntries(
  entries: ScrollEntry[],
  rows: DisplayRow[],
  spans: GroupSpan[],
  epoch: string,
  /** 当前帧处于新块预览的工具 id；退出行按上一帧的预览态决定是否展开。 */
  previewIds: ReadonlySet<string> = new Set(),
  /** 调用方已手动折叠的行（迷你视图局部 folds）：退出快照不再套预览。 */
  noPreviewIds?: ReadonlySet<string>,
): AbsorbingEntry[] {
  const motion = useFePrefs((s) => s.fePrefs.uiMotion) !== false
  const [ghosts, setGhosts] = useState<AbsorbingEntry[]>([])
  const prevRef = useRef<AbsorbSnapshot | null>(null)
  const timersRef = useRef<Map<string, number>>(new Map())

  useLayoutEffect(() => {
    const next = buildAbsorbSnapshot(entries, rows, epoch, previewIds)
    const prev = prevRef.current
    prevRef.current = next

    const byId = new Map<string, ScrollEntry>()
    for (const e of entries) byId.set(e.id, e)

    const epochChanged = prev != null && prev.epoch !== next.epoch
    const fresh: AbsorbingEntry[] = []
    if (prev && motion && !epochChanged) {
      for (const p of absorbPlacements(prev, next, spans)) {
        const e = byId.get(p.id)
        if (!e) continue
        const ghost = ghostFor(
          e,
          p,
          prev.previewIds.has(p.id),
          noPreviewIds,
        )
        if (ghost) fresh.push(ghost)
      }
    }

    setGhosts((current) => {
      let changed = false
      const keep: AbsorbingEntry[] = []
      for (const g of current) {
        const id = g.entry.id
        if (epochChanged || next.visibleIds.has(id) || !byId.has(id)) {
          changed = true
          continue
        }
        keep.push(g)
      }
      const ids = new Set(keep.map((g) => g.entry.id))
      for (const g of fresh) {
        if (ids.has(g.entry.id)) continue
        ids.add(g.entry.id)
        keep.push(g)
        changed = true
      }
      return changed ? keep : current
    })

    const timers = timersRef.current
    for (const g of fresh) {
      const id = g.entry.id
      const old = timers.get(id)
      if (old != null) window.clearTimeout(old)
      timers.set(
        id,
        window.setTimeout(() => {
          timers.delete(id)
          setGhosts((cur) => cur.filter((x) => x.entry.id !== id))
        }, ABSORB_GHOST_MAX_MS),
      )
    }
  }, [
    entries,
    rows,
    spans,
    epoch,
    motion,
    previewIds,
    noPreviewIds,
  ])

  useEffect(
    () => () => {
      for (const t of timersRef.current.values()) window.clearTimeout(t)
      timersRef.current.clear()
    },
    [],
  )

  return ghosts
}
