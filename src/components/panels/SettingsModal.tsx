import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { ChevronRight, X } from 'lucide-react'
import { useChatStore } from '../../store/chat'
import { Spinner } from '../ui/Spinner'
import { transport, type SettingsPatch, type SettingsPayload } from '../../api/client'
import { TOOL_CALL_DENSITY_CHOICES, TOOL_CALL_DENSITY_DEFAULT } from '../../api/transport'
import {
  applyCollapsedEditBlocksFromCache,
  bumpReseedGen,
  currentAgentStamp,
  effectivePermissionLabelFromUi,
  markReseeded,
  persistConfirmedPermission,
  syncDefaultModeFlagsFromUi,
  type PermissionModeLabel,
} from '../../store/chat/modeFlags'
import { applyUiSettings, applyToolsetSettings } from '../../store/settings'
import { pushToast } from '../../store/toast'
import { historyViaHubRelay, useFePrefs, useLiteReplay } from '../../store/historyPins'
import { THOUGHT_LINES_MAX, THOUGHT_LINES_MIN } from '../../scrollback/thoughtText'
import { CustomModelsPanel } from './CustomModelsPanel'
import { GuestTokensPanel } from './GuestTokensPanel'
import {
  loadDefaultSelectedPermission,
  saveDefaultSelectedPermission,
  type DefaultSelectedPermission,
} from '../../lib/defaultSelectedPermission'

/** 已知 config.toml 表的中文名；其余表按 TOML 路径原样展示。 */
const SECTION_LABELS: Record<string, string> = {
  ui: '界面',
  session: '会话',
  models: '模型',
  cli: 'CLI',
  features: '功能',
  privacy: '隐私',
  subagents: '子代理',
  toolset: '工具',
  compaction: '压缩',
  marketplace: '插件市场',
  mcp_servers: 'MCP',
}

/** 已知表先按 TUI 顺序，其余按路径字母序。 */
const SECTION_ORDER = ['ui', 'session', 'models', 'cli']

/** 左侧分类键：会话与权限 / 外观与显示 / 模型 / 访问与分享 / 高级。 */
type CategoryKey = 'session' | 'display' | 'custom' | 'share' | 'advanced'

type Category = {
  key: CategoryKey
  /** 桌面端左栏按钮文案（同时是右侧面板标题）。 */
  label: string
  /** 移动端顶部 Tab 标签（精炼短文案，占满一屏无需横向滑动）。 */
  shortLabel: string
}

/** 高级分类里的只读 config.toml 分组。 */
type DumpSection = {
  key: string
  label?: string
  rows: [string, unknown][]
}

/** FE-consumed [ui] scalars — edited above, not dumped as raw keys.
 *  `collapsed_edit_blocks` 已退役（编辑行折叠由 tool_call_density 决定），
 *  保留在这里只是为了不把它当只读键重复列出来。 */
