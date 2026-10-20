import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, Link2, Share2, X } from 'lucide-react'
import { transport } from '../../api/client'
import type { GuestSessionItem, GuestTokenRecord } from '../../api/types'
import {
  GUEST_EXPIRY_OPTIONS,
  formatGuestExpiry,
  guestAccessUrl,
  guestExpiryFromNow,
  guestShareLink,
} from '../../api/rpc/guestTokens'
import { pushToast } from '../../store/toast'
import {
  registerShareGuestOpener,
  type ShareTarget,
} from '../../lib/shareGuestTarget'

export type { ShareTarget }

/** 复制按钮：成功后短暂显示「已复制」。 */
export function CopyButton({
  text,
  label = '复制',
  className = '',
}: {
  text: string
  label?: string
  className?: string
}) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 1500)
    return () => clearTimeout(t)
  }, [done])
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
        } catch {
          pushToast('复制失败：浏览器拒绝了剪贴板访问', { type: 'warning' })
        }
      }}
      className={`inline-flex min-h-7 shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg ${className}`}
      title={done ? '已复制' : `复制${label === '复制' ? '' : label}`}
    >
      {done ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} strokeWidth={2.5} />}
      {done ? '已复制' : label}
    </button>
  )
}

/** 只读的值块（链接 / token）：等宽、可换行、可滚动。 */
function ValueRow({
  title,
  value,
  mono = true,
  wrap = false,
}: {
  title: string
  value: string
  mono?: boolean
  wrap?: boolean
}) {
  return (
    <div className="border-b border-gn-prompt-border/40 px-3 py-2 last:border-b-0 sm:px-4">
      <div className="mb-1 text-[10.5px] tracking-wide text-gn-gutter">{title}</div>
      <div className="flex items-start gap-2">
        <div
          className={`min-w-0 flex-1 rounded bg-gn-bg-dark/40 px-2 py-1 text-[11.5px] leading-relaxed text-gn-fg2 ${
            mono ? 'font-mono' : ''
          } ${wrap ? 'max-h-24 overflow-auto break-all' : 'truncate'}`}
          title={value}
        >
          {value}
        </div>
        <CopyButton text={value} />
      </div>
    </div>
  )
}

type Phase = 'confirm' | 'result'

/**
 * 分享只读链接（两阶段）。
 *
 * 阶段一：选一个已有令牌或新建一个，把「这一个会话」加进它的白名单。
 * 阶段二：展示分享链接 / 访问地址 / 访客密钥，各自可复制。
 *
 * 已有令牌里若已包含该会话，跳过写入直接进结果（令牌本来就授权了它）。
 */
