import type { TransportCore } from '../transport'
import { findArrayField, unwrapExtResult, xaiCall } from './core'
import { idempotentBody, newIdempotencyKey } from '../idempotency'
import type { GitBranch, GitBranchesData, GitLogEntry, GitRepoStateData, GitStashItem } from '../types'

type HostShellResponse = {
  ok?: boolean
  exitCode?: number
  stdout?: string
  stderr?: string
  error?: string
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function runHostGitLog(
  core: TransportCore,
  opts: { cwd?: string; maxCount?: number; skip?: number; branch?: string; range?: string },
): Promise<{ ok: boolean; commits: GitLogEntry[] }> {
  const maxCount = Math.max(1, Math.min(500, Math.trunc(opts.maxCount ?? 30)))
  const skip = Math.max(0, Math.trunc(opts.skip ?? 0))
  // range（如 '@{upstream}..HEAD'）与 branch 都是 revision 参数；range 优先。
  const rev = opts.range?.trim() || opts.branch?.trim()
  const command = [
    'git',
    'log',
    `--max-count=${maxCount}`,
    `--skip=${skip}`,
    '--date=iso-strict',
    // body 是末字段，可含换行；记录以 \x1e 分隔不受影响。
    "--format='%H%x00%h%x00%an%x00%ae%x00%at%x00%P%x00%D%x00%s%x00%b%x1e'",
    ...(rev ? [shellQuote(rev)] : []),
  ].join(' ')
  const res = await core.fetch(core.url('/api/shell'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, cwd: opts.cwd, timeoutMs: 15000 }),
  })
  const data = (await res.json().catch(() => ({}))) as HostShellResponse
  if (!res.ok || data.ok === false || (data.exitCode != null && data.exitCode !== 0)) {
    throw new Error(
      data.error || data.stderr || `git log failed (${res.status || data.exitCode || 'unknown'})`,
    )
  }

  const commits = (data.stdout ?? '')
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => record.split('\x00'))
    .filter((fields) => fields.length >= 8)
    .map(([hash, shortHash, author, email, timestamp, parents, refs, message, body]) => ({
      hash,
      shortHash,
      author,
      email,
      timestamp: Number(timestamp) || 0,
      date: new Date((Number(timestamp) || 0) * 1000).toISOString(),
      message,
      parents: parents.split(/\s+/).filter(Boolean),
      ...(refs ? { refs } : {}),
      ...(body ? { body: body.replace(/\n+$/, '') } : {}),
    }))

  return { ok: true, commits }
}

