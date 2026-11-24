import { describe, expect, it } from 'vitest'

/**
 * RPC mutation 的静态覆盖检查（v3 relay 幂等）。
 *
 * 目标不是跑实现，而是守住「新增写操作必须带 Idempotency-Key」：每个
 * `/api/...` 端点字面量都必须被显式归类；归类为 mutation 的端点，其
 * POST 调用点必须在调用窗口里传 `idempotencyKey`。只读 POST / hub 管理
 * 端点进白名单——它们不经 host relay（或大响应不该进幂等缓存）。
 *
 * 归类是刻意的：新增端点没归类会让本文件变红，逼着作者想清楚它的语义。
 */

/** 只读 POST：不发键（避免把会话/历史/列表这类大响应写进幂等缓存）。 */
const READ_ONLY = new Set([
  '/api/billing',
  '/api/btw',
  '/api/commands-list',
  '/api/custom-models',
  '/api/fs/read-file',
  '/api/git-info',
  '/api/git/branches',
  '/api/git/current-commit',
  '/api/git/diffs',
  '/api/git/files',
  '/api/git/repo-root',
  '/api/git/stash/list',
  '/api/git/state',
  '/api/git/status',
  '/api/git/worktree/db/path',
  '/api/git/worktree/db/stats',
  '/api/git/worktree/list',
  '/api/git/worktree/show',
  '/api/goal/status',
  '/api/hooks/list',
  '/api/local/dirs',
  '/api/marketplace/list',
  '/api/mcp/auth-status',
  '/api/mcp/list',
  '/api/mcp/read-resource',
  '/api/memory-list',
  '/api/model-filters',
  '/api/plugins/list',
  '/api/prompt-history',
  '/api/queue/status',
  '/api/rewind-points',
  '/api/search/content',
  '/api/search/fuzzy/change',
  '/api/search/fuzzy/close',
  '/api/search/fuzzy/open',
  '/api/session-info',
  '/api/session-load-history',
  '/api/session-plan',
  '/api/session-resolve-worktree-resume',
  '/api/session-running-tasks',
  '/api/session-state',
  '/api/session-stats',
  '/api/session-summaries/session-list',
  '/api/session-summaries/workspace-list',
  '/api/session-summaries/workspace-list-recent',
  '/api/session-updates',
  '/api/session/info',
  '/api/session/search',
  '/api/session/usage',
  '/api/sessions',
  '/api/sessions/list',
  '/api/stats',
  // 唯一调用是 git log（宿主 shell 适配器），不是用户命令执行。
  '/api/shell',
  '/api/skills/config',
  '/api/skills/list',
  '/api/subagent/get',
  '/api/subagent/list-running',
  '/api/suggest',
  '/api/suggest-prompt',
  '/api/task-list',
  '/api/task-output',
  '/api/terminal/output',
  '/api/terminal/wait-for-exit',
  '/api/usage-report',
  '/api/workflows/list',
  '/api/workspaces/list',
])

/** hub 管理端点：不经 host relay，host 的幂等中间件看不到这些请求。 */
const HUB_ONLY = new Set([
  '/api/guest-tokens/create',
  '/api/guest-tokens/delete',
  '/api/guest-tokens/refresh',
  '/api/guest-tokens/sessions/add',
  '/api/guest-tokens/sessions/remove',
  '/api/guest-tokens/update',
  '/api/me/token',
  '/api/users/create',
  '/api/users/delete',
  '/api/users/reset',
])

/** GET / 非 POST 端点（出现在这里只是为了归类完整）。 */
const NON_POST = new Set(['/api/extensions', '/api/status'])

/** 写操作：POST 调用点必须带 idempotencyKey。 */
const MUTATIONS = new Set([
  '/api/agent-restart',
  '/api/agents/default',
  '/api/agents/toggle',
  '/api/cancel',
  '/api/client-response',
  '/api/compact',
  '/api/custom-model',
  '/api/custom-model-delete',
  '/api/git/branch/create',
  '/api/git/branch/delete',
  '/api/git/checkout',
  '/api/git/checkout-commit',
  '/api/git/checkout-session-head',
  '/api/git/commit',
  '/api/git/discard',
  '/api/git/fetch',
  '/api/git/init',
  '/api/git/pull',
  '/api/git/push',
  '/api/git/stage',
  '/api/git/stage-content',
  '/api/git/stash',
  '/api/git/stash/drop',
  '/api/git/stash/pop',
  '/api/git/unstage',
  '/api/git/worktree/apply',
  '/api/git/worktree/create',
  '/api/git/worktree/create-from-worktree',
  '/api/git/worktree/create-from-worktree-sync',
  '/api/git/worktree/db/rebuild',
  '/api/git/worktree/gc',
  '/api/git/worktree/remove',
  '/api/git/worktree/resume-session',
  '/api/goal/clear',
  '/api/goal/pause',
  '/api/goal/resume',
  '/api/goal/set',
  '/api/hooks/action',
  '/api/interject',
  '/api/local/mkdir',
  '/api/marketplace/action',
  '/api/mcp-add',
  '/api/mcp-auth-trigger',
  '/api/mcp-remove',
  '/api/mcp-toggle',
  '/api/mcp/call',
  '/api/mcp/setup',
  '/api/mcp/toggle-tool',
  '/api/memory-dream',
  '/api/memory-flush',
  '/api/memory-forget',
  '/api/memory-rewrite',
  '/api/memory-toggle',
  '/api/permission-response',
  '/api/permissions-reset',
  '/api/personas',
  '/api/personas/delete',
  '/api/plugins/action',
  '/api/plugins/notify-updates',
  '/api/plugins/reload',
  '/api/prompt',
  '/api/queue/clear',
  '/api/queue/edit',
  '/api/queue/hold-edit',
  '/api/queue/interject',
  '/api/queue/release-edit',
  '/api/queue/remove',
  '/api/queue/reorder',
  '/api/recap',
  '/api/rewind-execute',
  '/api/scheduler-delete',
  '/api/session',
  '/api/session-add-local-workspace',
  '/api/session-close',
  '/api/session-delete',
  '/api/session-fork',
  '/api/session-import',
  '/api/session-load',
  '/api/session-rehydrate',
  '/api/session-rename',
  '/api/session-repair',
  '/api/session-resume',
  '/api/session-update-mcp-servers',
  '/api/session/share',
  '/api/set-default-model',
  '/api/set-mode',
  '/api/set-model',
  '/api/set-model-filters',
  '/api/settings',
  '/api/skills/add',
  '/api/skills/refresh-baseline',
  '/api/skills/remove',
  '/api/skills/reset',
  '/api/skills/toggle',
  '/api/subagent-cancel',
  '/api/subagent/message',
  '/api/task-kill',
  '/api/terminal/background',
  '/api/terminal/create',
  '/api/terminal/release',
  '/api/toggle-plan-mode',
])

