import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileSearchState } from '../../store/chat/typesPublic'

// chat store 用可变替身（hook 既读 selector 也读 getState/写 setState），
// transport 只给 fuzzy 三件套。
vi.mock('../../store/chat', () => ({
  useChatStore: Object.assign(vi.fn((sel?: (s: unknown) => unknown) => sel?.(fakeChat)), {
    getState: vi.fn(() => fakeChat),
    setState: vi.fn((patch: Record<string, unknown>) => {
      Object.assign(fakeChat, patch)
    }),
    subscribe: vi.fn(() => () => {}),
  }),
}))
vi.mock('../../api/client', () => ({
  transport: {
    searchFuzzyOpen: vi.fn(() => Promise.resolve({ searchId: 'sr-1', sessionId: 'agent' })),
    searchFuzzyChange: vi.fn(() => Promise.resolve({})),
    searchFuzzyClose: vi.fn(() => Promise.resolve({ closed: true })),
  },
}))

import { transport } from '../../api/client'
import type { PasteChip } from './pasteChips'
import { useAtPicker } from './useAtPicker'

const fakeChat = {
  cwd: '/ws/acp-fe',
  fileSearch: null as FileSearchState | null,
}

const mockedTransport = vi.mocked(transport)

function harness() {
  const state = { text: '' }
  const setText = vi.fn((v: string | ((t: string) => string)) => {
    state.text = typeof v === 'function' ? v(state.text) : v
  })
  const setChips = vi.fn((up: (cs: PasteChip[]) => PasteChip[]) => up([]))
  const setPendingCaret = vi.fn()
  const taRef = { current: null }
  const view = renderHook(() =>
    useAtPicker({
      get text() {
        return state.text
      },
      setText,
      setChips,
      setPendingCaret,
      taRef: taRef as never,
      composerChromeRef: { current: null } as never,
      shellMode: false,
      slashOpen: false,
    }),
  )
  /** 真 Composer 每次文本变化都重渲染（hook 在 render 时解构 text），harness 同构。 */
  const type = (text: string, caret: number) => {
    state.text = text
    view.rerender()
    act(() => view.result.current.detectAtToken(text, caret))
  }
  return { view, state, setText, setPendingCaret, type }
}

beforeEach(() => {
  fakeChat.cwd = '/ws/acp-fe'
  fakeChat.fileSearch = null
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('useAtPicker — @ 触发与 fuzzy 引擎', () => {
  it('首个 @ 只开浮层不发请求（引擎要求非空 query）', async () => {
    const { view, type } = harness()
    type('@', 1)
    expect(view.result.current.atOpen).toBe(true)
    expect(view.result.current.atQuery).toBe('')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(mockedTransport.searchFuzzyOpen).not.toHaveBeenCalled()
  })

  it('@query 防抖后开引擎会话并下发 query，root 记进 fileSearch', async () => {
    const { view, type } = harness()
    type('@sr', 3)
    expect(view.result.current.atOpen).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(mockedTransport.searchFuzzyOpen).toHaveBeenCalledWith({ cwd: '/ws/acp-fe' })
    expect(mockedTransport.searchFuzzyChange).toHaveBeenCalledWith({
      searchId: 'sr-1',
      query: 'sr',
      limit: 20,
    })
    expect(fakeChat.fileSearch).toMatchObject({
      searchId: 'sr-1',
      root: '/ws/acp-fe',
      // 快照未到 → pending，浮层画“搜索中…”而不是假的“没有匹配的文件”
      done: false,
    })
  })

  it('open 在飞时继续打字：最后一发 query 仍然下发（旧实现直接丢弃该次按键）', async () => {
    let resolveOpen: (v: { searchId: string }) => void = () => {}
    mockedTransport.searchFuzzyOpen.mockImplementationOnce(
      () => new Promise<{ searchId: string }>((r) => (resolveOpen = r)),
    )
    const { view, type } = harness()
    type('@s', 2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(mockedTransport.searchFuzzyOpen).toHaveBeenCalledTimes(1)
    // open 还没回来，用户又敲了一个字符
    type('@sr', 3)
    expect(view.result.current.atQuery).toBe('sr')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    resolveOpen({ searchId: 'sr-1' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(mockedTransport.searchFuzzyChange).toHaveBeenCalledTimes(1)
    expect(mockedTransport.searchFuzzyChange).toHaveBeenCalledWith({
      searchId: 'sr-1',
      query: 'sr',
      limit: 20,
    })
  })

  it('Enter 命中：@token 换成 @<相对路径> 并关掉浮层', async () => {
    const { view, type, setText, setPendingCaret } = harness()
    type('see @sr', 7)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    act(() => view.result.current.pickAtMatch('src/store.ts'))
    expect(setText).toHaveBeenCalledWith('see @src/store.ts ')
    expect(setPendingCaret).toHaveBeenCalledWith(18)
    expect(view.result.current.atOpen).toBe(false)
    expect(mockedTransport.searchFuzzyClose).toHaveBeenCalledWith({ searchId: 'sr-1' })
    expect(fakeChat.fileSearch).toBeNull()
  })

  it('引擎不可用（open 抛错）时浮层保持空态，下一按键可重试', async () => {
    mockedTransport.searchFuzzyOpen.mockImplementationOnce(() => Promise.reject(new Error('404')))
    const { view, type } = harness()
    type('@sr', 3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(fakeChat.fileSearch).toBeNull()
    expect(mockedTransport.searchFuzzyChange).not.toHaveBeenCalled()
    // 引擎缺席时浮层不关，只是空态（区别于「匹配不到」）
    expect(view.result.current.atOpen).toBe(true)
    // 失败的 open 不缓存：再敲一个字符会重新尝试 open
    type('@sro', 4)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(mockedTransport.searchFuzzyOpen).toHaveBeenCalledTimes(2)
    expect(mockedTransport.searchFuzzyChange).toHaveBeenCalledWith({
      searchId: 'sr-1',
      query: 'sro',
      limit: 20,
    })
  })
})
