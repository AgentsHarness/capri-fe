import {
  ArrowDown,
  Check,
  CircleHelp,
  ArrowUp,
  GitBranch as GitBranchIcon,
  GitPullRequest,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react'
import { transport } from '../../../api/client'
import type { GitBranch, GitStatusData, GitStashItem } from '../../../api/types'
import { Spinner } from '../../ui/Spinner'
import { CONFIRM_WINDOW_MS, formatGitDate } from '../../../lib/gitPanel'

type GitSyncTabProps = {
  status?: GitStatusData
  branches: GitBranch[]
  branchesError?: string
  branchFilter: string
  setBranchFilter: (value: string) => void
  branchesLoading: boolean
  newBranchName: string
  setNewBranchName: (value: string) => void
  newBranchCheckout: boolean
  setNewBranchCheckout: (value: boolean) => void
  filteredBranches: GitBranch[]
  armedCheckout: { branch: string; at: number } | null
  onCheckoutClick: (branch: GitBranch) => void
  refreshBranches: () => Promise<void>
  refreshStashes: () => Promise<void>
  stashes: GitStashItem[]
  stashLoading: boolean
  armedDropStash: { index: number; at: number } | null
  setArmedDropStash: (value: { index: number; at: number } | null) => void
  busy: boolean
  busyOp?: string
  cwd: string | undefined
  runOp: (label: string, fn: () => Promise<unknown>) => Promise<boolean>
  spin: (op: string, size?: number) => React.ReactNode
}

/** 「分支与同步」tab：远程同步按钮、分支列表与新建/切换/删除、stash 箱。 */
export function GitSyncTab({
  status,
  branches,
  branchesError,
  branchFilter,
  setBranchFilter,
  branchesLoading,
  newBranchName,
  setNewBranchName,
  newBranchCheckout,
  setNewBranchCheckout,
  filteredBranches,
  armedCheckout,
  onCheckoutClick,
  refreshBranches,
  refreshStashes,
  stashes,
  stashLoading,
  armedDropStash,
  setArmedDropStash,
  busy,
  busyOp,
  cwd,
  runOp,
  spin,
}: GitSyncTabProps) {
  return (
              <div className="gn-no-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 sm:p-4">
                <div className="flex shrink-0 flex-col gap-2.5 rounded-lg border border-gn-prompt-border bg-gn-bg-base/60 px-3 py-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:px-3.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <UploadCloud size={16} className="shrink-0 text-gn-cyan" />
                    <span className="text-[13px] font-medium text-gn-fg">远程仓库同步</span>
                    <span className="ml-1 flex min-w-0 items-center gap-1 font-mono text-[11px] text-gn-muted">
                      {status?.ahead ? (
                        <span className="flex shrink-0 items-center gap-0.5">
                          领先 <ArrowUp size={10} aria-hidden /> {status.ahead}
                        </span>
                      ) : (
                        '已是最新'
                      )}
                      {status?.behind ? (
                        <span className="flex shrink-0 items-center gap-0.5">
                          {'· 落后'} <ArrowDown size={10} aria-hidden /> {status.behind}
                        </span>
                      ) : null}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 sm:flex sm:items-center">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        runOp('fetch', async () => {
                          await transport.gitFetch?.({ cwd })
                        })
                      }
                      className="flex min-h-8 items-center justify-center gap-1 rounded border border-gn-prompt-border bg-gn-bg-base px-2 py-1.5 text-[11.5px] text-gn-fg hover:bg-gn-bg-highlight disabled:opacity-40 sm:min-h-0 sm:px-2.5 sm:py-1"
                    >
                      {busyOp === 'fetch' ? <Spinner size={11} /> : <RefreshCw size={11} />}
                      Fetch
                      <span className="hidden sm:inline"> (拉取状态)</span>
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        runOp('pull', async () => {
                          await transport.gitPull?.({ cwd })
                        })
                      }
                      className="flex min-h-8 items-center justify-center gap-1 rounded border border-gn-prompt-border bg-gn-bg-base px-2 py-1.5 text-[11.5px] text-gn-fg hover:bg-gn-bg-highlight disabled:opacity-40 sm:min-h-0 sm:px-2.5 sm:py-1"
                    >
                      {busyOp === 'pull' ? <Spinner size={11} /> : <ArrowDown size={11} />}
                      Pull
                      <span className="hidden sm:inline"> (拉取并合并)</span>
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        runOp('push', async () => {
                          await transport.gitPush?.({ cwd })
                        })
                      }
                      className="flex min-h-8 items-center justify-center gap-1 rounded border border-gn-green/40 bg-gn-green/20 px-2 py-1.5 text-[11.5px] font-medium text-gn-green hover:bg-gn-green/30 disabled:opacity-40 sm:min-h-0 sm:px-3 sm:py-1"
                    >
                      {busyOp === 'push' ? <Spinner size={11} /> : <ArrowUp size={11} />}
                      Push
                      <span className="hidden sm:inline"> (推送到远程)</span>
                    </button>
                  </div>
                </div>

                <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex min-h-0 flex-col rounded-lg border border-gn-prompt-border bg-gn-bg-base/60 p-3">
                    <div className="flex shrink-0 items-center justify-between border-b border-gn-prompt-border/40 pb-2">
                      <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-gn-fg">
                        <GitBranchIcon size={15} className="text-gn-yellow" /> 分支 · {branches.length}
                      </span>
                    </div>
                    {branchesError && (
                      <div className="mt-1.5 text-[10.5px] leading-snug text-gn-red">{branchesError}</div>
                    )}

                    <div className="relative mt-2.5 shrink-0">
                      <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gn-muted" />
                      <input
                        type="search"
                        value={branchFilter}
                        onChange={(e) => setBranchFilter(e.target.value)}
                        placeholder="筛选分支"
                        aria-label="筛选分支"
                        className="h-8 w-full rounded border border-gn-prompt-border bg-gn-bg-dark pl-7 pr-7 text-[11.5px] text-gn-fg outline-none focus:border-gn-cyan/60 sm:h-7"
                      />
                      {branchFilter && (
                        <button
                          type="button"
                          onClick={() => setBranchFilter('')}
                          aria-label="清除分支筛选"
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-gn-muted hover:text-gn-fg"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>

                    <div className="mt-2.5 flex shrink-0 flex-col gap-1.5 sm:flex-row sm:items-center">
                      <input
                        type="text"
                        value={newBranchName}
                        onChange={(e) => setNewBranchName(e.target.value)}
                        placeholder="新分支名称"
                        className="h-8 w-full min-w-0 rounded border border-gn-prompt-border bg-gn-bg-dark px-2 text-[11.5px] text-gn-fg outline-none focus:border-gn-green/60 sm:h-7 sm:w-auto sm:flex-1"
                      />
                      <div className="flex items-center gap-1.5">
                        <label className="flex shrink-0 cursor-pointer select-none items-center gap-1 text-[11px] text-gn-muted">
                          <input
                            type="checkbox"
                            checked={newBranchCheckout}
                            onChange={(e) => setNewBranchCheckout(e.target.checked)}
                            className="accent-gn-green"
                          />
                          切换
                        </label>
                        <button
                          type="button"
                          disabled={!newBranchName.trim() || busy}
                          onClick={() => {
                            const name = newBranchName.trim()
                            void runOp(`创建分支 ${name}`, async () => {
                              await transport.gitBranchCreate?.({
                                cwd,
                                branch: name,
                                checkout: newBranchCheckout,
                              })
                              setNewBranchName('')
                              await refreshBranches()
                            })
                          }}
                          className="flex h-8 shrink-0 items-center gap-1 rounded bg-gn-bg-highlight px-2.5 text-[11.5px] text-gn-fg hover:bg-gn-prompt-border disabled:opacity-40 sm:h-7"
                        >
                          {spin('创建分支') ?? <Plus size={12} />} 新建
                        </button>
                      </div>
                    </div>

                    <div className="gn-no-scrollbar mt-2.5 min-h-[140px] max-h-[360px] flex-1 space-y-0.5 overflow-y-auto sm:max-h-none">
                      {branchesLoading && branches.length === 0 && (
                        <div className="py-4 text-center text-[11px] text-gn-muted">加载中…</div>
                      )}
                      {!branchesLoading && branches.length === 0 && !branchesError && (
                        <div className="py-4 text-center text-[11px] text-gn-muted">无分支信息</div>
                      )}
                      {!branchesLoading && branches.length > 0 && filteredBranches.length === 0 && (
                        <div className="py-4 text-center text-[11px] text-gn-muted">没有匹配的分支</div>
                      )}
                      {filteredBranches.map((b) => {
                        const armed = armedCheckout?.branch === b.name
                        return (
                          <div
                            key={b.name}
                            className="group flex items-center justify-between rounded px-2 py-1.5 transition-colors hover:bg-gn-bg-highlight/50 sm:py-1"
                          >
                            <button
                              type="button"
                              disabled={busy || b.current === true}
                              onClick={() => onCheckoutClick(b)}
                              className={`flex min-w-0 flex-1 items-center gap-1.5 text-left font-mono text-[12px] sm:text-[11.5px] ${
                                b.current ? 'font-medium text-gn-green' : 'text-gn-fg2 hover:text-gn-fg'
                              }`}
                            >
                              <span className="flex w-3.5 shrink-0 items-center justify-center">
                                {b.current ? (
                                  <Check size={11} className="text-gn-green" aria-hidden />
                                ) : armed ? (
                                  <CircleHelp size={11} className="text-gn-yellow" aria-hidden />
                                ) : (
                                  <GitBranchIcon size={11} aria-hidden />
                                )}
                              </span>
                              <span className="truncate">{b.name}</span>
                              {b.upstream && (
                                <span className="ml-1 truncate text-[10px] text-gn-muted">({b.upstream})</span>
                              )}
                            </button>
                            {!b.current && (
                              <div className="flex shrink-0 items-center gap-1">
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => onCheckoutClick(b)}
                                  className={`shrink-0 rounded border px-2 py-1 text-[10.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                                    armed
                                      ? 'border-gn-cyan/60 bg-gn-cyan/15 text-gn-cyan'
                                      : 'border-gn-prompt-border bg-gn-bg-base text-gn-fg hover:bg-gn-bg-highlight'
                                  }`}
                                  title={armed ? '再点一次确认切换' : '切换到此分支'}
                                >
                                  {spin('checkout', 10) ?? (armed ? '确认' : '切换')}
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => {
                                    void runOp(`删除分支 ${b.name}`, async () => {
                                      await transport.gitBranchDelete?.({ cwd, branch: b.name, force: true })
                                      await refreshBranches()
                                    })
                                  }}
                                  className="p-1.5 text-gn-muted transition-colors hover:text-gn-red sm:p-1"
                                  title="删除此分支"
                                >
                                  {spin('删除分支', 12) ?? <Trash2 size={12} />}
                                </button>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  <div className="flex min-h-0 flex-col rounded-lg border border-gn-prompt-border bg-gn-bg-base/60 p-3">
                    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-gn-prompt-border/40 pb-2">
                      <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-gn-fg">
                        <GitPullRequest size={15} className="text-gn-muted" /> Stash 暂存箱
                        <span className="font-mono text-[10.5px] font-normal text-gn-muted">({stashes.length})</span>
                      </span>
                    </div>

                    <div className="gn-no-scrollbar mt-2.5 min-h-[140px] max-h-[360px] flex-1 space-y-1 overflow-y-auto sm:max-h-none">
                      {stashLoading ? (
                        <div className="py-4 text-center text-[11px] text-gn-muted">加载中…</div>
                      ) : stashes.length === 0 ? (
                        <div className="py-4 text-center text-[11px] text-gn-muted">暂存箱为空</div>
                      ) : (
                        stashes.map((s) => {
                          const armedDrop = armedDropStash?.index === s.index
                          return (
                            <div
                              key={s.ref}
                              className="flex flex-col gap-1.5 rounded border border-gn-prompt-border/30 bg-gn-bg-dark/40 px-2 py-1.5 text-[11px] sm:flex-row sm:items-center sm:justify-between sm:gap-0 sm:py-1"
                            >
                              <div className="min-w-0 flex-1 truncate font-mono">
                                <span className="mr-1.5 text-gn-cyan">{s.ref}</span>
                                <span className="text-gn-fg">{s.message}</span>
                                <span className="ml-1.5 text-[10px] text-gn-muted" title={s.date}>({formatGitDate(s.date)})</span>
                              </div>
                              <div className="ml-0 flex shrink-0 items-center gap-1 sm:ml-1.5">
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() =>
                                    runOp(`应用 ${s.ref}`, async () => {
                                      await transport.gitStashPop?.({ cwd, index: s.ref })
                                      await refreshStashes()
                                    })
                                  }
                                  className="inline-flex items-center gap-1 rounded bg-gn-green/10 px-2 py-1 text-[10px] text-gn-green hover:bg-gn-green/20 sm:px-1.5 sm:py-0.5"
                                >
                                  {spin('应用', 10)}
                                  Pop
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => {
                                    if (
                                      armedDropStash?.index === s.index &&
                                      Date.now() - armedDropStash.at < CONFIRM_WINDOW_MS
                                    ) {
                                      setArmedDropStash(null)
                                      void runOp(`删除 ${s.ref}`, async () => {
                                        await transport.gitStashDrop?.({ cwd, index: s.ref })
                                        await refreshStashes()
                                      })
                                    } else {
                                      setArmedDropStash({ index: s.index, at: Date.now() })
                                    }
                                  }}
                                  className={`rounded px-2 py-1 text-[10px] sm:px-1.5 sm:py-0.5 ${
                                    armedDrop
                                      ? 'bg-gn-diff-del-bg font-medium text-gn-red'
                                      : 'text-gn-muted hover:text-gn-red'
                                  }`}
                                >
                                  {armedDrop ? '确认？' : 'Drop'}
                                </button>
                              </div>
                            </div>
                          )
                        })
                      )}
                    </div>
                  </div>
                </div>
              </div>  )
}
