import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ScrollEntry } from '../../api/types'
import { enteringEntryIds } from '../../scrollback/entryEnter'

/** 与 index.css 的 gn-entry-enter 动画时长一致；动画结束后摘掉类，
 *  避免之后重新挂载（折叠组展开）时重播。 */
const ENTER_ANIMATION_MS = 240

const NONE: ReadonlySet<string> = new Set()

/**
 * 新 entry 块的入场动画状态：返回当前应带 `gn-entry-enter` 的 id 集合。
 * 判定逻辑见 scrollback/entryEnter.ts。
 */
export function useEnteringEntries(
  entries: ScrollEntry[],
  {
    enabled,
    historyLoadedAt,
    historyLoading,
    historyLoadingMore,
  }: {
    enabled: boolean
    historyLoadedAt?: number | null
    historyLoading: boolean
    historyLoadingMore: boolean
  },
): ReadonlySet<string> {
  const seenRef = useRef<Set<string>>(new Set())
  const initializedRef = useRef(false)
  const loadedAtRef = useRef<number | null | undefined>(historyLoadedAt)
  const [active, setActive] = useState<ReadonlySet<string>>(NONE)
  const timerRef = useRef<number | null>(null)

  // render 阶段先算，保证新条目第一次 commit（EntryShell 挂载）就带着动画类。
  const fresh = enteringEntryIds(entries, seenRef.current, {
    enabled,
    initialized: initializedRef.current,
    historyLoadedAt,
    lastHistoryLoadedAt: loadedAtRef.current,
    historyLoading,
    historyLoadingMore,
  })

  useLayoutEffect(() => {
    initializedRef.current = true
    loadedAtRef.current = historyLoadedAt
    const next = new Set(seenRef.current)
    for (const e of entries) next.add(e.id)
    seenRef.current = next

    if (fresh.length === 0) return
    setActive((prev) => {
      const merged = new Set(prev)
      for (const id of fresh) merged.add(id)
      return merged
    })
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setActive(NONE)
    }, ENTER_ANIMATION_MS)
  }, [entries, historyLoadedAt, fresh])

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
    },
    [],
  )

  if (fresh.length === 0) return active
  const entering = new Set(active)
  for (const id of fresh) entering.add(id)
  return entering
}
