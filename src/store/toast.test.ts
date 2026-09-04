import { beforeEach, describe, expect, it } from 'vitest'
import { dismissToast, inferToastType, pushToast, useToastStore } from './toast'

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

  it('支持通过对象参数指定 id 与 type', () => {
    pushToast('操作失败', { id: 'err-1', type: 'error' })
    expect(useToastStore.getState().toasts).toEqual([
      { id: 'err-1', text: '操作失败', type: 'error' },
    ])
  })

  it('支持通过第三个参数指定 type', () => {
    pushToast('操作成功', 'suc-1', 'success')
    expect(useToastStore.getState().toasts).toEqual([
      { id: 'suc-1', text: '操作成功', type: 'success' },
    ])
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

  it('inferToastType 智能推断文本对应类型', () => {
    expect(inferToastType('修改 Host 失败: 连接超时')).toBe('error')
    expect(inferToastType('复制失败，请手动选择复制')).toBe('error')
    expect(inferToastType('请先开始或恢复一个会话，再切换模型')).toBe('warning')
    expect(inferToastType('正在切换会话，请稍候再发送')).toBe('warning')
    expect(inferToastType('🔔 需要审批：bash')).toBe('info')
    expect(inferToastType('配对码已复制')).toBe('success')
    expect(inferToastType('普通状态描述')).toBe('info')
  })
})
