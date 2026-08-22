import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { AccentRail } from './AccentRail'
import { Glyphs } from '../theme/glyphs'
import { DIM_ACCENT, blendColor } from '../theme/wave'
import { Accents } from '../theme/accents'
import type { AccentPaint } from '../theme/accents'

// jsdom 无 ResizeObserver / matchMedia —— 组件里用到，这里补桩。
class MockResizeObserver {
  static instances: MockResizeObserver[] = []
  callback: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) {
    this.callback = cb
    MockResizeObserver.instances.push(this)
  }
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}

beforeEach(() => {
  MockResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
})

afterEach(() => {
  MockResizeObserver.instances = []
  vi.unstubAllGlobals()
})

function stubMatchMedia(matches: boolean) {
  const mq = { matches, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  vi.stubGlobal('matchMedia', vi.fn(() => mq))
  return mq
}

const base: AccentPaint = { show: true, color: '#9b8cff', animated: false }

describe('AccentRail', () => {
  it('show=false → 空轨道占位', () => {
    const { container } = render(<AccentRail paint={{ ...base, show: false }} />)
    expect(container.querySelector('div[aria-hidden]')).not.toBeNull()
    expect(container.querySelector('div')?.className).toContain('w-0 shrink-0')
  })

  it('collapsed 模式 → 短 tick 且不启用 ResizeObserver', () => {
    const { container } = render(
      <AccentRail paint={{ ...base, collapsedGlyph: true }} />,
    )
    const span = container.querySelector('span')
    expect(span).not.toBeNull()
    expect(span?.getAttribute('title')).toBe(Glyphs.collapsedAccent)
    expect(span?.style.height).toBe('0.75em')
    expect(span?.style.opacity).toBe('0.9')
    expect(MockResizeObserver.instances).toHaveLength(0)
  })

  it('静态全长轨 → 纯色填充 + 纹理层', () => {
    const { container } = render(<AccentRail paint={base} />)
    const track = container.querySelector('div[aria-hidden]') as HTMLElement
    expect(track).not.toBeNull()
    expect(track.style.getPropertyValue('--gn-bar')).toBe('#9b8cff')
    // jsdom 会把 hex 归一化成 rgb
    const staticFill = Array.from(track.querySelectorAll('div.absolute'))[0] as HTMLElement
    expect(staticFill.style.backgroundColor).toBe('rgb(155, 140, 255)')
    expect(staticFill.style.opacity).toBe('0.9')
    // 纹理层
    const texture = Array.from(track.querySelectorAll('div.absolute'))[1] as HTMLElement
    expect(texture.style.opacity).toBe('0.35')
  })

  it('interaction=selected → 不透明度升到 1', () => {
    const { container } = render(
      <AccentRail paint={{ ...base, interaction: 'selected' }} />,
    )
    const fill = container.querySelector('div[aria-hidden] > div > div') as HTMLElement
    expect(fill.style.opacity).toBe('1')
  })

  it('interaction=hover → 向背景 blend 0.72', () => {
    const { container } = render(
      <AccentRail paint={{ ...base, interaction: 'hover' }} />,
    )
    const fill = container.querySelector('div[aria-hidden] > div > div') as HTMLElement
    expect(fill.style.backgroundColor).toBe(blendColor(Accents.bg, '#9b8cff', 0.72))
    expect(fill.style.opacity).toBe('0.95')
  })

  it('dim=true → DIM_ACCENT blend', () => {
    const { container } = render(<AccentRail paint={{ ...base, dim: true }} />)
    const fill = container.querySelector('div[aria-hidden] > div > div') as HTMLElement
    expect(fill.style.backgroundColor).toBe(blendColor(Accents.bg, '#9b8cff', DIM_ACCENT))
  })

  it('animated + tick prop → 按行高渲染 wave 段', () => {
    const { container } = render(
      <AccentRail paint={{ ...base, animated: true }} tick={2} />,
    )
    const ro = MockResizeObserver.instances[0]
    expect(ro).toBeDefined()
    expect(ro.observe).toHaveBeenCalled()

    const track = container.querySelector('div[aria-hidden]') as HTMLElement
    Object.defineProperty(track, 'clientHeight', { value: 66, configurable: true })
    act(() => {
      ro.callback([], ro as unknown as ResizeObserver)
    })
    // ceil(66/11) = 6 段
    expect(track.querySelectorAll('.flex.flex-col > div')).toHaveLength(6)
  })

  it('animated + 无 tick prop → 自驱动 rAF 计时器', () => {
    vi.useFakeTimers()
    const { container } = render(<AccentRail paint={{ ...base, animated: true }} />)
    expect(MockResizeObserver.instances).toHaveLength(1)
    expect(container.querySelector('div[aria-hidden]')).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(100)
    })
    vi.useRealTimers()
  })

  it('frozen=true → 视为静态（无 wave 行渲染循环）', () => {
    vi.useFakeTimers()
    const { container } = render(
      <AccentRail paint={{ ...base, animated: true, frozen: true }} />,
    )
    const fill = container.querySelector('div[aria-hidden] > div > div') as HTMLElement
    expect(fill.style.backgroundColor).toBe('rgb(155, 140, 255)')
    vi.useRealTimers()
  })

  it('prefers-reduced-motion → 冻结动画', () => {
    const mq = stubMatchMedia(true)
    const { container } = render(<AccentRail paint={{ ...base, animated: true }} />)
    // reduceMotion=true → frozen → 静态填充
    const fill = container.querySelector('div[aria-hidden] > div > div') as HTMLElement
    expect(fill.style.backgroundColor).toBe('rgb(155, 140, 255)')
    // change 事件回调存在（挂上了监听）
    expect(mq.addEventListener).toHaveBeenCalledWith('change', expect.any(Function))
  })

  it('collapsed 且冻结（live=false）→ 仍走 tick 模式', () => {
    const { container } = render(
      <AccentRail paint={{ ...base, collapsedGlyph: true, animated: true, frozen: true }} />,
    )
    expect(container.querySelector('span')).not.toBeNull()
  })

  it('卸载时断开 ResizeObserver 并清理监听', () => {
    const { unmount } = render(<AccentRail paint={{ ...base, animated: true }} tick={1} />)
    const ro = MockResizeObserver.instances[0]
    unmount()
    expect(ro.disconnect).toHaveBeenCalled()
  })
})