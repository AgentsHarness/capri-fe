import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../store/chat'
import { transport, type TerminalInfo } from '../api/localTransport'

/**
 * Terminal panel — web counterpart of the TUI's terminal pane
 * (x.ai/terminal/*; host /api/terminal/*).
 *
 * Two terminal kinds (verified against grok-build
 * extensions/terminal.rs + terminal/{pty_session,streaming_local_terminal}.rs):
 *  - piped (non-interactive) terminals: x.ai/terminal/create; output is a
 *    CUMULATIVE snapshot polled via /api/terminal/output (~1s); no SSE
 *    push exists for them. Exit is signalled by `exitStatus` in the
 *    snapshot.
 *  - PTY (interactive) terminals: x.ai/terminal/pty/create; output is
 *    PUSHED via `pty_notification` SSE events (host broadcasts
 *    x.ai/terminal/pty/notification as {type:'pty_notification',
 *    params:{terminalId, type: output|exit|process_started|process_ended,
 *    data?<base64>, outputOffset?, isReplay?, exitCode?, signal?}}).
 *    /api/terminal/output does NOT serve PTYs (agent-side they live in a
 *    different registry keyed by terminal_id alone), so they are never
 *    polled; input goes through /api/terminal/pty/input (base64 data).
 *
 * Every host call degrades to an inline error line; a 404 surfaces the
 * "host 尚未实现终端端点" hint. Raw PTY bytes are ANSI-stripped for plain
 * text display (no VTE emulator in the web shell).
 */
