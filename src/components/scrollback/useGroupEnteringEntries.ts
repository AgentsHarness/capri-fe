import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ScrollEntry } from '../../api/types'
import {
  newlyExpandedEntryIds,
  visibleEntryIds,
  type GroupEnterSnapshot,
} from '../../scrollback/groupEnter'
import type { DisplayRow, GroupSpan } from '../../scrollback/verbGroup'
import { useFePrefs } from '../../store/historyPins'

/** 与 index.css 的 gn-entry-enter 动画时长一致；结束后摘掉类。 */
const GROUP_ENTER_MS = 240

const NONE: ReadonlySet<string> = new Set()

/**
 * 手动展开折叠分组时的成员入场动画：返回本帧应带 `gn-entry-enter`
 * 的条目 id 集合。判定见 scrollback/groupEnter.ts。
 *
 * 与 useEnteringEntries（实时新块）分开：这里只响应展开集新增的锚点，
 * 收起分组交给 useAbsorbingEntries 的退出快照。
 */
export function useGroupEnteringEntries(
  entries: ScrollEntry[],
  rows: DisplayRow[],
  spans: GroupSpan[],
  expandedGroups: ReadonlySet<string>,
): ReadonlySet<string> {
  const motion = useFePrefs((s) => s.fePrefs.uiMotion) !== false
  const visible = useMemo(() => visibleEntryIds(rows), [rows])
  const prevRef = useRef<GroupEnterSnapshot | null>(null)
  const [active, setActive] = useState<ReadonlySet<string>>(NONE)
  const timerRef = useRef<number | null>(null)

  // render 阶段先算：展开的那一帧成员第一次 commit 就带着动画类。
  const fresh = useMemo(
    () =>
      motion
        ? newlyExpandedEntryIds(
            entries,
            spans,
            prevRef.current,
            expandedGroups,
            visible,
          )
        : [],
    [motion, entries, spans, expandedGroups, visible],
  )

  useLayoutEffect(() => {
    prevRef.current = { expanded: expandedGroups, visible }
  })

  useLayoutEffect(() => {
    if (fresh.length === 0) return
    setActive((prev) => {
      const next = new Set(prev)
      for (const id of fresh) next.add(id)
      return next
    })
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setActive(NONE)
    }, GROUP_ENTER_MS)
  }, [fresh])

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
    },
    [],
  )

  // 收起分组 / 条目被移除后，动画类只应该留在还可见的行上。
  const visibleActive = useMemo(() => {
    if (active.size === 0) return active
    let changed = false
    const out = new Set<string>()
    for (const id of active) {
      if (visible.has(id)) out.add(id)
      else changed = true
    }
    return changed ? out : active
  }, [active, visible])

  if (!motion) return NONE
  if (fresh.length === 0) return visibleActive
  const entering = new Set(visibleActive)
  for (const id of fresh) entering.add(id)
  return entering
}
