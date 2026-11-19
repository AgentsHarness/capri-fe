import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Repeat, X } from 'lucide-react'
import type { ScheduledTask } from '../../api/types'
import { formatScheduleInterval, formatScheduledFireFull } from '../../format'
import { InlineAction } from '../ui/InlineAction'

/**
 * 调度任务详情弹窗 — 点任务行打开。
 *
 * 只展示 store 里已有的四个字段（prompt / interval / nextFireAt / taskId），
 * 不额外拉 host：数据就是任务条上的那一份，删除动作与行内 `[删除]` 同源。
 * 通过 portal 挂到 body：任务条本身是 `select-none` + `overflow-y-auto`，
 * 原地渲染会被裁切且正文无法选中。
 */
export function ScheduledTaskDetailModal({
  task,
  readonly = false,
  onClose,
  onDelete,
}: {
  task: ScheduledTask | null
  /** 访客（只读）：不渲染删除动作。 */
  readonly?: boolean
  onClose: () => void
  onDelete?: (taskId: string) => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const open = task != null

  useEffect(() => {
    if (!open) return
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    panelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      restoreRef.current?.focus()
    }
  }, [open, onClose])

  if (!task) return null

  const interval = formatScheduleInterval(task.interval)
  const fire = task.nextFireAt ? formatScheduledFireFull(task.nextFireAt) : ''

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center gn-modal-dim p-4"
      role="dialog"
      aria-modal="true"
      aria-label="调度任务详情"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="mt-8 flex max-h-[min(80vh,36rem)] w-full max-w-[560px] flex-col gn-modal-panel"
      >
        <header className="gn-modal-header">
          <Repeat size={13} className="shrink-0 text-gn-plan" aria-hidden />
          <span className="font-mono text-[13px] font-bold text-gn-fg">调度任务</span>
          <span className="font-mono text-[11px] text-gn-muted">Loop</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded p-1 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
            aria-label="关闭"
            title="关闭 (Esc)"
          >
            <X size={14} aria-hidden />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <p className="m-0 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-gn-fg">
            {task.prompt || <span className="text-gn-muted">（没有 prompt）</span>}
          </p>
          <dl className="mt-4 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 border-t border-gn-prompt-border/50 pt-3 text-[12px]">
            <dt className="text-gn-muted">排期</dt>
            <dd className="min-w-0 break-words font-mono text-gn-fg2">
              {task.interval ? (
                <>
                  {task.interval}
                  {interval && interval !== task.interval && (
                    <span className="ml-1 text-gn-muted">（{interval}）</span>
                  )}
                </>
              ) : (
                <span className="text-gn-gutter">未提供</span>
              )}
            </dd>
            <dt className="text-gn-muted">下次触发</dt>
            <dd className="font-mono tabular-nums text-gn-fg2">
              {fire || <span className="text-gn-gutter">未提供</span>}
            </dd>
            <dt className="text-gn-muted">任务 ID</dt>
            <dd className="min-w-0 break-all font-mono text-[11px] text-gn-fg2">
              {task.taskId}
            </dd>
          </dl>
        </div>

        <footer className="gn-modal-footer flex items-center gap-2">
          {!readonly && onDelete && (
            <InlineAction
              label="删除"
              title="删除调度任务"
              onRun={() => {
                onDelete(task.taskId)
                onClose()
              }}
            />
          )}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto min-h-8 rounded px-2 py-1 text-[12px] text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg sm:min-h-0"
          >
            关闭
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
