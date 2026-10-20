import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Eye, RefreshCw, X } from 'lucide-react'
import { transport } from '../api/client'
import { useChatStore } from '../store/chat'
import type { SubscriberRow } from '../api/types'
import { describeUserAgent, fmtConnectedFor } from './subscriberFormat'

/**
 * 在线订阅者详情（顶栏那个数字点开的面板）。
 *
 * hub 的 `subscribers_changed` 只带条数；每个订阅者是谁、从哪来、在看哪个
 * 会话，只有 GET /api/subscribers 答得了（admin-only）。面板打开时拉一次
 * 快照，之后按 hub 推来的数字变化跟进刷新——数字没变就不重拉，切会话
 * 这类台账更新靠定时轮询兜底（订阅者面板不是实时视图，5 秒够用）。
 */

/** 台账刷新间隔：会话/地址变化不推事件，只能轮询。 */
const POLL_MS = 5000

/** 会话行显示：标题 > 短 id；会话来自白名单时用它带的 host 名。 */
function sessionLabel(row: SubscriberRow, titles: Map<string, string>): string {
  if (!row.sessionId) return '—'
  const title = titles.get(row.sessionId)
  if (title) return title
  return row.sessionId.length > 12 ? `${row.sessionId.slice(0, 12)}…` : row.sessionId
}

export function SubscribersPanel({ onClose }: { onClose: () => void }) {
  const mode = useChatStore((s) => s.mode)
  const feSubscribers = useChatStore((s) => s.feSubscribers)
  const selfId = useChatStore((s) => s.feSubscriberId)
  const sessions = useChatStore((s) => s.sessions)
  const workspaces = useChatStore((s) => s.workspaces)
  const hosts = useChatStore((s) => s.hosts)
  const [rows, setRows] = useState<SubscriberRow[] | null>(null)
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (mode !== 'hub') return
    setLoading(true)
    try {
      setRows(await transport.listSubscribers())
      setError(undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [mode])

  useEffect(() => {
    void load()
  }, [load])

  // 数字变了 = 有人连上/离开，立刻跟进（首帧由上面那条 load 负责，这里
  // 只响应之后的变化）；数字稳定时按 POLL_MS 兜底——切会话、改订阅 host
  // 都不会推事件。
  const seenCount = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (feSubscribers === undefined) return
    if (seenCount.current === undefined) {
      seenCount.current = feSubscribers
      return
    }
    if (seenCount.current === feSubscribers) return
    seenCount.current = feSubscribers
    void load()
  }, [feSubscribers, load])

  useEffect(() => {
    if (mode !== 'hub') return
    const t = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(t)
  }, [mode, load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // 会话标题：侧栏已有会话列表 → 直接查；历史里没有的（别的页在看很久
  // 以前的会话）就显示 id 前缀。
  const titles = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of sessions) if (s.title) map.set(s.sessionId, s.title)
    for (const g of workspaces) {
      for (const s of g.sessions) if (s.title && !map.has(s.sessionId)) map.set(s.sessionId, s.title)
    }
    return map
  }, [sessions, workspaces])

  const hostName = useMemo(() => {
    const map = new Map<string, string>()
    for (const h of hosts) map.set(h.hostId, h.hostName || h.hostId)
    return map
  }, [hosts])

  const now = Date.now()

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center gn-modal-dim p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="在线订阅者"
        className="my-auto flex max-h-[80vh] w-full max-w-3xl flex-col gn-modal-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="gn-modal-header">
          <Eye size={14} strokeWidth={2.2} className="shrink-0 text-gn-gutter" aria-hidden />
          <span className="shrink-0 font-mono text-[13px] font-bold text-gn-fg">在线订阅者</span>
          <span className="shrink-0 text-[11px] text-gn-muted">
            {rows ? `${rows.length} 个连接` : `${feSubscribers ?? 0} 个连接`}
          </span>
          <button
            type="button"
            disabled={loading}
            onClick={() => void load()}
            className="ml-auto inline-flex min-h-7 shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-50"
            title="重新读取订阅者名单"
          >
            <RefreshCw size={11} strokeWidth={2.5} aria-hidden />
            刷新
          </button>
          <button
            type="button"
            className="shrink-0 rounded p-1 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
            onClick={onClose}
            aria-label="关闭订阅者面板"
            title="关闭 (Esc)"
          >
            <X size={14} aria-hidden />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 sm:px-4">
          {error && <div className="py-2 text-[11.5px] text-gn-red">{error}</div>}
          {!error && rows == null && (
            <div className="py-6 text-center text-[12px] text-gn-muted">加载订阅者…</div>
          )}
          {!error && rows != null && rows.length === 0 && (
            <div className="py-6 text-center text-[12px] text-gn-muted">当前没有在线订阅者。</div>
          )}
          {rows != null && rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-left">
                <thead>
                  <tr className="text-[10px] tracking-wide text-gn-gutter">
                    <th className="py-1 pr-2 font-normal">身份</th>
                    <th className="py-1 pr-2 font-normal">地址</th>
                    <th className="py-1 pr-2 font-normal">设备</th>
                    <th className="py-1 pr-2 font-normal">Host</th>
                    <th className="py-1 pr-2 font-normal">正在查看</th>
                    <th className="py-1 font-normal">已连接</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const isThisPage = selfId != null && row.id === selfId
                    return (
                      <tr
                        key={row.id}
                        data-subscriber-id={row.id}
                        className="border-t border-gn-prompt-border/30 align-top text-[11px] text-gn-fg2"
                      >
                        <td className="py-1.5 pr-2">
                          {row.role === 'guest' ? (
                            <span className="inline-flex items-center gap-1">
                              <span className="rounded bg-gn-cyan/15 px-1 py-px text-[10px] text-gn-cyan">
                                访客
                              </span>
                              <span className="max-w-[9rem] truncate" title={row.guestId}>
                                {row.guestLabel || row.guestId || '未知令牌'}
                              </span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              <span className="rounded bg-gn-bg-highlight px-1 py-px text-[10px] text-gn-muted">
                                管理员
                              </span>
                              {isThisPage && (
                                <span className="text-[10px] text-gn-green" title="当前这个页面">
                                  本页
                                </span>
                              )}
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap py-1.5 pr-2 font-mono text-[10.5px]" title={row.ip}>
                          {row.ip || '—'}
                        </td>
                        <td className="max-w-[12rem] py-1.5 pr-2" title={row.userAgent}>
                          <span className="block truncate">{describeUserAgent(row.userAgent)}</span>
                        </td>
                        <td className="max-w-[8rem] truncate py-1.5 pr-2" title={row.hostId}>
                          {row.hostId ? hostName.get(row.hostId) || row.hostId : '—'}
                        </td>
                        <td className="max-w-[12rem] truncate py-1.5 pr-2" title={row.sessionId}>
                          {sessionLabel(row, titles)}
                        </td>
                        <td className="whitespace-nowrap py-1.5 text-[10.5px] text-gn-muted">
                          {fmtConnectedFor(now - row.connectedAt)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
