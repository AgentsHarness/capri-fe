import { GitCommit } from 'lucide-react'
import { transport } from '../../../api/client'
import { Spinner } from '../../ui/Spinner'

type GitCommitFooterProps = {
  selectedPath?: string
  commitMsg: string
  setCommitMsg: (value: string) => void
  amend: boolean
  setAmend: (value: boolean) => void
  canCommit: boolean
  busy: boolean
  busyOp?: string
  cwd: string | undefined
  stagedCount: number
  onCommitAndPush: () => Promise<void>
  onStashClick: () => void
  runOp: (label: string, fn: () => Promise<unknown>) => Promise<boolean>
}

/** 变更 tab 底部提交栏：提交信息、amend、commit / commit & push / stash。 */
export function GitCommitFooter({
  selectedPath,
  commitMsg,
  setCommitMsg,
  amend,
  setAmend,
  canCommit,
  busy,
  busyOp,
  cwd,
  stagedCount,
  onCommitAndPush,
  onStashClick,
  runOp,
}: GitCommitFooterProps) {
  return (
          <footer
            className={`gn-modal-footer flex-col gap-2 bg-gn-bg-base px-3 py-2.5 sm:px-4 ${
              selectedPath ? 'hidden sm:flex' : 'flex'
            }`}
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <input
                  type="text"
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return
                    if (e.key === 'Enter' && canCommit) {
                      const msg = commitMsg.trim()
                      void runOp('commit', () =>
                        transport.gitCommit({
                          cwd,
                          message: msg,
                          ...(amend ? { amend: true } : {}),
                        }),
                      ).then((ok) => {
                        if (ok) setCommitMsg('')
                      })
                    }
                  }}
                  placeholder="提交信息（Enter 提交）"
                  className="min-h-8 min-w-0 flex-1 rounded border border-gn-prompt-border bg-gn-bg-dark px-2.5 text-[12px] text-gn-fg outline-none placeholder:text-gn-gray focus:border-gn-green/60 sm:min-h-8"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label
                  className="flex shrink-0 cursor-pointer select-none items-center gap-1 text-[11px] text-gn-muted"
                  title="git commit --amend"
                >
                  <input
                    type="checkbox"
                    checked={amend}
                    onChange={(e) => setAmend(e.target.checked)}
                    className="accent-gn-green"
                  />
                  amend
                </label>

                <button
                  type="button"
                  disabled={!canCommit}
                  onClick={() => {
                    const msg = commitMsg.trim()
                    void runOp('commit', () =>
                      transport.gitCommit({
                        cwd,
                        message: msg,
                        ...(amend ? { amend: true } : {}),
                      }),
                    ).then((ok) => {
                      if (ok) setCommitMsg('')
                    })
                  }}
                  className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded border border-gn-green/40 bg-gn-green/20 px-3 py-1 text-[12px] font-medium text-gn-green hover:bg-gn-green/30 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
                  title={
                    stagedCount === 0 && !amend
                      ? '请先暂存文件，或勾选 amend'
                      : '提交暂存区的更改（x.ai/git/commit）'
                  }
                >
                  {busyOp === 'commit' ? <Spinner size={11} /> : null}
                  commit
                </button>

                <button
                  type="button"
                  disabled={!canCommit}
                  onClick={onCommitAndPush}
                  className="flex min-h-8 shrink-0 items-center gap-1 rounded border border-gn-prompt-border bg-gn-bg-base px-2.5 py-1 text-[12px] text-gn-fg hover:bg-gn-bg-highlight disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
                  title="提交并推送到远端"
                >
                  {busy ? <Spinner size={12} /> : <GitCommit size={12} />}
                  <span className="sm:hidden">推送</span>
                  <span className="hidden sm:inline">commit & push</span>
                </button>

                <button
                  type="button"
                  disabled={busy}
                  onClick={onStashClick}
                  className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded border border-gn-prompt-border bg-gn-bg-base px-2.5 py-1 text-[12px] text-gn-fg hover:bg-gn-bg-highlight disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
                  title="git stash — 暂存全部未提交更改"
                >
                  {busyOp === 'stash' ? <Spinner size={11} /> : null}
                  stash
                </button>
              </div>
            </div>
          </footer>
  )
}
