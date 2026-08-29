import { useEffect, useRef, useState } from 'react'
import { transport } from '../../api/client'
import { findField } from '../../api/rpc/core'

/**
 * 空状态「在新 worktree 中开始」的门控探测：判断选中的工作目录是否在
 * git 仓库里。走 transport.gitRepoRoot（host /api/git/repo-root，参数只
 * 带 gitRoot、不依赖活动会话——home 时还没有会话，不能走按会话取 git
 * 信息的那条路）。
 *
 * 结果按 cwd 缓存在模块级 Map：同一目录反复进出 home / 重复 render 不
 * 重复发包；cwd 变化自动重新探测；进行中的探测统一为 checking 状态，
 * 避免「进行中→结果→进行中」式的闪烁反复显隐。
 */

export type WorktreeGateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ready'; repoRoot: string }
  | { status: 'not-repo'; reason: string }

type GateCacheEntry =
  | { status: 'checking'; promise: Promise<WorktreeGateState> }
  | { status: 'ready'; repoRoot: string }
  | { status: 'not-repo'; reason: string }

const gateCache = new Map<string, GateCacheEntry>()

export const NOT_A_GIT_REPO_TEXT = '该目录不是 git 仓库'

/** 从 gitRepoRoot 响应里取仓库根：wire 是 {gitRoot}，非仓库返回空/非对象。 */
function repoRootFrom(raw: unknown): string | undefined {
  const v = findField(raw, 'gitRoot') ?? findField(raw, 'git_root')
  return typeof v === 'string' && v.trim() ? v : undefined
}

async function probe(cwd: string): Promise<WorktreeGateState> {
  let result: WorktreeGateState
  try {
    const raw = await transport.gitRepoRoot({ cwd })
    const root = repoRootFrom(raw)
    result = root
      ? { status: 'ready', repoRoot: root }
      : { status: 'not-repo', reason: NOT_A_GIT_REPO_TEXT }
  } catch (e) {
    result = {
      status: 'not-repo',
      reason: e instanceof Error && e.message ? e.message : NOT_A_GIT_REPO_TEXT,
    }
  }
  gateCache.set(cwd, result)
  return result
}

function gateFor(c: string | undefined): WorktreeGateState {
  if (!c) return { status: 'idle' }
  const cached = gateCache.get(c)
  if (!cached) return { status: 'checking' }
  return cached.status === 'checking' ? { status: 'checking' } : cached
}

/**
 * 对 `cwd` 做 git 仓库探测。`cwd` 为空 → idle（调用方完全不渲染入口）。
 * 同一 cwd 的探测请求全局只发一次：结果缓存；进行中的请求共享同一
 * promise（并发挂载去重）。
 */
export function useWorktreeGate(cwd?: string): WorktreeGateState {
  const c = cwd?.trim()
  const [state, setState] = useState<WorktreeGateState>(() => gateFor(c))
  // 生效中的 cwd：响应回来时目录可能已换，不能把旧目录的判定渲染到
  // 新目录上（结果本身仍会缓存，下次回到该目录直接命中）。
  const cwdRef = useRef<string | undefined>(c)

  useEffect(() => {
    cwdRef.current = c
    if (!c) {
      setState({ status: 'idle' })
      return
    }
    let cancelled = false
    const apply = (r: WorktreeGateState) => {
      if (!cancelled && cwdRef.current === c) setState(r)
    }
    const cached = gateCache.get(c)
    if (cached) {
      if (cached.status === 'checking') void cached.promise.then(apply)
      return
    }
    const promise = probe(c)
    gateCache.set(c, { status: 'checking', promise })
    setState({ status: 'checking' })
    void promise.then(apply)
    return () => {
      cancelled = true
    }
  }, [c])

  // 渲染期兜底：当前 cwd 的缓存结果已就绪 → 直接采用（同一 cwd 反复
  // 进出、或探测刚完成时，不等异步 state 更新；cwd 换掉后旧判定不再
  // 命中，自动落到 checking/新结果，杜绝陈旧状态闪现）。
  if (c) {
    const cached = gateCache.get(c)
    if (cached && cached.status !== 'checking') return cached
  }
  return state
}

/** 清空探测缓存（测试用）。 */
export function resetWorktreeGateCache(): void {
  gateCache.clear()
}