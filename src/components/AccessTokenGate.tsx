import { useEffect, useRef, useState } from 'react'
import { KeyRound } from 'lucide-react'

/**
 * Full-screen gate: user must enter the hub FE_TOKEN before the app
 * connects. Token is stored only in localStorage (`capri-fe-token`) — never
 * baked into the static build.
 */
export function AccessTokenGate({
  error,
  submitting,
  onSubmit,
}: {
  error?: string
  submitting?: boolean
  onSubmit: (token: string) => void | Promise<void>
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

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center bg-gn-bg-base px-4 text-gn-fg font-ui">
      <div className="w-full max-w-md rounded-xl border border-gn-prompt-border bg-gn-bg-dark p-6 shadow-lg">
        <div className="mb-4 flex items-center gap-2 text-gn-cyan">
          <KeyRound className="h-5 w-5 shrink-0" aria-hidden />
          <h1 className="text-base font-medium tracking-tight">输入访问密钥</h1>
        </div>
        <p className="mb-4 text-[13px] leading-relaxed text-gn-muted">
          此 Hub 已启用访问控制。请输入部署时配置的密钥（
          <code className="text-gn-fg2">FE_TOKEN</code>
          ）。密钥只保存在本机浏览器，不会写入服务器静态文件。
        </p>
        <label className="mb-1 block text-[12px] text-gn-gray" htmlFor="capri-access-token">
          访问密钥
        </label>
        <input
          id="capri-access-token"
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
          placeholder="粘贴 FE_TOKEN…"
          className="mb-3 w-full rounded-md border border-gn-prompt-border bg-gn-bg-base px-3 py-2 font-mono text-[13px] text-gn-fg outline-none placeholder:text-gn-gray-dim focus:border-gn-prompt-border-active"
        />
        {error ? (
          <p className="mb-3 text-[12px] text-gn-red" role="alert">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          disabled={!value.trim() || submitting}
          onClick={submit}
          className="w-full rounded-md bg-gn-blue px-3 py-2 text-[13px] font-medium text-gn-bg-base transition-opacity enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? '验证中…' : '进入'}
        </button>
      </div>
    </div>
  )
}