const CONSUMED_UI_KEYS = new Set([
  'permission_mode',
  'approval_mode',
  'yolo',
  'collapsed_edit_blocks',
  'page_flip_on_send',
  'remember_tool_approvals',
  'follow_up_behavior',
  'tool_call_density',
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

/** TUI `/density` 五档（`[ui] tool_call_density`）。 */
const DENSITY_CHOICES = TOOL_CALL_DENSITY_CHOICES.map((c) => ({
  id: c.id,
  label: c.label,
}))

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

/** `[ui] page_flip_on_send` 在「外观与显示」分类里编辑。 */
const PAGE_FLIP_ROW = {
  key: 'page_flip_on_send',
  label: '发送后翻页',
  hint: '发出 prompt 后把它钉到视口顶部',
  dflt: true,
} as const

const BOOL_ROWS: {
  key: keyof Pick<SettingsPatch, 'remember_tool_approvals'>
  label: string
  hint: string
  dflt: boolean
}[] = [
  {
    key: 'remember_tool_approvals',
    label: '记住工具审批',
    hint: '审批条显示「始终允许」选项',
    dflt: false,
  },
]

/** 侧栏目录分组名的两种显示方式（FE 偏好）。 */
const WORKSPACE_GROUP_NAME_CHOICES: { id: 'short' | 'full'; label: string }[] = [
  { id: 'short', label: '短名' },
  { id: 'full', label: '全路径' },
]

/**
 * Settings modal — web counterpart of the TUI `/settings` modal (F2).
 *
 * Data comes from GET /api/settings (every scalar config.toml table except
 * custom-model definitions).
 * The FE-consumed [ui] scalars are editable (POST /api/settings);
 * remaining keys stay read-only. Permission_mode / yolo / approval_mode
 * collapse to one effective default.
 *
 * Layout: a left category rail (会话与权限 / 外观与显示 / 模型 / 访问与分享 /
 * 高级) and a right pane rendering ONLY the selected category. 高级 holds the
 * read-only Host config.toml dump, grouped by table.
 * Narrow viewports render a full-screen sheet and fold the rail into a
 * horizontal strip above the pane.
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
  const [active, setActive] = useState<CategoryKey>('session')
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

  // 只读分组：host 返回的每张 config.toml 表各成一节。已由「会话与权限 /
  // 外观与显示」编辑的 [ui] 标量和提问超时 pair 不重复列出。
  const dumpSections = useMemo((): DumpSection[] => {
    const out: DumpSection[] = []
    for (const [key, group] of Object.entries(data ?? {})) {
      if (group == null || typeof group !== 'object' || Array.isArray(group)) continue
      const rows = Object.entries(group as Record<string, unknown>)
        .filter(
          ([k]) =>
            (key !== 'ui' || !CONSUMED_UI_KEYS.has(k)) &&
            !(key === 'toolset' && k === 'ask_user_question'),
        )
        .sort(([a], [b]) => a.localeCompare(b))
      if (rows.length > 0) out.push({ key, label: SECTION_LABELS[key], rows })
    }
    const rank = (k: string) => {
      const i = SECTION_ORDER.indexOf(k)
      return i === -1 ? SECTION_ORDER.length : i
    }
    out.sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key))
    return out
  }, [data])

  // 左栏分类：按用户任务分组，不按 config.toml 表或存储层分组。
  const cats: Category[] = useMemo(() => {
    const list: Category[] = [
      {
        key: 'session',
        label: '会话与权限',
        shortLabel: '会话',
      },
      {
        key: 'display',
        label: '外观与显示',
        shortLabel: '外观',
      },
      {
        key: 'custom',
        label: '模型',
        shortLabel: '模型',
      },
      {
        key: 'share',
        label: '访问与分享',
        shortLabel: '分享',
      },
    ]
    if (dumpSections.length > 0) {
      list.push({
        key: 'advanced',
        label: '高级',
        shortLabel: '高级',
      })
    }
    return list
  }, [dumpSections.length])

  // 分类按数据动态增减；选中项找不到时落回首项。
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
      case 'session':
        return (
          <SessionSettings
            ui={data?.ui}
            toolset={data?.toolset}
            savingKey={savingKey}
            disabled={!!savingKey}
            onPatch={onPatch}
          />
        )
      case 'display':
        return (
          <DisplaySettings
            ui={data?.ui}
            savingKey={savingKey}
            disabled={!!savingKey}
            onPatch={onPatch}
          />
        )
      case 'custom':
        return <CustomModelsPanel />
      case 'share':
        return <GuestTokensPanel />
      case 'advanced':
        return <AdvancedSettings dumpSections={dumpSections} />
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center gn-modal-dim sm:items-start sm:p-4"
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
        className="gn-settings-panel gn-modal-panel flex h-full w-full max-h-none flex-col overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:mt-8 sm:mb-4 sm:h-auto sm:max-h-[80vh] sm:max-w-[860px] sm:pt-0"
      >
        <header className="gn-modal-header">
          <span className="text-[15px] font-bold text-gn-fg sm:text-[13px]">
            <span className="sm:hidden">设置</span>
            <span className="hidden sm:inline">settings</span>
          </span>
          <ChevronRight
            size={12}
            className="hidden shrink-0 text-gn-gutter sm:block"
            aria-hidden
          />
          <span className="hidden truncate text-[12px] text-gn-fg2 sm:inline">
            {current.label}
          </span>
          <span className="ml-auto hidden font-mono text-[10.5px] text-gn-gutter sm:inline">
            v{__APP_VERSION__}
          </span>
          <button
            type="button"
            onClick={close}
            className="ml-auto inline-flex min-h-9 min-w-9 items-center justify-center rounded p-1 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg sm:ml-0 sm:min-h-0 sm:min-w-0"
            aria-label="关闭"
            title="关闭 (Esc)"
          >
            <X size={16} className="sm:h-3.5 sm:w-3.5" aria-hidden />
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
                    className={`flex min-h-10 min-w-0 flex-1 items-center justify-center truncate rounded-md px-1 text-center text-[12.5px] transition-colors focus:outline-none sm:min-h-0 sm:w-full sm:flex-none sm:justify-start sm:rounded sm:px-2 sm:py-1.5 sm:text-left sm:text-[12px] ${
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
            key={current.key}
            role="tabpanel"
            aria-label={current.label}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3 touch-pan-y sm:pb-0"
          >
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
                  className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded px-3 py-1 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg sm:min-h-0 sm:text-[11px]"
                >
                  {loading ? <Spinner size={11} /> : null}
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

/** 分类内的小节标题 + 行组。 */
function SettingsGroup({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="border-b border-gn-prompt-border/50 py-1 last:border-b-0">
      <div className="flex items-baseline gap-1.5 border-b border-gn-prompt-border/30 bg-gn-bg-base px-3 pt-2 pb-1.5 sm:border-0 sm:bg-transparent sm:px-4 sm:pt-1.5 sm:pb-0.5">
        <span className="text-[11px] font-medium tracking-wide text-gn-fg2 sm:text-[10.5px]">
          {title}
        </span>
        {hint ? (
          <span className="text-[10.5px] text-gn-gutter sm:text-[10px]">{hint}</span>
        ) : null}
      </div>
      {children}
    </div>
  )
}

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
  /** 移动端多选项（如 ChoiceTabs）强制换行堆叠，默认单控件左右同行。 */
  stackOnMobile?: boolean
  children: ReactNode
}) {
  return (
    <div
      className={`border-b border-gn-prompt-border/40 px-3 py-3 last:border-b-0 sm:px-4 sm:py-2.5 ${
        stackOnMobile
          ? 'flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6'
          : 'flex items-start justify-between gap-3 sm:gap-6'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div
          className="text-[13px] leading-snug text-gn-fg sm:text-[12px]"
          title={code ?? label}
        >
          {label}
        </div>
        {hint ? (
          <div className="mt-1 text-[11.5px] leading-relaxed text-gn-fg2 sm:mt-0.5 sm:text-[10.5px] sm:leading-snug">
            {hint}
          </div>
        ) : null}
      </div>
      <div
        className={`flex min-w-0 flex-wrap items-center gap-1.5 sm:max-w-[58%] sm:justify-end sm:gap-1 ${
          stackOnMobile
            ? 'w-full justify-end self-start sm:w-auto sm:self-center'
            : 'max-w-[52%] shrink-0 justify-end self-center'
        }`}
      >
        {children}
      </div>
    </div>
  )
}

/** 一组线条式 tab（当前项 = 绿色下划线）。 */
function SettingTabs<T extends string>({
  choices,
  value,
  disabled,
  busyId,
  ariaLabel,
  onPick,
}: {
  choices: readonly { id: T; label: string }[]
  value: T
  disabled?: boolean
  /** 正在提交的那一档：给它转圈，其余档位一起禁用。 */
  busyId?: T
  ariaLabel?: string
  onPick: (id: T) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="flex max-w-full flex-wrap items-center justify-end gap-x-1.5 gap-y-2 sm:inline-flex sm:gap-x-1 sm:gap-y-1.5"
    >
      {choices.map((c) => {
        const on = value === c.id
        const busy = busyId === c.id
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            title={on ? `当前：${c.label}` : `切到 ${c.label}`}
            onClick={() => {
              if (on) return
              onPick(c.id)
            }}
            className={`inline-flex min-h-8 shrink-0 items-center justify-center gap-1 rounded-full border px-2.5 py-1 text-[11.5px] leading-none transition-colors disabled:cursor-not-allowed sm:min-h-0 sm:px-3 sm:py-1 sm:text-[11px] ${
              on
                ? 'border-gn-green/50 bg-gn-bg-highlight font-medium text-gn-green cursor-default'
                : 'border-gn-prompt-border/60 text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg'
            } disabled:opacity-50`}
          >
            {busy ? <Spinner size={10} /> : null}
            {c.label}
          </button>
        )
      })}
    </div>
  )
}

const ON_OFF_CHOICES: readonly { id: 'on' | 'off'; label: string }[] = [
  { id: 'on', label: 'on' },
  { id: 'off', label: 'off' },
]

/** on/off 同样用一组线条式 tab 表达。 */
function ToggleTabs({
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
    <SettingTabs
      choices={ON_OFF_CHOICES}
      value={on ? 'on' : 'off'}
      ariaLabel={title}
      disabled={disabled}
      busyId={busy ? (on ? 'on' : 'off') : undefined}
      onPick={(id) => {
        if ((id === 'on') !== on) onClick()
      }}
    />
  )
}

function ChoiceTabs<T extends string>(props: {
  choices: readonly { id: T; label: string }[]
  value: T
  disabled?: boolean
  /** 正在提交的那一档：给它转圈，其余档位一起禁用。 */
  busyId?: T
  onPick: (id: T) => void
}) {
  return <SettingTabs {...props} />
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

/** 「会话与权限」分类：权限/审批、会话行为与提问卡片。 */
function SessionSettings({
  ui,
  toolset,
  savingKey,
  disabled,
  onPatch,
}: {
  ui?: Record<string, unknown>
  toolset?: SettingsPayload['toolset']
  savingKey?: string
  disabled: boolean
  onPatch: (patch: SettingsPatch) => Promise<void>
}) {
  const perm = effectivePermissionLabelFromUi(ui)
  const followUp = ui?.follow_up_behavior === 'steer' ? 'steer' : 'queue'
  const autoTodoNewSession = useFePrefs((s) => s.fePrefs.autoTodoNewSession)
  const setFePrefs = useFePrefs((s) => s.setFePrefs)
  const [defaultSelectedPermission, setDefaultSelectedPermission] = useState<
    DefaultSelectedPermission
  >(() => loadDefaultSelectedPermission())
  return (
    <section>
      <SettingsGroup title="权限与审批">
        <SettingRow
          label="权限默认"
          code="permission_mode"
          hint="新会话 / Agent 启动时的默认权限；改动同时应用到当前会话。"
          stackOnMobile
        >
          <ChoiceTabs
            choices={PERM_CHOICES}
            value={perm}
            disabled={disabled}
            busyId={savingKey === 'permission_mode' ? perm : undefined}
            onPick={(id) => void onPatch({ permission_mode: id })}
          />
        </SettingRow>
        <SettingRow
          label="审批默认选项"
          code="default_selected_permission"
          hint="审批弹窗里默认选中哪一行。"
          stackOnMobile
        >
          <ChoiceTabs
            choices={DEFAULT_SELECTED_PERMISSION_UI}
            value={defaultSelectedPermission}
            onPick={(id) => {
              saveDefaultSelectedPermission(id)
              setDefaultSelectedPermission(id)
            }}
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
              <ToggleTabs
                on={on}
                busy={savingKey === row.key}
                disabled={disabled}
                title={row.hint}
                onClick={() => void onPatch({ [row.key]: !on })}
              />
            </SettingRow>
          )
        })}
      </SettingsGroup>
      <SettingsGroup title="会话行为">
        <SettingRow
          label="忙时处理"
          code="follow_up_behavior"
          hint="引导：工具调用完成后注入（不取消回合）；排队：等当前回合结束后发送。"
          stackOnMobile
        >
          <ChoiceTabs
            choices={FOLLOW_UP_CHOICES}
            value={followUp}
            disabled={disabled}
            busyId={savingKey === 'follow_up_behavior' ? followUp : undefined}
            onPick={(id) => void onPatch({ follow_up_behavior: id })}
          />
        </SettingRow>
        <SettingRow
          label="新对话自动待办"
          code="auto_todo_new_session"
          hint="开：新建会话后自动标记为待办；关：新会话默认为普通状态。"
        >
          <ToggleTabs
            on={autoTodoNewSession}
            title="发起新对话时自动将其设为待办，改动即时生效"
            onClick={() => setFePrefs({ autoTodoNewSession: !autoTodoNewSession })}
          />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="提问卡片">
        <AskTimeoutRows
          toolset={toolset}
          savingKey={savingKey}
          disabled={disabled}
          onPatch={onPatch}
        />
      </SettingsGroup>
    </section>
  )
}

/** `[toolset.ask_user_question]` timeout pair — TUI「Ask-Question timeout」。
 *  提示如实标注：agent 只在会话启动（agent build）时解析这两个键，改
 *  动只影响新会话。secs 缺省 = agent 默认 1800（30 分钟）。 */
const ASK_TIMEOUT_SECS_MAX = 86400

function AskTimeoutRows({
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
    <>
      <SettingRow
        label="提问超时"
        code="toolset.ask_user_question.timeout_enabled"
        hint="开：提问超时自动放弃，agent 继续（默认开）· 只影响新会话。"
      >
        <ToggleTabs
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
    </>
  )
}

/** 「外观与显示」分类：侧边栏分组名 + 转录/滚动显示。 */
function DisplaySettings({
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
  const workspaceFullPath = useFePrefs((s) => s.fePrefs.workspaceFullPath)
  const entryFadeIn = useFePrefs((s) => s.fePrefs.entryFadeIn)
  const streamTextSmooth = useFePrefs((s) => s.fePrefs.streamTextSmooth)
  const thoughtLines = useFePrefs((s) => s.fePrefs.thoughtLines)
  const liteReplay = useLiteReplay()
  const viaRelay = historyViaHubRelay()
  const setFePrefs = useFePrefs((s) => s.setFePrefs)
  const density =
    TOOL_CALL_DENSITY_CHOICES.find((c) => c.id === ui?.tool_call_density)?.id ??
    TOOL_CALL_DENSITY_DEFAULT
  const densityDesc =
    TOOL_CALL_DENSITY_CHOICES.find((c) => c.id === density)?.desc ?? ''
  const pageFlipOnSend = readUiBool(ui, PAGE_FLIP_ROW.key, PAGE_FLIP_ROW.dflt)
  return (
    <section>
      <SettingsGroup title="侧边栏">
        <SettingRow
          label="目录分组名"
          code="workspace_full_path"
          hint="侧边栏工作区分组的显示方式。短名：父目录-目录名（如 ccwork-acp-host）；全路径：完整工作目录。"
          stackOnMobile
        >
          <ChoiceTabs
            choices={WORKSPACE_GROUP_NAME_CHOICES}
            value={workspaceFullPath ? 'full' : 'short'}
            onPick={(id) => setFePrefs({ workspaceFullPath: id === 'full' })}
          />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="滚动区">
        <SettingRow
          label="工具调用密度"
          code="tool_call_density"
          hint={`滚动区里每条工具调用显示多少、怎么分组。${densityDesc}`}
          stackOnMobile
        >
          <ChoiceTabs
            choices={DENSITY_CHOICES}
            value={density}
            disabled={disabled}
            busyId={savingKey === 'tool_call_density' ? density : undefined}
            onPick={(id) => void onPatch({ tool_call_density: id })}
          />
        </SettingRow>
        <SettingRow
          label="新块淡入"
          code="entry_fade_in"
          hint="实时输出时，新出现的滚动区块以半透明状态平滑淡入；关 = 直接出现。"
        >
          <ToggleTabs
            on={entryFadeIn}
            title="新出现的滚动区块是否播放半透明淡入"
            onClick={() => setFePrefs({ entryFadeIn: !entryFadeIn })}
          />
        </SettingRow>
        <SettingRow
          label="出字平滑"
          code="stream_text_smooth"
          hint="流式思考和回答的新增文字以半透明状态渐显，避免一段一段蹦出；关 = 收到即显示。"
        >
          <ToggleTabs
            on={streamTextSmooth}
            title="流式思考和回答的新增文字是否半透明淡入"
            onClick={() => setFePrefs({ streamTextSmooth: !streamTextSmooth })}
          />
        </SettingRow>
        <SettingRow
          label="思考活动区行数"
          code="thought_lines"
          hint={`流式思考正文可见的行数（${THOUGHT_LINES_MIN}–${THOUGHT_LINES_MAX}）；超出时最新一行在底部滚动。`}
        >
          <select
            aria-label="思考活动区显示行数"
            value={thoughtLines}
            onChange={(e) => setFePrefs({ thoughtLines: Number(e.target.value) })}
            className="min-h-8 rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 text-[12px] text-gn-fg outline-none sm:min-h-0"
          >
            {Array.from(
              { length: THOUGHT_LINES_MAX - THOUGHT_LINES_MIN + 1 },
              (_, i) => {
                const n = THOUGHT_LINES_MIN + i
                return (
                  <option key={n} value={n}>
                    {n} 行
                  </option>
                )
              },
            )}
          </select>
        </SettingRow>
        <SettingRow
          label={PAGE_FLIP_ROW.label}
          code={PAGE_FLIP_ROW.key}
          hint={PAGE_FLIP_ROW.hint}
        >
          <ToggleTabs
            on={pageFlipOnSend}
            busy={savingKey === PAGE_FLIP_ROW.key}
            disabled={disabled}
            title={PAGE_FLIP_ROW.hint}
            onClick={() => void onPatch({ page_flip_on_send: !pageFlipOnSend })}
          />
        </SettingRow>
        <SettingRow
          label="精简回放"
          code="lite_replay"
          hint="仅经 Hub 中转时生效。开：先拉精简时间线再补全文，切会话更快。关：整页全量。直连本机始终全量。"
        >
          <ToggleTabs
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
      </SettingsGroup>
    </section>
  )
}

/** 「高级」分类：Host config.toml 只读视图。 */
function AdvancedSettings({ dumpSections }: { dumpSections: DumpSection[] }) {
  return (
    <section className="pb-1">
      {dumpSections.length > 0 ? (
        <SettingsGroup title="Host 配置（只读）" hint="config.toml">
          {dumpSections.map((g) => (
            <div
              key={g.key}
              className="border-b border-gn-prompt-border/40 py-1 last:border-b-0"
            >
              <div className="px-4 pt-1 pb-0.5 font-mono text-[10.5px] tracking-wide text-gn-fg2">
                [{g.key}]
                {g.label ? (
                  <span className="ml-1.5 font-ui text-gn-fg2">{g.label}</span>
                ) : null}
                <span className="ml-1.5 tabular-nums text-gn-muted">{g.rows.length}</span>
              </div>
              {g.rows.map(([k, v]) => (
                <SettingRow key={k} label={k}>
                  <SettingValue value={v} />
                </SettingRow>
              ))}
            </div>
          ))}
        </SettingsGroup>
      ) : null}
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
