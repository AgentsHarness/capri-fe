import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { useChatStore } from '../store/chat'
import { transport, type SettingsPatch, type SettingsPayload } from '../api/client'
import {
  applyCollapsedEditBlocksFromCache,
  bumpReseedGen,
  currentAgentStamp,
  effectivePermissionLabelFromUi,
  markReseeded,
  persistConfirmedPermission,
  syncDefaultModeFlagsFromUi,
  type PermissionModeLabel,
} from '../store/chat/modeFlags'
import { applyUiSettings, applyToolsetSettings } from '../store/settings'
import { pushToast } from '../store/toast'
import { historyViaHubRelay, useFePrefs, useLiteReplay } from '../store/historyPins'
import { CustomModelsPanel } from './CustomModelsPanel'
import {
  loadDefaultSelectedPermission,
  saveDefaultSelectedPermission,
  type DefaultSelectedPermission,
} from '../lib/defaultSelectedPermission'

/** host config.toml 的分组（GET /api/settings 的形状）——合并成一个只读分类展示。 */
const GROUPS = [
  { key: 'ui', label: '界面' },
  { key: 'session', label: '会话' },
  { key: 'models', label: '模型' },
  { key: 'cli', label: 'CLI' },
] as const

/** 左侧分类键：四个可编辑分类 + 一个只读的 Agent 配置（有内容才出现）。 */
type CategoryKey = 'behavior' | 'ask' | 'fe' | 'custom' | 'agent'

type Category = {
  key: CategoryKey
  /** 桌面端左栏按钮文案（同时是右侧面板标题）。 */
  label: string
  /** 移动端顶部 Tab 标签（精炼短文案，占满一屏无需横向滑动）。 */
  shortLabel: string
  /** 面板顶部一句说明。 */
  desc: string
}

/** FE-consumed [ui] scalars — edited above, not dumped as raw keys. */
const CONSUMED_UI_KEYS = new Set([
  'permission_mode',
  'approval_mode',
  'yolo',
  'collapsed_edit_blocks',
  'page_flip_on_send',
  'remember_tool_approvals',
  'follow_up_behavior',
])

const PERM_CHOICES: { id: PermissionModeLabel; label: string }[] = [
  { id: 'ask', label: '询问' },
  { id: 'auto', label: '自动' },
  { id: 'always-approve', label: '始终允许' },
]

/** TUI [ui].follow_up_behavior choices (queue default; steer = mid-turn). */
const FOLLOW_UP_CHOICES: { id: 'queue' | 'steer'; label: string }[] = [
  { id: 'queue', label: '排队' },
  { id: 'steer', label: '引导' },
]

/** 审批弹窗默认选中行四选一（canonical 与 TUI 一致；顺序对齐设置面板与
 *  审批弹窗的渲染顺序 YOLO → allow-always → allow-once → reject）。 */
