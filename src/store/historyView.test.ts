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

  it('setMode 更新并持久化', () => {
    useHistoryView.getState().setMode('marked')
    expect(useHistoryView.getState().mode).toBe('marked')
    expect(window.localStorage.getItem('capri-fe.historyView')).toBe(JSON.stringify({ mode: 'marked' }))
  })

  it('脏 localStorage 值 → 回退 workspace', async () => {
    window.localStorage.setItem('capri-fe.historyView', JSON.stringify({ mode: 'bogus' }))
    expect((await freshStore()).getState().mode).toBe('workspace')
  })

  it('marked 值被正确读取', async () => {
    window.localStorage.setItem('capri-fe.historyView', JSON.stringify({ mode: 'marked' }))
    expect((await freshStore()).getState().mode).toBe('marked')
  })
})