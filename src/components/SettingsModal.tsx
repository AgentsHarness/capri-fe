import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatStore } from '../store/chat'
import { transport, type SettingsPayload } from '../api/localTransport'

const GROUPS = [
  { key: 'ui', label: 'UI' },
  { key: 'session', label: 'Session' },
  { key: 'models', label: 'Models' },
  { key: 'cli', label: 'CLI' },
] as const

/**
 * Settings modal — web counterpart of the TUI `/settings` modal (F2).
 *
 * Data comes from GET /api/settings — a READ-ONLY safe subset of
 * config.toml (ui / session / models / cli), fetched once per open with
 * an inline retry. Booleans render as switch-style read-only badges;
 * everything else as plain key-value text. No writes: the footer states
 * edits belong in ~/.grok/config.toml.
 *
 * F2 opens the modal (mounted here, not in useScrollbackKeys — that file
 * is shared); the binding is ignored while an input/textarea is focused.
 * Esc / backdrop click close it.
 */
export function SettingsModal() {
  const open = useChatStore((s) => s.settingsOpen)
  const openSettings = useChatStore((s) => s.openSettings)
  const close = useChatStore((s) => s.closeSettings)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [data, setData] = useState<SettingsPayload>()
  const panelRef = useRef<HTMLDivElement>(null)
  const reqSeq = useRef(0)

  // F2 global binding — always mounted, opens the modal. Ignored while an
  // input/textarea/contentEditable is focused (TUI leaves F2 to the prompt).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F2' || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      const inField =
        !!target &&
        (target.tagName === 'TEXTAREA' ||
          target.tagName === 'INPUT' ||
          target.isContentEditable)
      if (inField) return
      e.preventDefault()
      openSettings()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [openSettings])

  const fetchSettings = useCallback(async () => {
    const seq = ++reqSeq.current
    setLoading(true)
    setError(undefined)
    try {
      const s = await transport.settings()
      // A newer open superseded this one (or the modal closed mid-flight).
      if (seq === reqSeq.current) setData(s)
    } catch (e) {
      if (seq === reqSeq.current) {
        setData(undefined)
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void fetchSettings()
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
  }, [open, fetchSettings, close])

  if (!open) return null

  const sections = GROUPS.filter((g) => data?.[g.key] != null)

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 backdrop-blur-[1px] p-4"
      role="dialog"
      aria-modal="true"
      aria-label="settings"
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
          <span className="text-[13px] font-bold text-gn-fg">settings</span>
          <span className="text-[11px] text-gn-muted">F2 · config.toml 只读展示</span>
          <button
            type="button"
            onClick={close}
            className="ml-auto rounded px-2 py-0.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          >
            esc
          </button>
        </header>

        <div className="max-h-[52vh] overflow-y-auto py-1">
          {loading ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              加载设置…
            </div>
          ) : error ? (
            <div className="px-4 py-5 text-center">
              <div className="text-[12px] text-gn-red">{error}</div>
              <button
                type="button"
                onClick={() => void fetchSettings()}
                className="mt-2 rounded border border-gn-prompt-border px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
              >
                重试
              </button>
            </div>
          ) : sections.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              没有可展示的设置项（host 可能尚未实现 /api/settings）
            </div>
          ) : (
            sections.map((g) => {
              const group = data?.[g.key] ?? {}
              return (
                <section key={g.key} className="border-b border-gn-prompt-border/50 py-1">
                  <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider text-gn-gutter">
                    [{g.key}] {g.label}
                  </div>
                  {Object.entries(group)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([k, v]) => (
                      <div key={k} className="flex items-start gap-3 px-4 py-1">
                        <span className="w-48 shrink-0 truncate font-mono text-[11.5px] text-gn-muted" title={k}>
                          {k}
                        </span>
                        <span className="min-w-0 flex-1">
                          <SettingValue value={v} />
                        </span>
                      </div>
                    ))}
                </section>
              )
            })
          )}
        </div>

        <footer className="rounded-b border-t border-gn-prompt-border px-4 py-2 text-[11px] text-gn-gutter">
          设置修改请在 config.toml（~/.grok/config.toml）中进行 · 当前为只读展示
        </footer>
      </div>
    </div>
  )
}

/**
 * One setting value: booleans render as a switch-style read-only badge
 * (on = green, off = gray); objects/arrays collapse to JSON; scalars as
 * plain text. No interactive controls anywhere.
 */
function SettingValue({ value }: { value: unknown }) {
  if (typeof value === 'boolean') {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-px text-[10.5px] ${
          value
            ? 'border-gn-green/60 text-gn-green'
            : 'border-gn-prompt-border text-gn-muted'
        }`}
        title={value ? 'on（只读）' : 'off（只读）'}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${value ? 'bg-gn-green' : 'bg-gn-gutter'}`}
        />
        {value ? 'on' : 'off'}
      </span>
    )
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return <span className="break-all font-mono text-[11.5px] text-gn-fg">{String(value)}</span>
  }
  if (value == null) {
    return <span className="text-[11.5px] text-gn-gutter">—</span>
  }
  let text: string
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return (
    <span className="break-all font-mono text-[11px] text-gn-gutter" title={text}>
      {text}
    </span>
  )
}
