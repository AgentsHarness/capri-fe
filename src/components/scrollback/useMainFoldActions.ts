import { useMemo, useRef } from 'react'
import type { ScrollEntry } from '../../api/types'
import { useChatStore } from '../../store/chat'
import type { EntryViewActions } from './chrome'

/**
 * 主 scrollback 的单击折叠覆盖。
 *
 * 新块预览中的块只看 store 是 collapsed；若直接走三态 toggle，第一次
 * 点击会把它「展开」而不是收起。这里用渲染补丁的 id 集合判断用户看到的
 * 是展开态，命中就一次手势钉成 collapsed；其余条目照旧走 store。
 *
 * 补丁集合放 ref：actions 引用保持稳定，EntryView 的 memo 不会每帧失效。
 */
export function useMainFoldActions(
  previewPatches: ReadonlyMap<string, Partial<ScrollEntry>>,
): EntryViewActions {
  const pinCollapsed = useChatStore((s) => s.pinCollapsed)
  const toggleTool = useChatStore((s) => s.toggleTool)
  const toggleThought = useChatStore((s) => s.toggleThought)
  const patchesRef = useRef(previewPatches)
  patchesRef.current = previewPatches

  return useMemo<EntryViewActions>(
    () => ({
      toggleTool: (id) => {
        if (patchesRef.current.has(id)) pinCollapsed(id)
        else toggleTool(id)
      },
      toggleThought: (id) => {
        if (patchesRef.current.has(id)) pinCollapsed(id)
        else toggleThought(id)
      },
    }),
    [pinCollapsed, toggleTool, toggleThought],
  )
}
