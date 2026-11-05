import { useEffect, useState } from 'react'
import { KeyRound, RefreshCw } from 'lucide-react'
import { transport } from '../../api/client'
import type { UserTokenIssue } from '../../api/types'
import { pushToast } from '../../store/toast'
import { CopyButton } from './ShareGuestModal'
import { Spinner } from '../ui/Spinner'

/** 设置 → 账号：普通用户查看自己的身份并更换 token。 */
export function AccountPanel() {
  const [label, setLabel] = useState('')
  const [id, setId] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [issued, setIssued] = useState<UserTokenIssue | null>(null)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let alive = true
    void transport
      .accessRole()
      .then((r) => {
        if (!alive || r.role !== 'user') return
        setId(r.user.id)
        setLabel(r.user.label)
      })
      .catch(() => {
        /* 角色探测失败时保留空壳，改 token 仍会由服务端校验 */
      })
    return () => {
      alive = false
    }
  }, [])

  const change = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const issue = await transport.changeMyToken(value.trim())
      setIssued(issue)
      setValue('')
      // 立即把新 token 写回本浏览器的 hub 槽，后续请求与 WS 重连都使用它。
      transport.setAccessToken(issue.token)
      pushToast('token 已更新', { type: 'success' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      pushToast(msg, { type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="pb-4">
      <div className="border-b border-gn-prompt-border/50 px-3 py-3 sm:px-4">
        <div className="flex items-center gap-2 text-gn-cyan">
          <KeyRound size={14} strokeWidth={2.5} aria-hidden />
          <span className="text-[13px] font-medium">我的访问身份</span>
        </div>
        <div className="mt-2 text-[12px] text-gn-muted">
          {label || '普通用户'}
          {id ? <span className="ml-2 font-mono text-[11px] text-gn-gutter">{id}</span> : null}
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-gn-gutter">
          当前 token 只保存在这台浏览器。修改后旧 token 立即失效，其他已登录的窗口需要重新输入新 token。
        </p>
      </div>

      {issued && (
        <div className="border-b border-gn-cyan/30 bg-gn-cyan/5 px-3 py-3 sm:px-4">
          <div className="mb-1 text-[12px] font-medium text-gn-cyan">新的 token（只显示这一次）</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-gn-bg-dark/50 px-2 py-1 font-mono text-[11.5px] text-gn-fg2">
              {issued.token}
            </code>
            <CopyButton text={issued.token} />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2 px-3 py-3 sm:px-4">
        <label className="min-w-0 flex-1 text-[11px] text-gn-gray">
          新 token（留空则生成随机 token）
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            type="password"
            autoComplete="new-password"
            placeholder="至少 16 个字符"
            className="mt-1 block w-full rounded border border-gn-prompt-border bg-gn-bg-base px-2 py-1.5 font-mono text-[12px] text-gn-fg outline-none placeholder:text-gn-gray-dim focus:border-gn-cyan"
          />
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => void change()}
          className="inline-flex min-h-9 items-center gap-1 rounded bg-gn-cyan/15 px-3 py-1.5 text-[12px] font-medium text-gn-cyan hover:bg-gn-cyan/25 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-8"
        >
          {busy ? <Spinner size={12} /> : <RefreshCw size={12} strokeWidth={2.5} aria-hidden />}
          更新 token
        </button>
      </div>
      {error && <div className="px-3 pb-2 text-[11.5px] text-gn-red sm:px-4">{error}</div>}
    </section>
  )
}
