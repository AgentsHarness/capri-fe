import { useState } from 'react'
import { ChevronDown, ChevronRight, Minus, Plus, RotateCcw } from 'lucide-react'
import { Spinner } from '../../ui/Spinner'
import { splitPath, statusBadge, type StatusRow } from '../../../lib/gitPanel'

export function ChangeGroup({
  title,
  count,
  tone,
  action,
  children,
}: {
  title: string
  count: number
  tone: 'green' | 'yellow' | 'red'
  action?: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  if (count === 0) return null
  const toneClass =
    tone === 'green' ? 'text-gn-green' : tone === 'yellow' ? 'text-gn-yellow' : 'text-gn-red'
  return (
    <section>
      <div className="sticky top-0 z-[1] flex items-center gap-1 border-b border-gn-prompt-border/40 bg-gn-bg-base/95 px-2 py-0.5 backdrop-blur-sm">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`${open ? '折叠' : '展开'}${title}`}
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1.5 text-left hover:bg-gn-bg-highlight/60 sm:py-1"
        >
          {open ? (
            <ChevronDown size={12} className="shrink-0 text-gn-muted" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-gn-muted" />
          )}
          <span className={`text-[10.5px] font-semibold uppercase tracking-wider ${toneClass}`}>
            {title}
          </span>
          <span className="font-mono text-[10px] text-gn-muted">{count}</span>
        </button>
        {action}
      </div>
      {open ? children : null}
    </section>
  )
}

export function FileRow({
  row,
  selected,
  armed,
  busy,
  busyOp,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
}: {
  row: StatusRow
  selected: boolean
  armed: boolean
  busy: boolean
  /** 当前在飞的操作名（`stage <path>` / `unstage <path>` / `discard <path>`）。 */
  busyOp?: string
  onSelect: () => void
  onStage?: () => void
  onUnstage?: () => void
  onDiscard: (e: React.MouseEvent) => void
}) {
  const { fileName, dirPath } = splitPath(row.path)
  const statusConfig = statusBadge(row)
  const op = busyOp === `stage ${row.path}` || busyOp === `unstage ${row.path}` || busyOp === `discard ${row.path}`
  return (
    <div
      className={`group flex items-center gap-1.5 border-b border-gn-prompt-border/20 px-2.5 py-1.5 min-h-10 sm:min-h-0 sm:py-1.5 transition-colors ${
        selected
          ? 'bg-gn-bg-highlight font-medium border-l-2 border-l-gn-cyan'
          : 'border-l-2 border-l-transparent hover:bg-gn-bg-highlight/60'
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        title={row.path}
      >
        <span
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border font-mono text-[9px] font-bold ${statusConfig.className}`}
          title={statusConfig.title}
        >
          {statusConfig.label}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] sm:text-[11.5px]">
          <span className="font-medium text-gn-fg">{fileName}</span>
          {dirPath ? <span className="ml-1 text-[10px] text-gn-muted/70">{dirPath}</span> : null}
        </span>
        {(row.additions > 0 || row.deletions > 0) && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-gn-gutter">
            +{row.additions}−{row.deletions}
          </span>
        )}
      </button>

      <div className="flex shrink-0 items-center gap-0.5">
        {row.status === 'staged' ? (
          <button
            type="button"
            disabled={busy}
            aria-label="unstage"
            onClick={(e) => {
              e.stopPropagation()
              onUnstage?.()
            }}
            className="flex h-7 w-7 items-center justify-center rounded text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-40 sm:h-6 sm:w-6"
            title="取消暂存 (unstage)"
          >
            {op ? <Spinner size={12} /> : <Minus size={13} />}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            aria-label="stage"
            onClick={(e) => {
              e.stopPropagation()
              onStage?.()
            }}
            className="flex h-7 w-7 items-center justify-center rounded text-gn-green transition-colors hover:bg-gn-green/20 disabled:opacity-40 sm:h-6 sm:w-6"
            title="加入暂存 (stage)"
          >
            {op ? <Spinner size={12} /> : <Plus size={13} />}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          aria-label={armed ? '确认？' : 'discard'}
          onClick={onDiscard}
          className={`flex items-center justify-center rounded transition-colors disabled:opacity-40 ${
            armed
              ? 'h-7 px-1.5 text-[10px] font-medium bg-gn-diff-del-bg text-gn-red border border-gn-red/40 sm:h-6'
              : 'h-7 w-7 text-gn-muted hover:bg-gn-diff-del-bg hover:text-gn-red sm:h-6 sm:w-6'
          }`}
          title={armed ? '再点一次确认丢弃更改（2 秒内）' : '丢弃该文件的更改 (discard)'}
        >
          {op ? <Spinner size={12} /> : armed ? '确认？' : <RotateCcw size={13} />}
        </button>
      </div>
    </div>
  )
}
