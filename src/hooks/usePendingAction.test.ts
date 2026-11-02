import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { usePendingAction } from './usePendingAction'

function deferred() {
  let resolve!: () => void
  const p = new Promise<void>((r) => (resolve = r))
  return { p, resolve }
}

describe('usePendingAction', () => {
  it('同一 key 的重复调用被挡住：返回 false 且不执行', async () => {
    const { result } = renderHook(() => usePendingAction())
    const gate = deferred()
    const first = vi.fn(() => gate.p)
    const second = vi.fn().mockResolvedValue(undefined)

    let firstResult: Promise<boolean> | undefined
    act(() => {
      firstResult = result.current.run('toggle', first)
    })
    expect(result.current.isPending('toggle')).toBe(true)

    let blocked: boolean | undefined
    await act(async () => {
      blocked = await result.current.run('toggle', second)
    })
    expect(blocked).toBe(false)
    expect(second).not.toHaveBeenCalled()

    await act(async () => {
      gate.resolve()
      await firstResult
    })
    expect(first).toHaveBeenCalledTimes(1)
    expect(result.current.busy).toBe(false)
  })

  it('不同 key 的调用同样被挡住（面板级单飞）：返回 false，前一个不受影响', async () => {
    const { result } = renderHook(() => usePendingAction())
    const gate = deferred()
    const first = vi.fn(() => gate.p)
    const other = vi.fn().mockResolvedValue(undefined)

    let firstResult: Promise<boolean> | undefined
    act(() => {
      firstResult = result.current.run('default', first)
    })

    let blocked: boolean | undefined
    await act(async () => {
      blocked = await result.current.run('toggle', other)
    })
    expect(blocked).toBe(false)
    expect(other).not.toHaveBeenCalled()
    // 锁仍是第一个动作的，第一个动作没被打断。
    expect(result.current.isPending('default')).toBe(true)
    expect(result.current.isPending('toggle')).toBe(false)

    await act(async () => {
      gate.resolve()
      await firstResult
    })
    expect(first).toHaveBeenCalledTimes(1)
    expect(result.current.busy).toBe(false)
  })

  it('没有在飞请求时执行并返回 true；完成后可以再次执行', async () => {
    const { result } = renderHook(() => usePendingAction())
    const fn = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      await expect(result.current.run('default', fn)).resolves.toBe(true)
    })
    expect(fn).toHaveBeenCalledTimes(1)

    await act(async () => {
      await expect(result.current.run('toggle', fn)).resolves.toBe(true)
    })
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
