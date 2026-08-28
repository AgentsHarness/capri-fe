import { describe, expect, it } from 'vitest'
import { useChatStore } from './store'
import { atTokenAt } from '../../lib/atToken'
import { sessionsRpc } from '../../api/rpc/sessions'
import type { TransportCore } from '../../api/transport'

describe('search_fuzzy_status → store.fileSearch（@ 文件选择器引擎流）', () => {
  it('解析 matches 快照并更新 done/total', () => {
    const st = useChatStore.getState()
    useChatStore.setState({
      fileSearch: { searchId: 's-1', matches: [], done: true },
    })
    st.handleEvent({
      type: 'search_fuzzy_status',
      params: {
        searchId: 's-1',
        matches: [
          { path: 'src/components/Composer.tsx', score: 12, matchedIndices: [0, 4, 9] },
          { path: 'src/App.tsx' },
          { path: 42 }, // 非法条目被丢弃
          null,
        ],
        total: 3,
        done: false,
        generation: 2,
      },
    } as never)
    const fs = useChatStore.getState().fileSearch
    expect(fs).not.toBeNull()
    expect(fs?.searchId).toBe('s-1')
    expect(fs?.matches).toEqual([
      {
        path: 'src/components/Composer.tsx',
        score: 12,
        matchedIndices: [0, 4, 9],
      },
      { path: 'src/App.tsx' },
    ])
    expect(fs?.done).toBe(false)
    expect(fs?.total).toBe(3)
  })

  it('非当前 searchId（陈旧会话）被丢弃', () => {
    const st = useChatStore.getState()
    useChatStore.setState({
      fileSearch: { searchId: 's-live', matches: [], done: true },
    })
    st.handleEvent({
      type: 'search_fuzzy_status',
      params: { searchId: 's-stale', matches: [{ path: 'x.ts' }], done: true },
    } as never)
    expect(useChatStore.getState().fileSearch?.matches).toEqual([])
  })

  it('选择器关闭（fileSearch null）时事件被丢弃且不报错', () => {
    const st = useChatStore.getState()
    useChatStore.setState({ fileSearch: null })
    expect(() =>
      st.handleEvent({
        type: 'search_fuzzy_status',
        params: { searchId: 's-1', matches: [{ path: 'x.ts' }], done: true },
      } as never),
    ).not.toThrow()
    expect(useChatStore.getState().fileSearch).toBeNull()
  })
})

describe('atTokenAt（@ token 检测）', () => {
  it('文本起始与空白后的 @ 触发，query 为 token 剩余部分', () => {
    expect(atTokenAt('@Com', 4)).toEqual({ start: 0, query: 'Com' })
    expect(atTokenAt('hello @src/fe', 13)).toEqual({ start: 6, query: 'src/fe' })
    expect(atTokenAt('@', 1)).toEqual({ start: 0, query: '' })
  })

  it('邮件式 @（前面是单词字符）不触发', () => {
    expect(atTokenAt('mail me at foo@bar', 18)).toBeNull()
  })

  it('caret 不在 token 上（中间有空白）不触发', () => {
    expect(atTokenAt('@ab cd', 6)).toBeNull()
    expect(atTokenAt('', 0)).toBeNull()
  })
})

describe('sessionSearch 窗口钳制（agent 硬校验 limit 1..=100 / offset ≤1000）', () => {
  it('越界参数被收敛到合法窗口', async () => {
    let captured: Record<string, unknown> | undefined
    const fakeCore = {
      url: (p: string) => `http://host${p}`,
      fetch: async (_u: string, init?: RequestInit) => {
        captured = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({ ok: true, result: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    } as unknown as TransportCore
    await sessionsRpc.sessionSearch.call(
      fakeCore,
      { query: 'q', limit: 500, offset: 5000 } as never,
    )
    expect(captured?.limit).toBe(100)
    expect(captured?.offset).toBe(1000)
    await sessionsRpc.sessionSearch.call(
      fakeCore,
      { query: 'q', limit: 0, offset: -3 } as never,
    )
    expect(captured?.limit).toBe(1)
    expect(captured?.offset).toBe(0)
  })
})
