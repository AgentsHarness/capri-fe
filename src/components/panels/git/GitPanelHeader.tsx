import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  GitBranch as GitBranchIcon,
  RefreshCw,
  X,
} from 'lucide-react'
import type { GitLogEntry, GitStatusData } from '../../../api/types'
import type { ActiveTab } from '../../../lib/gitPanel'

type GitPanelHeaderProps = {
  onClose: () => void
  notRepo: boolean
  branch?: string | null
  status?: GitStatusData
  headCommit?: GitLogEntry
  copiedHeadHash: boolean
  setCopiedHeadHash: (copied: boolean) => void
  stagedCount: number
  modifiedCount: number
  untrackedCount: number
  rowCount: number
  busyOp?: string
  loading: boolean
  busy: boolean
  activeTab: ActiveTab
  setActiveTab: (tab: ActiveTab) => void
  refresh: () => Promise<void>
  refreshBranches: () => Promise<void>
  refreshLog: () => Promise<void>
  refreshStashes: () => Promise<void>
  showUnpushed: boolean
  toggleUnpushed: () => void
  unpushed?: {
    loading: boolean
    commits?: GitLogEntry[]
    error?: string
  }
}

/** Git 面板顶栏：分支读数、HEAD 锚点、刷新/关闭与未推送提交展开条。 */
export function GitPanelHeader({
  onClose,
  notRepo,
  branch,
  status,
  headCommit,
  copiedHeadHash,
  setCopiedHeadHash,
  stagedCount,
  modifiedCount,
  untrackedCount,
  rowCount,
  busyOp,
  loading,
  busy,
  activeTab,
  setActiveTab,
  refresh,
  refreshBranches,
  refreshLog,
  refreshStashes,
  showUnpushed,
  toggleUnpushed,
  unpushed,
}: GitPanelHeaderProps) {
  return (
    <>
        <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-gn-prompt-border bg-gn-bg-base px-3 py-1.5 sm:px-4">
          <span className="text-[14px] font-bold text-gn-fg">git</span>

          {!notRepo && branch ? (
            <div className="flex min-w-0 items-center gap-1">
              <button
                type="button"
                onClick={() => setActiveTab('sync')}
                aria-label="查看分支与同步"
                title={branch}
                className="flex min-w-0 max-w-[38vw] items-center gap-1 truncate rounded px-1 py-0.5 font-mono text-[12px] text-gn-cyan hover:bg-gn-bg-highlight sm:max-w-[220px]"
              >
                <GitBranchIcon size={12} className="shrink-0" aria-hidden />
                <span className="truncate">{branch === '(detached)' ? 'detached' : branch}</span>
              </button>
              {(status?.ahead ?? 0) > 0 && (
                <button
                  type="button"
                  onClick={toggleUnpushed}
                  aria-expanded={showUnpushed}
                  aria-label={`查看 ${status?.ahead ?? 0} 个未推送的提交`}
                  className={`flex h-7 shrink-0 items-center gap-0.5 rounded px-1.5 font-mono text-[11px] font-bold transition-colors ${
                    showUnpushed
                      ? 'bg-gn-yellow/25 text-gn-yellow'
                      : 'bg-gn-yellow/15 text-gn-yellow hover:bg-gn-yellow/25'
                  }`}
                  title="领先上游的未推送提交 — 点击查看列表"
                >
                  <ArrowUp size={10} className="shrink-0" aria-hidden />
                  {status?.ahead}
                  {showUnpushed ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                </button>
              )}
              {(status?.behind ?? 0) > 0 && (
                <span
                  className="shrink-0 rounded bg-gn-bg-highlight px-1.5 py-1 font-mono text-[11px] font-bold text-gn-muted"
                  title="落后上游的提交（打开面板时会静默 fetch，数字更准）"
                >
                  <ArrowDown size={10} className="shrink-0" aria-hidden />
                  {status?.behind}
                </span>
              )}
            </div>
          ) : null}

          {/* HEAD 锚点：短哈希点击复制，桌面端附提交主题 */}
          {!notRepo && (status?.commit ?? headCommit?.hash) ? (
            <button
              type="button"
              onClick={() => {
                const hash = status?.commit ?? headCommit?.hash
                if (!hash) return
                void navigator.clipboard?.writeText(hash)
                setCopiedHeadHash(true)
                setTimeout(() => setCopiedHeadHash(false), 1500)
              }}
              className="hidden h-7 min-w-0 shrink-0 items-center gap-1 rounded px-1.5 font-mono text-[11px] text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg sm:flex"
              title={
                headCommit
                  ? `${headCommit.shortHash} ${headCommit.message} — 点击复制完整哈希`
                  : '复制 HEAD 完整哈希'
              }
              aria-label="复制 HEAD 完整哈希"
            >
              {copiedHeadHash ? (
                <Check size={11} className="shrink-0 text-gn-green" />
              ) : (
                <Copy size={10} className="shrink-0 opacity-60" />
              )}
              <span className="shrink-0">{(status?.commit ?? headCommit?.hash)?.slice(0, 7)}</span>
              {headCommit?.message && (
                <span className="hidden max-w-[180px] truncate text-[10.5px] text-gn-muted/70 md:inline">
                  {headCommit.message}
                </span>
              )}
            </button>
          ) : null}

          {!notRepo && rowCount > 0 && (
            <span className="hidden font-mono text-[11px] text-gn-muted md:inline">
              {stagedCount} staged · {modifiedCount} modified · {untrackedCount} untracked
            </span>
          )}

          {busyOp ? (
            <span className="hidden min-w-0 truncate font-mono text-[11px] text-gn-yellow sm:inline">
              {busyOp}…
            </span>
          ) : null}

          <div className="ml-auto flex items-center gap-0.5">
            {!notRepo && (
              <button
                type="button"
                onClick={() => {
                  void refresh()
                  void refreshBranches()
                  if (activeTab === 'log') void refreshLog()
                  if (activeTab === 'sync') void refreshStashes()
                }}
                disabled={loading}
                className="rounded p-1.5 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-40"
                title="重新拉取 git 状态"
              >
                <span className="hidden sm:inline text-[11px] px-1">刷新</span>
                <RefreshCw size={13} className={`inline ${loading || busy ? 'animate-spin' : ''}`} />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1.5 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
              aria-label="关闭"
              title="关闭 (Esc)"
            >
              <X size={15} aria-hidden />
            </button>
          </div>
        </header>

        {/* 未推送提交列表（↑N 徽章点开）— 内嵌展开条，避免移动端浮层裁切 */}
        {!notRepo && showUnpushed && (
          <div className="shrink-0 border-b border-gn-prompt-border bg-gn-bg-base/70 px-3 py-2">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gn-yellow">
                未推送的提交
              </span>
              <span className="min-w-0 truncate font-mono text-[10px] text-gn-muted" title={status?.upstream}>
                {status?.upstream ?? '（未配置上游）'}
              </span>
            </div>
            <div className="gn-no-scrollbar mt-1 max-h-40 space-y-0.5 overflow-y-auto">
              {unpushed?.loading ? (
                <div className="py-1 text-[11px] text-gn-muted">加载中…</div>
              ) : unpushed?.error ? (
                <div className="py-1 text-[11px] text-gn-muted">
                  {/upstream/i.test(unpushed.error)
                    ? '当前分支没有配置上游，无法比较未推送提交'
                    : unpushed.error}
                </div>
              ) : unpushed?.commits && unpushed.commits.length > 0 ? (
                unpushed.commits.map((c) => (
                  <div key={c.hash} className="flex min-w-0 items-center gap-2 text-[11px]">
                    <span className="shrink-0 font-mono text-gn-cyan">{c.shortHash}</span>
                    <span className="min-w-0 flex-1 truncate text-gn-fg2" title={c.message}>
                      {c.message}
                    </span>
                  </div>
                ))
              ) : (
                <div className="py-1 text-[11px] text-gn-muted">
                  没有未推送的提交（计数可能已过期，试试 Fetch 刷新）
                </div>
              )}
            </div>
          </div>
        )}
    </>
  )
}
