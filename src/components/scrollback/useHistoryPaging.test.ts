import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TouchEvent as ReactTouchEvent } from 'react'
import type { ScrollEntry } from '../../api/types'
import {
  PULL_DWELL_MS,
  PULL_IDLE_MS,
  PULL_TRIGGER_PX,
  TOP_EDGE_PX,
  TOP_PAGE_COOLDOWN_MS,
  TOUCH_UP_SWIPE_PX,
} from './constants'
import { useHistoryPaging } from './useHistoryPaging'

// 只用来做「loadMoreHistory 有没有真的开跑」的早退探测。
const storeMock = { historyLoadingMore: false }
vi.mock('../../store/chat', () => ({
  useChatStore: { getState: () => storeMock },
}))

type Props = {
  scrollTop: number
  historyHasMore: boolean
  historyLoadingMore: boolean
  historyPrependedAt: number | undefined
}

const ENTRIES = [{ id: 'e1', kind: 'user' }] as unknown as ScrollEntry[]

function makeBox(initial = 0) {
  let scrollTop = initial
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v
    },
  })
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => 400,
  })
  return {
    el,
    get scrollTop() {
      return scrollTop
    },
    set scrollTop(v: number) {
      scrollTop = v
    },
  }
}

function setup(p: Props, opts: { earlyReturn?: boolean } = {}) {
  const box = makeBox(p.scrollTop)
  // 与真实组件一致：ref 引用恒定（hook 内部按它绑定 wheel 原生监听）
  const boxRef = { current: box.el }
  const loadMoreHistory = vi.fn(() => {
    // 真实 store 在 loadMoreHistory 里同步置位；earlyReturn 模拟竞态早退。
    if (!opts.earlyReturn) storeMock.historyLoadingMore = true
  })
  const captureScrollPosition = vi.fn()
  const ensureScrollPositionCaptured = vi.fn()
  const cancelScrollSettle = vi.fn()
  let cur = p
  const h = renderHook(
    (pp: Props) =>
      useHistoryPaging(
        boxRef,
        ENTRIES,
        pp.historyHasMore,
        pp.historyLoadingMore,
        pp.historyPrependedAt,
        loadMoreHistory,
        captureScrollPosition,
        ensureScrollPositionCaptured,
        cancelScrollSettle,
      ),
    { initialProps: p },
  )
  /** 换 props 重渲染（模拟 store 状态推进）。 */
  const rerun = (next: Partial<Props> = {}) => {
    cur = { ...cur, ...next }
    // scrollTop 由盒子持有，其余走 props；store 标志与 props 保持一致。
    box.scrollTop = cur.scrollTop
    storeMock.historyLoadingMore = cur.historyLoadingMore
    h.rerender(cur)
  }
  return {
    ...h,
    rerun,
    box,
    loadMoreHistory,
    captureScrollPosition,
    ensureScrollPositionCaptured,
    cancelScrollSettle,
  }
}

const base: Props = {
  scrollTop: 0,
  historyHasMore: true,
  historyLoadingMore: false,
  historyPrependedAt: undefined,
}

/** 派发真实 wheel 事件：翻页走的是非 passive 原生监听，不是 React prop。 */
function pushWheel(h: ReturnType<typeof setup>, deltaY: number, deltaMode = 0) {
  act(() => {
    h.box.el.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY,
        deltaMode,
        cancelable: true,
        bubbles: true,
      }),
    )
  })
}

const touch = (clientY: number) =>
  ({ touches: [{ clientY }] }) as unknown as ReactTouchEvent<HTMLDivElement>

/** 先停手过 dwell（到边界后头几下不算上拉），再累计上推 px 像素。 */
function pull(h: ReturnType<typeof setup>, px = PULL_TRIGGER_PX) {
  quiet()
  pushWheel(h, -px)
}

/** 手势断流 + 边界停留窗口 */
function quiet(ms = PULL_IDLE_MS + PULL_DWELL_MS + 1) {
  vi.advanceTimersByTime(ms)
}

/** 不带 dwell 让位的连续上推（模拟一路滚到顶）。 */
function pushNow(h: ReturnType<typeof setup>, px: number) {
  pushWheel(h, -px)
}

/** 完整走一次「发起 → 请求中 → 落地（或不落地）」的 fetch 生命周期。 */
async function finishFetch(
  h: ReturnType<typeof setup>,
  opts: { prepended?: number } = {},
) {
  await act(async () => h.rerun({ historyLoadingMore: true }))
  await act(async () =>
    h.rerun({
      historyLoadingMore: false,
      historyPrependedAt: opts.prepended,
    }),
  )
}