async function postGitEndpoint<T>(
  core: TransportCore,
  path: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<T> {
  const res = await core.fetch(
    core.url(path),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    idempotencyKey ? { idempotencyKey } : undefined,
  )
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

  async gitInit(this: TransportCore, opts: { cwd?: string; idempotencyKey?: string } = {}): Promise<{ ok: boolean; output?: string }> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return postGitEndpoint<{ ok: boolean; output?: string }>(this, '/api/git/init', body, idempotencyKey)
  },

  async gitPush(this: TransportCore, opts: {
    cwd?: string
    remote?: string
    branch?: string
    force?: boolean
    setUpstream?: boolean
    /** 幂等键：同一次推送重试复用。 */
    idempotencyKey?: string
  } = {}): Promise<{ ok: boolean; output?: string }> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return postGitEndpoint<{ ok: boolean; output?: string }>(this, '/api/git/push', body, idempotencyKey)
  },

  async gitPull(this: TransportCore, opts: {
    cwd?: string
    remote?: string
    branch?: string
    rebase?: boolean
    /** 幂等键：同一次拉取重试复用。 */
    idempotencyKey?: string
  } = {}): Promise<{ ok: boolean; output?: string }> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return postGitEndpoint<{ ok: boolean; output?: string }>(this, '/api/git/pull', body, idempotencyKey)
  },

  async gitFetch(this: TransportCore, opts: {
    cwd?: string
    remote?: string
    prune?: boolean
    /** 幂等键：同一次 fetch 重试复用。 */
    idempotencyKey?: string
  } = {}): Promise<{ ok: boolean; output?: string }> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return postGitEndpoint<{ ok: boolean; output?: string }>(this, '/api/git/fetch', body, idempotencyKey)
  },

  async gitLog(this: TransportCore, opts: {
    cwd?: string
    maxCount?: number
    skip?: number
    /** revision 参数，如分支名（历史实现误作 pathspec，已修正）。 */
    branch?: string
    /** revision range，如 '@{upstream}..HEAD'；与 branch 同时给出时优先。 */
    range?: string
  } = {}): Promise<{ ok: boolean; commits: GitLogEntry[] }> {
    return runHostGitLog(this, opts)
  },

  /** 仓库进行中状态（merge/rebase/cherry-pick + 冲突文件），只读；非 git 目录抛错。 */
  async gitRepoState(this: TransportCore, opts: { cwd?: string } = {}): Promise<GitRepoStateData> {
    const res = await this.fetch(this.url('/api/git/state'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: opts.cwd }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      error?: string
      state?: GitRepoStateData
    }
    if (!res.ok || data.ok === false || !data.state) {
      throw new Error(data.error || `/api/git/state failed (${res.status})`)
    }
    return data.state
  },

  async gitStashList(this: TransportCore, opts: { cwd?: string } = {}): Promise<{ ok: boolean; stashes: GitStashItem[] }> {
    return postGitEndpoint<{ ok: boolean; stashes: GitStashItem[] }>(this, '/api/git/stash/list', opts)
  },

  async gitStashPop(this: TransportCore, opts: { cwd?: string; index?: string; idempotencyKey?: string } = {}): Promise<{ ok: boolean; output?: string }> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return postGitEndpoint<{ ok: boolean; output?: string }>(this, '/api/git/stash/pop', body, idempotencyKey)
  },

  async gitStashDrop(this: TransportCore, opts: { cwd?: string; index?: string; idempotencyKey?: string } = {}): Promise<{ ok: boolean; output?: string }> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return postGitEndpoint<{ ok: boolean; output?: string }>(this, '/api/git/stash/drop', body, idempotencyKey)
  },

  async gitBranchCreate(this: TransportCore, opts: {
    cwd?: string
    branch: string
    checkout?: boolean
    /** 幂等键：同一次建分支重试复用。 */
    idempotencyKey?: string
  }): Promise<{ ok: boolean; output?: string }> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return postGitEndpoint<{ ok: boolean; output?: string }>(this, '/api/git/branch/create', body, idempotencyKey)
  },

  async gitBranchDelete(this: TransportCore, opts: {
    cwd?: string
    branch: string
    force?: boolean
    /** 幂等键：同一次删分支重试复用。 */
    idempotencyKey?: string
  }): Promise<{ ok: boolean; output?: string }> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return postGitEndpoint<{ ok: boolean; output?: string }>(this, '/api/git/branch/delete', body, idempotencyKey)
  },

  async gitStage(this: TransportCore, opts: { cwd?: string; paths?: string[]; idempotencyKey?: string }): Promise<unknown> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return unwrapExtResult(await xaiCall(this, '/api/git/stage', body, { idempotencyKey }))
  },

  async gitUnstage(this: TransportCore, opts: { cwd?: string; paths?: string[]; idempotencyKey?: string }): Promise<unknown> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return unwrapExtResult(await xaiCall(this, '/api/git/unstage', body, { idempotencyKey }))
  },

  async gitDiscard(this: TransportCore, opts: {
    cwd?: string
    paths?: string[]
    includeUntracked?: boolean
    /** 幂等键：同一次丢弃重试复用。 */
    idempotencyKey?: string
  }): Promise<unknown> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return unwrapExtResult(await xaiCall(this, '/api/git/discard', body, { idempotencyKey }))
  },

  async gitCommit(this: TransportCore, opts: {
    cwd?: string
    message: string
    amend?: boolean
    signoff?: boolean
    push?: boolean
    /** 幂等键：同一次提交重试复用。 */
    idempotencyKey?: string
  }): Promise<unknown> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return unwrapExtResult(await xaiCall(this, '/api/git/commit', body, { idempotencyKey }))
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

  async gitCheckout(this: TransportCore, opts: { cwd?: string; branch: string; create?: boolean; idempotencyKey?: string }): Promise<unknown> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return unwrapExtResult(await xaiCall(this, '/api/git/checkout', body, { idempotencyKey }))
  },

  async gitCheckoutCommit(this: TransportCore, opts: {
    cwd?: string
    commit: string
    stashIfDirty?: boolean
    /** 幂等键：同一次 checkout 重试复用。 */
    idempotencyKey?: string
  }): Promise<unknown> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return unwrapExtResult(await xaiCall(this, '/api/git/checkout-commit', body, { idempotencyKey }))
  },

  async gitCheckoutSessionHead(this: TransportCore, opts: {
    cwd?: string
    stashIfDirty?: boolean
    /** 幂等键：同一次 checkout 重试复用。 */
    idempotencyKey?: string
  }): Promise<unknown> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return unwrapExtResult(await xaiCall(this, '/api/git/checkout-session-head', body, { idempotencyKey }))
  },

  async gitStash(this: TransportCore, opts: { cwd?: string; includeUntracked?: boolean; idempotencyKey?: string } = {}): Promise<unknown> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return unwrapExtResult(await xaiCall(this, '/api/git/stash', body, { idempotencyKey }))
  },

  async gitCurrentCommit(this: TransportCore, opts: { cwd?: string } = {}): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/current-commit', opts))
  },

  async gitRepoRoot(this: TransportCore, opts: { cwd?: string } = {}): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/repo-root', opts))
  },

  async gitStageContent(this: TransportCore, opts: { cwd?: string; path: string; content: string; idempotencyKey?: string }): Promise<unknown> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return unwrapExtResult(await xaiCall(this, '/api/git/stage-content', body, { idempotencyKey }))
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
    /** 幂等键：同一次建 worktree 重试复用。 */
    idempotencyKey?: string
  }): Promise<unknown> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return unwrapExtResult(await xaiCall(this, '/api/git/worktree/create', body, { idempotencyKey }))
  },

  async gitWorktreeRemove(this: TransportCore, opts: {
    worktreePath?: string
    idOrPath?: string
    force?: boolean
    dryRun?: boolean
    /** 幂等键：同一次删除重试复用。 */
    idempotencyKey?: string
  }): Promise<unknown> {
    const { idempotencyKey, ...params } = opts
    const body: Record<string, unknown> = {
      ...(params.worktreePath ? { worktreePath: params.worktreePath } : {}),
      ...(params.idOrPath ? { idOrPath: params.idOrPath } : {}),
      ...(params.force !== undefined ? { force: params.force } : {}),
      ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
    }
    return unwrapExtResult(
      await xaiCall(this, '/api/git/worktree/remove', body, {
        idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
      }),
    )
  },

  async gitWorktreeApply(this: TransportCore, opts: { worktreePath: string; mode?: string; idempotencyKey?: string }): Promise<unknown> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return unwrapExtResult(await xaiCall(this, '/api/git/worktree/apply', body, { idempotencyKey }))
  },

  async gitWorktreeCreateFromWorktree(this: TransportCore, opts: {
    sourceWorktreePath: string
    newSessionId: string
    copyMode?: string
    gitRef?: string
    worktreeType?: string
    label?: string
    /** 幂等键：同一次建 worktree 重试复用。 */
    idempotencyKey?: string
  }): Promise<unknown> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return unwrapExtResult(await xaiCall(this, '/api/git/worktree/create-from-worktree', body, { idempotencyKey }))
  },

  async gitWorktreeCreateFromWorktreeSync(this: TransportCore, opts: {
    sourceWorktreePath: string
    newSessionId: string
    copyMode?: string
    gitRef?: string
    worktreeType?: string
    label?: string
    /** 幂等键：同一次建 worktree 重试复用。 */
    idempotencyKey?: string
  }): Promise<unknown> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return unwrapExtResult(await xaiCall(this, '/api/git/worktree/create-from-worktree-sync', body, { idempotencyKey }))
  },

  async gitWorktreeResumeSession(this: TransportCore, opts: {
    sourceCwd: string
    copyMode?: string
    worktreeType?: string
    restoreCode?: boolean
    gitRef?: string
    /** 幂等键：同一次恢复重试复用。 */
    idempotencyKey?: string
  }): Promise<unknown> {
    const { body, idempotencyKey } = idempotentBody(opts)
    return unwrapExtResult(await xaiCall(this, '/api/git/worktree/resume-session', body, { idempotencyKey }))
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

  async gitWorktreeGc(this: TransportCore, opts: { dryRun?: boolean; maxAge?: string; force?: boolean; idempotencyKey?: string } = {}): Promise<unknown> {
    const { idempotencyKey, ...params } = opts
    const body: Record<string, unknown> = {}
    if (params.dryRun !== undefined) body.dryRun = params.dryRun
    if (params.maxAge) body.maxAge = params.maxAge
    if (params.force !== undefined) body.force = params.force
    return unwrapExtResult(
      await xaiCall(this, '/api/git/worktree/gc', body, {
        idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
      }),
    )
  },

  async gitWorktreeDbStats(this: TransportCore): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/worktree/db/stats', {}))
  },

  async gitWorktreeDbRebuild(this: TransportCore, idempotencyKey?: string): Promise<unknown> {
    return unwrapExtResult(
      await xaiCall(this, '/api/git/worktree/db/rebuild', {}, {
        idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
      }),
    )
  },

  async gitWorktreeDbPath(this: TransportCore): Promise<unknown> {
    return unwrapExtResult(await xaiCall(this, '/api/git/worktree/db/path', {}))
  }
}
