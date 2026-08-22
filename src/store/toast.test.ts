import { beforeEach, describe, expect, it } from 'vitest'
import { dismissToast, pushToast, useToastStore } from './toast'

beforeEach(() => {
  useToastStore.setState({ toasts: [] })
})

describe('toast store', () => {
  it('push 追加并返回可用的 id', () => {
    const id = pushToast('hello')
    expect(id).toBeTruthy()
    expect(useToastStore.getState().toasts).toEqual([{ id, text: 'hello' }])
  })

  it('支持调用方指定 id（之后可定点清除）', () => {
    pushToast('a', 'fixed-id')
    expect(useToastStore.getState().toasts[0]?.id).toBe('fixed-id')
    dismissToast('fixed-id')
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('最多保留 4 条，旧的先被挤掉', () => {
    for (let i = 0; i < 6; i++) pushToast(`t${i}`)
    const toasts = useToastStore.getState().toasts
    expect(toasts.map((t) => t.text)).toEqual(['t2', 't3', 't4', 't5'])
  })

  it('dismissToast 只移除目标行', () => {
    const a = pushToast('a')
    const b = pushToast('b')
    dismissToast(a)
    expect(useToastStore.getState().toasts.map((t) => t.id)).toEqual([b])
  })

  it('dismiss 不存在的 id 是 no-op', () => {
    pushToast('keep')
    dismissToast('nope')
    expect(useToastStore.getState().toasts).toHaveLength(1)
  })
})
