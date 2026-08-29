import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useChatStore } from '../../store/chat'
import { usePromptQueue } from '../../store/promptQueue'

/**
 * Composer 内联队列的导航状态机（TUI queue.rs）：行选择（↑↓/j/k/悬停）、
 * 焦点（空输入 ↑ 进入；点行/抓手进入）、抓手拖拽排序、捕获期键盘操作
 * （x 删除 / e·Enter 编辑 / Shift+K·J·Ctrl+↑↓ 换位）。队列状态本身
 * （queue / editIndex）仍在 promptQueue store，这里只管"选中哪行"。
 *
 * strip 的 JSX 由 Composer 渲染（queueRow），键盘路由（textarea onKeyDown）
 * 消费本 hook 返回的选择器与 setter。
 */
export function useQueueNav() {
  const queue = usePromptQueue((s) => s.queue)
  // queuePanelOpen = composer 内联队列是否展开（不再是弹窗）。顶部 +N
  // 徽标与标题行共用这个开关。
  const queuePanelOpen = useChatStore((s) => s.queuePanelOpen)
  const setQueuePanelOpen = useChatStore((s) => s.setQueuePanelOpen)
  const queueEditIndex = usePromptQueue((s) => s.editIndex)
  const queueEditDraft = usePromptQueue((s) => s.editDraft)
  // Selected queue row (↑↓/j/k)；queueFocus 时快捷键归队列，否则滚动区
  // 照常吃 j/k（内联条常驻展开时不能把滚动键抢走）。
  const [queueSel, setQueueSel] = useState(0)
  const [queueFocus, setQueueFocus] = useState(false)
  // 左侧抓手拖拽：from = 抓起行，over = 当前落点（都是当前 queue 下标）。
  const [queueDrag, setQueueDrag] = useState<{ from: number; over: number } | null>(null)
  const queueDragRef = useRef<{ from: number; over: number } | null>(null)
  const queuePanelRef = useRef<HTMLDivElement>(null)
  const queueLenRef = useRef(0)

  // Keep the queue selection inside the current list (rows drain / get
  // deleted). New items auto-expand the strip so the message itself is
  // visible in composer — not just "N queued".
  useEffect(() => {
    if (queue.length > queueLenRef.current) setQueuePanelOpen(true)
    queueLenRef.current = queue.length
    if (queue.length === 0) setQueueFocus(false)
    setQueueSel((s) => Math.min(s, Math.max(0, queue.length - 1)))
  }, [queue.length, setQueuePanelOpen])

  // ── Inline queue keyboard ops (TUI queue.rs): x delete, e/Enter edit,
  // ↑↓/j/k move the selection, Shift+K/↑ or Ctrl+↑ swap up, Shift+J/↓ or
  // Ctrl+↓ swap down. Only while the strip is focused (empty-prompt ↑
  // or a row click) — typing in the composer and scrollback j/k win
  // otherwise. Capture phase so the scrollback nav keys never see these.
  useEffect(() => {
    if (!queueFocus || queueEditIndex != null || queue.length === 0) return
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      const t = e.target as HTMLElement | null
      if (
        !!t &&
        (t.tagName === 'TEXTAREA' ||
          t.tagName === 'INPUT' ||
          t.isContentEditable)
      ) {
        return // typing / editing — don't steal keys
      }
      if (e.metaKey || e.altKey) return
      const q = usePromptQueue.getState()
      const n = q.queue.length
      if (n === 0) return
      const sel = Math.min(queueSel, n - 1)
      let handled = true
      if (e.key === 'ArrowDown' || e.key === 'j') {
        setQueueSel(Math.min(n - 1, sel + 1))
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        setQueueSel(Math.max(0, sel - 1))
      } else if (e.key === 'x' || e.key === 'Delete' || e.key === 'Backspace') {
        q.removeAt(q.queue[sel].id)
      } else if (e.key === 'e' || e.key === 'Enter') {
        q.startEdit(sel)
      } else if (
        (e.shiftKey && (e.key === 'J' || e.key === 'ArrowDown')) ||
        (e.ctrlKey && e.key === 'ArrowDown')
      ) {
        // TUI SwapDown binding: Shift+J (queue.rs); Ctrl+↓ also works.
        q.moveDown(sel)
        setQueueSel(Math.min(n - 1, sel + 1))
      } else if (
        (e.shiftKey && (e.key === 'K' || e.key === 'ArrowUp')) ||
        (e.ctrlKey && e.key === 'ArrowUp')
      ) {
        // TUI SwapUp binding: Shift+K (queue.rs); Ctrl+↑ also works.
        q.moveUp(sel)
        setQueueSel(Math.max(0, sel - 1))
      } else {
        handled = false
      }
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [queueFocus, queueEditIndex, queueSel, queue.length])

  const setQueueDragBoth = (
    v: { from: number; over: number } | null,
  ) => {
    queueDragRef.current = v
    setQueueDrag(v)
  }
  const onQueueGripPointerDown = (
    i: number,
    e: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (queueEditIndex != null) return
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setQueueDragBoth({ from: i, over: i })
    setQueueSel(i)
    setQueueFocus(true)
  }
  const onQueueGripPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = queueDragRef.current
    if (!drag) return
    const list = queuePanelRef.current
    if (!list) return
    let best = drag.from
    let bestDist = Infinity
    list.querySelectorAll<HTMLElement>('[data-queue-idx]').forEach((el) => {
      const r = el.getBoundingClientRect()
      const idx = Number(el.dataset.queueIdx)
      if (!Number.isFinite(idx)) return
      const d = Math.abs(e.clientY - (r.top + r.height / 2))
      if (d < bestDist) {
        bestDist = d
        best = idx
      }
    })
    if (best !== drag.over) setQueueDragBoth({ from: drag.from, over: best })
  }
  const onQueueGripPointerUp = () => {
    const drag = queueDragRef.current
    if (!drag) return
    if (drag.from !== drag.over) {
      usePromptQueue.getState().moveTo(drag.from, drag.over)
      setQueueSel(drag.over)
    }
    setQueueDragBoth(null)
  }

  return {
    queue,
    queuePanelOpen,
    setQueuePanelOpen,
    queueEditIndex,
    queueEditDraft,
    queueSel,
    setQueueSel,
    queueFocus,
    setQueueFocus,
    queueDrag,
    queuePanelRef,
    onQueueGripPointerDown,
    onQueueGripPointerMove,
    onQueueGripPointerUp,
  }
}
