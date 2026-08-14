import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import type { HostInfo } from '../api/types'
import { transport } from '../api/client'
import { useChatStore } from '../store/chat'
import { pushToast } from '../store/toast'

/**
 * Hub 多 Host 管理面板（TopBar 左上角 host 选择器配套）：
 * - HostActionsMenu —— 单个 host 的操作菜单（右键点击 / 行内 ⋮ 图标打开），
 *   只含菜单项：修改名称、删除（解除配对）；本机 host（hub 所在机器）
 *   不可删除。添加 Host 的唯一入口是下拉面板底部的按钮。
 * - AddHostModal —— 添加新 host：展示当前配对码、轮换出新码、复制、指引用。
 * - RenameHostModal / DeleteHostModal —— 修改 / 删除的确认与输入。
 *
 * 所有端点都是 hub 管理面（不带 ?host= 中继），仅 hub 模式可用；
 * 组件本身只在 hub 模式的 host 下拉里渲染，local 模式不会触达。
 */

/** 菜单打开位置（fixed 视口坐标，已做边缘夹取）。 */
export type HostMenuPos = { x: number; y: number }

export function HostActionsMenu({
  host,
  pos,
  onClose,
  onRename,
  onDelete,
  onRestart,
  canRestart,
}: {
  host: HostInfo
  pos: HostMenuPos
  onClose: () => void
  onRename: (h: HostInfo) => void
  onDelete: (h: HostInfo) => void
  onRestart: (h: HostInfo) => void
  /** 仅当前选中的 host 可重启（重启作用于选中 host 的 agent 进程）。 */
  canRestart: boolean
}) {
  // 菜单弹出即捕获焦点，Esc 关闭（与 TUI 菜单一致）。
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  // Portaled to body：脱离 header 的 z-40 层叠上下文，保证盖住全页面。
  return createPortal(
    <>
      <button
        type="button"
        className="fixed inset-0 z-[45] cursor-default"
        aria-label="close"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        ref={ref}
        tabIndex={-1}
        role="menu"
        className="fixed z-[46] w-44 rounded border border-gn-prompt-border bg-gn-bg-base shadow-xl py-1 outline-none"
        style={{ left: pos.x, top: pos.y }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => onRename(host)}
          className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          title="修改 Host 展示名（不影响连接与 token）"
        >
          <Pencil size={13} strokeWidth={2} aria-hidden />
          修改名称
        </button>
        {canRestart && (
          <button
            type="button"
            role="menuitem"
            onClick={() => onRestart(host)}
            className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
            title="杀掉当前 agent 进程并重新启动（恢复上次会话；在飞回合会被中断）"
          >
            <RefreshCw size={13} strokeWidth={2} aria-hidden />
            重启 Agent
          </button>
        )}
        {!host.local && (
          <button
            type="button"
            role="menuitem"
            onClick={() => onDelete(host)}
            className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-red hover:bg-gn-red/10"
            title="解除配对：吊销 token 并断开中继"
          >
            <Trash2 size={13} strokeWidth={2} aria-hidden />
            删除 Host
          </button>
        )}
      </div>
    </>,
    document.body,
  )
}

/** 通用模态外壳（与 DirectoryPickerModal 同款样式；portaled 到 body）。 */
function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 backdrop-blur-[1px] p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="mt-8 w-full max-w-[480px] rounded border border-gn-prompt-border-active bg-gn-bg-base shadow-2xl outline-none">
        <header className="flex items-center gap-2 rounded-t border-b border-gn-prompt-border bg-gn-bg-dark px-4 py-2.5">
          <span className="text-[13px] font-bold text-gn-fg">{title}</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded px-2 py-0.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
            aria-label="关闭"
          >
            ✕
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  )
}

export function RenameHostModal({
  host,
  onClose,
}: {
  host: HostInfo
  onClose: () => void
}) {
  const renameHost = useChatStore((s) => s.renameHost)
  const [value, setValue] = useState(host.hostName)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const submit = async () => {
    const name = value.trim()
    if (!name || submitting) return
    setSubmitting(true)
    const ok = await renameHost(host.hostId, name)
    setSubmitting(false)
    if (ok) onClose()
  }

  return (
    <ModalShell title="修改 Host 名称" onClose={onClose}>
      <div className="p-4">
        <p className="mb-3 text-[12px] text-gn-muted leading-snug">
          仅修改展示名（hostId 不变），不会断开连接或吊销 token。
        </p>
        <input
          ref={inputRef}
          type="text"
          value={value}
          maxLength={256}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
            if (e.key === 'Escape') onClose()
          }}
          placeholder="Host 名称…"
          className="mb-4 w-full rounded-md border border-gn-prompt-border bg-gn-bg-base px-3 py-2 font-mono text-[13px] text-gn-fg outline-none placeholder:text-gn-gray-dim focus:border-gn-prompt-border-active"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gn-prompt-border px-3 py-1.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!value.trim() || submitting}
            onClick={submit}
            className="rounded-md bg-gn-blue px-3 py-1.5 text-[12px] font-medium text-gn-bg-base transition-opacity enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

