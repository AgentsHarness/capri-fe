import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw, Trash2, Plus } from 'lucide-react'
import { transport } from '../../api/client'
import { useChatStore } from '../../store/chat'
import type { GuestSessionItem, GuestTokenRecord, HostInfo } from '../../api/types'
import {
  GUEST_EXPIRY_OPTIONS,
  formatGuestExpiry,
  guestExpiryFromNow,
  guestShareLink,
} from '../../api/rpc/guestTokens'
import { pushToast } from '../../store/toast'
import { CopyButton } from './ShareGuestModal'

/**
 * 设置 → 分享：访客令牌管理。
 *
 * 「右键会话 → 分享」负责单会话快速加白；这里负责整体管理（改标签/到期、
 * 吊销、删除、增删会话、刷新标题）。两处共用 hub 的同一份 guests.json。
 */
export function GuestTokensPanel() {
  const mode = transport.getConnectionMode()
  const [tokens, setTokens] = useState<GuestTokenRecord[] | null>(null)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newExpiry, setNewExpiry] = useState('1d')
  const [editing, setEditing] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [editExpiry, setEditExpiry] = useState('forever')

  const load = useCallback(async () => {
    if (mode !== 'hub') return
    setError(undefined)
    try {
      setTokens(await transport.listGuestTokens())
    } catch (e) {
      setTokens([])
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [mode])

  useEffect(() => {
    void load()
  }, [load])

  const replaceToken = (next: GuestTokenRecord) => {
    setTokens((prev) => (prev ?? []).map((t) => (t.id === next.id ? next : t)))
  }

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

  if (mode !== 'hub') {
    return (
      <div className="px-4 py-6 text-center text-[12px] leading-relaxed text-gn-muted">
        仅 Hub 模式支持分享。
        <span className="mt-1 block text-[11px]">
          本地直连模式没有 hub 承载会话白名单，无法生成访客链接。
        </span>
      </div>
    )
  }

  return (
    <section className="pb-2">
      <div className="flex flex-wrap items-center gap-2 border-b border-gn-prompt-border/50 px-3 py-2 sm:px-4">
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="inline-flex min-h-7 items-center gap-1 rounded bg-gn-cyan/15 px-2 py-1 text-[11.5px] font-medium text-gn-cyan hover:bg-gn-cyan/25"
        >
          <Plus size={12} strokeWidth={2.5} aria-hidden />
          新建令牌
        </button>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex min-h-7 items-center gap-1 rounded px-2 py-1 text-[11.5px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          title="重新读取令牌列表"
        >
          <RefreshCw size={12} strokeWidth={2.5} aria-hidden />
          刷新列表
        </button>
        <span className="ml-auto text-[10.5px] text-gn-gutter">
          {tokens ? `${tokens.length} 个令牌` : ''}
        </span>
      </div>

      {creating && (
        <div className="flex flex-wrap items-center gap-2 border-b border-gn-prompt-border/40 px-3 py-2 sm:px-4">
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="标签（给小王）"
            aria-label="新令牌标签"
            className="min-h-7 min-w-0 flex-1 rounded border border-gn-prompt-border bg-gn-bg-base px-2 py-1 text-[11.5px] text-gn-fg outline-none focus:border-gn-cyan sm:max-w-[16rem]"
          />
          <select
            value={newExpiry}
            onChange={(e) => setNewExpiry(e.target.value)}
            aria-label="新令牌有效期"
            className="min-h-7 rounded border border-gn-prompt-border bg-gn-bg-base px-2 py-1 text-[11.5px] text-gn-fg outline-none focus:border-gn-cyan"
          >
            {GUEST_EXPIRY_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy === 'create'}
            onClick={() =>
              void run('create', async () => {
                const secs = GUEST_EXPIRY_OPTIONS.find((o) => o.id === newExpiry)?.seconds ?? 0
                const created = await transport.createGuestToken({
                  label: newLabel.trim() || '访客令牌',
                  expiresAt: guestExpiryFromNow(secs),
                })
                setTokens((prev) => [...(prev ?? []), created])
                setCreating(false)
                setNewLabel('')
                setExpanded(created.id)
                pushToast('访客令牌已创建', { type: 'success' })
              })
            }
            className="inline-flex min-h-7 items-center rounded bg-gn-bg-highlight px-2.5 py-1 text-[11.5px] font-medium text-gn-fg hover:bg-gn-bg-highlight/80 disabled:opacity-50"
          >
            创建
          </button>
        </div>
      )}

      {error && <div className="px-3 py-2 text-[11.5px] text-gn-red sm:px-4">{error}</div>}

      {tokens == null ? (
        <div className="px-4 py-6 text-center text-[12px] text-gn-muted">加载令牌…</div>
      ) : tokens.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] leading-relaxed text-gn-muted">
          还没有访客令牌。
          <span className="mt-1 block text-[11px]">
            也可以在会话上右键 →「分享只读链接」快速创建。
          </span>
        </div>
      ) : (
        tokens.map((t) => {
          const open = expanded === t.id
          return (
            <div key={t.id} className="border-b border-gn-prompt-border/40 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2 px-3 py-2 sm:px-4">
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : t.id)}
                  aria-expanded={open}
                  className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  {open ? (
                    <ChevronDown size={12} strokeWidth={2.5} className="shrink-0 text-gn-gutter" aria-hidden />
                  ) : (
                    <ChevronRight size={12} strokeWidth={2.5} className="shrink-0 text-gn-gutter" aria-hidden />
                  )}
                  <span className="min-w-0 truncate text-[12px] font-medium text-gn-fg">
                    {t.label}
                  </span>
                  {t.revoked ? (
                    <span className="shrink-0 rounded bg-gn-diff-del-bg px-1 py-px text-[10px] text-gn-red">
                      已吊销
                    </span>
                  ) : null}
                </button>
                <span className="shrink-0 text-[10.5px] text-gn-muted">
                  {t.sessions.length} 个会话 · {formatGuestExpiry(t.expiresAt)}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <CopyButton text={guestShareLink(t.token)} label="链接" />
                  <CopyButton text={t.token} label="密钥" />
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(editing === t.id ? null : t.id)
                      setEditLabel(t.label)
                      setEditExpiry(
                        GUEST_EXPIRY_OPTIONS.find((o) => o.seconds === t.expiresAt)?.id ??
                          'forever',
                      )
                    }}
                    className="inline-flex min-h-7 items-center rounded px-2 py-1 text-[11px] text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    disabled={busy === `revoke:${t.id}` || t.revoked}
                    onClick={() =>
                      void run(`revoke:${t.id}`, async () => {
                        replaceToken(await transport.updateGuestToken({ id: t.id, revoked: true }))
                        pushToast('令牌已吊销', { type: 'success' })
                      })
                    }
                    className="inline-flex min-h-7 items-center rounded px-2 py-1 text-[11px] text-gn-yellow hover:bg-gn-bg-highlight disabled:opacity-40"
                  >
                    吊销
                  </button>
                  <button
                    type="button"
                    disabled={busy === `delete:${t.id}`}
                    onClick={() =>
                      void run(`delete:${t.id}`, async () => {
                        await transport.deleteGuestToken(t.id)
                        setTokens((prev) => (prev ?? []).filter((x) => x.id !== t.id))
                        pushToast('令牌已删除', { type: 'success' })
                      })
                    }
                    className="inline-flex min-h-7 items-center rounded px-2 py-1 text-[11px] text-gn-red hover:bg-gn-bg-highlight disabled:opacity-40"
                    aria-label="删除令牌"
                  >
                    <Trash2 size={12} strokeWidth={2.5} aria-hidden />
                  </button>
                </span>
              </div>

              {editing === t.id && (
                <div className="flex flex-wrap items-center gap-2 bg-gn-bg-dark/20 px-3 py-2 sm:px-4">
                  <input
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    aria-label="令牌标签"
                    className="min-h-7 min-w-0 flex-1 rounded border border-gn-prompt-border bg-gn-bg-base px-2 py-1 text-[11.5px] text-gn-fg outline-none focus:border-gn-cyan sm:max-w-[16rem]"
                  />
                  <select
                    value={editExpiry}
                    onChange={(e) => setEditExpiry(e.target.value)}
                    aria-label="令牌有效期"
                    className="min-h-7 rounded border border-gn-prompt-border bg-gn-bg-base px-2 py-1 text-[11.5px] text-gn-fg outline-none focus:border-gn-cyan"
                  >
                    {GUEST_EXPIRY_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={busy === `edit:${t.id}`}
                    onClick={() =>
                      void run(`edit:${t.id}`, async () => {
                        const secs =
                          GUEST_EXPIRY_OPTIONS.find((o) => o.id === editExpiry)?.seconds ?? 0
                        replaceToken(
                          await transport.updateGuestToken({
                            id: t.id,
                            label: editLabel.trim() || t.label,
                            expiresAt: guestExpiryFromNow(secs),
                          }),
                        )
                        setEditing(null)
                        pushToast('令牌已更新', { type: 'success' })
                      })
                    }
                    className="inline-flex min-h-7 items-center rounded bg-gn-bg-highlight px-2.5 py-1 text-[11.5px] font-medium text-gn-fg hover:bg-gn-bg-highlight/80 disabled:opacity-50"
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className="inline-flex min-h-7 items-center rounded px-2 py-1 text-[11.5px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  >
                    取消
                  </button>
                </div>
              )}

              {open && (
                <TokenSessions
                  token={t}
                  busy={busy}
                  onChange={replaceToken}
                  run={run}
                />
              )}
            </div>
          )
        })
      )}
    </section>
  )
}

