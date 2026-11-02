import { describe, expect, it, vi } from 'vitest'
import { createRefreshGate } from './refreshGate'

/** 一个可手动放行的挂起 promise。 */
function deferred() {
  let resolve!: () => void
  const p = new Promise<void>((r) => (resolve = r))
  return { p, resolve }
}

describe('createRefreshGate', () => {
  it('首次调用立即执行（挂载首屏不被节流拖慢）', async () => {
    const gate = createRefreshGate(400)
    const run = vi.fn().mockResolvedValue(undefined)
    await gate(run)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('在飞期间的并发调用各自排队执行一次，互不吞掉（mutation 的刷新不能被顶掉）', async () => {
    const gate = createRefreshGate(0)
    const first = deferred()
    const calls: string[] = []
    const p1 = gate(async () => {
      calls.push('first')
      await first.p
    })
    const second = vi.fn(async () => {
      calls.push('second')
    })
    const p2 = gate(second)
    const third = vi.fn(async () => {
      calls.push('third')
    })
    const p3 = gate(third)
    expect(calls).toEqual(['first'])

    first.resolve()
    await Promise.all([p1, p2, p3])
    // 每个调用方的闭包都跑了且只跑一次；顺序按入队顺序。
    expect(calls).toEqual(['first', 'second', 'third'])
    expect(second).toHaveBeenCalledTimes(1)
    expect(third).toHaveBeenCalledTimes(1)
  })

  it('两个并发调用各自在自己的闭包跑完后才 resolve', async () => {
    const gate = createRefreshGate(0)
    const first = deferred()
    const finished: string[] = []
    const p1 = gate(async () => {
      await first.p
    }).then(() => finished.push('first'))
    const secondRun = deferred()
    const p2 = gate(async () => {
      await secondRun.p
    }).then(() => finished.push('second'))

    first.resolve()
    await p1
    // 第一个已收尾，第二个的闭包已开始但还挂着 → 它的 promise 不能提前 resolve。
    expect(finished).toEqual(['first'])
    secondRun.resolve()
    await p2
    expect(finished).toEqual(['first', 'second'])
  })

  it('间隔内的呼叫做尾部合并：一次窗口只发一个请求', async () => {
    vi.useFakeTimers()
    try {
      const gate = createRefreshGate(400)
      const run = vi.fn().mockResolvedValue(undefined)
      await gate(run)
      expect(run).toHaveBeenCalledTimes(1)

      const trailing = vi.fn().mockResolvedValue(undefined)
      void gate(trailing)
      void gate(trailing)
      expect(trailing).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(400)
      expect(trailing).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('immediate 跳过节流窗口（用户点刷新要立刻发）', async () => {
    vi.useFakeTimers()
    try {
      const gate = createRefreshGate(400)
      await gate(vi.fn().mockResolvedValue(undefined))
      const clicked = vi.fn().mockResolvedValue(undefined)
      void gate(clicked, { immediate: true })
      // 不等 400ms 窗口
      await Promise.resolve()
      expect(clicked).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('在飞期间的 immediate 插到已排队调用之前', async () => {
    const gate = createRefreshGate(0)
    const blocker = deferred()
    const calls: string[] = []
    const p1 = gate(async () => {
      calls.push('first')
      await blocker.p
    })
    const trailing = vi.fn(async () => {
      calls.push('trailing')
    })
    const pTrailing = gate(trailing)
    const clicked = vi.fn(async () => {
      calls.push('clicked')
    })
    const pClicked = gate(clicked, { immediate: true })

    blocker.resolve()
    await Promise.all([p1, pClicked, pTrailing])
    // 用户点击先于（在飞期间排队的）尾随刷新执行。
    expect(calls).toEqual(['first', 'clicked', 'trailing'])
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(trailing).toHaveBeenCalledTimes(1)
  })

  it('mutation 的刷新在同一窗口内到达第二个调用时不会被丢弃', async () => {
    const gate = createRefreshGate(0)
    const blocker = deferred()
    const mutation = vi.fn(async () => {})
    const pMutation = gate(async () => {
      await blocker.p
    })
    const pOther = gate(mutation)
    blocker.resolve()
    await Promise.all([pMutation, pOther])
    expect(mutation).toHaveBeenCalledTimes(1)
  })

  it('请求失败不会堵住后续刷新', async () => {
    const gate = createRefreshGate(0)
    await gate(() => Promise.reject(new Error('boom')))
    const ok = vi.fn().mockResolvedValue(undefined)
    await gate(ok)
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('reset 丢掉节流历史：新 host 的首轮立刻发出', async () => {
    vi.useFakeTimers()
    try {
      const gate = createRefreshGate(400)
      await gate(vi.fn().mockResolvedValue(undefined))
      const next = vi.fn().mockResolvedValue(undefined)
      gate.reset()
      await gate(next)
      expect(next).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reset 丢掉已排队的尾随刷新（那是上一台 host 的闭包）', async () => {
    vi.useFakeTimers()
    try {
      const gate = createRefreshGate(400)
      await gate(vi.fn().mockResolvedValue(undefined))
      const stale = vi.fn().mockResolvedValue(undefined)
      void gate(stale)
      gate.reset()
      await vi.advanceTimersByTimeAsync(1000)
      // 旧闭包捕获的是旧 host 的 async scope，跑它只会被整批丢弃。
      expect(stale).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reset 期间在飞的请求收尾后不执行 reset 之前排队的闭包', async () => {
    const gate = createRefreshGate(0)
    const blocker = deferred()
    const calls: string[] = []
    const pFirst = gate(async () => {
      calls.push('first')
      await blocker.p
    })
    const stale = vi.fn(async () => {
      calls.push('stale')
    })
    const pStale = gate(stale)
    // 旧 host 的请求还在飞、旧闭包已排队，此时切 host。
    gate.reset()
    const fresh = vi.fn(async () => {
      calls.push('fresh')
    })
    const pFresh = gate(fresh)

    blocker.resolve()
    await Promise.all([pFirst, pStale, pFresh])
    // 旧代际的排队闭包不跑，但 waiter 不会被挂住；新 host 的刷新照常执行。
    expect(calls).toEqual(['first', 'fresh'])
    expect(stale).not.toHaveBeenCalled()
    expect(fresh).toHaveBeenCalledTimes(1)
  })
})
