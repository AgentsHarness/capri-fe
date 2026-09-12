import { useEffect, useRef } from 'react'
import { AlertTriangle, X } from 'lucide-react'

export interface InterjectConfirmModalProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  hasQuestions: boolean
  hasPermissions: boolean
}

export function InterjectConfirmModal({
  open,
  onClose,
  onConfirm,
  hasQuestions,
  hasPermissions,
}: InterjectConfirmModalProps) {
  const cancelBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    cancelBtnRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  let message = '当前有待处理的未决任务。立即发送将中断当前回合。'
  if (hasQuestions && hasPermissions) {
    message =
      '当前有待回答的提问与待审批的工具权限。立即发送将中断当前回合，未提交的问题和权限审批将被直接作废。'
  } else if (hasQuestions) {
    message =
      'Agent 正在等待你的回答。立即发送将中断当前回合，未提交的问题将被直接作废。'
  } else if (hasPermissions) {
    message =
      '当前有待审批的工具权限。立即发送将中断当前回合并取消未审批的工具执行。'
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center gn-modal-dim p-4"
      role="dialog"
      aria-modal="true"
      aria-label="立即发送确认"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-[440px] gn-modal-panel">
        <header className="gn-modal-header flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-gn-amber" />
          <span className="text-[13px] font-bold text-gn-fg">中断当前回合确认</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded p-1 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
            aria-label="关闭"
            title="关闭 (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="space-y-4 p-4">
          <p className="text-[12.5px] leading-relaxed text-gn-fg">{message}</p>
          <div className="flex justify-end gap-2">
            <button
              ref={cancelBtnRef}
              type="button"
              onClick={onClose}
              className="rounded px-3 py-1.5 text-[12px] text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
            >
              取消
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded border border-gn-amber/40 bg-gn-amber/20 px-3 py-1.5 text-[12px] font-semibold text-gn-amber transition-colors hover:bg-gn-amber/30"
            >
              仍要立即发送
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