export function TerminalPanel({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const cwd = useChatStore((s) => s.cwd)

  // ── Terminals / outputs / selection ─────────────────────────────────
  const [terminals, setTerminals] = useState<TerminalInfo[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** Locally created commands (agent TerminalInfo has no command field). */
  const [commands, setCommands] = useState<Record<string, string>>({})
  const commandsRef = useRef<Record<string, string>>({})
  /** Raw accumulated output per terminalId (capped at OUTPUT_CAP). */
  const [outputs, setOutputs] = useState<
    Record<
      string,
      {
        text: string
        truncated: boolean
        exitCode?: number | null
        signal?: string
        busy?: boolean
      }
    >
  >({})

  const [createCmd, setCreateCmd] = useState('')
  const [creating, setCreating] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [listError, setListError] = useState<string>()
  const [error, setError] = useState<string>()
  const [input, setInput] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const outRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)

  const selected = useMemo(
    () => terminals.find((t) => t.terminalId === selectedId) ?? null,
    [terminals, selectedId],
  )

  /** GET /api/terminal/list — server is authoritative; locally created
   *  rows the server has not caught up with yet are kept. */
  const refreshList = useCallback(async () => {
    try {
      const { terminals: server } = await transport.terminalList()
      setTerminals((prev) => {
        const byId = new Map(server.map((t) => [t.terminalId, t]))
        for (const p of prev) {
          if (!byId.has(p.terminalId) && commandsRef.current[p.terminalId]) {
            byId.set(p.terminalId, {
              ...p,
              status: p.status === 'exited' ? p.status : 'connected',
            })
          }
        }
        return [...byId.values()]
      })
      setListError(undefined)
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // On open: refresh + poll the list while the panel is open (status
  // transitions show up without user interaction).
  useEffect(() => {
    if (!open) return
    void refreshList()
    const t = window.setInterval(() => void refreshList(), LIST_POLL_MS)
    return () => window.clearInterval(t)
  }, [open, refreshList])

  // Esc / backdrop close (SettingsModal skeleton) + initial focus.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  // ── PTY output: SSE pty_notification events (host pushes
  //    x.ai/terminal/pty/notification; hub relays keep the method name).
  useEffect(() => {
    if (!open) return
    return transport.onEvent((ev) => {
      // Typed carrier (host bridge.go broadcasts the pty notification as
      // {type:'pty_notification', params}) with the legacy
      // ext_notification fallback for older hosts. PtyEvent fields are
      // `unknown` and every consumer below validates with typeof, so both
      // carriers narrow through the same checks.
      let p: PtyEvent | undefined
      if (ev.type === 'pty_notification') {
        p = ev.params
      } else if (
        ev.type === 'ext_notification' &&
        ev.method === 'x.ai/terminal/pty/notification'
      ) {
        p = ev.params as PtyEvent | undefined
      }
      if (!p || typeof p !== 'object') return
      const tid = typeof p.terminalId === 'string' ? p.terminalId : ''
      const kind = typeof p.type === 'string' ? p.type : ''
      if (!tid || !kind) return

      if (kind === 'output') {
        const b64 = typeof p.data === 'string' ? p.data : ''
        if (!b64) return
        let chunk: string
        try {
          chunk = base64ToText(b64)
        } catch {
          return
        }
        setOutputs((prev) => {
          const cur = prev[tid]
          // isReplay (pty/load) replaces the whole buffer; incremental
          // chunks append.
          const base = p.isReplay === true ? '' : (cur?.text ?? '')
          const capped = capOutput(base + chunk)
          return {
            ...prev,
            [tid]: {
              text: capped.text,
              truncated: capped.truncated,
              busy: cur?.busy,
            },
          }
        })
        // A PTY created outside this panel (agent-side) still gets a row.
        setTerminals((prev) =>
          prev.some((t) => t.terminalId === tid)
            ? prev
            : [
                {
                  terminalId: tid,
                  status: 'connected',
                  interactive: true,
                  outputOffset: 0,
                  createdAt: Math.floor(Date.now() / 1000),
                },
                ...prev,
              ],
        )
        return
      }

      if (kind === 'exit') {
        const code = typeof p.exitCode === 'number' ? p.exitCode : null
        const sig =
          typeof p.signal === 'string' && p.signal ? p.signal : undefined
        setOutputs((prev) => ({
          ...prev,
          [tid]: {
            ...(prev[tid] ?? { text: '', truncated: false }),
            exitCode: code,
            ...(sig ? { signal: sig } : {}),
          },
        }))
        setTerminals((prev) =>
          prev.map((t) =>
            t.terminalId === tid
              ? { ...t, status: 'exited', ...(code != null ? { exitCode: code } : {}) }
              : t,
          ),
        )
        return
      }

      if (kind === 'process_started' || kind === 'process_ended') {
        const busy = kind === 'process_started'
        setOutputs((prev) => ({
          ...prev,
          [tid]: { ...(prev[tid] ?? { text: '', truncated: false }), busy },
        }))
      }
    })
  }, [open])

  // ── Piped output: poll the cumulative snapshot (~1s) while the
  //    selected terminal is a running non-interactive one.
  const selId = selected?.terminalId
  const selInteractive = selected?.interactive
  const selStatus = selected?.status
  useEffect(() => {
    if (!open || !selId || selInteractive || selStatus === 'exited') return
    let stopped = false
    let timer: number | undefined
    const tick = async () => {
      if (stopped) return
      try {
        const out = await transport.terminalOutput(selId)
        if (stopped) return
        setOutputs((prev) => {
          const cur = prev[selId]
          const capped = capOutput(out.output)
          return {
            ...prev,
            [selId]: {
              text: capped.text,
              truncated: capped.truncated,
              ...(out.exitStatus
                ? {
                    exitCode: out.exitStatus.exitCode ?? null,
                    signal: out.exitStatus.signal,
                  }
                : {}),
              busy: cur?.busy,
            },
          }
        })
        if (out.exitStatus) {
          setTerminals((prev) =>
            prev.map((t) =>
              t.terminalId === selId
                ? {
                    ...t,
                    status: 'exited',
                    exitCode: out.exitStatus!.exitCode ?? null,
                  }
                : t,
            ),
          )
        }
      } catch (e) {
        // Terminal vanished (released/killed elsewhere) — surface once,
        // stop polling this terminal.
        if (stopped) return
        stopped = true
        setError(friendlyError(e))
      }
    }
    void tick()
    timer = window.setInterval(() => void tick(), POLL_INTERVAL_MS)
    return () => {
      stopped = true
      if (timer) window.clearInterval(timer)
    }
  }, [open, selId, selInteractive, selStatus])

  // ── Create (piped) ──────────────────────────────────────────────────
  const createTerminal = useCallback(async () => {
    const command = createCmd.trim()
    if (!command) return
    setCreating(true)
    setError(undefined)
    try {
      const { terminalId } = await transport.terminalCreate({
        command,
        ...(cwd ? { cwd } : {}),
      })
      commandsRef.current[terminalId] = command
      setCommands({ ...commandsRef.current })
      setCreateCmd('')
      setSelectedId(terminalId)
      setTerminals((prev) =>
        prev.some((t) => t.terminalId === terminalId)
          ? prev
          : [
              {
                terminalId,
                status: 'connected',
                interactive: false,
                outputOffset: 0,
                createdAt: Math.floor(Date.now() / 1000),
              },
              ...prev,
            ],
      )
      useChatStore.setState({ statusText: `已创建终端 ${terminalId}` })
      void refreshList()
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setCreating(false)
    }
  }, [createCmd, cwd, refreshList])

  // ── Create PTY (interactive shell in the session cwd) ───────────────
  const createPty = useCallback(async () => {
    setCreating(true)
    setError(undefined)
    try {
      const { terminalId } = await transport.terminalPtyCreate({
        ...(cwd ? { cwd } : {}),
        rows: 24,
        cols: 80,
      })
      commandsRef.current[terminalId] = 'PTY shell'
      setCommands({ ...commandsRef.current })
      setSelectedId(terminalId)
      setTerminals((prev) =>
        prev.some((t) => t.terminalId === terminalId)
          ? prev
          : [
              {
                terminalId,
                status: 'connected',
                interactive: true,
                outputOffset: 0,
                createdAt: Math.floor(Date.now() / 1000),
              },
              ...prev,
            ],
      )
      useChatStore.setState({ statusText: `已创建 PTY ${terminalId}` })
      void refreshList()
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setCreating(false)
    }
  }, [cwd, refreshList])

  // ── Actions: kill (confirm) / release / background / resize ─────────
  const killTerminal = (t: TerminalInfo) => {
    if (
      !window.confirm(
        `终止终端 ${shortId(t.terminalId)}？${t.interactive ? '交互 shell' : '运行中的进程'}将被杀死。`,
      )
    ) {
      return
    }
    setBusyId(t.terminalId)
    setError(undefined)
    transport
      .terminalKill(t.terminalId)
      .then(() => {
        useChatStore.setState({ statusText: `已终止终端 ${t.terminalId}` })
        void refreshList()
      })
      .catch((e) => setError(friendlyError(e)))
      .finally(() => setBusyId(null))
  }

  const releaseTerminal = (t: TerminalInfo) => {
    setBusyId(t.terminalId)
    setError(undefined)
    transport
      .terminalRelease(t.terminalId)
      .then(() => {
        useChatStore.setState({ statusText: `已释放终端 ${t.terminalId}` })
        void refreshList()
      })
      .catch((e) => setError(friendlyError(e)))
      .finally(() => setBusyId(null))
  }

  const backgroundTerminal = (t: TerminalInfo) => {
    if (!window.confirm(`将终端 ${shortId(t.terminalId)} 转后台？进程继续运行, agent 可继续工作。`)) return
    setBusyId(t.terminalId)
    setError(undefined)
    transport
      .terminalBackground(t.terminalId)
      .then(() => {
        useChatStore.setState({ statusText: `终端 ${t.terminalId} 已转后台` })
        void refreshList()
      })
      .catch((e) => setError(friendlyError(e)))
      .finally(() => setBusyId(null))
  }

  const resizePty = (t: TerminalInfo) => {
    setBusyId(t.terminalId)
    setError(undefined)
    transport
      .terminalPtyResize(t.terminalId, 24, 80)
      .then(() => useChatStore.setState({ statusText: `PTY ${t.terminalId} 已重置为 24×80` }))
      .catch((e) => setError(friendlyError(e)))
      .finally(() => setBusyId(null))
  }

  // ── PTY input (base64, Enter = CR) ──────────────────────────────────
  const sendInput = () => {
    if (!selected || !selected.interactive || selected.status === 'exited') return
    if (!input) return
    const data = textToBase64(input + '\r')
    setInput('')
    setError(undefined)
    void transport.terminalPtyInput(selected.terminalId, data).catch((e) =>
      setError(friendlyError(e)),
    )
  }

  // ── Output view: ANSI-stripped, auto-scroll while pinned to bottom ──
  const selOut = selected ? outputs[selected.terminalId] : undefined
  const displayText = useMemo(() => stripAnsi(selOut?.text ?? ''), [selOut?.text])
  const onOutScroll = () => {
    const el = outRef.current
    if (!el) return
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }
  useEffect(() => {
    const el = outRef.current
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight
  }, [displayText, selectedId])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 backdrop-blur-[1px] p-4"
      role="dialog"
      aria-modal="true"
      aria-label="terminal"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="mt-6 flex max-h-[86vh] w-full max-w-[900px] flex-col rounded border border-gn-prompt-border-active bg-gn-bg-base shadow-2xl outline-none"
      >
        <header className="flex items-center gap-2 rounded-t border-b border-gn-prompt-border bg-gn-bg-dark px-4 py-2.5">
          <span className="text-[13px] font-bold text-gn-fg">terminal</span>
          <span className="text-[11px] text-gn-muted">
            x.ai/terminal · piped 轮询输出 / PTY 经 SSE 推送
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded px-2 py-0.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          >
            esc
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* ── Left: create + list ─────────────────────────────────── */}
          <aside className="flex w-72 shrink-0 flex-col border-r border-gn-prompt-border">
            <div className="flex flex-col gap-1.5 border-b border-gn-prompt-border p-2">
              <div className="flex gap-1.5">
                <input
                  value={createCmd}
                  onChange={(e) => setCreateCmd(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void createTerminal()
                  }}
                  placeholder="命令 (如: ls -la)"
                  className="min-w-0 flex-1 rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 font-mono text-[11.5px] text-gn-fg outline-none placeholder:text-gn-gutter focus:border-gn-prompt-border-active"
                />
                <button
                  type="button"
                  onClick={() => void createTerminal()}
                  disabled={creating || !createCmd.trim()}
                  className="shrink-0 rounded border border-gn-prompt-border px-2 py-1 font-mono text-[11px] text-gn-fg hover:bg-gn-bg-highlight disabled:cursor-default disabled:opacity-40"
                  title="创建管道终端 (x.ai/terminal/create)"
                >
                  执行
                </button>
              </div>
              <button
                type="button"
                onClick={() => void createPty()}
                disabled={creating}
                className="rounded border border-gn-cyan/40 px-2 py-1 text-left font-mono text-[10.5px] text-gn-cyan hover:bg-gn-bg-highlight disabled:cursor-default disabled:opacity-40"
                title="创建交互式 shell PTY — 输出经 SSE 推送, 底部输入行可交互"
              >
                + 新建 PTY
              </button>
            </div>
            <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-gn-gutter">
              终端 ({terminals.length})
            </div>
            {listError && (
              <div className="px-3 pb-1 text-[10.5px] leading-snug text-gn-red">
                {friendlyError(listError)}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto pb-1">
              {terminals.length === 0 && !listError && (
                <div className="px-3 py-4 text-center text-[11px] text-gn-gutter">
                  没有终端 — 输入命令新建, 或新建 PTY
                </div>
              )}
              {terminals.map((t) => {
                const active = t.terminalId === selectedId
                return (
                  <button
                    key={t.terminalId}
                    type="button"
                    onClick={() => setSelectedId(t.terminalId)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gn-bg-highlight ${active ? 'bg-gn-bg-highlight' : ''}`}
                    title={`${commands[t.terminalId] ?? t.name ?? t.cwd ?? t.terminalId} · ${STATUS_LABEL[t.status]}${t.exitCode != null ? ` · exit ${t.exitCode}` : ''} · ${t.terminalId}`}
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(t.status)}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[11.5px] text-gn-fg">
                        {commands[t.terminalId] ?? t.name ?? t.cwd ?? shortId(t.terminalId)}
                      </span>
                      <span className="block truncate font-mono text-[9.5px] text-gn-muted">
                        {STATUS_LABEL[t.status]}
                        {t.exitCode != null ? ` · exit ${t.exitCode}` : ''}
                        {t.interactive ? ' · pty' : ''} · {fmtCreated(t.createdAt)}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </aside>

          {/* ── Right: status + output + input ───────────────────────── */}
          <section className="flex min-w-0 flex-1 flex-col">
            {selected ? (
              <>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-gn-prompt-border bg-gn-bg-dark/60 px-3 py-1.5">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(selected.status)}`}
                  />
                  <span className="max-w-[38%] truncate font-mono text-[11.5px] text-gn-cyan" title={selected.terminalId}>
                    {commands[selected.terminalId] ?? selected.name ?? selected.cwd ?? shortId(selected.terminalId)}
                  </span>
                  <span className="font-mono text-[10px] text-gn-muted">
                    {STATUS_LABEL[selected.status]}
                  </span>
                  {selected.interactive && (
                    <span className="rounded border border-gn-cyan/50 px-1 font-mono text-[9px] text-gn-cyan">
                      pty
                    </span>
                  )}
                  {selOut?.busy && (
                    <span className="font-mono text-[10px] text-gn-warning">⠋ 前台进程运行中</span>
                  )}
                  {selected.status === 'exited' && (
                    <span className="font-mono text-[10px] text-gn-green">
                      已退出 · exit {selected.exitCode ?? selOut?.exitCode ?? '?'}
                      {selOut?.signal ? ` (${selOut.signal})` : ''}
                    </span>
                  )}
                  {selected.cwd && (
                    <span
                      className="ml-auto max-w-[30%] truncate font-mono text-[10px] text-gn-gutter"
                      title={selected.cwd}
                    >
                      {selected.cwd}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 border-b border-gn-prompt-border px-3 py-1">
                  <button
                    type="button"
                    onClick={() => killTerminal(selected)}
                    disabled={busyId === selected.terminalId}
                    className="rounded border border-transparent px-1.5 py-0.5 font-mono text-[10.5px] text-gn-muted hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-red disabled:opacity-40"
                    title="x.ai/terminal/kill — 终止进程"
                  >
                    kill
                  </button>
                  <button
                    type="button"
                    onClick={() => releaseTerminal(selected)}
                    disabled={busyId === selected.terminalId}
                    className="rounded border border-transparent px-1.5 py-0.5 font-mono text-[10.5px] text-gn-muted hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-40"
                    title="x.ai/terminal/release — 释放终端（运行中的子进程会被终止）"
                  >
                    release
                  </button>
                  {!selected.interactive && selected.status !== 'exited' && (
                    <button
                      type="button"
                      onClick={() => backgroundTerminal(selected)}
                      disabled={busyId === selected.terminalId}
                      className="rounded border border-transparent px-1.5 py-0.5 font-mono text-[10.5px] text-gn-muted hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-40"
                      title="x.ai/terminal/background — 转后台, 进程继续运行"
                    >
                      background
                    </button>
                  )}
                  {selected.interactive && selected.status !== 'exited' && (
                    <button
                      type="button"
                      onClick={() => resizePty(selected)}
                      disabled={busyId === selected.terminalId}
                      className="rounded border border-transparent px-1.5 py-0.5 font-mono text-[10.5px] text-gn-muted hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-40"
                      title="x.ai/terminal/pty/resize — 重置为 24×80"
                    >
                      resize 24×80
                    </button>
                  )}
                  {busyId === selected.terminalId && (
                    <span className="ml-auto font-mono text-[10px] text-gn-muted">处理中…</span>
                  )}
                </div>
              </>
            ) : (
              <div className="border-b border-gn-prompt-border px-3 py-2 text-[11px] text-gn-gutter">
                选择左侧终端查看输出
              </div>
            )}

            {/* Output pane — groknight terminal look: dark bg, mono, white text. */}
            <div
              ref={outRef}
              onScroll={onOutScroll}
              className="min-h-0 flex-1 overflow-y-auto bg-gn-bg-dark"
            >
              {displayText ? (
                <pre className="whitespace-pre-wrap break-all px-3 py-2 font-mono text-[12px] leading-relaxed text-gn-fg">
                  {displayText}
                </pre>
              ) : (
                <div className="px-3 py-6 text-center font-mono text-[11px] text-gn-gutter">
                  {selected?.status === 'exited' ? '终端已退出, 无输出' : '等待输出…'}
                </div>
              )}
              {selected && (
                <div className="px-3 pb-2">
                  {selOut?.truncated && (
                    <div className="font-mono text-[10.5px] text-gn-warning">
                      ⚠ 输出超过 200KB, 已截断（仅保留尾部）
                    </div>
                  )}
                  {selected.status === 'exited' && (
                    <div className="font-mono text-[10.5px] text-gn-green">
                      [进程已退出] exit {selected.exitCode ?? selOut?.exitCode ?? '?'}
                      {selOut?.signal ? ` (signal ${selOut.signal})` : ''}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Inline error line — every failing host call lands here. */}
            {error && (
              <div className="border-t border-gn-prompt-border px-3 py-1.5 text-[10.5px] leading-snug text-gn-red">
                {error}
              </div>
            )}

            {/* PTY input row — Enter sends base64 bytes via pty/input. */}
            {selected?.interactive && selected.status !== 'exited' && (
              <div className="flex items-center gap-2 border-t border-gn-prompt-border px-3 py-2">
                <span className="shrink-0 font-mono text-[12px] text-gn-green" aria-hidden>
                  ❯
                </span>
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') sendInput()
                  }}
                  placeholder="输入命令 — Enter 发送（pty/input, base64）"
                  className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-gn-fg outline-none placeholder:text-gn-gutter"
                />
                <button
                  type="button"
                  onClick={sendInput}
                  disabled={!input.trim()}
                  className="shrink-0 rounded border border-gn-prompt-border px-2 py-0.5 font-mono text-[10.5px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:cursor-default disabled:opacity-40"
                >
                  发送
                </button>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

// ── Constants & helpers ────────────────────────────────────────────────

/** Output cap per terminal — keep only the tail beyond this (200KB). */
const OUTPUT_CAP = 200 * 1024
/** Piped output poll interval. */
const POLL_INTERVAL_MS = 1000
/** Terminal list refresh interval while open. */
const LIST_POLL_MS = 2000

const STATUS_LABEL: Record<TerminalInfo['status'], string> = {
  connecting: '连接中',
  connected: '运行中',
  exited: '已退出',
  error: '错误',
}

function statusDotClass(status: TerminalInfo['status']): string {
  switch (status) {
    case 'connected':
      return 'bg-gn-green'
    case 'exited':
      return 'bg-gn-gutter'
    case 'error':
      return 'bg-gn-red'
    case 'connecting':
      return 'bg-gn-yellow animate-pulse'
  }
}

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 16)}…` : id
}

function fmtCreated(unixSecs: number): string {
  if (!unixSecs) return '—'
  return new Date(unixSecs * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 404 / ok:false → friendly "host 尚未实现" hint; everything else passes. */
function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/\b404\b/.test(msg)) return `host 尚未实现终端端点 (404) — ${msg}`
  return msg
}

/**
 * pty_notification params (agent pty_session.rs: flush_output /
 * send_busy_notification / exit + pty/load replay).
 */
type PtyEvent = {
  terminalId?: unknown
  type?: unknown
  data?: unknown
  isReplay?: unknown
  exitCode?: unknown
  signal?: unknown
}

/** Cap accumulated output at OUTPUT_CAP, keeping the tail. */
function capOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= OUTPUT_CAP) return { text, truncated: false }
  return { text: text.slice(text.length - OUTPUT_CAP), truncated: true }
}

/**
 * Strip ANSI/VT escape sequences so raw PTY bytes render as plain text
 * (web has no VTE emulator; the TUI forwards raw bytes to a real terminal).
 * Built via String.fromCharCode so the source holds no control-char
 * escapes (oxlint no-control-regex).
 */
const ANSI_RE = new RegExp(
  `[${String.fromCharCode(27)}${String.fromCharCode(155)}][[()#;?]*(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-ORZcf-nqry=><]`,
  'g',
)

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

function base64ToText(b64: string): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}
