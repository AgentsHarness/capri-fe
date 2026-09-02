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

describe('UserMessageNav', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
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

  it('点击轨道展开目录；点击条目跳转并收起', () => {
    const onJump = vi.fn()
    render(<UserMessageNav items={items(3)} activeId={null} onJump={onJump} />)
    fireEvent.click(screen.getByLabelText('打开用户消息目录'))
    expect(screen.getByRole('list', { name: '用户消息目录' })).not.toBeNull()
    expect(screen.getByLabelText('跳转到消息 2：消息 1')).not.toBeNull()
    // 序号 = turnIdx + 1
    expect(screen.getByText('1')).not.toBeNull()
    fireEvent.click(screen.getByLabelText('跳转到消息 2：消息 1'))
    expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', loaded: true }))
    // 目录已收起（回到折叠轨道）
    expect(screen.getByLabelText('打开用户消息目录')).not.toBeNull()
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

  it('滚动显示轨道，2s 空闲后淡出', () => {
    vi.useFakeTimers()
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
  })

  it('桌面 hover 边带显示轨道；离开后 2s 淡出', () => {
    vi.useFakeTimers()
    const { container } = render(
      <div>
        <div data-scrollback-box />
        <UserMessageNav items={items(3)} activeId={null} onJump={vi.fn()} />
      </div>,
    )
    const edge = container.querySelector('.pointer-events-auto.absolute') as HTMLElement
    expect(edge).not.toBeNull()
    const nav = container.querySelector('nav')!
    fireEvent.mouseEnter(edge)
    expect(nav.className).toContain('opacity-100')
    fireEvent.mouseLeave(edge)
    expect(nav.className).toContain('opacity-100') // 淡出前仍可见
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(nav.className).toContain('opacity-0')
  })

  it('目录展开期间离开 hover 区不启动淡出计时（保持可见）', () => {
    vi.useFakeTimers()
    const { container } = render(
      <div>
        <div data-scrollback-box />
        <UserMessageNav items={items(3)} activeId={null} onJump={vi.fn()} />
      </div>,
    )
    const edge = container.querySelector('.pointer-events-auto.absolute') as HTMLElement
    fireEvent.mouseEnter(edge)
    fireEvent.click(screen.getByLabelText('打开用户消息目录'))
    fireEvent.mouseLeave(edge)
    const nav = container.querySelector('nav')!
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(nav.className).toContain('opacity-100')
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
    // 桌面 hover 边带（始终挂 onWheel）接收滚轮
    const edge = container.querySelector('.pointer-events-auto.absolute') as HTMLElement
    fireEvent.wheel(edge, { deltaY: 50 })
    expect(dispatchSpy).toHaveBeenCalled()
    expect(dispatchSpy.mock.calls[0][0]).toBeInstanceOf(WheelEvent)
  })

  it('hover 条目不展开，但 hover 态切换不报错', () => {
    render(<UserMessageNav items={items(3)} activeId={null} onJump={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('打开用户消息目录'))
    const row = screen.getByLabelText('跳转到消息 1：消息 0')
    fireEvent.mouseEnter(row)
    fireEvent.mouseLeave(row)
    expect(screen.getByRole('list', { name: '用户消息目录' })).not.toBeNull()
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
})