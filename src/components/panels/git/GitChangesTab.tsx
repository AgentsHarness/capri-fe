import { Check, ChevronLeft } from 'lucide-react'
import { Spinner } from '../../ui/Spinner'
import { transport } from '../../../api/client'
import {
  type ChangeFilter,
  type DiffHunkBlock,
  type DiffState,
  type StatusRow,
} from '../../../lib/gitPanel'
import { ChangeGroup, FileRow } from './GitFileRows'
import { DiffRowView } from './GitDiffRows'

type GitChangesTabProps = {
  statusError?: string
  status?: unknown
  loading: boolean
  refresh: () => Promise<void>
  rows: StatusRow[]
  stagedRows: StatusRow[]
  unstagedRows: StatusRow[]
  visibleStagedRows: StatusRow[]
  visibleUnstagedRows: StatusRow[]
  visibleUntrackedRows: StatusRow[]
  visibleRowCount: number
  changeFilter: ChangeFilter
  setChangeFilter: (filter: ChangeFilter) => void
  selectedPath?: string
  setSelectedPath: (path: string | undefined) => void
  selectedRow?: StatusRow
  armedDiscard: { path: string; at: number } | null
  busy: boolean
  busyOp?: string
  diff?: DiffState
  cwd: string | undefined
  runOp: (label: string, fn: () => Promise<unknown>) => Promise<boolean>
  onStageAll: () => void
  onUnstageAll: () => void
  onDiscardClick: (e: React.MouseEvent, row: StatusRow) => void
  onStageHunk: (block: DiffHunkBlock) => void
}

