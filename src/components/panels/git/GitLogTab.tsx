import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import { KEY } from '../../../lib/keys'
import { saveJSON } from '../../../lib/storage'
import type { GitFileChange, GitLogEntry } from '../../../api/types'
import {
  COMMIT_PATCH_MAX_LINES,
  LOG_HEADER_PAD_X,
  capDiffBlocks,
  computeDividerWidths,
  formatGitDate,
  loadLogColWidths,
  parseUnifiedDiffBlocks,
  type LogColWidths,
  type LogDivider,
} from '../../../lib/gitPanel'
import { buildGitGraph } from './gitGraph'
import { GitGraphCell } from './GitGraphCell'
import { DiffRowView } from './GitDiffRows'
import { LogColHandle } from './GitLogHandle'

type CommitDiffState = {
  loading: boolean
  files?: GitFileChange[]
  error?: string
}

type GitLogTabProps = {
  commits: GitLogEntry[]
  filteredCommits: GitLogEntry[]
  logLoading: boolean
  logError?: string
  commitFilter: string
  setCommitFilter: (value: string) => void
  refreshLog: () => Promise<void>
  selectedCommit?: GitLogEntry
  setSelectedCommitHash: (hash: string | undefined) => void
  copiedHash: boolean
  setCopiedHash: (copied: boolean) => void
  commitDiff?: CommitDiffState
  openCommitFile?: string
  setOpenCommitFile: (path: string | undefined) => void
}

function renderRefBadges(refs?: string) {
  if (!refs) return null
  const parts = refs.split(',').map((r) => r.trim()).filter(Boolean)
  return (
    <span className="inline-flex items-center gap-1 shrink-0">
      {parts.map((ref, idx) => {
        const isHead = ref.includes('HEAD') || ref.includes('main') || ref.includes('master')
        const isTag = ref.startsWith('tag:')
        const isRemote = ref.startsWith('origin/') || ref.startsWith('upstream/')
        const colorClass = isHead
          ? 'bg-gn-green/20 text-gn-green border-gn-green/40'
          : isTag
            ? 'bg-gn-yellow/20 text-gn-yellow border-gn-yellow/40'
            : isRemote
              ? 'bg-gn-cyan/20 text-gn-cyan border-gn-cyan/40'
              : 'bg-gn-bg-highlight text-gn-muted border-gn-prompt-border'
        return (
          <span
            key={idx}
            className={`rounded border px-1.5 py-[1px] font-mono text-[9.5px] font-medium leading-none ${colorClass}`}
          >
            {ref}
          </span>
        )
      })}
    </span>
  )
}

