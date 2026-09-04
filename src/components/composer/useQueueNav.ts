import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useChatStore } from '../../store/chat'
import { usePromptQueue } from '../../store/promptQueue'

export type QueueDragState = {
  from: number
  to: number
  slot: number
  over: number
}

/** 拖拽阈值（px）：超过才算拖动，未超过视作点击（不误杀轻点）。 */
const DRAG_THRESHOLD_PX = 4

/**
 * 拖拽中行的常驻视觉态（指示线渲染归 QueueStrip）：opacity 半透明 +
 * cursor-grabbing；body 级 user-select/touch-action 禁用归这里。
 */
function applyDragChrome(on: boolean): void {
  const b = document.body
  b.classList.toggle('gn-queue-dragging', on)
}

function computeSlotAndTo(
  list: HTMLElement,
  fromIdx: number,
  clientY: number,
): { slot: number; to: number } {
  const rowElements = Array.from(
    list.querySelectorAll<HTMLElement>('[data-queue-idx]'),
  ).sort((a, b) => Number(a.dataset.queueIdx) - Number(b.dataset.queueIdx))
  const n = rowElements.length
  if (n === 0) return { slot: fromIdx, to: fromIdx }

  const firstRect = rowElements[0].getBoundingClientRect()
  const lastRect = rowElements[n - 1].getBoundingClientRect()
  const firstMid = firstRect.top + firstRect.height / 2
  const lastMid = lastRect.top + lastRect.height / 2

  let slot = fromIdx
  if (clientY <= firstMid) {
    slot = 0
  } else if (clientY >= lastMid) {
    slot = n
  } else {
    let bestDist = Infinity
    let bestRow = fromIdx
    let isBelow = false
    for (let idx = 0; idx < n; idx++) {
      const r = rowElements[idx].getBoundingClientRect()
      const mid = r.top + r.height / 2
      const dist = Math.abs(clientY - mid)
      if (dist < bestDist) {
        bestDist = dist
        bestRow = idx
        isBelow = clientY >= mid
      }
    }
    slot = isBelow ? bestRow + 1 : bestRow
  }

  const to = slot > fromIdx ? slot - 1 : slot
  return { slot, to }
}

/**
 * Composer 内联队列的导航状态机（TUI queue.rs）：行选择（↑↓/j/k/悬停）、
 * 焦点（空输入 ↑ 进入；点行/抓手进入）、整行拖拽排序（除按钮外行上
 * 任意处可抓，触控端抓手专享防误触，阈值以下视作点击）、捕获期键盘操作
 * （x 删除 / e·Enter 编辑 / Shift+K·J·Ctrl+↑↓ 换位）。队列状态本身
 * （queue / editIndex）仍在 promptQueue store，这里只管"选中哪行"。
 *
 * 编辑入口（点「编辑」或 e / Enter）只置 store 的 editIndex，正文在
 * QueueEditModal 弹窗里改。
 */