/** 「变更」tab：工作区文件列表（暂存/未暂存/未跟踪）+ diff 预览与按块暂存。 */
export function GitChangesTab({
  statusError,
  status,
  loading,
  refresh,
  rows,
  stagedRows,
  unstagedRows,
  visibleStagedRows,
  visibleUnstagedRows,
  visibleUntrackedRows,
  visibleRowCount,
  changeFilter,
  setChangeFilter,
  selectedPath,
  setSelectedPath,
  selectedRow,
  armedDiscard,
  busy,
  busyOp,
  diff,
  cwd,
  runOp,
  onStageAll,
  onUnstageAll,
  onDiscardClick,
  onStageHunk,
}: GitChangesTabProps) {
  return (
              statusError && !status ? (
                <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
                  <div className="text-[13px] text-gn-red">{statusError}</div>
                  <div className="mt-1 text-[11.5px] text-gn-muted">host 调用失败</div>
                  <button
                    type="button"
                    onClick={() => void refresh()}
                    className="mt-3 rounded border border-gn-prompt-border bg-gn-bg-base px-4 py-1.5 text-[12px] text-gn-fg hover:bg-gn-bg-highlight"
                  >
                    重试
                  </button>
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
                  {/* File list sidebar — hidden on mobile while a diff is open */}
                  <div
                    className={`flex min-h-0 flex-col border-gn-prompt-border bg-gn-bg-base/40 sm:shrink-0 sm:border-r ${
                      selectedPath ? 'hidden sm:flex sm:w-[320px] lg:w-[360px]' : 'flex w-full sm:w-[320px] lg:w-[360px]'
                    }`}
                  >
                    <div className="flex shrink-0 flex-col gap-2 border-b border-gn-prompt-border/50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <span className="text-[10px] uppercase tracking-wider text-gn-gutter">
                          工作区状态 · {rows.length}
                        </span>

                      </div>
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-1 gap-1 rounded bg-gn-bg-dark/50 p-0.5" role="group" aria-label="筛选工作区文件">
                          {([
                            ['all', '全部', rows.length],
                            ['staged', '暂存', stagedRows.length],
                            ['unstaged', '待暂存', unstagedRows.length],
                          ] as const).map(([filter, label, count]) => (
                            <button
                              key={filter}
                              type="button"
                              aria-pressed={changeFilter === filter}
                              aria-label={`${label}文件 ${count}`}
                              onClick={() => setChangeFilter(filter)}
                              className={`flex min-h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded px-1.5 text-[10px] transition-colors sm:min-h-0 sm:flex-none sm:px-2 sm:py-0.5 sm:text-[10.5px] ${
                                changeFilter === filter
                                  ? 'bg-gn-bg-highlight font-medium text-gn-fg'
                                  : 'text-gn-muted hover:bg-gn-bg-highlight/60 hover:text-gn-fg'
                              }`}
                            >
                              <span className="truncate">{label}</span>
                              <span className="font-mono text-[10px] text-gn-gutter">{count}</span>
                            </button>
                          ))}
                        </div>
                        <div className="flex items-center gap-1">
                          {unstagedRows.length > 0 && (
                            <button
                              type="button"
                              onClick={onStageAll}
                              disabled={busy}
                              className="inline-flex items-center gap-1 rounded bg-gn-bg-highlight px-2 py-1 text-[10.5px] text-gn-green hover:bg-gn-green/20 disabled:cursor-not-allowed disabled:opacity-40 sm:px-1.5 sm:py-0.5 sm:text-[10px]"
                              title="一键暂存所有修改"
                            >
                              {busyOp === 'stage all' ? <Spinner size={10} /> : null}
                              全部暂存
                            </button>
                          )}
                          {stagedRows.length > 0 && (
                            <button
                              type="button"
                              onClick={onUnstageAll}
                              disabled={busy}
                              className="inline-flex items-center gap-1 rounded bg-gn-bg-highlight px-2 py-1 text-[10.5px] text-gn-muted hover:bg-gn-bg-base disabled:cursor-not-allowed disabled:opacity-40 sm:px-1.5 sm:py-0.5 sm:text-[10px]"
                              title="一键取消暂存全部文件"
                            >
                              {busyOp === 'unstage all' ? <Spinner size={10} /> : null}
                              全部取消
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="gn-no-scrollbar min-h-0 flex-1 overflow-y-auto">
                      {loading && rows.length === 0 && (
                        <div className="px-3 py-3 text-[11px] text-gn-muted">加载中…</div>
                      )}
                      {!loading && visibleRowCount === 0 && (
                        <div className="px-3 py-8 text-center text-[12px] text-gn-muted">
                          {rows.length === 0 ? (
                            <span className="inline-flex items-center gap-1">
                              工作区没有改动
                              <Check size={12} className="text-gn-green" aria-hidden />
                            </span>
                          ) : (
                            '当前筛选没有文件'
                          )}
                        </div>
                      )}

                      <ChangeGroup title="已暂存" count={visibleStagedRows.length} tone="green">
                        {visibleStagedRows.map((row) => (
                          <FileRow
                            key={row.path}
                            row={row}
                            selected={row.path === selectedPath}
                            armed={armedDiscard?.path === row.path}
                            busy={busy}
                            busyOp={busyOp}
                            onSelect={() => setSelectedPath(row.path === selectedPath ? undefined : row.path)}
                            onUnstage={() =>
                              void runOp(`unstage ${row.path}`, () =>
                                transport.gitUnstage({ cwd, paths: [row.path] }),
                              )
                            }
                            onDiscard={(e) => onDiscardClick(e, row)}
                          />
                        ))}
                      </ChangeGroup>
                      <ChangeGroup title="已修改" count={visibleUnstagedRows.length} tone="yellow">
                        {visibleUnstagedRows.map((row) => (
                          <FileRow
                            key={row.path}
                            row={row}
                            selected={row.path === selectedPath}
                            armed={armedDiscard?.path === row.path}
                            busy={busy}
                            busyOp={busyOp}
                            onSelect={() => setSelectedPath(row.path === selectedPath ? undefined : row.path)}
                            onStage={() =>
                              void runOp(`stage ${row.path}`, () =>
                                transport.gitStage({ cwd, paths: [row.path] }),
                              )
                            }
                            onDiscard={(e) => onDiscardClick(e, row)}
                          />
                        ))}
                      </ChangeGroup>
                      <ChangeGroup title="未跟踪" count={visibleUntrackedRows.length} tone="red">
                        {visibleUntrackedRows.map((row) => (
                          <FileRow
                            key={row.path}
                            row={row}
                            selected={row.path === selectedPath}
                            armed={armedDiscard?.path === row.path}
                            busy={busy}
                            busyOp={busyOp}
                            onSelect={() => setSelectedPath(row.path === selectedPath ? undefined : row.path)}
                            onStage={() =>
                              void runOp(`stage ${row.path}`, () =>
                                transport.gitStage({ cwd, paths: [row.path] }),
                              )
                            }
                            onDiscard={(e) => onDiscardClick(e, row)}
                          />
                        ))}
                      </ChangeGroup>
                    </div>
                  </div>

                  {/* Diff Viewer — full-screen on mobile when a file is selected */}
                  <div
                    className={`flex min-h-0 min-w-0 flex-1 flex-col bg-gn-bg-dark ${
                      selectedPath ? 'flex' : 'hidden sm:flex'
                    }`}
                  >
                    {selectedPath && (
                      <div className="flex shrink-0 items-center gap-2 border-b border-gn-prompt-border bg-gn-bg-base px-3 py-2 sm:hidden">
                        <button
                          type="button"
                          onClick={() => setSelectedPath(undefined)}
                          className="flex min-h-8 items-center gap-1 text-[12px] text-gn-cyan"
                        >
                          <ChevronLeft size={16} /> 返回文件列表
                        </button>
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-gn-fg2">
                          {selectedPath}
                        </span>
                      </div>
                    )}

                    <div className="gn-no-scrollbar min-h-0 flex-1 overflow-y-auto">
                      {diff?.loading ? (
                        <div className="px-4 py-4 font-mono text-[12px] text-gn-muted">
                          加载 diff…
                        </div>
                      ) : diff?.error ? (
                        <div className="px-4 py-4 font-mono text-[12px] text-gn-red">
                          {diff.error}
                        </div>
                      ) : diff?.rows != null ? (
                        <div className="py-2">
                          {diff.file && (
                            <div className="flex items-center justify-between gap-2 border-b border-gn-prompt-border/30 px-3 pb-2 font-mono text-[11.5px] text-gn-cyan">
                              <span className="truncate">diff · {diff.file.path}</span>
                              {diff.file.additions > 0 || diff.file.deletions > 0 ? (
                                <span className="shrink-0 text-gn-gutter">
                                  +{diff.file.additions} −{diff.file.deletions}
                                </span>
                              ) : null}
                            </div>
                          )}
                          {diff.note && (
                            <div className="bg-gn-bg-base/20 px-3 py-1 font-mono text-[10.5px] text-gn-gutter">
                              {diff.note}
                            </div>
                          )}
                          {diff.rows.length === 0 ? (
                            <div className="px-4 py-4 font-mono text-[12px] text-gn-muted">
                              （无 diff 内容）
                            </div>
                          ) : (
                            diff.blocks?.map((block, bi) => (
                              <div key={bi} className="my-1 border-y border-gn-prompt-border/20">
                                {block.header !== 'File Header' && (
                                  <div className="flex items-center justify-between gap-2 border-b border-gn-prompt-border/40 bg-gn-bg-base/80 px-2.5 py-1">
                                    <span className="truncate font-mono text-[11px] text-gn-cyan/90 select-all">
                                      {block.header}
                                    </span>
                                    {selectedPath &&
                                      selectedRow?.status !== 'staged' &&
                                      block.header !== 'New File' && (
                                        <button
                                          type="button"
                                          onClick={() => onStageHunk(block)}
                                          disabled={busy}
                                          className="ml-2 shrink-0 rounded border border-gn-green/30 bg-gn-bg-highlight px-2 py-1 text-[10px] text-gn-green transition-colors hover:bg-gn-green/20 sm:py-0.5"
                                          title="将当前这块改动加入暂存区"
                                        >
                                          暂存此块
                                        </button>
                                      )}
                                  </div>
                                )}
                                {block.rows.map((r, ri) => (
                                  <DiffRowView key={ri} kind={r.kind} text={r.text} />
                                ))}
                              </div>
                            )) ??
                            diff.rows.map((r, i) => (
                              <DiffRowView key={i} kind={r.kind} text={r.text} />
                            ))
                          )}
                        </div>
                      ) : (
                        <div className="flex h-full min-h-48 flex-col items-center justify-center gap-1 px-6 text-center font-mono text-[12px] text-gn-muted">
                          <span>选择左侧文件查看 diff</span>
                          <span className="text-[10.5px] text-gn-gutter">
                            点击文件名预览改动，使用 + / − 暂存或取消暂存
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )  )
}
