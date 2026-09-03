import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ScrollEntry } from '../api/types'
import { useChatStore } from '../store/chat'
import { selectableRowIds } from '../store/chat/turn'
import { clearEscArm, escArmTimestamp, useScrollbackKeys } from './useScrollbackKeys'

/**
 * useScrollbackKeys 键位测试（TUI 对齐：defaults.rs / nav.rs /
 * router.rs / prompt.rs try_handle_esc_policy）。jsdom 没有排版：滚动
 * 容器与行 rect 手搓一维假布局，行 top 随 scrollTop 平移。
 */

const user = (id: string): ScrollEntry =>
  ({ id, kind: 'user', text: `prompt ${id}` }) as ScrollEntry
const assistant = (id: string): ScrollEntry =>
  ({ id, kind: 'assistant', text: `reply ${id}` }) as ScrollEntry
/** read 工具（折叠态）——相邻两条会被 scanGroups 聚成 verb 组。 */
const readTool = (id: string): ScrollEntry =>
  ({
    id,
    kind: 'tool',
    toolCallId: `call_${id}`,
    title: `Read /a/${id}.ts`,
    kindName: 'read_file',
    verb: 'Read',
    status: 'completed',
    expanded: false,
  }) as ScrollEntry

type RowSpec = { id: string; top: number; height: number }

function makeBox(
  rows: RowSpec[],
  viewH: number,
  contentH: number,
): { box: HTMLElement; scrollBy: ReturnType<typeof vi.fn> } {
  const box = document.createElement('div')
  box.setAttribute('data-scrollback-box', '')
  let st = 0
  const clamp = (v: number) => Math.max(0, Math.min(v, contentH - viewH))
  Object.defineProperty(box, 'scrollTop', {
    configurable: true,
    get: () => st,
    set: (v: number) => {
      st = clamp(v)
    },
  })
  Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => viewH })
  Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => contentH })
  const rect = (top: number, height: number): DOMRect =>
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
  // 视口矩形的 top 固定（滚动的是内容不是容器）；行 top 随 scrollTop 平移。
  box.getBoundingClientRect = () => rect(0, viewH)
  for (const r of rows) {
    const el = document.createElement('div')
    el.setAttribute('data-entry-id', r.id)
    el.getBoundingClientRect = () => rect(r.top - st, r.height)
    box.appendChild(el)
  }
  const scrollBy = vi.fn((opts?: { top?: number }) => {
    st = clamp(st + (opts?.top ?? 0))
  })
  box.scrollBy = scrollBy as unknown as typeof box.scrollBy
  document.body.appendChild(box)
  return { box, scrollBy }
}

function key(k: string, init: Partial<KeyboardEventInit> = {}): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))
  })
}

// 被测试替换过的 store action 在这里恢复（action 引用建店时确定）。
const realActions = {
  cancelTurn: useChatStore.getState().cancelTurn,
  requestCancelTurn: useChatStore.getState().requestCancelTurn,
  clearComposerDraft: useChatStore.getState().clearComposerDraft,
  openViewer: useChatStore.getState().openViewer,
}

const realGCS = window.getComputedStyle

