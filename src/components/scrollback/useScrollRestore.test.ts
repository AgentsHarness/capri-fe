import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RefObject } from 'react'
import type { ScrollEntry } from '../../api/types'
import { ANCHOR_DRIFT_TOLERANCE_PX, TOP_EDGE_PX } from './constants'
import { useScrollRestore } from './useScrollRestore'

/**
 * jsdom 没有排版：手搓一个一维假布局。
 *   内容坐标 = [bar(BAR_H)] [顶部加载按钮 btnH] [row0 h0] [row1 h1] …
 * 元素 rect 逐个 stub（own property 压住原型方法），box 的 scrollTop /
 * scrollHeight / clientHeight 用 accessor 模拟带钳位的滚动容器。
 */
const BAR_H = 28
const VIEW_H = 400
/** 可读区顶（workspace bar 下沿）的视口 Y。 */
const READ_LINE = BAR_H

type RowSpec = { id: string; h: number; kind?: 'user' | 'assistant' | 'tool' }

function fakeRect(top: number, height: number): () => DOMRect {
  return () =>
    ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 800,
      width: 800,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect
}

class FakeLayout {
  box = document.createElement('div')
  btn = document.createElement('div')
  barEl = document.createElement('div')
  rows: RowSpec[] = []
  els = new Map<string, HTMLElement>()
  btnH = 28
  top = 0

  constructor() {
    this.box.appendChild(this.barEl)
    this.box.appendChild(this.btn)
    this.barEl.getBoundingClientRect = fakeRect(0, BAR_H)
    this.box.getBoundingClientRect = fakeRect(0, VIEW_H)
    Object.defineProperty(this.box, 'clientHeight', {
      configurable: true,
      get: () => VIEW_H,
    })
    Object.defineProperty(this.box, 'scrollHeight', {
      configurable: true,
      get: () => this.scrollHeightRaw,
    })
    Object.defineProperty(this.box, 'scrollTop', {
      configurable: true,
      get: () => this.top,
      set: (v: number) => {
        const max = Math.max(0, this.scrollHeightRaw - VIEW_H)
        this.top = Math.min(Math.max(0, v), max)
        this.relayout()
      },
    })
  }

  get scrollHeightRaw() {
    return BAR_H + this.btnH + this.rows.reduce((acc, r) => acc + r.h, 0)
  }

  contentTop(index: number) {
    let y = BAR_H + this.btnH
    for (let i = 0; i < index; i++) y += this.rows[i].h
    return y
  }

  /**
   * 按当前 rows + top 就地刷新 rect。元素按 id 复用（append 会保持顺序），
   * 这样调用方持有的元素引用不会因为一次重排就变成孤儿 + 过期 rect。
   */
  relayout() {
    const alive = new Set<string>()
    this.rows.forEach((r, i) => {
      let el = this.els.get(r.id)
      if (!el) {
        el = document.createElement('div')
        el.setAttribute('data-entry-id', r.id)
        this.els.set(r.id, el)
      }
      alive.add(r.id)
      el.getBoundingClientRect = fakeRect(this.contentTop(i) - this.top, r.h)
      this.box.appendChild(el)
    })
    for (const [id, el] of this.els) {
      if (alive.has(id)) continue
      el.remove()
      this.els.delete(id)
    }
  }

  prepend(specs: RowSpec[]) {
    this.rows = [...specs, ...this.rows]
    this.relayout()
  }

  setRowHeight(id: string, h: number) {
    const r = this.rows.find((x) => x.id === id)
    if (!r) throw new Error(`no row ${id}`)
    r.h = h
    this.relayout()
  }

  setBtnH(h: number) {
    this.btnH = h
    this.relayout()
  }

  /** 某条目的视口顶 Y（box 顶为 0）。 */
  viewportTop(id: string) {
    const el = this.box.querySelector(`[data-entry-id="${id}"]`)
    if (!el) return Number.NaN
    return el.getBoundingClientRect().top
  }

  toRef(): RefObject<HTMLDivElement | null> {
    return { current: this.box }
  }
}

const ROWS = (n: number, h = 200): RowSpec[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    h,
    kind: i % 4 === 0 ? ('user' as const) : ('assistant' as const),
  }))

function setup(rows: RowSpec[], scrollTop: number) {
  const layout = new FakeLayout()
  layout.rows = rows
  layout.relayout()
  layout.box.scrollTop = scrollTop
  const followRef = { current: true }
  const lastScrollTopRef = { current: layout.top }
  const wsBarElRef = { current: layout.barEl }
  let specs = rows
  const h = renderHook(() =>
    useScrollRestore(
      layout.toRef(),
      followRef,
      lastScrollTopRef,
      wsBarElRef,
      BAR_H,
      specs.map(
        (r) =>
          ({ id: r.id, kind: r.kind ?? 'assistant' }) as unknown as ScrollEntry,
      ),
    ),
  )
  const setRows = (next: RowSpec[]) => {
    specs = next
    h.rerender()
  }
  return { ...h, layout, followRef, lastScrollTopRef, setRows }
}