/** 「历史」tab：提交表（可拖列宽）+ 提交详情与改动文件。 */
export function GitLogTab({
  commits,
  filteredCommits,
  logLoading,
  logError,
  commitFilter,
  setCommitFilter,
  refreshLog,
  selectedCommit,
  setSelectedCommitHash,
  copiedHash,
  setCopiedHash,
  commitDiff,
  openCommitFile,
  setOpenCommitFile,
}: GitLogTabProps) {
  // 历史 tab 列宽：拖动中实时更新 state（行随表头联动），落盘见下方 effect。
  const [logColWidths, setLogColWidths] = useState<LogColWidths>(loadLogColWidths)
  const logHeaderRef = useRef<HTMLDivElement>(null)
  const colDrag = useRef<{
    boundary: LogDivider
    widths: LogColWidths
    contentW: number
    graphW: number
  } | null>(null)
  useEffect(() => {
    saveJSON(KEY.gitLogColWidths, logColWidths)
  }, [logColWidths])

  const { rows: gitGraphRows, graphWidth } = useMemo(
    () => buildGitGraph(filteredCommits),
    [filteredCommits],
  )

  // 列宽拖拽：pointerdown 时对当前宽度/容器宽/图谱宽做快照，move 期间
  // 一律从快照推算，避免增量在 clamp 时累积误差。
  const beginColDrag = useCallback(
    (boundary: LogDivider) => {
      colDrag.current = {
        boundary,
        widths: logColWidths,
        contentW: (logHeaderRef.current?.clientWidth ?? 0) - LOG_HEADER_PAD_X,
        graphW: graphWidth,
      }
    },
    [logColWidths, graphWidth],
  )
  const dragColDivider = useCallback((boundary: LogDivider, dx: number) => {
    const snap = colDrag.current
    if (snap?.boundary !== boundary) return
    setLogColWidths(computeDividerWidths(boundary, dx, snap))
  }, [])

  return (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div
                  className={`shrink-0 items-center justify-between gap-2 border-b border-gn-prompt-border bg-gn-bg-base/60 px-2 py-1.5 ${
                    selectedCommit ? 'hidden sm:flex' : 'flex'
                  }`}
                >
                  <div className="relative min-w-0 flex-1 max-w-sm">
                    <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gn-muted" />
                    <input
                      type="text"
                      value={commitFilter}
                      onChange={(e) => setCommitFilter(e.target.value)}
                      placeholder="搜索提交信息、作者、哈希..."
                      className="h-8 w-full rounded border border-gn-prompt-border bg-gn-bg-dark pl-7 pr-7 text-[11.5px] text-gn-fg outline-none focus:border-gn-cyan/60 sm:h-7"
                    />
                    {commitFilter && (
                      <button
                        type="button"
                        onClick={() => setCommitFilter('')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gn-muted hover:text-gn-fg"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-gn-muted">
                    <span className="hidden font-mono sm:inline">
                      {filteredCommits.length !== commits.length
                        ? `${filteredCommits.length} / ${commits.length} 次提交`
                        : `共 ${commits.length} 次提交`}
                    </span>
                    <button
                      type="button"
                      onClick={() => void refreshLog()}
                      className="flex items-center gap-1 rounded border border-gn-prompt-border bg-gn-bg-base px-2 py-1 text-gn-muted hover:text-gn-fg"
                      title="刷新提交历史"
                    >
                      <RefreshCw size={11} className={logLoading ? 'animate-spin' : ''} /> 刷新
                    </button>
                  </div>
                </div>

                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden sm:flex-row">
                      <div
                    className={`min-h-0 min-w-0 flex-col border-gn-prompt-border/60 sm:border-r ${
                      selectedCommit ? 'hidden sm:flex sm:flex-1' : 'flex flex-1'
                    }`}
                  >
                    <div
                      ref={logHeaderRef}
                      className="flex shrink-0 items-center border-b border-gn-prompt-border/40 bg-gn-bg-base/80 px-1.5 py-1 text-[10px] font-medium uppercase tracking-wider text-gn-gutter select-none"
                    >
                      <span style={{ width: graphWidth }} className="shrink-0" aria-hidden="true" />
                      <span className="relative min-w-0 flex-1 pr-2">
                        提交信息
                        <LogColHandle
                          label="调整提交信息列宽"
                          onDragStart={() => beginColDrag('message')}
                          onDrag={(dx) => dragColDivider('message', dx)}
                        />
                      </span>
                      <span
                        className="relative hidden shrink-0 px-2 text-left md:inline"
                        style={{ width: logColWidths.author }}
                      >
                        作者
                        <LogColHandle
                          label="调整作者列宽"
                          onDragStart={() => beginColDrag('author')}
                          onDrag={(dx) => dragColDivider('author', dx)}
                        />
                      </span>
                      <span
                        className="relative hidden shrink-0 px-2 text-left sm:inline"
                        style={{ width: logColWidths.date }}
                      >
                        日期
                        <LogColHandle
                          label="调整日期列宽"
                          onDragStart={() => beginColDrag('date')}
                          onDrag={(dx) => dragColDivider('date', dx)}
                        />
                      </span>
                      <span className="shrink-0 pl-2 text-left" style={{ width: logColWidths.hash }}>
                        哈希
                      </span>
                    </div>

                    <div className="gn-no-scrollbar flex-1 divide-y divide-gn-prompt-border/20 overflow-y-auto">
                      {logLoading && commits.length === 0 ? (
                        <div className="py-8 text-center text-[12px] text-gn-muted">加载提交历史中…</div>
                      ) : logError ? (
                        <div className="py-8 text-center text-[12px] text-gn-red">{logError}</div>
                      ) : filteredCommits.length === 0 ? (
                        <div className="py-8 text-center text-[12px] text-gn-muted">
                          {commitFilter ? '未找到匹配的提交' : '暂无提交记录'}
                        </div>
                      ) : (
                        filteredCommits.map((c, index) => {
                          const isSelected = selectedCommit?.hash === c.hash
                          return (
                            <button
                              type="button"
                              key={c.hash}
                              onClick={() => setSelectedCommitHash(c.hash)}
                              className={`group flex h-7 w-full shrink-0 cursor-pointer items-center gap-0 px-1.5 text-left text-[11.5px] leading-none transition-colors ${
                                isSelected
                                  ? 'ring-1 ring-inset ring-gn-cyan/60 bg-gn-bg-highlight font-medium text-gn-fg'
                                  : 'text-gn-fg2 hover:bg-gn-bg-highlight/40 hover:text-gn-fg'
                              }`}
                            >
                              <GitGraphCell row={gitGraphRows[index]} width={graphWidth} />
                              <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate pr-2">
                                {renderRefBadges(c.refs)}
                                <span className="truncate font-mono" title={c.message}>
                                  {c.message}
                                </span>
                              </span>
                              <span
                                className="hidden shrink-0 truncate px-2 font-mono text-[11px] text-gn-muted md:inline"
                                style={{ width: logColWidths.author }}
                                title={c.author}
                              >
                                {c.author}
                              </span>
                              <span
                                className="hidden shrink-0 truncate px-2 text-[11px] text-gn-muted sm:inline"
                                style={{ width: logColWidths.date }}
                                title={c.date}
                              >
                                {formatGitDate(c.date)}
                              </span>
                              <span
                                className="shrink-0 pl-2 text-left font-mono text-[10.5px] text-gn-cyan"
                                style={{ width: logColWidths.hash }}
                              >
                                {c.shortHash}
                              </span>
                            </button>
                          )
                        })
                      )}
                    </div>
                  </div>

                  {selectedCommit ? (
                    <div className="min-h-0 w-full flex-1 overflow-y-auto bg-gn-bg-dark/60 sm:flex sm:w-[320px] sm:flex-none sm:flex-col sm:overflow-hidden md:w-[360px]">
                      <div className="sticky top-0 z-[1] flex shrink-0 items-center gap-2 border-b border-gn-prompt-border bg-gn-bg-base px-3 py-2 sm:hidden">
                        <button
                          type="button"
                          onClick={() => setSelectedCommitHash(undefined)}
                          className="flex min-h-8 items-center gap-1 text-[12px] text-gn-cyan"
                        >
                          <ChevronLeft size={16} /> 返回提交列表
                        </button>
                      </div>
                      <div className="shrink-0 space-y-2 border-b border-gn-prompt-border/40 bg-gn-bg-base/30 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="font-mono text-[13px] font-semibold leading-snug break-words text-gn-fg">
                            <span className="font-normal text-gn-gutter">提交：</span>
                            {selectedCommit.message}
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              void navigator.clipboard?.writeText(selectedCommit.hash)
                              setCopiedHash(true)
                              setTimeout(() => setCopiedHash(false), 1500)
                            }}
                            className="flex shrink-0 items-center gap-1 rounded border border-gn-prompt-border bg-gn-bg-dark px-1.5 py-0.5 font-mono text-[10px] text-gn-cyan hover:bg-gn-bg-highlight"
                            title="复制完整 SHA"
                          >
                            {copiedHash ? <Check size={11} className="text-gn-green" /> : <Copy size={11} />}
                            <span>{selectedCommit.hash.slice(0, 7)}</span>
                          </button>
                        </div>

                        {selectedCommit.body && (
                          <div className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-gn-muted">
                            {selectedCommit.body}
                          </div>
                        )}

                        <div className="flex flex-col gap-1 text-[11px] text-gn-muted">
                          <div>
                            <span className="text-gn-gutter">作者：</span>
                            {selectedCommit.author}
                            {selectedCommit.email ? ` <${selectedCommit.email}>` : ''}
                          </div>
                          <div className="flex items-center gap-1 text-[10.5px]">
                            <Clock size={11} className="shrink-0" />
                            <span title={selectedCommit.date}>{formatGitDate(selectedCommit.date)}</span>
                          </div>
                          {selectedCommit.refs && (
                            <div className="pt-0.5">{renderRefBadges(selectedCommit.refs)}</div>
                          )}
                        </div>
                      </div>

                      <div className="flex min-h-0 flex-col sm:flex-1">
                        <div className="flex shrink-0 items-center justify-between border-b border-gn-prompt-border/30 bg-gn-bg-base/50 px-3 py-1.5 text-[10.5px] uppercase tracking-wider text-gn-gutter select-none">
                          <span>改动文件 {commitDiff?.files ? `· ${commitDiff.files.length}` : ''}</span>
                        </div>
                        <div className="gn-no-scrollbar space-y-1 p-2 sm:flex-1 sm:overflow-y-auto">
                          {commitDiff?.loading ? (
                            <div className="py-4 text-center text-[11px] text-gn-muted">分析改动中…</div>
                          ) : commitDiff?.error ? (
                            <div className="px-3 py-2 text-[11px] text-gn-muted">无附加文件差异</div>
                          ) : commitDiff?.files && commitDiff.files.length > 0 ? (
                            commitDiff.files.map((f) => {
                              const expanded = openCommitFile === f.path
                              const capped =
                                expanded && f.patch
                                  ? capDiffBlocks(parseUnifiedDiffBlocks(f.patch), COMMIT_PATCH_MAX_LINES)
                                  : undefined
                              return (
                                <div key={f.path} className="overflow-hidden rounded bg-gn-bg-dark/40">
                                  <button
                                    type="button"
                                    onClick={() => setOpenCommitFile(expanded ? undefined : f.path)}
                                    aria-expanded={expanded}
                                    className="flex w-full min-h-8 items-center justify-between gap-2 rounded px-2 py-2 text-left font-mono text-[11px] hover:bg-gn-bg-highlight/40 sm:min-h-0 sm:py-1.5"
                                    title={f.path}
                                  >
                                    {expanded ? (
                                      <ChevronDown size={11} className="shrink-0 text-gn-muted" />
                                    ) : (
                                      <ChevronRight size={11} className="shrink-0 text-gn-muted" />
                                    )}
                                    <span className="min-w-0 flex-1 truncate text-gn-fg">{f.path}</span>
                                    <span className="ml-2 shrink-0 text-[10px] tabular-nums text-gn-gutter">
                                      +{f.additions}−{f.deletions}
                                    </span>
                                  </button>
                                  {expanded && (
                                    <div className="border-t border-gn-prompt-border/30">
                                      {capped && capped.blocks.length > 0 ? (
                                        <>
                                          {capped.blocks
                                            .filter((b) => b.header !== 'File Header')
                                            .map((block, bi) => (
                                              <div
                                                key={bi}
                                                className="border-b border-gn-prompt-border/10 last:border-b-0"
                                              >
                                                <div className="truncate bg-gn-bg-base/60 px-2 py-0.5 font-mono text-[10px] text-gn-cyan/90">
                                                  {block.header}
                                                </div>
                                                {block.rows.map((r, ri) => (
                                                  <DiffRowView key={ri} kind={r.kind} text={r.text} />
                                                ))}
                                              </div>
                                            ))}
                                          {capped.truncated && (
                                            <div className="px-2 py-1 font-mono text-[10px] text-gn-gutter">
                                              … diff 过大，仅显示前 {COMMIT_PATCH_MAX_LINES} 行
                                            </div>
                                          )}
                                        </>
                                      ) : (
                                        <div className="px-2 py-1.5 text-[10.5px] text-gn-muted">
                                          {f.patch != null
                                            ? '（无内容 diff）'
                                            : '无 patch 内容（可能是二进制文件）'}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )
                            })
                          ) : (
                            <div className="py-3 text-center text-[11px] text-gn-muted">
                              {commitDiff ? '无修改文件记录' : '点击提交查看改动详情'}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="hidden items-center justify-center text-[12px] text-gn-muted sm:flex sm:w-[320px] sm:shrink-0 md:w-[360px]">
                      选择左侧提交查看详细信息
                    </div>
                  )}
                </div>
              </div>  )
}
