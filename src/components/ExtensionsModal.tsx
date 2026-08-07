import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatStore } from '../store/chat'
import { transport, type ExtensionsPayload } from '../api/localTransport'

const TABS = [
  { id: 'hooks', label: 'hooks' },
  { id: 'plugins', label: 'plugins' },
  { id: 'skills', label: 'skills' },
  { id: 'marketplace', label: 'marketplace' },
] as const

/**
 * Extensions modal — web counterpart of the TUI extensions modal
 * (/hooks /plugins /skills /marketplace all open it on their own tab).
 *
 * Data comes from GET /api/extensions (host reads ~/.grok, local-only),
 * fetched once per open with an inline retry; hooks_changed /
 * plugins_changed (hooksVersion bumps) auto-refresh while open.
 * Hooks toggling has no write endpoint in the web build — clicking the
 * 启停 control shows a read-only hint instead.
 */
export function ExtensionsModal() {
  const open = useChatStore((s) => s.extensionsOpen)
  const tab = useChatStore((s) => s.extensionsTab)
  const close = useChatStore((s) => s.closeExtensions)
  const hooksVersion = useChatStore((s) => s.hooksVersion)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [data, setData] = useState<ExtensionsPayload>()
  const [hookHint, setHookHint] = useState<string>()
  const panelRef = useRef<HTMLDivElement>(null)
  const reqSeq = useRef(0)

  const fetchData = useCallback(async () => {
    const seq = ++reqSeq.current
    setLoading(true)
    setError(undefined)
    try {
      const d = await transport.extensions()
      // A newer open / hooksVersion bump superseded this one.
      if (seq === reqSeq.current) setData(d)
    } catch (e) {
      if (seq === reqSeq.current) {
        setData(undefined)
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }, [])

  // Fetch on open AND on every hooks_changed / plugins_changed bump while
  // open (hooksVersion) — a single effect covers both triggers.
  useEffect(() => {
    if (!open) return
    void fetchData()
  }, [open, hooksVersion, fetchData])

  useEffect(() => {
    if (!open) return
    setHookHint(undefined)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, close])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 backdrop-blur-[1px] p-4"
      role="dialog"
      aria-modal="true"
      aria-label="extensions"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="mt-8 w-full max-w-[560px] rounded border border-gn-prompt-border-active bg-gn-bg-base shadow-2xl outline-none"
      >
        <header className="flex items-center gap-2 rounded-t border-b border-gn-prompt-border bg-gn-bg-dark px-4 py-2.5">
          <span className="text-[13px] font-bold text-gn-fg">extensions</span>
          <span className="text-[11px] text-gn-muted">hooks · plugins · skills · marketplace</span>
          <button
            type="button"
            onClick={close}
            className="ml-auto rounded px-2 py-0.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          >
            esc
          </button>
        </header>

        {/* Tab bar */}
        <div className="flex gap-1 border-b border-gn-prompt-border px-2 pt-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                useChatStore.getState().openExtensions(t.id)
                setHookHint(undefined)
              }}
              className={`rounded-t border border-b-0 px-3 py-1.5 text-[12px] ${
                tab === t.id
                  ? 'border-gn-prompt-border bg-gn-bg-base text-gn-fg'
                  : 'border-transparent text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="max-h-[52vh] overflow-y-auto py-1">
          {loading ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              加载扩展…
            </div>
          ) : error ? (
            <div className="px-4 py-5 text-center">
              <div className="text-[12px] text-gn-red">{error}</div>
              <button
                type="button"
                onClick={() => void fetchData()}
                className="mt-2 rounded border border-gn-prompt-border px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
              >
                重试
              </button>
            </div>
          ) : tab === 'hooks' ? (
            <HooksTab data={data} hint={hookHint} onToggleClick={() => setHookHint('启停 hooks 需在 TUI/配置中修改，当前为只读')} />
          ) : tab === 'plugins' ? (
            <PluginsTab data={data} />
          ) : tab === 'skills' ? (
            <SkillsTab data={data} />
          ) : (
            <MarketplaceTab />
          )}
        </div>

        <footer className="rounded-b border-t border-gn-prompt-border px-4 py-2 text-[11px] text-gn-gutter">
          数据来自本机 ~/.grok（GET /api/extensions） · hooks/plugins 变更会自动刷新
        </footer>
      </div>
    </div>
  )
}

// ── tabs ───────────────────────────────────────────────────────────────

function HooksTab({
  data,
  hint,
  onToggleClick,
}: {
  data?: ExtensionsPayload
  hint?: string
  onToggleClick: () => void
}) {
  const hooks = data?.hooks ?? []
  return (
    <>
      {hint ? (
        <div className="mx-4 mt-2 rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1.5 text-[11px] text-gn-warning">
          {hint}
        </div>
      ) : null}
      {hooks.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
          未加载 hooks
        </div>
      ) : (
        hooks.map((h) => (
          <div key={h.name} className="flex items-start gap-2.5 border-b border-gn-prompt-border/50 px-4 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate font-mono text-[12.5px] text-gn-fg">{h.name}</span>
                {h.enabled !== undefined && (
                  <span
                    className={`shrink-0 rounded border px-1 text-[9px] leading-[14px] ${
                      h.enabled
                        ? 'border-gn-green/60 text-gn-green'
                        : 'border-gn-prompt-border text-gn-muted'
                    }`}
                  >
                    {h.enabled ? 'enabled' : 'disabled'}
                  </span>
                )}
              </div>
              {h.command ? (
                <div className="mt-0.5 truncate font-mono text-[11px] text-gn-muted" title={h.command}>
                  {h.command}
                </div>
              ) : null}
              {h.event ? (
                <div className="mt-0.5 truncate text-[11px] text-gn-gutter">event: {h.event}</div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onToggleClick}
              className="shrink-0 rounded border border-gn-prompt-border px-2 py-0.5 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
              title="web 端无写端点 — 只读"
            >
              启停
            </button>
          </div>
        ))
      )}
    </>
  )
}

function PluginsTab({ data }: { data?: ExtensionsPayload }) {
  const plugins = data?.plugins ?? []
  return (
    <>
      {plugins.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
          未安装插件
        </div>
      ) : (
        plugins.map((p) => (
          <div key={p.name} className="flex items-center gap-2.5 border-b border-gn-prompt-border/50 px-4 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate font-mono text-[12.5px] text-gn-fg">{p.name}</span>
                {p.enabled !== undefined && (
                  <span
                    className={`shrink-0 rounded border px-1 text-[9px] leading-[14px] ${
                      p.enabled
                        ? 'border-gn-green/60 text-gn-green'
                        : 'border-gn-prompt-border text-gn-muted'
                    }`}
                  >
                    {p.enabled ? 'enabled' : 'disabled'}
                  </span>
                )}
              </div>
              {p.source ? (
                <div className="mt-0.5 truncate font-mono text-[11px] text-gn-gutter" title={p.source}>
                  {p.source}
                </div>
              ) : null}
            </div>
          </div>
        ))
      )}
    </>
  )
}

function SkillsTab({ data }: { data?: ExtensionsPayload }) {
  const skills = data?.skills ?? []
  return (
    <>
      {skills.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
          未安装 skills
        </div>
      ) : (
        skills.map((s) => (
          <div
            key={s.name}
            className="border-b border-gn-prompt-border/50 px-4 py-2"
            title={s.path ? `SKILL.md: ${s.path}` : undefined}
          >
            <div className="flex items-baseline gap-2">
              <span className="truncate font-mono text-[12.5px] text-gn-fg">{s.name}</span>
              <span
                className={`shrink-0 rounded border px-1 text-[9px] leading-[14px] ${
                  s.scope === 'user'
                    ? 'border-gn-cyan/60 text-gn-cyan'
                    : s.scope === 'bundled'
                      ? 'border-gn-prompt-border text-gn-muted'
                      : 'border-gn-prompt-border text-gn-gutter'
                }`}
              >
                {s.scope ?? 'unknown'}
              </span>
            </div>
            {s.path ? (
              <div className="mt-0.5 truncate font-mono text-[11px] text-gn-gutter" title={`SKILL.md: ${s.path}`}>
                {s.path}
              </div>
            ) : null}
          </div>
        ))
      )}
    </>
  )
}

function MarketplaceTab() {
  return (
    <div className="px-4 py-4">
      <div className="rounded border border-gn-prompt-border bg-gn-bg-dark px-3 py-3 text-[12px] leading-relaxed text-gn-muted">
        <div className="mb-1 text-[11px] font-bold text-gn-fg">marketplace（占位）</div>
        市场浏览与安装依赖插件生态 API，web 端暂不可用。请使用
        TUI 的 <span className="font-mono text-gn-cyan">/marketplace</span>{' '}
        或命令行（<span className="font-mono text-gn-cyan">grok plugins install &lt;source&gt;</span>）安装插件；
        已安装的插件会在本面板的 plugins tab 中列出。
      </div>
    </div>
  )
}
