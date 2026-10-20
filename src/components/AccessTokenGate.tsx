import { useEffect, useRef, useState } from 'react'
import { KeyRound, ShieldQuestion } from 'lucide-react'

/**
 * 全屏门禁：进应用前必须先通过这一道门。
 *
 * 这里问的**永远是「当前门禁那把」**——hub 模式是 Hub 的 `FE_TOKEN`，
 * 纯 local（Host 没配 `HUB_URL`）就是页面这台 Host 自己的钥匙。两者存在
 * 不同的槽里（见 api/credentials.ts），所以文案跟着 `local` 标志走，别在
 * 本机部署里跟用户提一个根本不存在的 Hub。
 * 密钥只保存在本机浏览器（`capri-fe-token` / `capri-fe.hostTokens`），
 * 绝不写进静态构建产物。
 */
export function AccessTokenGate({
  error,
  submitting,
  local,
  hostName,
  onSubmit,
  guest,
  onCancel,
}: {
  error?: string
  submitting?: boolean
  /** 纯 local 模式：门后没有 Hub，问的是这台机器自己的钥匙。 */
  local?: boolean
  /** local 模式下这台 Host 的展示名（拿不到时退回「本机」）。 */
  hostName?: string
  onSubmit: (token: string) => void | Promise<void>
  /** 访客令牌门禁：从 host 列表切到访客模式、本地又没存过访客令牌时出现。 */
  guest?: boolean
  /** 访客门禁的「返回管理员界面」；给了才渲染。 */
  onCancel?: () => void
}) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = () => {
    const t = value.trim()
    if (!t || submitting) return
    void onSubmit(t)
  }

  const title = guest ? '输入访客令牌' : local ? '输入本机访问密钥' : '输入访问密钥'
  const inputId = guest ? 'capri-guest-token' : 'capri-access-token'
  const label = guest ? '访客令牌' : '访问密钥'

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center bg-gn-bg-base px-4 text-gn-fg font-ui">
      <div className="w-full max-w-md gn-modal-panel p-6">
        <div className="mb-4 flex items-center gap-2 text-gn-cyan">
          {guest ? (
            <ShieldQuestion className="h-5 w-5 shrink-0" aria-hidden />
          ) : (
            <KeyRound className="h-5 w-5 shrink-0" aria-hidden />
          )}
          <h1 className="text-base font-medium tracking-tight">{title}</h1>
        </div>
        <p className="mb-4 text-[13px] leading-relaxed text-gn-muted">
          {guest ? (
            <>
              访客视图只读。请输入管理员分享给你的访客令牌（Hub 的「设置 → 分享」里
              那一把，形如 <code className="text-gn-fg2">g_…</code>
              ）——它和管理员访问密钥分开保存，切换身份不会互相覆盖。
            </>
          ) : local ? (
            <>
              这台 <code className="text-gn-fg2">{hostName || '本机 Host'}</code>{' '}
              的接口启用了访问控制。请输入它部署时配置的密钥（
              <code className="text-gn-fg2">FE_TOKEN</code>
              ）——这里没有 Hub，只问这一把。密钥只保存在本机浏览器，不会写入服务器静态文件。
            </>
          ) : (
            <>
              此 Hub 已启用访问控制。请输入部署时配置的密钥（
              <code className="text-gn-fg2">FE_TOKEN</code>
              ）。密钥只保存在本机浏览器，不会写入服务器静态文件。
            </>
          )}
        </p>
        <label className="mb-1 block text-[12px] text-gn-gray" htmlFor={inputId}>
          {label}
        </label>
        <input
          id={inputId}
          ref={inputRef}
          type="password"
          autoComplete="current-password"
          spellCheck={false}
          value={value}
          disabled={submitting}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={guest ? '粘贴访客令牌…' : '粘贴 FE_TOKEN…'}
          className="mb-3 w-full rounded-md border border-gn-prompt-border bg-gn-bg-base px-3 py-2 font-mono text-[13px] text-gn-fg outline-none placeholder:text-gn-gray-dim focus:border-gn-prompt-border-active"
        />
        {error ? (
          <p className="mb-3 text-[12px] text-gn-red" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 rounded px-3 py-2 text-[13px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
              title="留在管理员界面"
            >
              返回
            </button>
          ) : null}
          <button
            type="button"
            disabled={!value.trim() || submitting}
            onClick={submit}
            className="flex-1 rounded px-3 py-2 text-[13px] text-gn-cyan hover:bg-gn-bg-highlight disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? '验证中…' : guest ? '进入访客视图' : '进入'}
          </button>
        </div>
      </div>
    </div>
  )
}
