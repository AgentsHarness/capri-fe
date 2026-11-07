import { GitBranch as GitBranchIcon, Plus } from 'lucide-react'
import { transport } from '../../../api/client'
import { Spinner } from '../../ui/Spinner'

/** 目录不是 git 仓库时的空态：说明 + 初始化 / 重试。 */
export function GitNotRepoState({
  cwd,
  statusError,
  busy,
  busyOp,
  runOp,
  refresh,
}: {
  cwd: string | undefined
  statusError?: string
  busy: boolean
  busyOp?: string
  runOp: (label: string, fn: () => Promise<unknown>) => Promise<boolean>
  refresh: () => Promise<void>
}) {
  return (
          <div className="flex flex-1 flex-col items-center justify-center p-6 sm:p-8 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gn-bg-highlight text-gn-cyan border border-gn-prompt-border/60 shadow-sm">
              <GitBranchIcon size={26} />
            </div>
            <div className="mt-4 text-[16px] font-semibold text-gn-fg">
              当前目录不是 git 仓库
            </div>
            <p className="mt-2 max-w-md text-[12.5px] leading-relaxed text-gn-muted">
              当前工作区路径 <span className="font-mono text-gn-cyan">{cwd || '当前路径'}</span> 尚未初始化 Git 版本控制 (not a git repository)。
              一键初始化后即可直接使用暂存、提交、分支管理等功能。
            </p>
            <div className="mt-2 font-mono text-[11px] text-gn-gutter">
              ({statusError})
            </div>
            <div className="mt-6 flex w-full max-w-sm flex-col items-stretch gap-2 sm:max-w-none sm:flex-row sm:items-center sm:justify-center sm:gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  runOp('init', async () => {
                    await transport.gitInit?.({ cwd })
                    await refresh()
                  })
                }
                className="flex items-center justify-center gap-1.5 rounded-lg bg-gn-green/20 border border-gn-green/40 px-4 py-2.5 text-[12.5px] font-medium text-gn-green hover:bg-gn-green/30 disabled:cursor-not-allowed disabled:opacity-40 shadow-sm sm:py-2"
              >
                {busyOp === 'init' ? <Spinner size={15} /> : <Plus size={15} />}
                初始化 Git 仓库 (git init)
              </button>
              <button
                type="button"
                onClick={() => void refresh()}
                className="rounded-lg border border-gn-prompt-border bg-gn-bg-base px-3.5 py-2.5 text-[12px] text-gn-fg hover:bg-gn-bg-highlight sm:py-2"
              >
                重试
              </button>
            </div>
          </div>
  )
}
