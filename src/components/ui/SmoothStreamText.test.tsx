import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { SmoothStreamText } from './SmoothStreamText'
import { STREAM_TEXT_FRAME_MS } from '../../scrollback/streamTextFade'

/** 推进 n 个动画帧（假定时器里 rAF 按 16ms 触发）。逐帧 act，让 effect
 *  在下一帧前排好新的 rAF。 */
function frames(count = 1) {
  for (let i = 0; i < count; i++) {
    act(() => {
      vi.advanceTimersByTime(STREAM_TEXT_FRAME_MS)
    })
  }
}

const fadeSpans = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.gn-stream-fade')).map(
    (node) => node.textContent ?? '',
  )

describe('SmoothStreamText — 短缓冲逐字淡入', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('10 字一段到达时按帧逐字出现，不是整段一起出现', () => {
    const r = render(<SmoothStreamText text="" enabled />)
    r.rerender(<SmoothStreamText text="abcdefghij" enabled />)

    // 吸收和释放合并到同一个 rAF：文本更新当帧不挂片段，下一帧才放出首字。
    expect(r.container.textContent).toBe('')
    frames(1)
    expect(r.container.textContent).toBe('a')
    expect(fadeSpans(r.container)).toEqual(['a'])

    frames(1)
    expect(r.container.textContent).toBe('ab')
    // 上一字还没淡完，仍在片段里；新字单独一个片段，不会合并成整段。
    expect(fadeSpans(r.container)).toEqual(['a', 'b'])

    frames(20)
    expect(r.container.textContent).toBe('abcdefghij')
  })

  it('慢 token：上一段已淡完时，新 token 单独挂一个淡入片段', () => {
    const r = render(<SmoothStreamText text="a" enabled />)
    expect(r.container.textContent).toBe('a')

    // 跨过 180ms 动画窗口，同时排空可能残留的缓冲。
    frames(20)
    r.rerender(<SmoothStreamText text="ab" enabled />)

    expect(r.container.textContent).toBe('a')
    frames(1)
    expect(r.container.textContent).toBe('ab')
    expect(fadeSpans(r.container)).toEqual(['b'])
  })

  it('120 字成段到达：首帧只放出小片段，排空后文本完整', () => {
    const text = 'x'.repeat(120)
    const r = render(<SmoothStreamText text="" enabled />)
    r.rerender(<SmoothStreamText text={text} enabled />)

    expect(r.container.textContent).toBe('')
    frames(1)
    expect(r.container.textContent!.length).toBeGreaterThan(0)
    expect(r.container.textContent!.length).toBeLessThan(text.length)
    for (const span of fadeSpans(r.container)) {
      expect(span.length).toBeLessThanOrEqual(2)
    }

    frames(30)
    expect(r.container.textContent).toBe(text)
  })

  it('关闭平滑时立即显示全文，不挂动画片段', () => {
    const text = 'x'.repeat(120)
    const r = render(<SmoothStreamText text={text} enabled={false} />)
    expect(r.container.textContent).toBe(text)
    expect(fadeSpans(r.container)).toEqual([])
  })

  it('prefers-reduced-motion 时直接显示全文', () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia

    try {
      const text = 'x'.repeat(120)
      const r = render(<SmoothStreamText text={text} enabled />)
      expect(r.container.textContent).toBe(text)
      expect(fadeSpans(r.container)).toEqual([])
    } finally {
      window.matchMedia = original
    }
  })

  it('流式更新把已显示文本挪进稳定文本，新字仍在淡入片段里', () => {
    const r = render(<SmoothStreamText text="abc" enabled />)
    expect(fadeSpans(r.container)).toEqual(['a'])

    frames(20)
    r.rerender(<SmoothStreamText text="abcdef" enabled />)

    // 新增的 def 也先进入短缓冲，下一帧才挂出首个新字。
    expect(r.container.textContent).toBe('abc')
    frames(1)
    expect(r.container.textContent).toBe('abcd')
    expect(fadeSpans(r.container).length).toBeGreaterThan(0)
    expect(fadeSpans(r.container).join('')).not.toBe('def')

    frames(20)
    expect(r.container.textContent).toBe('abcdef')
  })
})
