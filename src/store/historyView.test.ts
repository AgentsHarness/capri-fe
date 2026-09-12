import { describe, expect, it } from 'vitest'
import { useHistoryView } from './historyView'

/** 用递增 query 参数强制 vitest 建新模块实例，重跑模块级 load()。 */
let freshSeq = 0
async function freshStore() {
  const mod = await import(`./historyView?fresh${++freshSeq}`)
  return mod.useHistoryView
}

describe('useHistoryView', () => {
  it('默认 workspace 模式', () => {
    expect(useHistoryView.getState().mode).toBe('workspace')
  })

  it('默认钉住顺序', () => {
    expect(useHistoryView.getState().orderMode).toBe('frozen')
  })

  it('setMode 更新并持久化', () => {
    useHistoryView.getState().setMode('marked')
    expect(useHistoryView.getState().mode).toBe('marked')
    expect(
      JSON.parse(window.localStorage.getItem('capri-fe.historyView') ?? '{}'),
    ).toEqual({ mode: 'marked', orderMode: 'frozen' })
  })

  it('setOrderMode 不冲掉已存的视图形态', () => {
    useHistoryView.getState().setMode('marked')
    useHistoryView.getState().setOrderMode('active')
    expect(useHistoryView.getState().mode).toBe('marked')
    expect(useHistoryView.getState().orderMode).toBe('active')
    expect(
      JSON.parse(window.localStorage.getItem('capri-fe.historyView') ?? '{}'),
    ).toEqual({ mode: 'marked', orderMode: 'active' })
  })

  it('脏 localStorage 值 → 回退 workspace', async () => {
    window.localStorage.setItem('capri-fe.historyView', JSON.stringify({ mode: 'bogus' }))
    expect((await freshStore()).getState().mode).toBe('workspace')
  })

  it('marked 值被正确读取', async () => {
    window.localStorage.setItem('capri-fe.historyView', JSON.stringify({ mode: 'marked' }))
    expect((await freshStore()).getState().mode).toBe('marked')
  })

  it('缺 orderMode 的旧存档 → 回退 frozen，认 active', async () => {
    window.localStorage.setItem('capri-fe.historyView', JSON.stringify({ mode: 'marked' }))
    expect((await freshStore()).getState().orderMode).toBe('frozen')
    window.localStorage.setItem(
      'capri-fe.historyView',
      JSON.stringify({ mode: 'workspace', orderMode: 'active' }),
    )
    const fresh = await freshStore()
    expect(fresh.getState().orderMode).toBe('active')
  })
})