export function useQueueNav() {
  const queue = usePromptQueue((s) => s.queue)
  // queuePanelOpen = composer 内联队列是否展开（不再是弹窗）。顶部 +N
  // 徽标与标题行共用这个开关。
  const queuePanelOpen = useChatStore((s) => s.queuePanelOpen)
  const setQueuePanelOpen = useChatStore((s) => s.setQueuePanelOpen)
  const queueEditIndex = usePromptQueue((s) => s.editIndex)
  // Selected queue row (↑↓/j/k)；queueFocus 时快捷键归队列，否则滚动区
  // 照常吃 j/k（内联条常驻展开时不能把滚动键抢走）。
  const [queueSel, setQueueSel] = useState(0)
  const [queueFocus, setQueueFocus] = useState(false)
  // 整行拖拽：from = 抓起行，to = 数组目标下标，slot = 视觉落点槽位 (0..n)，
  // over = 兼容旧命名。
  const [queueDrag, setQueueDrag] = useState<QueueDragState | null>(null)
  const queueDragRef = useRef<QueueDragState | null>(null)
  // 按住状态：记录起始坐标与触控标识
  const dragArmRef = useRef<{
    idx: number
    x: number
    y: number
    fromGrip: boolean
    pointerId: number
  } | null>(null)
  // 移动端长按拖拽定时器
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
    v: QueueDragState | null,
  ) => {
    queueDragRef.current = v
    setQueueDrag(v)
    applyDragChrome(v != null)
  }

  // 整行抓起：桌面端鼠标整行可抓；移动端支持抓手滑动拖拽与整行长按（~250ms）触发拖拽，
  // 正常触控快速滑动仍走原生列表滚动，互不干扰。
  const onQueueGripPointerDown = (
    i: number,
    e: ReactPointerEvent<HTMLElement>,
  ) => {
    if (queueEditIndex != null) return
    if (e.button !== 0) return

    const isTouch = e.pointerType === 'touch'
    const fromGrip = Boolean((e.target as HTMLElement).closest('[data-queue-grip]'))

    dragArmRef.current = {
      idx: i,
      x: e.clientX,
      y: e.clientY,
      fromGrip,
      pointerId: e.pointerId,
    }
    setQueueSel(i)
    setQueueFocus(true)

    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }

    if (isTouch) {
      if (fromGrip) {
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {}
      }
      // 移动端长按 250ms 触发拖拽
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null
        const arm = dragArmRef.current
        if (!arm || arm.idx !== i) return
        try {
          navigator.vibrate?.(15)
        } catch {}
        setQueueDragBoth({
          from: i,
          to: i,
          slot: i,
          over: i,
        })
      }, 250)
    } else {
      // 桌面端鼠标：捕获指针后移动超过阈值触发拖拽
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {}
    }
  }

  const onQueueGripPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const arm = dragArmRef.current
    if (arm) {
      const dx = Math.abs(e.clientX - arm.x)
      const dy = Math.abs(e.clientY - arm.y)

      // 移动端长按等待期间：
      if (longPressTimerRef.current) {
        // 若在抓手外部滑动超过 8px，表明用户意图是滚动列表，取消长按拖拽
        if (!arm.fromGrip && (dx > 8 || dy > 8)) {
          clearTimeout(longPressTimerRef.current)
          longPressTimerRef.current = null
          dragArmRef.current = null
          return
        }
        // 若在抓手上滑动超过阈值，直接激活拖拽
        if (arm.fromGrip && (dx >= DRAG_THRESHOLD_PX || dy >= DRAG_THRESHOLD_PX)) {
          clearTimeout(longPressTimerRef.current)
          longPressTimerRef.current = null
          setQueueDragBoth({
            from: arm.idx,
            to: arm.idx,
            slot: arm.idx,
            over: arm.idx,
          })
        }
      } else if (!queueDragRef.current) {
        // 鼠标端：滑动超过阈值激活拖拽
        if (dx >= DRAG_THRESHOLD_PX || dy >= DRAG_THRESHOLD_PX) {
          dragArmRef.current = null
          setQueueDragBoth({
            from: arm.idx,
            to: arm.idx,
            slot: arm.idx,
            over: arm.idx,
          })
        }
      }
    }

    const currentDrag = queueDragRef.current
    if (!currentDrag) return

    if (e.cancelable) e.preventDefault()
    handleDragMove(e.clientY)
  }

  const handleDragMove = (clientY: number) => {
    const currentDrag = queueDragRef.current
    if (!currentDrag) return
    const list = queuePanelRef.current
    if (!list) return

    // 拖动靠近滚动容器上下边缘时自动平滑滚动
    const scrollContainer = list.querySelector('.overflow-y-auto') as HTMLElement | null
    if (scrollContainer) {
      const containerRect = scrollContainer.getBoundingClientRect()
      const EDGE_PAD = 24
      if (clientY < containerRect.top + EDGE_PAD) {
        scrollContainer.scrollTop -= 6
      } else if (clientY > containerRect.bottom - EDGE_PAD) {
        scrollContainer.scrollTop += 6
      }
    }

    const { slot, to } = computeSlotAndTo(list, currentDrag.from, clientY)
    if (currentDrag.slot !== slot || currentDrag.to !== to) {
      setQueueDragBoth({ from: currentDrag.from, to, slot, over: to })
    }
  }

  const onQueueGripPointerUp = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    dragArmRef.current = null
    const drag = queueDragRef.current
    if (!drag) return
    if (drag.from !== drag.to) {
      usePromptQueue.getState().moveTo(drag.from, drag.to)
      setQueueSel(drag.to)
    }
    setQueueDragBoth(null)
  }

  const isDragging = queueDrag != null

  // 拖拽激活时在 window 上全局监听 touchmove (passive: false) 与 mousemove，
  // 确保移动端触控拖动时阻止页面滚动（e.preventDefault）并不受 pointercancel 干扰
  useEffect(() => {
    if (!isDragging) return

    const onTouchMove = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault()
      if (e.touches.length > 0) {
        handleDragMove(e.touches[0].clientY)
      }
    }

    const onTouchEnd = () => {
      onQueueGripPointerUp()
    }

    const onMouseMove = (e: MouseEvent) => {
      handleDragMove(e.clientY)
    }

    const onMouseUp = () => {
      onQueueGripPointerUp()
    }

    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', onTouchEnd)
    window.addEventListener('touchcancel', onTouchEnd)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)

    return () => {
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('touchcancel', onTouchEnd)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [isDragging])

  // 拖动中途组件卸载时清理定时器与 body 样式
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current)
        longPressTimerRef.current = null
      }
      applyDragChrome(false)
    }
  }, [])

  return {
    queue,
    queuePanelOpen,
    setQueuePanelOpen,
    queueEditIndex,
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