export function ShareGuestModal({
  target,
  onClose,
}: {
  target: ShareTarget
  onClose: () => void
}) {
  const [tokens, setTokens] = useState<GuestTokenRecord[] | null>(null)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<Phase>('confirm')
  /** 选中的已有令牌 id；'new' = 新建。 */
  const [choice, setChoice] = useState<string>('new')
  const [label, setLabel] = useState('')
  const [expiryId, setExpiryId] = useState('1d')
  const [result, setResult] = useState<GuestTokenRecord | null>(null)

  const item: GuestSessionItem = useMemo(
    () => ({
      hostId: target.hostId,
      hostName: target.hostName,
      sessionId: target.sessionId,
      cwd: target.cwd,
      ...(target.title ? { title: target.title } : {}),
    }),
    [target],
  )

  const load = useCallback(async () => {
    setError(undefined)
    try {
      const list = await transport.listGuestTokens()
      setTokens(list)
      // 默认选「新建」；已有令牌里第一个未吊销的也列出来供选。
      setChoice('new')
    } catch (e) {
      setTokens([])
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const selected = tokens?.find((t) => t.id === choice)
  const alreadyIncluded = !!selected?.sessions.some(
    (s) => s.hostId === item.hostId && s.sessionId === item.sessionId,
  )

  const confirm = async () => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      if (choice === 'new') {
        const secs = GUEST_EXPIRY_OPTIONS.find((o) => o.id === expiryId)?.seconds ?? 0
        const created = await transport.createGuestToken({
          label: label.trim() || defaultShareLabel(target),
          expiresAt: guestExpiryFromNow(secs),
          sessions: [item],
        })
        setResult(created)
      } else if (selected) {
        const next = alreadyIncluded
          ? selected
          : await transport.addGuestSessions(selected.id, [item])
        setResult(next)
      }
      setPhase('result')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const showResult = phase === 'result' && result
  const link = result ? guestShareLink(result.token) : ''
  const access = guestAccessUrl()

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center gn-modal-dim p-3 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="分享只读链接"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="my-4 flex max-h-[86dvh] w-full max-w-[520px] flex-col overflow-hidden gn-modal-panel">
        <header className="gn-modal-header">
          <Share2 size={13} className="shrink-0 text-gn-cyan" aria-hidden />
          <span className="min-w-0 truncate text-[13px] font-bold text-gn-fg">
            {showResult ? '分享链接' : '分享此会话（只读）'}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto shrink-0 rounded p-1 text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
            aria-label="关闭"
            title="关闭 (Esc)"
          >
            <X size={14} aria-hidden />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {showResult ? (
            <>
              <ValueRow title="分享链接" value={link} />
              <ValueRow title="访问地址" value={access} />
              <ValueRow title="访客密钥" value={result.token} wrap />
              <div className="px-3 py-2 text-[11px] leading-relaxed text-gn-fg2 sm:px-4">
                到期：{formatGuestExpiry(result.expiresAt)} · 可在「设置 → 分享」中吊销
              </div>
            </>
          ) : (
            <>
              <div className="border-b border-gn-prompt-border/40 px-3 py-2 text-[11.5px] leading-relaxed text-gn-fg2 sm:px-4">
                <div className="text-gn-fg">
                  会话：
                  <span className="mx-1 font-medium">
                    {target.title || target.sessionId.slice(0, 12)}
                  </span>
                  <span className="text-gn-muted">· {target.hostName}</span>
                </div>
                <div className="mt-1 text-gn-muted">
                  把这一个会话加入某个访客令牌；令牌里已有的其他会话不受影响。
                </div>
              </div>

              {tokens == null ? (
                <div className="px-4 py-5 text-center text-[12px] text-gn-muted">加载令牌…</div>
              ) : (
                <div className="px-2 py-1.5 sm:px-3">
                  <label className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-gn-bg-highlight/60">
                    <input
                      type="radio"
                      name="guest-token-choice"
                      checked={choice === 'new'}
                      onChange={() => setChoice('new')}
                      className="mt-1"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="text-[12px] text-gn-fg">新建令牌</span>
                      <span className="mt-1 flex flex-wrap items-center gap-2">
                        <input
                          value={label}
                          onChange={(e) => setLabel(e.target.value)}
                          onFocus={() => setChoice('new')}
                          placeholder={defaultShareLabel(target)}
                          aria-label="令牌标签"
                          className="min-h-7 min-w-0 flex-1 rounded border border-gn-prompt-border bg-gn-bg-base px-2 py-1 text-[11.5px] text-gn-fg outline-none focus:border-gn-cyan sm:max-w-[14rem]"
                        />
                        <select
                          value={expiryId}
                          onChange={(e) => {
                            setExpiryId(e.target.value)
                            setChoice('new')
                          }}
                          aria-label="有效期"
                          className="min-h-7 rounded border border-gn-prompt-border bg-gn-bg-base px-2 py-1 text-[11.5px] text-gn-fg outline-none focus:border-gn-cyan"
                        >
                          {GUEST_EXPIRY_OPTIONS.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </span>
                    </span>
                  </label>

                  {tokens.map((t) => (
                    <label
                      key={t.id}
                      className={`flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-gn-bg-highlight/60 ${
                        t.revoked ? 'opacity-60' : ''
                      }`}
                    >
                      <input
                        type="radio"
                        name="guest-token-choice"
                        checked={choice === t.id}
                        onChange={() => setChoice(t.id)}
                        className="mt-1"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-gn-fg">
                          <span className="min-w-0 truncate">{t.label}</span>
                          {t.revoked && (
                            <span className="rounded bg-gn-diff-del-bg px-1 py-px text-[10px] text-gn-red">
                              已吊销
                            </span>
                          )}
                        </span>
                        <span className="block text-[10.5px] text-gn-muted">
                          {t.sessions.length} 个会话 · {formatGuestExpiry(t.expiresAt)}
                        </span>
                      </span>
                    </label>
                  ))}

                  {alreadyIncluded && (
                    <div className="mt-1 rounded bg-gn-bg-highlight/50 px-2 py-1 text-[11px] text-gn-muted">
                      该令牌已包含此会话
                    </div>
                  )}
                </div>
              )}

              {error && <div className="px-3 pb-2 text-[11.5px] text-gn-red sm:px-4">{error}</div>}
            </>
          )}
        </div>

        <footer className="gn-modal-footer flex shrink-0 justify-end gap-2">
          {showResult ? (
            <button
              type="button"
              onClick={onClose}
              className="min-h-8 rounded bg-gn-bg-highlight px-3 py-1 text-[12px] font-semibold text-gn-fg hover:bg-gn-bg-highlight/80"
            >
              完成
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="min-h-8 rounded bg-gn-bg-base px-3 py-1 text-[12px] text-gn-fg2 hover:bg-gn-bg-highlight"
              >
                取消
              </button>
              <button
                type="button"
                disabled={busy || tokens == null}
                onClick={() => void confirm()}
                className="inline-flex min-h-8 items-center gap-1 rounded bg-gn-cyan/15 px-3 py-1 text-[12px] font-semibold text-gn-cyan hover:bg-gn-cyan/25 disabled:opacity-50"
              >
                <Link2 size={12} strokeWidth={2.5} aria-hidden />
                {alreadyIncluded ? '查看链接' : '确认并生成链接'}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  )
}

/**
 * 分享弹窗的宿主：右键菜单只负责把目标交给它（单例注册，避免每个会话行
 * 各挂一份 modal）。挂载在 App 的完整壳里，访客壳不挂。
 */
export function ShareGuestHost() {
  const [target, setTarget] = useState<ShareTarget | null>(null)

  useEffect(() => {
    registerShareGuestOpener(setTarget)
    return () => registerShareGuestOpener(null)
  }, [])

  if (!target) return null
  return <ShareGuestModal target={target} onClose={() => setTarget(null)} />
}

function defaultShareLabel(target: ShareTarget): string {
  return target.title ? `分享 · ${target.title}` : '访客令牌'
}

