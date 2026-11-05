import { useCallback, useEffect, useState } from 'react'
import { Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { transport } from '../../api/client'
import type { UserRecord, UserTokenIssue } from '../../api/types'
import { pushToast } from '../../store/toast'
import { CopyButton } from './ShareGuestModal'
import { Spinner } from '../ui/Spinner'

/** 设置 → 用户：管理员创建用户、重置 token、删除用户。列表不显示 token。 */
export function UsersPanel() {
  const mode = transport.getConnectionMode()
  const [users, setUsers] = useState<UserRecord[] | null>(null)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [issued, setIssued] = useState<{ title: string; token: string; user: UserRecord } | null>(null)

  const load = useCallback(async () => {
    if (mode !== 'hub') return
    setError(undefined)
    try {
      setUsers(await transport.listUsers())
    } catch (e) {
      setUsers([])
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [mode])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key)
    setError(undefined)
    try {
      await fn()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      pushToast(msg, { type: 'error' })
    } finally {
      setBusy(undefined)
    }
  }

  const showIssue = (title: string, issue: UserTokenIssue) => {
    setIssued({ title, token: issue.token, user: issue.user })
    setUsers((prev) => (prev ?? []).map((u) => (u.id === issue.user.id ? issue.user : u)))
  }

  if (mode !== 'hub') {
    return <div className="px-4 py-6 text-center text-[12px] text-gn-muted">仅 Hub 模式支持用户管理。</div>
  }

  return (
    <section className="pb-2">
      <div className="flex flex-wrap items-center gap-2 border-b border-gn-prompt-border/50 px-3 py-2 sm:px-4">
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="inline-flex min-h-9 items-center gap-1 rounded bg-gn-cyan/15 px-2.5 py-1.5 text-[12px] font-medium text-gn-cyan hover:bg-gn-cyan/25 sm:min-h-7 sm:px-2 sm:py-1 sm:text-[11.5px]"
        >
          <Plus size={12} strokeWidth={2.5} aria-hidden />
          新建用户
        </button>
        <button
          type="button"
          disabled={busy === 'load'}
          onClick={() => void run('load', load)}
          className="inline-flex min-h-9 items-center gap-1 rounded px-2.5 py-1.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-7 sm:px-2 sm:py-1 sm:text-[11.5px]"
        >
          {busy === 'load' ? <Spinner size={12} /> : <RefreshCw size={12} strokeWidth={2.5} aria-hidden />}
          刷新列表
        </button>
        <span className="ml-auto text-[11px] text-gn-gutter sm:text-[10.5px]">
          {users ? `${users.length} 个用户` : ''}
        </span>
      </div>

      {creating && (
        <div className="flex flex-wrap items-center gap-2 border-b border-gn-prompt-border/40 px-3 py-2 sm:px-4">
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="用户标签（给小王）"
            aria-label="新用户标签"
            className="min-h-7 min-w-0 flex-1 rounded border border-gn-prompt-border bg-gn-bg-base px-2 py-1 text-[11.5px] text-gn-fg outline-none focus:border-gn-cyan sm:max-w-[18rem]"
          />
          <button
            type="button"
            disabled={busy != null}
            onClick={() =>
              void run('create', async () => {
                const issue = await transport.createUser(newLabel.trim() || '用户')
                setUsers((prev) => [...(prev ?? []), issue.user])
                setCreating(false)
                setNewLabel('')
                showIssue('用户已创建', issue)
              })
            }
            className="inline-flex min-h-9 items-center gap-1 rounded bg-gn-bg-highlight px-3 py-1 text-[12.5px] font-medium text-gn-fg hover:bg-gn-bg-highlight/80 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-7 sm:px-2.5 sm:text-[11.5px]"
          >
            {busy === 'create' ? <Spinner size={11} /> : null}
            创建
          </button>
        </div>
      )}

      {issued && (
        <div className="border-b border-gn-cyan/30 bg-gn-cyan/5 px-3 py-3 sm:px-4">
          <div className="mb-1 text-[12px] font-medium text-gn-cyan">{issued.title}：{issued.user.label}</div>
          <div className="mb-1 text-[11px] text-gn-muted">token 只显示这一次，关闭后无法再次查看；用户可登录后自行更换。</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-gn-bg-dark/50 px-2 py-1 font-mono text-[11.5px] text-gn-fg2">
              {issued.token}
            </code>
            <CopyButton text={issued.token} />
            <button
              type="button"
              onClick={() => setIssued(null)}
              className="min-h-7 rounded px-2 text-[11.5px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
            >
              关闭
            </button>
          </div>
        </div>
      )}

      {error && <div className="px-3 py-2 text-[11.5px] text-gn-red sm:px-4">{error}</div>}

      {users == null ? (
        <div className="px-4 py-6 text-center text-[12px] text-gn-muted">加载用户…</div>
      ) : users.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] leading-relaxed text-gn-muted">
          还没有用户。创建后把一次性 token 发给对方，对方用它登录 Hub 并配对 host。
        </div>
      ) : (
        users.map((u) => (
          <div key={u.id} className="flex flex-col gap-2 border-b border-gn-prompt-border/40 px-3 py-2.5 last:border-b-0 sm:flex-row sm:items-center sm:px-4">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] text-gn-fg">{u.label}</div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 text-[10.5px] text-gn-gutter">
                <span>{u.id}</span>
                <span>{u.hostCount} 个 host</span>
                <span>{u.lastUsedAt ? `最近使用 ${new Date(u.lastUsedAt * 1000).toLocaleString()}` : '从未使用'}</span>
              </div>
              {u.hosts && u.hosts.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {u.hosts.map((host) => (
                    <span
                      key={host.hostId}
                      className="inline-flex max-w-full items-center gap-1 rounded bg-gn-bg-dark/40 px-1.5 py-0.5 text-[10.5px] text-gn-fg2"
                      title={host.hostId}
                    >
                      <span className="truncate">{host.hostName || host.hostId}</span>
                      <span className={host.online ? 'text-gn-green' : 'text-gn-gutter'}>
                        {host.online ? '在线' : '离线'}
                      </span>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                disabled={busy != null}
                onClick={() => {
                  if (!window.confirm(`重置「${u.label}」的 token？旧 token 会立即失效。`)) return
                  void run(`reset-${u.id}`, async () => {
                    const issue = await transport.resetUserToken(u.id)
                    showIssue('token 已重置', issue)
                  })
                }}
                className="inline-flex min-h-8 items-center gap-1 rounded px-2 py-1 text-[11.5px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-40"
              >
                {busy === `reset-${u.id}` ? <Spinner size={11} /> : <RotateCcw size={12} strokeWidth={2.5} aria-hidden />}
                重置 token
              </button>
              <button
                type="button"
                disabled={busy != null}
                onClick={() => {
                  if (!window.confirm(`删除用户「${u.label}」？其名下 host 会被解除配对，操作不可恢复。`)) return
                  void run(`delete-${u.id}`, async () => {
                    await transport.deleteUser(u.id)
                    setUsers((prev) => (prev ?? []).filter((x) => x.id !== u.id))
                    pushToast('用户已删除', { type: 'success' })
                  })
                }}
                className="inline-flex min-h-8 items-center gap-1 rounded px-2 py-1 text-[11.5px] text-gn-red hover:bg-gn-red/10 disabled:opacity-40"
              >
                {busy === `delete-${u.id}` ? <Spinner size={11} /> : <Trash2 size={12} strokeWidth={2.5} aria-hidden />}
                删除
              </button>
            </div>
          </div>
        ))
      )}
    </section>
  )
}
