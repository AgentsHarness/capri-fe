import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useQueueNav } from './useQueueNav'
import { usePromptQueue } from '../../store/promptQueue'
import { useChatStore } from '../../store/chat'
import type { PointerEvent as ReactPointerEvent } from 'react'

beforeEach(() => {
  usePromptQueue.setState({
    queues: {
      s1: [
        { id: '1', text: 'first', blocks: [{ type: 'text', text: 'first' }], ts: 1 },
        { id: '2', text: 'second', blocks: [{ type: 'text', text: 'second' }], ts: 2 },
        { id: '3', text: 'third', blocks: [{ type: 'text', text: 'third' }], ts: 3 },
      ],
    },
    sessionId: 's1',
    editIndex: null,
  })
  useChatStore.setState({
    queuePanelOpen: true,
  })
})

function makePointerEvent(overrides: Partial<ReactPointerEvent<HTMLElement>> = {}): ReactPointerEvent<HTMLElement> {
  const target = document.createElement('div')
  return {
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: 10,
    clientY: 10,
    currentTarget: {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    } as unknown as HTMLElement,
    target,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as ReactPointerEvent<HTMLElement>
}

describe('useQueueNav', () => {
  it('初始化时选中首项', () => {
    const { result } = renderHook(() => useQueueNav())
    expect(result.current.queueSel).toBe(0)
    expect(result.current.queueDrag).toBeNull()
  })

  it('非触控模式下点击行任意非按钮位置记录 arm，超过阈值升级为拖拽', () => {
    const { result } = renderHook(() => useQueueNav())

    act(() => {
      result.current.onQueueGripPointerDown(0, makePointerEvent({ clientX: 10, clientY: 10 }))
    })
    // 未超阈值前不进入 drag
    expect(result.current.queueDrag).toBeNull()

    // 移动超过 4px
    act(() => {
      result.current.onQueueGripPointerMove(makePointerEvent({ clientX: 10, clientY: 20 }))
    })
    expect(result.current.queueDrag).not.toBeNull()
    expect(result.current.queueDrag?.from).toBe(0)
  })

  it('移动触控模式下长按 250ms 可触发整行拖拽', () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useQueueNav())
      const textTarget = document.createElement('span')

      act(() => {
        result.current.onQueueGripPointerDown(
          1,
          makePointerEvent({
            pointerType: 'touch',
            target: textTarget,
            clientX: 10,
            clientY: 10,
          }),
        )
      })
      // 250ms 前未触发
      expect(result.current.queueDrag).toBeNull()

      // 长按时间到
      act(() => {
        vi.advanceTimersByTime(250)
      })
      expect(result.current.queueDrag).not.toBeNull()
      expect(result.current.queueDrag?.from).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('移动触控模式下长按未到时间前若大幅滑动（>8px），取消长按（视为滚动）', () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useQueueNav())
      const textTarget = document.createElement('span')

      act(() => {
        result.current.onQueueGripPointerDown(
          0,
          makePointerEvent({
            pointerType: 'touch',
            target: textTarget,
            clientX: 10,
            clientY: 10,
          }),
        )
      })

      // 100ms 时快速滑动 20px
      act(() => {
        vi.advanceTimersByTime(100)
        result.current.onQueueGripPointerMove(
          makePointerEvent({ pointerType: 'touch', clientX: 10, clientY: 30 }),
        )
      })

      // 即使时间走完也不再触发拖拽
      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(result.current.queueDrag).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('移动触控模式下在抓手区域按住正常启动拖拽', () => {
    const { result } = renderHook(() => useQueueNav())
    const gripTarget = document.createElement('span')
    gripTarget.setAttribute('data-queue-grip', '')

    act(() => {
      result.current.onQueueGripPointerDown(
        0,
        makePointerEvent({
          pointerType: 'touch',
          target: gripTarget,
          clientX: 10,
          clientY: 10,
        }),
      )
    })

    act(() => {
      result.current.onQueueGripPointerMove(
        makePointerEvent({ pointerType: 'touch', clientX: 10, clientY: 30 }),
      )
    })
    expect(result.current.queueDrag).not.toBeNull()
    expect(result.current.queueDrag?.from).toBe(0)
  })

  it('松开手指或鼠标完成排序并更新选中项', () => {
    const { result } = renderHook(() => useQueueNav())
    const gripTarget = document.createElement('span')
    gripTarget.setAttribute('data-queue-grip', '')

    act(() => {
      result.current.onQueueGripPointerDown(
        0,
        makePointerEvent({ target: gripTarget, clientX: 10, clientY: 10 }),
      )
    })
    act(() => {
      result.current.onQueueGripPointerMove(makePointerEvent({ clientX: 10, clientY: 20 }))
    })
    act(() => {
      result.current.onQueueGripPointerUp()
    })
    expect(result.current.queueDrag).toBeNull()
  })
})
