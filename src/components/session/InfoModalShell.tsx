import { X } from 'lucide-react'
import type { ReactNode, RefObject } from 'react'
import { UsageInfoTabs, type UsageInfoTabId } from './UsageInfoTabs'

/**
 * /context · /session-info 两个弹窗共用的外框：遮罩、面板、标题栏（含关闭
 * 按钮）与 usage-info 标签栏。Esc 关闭与打开时聚焦面板仍由各 modal 自己管，
 * 因为那边同时要发起数据请求。
 */
export function InfoModalFrame({
  open,
  ariaLabel,
  title,
  maxWidth,
  panelRef,
  tab,
  onClose,
  children,
}: {
  open: boolean
  ariaLabel: string
  title: string
  maxWidth: number
  panelRef: RefObject<HTMLDivElement | null>
  tab: UsageInfoTabId
  onClose: () => void
  children: ReactNode
}) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center gn-modal-dim p-4"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="mt-8 w-full gn-modal-panel"
        style={{ maxWidth }}
      >
        <header className="gn-modal-header">
          <span className="font-mono text-[13px] font-bold text-gn-fg">{title}</span>
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
        <UsageInfoTabs active={tab} />

        <div className="py-1">{children}</div>
      </div>
    </div>
  )
}

/**
 * 请求三态的统一呈现：loading / error + 重试 / empty。三者都不成立时渲染
 * children（各 modal 自己的内容）。
 */
export function InfoModalState({
  loading,
  error,
  empty,
  emptyText,
  onRetry,
  children,
}: {
  loading: boolean
  error?: string
  empty: boolean
  emptyText: string
  onRetry: () => void
  children: ReactNode
}) {
  if (loading) {
    return (
      <div className="px-4 py-6 text-center text-[12px] text-gn-muted">加载中…</div>
    )
  }
  if (error) {
    return (
      <div className="px-4 py-5 text-center">
        <div className="text-[12px] text-gn-red">{error}</div>
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
        >
          重试
        </button>
      </div>
    )
  }
  if (empty) {
    return <div className="px-4 py-6 text-center text-[12px] text-gn-muted">{emptyText}</div>
  }
  return <>{children}</>
}
