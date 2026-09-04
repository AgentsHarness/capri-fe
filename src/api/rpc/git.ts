import type { TransportCore } from '../transport'
import { findArrayField, unwrapExtResult, xaiCall } from './core'
import type { GitBranch, GitBranchesData, GitLogEntry, GitStashItem } from '../types'

async function postGitEndpoint<T>(core: TransportCore, path: string, body: Record<string, unknown>): Promise<T> {
  const res = await core.fetch(core.url(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as T & { ok?: boolean; error?: string }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `${path} failed (${res.status})`)
  }
  return data
}

export const gitRpc = {
  async gitInfo(this: TransportCore, 
    sessionId: string,
    cwd: string,
  ): Promise<{ branch?: string; isWorktree?: boolean; mainRepo?: string }> {
    return postGitEndpoint<{ branch?: string; isWorktree?: boolean; mainRepo?: string }>(this, '/api/git-info', {
      sessionId,
      cwd,
    })
  },

  async gitStatus(this: TransportCore, 
    opts: { cwd?: string; includeUntracked?: boolean } = {},
  ): Promise<import('../types').GitStatusData> {
    return unwrapExtResult<import('../types').GitStatusData>(
      await xaiCall(this, '/api/git/status', opts),
    )
  },

  async gitDiffs(this: TransportCore, opts: {
    cwd?: string
    from: string
    to: string
    paths?: string[]
    includePatch?: boolean
  }): Promise<import('../types').GitDiffsData> {
    return unwrapExtResult<import('../types').GitDiffsData>(
      await xaiCall(this, '/api/git/diffs', opts),
    )
  },

  async gitPush(this: TransportCore, opts: {
    cwd?: string
    remote?: string
    branch?: string
    force?: boolean
    setUpstream?: boolean
  } = {}): Promise<{ ok: boolean; output?: string }> {
    return postGitEndpoint<{ ok: boolean; output?: string }>(this, '/api/git/push', opts)
  },

  async gitPull(this: TransportCore, opts: {
    cwd?: string
    remote?: string
    branch?: string
    rebase?: boolean
  } = {}): Promise<{ ok: boolean; output?: string }> {
    return postGitEndpoint<{ ok: boolean; output?: string }>(this, '/api/git/pull', opts)
  },

  async gitFetch(this: TransportCore, opts: {
    cwd?: string
    remote?: string
    prune?: boolean
  } = {}): Promise<{ ok: boolean; output?: string }> {
    return postGitEndpoint<{ ok: boolean; output?: string }>(this, '/api/git/fetch', opts)
  },

  async gitLog(this: TransportCore, opts: {
    cwd?: string
    maxCount?: number
    skip?: number
    branch?: string
  } = {}): Promise<{ ok: boolean; commits: GitLogEntry[] }> {
    return postGitEndpoint<{ ok: boolean; commits: GitLogEntry[] }>(this, '/api/git/log', opts)
  },

  async gitStashList(this: TransportCore, opts: { cwd?: string } = {}): Promise<{ ok: boolean; stashes: GitStashItem[] }> {
    return postGitEndpoint<{ ok: boolean; stashes: GitStashItem[] }>(this, '/api/git/stash/list', opts)
  },

  async gitStashPop(this: TransportCore, opts: { cwd?: string; index?: string } = {}): Promise<{ ok: boolean; output?: string }> {
    return postGitEndpoint<{ ok: boolean; output?: string }>(this, '/api/git/stash/pop', opts)
  },

  async gitStashDrop(this: TransportCore, opts: { cwd?: string; index?: string } = {}): Promise<{ ok: boolean; output?: string }> {
    return postGitEndpoint<{ ok: boolean; output?: string }>(this, '/api/git/stash/drop', opts)
  },

  async gitBranchCreate(this: TransportCore, opts: {
    cwd?: string
    branch: string
    checkout?: boolean
  }): Promise<{ ok: boolean; output?: string }> {
    return postGitEndpoint<{ ok: boolean; output?: string }>(this, '/api/git/branch/create', opts)
  },

  async gitBranchDelete(this: TransportCore, opts: {
    cwd?: string
    branch: string
    force?: boolean
  }): Promise<{ ok: boolean; output?: string }> {
    return postGitEndpoint<{ ok: boolean; output?: string }>(this, '/api/git/branch/delete', opts)
  },

  async gitStage(this: TransportCore, opts: { cwd?: string; paths?: string[] }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/stage', opts))
  },

  async gitUnstage(this: TransportCore, opts: { cwd?: string; paths?: string[] }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/unstage', opts))
  },

  async gitDiscard(this: TransportCore, opts: {
    cwd?: string
    paths?: string[]
    includeUntracked?: boolean
  }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/discard', opts))
  },

  async gitCommit(this: TransportCore, opts: {
    cwd?: string
    message: string
    amend?: boolean
    signoff?: boolean
    push?: boolean
  }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/commit', opts))
  },

  async gitFiles(this: TransportCore, opts: {
    cwd?: string
    paths: string[]
    version?: string
  }): Promise<import('../types').GitReadFilesData> {
    return unwrapExtResult<import('../types').GitReadFilesData>(
      await xaiCall(this, '/api/git/files', opts),
    )
  },

  async gitBranches(this: TransportCore, opts: { cwd?: string } = {}): Promise<GitBranchesData> {
    const raw = unwrapExtResult<unknown>(await xaiCall(this, '/api/git/branches', opts))
    const branches: GitBranch[] = (findArrayField(raw, 'branches') as Record<string, unknown>[])
      .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
      .map((b) => ({
        name: typeof b.name === 'string' ? b.name : '',
        ...(typeof b.current === 'boolean' ? { current: b.current } : {}),
        ...(typeof b.upstream === 'string' && b.upstream ? { upstream: b.upstream } : {}),
        ...(typeof b.commit === 'string' && b.commit ? { commit: b.commit } : {}),
      }))
      .filter((b) => b.name)
    // wire 同时带 repoRoot（非 git 目录时缺省）——home 的 worktree 门控
    // 拿它当 gitRepoRoot 不可用时的兜底探针。
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const repoRoot = typeof o.repoRoot === 'string' && o.repoRoot ? o.repoRoot : undefined
    return repoRoot ? { branches, repoRoot } : { branches }
  },

  async gitCheckout(this: TransportCore, opts: { cwd?: string; branch: string; create?: boolean }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/checkout', opts))
  },

  async gitCheckoutCommit(this: TransportCore, opts: {
    cwd?: string
    commit: string
    stashIfDirty?: boolean
  }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/checkout-commit', opts))
  },

  async gitCheckoutSessionHead(this: TransportCore, opts: {
    cwd?: string
    stashIfDirty?: boolean
  }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/checkout-session-head', opts))
  },

  async gitStash(this: TransportCore, opts: { cwd?: string; includeUntracked?: boolean } = {}): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/stash', opts))
  },

  async gitCurrentCommit(this: TransportCore, opts: { cwd?: string } = {}): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/current-commit', opts))
  },

  async gitRepoRoot(this: TransportCore, opts: { cwd?: string } = {}): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/repo-root', opts))
  },

  async gitStageContent(this: TransportCore, opts: { cwd?: string; path: string; content: string }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/stage-content', opts))
  },

  async gitWorktreeCreate(this: TransportCore, opts: {
    sourcePath: string
    worktreePath?: string
    copyMode?: string
    gitRef?: string
    copyIgnoredInBackground?: boolean
    ignoredSkipPatterns?: string[]
    worktreeType?: string
    label?: string
  }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/worktree/create', opts))
  },

  async gitWorktreeRemove(this: TransportCore, opts: {
    worktreePath?: string
    idOrPath?: string
    force?: boolean
    dryRun?: boolean
  }): Promise<unknown> {
    const body: Record<string, unknown> = {
      ...(opts.worktreePath ? { worktreePath: opts.worktreePath } : {}),
      ...(opts.idOrPath ? { idOrPath: opts.idOrPath } : {}),
      ...(opts.force !== undefined ? { force: opts.force } : {}),
      ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
    }
    return unwrapExtResult(await xaiCall(this, '/api/git/worktree/remove', body))
  },

  async gitWorktreeApply(this: TransportCore, opts: { worktreePath: string; mode?: string }): Promise<unknown> {
    const body: Record<string, unknown> = { worktreePath: opts.worktreePath }
    if (opts.mode) body.mode = opts.mode
    return unwrapExtResult(await xaiCall(this, '/api/git/worktree/apply', body))
  },

  async gitWorktreeCreateFromWorktree(this: TransportCore, opts: {
    sourceWorktreePath: string
    newSessionId: string
    copyMode?: string
    gitRef?: string
    worktreeType?: string
    label?: string
  }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/worktree/create-from-worktree', opts))
  },

  async gitWorktreeCreateFromWorktreeSync(this: TransportCore, opts: {
    sourceWorktreePath: string
    newSessionId: string
    copyMode?: string
    gitRef?: string
    worktreeType?: string
    label?: string
  }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/worktree/create-from-worktree-sync', opts))
  },

  async gitWorktreeResumeSession(this: TransportCore, opts: {
    sourceCwd: string
    copyMode?: string
    worktreeType?: string
    restoreCode?: boolean
    gitRef?: string
  }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/worktree/resume-session', opts))
  },

  async gitWorktreeList(this: TransportCore, opts: {
    repo?: string
    type?: string[]
    includeAll?: boolean
  } = {}): Promise<unknown> {
    const body: Record<string, unknown> = {}
    if (opts.repo) body.repo = opts.repo
    if (opts.type && opts.type.length > 0) body.type = opts.type
    if (opts.includeAll === true) body.includeAll = true
    return unwrapExtResult(await xaiCall(this, '/api/git/worktree/list', body))
  },

  async gitWorktreeShow(this: TransportCore, opts: { idOrPath: string }): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/worktree/show', opts))
  },

  async gitWorktreeGc(this: TransportCore, opts: { dryRun?: boolean; maxAge?: string; force?: boolean } = {}): Promise<unknown> {
    const body: Record<string, unknown> = {}
    if (opts.dryRun !== undefined) body.dryRun = opts.dryRun
    if (opts.maxAge) body.maxAge = opts.maxAge
    if (opts.force !== undefined) body.force = opts.force
    return unwrapExtResult(await xaiCall(this, '/api/git/worktree/gc', body))
  },

  async gitWorktreeDbStats(this: TransportCore): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/worktree/db/stats', {}))
  },

  async gitWorktreeDbRebuild(this: TransportCore): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/worktree/db/rebuild', {}))
  },

  async gitWorktreeDbPath(this: TransportCore): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/worktree/db/path', {}))
  }
}
