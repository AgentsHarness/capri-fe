import { AlertTriangle } from 'lucide-react'
import type { GitRepoStateData } from '../../../api/types'

/** merge / rebase / cherry-pick 进行中横幅（只读；处理交给 agent）。 */
export function GitRepoStateBanner({
  repoState,
}: {
  repoState?: GitRepoStateData
}) {
  return (
    <>
        {repoState &&
          (repoState.mergeInProgress || repoState.rebaseInProgress || repoState.cherryPickInProgress) && (
            <div
              role="status"
              className={`shrink-0 border-b px-3 py-1.5 text-[11px] leading-relaxed ${
                repoState.conflictCount > 0
                  ? 'border-gn-red/40 bg-gn-diff-del-bg/30 text-gn-red'
                  : 'border-gn-yellow/40 bg-gn-yellow/10 text-gn-yellow'
              }`}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <AlertTriangle size={12} className="shrink-0" aria-hidden />
                <span className="font-semibold">
                  {repoState.rebaseInProgress
                    ? 'rebase 进行中'
                    : repoState.mergeInProgress
                      ? 'merge 进行中'
                      : 'cherry-pick 进行中'}
                </span>
                {repoState.conflictCount > 0 ? (
                  <span>· {repoState.conflictCount} 个冲突文件待解决</span>
                ) : null}
                <span className="text-gn-muted">（可在对话中让 agent 继续/中止该操作）</span>
              </div>
              {repoState.conflicts.length > 0 && (
                <div className="mt-1 flex flex-col gap-0.5 font-mono text-[10.5px] text-gn-muted">
                  {repoState.conflicts.slice(0, 3).map((p) => (
                    <span key={p} className="min-w-0 truncate" title={p}>
                      · {p}
                    </span>
                  ))}
                  {repoState.conflicts.length > 3 && (
                    <span>… 共 {repoState.conflicts.length} 个文件</span>
                  )}
                </div>
              )}
            </div>
          )}



    </>
  )
}