/** 展开一个令牌：会话表 + 添加会话 + 刷新（回填标题 / stale）。 */
function TokenSessions({
  token,
  busy,
  onChange,
  run,
}: {
  token: GuestTokenRecord
  busy?: string
  onChange: (next: GuestTokenRecord) => void
  run: (key: string, fn: () => Promise<void>) => Promise<void>
}) {
  const hosts = useChatStore((s) => s.hosts)
  const refreshHosts = useChatStore((s) => s.refreshHosts)
  const [adding, setAdding] = useState(false)
  const [hostId, setHostId] = useState<string>('')
  const [sessions, setSessions] = useState<Array<{ sessionId: string; cwd?: string; title?: string }>>(
    [],
  )
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [addError, setAddError] = useState<string>()

  useEffect(() => {
    if (adding && hosts.length === 0) void refreshHosts()
  }, [adding, hosts.length, refreshHosts])

  useEffect(() => {
    if (!adding) return
    const target = hostId || hosts[0]?.hostId
    if (!target) return
    if (!hostId) {
      setHostId(target)
      return
    }
    let cancelled = false
    setLoadingSessions(true)
    setAddError(undefined)
    setPicked(new Set())
    transport
      .listHostSessions(target)
      .then((rows) => {
        if (!cancelled) setSessions(rows)
      })
      .catch((e) => {
        if (cancelled) return
        setSessions([])
        setAddError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoadingSessions(false)
      })
    return () => {
      cancelled = true
    }
  }, [adding, hostId, hosts])

  const hostName = useMemo(() => {
    const hit = hosts.find((h) => h.hostId === (hostId || hosts[0]?.hostId))
    return hit?.hostName
  }, [hosts, hostId])

  const existing = useMemo(
    () => new Set(token.sessions.map((s) => `${s.hostId}\u0000${s.sessionId}`)),
    [token.sessions],
  )

  return (
    <div className="bg-gn-bg-dark/20 px-3 pb-2 sm:px-4">
      <div className="flex flex-wrap items-center gap-2 py-1.5">
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="inline-flex min-h-7 items-center gap-1 rounded bg-gn-bg-base px-2 py-1 text-[11px] text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg"
        >
          <Plus size={11} strokeWidth={2.5} aria-hidden />
          添加会话
        </button>
        <button
          type="button"
          disabled={busy === `refresh:${token.id}`}
          onClick={() =>
            void run(`refresh:${token.id}`, async () => {
              onChange(await transport.refreshGuestToken(token.id))
              pushToast('已刷新会话标题', { type: 'success' })
            })
          }
          className="inline-flex min-h-7 items-center gap-1 rounded px-2 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-50"
          title="按 Host 的会话列表回填标题，并标记已不存在的会话"
        >
          <RefreshCw size={11} strokeWidth={2.5} aria-hidden />
          刷新
        </button>
        <span className="ml-auto font-mono text-[10px] text-gn-gutter">{token.id}</span>
      </div>

      {token.sessions.length === 0 ? (
        <div className="py-1 text-[11px] text-gn-muted">该令牌没有任何会话。</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-left">
            <thead>
              <tr className="text-[10px] tracking-wide text-gn-gutter">
                <th className="py-1 pr-2 font-normal">Host</th>
                <th className="py-1 pr-2 font-normal">标题</th>
                <th className="py-1 pr-2 font-normal">cwd</th>
                <th className="py-1 pr-2 font-normal">加入时间</th>
                <th className="py-1 font-normal" />
              </tr>
            </thead>
            <tbody>
              {token.sessions.map((s) => (
                <tr
                  key={`${s.hostId}:${s.sessionId}`}
                  className={`border-t border-gn-prompt-border/30 text-[11px] ${
                    s.stale ? 'text-gn-gutter' : 'text-gn-fg2'
                  }`}
                >
                  <td className="max-w-[8rem] truncate py-1 pr-2" title={s.hostId}>
                    {s.hostName || s.hostId}
                  </td>
                  <td
                    className="max-w-[12rem] truncate py-1 pr-2"
                    title={s.stale ? '该会话已不存在' : s.title || s.sessionId}
                  >
                    {s.title || s.sessionId.slice(0, 12)}
                    {s.stale && <span className="ml-1 text-[10px] text-gn-yellow">已失效</span>}
                  </td>
                  <td className="max-w-[12rem] truncate py-1 pr-2 font-mono text-[10.5px]" title={s.cwd}>
                    {s.cwd || '—'}
                  </td>
                  <td className="whitespace-nowrap py-1 pr-2 text-[10.5px]">
                    {s.addedAt ? formatGuestExpiry(s.addedAt) : '—'}
                  </td>
                  <td className="py-1 text-right">
                    <button
                      type="button"
                      onClick={() =>
                        void run(`remove:${token.id}:${s.sessionId}`, async () => {
                          onChange(
                            await transport.removeGuestSessions(token.id, [
                              { hostId: s.hostId, sessionId: s.sessionId },
                            ]),
                          )
                        })
                      }
                      className="inline-flex min-h-6 items-center rounded px-1.5 py-0.5 text-[10.5px] text-gn-red hover:bg-gn-bg-highlight"
                    >
                      移除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <div className="mt-1 rounded border border-gn-prompt-border/60 bg-gn-bg-base/60 p-2">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={hostId}
              onChange={(e) => setHostId(e.target.value)}
              aria-label="选择 Host"
              className="min-h-7 rounded border border-gn-prompt-border bg-gn-bg-base px-2 py-1 text-[11px] text-gn-fg outline-none focus:border-gn-cyan"
            >
              {hosts.map((h: HostInfo) => (
                <option key={h.hostId} value={h.hostId}>
                  {h.hostName || h.hostId}
                </option>
              ))}
            </select>
            <span className="text-[10.5px] text-gn-muted">
              {loadingSessions ? '加载会话…' : `${sessions.length} 个会话`}
            </span>
            <button
              type="button"
              disabled={picked.size === 0 || loadingSessions}
              onClick={() =>
                void run(`add:${token.id}`, async () => {
                  const items: GuestSessionItem[] = sessions
                    .filter((s) => picked.has(s.sessionId))
                    .map((s) => ({
                      hostId: hostId || hosts[0]?.hostId || '',
                      ...(hostName ? { hostName } : {}),
                      sessionId: s.sessionId,
                      ...(s.cwd ? { cwd: s.cwd } : {}),
                      ...(s.title ? { title: s.title } : {}),
                    }))
                  onChange(await transport.addGuestSessions(token.id, items))
                  setPicked(new Set())
                  setAdding(false)
                })
              }
              className="ml-auto inline-flex min-h-7 items-center rounded bg-gn-bg-highlight px-2.5 py-1 text-[11px] font-medium text-gn-fg hover:bg-gn-bg-highlight/80 disabled:opacity-50"
            >
              加入 {picked.size > 0 ? `(${picked.size})` : ''}
            </button>
          </div>
          {addError && <div className="mt-1 text-[10.5px] text-gn-red">{addError}</div>}
          <div className="mt-1 max-h-40 overflow-y-auto">
            {sessions.length === 0 && !loadingSessions && !addError && (
              <div className="py-1 text-[10.5px] text-gn-muted">该 Host 没有会话。</div>
            )}
            {sessions.map((s) => {
              const key = `${hostId || hosts[0]?.hostId}\u0000${s.sessionId}`
              const dup = existing.has(key)
              return (
                <label
                  key={s.sessionId}
                  className={`flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-gn-bg-highlight/60 ${
                    dup ? 'opacity-50' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={dup || picked.has(s.sessionId)}
                    disabled={dup}
                    onChange={(e) => {
                      const next = new Set(picked)
                      if (e.target.checked) next.add(s.sessionId)
                      else next.delete(s.sessionId)
                      setPicked(next)
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-gn-fg2">
                    {s.title || s.sessionId.slice(0, 12)}
                  </span>
                  {dup && <span className="shrink-0 text-[10px] text-gn-gutter">已加入</span>}
                </label>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