/** 视口里第一条还没完全滚过去的条目 = 锚点会挑中的那一条。 */
function anchorIdOf(layout: FakeLayout) {
  const r = layout.rows.find(
    (row) => layout.viewportTop(row.id) + row.h > READ_LINE + 1,
  )
  if (!r) throw new Error('no anchor candidate')
  return r.id
}

describe('useScrollRestore · 行锚点恢复', () => {
  it('keep：prepend 后正在读的那一行停在原处', () => {
    const s = setup(ROWS(10), 900)
    const id = anchorIdOf(s.layout)
    act(() => s.result.current.captureScrollPosition())
    const before = s.layout.viewportTop(id)

    s.layout.prepend([{ id: 'old0', h: 180 }, { id: 'old1', h: 720 }])
    s.setRows(s.layout.rows)
    let res: string | undefined
    act(() => {
      res = s.result.current.revealPrependedTurn('e0', 'keep')
    })

    expect(res).toBe('kept')
    expect(Math.abs(s.layout.viewportTop(id) - before)).toBeLessThan(1)
    // 视口没有被贴底逻辑拽回末尾
    expect(s.followRef.current).toBe(false)
  })

  it('keep：顶部按钮换行 / 卸载这类无关高度变化污染不了恢复', () => {
    const s = setup(ROWS(10), 900)
    const id = anchorIdOf(s.layout)
    act(() => s.result.current.captureScrollPosition())
    const before = s.layout.viewportTop(id)
    const topBefore = s.layout.top

    s.layout.prepend([{ id: 'old0', h: 700 }])
    // 同帧里加载按钮三态文案先撑高、最后一页又整个卸载
    s.layout.setBtnH(120)
    s.layout.setBtnH(0)
    s.setRows(s.layout.rows)
    act(() => s.result.current.revealPrependedTurn('e0', 'keep'))

    expect(Math.abs(s.layout.viewportTop(id) - before)).toBeLessThan(1)
    expect(s.layout.top).toBeGreaterThan(topBefore)
  })

  it('keep：绝不做顶对齐（新轮的 user 行不落回可读区顶）', () => {
    const s = setup(ROWS(8), 1100)
    act(() => s.result.current.captureScrollPosition())
    s.layout.prepend([{ id: 'u_new', h: 120, kind: 'user' }])
    s.setRows(s.layout.rows)
    act(() => s.result.current.revealPrependedTurn('e0', 'keep'))
    expect(
      Math.abs(s.layout.viewportTop('u_new') - READ_LINE),
    ).toBeGreaterThan(TOP_EDGE_PX + ANCHOR_DRIFT_TOLERANCE_PX)
  })

  it('reveal：短轮顶对齐完整展示', () => {
    const s = setup(ROWS(8), 1100)
    act(() => s.result.current.captureScrollPosition())
    s.layout.prepend([
      { id: 'u_new', h: 100, kind: 'user' },
      { id: 'a_new', h: 120 },
    ])
    s.setRows(s.layout.rows)
    let res: string | undefined
    act(() => {
      res = s.result.current.revealPrependedTurn('e0', 'reveal')
    })
    expect(res).toBe('revealed')
    expect(Math.abs(s.layout.viewportTop('u_new') - READ_LINE)).toBeLessThan(1)
  })

  it('reveal：长轮（比视口高）只保持位置不跳', () => {
    const s = setup(ROWS(8), 1100)
    const id = anchorIdOf(s.layout)
    act(() => s.result.current.captureScrollPosition())
    const before = s.layout.viewportTop(id)
    s.layout.prepend([{ id: 'u_new', h: 900, kind: 'user' }])
    s.setRows(s.layout.rows)
    let res: string | undefined
    act(() => {
      res = s.result.current.revealPrependedTurn('e0', 'reveal')
    })
    expect(res).toBe('kept')
    expect(Math.abs(s.layout.viewportTop(id) - before)).toBeLessThan(1)
  })

  it('顶那条锚点被 prepend 合并掉时，顺位退到下一条', () => {
    const s = setup(ROWS(10), 900)
    act(() => s.result.current.captureScrollPosition())
    // 候选 = e4（跨在可读区顶上）/ e5 / e6
    const beforeE5 = s.layout.viewportTop('e5')
    // 模拟 loadMoreHistory 的页尾缝合：旧区首条被并进新页最后一条 → e4 消失
    s.layout.prepend([{ id: 'old0', h: 400 }])
    s.layout.rows = s.layout.rows.filter((r) => r.id !== 'e4')
    s.layout.relayout()
    s.setRows(s.layout.rows)
    act(() => s.result.current.revealPrependedTurn('e0', 'keep'))
    // e5 上方：新页 +400px、被合并掉的 e4 -200px → 只补偿这 200px 净增量
    expect(s.layout.top).toBe(1100)
    expect(Math.abs(s.layout.viewportTop('e5') - beforeE5)).toBeLessThan(1)
  })

  it('没有行锚点时回退到 height-delta 快照', () => {
    const s = setup([], 0)
    // 一条条目都没挂载（EmptyState / 尚未挂载）：capture 只能留下快照
    s.layout.setBtnH(500)
    act(() => s.result.current.captureScrollPosition())
    s.layout.prepend([{ id: 'old0', h: 900 }, { id: 'old1', h: 900 }])
    s.setRows(s.layout.rows)
    act(() => s.result.current.revealPrependedTurn(null, 'keep'))
    // height-delta：原 scrollTop 0 + scrollHeight 增量 1800
    expect(s.layout.top).toBe(1800)
  })

  it('看门狗：晚到撑高（图片解码 / mermaid）按同一锚点拉回', () => {
    const s = setup(ROWS(10), 900)
    const id = anchorIdOf(s.layout)
    act(() => s.result.current.captureScrollPosition())
    const before = s.layout.viewportTop(id)
    s.layout.prepend([{ id: 'old0', h: 400 }])
    s.setRows(s.layout.rows)
    act(() => s.result.current.revealPrependedTurn('e0', 'keep'))
    expect(Math.abs(s.layout.viewportTop(id) - before)).toBeLessThan(1)

    // 请求早已结束、DOM 也挂了，但 old0 里的图片这一刻才解码撑高
    s.layout.setRowHeight('old0', 900)
    expect(Math.abs(s.layout.viewportTop(id) - before)).toBeGreaterThan(2)
    act(() => s.result.current.settleScrollAnchor())
    expect(Math.abs(s.layout.viewportTop(id) - before)).toBeLessThan(1)
  })

  it('cancelScrollSettle：用户接管后看门狗不再抢方向盘', () => {
    const s = setup(ROWS(10), 900)
    act(() => s.result.current.captureScrollPosition())
    s.layout.prepend([{ id: 'old0', h: 400 }])
    s.setRows(s.layout.rows)
    act(() => s.result.current.revealPrependedTurn('e0', 'keep'))
    const afterRestore = s.layout.top
    act(() => s.result.current.cancelScrollSettle())
    s.layout.setRowHeight('old0', 900)
    act(() => s.result.current.settleScrollAnchor())
    expect(s.layout.top).toBe(afterRestore)
  })

  it('动量窗口内一律算自己写的；窗口关掉后按 scrollTop 值判定', () => {
    const s = setup(ROWS(10), 900)
    expect(s.result.current.isProgrammaticScroll(s.layout.box)).toBe(false)
    act(() => s.result.current.captureScrollPosition())
    s.layout.prepend([{ id: 'old0', h: 400 }])
    s.setRows(s.layout.rows)
    act(() => s.result.current.revealPrependedTurn('e0', 'keep'))
    const settled = s.layout.top
    // 恢复刚写完：触发翻页的那下滚轮还在拖视口，这段时间的 scroll 事件
    // 不是用户接管（否则锚点会被自己误杀，实测差 41px）。
    s.layout.box.scrollTop = settled + 120
    expect(s.result.current.isProgrammaticScroll(s.layout.box)).toBe(true)
    // 窗口关掉（用户接管 / 切会话）后回到按值判定
    act(() => s.result.current.cancelScrollSettle())
    expect(s.result.current.isProgrammaticScroll(s.layout.box)).toBe(false)
    s.layout.box.scrollTop = settled
    expect(s.result.current.isProgrammaticScroll(s.layout.box)).toBe(true)
  })

  it('ensureScrollPositionCaptured 不覆盖手势时刻的锚点', () => {
    const s = setup(ROWS(10), 900)
    const id = anchorIdOf(s.layout)
    act(() => s.result.current.captureScrollPosition())
    const before = s.layout.viewportTop(id)
    // 请求进行中视口被别的东西挪了一下：补拍不该跟着改锚点
    s.layout.box.scrollTop = 40
    act(() => s.result.current.ensureScrollPositionCaptured())
    s.layout.prepend([{ id: 'old0', h: 400 }])
    s.setRows(s.layout.rows)
    act(() => s.result.current.revealPrependedTurn('e0', 'keep'))
    expect(Math.abs(s.layout.viewportTop(id) - before)).toBeLessThan(1)
  })

  it('拍快照即关掉 stick-to-bottom（避免贴底 effect 拽回末尾）', () => {
    const s = setup(ROWS(10), 900)
    expect(s.followRef.current).toBe(true)
    act(() => s.result.current.captureScrollPosition())
    expect(s.followRef.current).toBe(false)
  })
})