const DEFAULT_SELECTED_PERMISSION_UI: {
  id: DefaultSelectedPermission
  label: string
}[] = [
  { id: 'always_allow_all_sessions', label: '始终允许（所有会话）' },
  { id: 'allow_command_always', label: '始终允许本命令' },
  { id: 'allow_once', label: '仅允许一次' },
  { id: 'reject', label: '拒绝' },
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
    hint: '开：diff 收成 +N/−M 一行。关：每条 diff 默认展开',
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
 * Layout: a left category rail (行为偏好 / 问答超时 / 前端偏好 / 自定义模型
 * + 一个只读的「Agent 配置」，里面按 config.toml 分组分小节) and a right pane
 * rendering ONLY the selected category — the whole config dump no longer
 * stacks into one long scroll.
 * Narrow viewports fold the rail into a horizontal strip above the pane.
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
  // 选中分类跨开关保留（组件常驻挂载，Modal 关闭时只 return null）。
  const [active, setActive] = useState<CategoryKey>('behavior')
  const panelRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
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

  // 只读分组剩下的键（consumed 的 [ui] 标量在「行为偏好」分类里编辑）。
  const dumpRows = useMemo(() => {
    const out: Partial<Record<(typeof GROUPS)[number]['key'], [string, unknown][]>> = {}
    for (const g of GROUPS) {
      const group = data?.[g.key]
      if (group == null) continue
      const rows = Object.entries(group)
        .filter(([k]) => g.key !== 'ui' || !CONSUMED_UI_KEYS.has(k))
        .sort(([a], [b]) => a.localeCompare(b))
      if (rows.length > 0) out[g.key] = rows
    }
    return out
  }, [data])

  // 左栏分类：四个可编辑分类 + 一个「Agent 配置」（agent 解析的 config.toml
  // 分组，本端只读；一个分组都没有时整项不出现）。
  const cats: Category[] = useMemo(() => {
    const list: Category[] = [
      {
        key: 'behavior',
        label: '行为偏好',
        shortLabel: '行为',
        desc: '改动写回 host 配置并即时生效。',
      },
      {
        key: 'ask',
        label: '问答超时',
        shortLabel: '问答',
        desc: '提问卡片的超时策略；agent 只在会话启动时解析，改动只影响新会话。',
      },
      {
        key: 'fe',
        label: '前端偏好',
        shortLabel: '前端',
        desc: '通过 hub 同步，不写入 host config.toml。',
      },
      {
        key: 'custom',
        label: '自定义模型',
        shortLabel: '模型',
        desc: '',
      },
    ]
    if (GROUPS.some((g) => dumpRows[g.key])) {
      list.push({
        key: 'agent',
        label: 'Agent 配置',
        shortLabel: 'Agent',
        desc: 'Agent config.toml，仅展示；请在 host 侧编辑配置。',
      })
    }
    return list
  }, [dumpRows])

  // 分类固定四项恒在；选中项随数据消失（例如切到没有 [cli] 的 host）时落回首项。
  const current: Category = cats.find((c) => c.key === active) ?? cats[0]

  // 左栏 ↑↓（窄屏折成横条时 ←→）在分类间移动选中与焦点。
  const onNavKeyDown = (e: ReactKeyboardEvent) => {
    if (!NAV_MOVE_KEYS.has(e.key)) return
    const i = cats.findIndex((c) => c.key === current.key)
    if (i === -1) return
    const last = cats.length - 1
    const step =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? 1
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? -1
          : e.key === 'Home'
            ? -i
            : last - i
    const next = cats[Math.min(last, Math.max(0, i + step))]
    if (next.key === current.key) return
    e.preventDefault()
    e.stopPropagation()
    setActive(next.key)
    navRef.current
      ?.querySelector<HTMLButtonElement>(`[data-cat="${next.key}"]`)
      ?.focus()
  }

  if (!open) return null

  const onPatch = async (p: SettingsPatch) => {
    const key = Object.keys(p)[0] ?? 'settings'
    setSavingKey(key)
    try {
      const next = await transport.updateSettings(p)
      setData(next)
      const ui = next.ui ?? {}
      applyUiSettings(ui)
      applyToolsetSettings(next.toolset)
      applyCollapsedEditBlocksFromCache(useChatStore.setState)
      syncDefaultModeFlagsFromUi(ui)
      if (p.permission_mode) {
        await applyLivePermission(p.permission_mode)
      }
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingKey(undefined)
    }
  }

  const pane = () => {
    switch (current.key) {
      case 'behavior':
        return (
          <ConsumedSettings
            ui={data?.ui}
            savingKey={savingKey}
            disabled={!!savingKey}
            onPatch={onPatch}
          />
        )
      case 'ask':
        return (
          <AskTimeoutSection
            toolset={data?.toolset}
            savingKey={savingKey}
            disabled={!!savingKey}
            onPatch={onPatch}
          />
        )
      case 'fe':
        return <FePrefsSection />
      case 'custom':
        return <CustomModelsPanel />
      default:
        // 「Agent 配置」：每个 config.toml 分组一小节，键按字母序，只读。
        return (
          <section className="pb-1">
            {GROUPS.filter((g) => dumpRows[g.key]?.length).map((g) => (
              <div key={g.key} className="border-b border-gn-prompt-border/50 py-1 last:border-b-0">
                <div className="px-4 pt-1.5 pb-0.5 font-mono text-[10.5px] tracking-wide text-gn-fg2">
                  [{g.key}]
                  <span className="ml-1.5 font-ui text-gn-fg2">{g.label}</span>
                  <span className="ml-1.5 tabular-nums text-gn-muted">
                    {dumpRows[g.key]?.length}
                  </span>
                </div>
                {(dumpRows[g.key] ?? []).map(([k, v]) => (
                  <SettingRow key={k} label={k}>
                    <SettingValue value={v} />
                  </SettingRow>
                ))}
              </div>
            ))}
          </section>
        )
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center gn-modal-dim p-2 sm:p-4"
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
        className="mt-2 mb-2 flex max-h-[88dvh] w-full max-w-[560px] flex-col overflow-hidden gn-modal-panel sm:mt-8 sm:mb-4 sm:max-h-[80vh] sm:max-w-[860px]"
      >
        <header className="gn-modal-header">
          <span className="text-[13px] font-bold text-gn-fg">settings</span>
          <span className="text-gn-gutter" aria-hidden>
            ›
          </span>
          <span className="truncate text-[12px] text-gn-fg2">{current.label}</span>
          <span className="ml-auto hidden font-mono text-[10.5px] text-gn-gutter sm:inline">
            v{__APP_VERSION__}
          </span>
          <button
            type="button"
            onClick={close}
            className="ml-auto rounded px-2 py-0.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg sm:ml-0"
          >
            esc
          </button>
        </header>

        {/* 顶栏之下：移动端为顶部 Tab 栏（等宽短标签，无需横向滑动），桌面端为左侧边栏。 */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col sm:flex-row">
          <nav
            ref={navRef}
            role="tablist"
            aria-label="设置分类"
            onKeyDown={onNavKeyDown}
            className="gn-no-scrollbar shrink-0 overflow-x-auto border-b border-gn-prompt-border bg-gn-bg-dark/30 p-1.5 sm:w-[186px] sm:overflow-x-hidden sm:overflow-y-auto sm:border-b-0 sm:border-r sm:border-gn-prompt-border/60 sm:bg-transparent sm:p-2"
          >
            <div className="flex w-full gap-1 sm:min-w-0 sm:flex-col sm:gap-0.5">
              {cats.map((c) => {
                const on = c.key === current.key
                return (
                  <button
                    key={c.key}
                    type="button"
                    role="tab"
                    data-cat={c.key}
                    aria-label={c.label}
                    aria-selected={on}
                    onClick={() => setActive(c.key)}
                    className={`flex-1 min-w-0 truncate rounded py-1.5 px-1 text-center text-[12px] transition-colors sm:flex-none sm:w-full sm:px-2 sm:py-1.5 sm:text-left ${
                      on
                        ? 'bg-gn-bg-highlight font-medium text-gn-fg'
                        : 'text-gn-muted hover:bg-gn-bg-highlight/60 hover:text-gn-fg2'
                    }`}
                    title={c.label}
                  >
                    <span className="sm:hidden">{c.shortLabel}</span>
                    <span className="hidden sm:inline">{c.label}</span>
                  </button>
                )
              })}
            </div>
          </nav>

          <div
            role="tabpanel"
            aria-label={current.label}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            {current.desc ? (
              <div className="border-b border-gn-prompt-border/50 px-3 py-1.5 text-[11px] leading-snug text-gn-fg2 sm:px-4 sm:py-2 sm:text-[10.5px]">
                {current.desc}
              </div>
            ) : null}
            {loading && !data ? (
              <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
                加载设置…
              </div>
            ) : error ? (
              <div className="px-4 py-5 text-center">
                <div className="text-[12px] text-gn-red">{error}</div>
                <button
                  type="button"
                  onClick={() => void fetchSettings()}
                  className="mt-2 rounded px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                >
                  重试
                </button>
              </div>
            ) : (
              pane()
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const NAV_MOVE_KEYS = new Set([
  'ArrowDown',
  'ArrowUp',
  'ArrowRight',
  'ArrowLeft',
  'Home',
  'End',
])

/**
 * One settings row: key + hint on the left, control on the right. Narrow
 * panes (and mobile) stack the control under the label for multi-item choices,
 * while keeping single toggles / inputs inline for a clean mobile settings layout.
 */
function SettingRow({
  label,
  hint,
  code,
  stackOnMobile = false,
  children,
}: {
  label: string
  hint?: string
  /** 配置键名，悬停可见，界面不直接展示。 */
  code?: string
  /** 移动端多选项（如 ChoicePills）强制换行堆叠，默认单控件左右同行。 */
  stackOnMobile?: boolean
  children: ReactNode
}) {
  return (
    <div
      className={`border-b border-gn-prompt-border/40 px-3 py-2.5 last:border-b-0 sm:px-4 sm:py-2.5 ${
        stackOnMobile
          ? 'flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-6'
          : 'flex items-start justify-between gap-3 sm:gap-6'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[12px] leading-snug text-gn-fg" title={code ?? label}>
          {label}
        </div>
        {hint ? (
          <div className="mt-0.5 text-[10.5px] leading-snug text-gn-fg2">{hint}</div>
        ) : null}
      </div>
      <div
        className={`flex min-w-0 shrink-0 flex-wrap items-center gap-1 sm:max-w-[58%] sm:justify-end ${
          stackOnMobile ? 'self-start pt-0.5 sm:pt-0' : 'self-center sm:self-start'
        }`}
      >
        {children}
      </div>
    </div>
  )
}

/** On/off pill button shared by the editable rows (on = green). */
function TogglePill({
  on,
  busy,
  disabled,
  title,
  onClick,
}: {
  on: boolean
  busy?: boolean
  disabled?: boolean
  title: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] transition-colors sm:px-2 sm:py-px sm:text-[10.5px] ${
        on ? 'bg-gn-bg-highlight font-medium text-gn-green' : 'text-gn-muted hover:bg-gn-bg-highlight'
      } disabled:opacity-50`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${on ? 'bg-gn-green' : 'bg-gn-gutter'}`}
      />
      {busy ? '…' : on ? 'on' : 'off'}
    </button>
  )
}

/** Radio-style pill group (current = green, clicking it is a no-op). */
function ChoicePills<T extends string>({
  choices,
  value,
  disabled,
  onPick,
}: {
  choices: readonly { id: T; label: string }[]
  value: T
  disabled?: boolean
  onPick: (id: T) => void
}) {
  return (
    <>
      {choices.map((c) => {
        const on = value === c.id
        return (
          <button
            key={c.id}
            type="button"
            disabled={disabled}
            title={on ? `当前：${c.label}` : `切到 ${c.label}`}
            onClick={() => {
              if (on) return
              onPick(c.id)
            }}
            className={`rounded px-2.5 py-1 text-[11px] transition-colors sm:px-2 sm:py-px sm:text-[10.5px] ${
              on
                ? 'bg-gn-bg-highlight font-medium text-gn-green cursor-default'
                : 'text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg'
            } disabled:opacity-50`}
          >
            {c.label}
          </button>
        )
      })}
    </>
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
    persistConfirmedPermission({
      yoloMode: true,
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
  persistConfirmedPermission(
    mode === 'auto' ? { autoMode: true, permissionMode: 'auto' } : {},
  )
  markReseeded(currentAgentStamp())
}

/** 「行为偏好」分类：permission_mode / follow_up_behavior + 三个显示开关。 */
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
  const followUp = ui?.follow_up_behavior === 'steer' ? 'steer' : 'queue'
  return (
    <section>
      <SettingRow
        label="权限默认"
        code="permission_mode"
        hint="新会话 / Agent 启动时的默认权限；改动同时应用到当前会话。"
        stackOnMobile
      >
        <ChoicePills
          choices={PERM_CHOICES}
          value={perm}
          disabled={disabled}
          onPick={(id) => void onPatch({ permission_mode: id })}
        />
      </SettingRow>
      <SettingRow
        label="忙时处理"
        code="follow_up_behavior"
        hint="引导：工具调用完成后注入（不取消回合）；排队：等当前回合结束后发送。"
        stackOnMobile
      >
        <ChoicePills
          choices={FOLLOW_UP_CHOICES}
          value={followUp}
          disabled={disabled}
          onPick={(id) => void onPatch({ follow_up_behavior: id })}
        />
      </SettingRow>
      {BOOL_ROWS.map((row) => {
        const on = readUiBool(ui, row.key, row.dflt)
        return (
          <SettingRow
            key={row.key}
            label={row.label}
            code={row.key}
            hint={row.hint}
          >
            <TogglePill
              on={on}
              busy={savingKey === row.key}
              disabled={disabled}
              title={row.hint}
              onClick={() => void onPatch({ [row.key]: !on })}
            />
          </SettingRow>
        )
      })}
    </section>
  )
}

/** `[toolset.ask_user_question]` timeout pair — TUI「Ask-Question timeout」。
 *  提示如实标注：agent 只在会话启动（agent build）时解析这两个键，改
 *  动只影响新会话。secs 缺省 = agent 默认 1800（30 分钟）。 */
const ASK_TIMEOUT_SECS_MAX = 86400

function AskTimeoutSection({
  toolset,
  savingKey,
  disabled,
  onPatch,
}: {
  toolset?: SettingsPayload['toolset']
  savingKey?: string
  disabled: boolean
  onPatch: (patch: SettingsPatch) => Promise<void>
}) {
  const aq = toolset?.ask_user_question
  // 缺省与 agent 侧 DEFAULT_ASK_USER_QUESTION_TIMEOUT_ENABLED 一致。
  const on = aq?.timeout_enabled !== false
  const secs = aq?.timeout_secs
  const busy = savingKey === 'toolset'
  const [draft, setDraft] = useState('')

  const commitSecs = () => {
    const n = Number(draft)
    if (!Number.isInteger(n) || n < 1 || n > ASK_TIMEOUT_SECS_MAX) {
      setDraft('') // 非法输入不提交，回退显示当前值
      return
    }
    setDraft('')
    void onPatch({ toolset: { ask_user_question: { timeout_secs: n } } })
  }

  return (
    <section>
      <SettingRow
        label="提问超时"
        code="toolset.ask_user_question.timeout_enabled"
        hint="开：提问超时自动放弃，agent 继续（默认开）· 只影响新会话。"
      >
        <TogglePill
          on={on}
          busy={busy}
          disabled={disabled}
          title="提问卡片超时是否武装；关 = 一直等答案"
          onClick={() =>
            void onPatch({
              toolset: { ask_user_question: { timeout_enabled: !on } },
            })
          }
        />
      </SettingRow>
      <SettingRow
        label="超时秒数"
        code="toolset.ask_user_question.timeout_secs"
        hint={`超时秒数（1–${ASK_TIMEOUT_SECS_MAX}，Enter / 失焦生效）· 只影响新会话。`}
      >
        <input
          type="number"
          min={1}
          max={ASK_TIMEOUT_SECS_MAX}
          inputMode="numeric"
          disabled={disabled}
          value={draft || (secs !== undefined ? String(secs) : '')}
          placeholder="1800"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitSecs}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitSecs()
            }
          }}
          className="w-28 rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 text-[12px] text-gn-fg outline-none placeholder:text-gn-gray focus:border-gn-magenta/50 sm:w-32"
        />
      </SettingRow>
    </section>
  )
}

/**
 * 「前端偏好」分类：FE 侧自有偏好，与置顶/待办同走 hub prefs 通道
 * （localStorage 离线缓存 + hub 广播跨端同步），不走 host config.toml。
 */
function FePrefsSection() {
  const collapseToolGroups = useFePrefs((s) => s.fePrefs.collapseToolGroups)
  const liteReplay = useLiteReplay()
  const autoTodoNewSession = useFePrefs((s) => s.fePrefs.autoTodoNewSession)
  const viaRelay = historyViaHubRelay()
  const setFePrefs = useFePrefs((s) => s.setFePrefs)
  const [defaultSelectedPermission, setDefaultSelectedPermission] = useState<
    DefaultSelectedPermission
  >(() => loadDefaultSelectedPermission())
  return (
    <section>
      <SettingRow
        label="折叠工具分组"
        code="collapse_tool_groups"
        hint="开：连续工具调用折叠成「Read 3 files」分组头，成员隐藏；关：分组默认展开、逐条显示。"
      >
        <TogglePill
          on={collapseToolGroups}
          title="控制滚动区里 toolcall 分组是否折叠，改动即时生效"
          onClick={() => setFePrefs({ collapseToolGroups: !collapseToolGroups })}
        />
      </SettingRow>
      <SettingRow
        label="精简回放"
        code="lite_replay"
        hint="仅经 Hub 中转时生效。开：先拉精简时间线再补全文，切会话更快。关：整页全量。直连本机始终全量。"
      >
        <TogglePill
          on={liteReplay}
          disabled={!viaRelay}
          title={
            viaRelay
              ? '走 hub 中转时是否精简回放，改动即时生效'
              : '当前直连 host，始终拉全量；'
          }
          onClick={() => setFePrefs({ liteReplay: !liteReplay })}
        />
      </SettingRow>
      <SettingRow
        label="新对话自动待办"
        code="auto_todo_new_session"
        hint="开：新建会话后自动标记为待办；关：新会话默认为普通状态。"
      >
        <TogglePill
          on={autoTodoNewSession}
          title="发起新对话时自动将其设为待办，改动即时生效"
          onClick={() => setFePrefs({ autoTodoNewSession: !autoTodoNewSession })}
        />
      </SettingRow>
      <SettingRow
        label="审批默认选项"
        code="default_selected_permission"
        hint="审批弹窗里默认选中哪一行。"
        stackOnMobile
      >
        <ChoicePills
          choices={DEFAULT_SELECTED_PERMISSION_UI}
          value={defaultSelectedPermission}
          onPick={(id) => {
            saveDefaultSelectedPermission(id)
            setDefaultSelectedPermission(id)
          }}
        />
      </SettingRow>
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
        className={`inline-flex items-center gap-1.5 rounded px-2 py-px text-[10.5px] ${
 value ? 'bg-gn-bg-highlight text-gn-green' : 'text-gn-muted'
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
    return (
      <span className="break-all text-right font-mono text-[11.5px] text-gn-fg">
        {String(value)}
      </span>
    )
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
    <span
      className="break-all text-right font-mono text-[11px] text-gn-fg2"
      title={text}
    >
      {text}
    </span>
  )
}