const KNOWN = new Set([...READ_ONLY, ...HUB_ONLY, ...NON_POST, ...MUTATIONS])

/**
 * 源码按原文读入（Vite `?raw`）：本测试只做静态扫描，不执行被扫模块。
 * `./*.ts` 覆盖 rpc 目录，另加传输层的 localFs（目录创建入口）。
 */
const SOURCES = Object.entries(
  import.meta.glob(['./*.ts', '../localFs.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>,
).filter(
  ([file]) =>
    !file.endsWith('.test.ts') &&
    !file.endsWith('/core.ts') &&
    !file.endsWith('/mixins.ts'),
)

/** 端点字面量到调用窗口（到本方法后的第一个空行，防跨方法误判）。 */
function callWindow(src: string, at: number): string {
  const blank = src.indexOf('\n\n', at)
  const end = blank === -1 || blank > at + 900 ? at + 900 : blank
  return src.slice(at, end)
}

/** 这个字面量是否处在一个 POST 调用里（直接 fetch 或 POST-only helper）。 */
function isPostCallSite(src: string, at: number): boolean {
  const before = src.slice(Math.max(0, at - 200), at)
  const helperRe =
    /\b(?:xaiCall|postGitEndpoint|postJsonRpc|postJson|postLocalFs)\s*(?:<[^()]*>)?\(/g
  // 取离字面量最近的那个 helper：窗口里可能还含上一个已闭合的调用。
  let helper: RegExpExecArray | null = null
  for (const m of before.matchAll(helperRe)) helper = m
  if (helper) {
    // helper 名与字面量之间不能已经闭合（否则是上一个调用）。
    const tail = before.slice((helper.index ?? 0) + helper[0].length)
    if (!tail.includes(')')) return true
  }
  return /method:\s*'POST'/.test(callWindow(src, at))
}

type Occurrence = { file: string; path: string; at: number; window: string; post: boolean }

const occurrences: Occurrence[] = []
for (const [file, src] of SOURCES) {
  for (const m of src.matchAll(/['"](\/api\/[^'"]+)['"]/g)) {
    const path = m[1].split('?')[0] ?? ''
    const at = m.index ?? 0
    occurrences.push({ file, path, at, window: callWindow(src, at), post: isPostCallSite(src, at) })
  }
}

describe('RPC mutation 幂等键静态覆盖', () => {
  it('每个端点字面量都已归类（新增 mutation 必须进 MUTATIONS 并带键）', () => {
    const unknown = occurrences
      .filter((o) => !KNOWN.has(o.path))
      .map((o) => `${o.file}: ${o.path}`)
    expect(unknown).toEqual([])
  })

  it('归类里的每个端点都仍被代码引用（删端点时同步清名单）', () => {
    const seen = new Set(occurrences.map((o) => o.path))
    expect([...KNOWN].filter((p) => !seen.has(p))).toEqual([])
  })

  it('每个 mutation 的 POST 调用点都传了 idempotencyKey', () => {
    const missing = occurrences
      .filter((o) => o.post && MUTATIONS.has(o.path) && !o.window.includes('idempotencyKey'))
      .map((o) => `${o.file}: ${o.path}`)
    expect(missing).toEqual([])
  })

  it('每个 mutation 至少有一个带键的 POST 调用点', () => {
    const keyed = new Set(
      occurrences
        .filter((o) => o.post && MUTATIONS.has(o.path) && o.window.includes('idempotencyKey'))
        .map((o) => o.path),
    )
    expect([...MUTATIONS].filter((p) => !keyed.has(p))).toEqual([])
  })

  it('只读 / hub 端点不发幂等键', () => {
    const keyed = occurrences
      .filter(
        (o) => (READ_ONLY.has(o.path) || HUB_ONLY.has(o.path)) && o.window.includes('idempotencyKey'),
      )
      .map((o) => `${o.file}: ${o.path}`)
    expect(keyed).toEqual([])
  })
})