describe('useScrollbackKeys', () => {
  beforeEach(() => {
    clearEscArm()
    useChatStore.setState({
      entries: [],
      expandedGroups: new Set<string>(),
      selectedId: null,
      focusMode: 'scrollback',
      conn: 'ready',
      composerDraftLen: 0,
      rewindOpen: false,
      viewerEntryId: null,
      viewerTask: undefined,
      xaiRequests: [],
      cancelPanelOpen: false,
      cancelTurn: realActions.cancelTurn,
      requestCancelTurn: realActions.requestCancelTurn,
      clearComposerDraft: realActions.clearComposerDraft,
      openViewer: realActions.openViewer,
    })
    window.getComputedStyle = realGCS
  })

  afterEach(() => {
    window.getComputedStyle = realGCS
    document.body.innerHTML = ''
  })

  describe('Ctrl+J / Ctrl+K — 1 行滚动（TUI defaults.rs ScrollDown/ScrollUp）', () => {
    it('行高可解析 → 恰好滚 1 行', () => {
      const { box } = makeBox(
        [
          { id: 'u1', top: 0, height: 100 },
          { id: 'u2', top: 100, height: 100 },
        ],
        250,
        300,
      )
      window.getComputedStyle = (() =>
        ({ lineHeight: '24px' }) as unknown as CSSStyleDeclaration) as typeof window.getComputedStyle
      renderHook(() => useScrollbackKeys())
      key('j', { ctrlKey: true })
      expect(box.scrollBy).toHaveBeenCalledWith({ top: 24 })
      key('k', { ctrlKey: true })
      expect(box.scrollBy).toHaveBeenCalledWith({ top: -24 })
    })

    it('line-height 读不到（normal → NaN）→ 回退 22px', () => {
      const { box } = makeBox(
        [{ id: 'u1', top: 0, height: 100 }],
        250,
        300,
      )
      window.getComputedStyle = (() =>
        ({}) as unknown as CSSStyleDeclaration) as typeof window.getComputedStyle
      renderHook(() => useScrollbackKeys())
      key('j', { ctrlKey: true })
      expect(box.scrollBy).toHaveBeenCalledWith({ top: 22 })
    })
  })

  describe('g / G — 首/末可选条目（TUI nav.rs goto_top/goto_bottom）', () => {
    it('g → 滚到顶并选中第一个可选行', () => {
      const { box } = makeBox([], 250, 300)
      useChatStore.setState({
        entries: [user('u1'), assistant('a1'), user('u2')],
        selectedId: 'u2',
      })
      renderHook(() => useScrollbackKeys())
      key('g')
      expect(box.scrollTop).toBe(0)
      expect(useChatStore.getState().selectedId).toBe('u1')
    })

    it('G → 滚到底并选中最后一个可选行', () => {
      const { box } = makeBox([], 250, 300)
      useChatStore.setState({
        entries: [user('u1'), assistant('a1'), user('u2')],
        selectedId: 'u1',
      })
      renderHook(() => useScrollbackKeys())
      key('G')
      // 代码写入 scrollHeight，容器钳到 max（contentH-viewH=50）——与
      // 浏览器行为一致。
      expect(box.scrollTop).toBe(50)
      expect(useChatStore.getState().selectedId).toBe('u2')
    })
  })

  describe('PgUp / PgDn — 选中视口边缘可选行（TUI nav.rs select_viewport_edge）', () => {
    it('PgDn → 滚页后选中视口下边缘的可见可选行', () => {
      const { box } = makeBox(
        [
          { id: 'u1', top: 0, height: 100 },
          { id: 'a1', top: 100, height: 100 },
          { id: 'u2', top: 200, height: 100 },
        ],
        250,
        300,
      )
      useChatStore.setState({ entries: [user('u1'), assistant('a1'), user('u2')] })
      renderHook(() => useScrollbackKeys())
      key('PageDown')
      // 滚 0.9×250=225，钳到最大 50；视口 [50, 300)，下边缘行是 u2。
      expect(box.scrollTop).toBe(50)
      expect(useChatStore.getState().selectedId).toBe('u2')
    })

    it('PgUp → 滚页后选中视口上边缘的可见可选行', () => {
      const { box } = makeBox(
        [
          { id: 'u1', top: 0, height: 100 },
          { id: 'a1', top: 100, height: 100 },
          { id: 'u2', top: 200, height: 100 },
        ],
        250,
        300,
      )
      useChatStore.setState({ entries: [user('u1'), assistant('a1'), user('u2')] })
      renderHook(() => useScrollbackKeys())
      act(() => {
        box.scrollTop = 50
      })
      key('PageUp')
      expect(box.scrollTop).toBe(0)
      expect(useChatStore.getState().selectedId).toBe('u1')
    })

    it('边缘行不在可选集中 → 向视口内侧行走', () => {
      makeBox(
        [
          { id: 'u1', top: 0, height: 100 },
          { id: 'u2', top: 100, height: 100 },
          // 不在 entries 里的 DOM 行（等价不可选行）压在下边缘。
          { id: 'ghost', top: 200, height: 100 },
        ],
        250,
        300,
      )
      useChatStore.setState({ entries: [user('u1'), user('u2')] })
      renderHook(() => useScrollbackKeys())
      key('PageDown')
      expect(useChatStore.getState().selectedId).toBe('u2')
    })
  })

  describe('Enter — 组头先切组（TUI router.rs OpenBlockViewer）', () => {
    it('选中 gh_ 组头时 Enter 切换组展开，不 openViewer', () => {
      renderHook(() => useScrollbackKeys())
      const openViewer = vi.fn()
      useChatStore.setState({
        entries: [readTool('t1'), readTool('t2')],
        openViewer,
      })
      const rows = selectableRowIds(
        useChatStore.getState().entries,
        useChatStore.getState().expandedGroups,
      )
      const gh = rows.find((id) => id.startsWith('gh_'))
      expect(gh).toBeTruthy()
      useChatStore.getState().selectEntry(gh!)
      key('Enter')
      const st = useChatStore.getState()
      expect(openViewer).not.toHaveBeenCalled()
      expect(st.expandedGroups.has(gh!.slice(3))).toBe(true)
      expect(st.selectedId).toBe(gh)
    })

    it('普通条目 Enter 仍 openViewer', () => {
      renderHook(() => useScrollbackKeys())
      const openViewer = vi.fn()
      useChatStore.setState({ entries: [user('u1')], selectedId: 'u1', openViewer })
      key('Enter')
      expect(openViewer).toHaveBeenCalledWith()
    })
  })

  describe('Esc — 2×Esc 打开回退（TUI prompt.rs try_handle_esc_policy）', () => {
    it('首个 idle Esc 臂定并把焦点交回 prompt', () => {
      renderHook(() => useScrollbackKeys())
      key('Escape')
      const st = useChatStore.getState()
      expect(st.focusMode).toBe('prompt')
      expect(st.rewindOpen).toBe(false)
      expect(escArmTimestamp()).toBeGreaterThan(0)
    })

    it('TTL 内第二击（焦点仍在 scrollback 的兜底路径）→ openRewind', () => {
      renderHook(() => useScrollbackKeys())
      key('Escape')
      // 焦点已切回 prompt——真实链路的第二击落在 composer（Composer 经
      // escArmTimestamp() 判定）；这里把 focusMode 拉回 scrollback，覆盖
      // composer 缺席时本 hook 的兜底分支。
      useChatStore.setState({ focusMode: 'scrollback' })
      key('Escape')
      const st = useChatStore.getState()
      expect(st.rewindOpen).toBe(true)
      expect(escArmTimestamp()).toBe(0)
    })

    it('非 Esc 键解除臂定 → 之后的首个 Esc 回到原行为', () => {
      useChatStore.setState({
        entries: [user('u1')],
        selectedId: 'u1',
      })
      renderHook(() => useScrollbackKeys())
      key('Escape')
      expect(escArmTimestamp()).toBeGreaterThan(0)
      key('j') // 任意非 Esc 键
      expect(escArmTimestamp()).toBe(0)
      key('Escape')
      expect(useChatStore.getState().rewindOpen).toBe(false)
      expect(useChatStore.getState().focusMode).toBe('prompt')
    })

    it('busy Esc 不走阶梯，仍直接进取消流程', () => {
      renderHook(() => useScrollbackKeys())
      const requestCancelTurn = vi.fn()
      useChatStore.setState({ conn: 'busy', requestCancelTurn })
      key('Escape')
      expect(requestCancelTurn).toHaveBeenCalledWith()
      expect(useChatStore.getState().focusMode).toBe('scrollback')
      expect(escArmTimestamp()).toBe(0)
    })
  })

  describe('Ctrl+C — 选区复制优先（TUI 复制优先）', () => {
    it('页面有非空选区 → 不清草稿、不取消（交给浏览器复制）', () => {
      renderHook(() => useScrollbackKeys())
      const clearComposerDraft = vi.fn()
      const cancelTurn = vi.fn()
      useChatStore.setState({
        composerDraftLen: 5,
        clearComposerDraft,
        cancelTurn,
      })
      const target = document.createElement('div')
      target.textContent = 'selected scrollback text'
      document.body.appendChild(target)
      const range = document.createRange()
      range.selectNodeContents(target)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      key('c', { ctrlKey: true })
      expect(clearComposerDraft).not.toHaveBeenCalled()
      expect(cancelTurn).not.toHaveBeenCalled()
      sel?.removeAllRanges()
    })

    it('无选区 → 非空草稿仍先被清除（原行为）', () => {
      renderHook(() => useScrollbackKeys())
      const clearComposerDraft = vi.fn()
      useChatStore.setState({ composerDraftLen: 5, clearComposerDraft })
      key('c', { ctrlKey: true })
      expect(clearComposerDraft).toHaveBeenCalledWith()
    })

    it('无选区 + 空草稿 + busy → 取消回合（原行为）', () => {
      renderHook(() => useScrollbackKeys())
      const cancelTurn = vi.fn()
      useChatStore.setState({ conn: 'busy', cancelTurn })
      key('c', { ctrlKey: true })
      expect(cancelTurn).toHaveBeenCalledWith({})
    })
  })
})
