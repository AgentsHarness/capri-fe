import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScrollEntry } from '../../api/types'
import { usePins } from '../../store/historyPins'
import {
  rememberStreamFade,
  resetStreamFadeCache,
} from '../../scrollback/streamFadeCache'
import { streamClockNow, type StreamTextView } from '../../scrollback/streamTextFade'
import { AbsorbingEntryRow } from './AbsorbingEntryRow'
import type { AbsorbingEntry } from './useAbsorbingEntries'

const thought: Extract<ScrollEntry, { kind: 'thought' }> = {
  id: 'th',
  kind: 'thought',
  text: 'hmm',
  displayMode: 'collapsed',
  streaming: false,
}

const ghost = (over: Partial<AbsorbingEntry> = {}): AbsorbingEntry => ({
  entry: thought,
  afterKey: null,
  patch: { displayMode: 'expanded' },
  waitForFade: false,
  ...over,
})

let frames: FrameRequestCallback[] = []

class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ROStub as unknown as typeof ResizeObserver

beforeEach(() => {
  resetStreamFadeCache()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const prev = usePins.getState().fePrefs
  usePins.setState({ fePrefs: { ...prev, streamTextSmooth: false } })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  frames = []
  resetStreamFadeCache()
  const prev = usePins.getState().fePrefs
  usePins.setState({ fePrefs: { ...prev, streamTextSmooth: true } })
})

const runFrames = () => {
  act(() => {
    // 只跑本帧已排队的回调；AccentRail 的波浪循环会继续排下一帧。
    const batch = frames.slice()
    frames = []
    for (const cb of batch) cb(16)
  })
}

describe('AbsorbingEntryRow', () => {
  it('先折正文，再把标题行淡出', () => {
    vi.useFakeTimers()
    render(<AbsorbingEntryRow ghost={ghost()} pendingFreeze={false} now={0} />)

    expect(screen.getByText(/Thought/)).toBeInTheDocument()
    expect(screen.getByText('hmm')).toBeInTheDocument()
    const box = document.querySelector('.gn-collapse')
    expect(box?.getAttribute('data-open')).toBe('1')

    // 正文折叠窗口内不淡出。
    act(() => vi.advanceTimersByTime(100))
    expect(box?.getAttribute('data-open')).toBe('1')
    act(() => vi.advanceTimersByTime(200))
    expect(box?.getAttribute('data-open')).toBe('0')
  })

  it('用户钉过的折叠行保持 dense 行距', () => {
    render(
      <AbsorbingEntryRow
        ghost={ghost({ patch: undefined })}
        pendingFreeze={false}
        now={0}
      />,
    )
    expect(
      document
        .querySelector('[data-entry-id="th"]')
        ?.hasAttribute('data-dense'),
    ).toBe(true)
  })

  it('接手直播行的淡入进度；未落定前不收高度', () => {
    const prev = usePins.getState().fePrefs
    usePins.setState({ fePrefs: { ...prev, streamTextSmooth: true } })
    const now = streamClockNow()
    const cached: StreamTextView = {
      source: 'hmm',
      pending: ['m', 'm'],
      parts: [
        {
          id: 9001,
          text: 'h',
          fading: true,
          expiresAt: now + 10_000,
          delayMs: 0,
          durationMs: 180,
        },
      ],
      deadline: now + 160,
    }
    rememberStreamFade('th', cached, now)

    render(
      <AbsorbingEntryRow
        ghost={ghost({ patch: { streaming: true }, waitForFade: true })}
        pendingFreeze={false}
        now={0}
      />,
    )
    // 只显示直播行已经释放的 'h'，没有整块重播。
    const entryText = () =>
      document.querySelector('[data-entry-id="th"]')?.textContent ?? ''
    expect(entryText()).not.toContain('hmm')
    expect(entryText()).toContain('h')
    // 淡入未落定前保持展开预览：非 dense 行距（EntryShell 不写 data-dense）。
    expect(
      document
        .querySelector('[data-entry-id="th"]')
        ?.hasAttribute('data-dense'),
    ).toBe(false)
    const box = document.querySelector('.gn-collapse')
    expect(box?.getAttribute('data-open')).toBe('1')

    // 排空 pending，但缓存里的淡入片段要到 10s 后才落定：不收高度。
    for (let i = 0; i < 4; i++) runFrames()
    expect(entryText()).toContain('hmm')
    expect(box?.getAttribute('data-open')).toBe('1')
  })
})
