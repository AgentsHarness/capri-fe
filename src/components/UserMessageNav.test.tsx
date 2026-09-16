import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { createRef } from 'react'
import { UserMessageNav, type UserMessageNavItem } from './UserMessageNav'

function items(n: number): UserMessageNavItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    seq: i * 10,
    preview: `消息 ${i}`,
    turnIdx: i,
    loaded: true,
  }))
}

/**
 * jsdom 无 matchMedia → isTouchUi() 默认 false（桌面）。触控用例临时改写
 * 让 `(hover: none), (pointer: coarse)` 命中。
 */
function stubTouchUi(touch: boolean): () => void {
  const original = window.matchMedia
  window.matchMedia = ((query: string) => ({
    matches: touch,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  return () => {
    window.matchMedia = original
  }
}

describe('UserMessageNav', () => {
  const originalMatchMedia = window.matchMedia

  beforeEach(() => {
    vi.useRealTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    window.matchMedia = originalMatchMedia
  })

  it('少于 2 条用户消息 → null（MIN_TURNS）', () => {
    const { container } = render(
      <UserMessageNav items={items(1)} activeId={null} onJump={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('>= 2 条 → 渲染折叠轨道（tick 条数 = 消息数）', () => {
    const { container } = render(
      <UserMessageNav items={items(3)} activeId={null} onJump={vi.fn()} />,
    )
    expect(screen.getByLabelText('打开用户消息目录')).not.toBeNull()
    const ticks = container.textContent?.match(/[─━]/g) ?? []
    expect(ticks).toHaveLength(3)
  })

  it('点击目录外部 → 关闭', () => {
    const { container } = render(
      <UserMessageNav items={items(3)} activeId={null} onJump={vi.fn()} />,
    )
    fireEvent.click(screen.getByLabelText('打开用户消息目录'))
    expect(screen.getByRole('list', { name: '用户消息目录' })).not.toBeNull()
    fireEvent.mouseDown(document.body)
    expect(container.querySelector('[role="list"]')).toBeNull()
  })

  it('activeId → 展开态 aria-current + 折叠态粗 tick（━━）', () => {
    const { container } = render(
      <UserMessageNav items={items(3)} activeId="m1" onJump={vi.fn()} />,
    )
    expect(container.textContent).toContain('━━')
    fireEvent.click(screen.getByLabelText('打开用户消息目录'))
    const activeRow = screen.getByLabelText('跳转到消息 2：消息 1')
    expect(activeRow.getAttribute('aria-current')).toBe('true')
    expect(screen.getByLabelText('跳转到消息 1：消息 0').getAttribute('aria-current')).toBeNull()
  })

  it('消息数超 MAX_COLLAPSED_TICKS → 只渲染 28 个窗口 tick', () => {
    const forty = items(40)
    const { container } = render(
      <UserMessageNav items={forty} activeId="m39" onJump={vi.fn()} />,
    )
    // 28 tick：27 个普通 '─' + 1 个激活 '━━'
    expect(container.querySelectorAll('button span span')).toHaveLength(28)
    const text = container.textContent ?? ''
    expect((text.match(/─/g) ?? []).length).toBe(27)
    expect((text.match(/━/g) ?? []).length).toBe(2)
  })

  it('轮子事件转发到 scrollback 容器；触顶时重派发 wheel', () => {
    const boxRef = createRef<HTMLDivElement>()
    const { container } = render(
      <div>
        <div ref={boxRef} data-testid="box" />
        <UserMessageNav items={items(3)} activeId={null} onJump={vi.fn()} scrollParentRef={boxRef} />
      </div>,
    )
    const box = boxRef.current!
    // jsdom 无布局：让 scrollTop 恒为 0，触发「触顶重派发」分支
    Object.defineProperty(box, 'scrollTop', { configurable: true, get: () => 0, set: () => {} })
    const dispatchSpy = vi.spyOn(box, 'dispatchEvent')
    // 折叠轨道接收滚轮（轨道压在转录上，不能吃掉翻页）
    fireEvent.wheel(screen.getByLabelText('打开用户消息目录'), { deltaY: 50 })
    expect(dispatchSpy).toHaveBeenCalled()
    expect(dispatchSpy.mock.calls[0][0]).toBeInstanceOf(WheelEvent)
    // 展开态由目录列表自己滚 → 不再转发
    dispatchSpy.mockClear()
    fireEvent.mouseEnter(container.querySelector('[data-user-nav-zone]')!)
    fireEvent.wheel(screen.getByRole('list', { name: '用户消息目录' }), { deltaY: 50 })
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('未加载轮：带「未加载」标记，点击把整条目交给 onJump（含 seq）', () => {
    const onJump = vi.fn()
    const mixed: UserMessageNavItem[] = [
      { id: 'prompt:0', seq: 0, preview: '最早一轮', turnIdx: 0, loaded: false },
      { id: 'm1', seq: 10, preview: '已加载轮', turnIdx: 1, loaded: true },
    ]
    render(<UserMessageNav items={mixed} activeId={null} onJump={onJump} />)
    fireEvent.click(screen.getByLabelText('打开用户消息目录'))
    const unloadedRow = screen.getByLabelText('跳转到消息 1：最早一轮')
    expect(unloadedRow.textContent).toContain('未加载')
    // 已加载轮不带「未加载」标记
    expect(screen.getByLabelText('跳转到消息 2：已加载轮').textContent).not.toContain('未加载')
    fireEvent.click(unloadedRow)
    expect(onJump).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'prompt:0', seq: 0, loaded: false }),
    )
  })

  describe('桌面（轨道常显 + 悬停直接展开）', () => {
    it('不滚动也常显（opacity-100）', () => {
      const { container } = render(
        <UserMessageNav items={items(3)} activeId={null} onJump={vi.fn()} />,
      )
      expect(container.querySelector('nav')!.className).toContain('opacity-100')
    })

    it('悬停轨道直接展开目录，移开收起（无需点击）', () => {
      const { container } = render(
        <UserMessageNav items={items(3)} activeId={null} onJump={vi.fn()} />,
      )
      const zone = container.querySelector('[data-user-nav-zone]')!
      fireEvent.mouseEnter(zone)
      expect(screen.getByRole('list', { name: '用户消息目录' })).not.toBeNull()
      fireEvent.mouseLeave(zone)
      expect(container.querySelector('[role="list"]')).toBeNull()
      expect(screen.getByLabelText('打开用户消息目录')).not.toBeNull()
    })

    it('展开列表的滚动与半屏高度落在内层元素上，不在 gn-menu 面板上', () => {
      render(<UserMessageNav items={items(3)} activeId={null} onJump={vi.fn()} />)
      fireEvent.click(screen.getByLabelText('打开用户消息目录'))
      const panel = screen.getByRole('list', { name: '用户消息目录' })
      expect(panel.className).toContain('gn-menu')
      // gn-menu 的 overflow:hidden 会压过同一元素上的 overflow-y-auto，滚动容器必须是内层。
      const scroller = screen.getByLabelText('跳转到消息 1：消息 0').parentElement!
      expect(scroller).not.toBe(panel)
      expect(scroller.className).toContain('overflow-y-auto')
      expect(scroller.className).toContain('max-h-[50vh]')
      expect(scroller.className).not.toContain('gn-menu')
    })

    it('悬停条目只高亮，不跳转也不收起目录', () => {
      const onJump = vi.fn()
      const { container } = render(
        <UserMessageNav items={items(3)} activeId={null} onJump={onJump} />,
      )
      fireEvent.mouseEnter(container.querySelector('[data-user-nav-zone]')!)
      const row = screen.getByLabelText('跳转到消息 1：消息 0')
      fireEvent.mouseEnter(row)
      expect(row.className).toContain('bg-gn-bg-hover')
      expect(onJump).not.toHaveBeenCalled()
      expect(screen.getByRole('list', { name: '用户消息目录' })).not.toBeNull()
    })
  })

  describe('触控（滚动显现 + 点击展开）', () => {
    it('滚动显现轨道，2s 空闲后淡出', () => {
      vi.useFakeTimers()
      const restore = stubTouchUi(true)
      const { container } = render(
        <div>
          <div data-scrollback-box data-testid="box" />
          <UserMessageNav items={items(3)} activeId={null} onJump={vi.fn()} />
        </div>,
      )
      const box = container.querySelector('[data-scrollback-box]')!
      const nav = container.querySelector('nav')!
      expect(nav.className).toContain('opacity-0')
      fireEvent.scroll(box)
      expect(nav.className).toContain('opacity-100')
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(nav.className).toContain('opacity-0')
      restore()
    })

    it('悬停不展开（触控无 hover 语义）', () => {
      const restore = stubTouchUi(true)
      const { container } = render(
        <UserMessageNav items={items(3)} activeId={null} onJump={vi.fn()} />,
      )
      fireEvent.mouseEnter(container.querySelector('[data-user-nav-zone]')!)
      expect(container.querySelector('[role="list"]')).toBeNull()
      restore()
    })

    it('点击轨道展开；打开期间不启动淡出计时', () => {
      vi.useFakeTimers()
      const restore = stubTouchUi(true)
      const { container } = render(
        <UserMessageNav items={items(3)} activeId={null} onJump={vi.fn()} />,
      )
      fireEvent.click(screen.getByLabelText('打开用户消息目录'))
      expect(screen.getByRole('list', { name: '用户消息目录' })).not.toBeNull()
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(container.querySelector('nav')!.className).toContain('opacity-100')
      restore()
    })

    it('点击条目跳转并收起目录', () => {
      const restore = stubTouchUi(true)
      const onJump = vi.fn()
      render(<UserMessageNav items={items(3)} activeId={null} onJump={onJump} />)
      fireEvent.click(screen.getByLabelText('打开用户消息目录'))
      fireEvent.click(screen.getByLabelText('跳转到消息 2：消息 1'))
      expect(onJump).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'm1', loaded: true }),
      )
      // 目录已收起（回到折叠轨道）
      expect(screen.getByLabelText('打开用户消息目录')).not.toBeNull()
      restore()
    })
  })
})
