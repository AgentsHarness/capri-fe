import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatStore } from '../store/chat'
import { transport, type SettingsPatch, type SettingsPayload } from '../api/client'
import {
  applyCollapsedEditBlocksFromCache,
  bumpReseedGen,
  currentAgentStamp,
  effectivePermissionLabelFromUi,
  markReseeded,
  syncDefaultModeFlagsFromUi,
  type PermissionModeLabel,
} from '../store/chat/modeFlags'
import { applyUiSettings } from '../store/settings'
import { pushToast } from '../store/toast'
import { CustomModelsPanel } from './CustomModelsPanel'

const GROUPS = [
  { key: 'ui', label: 'UI' },
  { key: 'session', label: 'Session' },
  { key: 'models', label: 'Models' },
  { key: 'cli', label: 'CLI' },
] as const

/** FE-consumed [ui] scalars — edited above, not dumped as raw keys. */
const CONSUMED_UI_KEYS = new Set([
  'permission_mode',
  'approval_mode',
  'yolo',
  'collapsed_edit_blocks',
  'page_flip_on_send',
  'remember_tool_approvals',
])

const PERM_CHOICES: { id: PermissionModeLabel; label: string }[] = [
  { id: 'ask', label: 'ask' },
  { id: 'auto', label: 'auto' },
  { id: 'always-approve', label: 'always-approve' },
]

const BOOL_ROWS: {
  key: keyof Pick<
    SettingsPatch,
    'page_flip_on_send' | 'collapsed_edit_blocks' | 'remember_tool_approvals'
  >
  label: string
  hint: string
  dflt: boolean
}[] = [
  {
    key: 'page_flip_on_send',
    label: '发送后翻页',
    hint: '发出 prompt 后把它钉到视口顶部',
    dflt: true,
  },
  {
    key: 'collapsed_edit_blocks',
    label: '折叠编辑块',
    hint: '开：diff 收成 +N/−M 一行（已有行立即收起）；同文件连续合并只作用于新到达的 edit。关：每条 diff 默认展开',
    dflt: false,
  },
  {
    key: 'remember_tool_approvals',
    label: '记住工具审批',
    hint: '审批条显示「始终允许」选项',
    dflt: false,
  },
]

/**
 * Settings modal — web counterpart of the TUI `/settings` modal (F2).
 *
 * Data comes from GET /api/settings (safe subset of config.toml).
 * The four FE-consumed [ui] scalars are editable (POST /api/settings);
 * remaining keys stay read-only. Permission_mode / yolo / approval_mode
 * collapse to one effective default.
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
  const [savingKey, setSavingKey] = useState<string>()
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
          <span className="font-mono text-[10.5px] text-gn-gutter">v{__APP_VERSION__}</span>
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
          ) : (
            <>
              <ConsumedSettings
                ui={data?.ui}
                savingKey={savingKey}
                disabled={!!savingKey}
                onPatch={async (patch) => {
                  const key = Object.keys(patch)[0] ?? 'settings'
                  setSavingKey(key)
                  try {
                    const next = await transport.updateSettings(patch)
                    setData(next)
                    const ui = next.ui ?? {}
                    applyUiSettings(ui)
                    applyCollapsedEditBlocksFromCache(useChatStore.setState)
                    syncDefaultModeFlagsFromUi(ui)
                    if (patch.permission_mode) {
                      await applyLivePermission(patch.permission_mode)
                    }
                  } catch (e) {
                    pushToast(e instanceof Error ? e.message : String(e))
                  } finally {
                    setSavingKey(undefined)
                  }
                }}
              />
              {sections.map((g) => {
                const group = data?.[g.key] ?? {}
                const rows = Object.entries(group)
                  .filter(([k]) => g.key !== 'ui' || !CONSUMED_UI_KEYS.has(k))
                  .sort(([a], [b]) => a.localeCompare(b))
                if (rows.length === 0) return null
                return (
                  <section key={g.key} className="border-b border-gn-prompt-border/50 py-1 last:border-b-0">
                    <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider text-gn-gutter">
                      [{g.key}] {g.label}
                    </div>
                    {rows.map(([k, v]) => (
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
              })}
            </>
          )}
          {/* 自定义模型（[model.*]）可视化编辑 — 独立于 /api/settings。 */}
          <CustomModelsPanel />
        </div>
      </div>
    </div>
  )
}