beforeEach(() => {
  storeMock.historyLoadingMore = false
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 8, 1, 12, 0, 0))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useHistoryPaging · 触发纪律', () => {
  it('未到累加阈值不翻页（触控板轻扫 / 惯性尾巴）', () => {
    const h = setup(base)
    quiet()
    pushNow(h, PULL_TRIGGER_PX - 1)
    expect(h.loadMoreHistory).not.toHaveBeenCalled()
  })

  it('累计到阈值翻一页；同一次手势继续推不翻第二页', () => {
    const h = setup(base)
    quiet()
    pushNow(h, PULL_TRIGGER_PX / 2)
    pushNow(h, PULL_TRIGGER_PX / 2)
    expect(h.loadMoreHistory).toHaveBeenCalledTimes(1)
    pushNow(h, PULL_TRIGGER_PX * 3)
    expect(h.loadMoreHistory).toHaveBeenCalledTimes(1)
  })

  it('没顶到边界时上推什么都不触发（旧实现 80px 带内会直接翻页）', () => {
    const h = setup({ ...base, scrollTop: TOP_EDGE_PX + 40 })
    quiet()
    pushNow(h, PULL_TRIGGER_PX * 5)
    pushNow(h, PULL_TRIGGER_PX * 5)
    expect(h.loadMoreHistory).not.toHaveBeenCalled()
    expect(h.captureScrollPosition).not.toHaveBeenCalled()
  })

  it('滚到顶后手没停地继续推：一直不翻页，停手才算上拉', () => {
    const h = setup(base)
    // 滚到顶的那次 scroll 事件武装 dwell
    act(() => h.result.current.onPagingScroll())
    for (let i = 0; i < 20; i++) {
      pushNow(h, 300)
      vi.advanceTimersByTime(60)
    }
    expect(h.loadMoreHistory).not.toHaveBeenCalled()
    pull(h)
    expect(h.loadMoreHistory).toHaveBeenCalledTimes(1)
  })

  it('向下滚清零累加器', () => {
    const h = setup(base)
    quiet()
    pushNow(h, PULL_TRIGGER_PX - 1)
    pushWheel(h, 20)
    pushNow(h, PULL_TRIGGER_PX - 1)
    expect(h.loadMoreHistory).not.toHaveBeenCalled()
    pull(h, PULL_TRIGGER_PX)
    expect(h.loadMoreHistory).toHaveBeenCalledTimes(1)
  })

  it('滚离边界再回到边界：先要停一下（dwell）才开始累计', () => {
    const h = setup(base)
    pull(h)
    expect(h.loadMoreHistory).toHaveBeenCalledTimes(1)
    // 读一会儿，再滚回顶部
    h.box.scrollTop = 300
    act(() => h.result.current.onPagingScroll())
    h.box.scrollTop = 0
    act(() => h.result.current.onPagingScroll())
    // 刚到边界，立刻猛推不算上拉（且每一下都重新计时）
    pushNow(h, PULL_TRIGGER_PX * 3)
    vi.advanceTimersByTime(60)
    pushNow(h, PULL_TRIGGER_PX * 3)
    expect(h.loadMoreHistory).toHaveBeenCalledTimes(1)
    // 停过 dwell 后再拉 → 翻一页
    pull(h)
    expect(h.loadMoreHistory).toHaveBeenCalledTimes(2)
  })

  it('一路滚到顶的那几下不被当成上拉（dwell 闸）', () => {
    const h = setup({ ...base, scrollTop: 900 })
    // 连续上滚：中途滚到顶（scrollTop 归 0 并上报滚动事件），手没有停
    pushNow(h, 300)
    h.box.scrollTop = 0
    act(() => h.result.current.onPagingScroll())
    pushNow(h, 300)
    vi.advanceTimersByTime(60)
    pushNow(h, 300)
    vi.advanceTimersByTime(60)
    pushNow(h, 300)
    expect(h.loadMoreHistory).not.toHaveBeenCalled()
    pull(h)
    expect(h.loadMoreHistory).toHaveBeenCalledTimes(1)
  })

  it('手势断流（> PULL_IDLE_MS）后算新的一下', () => {
    const h = setup(base)
    pull(h)
    expect(h.loadMoreHistory).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(400)
    pull(h)
    expect(h.loadMoreHistory).toHaveBeenCalledTimes(2)
  })

  it('deltaMode=1（Firefox 按行上报）换算成像素后再判阈值', () => {
    const h = setup(base)
    const lines = Math.ceil(PULL_TRIGGER_PX / 16)
    pushWheel(h, -lines, 1)
    expect(h.loadMoreHistory).toHaveBeenCalledTimes(1)
    const h2 = setup(base)
    pushWheel(h2, -(lines - 2), 1)
    expect(h2.loadMoreHistory).not.toHaveBeenCalled()
  })

  it('翻页前拍位置快照，anchor 传 store 头部 id', () => {
    const h = setup(base)
    pull(h)
    expect(h.captureScrollPosition).toHaveBeenCalledTimes(1)
    expect(h.loadMoreHistory).toHaveBeenCalledWith('e1')
  })

  it('滚轮手势记为 keep，点击记为 reveal', () => {
    const h = setup(base)
    pull(h)
    expect(h.result.current.pagingModeRef.current).toBe('keep')
    act(() => h.result.current.maybeLoadOlderHistory('reveal'))
    expect(h.result.current.pagingModeRef.current).toBe('reveal')
  })

  it('只有真翻页那一下被本组件消费（preventDefault），其余交回浏览器', () => {
    const h = setup(base)
    quiet()
    // 没到阈值 → 不该吃掉事件（条目内部的滚动区还要用）
    const under = new WheelEvent('wheel', {
      deltaY: -100,
      cancelable: true,
      bubbles: true,
    })
    act(() => h.box.el.dispatchEvent(under))
    expect(under.defaultPrevented).toBe(false)
    const ev = new WheelEvent('wheel', {
      deltaY: -PULL_TRIGGER_PX,
      cancelable: true,
      bubbles: true,
    })
    act(() => h.box.el.dispatchEvent(ev))
    expect(ev.defaultPrevented).toBe(true)
    const mid = setup({ ...base, scrollTop: TOP_EDGE_PX + 60 })
    const ev2 = new WheelEvent('wheel', {
      deltaY: -200,
      cancelable: true,
      bubbles: true,
    })
    act(() => mid.box.el.dispatchEvent(ev2))
    expect(ev2.defaultPrevented).toBe(false)
  })

  it('historyLoadingMore 中不重复发起', () => {
    const h = setup({ ...base, historyLoadingMore: true })
    pull(h, PULL_TRIGGER_PX * 4)
    expect(h.loadMoreHistory).not.toHaveBeenCalled()
  })

  it('没有更多历史时不发起', () => {
    const h = setup({ ...base, historyHasMore: false })
    pull(h, PULL_TRIGGER_PX * 4)
    expect(h.loadMoreHistory).not.toHaveBeenCalled()
  })

  it('fetch 结束但没落地新页（失败 / no-op）→ 立刻可重试，不等冷却', async () => {
    const h = setup(base)
    pull(h)
    expect(h.loadMoreHistory).toHaveBeenCalledTimes(1)
    await finishFetch(h, { prepended: undefined })
    // 同一手势余波里再来一次（未断流，但 burst 门闩随失败一起解开）
    pushWheel(h, -PULL_TRIGGER_PX)
    expect(h.loadMoreHistory).toHaveBeenCalledTimes(2)
  })

  it('成功落地新页：同一手势不连锁，冷却期内有意的上推也被挡住', async () => {
    const h = setup(base)
    pull(h)
    // 同一连续手势的余波（没有断流）→ burst 门闩挡住
    pushNow(h, PULL_TRIGGER_PX * 2)
    expect(h.loadMoreHistory).toHaveBeenCalledTimes(1)
    await finishFetch(h, { prepended: Date.now() })
    // 手势断流（> PULL_IDLE_MS）但仍在 400ms 冷却内 → 冷却挡住
    vi.advanceTimersByTime(PULL_IDLE_MS + 10)
    pushNow(h, PULL_TRIGGER_PX * 2)
    expect(h.loadMoreHistory).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(TOP_PAGE_COOLDOWN_MS)
    pushNow(h, PULL_TRIGGER_PX)
    expect(h.loadMoreHistory).toHaveBeenCalledTimes(2)
  })

  it('请求开始时补拍位置（sticky / 链式续翻没有手势入口）', async () => {
    const h = setup(base)
    await act(async () => h.rerun({ historyLoadingMore: true }))
    expect(h.ensureScrollPositionCaptured).toHaveBeenCalledTimes(1)
  })

  it('loadMoreHistory 早退（store 仍没开跑）→ 门闩不卡死', () => {
    const h = setup(base, { earlyReturn: true })
    act(() => h.result.current.maybeLoadOlderHistory('reveal'))
    act(() => h.result.current.maybeLoadOlderHistory('reveal'))
    expect(h.loadMoreHistory).toHaveBeenCalledTimes(2)
  })

  it('触摸：越过边界的累计位移达标才翻页', () => {
    const h = setup(base)
    act(() => h.result.current.onPagingTouchStart(touch(100)))
    act(() => h.result.current.onPagingTouchEnd())
    expect(h.loadMoreHistory).not.toHaveBeenCalled()
    act(() => h.result.current.onPagingTouchStart(touch(100)))
    act(() => h.result.current.onPagingTouchMove(touch(100 + TOUCH_UP_SWIPE_PX + 40)))
    act(() => h.result.current.onPagingTouchEnd())
    expect(h.loadMoreHistory).toHaveBeenCalledTimes(1)
  })

  it('触摸：从内容中间拖到顶的那一段不算上拉', () => {
    const h = setup(base)
    act(() => h.result.current.onPagingTouchStart(touch(100)))
    // 这一段还在内容里（scrollTop > 边界）→ 起点跟着手指走
    h.box.scrollTop = 300
    act(() => h.result.current.onPagingTouchMove(touch(140)))
    h.box.scrollTop = 0
    act(() => h.result.current.onPagingTouchMove(touch(180)))
    act(() => h.result.current.onPagingTouchEnd())
    // 只有 140→180 这 40px 算越界上拉，不到 TOUCH_UP_SWIPE_PX
    expect(h.loadMoreHistory).not.toHaveBeenCalled()
  })

  it('每次触摸 / 滚轮手势都先让用户接管（关掉锚点看门狗）', () => {
    const h = setup(base)
    pushWheel(h, -4)
    act(() => h.result.current.onPagingTouchStart(touch(10)))
    expect(h.cancelScrollSettle).toHaveBeenCalledTimes(2)
  })
})