export function DeleteHostModal({
  host,
  onClose,
}: {
  host: HostInfo
  onClose: () => void
}) {
  const deleteHost = useChatStore((s) => s.deleteHost)
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    if (submitting) return
    setSubmitting(true)
    const ok = await deleteHost(host.hostId)
    setSubmitting(false)
    if (ok) onClose()
  }

  return (
    <ModalShell title="删除 Host" onClose={onClose}>
      <div className="p-4">
        <p className="text-[12px] text-gn-fg leading-snug">
          确定要解除配对并删除「<span className="text-gn-red">{host.hostName}</span>
          」吗？
        </p>
        <p className="mt-1 text-[11px] text-gn-muted leading-snug">
          删除后其 token 立即失效、中继连接被断开，该机器上的 capri-host 需重新配对才能恢复接入。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gn-prompt-border px-3 py-1.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          >
            取消
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={submit}
            className="rounded-md bg-gn-red px-3 py-1.5 text-[12px] font-medium text-gn-bg-base transition-opacity enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? '删除中…' : '删除'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

export function AddHostModal({ onClose }: { onClose: () => void }) {
  const fetchPairingCode = useChatStore((s) => s.fetchPairingCode)
  const rotatePairingCode = useChatStore((s) => s.rotatePairingCode)


  const [code, setCode] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | undefined>()
  const [ttl, setTtl] = useState<number | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rotating, setRotating] = useState(false)

  // 打开即拉当前配对码；失败可点重试。
  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetchPairingCode()
      setCode(r.code)
      setExpiresAt(r.expiresAt)
      setTtl(r.ttl)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rotate = async () => {
    if (rotating) return
    setRotating(true)
    try {
      const r = await rotatePairingCode()
      setCode(r.code)
      setExpiresAt(r.expiresAt)
    } catch {
      /* toast 已提示 */
    } finally {
      setRotating(false)
    }
  }

  const copy = async () => {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      pushToast('配对码已复制')
    } catch {
      pushToast('复制失败，请手动选择复制')
    }
  }

  const hubUrl = transport.getHubUrl() || location.origin
  const expireText = expiresAt
    ? ` ${new Date(expiresAt).toLocaleTimeString()} 过期`
    : ''

  return (
    <ModalShell title="添加 Host" onClose={onClose}>
      <div className="p-4">
        <p className="mb-2 text-[12px] text-gn-muted leading-snug">
          在要接入 hub 的新机器上启动 capri-host，填入以下配对码（每台机器一个码）：
        </p>
        {loading ? (
          <div className="mb-3 rounded-md border border-gn-prompt-border bg-gn-bg-dark px-3 py-3 text-center text-[12px] text-gn-muted">
            获取配对码中…
          </div>
        ) : error ? (
          <div className="mb-3 rounded-md border border-gn-red/30 bg-gn-red/10 px-3 py-2 text-[12px] text-gn-red" role="alert">
            {error}
            <button
              type="button"
              onClick={() => void load()}
              className="ml-2 underline underline-offset-2 hover:text-gn-fg"
            >
              重试
            </button>
          </div>
        ) : code ? (
          <>
            <div className="mb-2 flex items-center gap-2">
              <code className="flex-1 rounded-md border border-gn-prompt-border bg-gn-bg-dark px-3 py-2 font-mono text-[16px] tracking-[0.25em] text-gn-cyan select-all">
                {code}
              </code>
              <button
                type="button"
                onClick={copy}
                className="inline-flex h-9 shrink-0 items-center gap-1 rounded-md border border-gn-prompt-border px-2.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                title="复制配对码"
              >
                <Copy size={13} strokeWidth={2} aria-hidden />
                复制
              </button>
            </div>
            <div className="mb-3 text-[11px] text-gn-muted">
              {ttl ? `${ttl} 分钟内有效` : '一次性配对码'}
              {expireText} · 一个码只能配对一台机器
            </div>
          </>
        ) : null}

        <button
          type="button"
          onClick={rotate}
          disabled={rotating || !!error}
          className="mb-3 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-gn-prompt-border px-3 py-2 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:cursor-not-allowed disabled:opacity-40"
          title="轮换配对码：旧码立即失效（正在配对的机器需用新码）"
        >
          <RefreshCw size={13} strokeWidth={2} aria-hidden className={rotating ? 'animate-spin' : ''} />
          {rotating ? '生成中…' : '生成新配对码'}
        </button>

        <div className="rounded-md border border-gn-prompt-border bg-gn-bg-dark p-3">
          <div className="mb-1.5 text-[12px] text-gn-fg">新机器启动示例</div>
          <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-gn-cyan leading-relaxed">{`HUB_URL=${hubUrl} HUB_PAIR_CODE=${code ?? '<配对码>'} go run ./cmd/capri-host`}</pre>
          <div className="mt-1.5 text-[11px] text-gn-muted leading-snug">
            已配对过的机器会自动复用 ~/.capri-host/hub.json 中的 token，无需重复配对；
            HOST_TOKEN 优先级最高。
          </div>
        </div>
      </div>
    </ModalShell>
  )
}

/** 重启 Agent 确认框：杀进程会中断所有会话的在飞回合（不重试），需确认。 */
export function RestartAgentModal({
  host,
  onClose,
}: {
  host: HostInfo
  onClose: () => void
}) {
  const restartAgent = useChatStore((s) => s.restartAgent)
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    if (submitting) return
    setSubmitting(true)
    const ok = await restartAgent()
    setSubmitting(false)
    if (ok) onClose()
  }

  return (
    <ModalShell title="重启 Agent" onClose={onClose}>
      <div className="p-4">
        <p className="text-[12px] text-gn-fg leading-snug">
          确定要重启「<span className="text-gn-cyan">{host.hostName}</span>
          」的 agent 进程吗？
        </p>
        <p className="mt-1 text-[11px] text-gn-muted leading-snug">
          会中断所有会话的在飞回合（不自动重试），随后重新启动并恢复上次会话。
          通常用于 agent 卡死 / 输出通道异常等需要手动恢复的情况。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gn-prompt-border px-3 py-1.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          >
            取消
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={submit}
            className="rounded-md bg-gn-blue px-3 py-1.5 text-[12px] font-medium text-gn-bg-base transition-opacity enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? '重启中…' : '重启'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
