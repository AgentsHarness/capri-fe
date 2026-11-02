import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 面板级「同一时刻只允许一个请求在飞」的等待态。
 *
 * 契约：`run` 在整个面板范围内单飞，不是按 `key` 单飞——已有请求在飞时，
 * 任何 key 的调用都直接返回 `false`（被挡住，没有执行）。`key` 只用来让
 * 按钮给对应那一行转圈（`isPending(key)`），以及 `busy` 给整块操作区
 * 置灰。调用方可以据返回值区分「跑了」和「被挡了」。
 *
 * 面板级（而非按 key）是刻意的：这里的调用点都是单详情弹窗，同一时刻
 * 只有一个写入动作该发生；按 key 放开会让「设默认」与「启停」并发写
 * config.toml。需要多行各自独立的场景请另建原语，不要放宽这里的锁。
 *
 * 卸载后不再写 state（卡片被请求结果移除的场景）。
 */
export function usePendingAction() {
  const [pending, setPending] = useState<string | null>(null)
  const pendingRef = useRef<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const run = useCallback(async (key: string, fn: () => Promise<unknown>): Promise<boolean> => {
    if (pendingRef.current !== null) return false
    pendingRef.current = key
    setPending(key)
    try {
      await fn()
      return true
    } finally {
      pendingRef.current = null
      if (mountedRef.current) setPending(null)
    }
  }, [])

  const isPending = useCallback((key: string) => pending === key, [pending])

  return { pending, busy: pending !== null, isPending, run }
}