function readUiBool(
  ui: Record<string, unknown> | undefined,
  key: string,
  dflt: boolean,
): boolean {
  const v = ui?.[key]
  return typeof v === 'boolean' ? v : dflt
}

async function applyLivePermission(mode: PermissionModeLabel): Promise<void> {
  bumpReseedGen()
  const sid = useChatStore.getState().sessionId
  if (mode === 'always-approve') {
    let ok = false
    for (const id of ['always-approve', 'always_approve', 'yolo']) {
      try {
        await transport.setMode(id, sid)
        ok = true
        break
      } catch {
        /* try next host-build id */
      }
    }
    if (!ok) throw new Error('默认已写入，但当前会话未能切到 always-approve')
    useChatStore.setState({
      yoloMode: true,
      autoMode: false,
      permissionMode: 'always-approve',
    })
    markReseeded(currentAgentStamp())
    return
  }
  try {
    await transport.setMode(mode === 'auto' ? 'auto' : 'normal', sid)
  } catch {
    throw new Error(
      mode === 'auto'
        ? '默认已写入，但当前会话未能切到 auto'
        : '默认已写入，但当前会话未能切到 ask',
    )
  }
  useChatStore.setState({
    yoloMode: false,
    autoMode: mode === 'auto',
    permissionMode: mode === 'auto' ? 'auto' : undefined,
  })
  markReseeded(currentAgentStamp())
}

function ConsumedSettings({
  ui,
  savingKey,
  disabled,
  onPatch,
}: {
  ui?: Record<string, unknown>
  savingKey?: string
  disabled: boolean
  onPatch: (patch: SettingsPatch) => Promise<void>
}) {
  const perm = effectivePermissionLabelFromUi(ui)
  return (
    <section className="border-b border-gn-prompt-border/50 py-1">
      <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider text-gn-gutter">
        本端行为
      </div>
      <div className="flex items-start gap-3 px-4 py-1.5">
        <span className="w-48 shrink-0 pt-0.5 font-mono text-[11.5px] text-gn-muted">
          permission_mode
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap gap-1">
            {PERM_CHOICES.map((c) => {
              const on = perm === c.id
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={disabled || on}
                  onClick={() => void onPatch({ permission_mode: c.id })}
                  className={`rounded-full border px-2 py-px text-[10.5px] ${
                    on
                      ? 'border-gn-green/60 text-gn-green'
                      : 'border-gn-prompt-border text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg'
                  } disabled:opacity-50`}
                >
                  {c.label}
                </button>
              )
            })}
          </div>
          <div className="mt-1 text-[10.5px] leading-snug text-gn-gutter">
            新会话 / agent 启动默认；改动同时应用到当前会话。
          </div>
        </div>
      </div>
      {BOOL_ROWS.map((row) => {
        const on = readUiBool(ui, row.key, row.dflt)
        const busy = savingKey === row.key
        return (
          <div key={row.key} className="flex items-start gap-3 px-4 py-1.5">
            <span className="w-48 shrink-0 pt-0.5 font-mono text-[11.5px] text-gn-muted" title={row.key}>
              {row.key}
            </span>
            <div className="min-w-0 flex-1">
              <button
                type="button"
                disabled={disabled}
                onClick={() => void onPatch({ [row.key]: !on })}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-px text-[10.5px] ${
                  on
                    ? 'border-gn-green/60 text-gn-green'
                    : 'border-gn-prompt-border text-gn-muted'
                } hover:bg-gn-bg-highlight disabled:opacity-50`}
                title={row.hint}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${on ? 'bg-gn-green' : 'bg-gn-gutter'}`}
                />
                {busy ? '…' : on ? 'on' : 'off'}
              </button>
              <div className="mt-0.5 text-[10.5px] leading-snug text-gn-gutter">
                {row.label} · {row.hint}
              </div>
            </div>
          </div>
        )
      })}
    </section>
  )
}

/**
 * One setting value: booleans render as a switch-style read-only badge
 * (on = green, off = gray); objects/arrays collapse to JSON; scalars as
 * plain text. Remaining dump rows stay read-only.
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
