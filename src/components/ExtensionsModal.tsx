import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../store/chat'
import {
  transport,
  type ExtensionsPayload,
  type ExtensionHook,
  type ExtensionPlugin,
  type ExtensionSkill,
} from '../api/client'
import type { AgentSkill, WorkflowInfo } from '../api/types'
import { setCachedWorkflows } from '../commands/workflows'
import { Glyphs } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'

const TABS = [
  { id: 'hooks', label: 'hooks' },
  { id: 'plugins', label: 'plugins' },
  { id: 'skills', label: 'skills' },
  { id: 'workflows', label: 'workflows' },
  { id: 'marketplace', label: 'marketplace' },
] as const

// ── grouping / filtering helpers (TUI extensions_modal.rs) ─────────────

/** TUI cmp_str_ci — case-insensitive order; original order as tiebreak. */
function cmpStrCi(a: string, b: string): number {
  return a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b)
}

/** Status filter — TUI StatusFilter: All → Enabled → Disabled. */
type StatusFilter = 'all' | 'enabled' | 'disabled'
const STATUS_FILTERS: ReadonlyArray<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'enabled', label: 'Enabled' },
  { id: 'disabled', label: 'Disabled' },
]

/**
 * Only entries that CARRY the `enabled` field are filtered; entries with
 * unknown state stay visible under any filter (TUI StatusFilter::matches
 * gated on known state).
 */
function filterByStatus<T extends object>(items: T[], filter: StatusFilter): T[] {
  if (filter === 'all') return items
  return items.filter((x) => {
    const enabled = (x as { enabled?: boolean }).enabled
    return enabled === undefined || (filter === 'enabled') === enabled
  })
}

type ExtGroup<T> = { key: string; label: string; items: T[] }

/**
 * Group items by a string key (source / scope). Returns null when NO item
 * carries the key — callers fall back to a flat A-Z list (e.g. hooks, whose
 * web payload has no source field yet). Groups sort A-Z; unkeyed stragglers
 * collect under "Other" last. Items within a group sort A-Z by name.
 */
function groupBySourceKey<T extends { name: string }>(
  items: T[],
  keyOf: (t: T) => string | undefined,
): ExtGroup<T>[] | null {
  const buckets = new Map<string, T[]>()
  for (const it of items) {
    const k = keyOf(it)
    const key = k && k !== '' ? k : 'Other'
    const arr = buckets.get(key)
    if (arr) arr.push(it)
    else buckets.set(key, [it])
  }
  if (buckets.size === 1 && buckets.has('Other')) return null
  return [...buckets.entries()]
    .map(([key, groupItems]) => ({
      key,
      label: key,
      items: [...groupItems].sort((a, b) => cmpStrCi(a.name, b.name)),
    }))
    .sort((a, b) => {
      if (a.key === 'Other') return 1
      if (b.key === 'Other') return -1
      return cmpStrCi(a.label, b.label)
    })
}

// ── hooks 行/分组（TUI extensions_modal.rs 对齐）───────────────────

/** TUI hook_row_label: `on:{event} /{matcher}`; 无 event（本地回退数据）
 *  时退回裸 name。 */
function hookRowLabel(h: ExtensionHook): string {
  if (!h.event) return h.name
  return `on:${h.event}${h.matcher ? ` /${h.matcher}` : ''}`
}

/**
 * TUI hook_source_meta: 来源分组标签 + 排序 kind（Project < Global <
 * Claude < Plugin < Custom）。分组依据：hook 全名前缀（global/、
 * project/、plugin/、claude/）优先，sourceDir 兜底。
 */
function hookSourceMeta(h: ExtensionHook): { label: string; kind: number } {
  const name = h.name
  const dir = h.sourceDir ?? ''
  if (name.startsWith('project/')) return { label: 'Project hooks', kind: 0 }
  if (name.startsWith('global/')) return { label: 'Global hooks', kind: 1 }
  if (name.startsWith('claude/')) return { label: 'Claude settings', kind: 2 }
  const plugin = /\.grok\/(?:plugins|installed-plugins)\/([^/]+)/.exec(dir)
  if (name.startsWith('plugin/')) {
    return plugin?.[1] ? { label: `Plugin: ${plugin[1]}`, kind: 3 } : { label: 'Plugin', kind: 3 }
  }
  if (dir.includes('/.claude/')) return { label: 'Claude settings', kind: 2 }
  if (!dir) return { label: 'Other', kind: 4 }
  return { label: `Custom: ${dir.replace(/^\/Users\/[^/]+/, '~')}`, kind: 4 }
}

/**
 * TUI hooks modal 分组：组按 kind 排序（Project→Global→Claude→Plugin→
 * Custom），组内按行 label（on:event /matcher）A-Z。
 */
function groupHooksForDisplay(hooks: ExtensionHook[]): {
  label: string
  kind: number
  items: ExtensionHook[]
}[] {
  const buckets = new Map<string, { label: string; kind: number; items: ExtensionHook[] }>()
  for (const h of hooks) {
    const meta = hookSourceMeta(h)
    const b = buckets.get(meta.label)
    if (b) b.items.push(h)
    else buckets.set(meta.label, { label: meta.label, kind: meta.kind, items: [h] })
  }
  return [...buckets.values()]
    .map((g) => ({
      ...g,
      items: [...g.items].sort((a, b) => cmpStrCi(hookRowLabel(a), hookRowLabel(b))),
    }))
    .sort((a, b) => (a.kind - b.kind) || cmpStrCi(a.label, b.label))
}

/** TUI 行内命令描述：`→ {command|url|(no command)}`。 */
function hookCommandText(h: ExtensionHook): string {
  return `→ ${h.command ?? h.url ?? '(no command)'}`
}

/**
 * Skills scope order — TUI skill_group: Project → User → Plugin →
 * Bundled → Server → Config (missing levels are skipped).
 */
const SKILL_SCOPE_ORDER: ReadonlyArray<{ scope: string; label: string }> = [
  { scope: 'project', label: 'Project' },
  { scope: 'user', label: 'User' },
  { scope: 'plugin', label: 'Plugin' },
  { scope: 'bundled', label: 'Bundled' },
  { scope: 'server', label: 'Server' },
  { scope: 'config', label: 'Config' },
]

function skillScopeGroup(s: ExtensionSkill): { key: string; label: string } {
  const scope = (s.scope ?? '').toLowerCase()
  // TUI SkillScope::Local | Repo → Project.
  const normalized = scope === 'local' || scope === 'repo' ? 'project' : scope
  const found = SKILL_SCOPE_ORDER.find((g) => g.scope === normalized)
  if (found) return { key: found.scope, label: found.label }
  return { key: scope || 'unknown', label: s.scope || 'unknown' }
}

function groupSkills<T extends ExtensionSkill>(skills: T[]): ExtGroup<T>[] {
  const buckets = new Map<string, { label: string; rank: number; items: T[] }>()
  for (const s of skills) {
    const { key, label } = skillScopeGroup(s)
    let b = buckets.get(key)
    if (!b) {
      const rank = SKILL_SCOPE_ORDER.findIndex((g) => g.scope === key)
      b = { label, rank, items: [] }
      buckets.set(key, b)
    }
    b.items.push(s)
  }
  return [...buckets.values()]
    .sort((a, b) => {
      const ra = a.rank === -1 ? SKILL_SCOPE_ORDER.length : a.rank
      const rb = b.rank === -1 ? SKILL_SCOPE_ORDER.length : b.rank
      return ra - rb || cmpStrCi(a.label, b.label)
    })
    .map((b) => ({
      key: b.label,
      label: b.label,
      items: [...b.items].sort((a, b) => cmpStrCi(a.name, b.name)),
    }))
}

/** Collapsible group header (click to fold the group's rows). */
function GroupHeader({
  label,
  count,
  collapsed,
  onToggle,
}: {
  label: string
  count: number
  collapsed: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="sticky top-0 z-10 flex w-full cursor-pointer items-center gap-1.5 border-b border-gn-prompt-border/50 bg-gn-bg-base px-3 py-1 text-left hover:bg-gn-bg-highlight"
      title={collapsed ? `展开${label}` : `收起${label}`}
    >
      <span className="shrink-0 text-gn-gutter" aria-hidden>
        <IconGlyph glyph={collapsed ? Glyphs.chevron : Glyphs.chevronDown} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium uppercase tracking-wide text-gn-fg2">
        {label}
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-gn-gutter">{count}</span>
    </button>
  )
}

/**
 * Extensions modal — web counterpart of the TUI extensions modal
 * (/hooks /plugins /skills /marketplace all open it on their own tab).
 *
 * The hooks tab renders the AGENT's live hook registry
 * (POST /api/hooks/list → x.ai/hooks/list — the same source as the TUI
 * /hooks modal, incl. sourceDir + disabled/pinned + loadErrors), with a
 * hot-reload button (POST /api/hooks/action {type:"reload"}) that
 * re-discovers ~/.grok/hooks without a restart; plugins/skills still
 * come from GET /api/extensions (host reads ~/.grok, local-only).
 * Fetched once per open with an inline retry; hooks_changed /
 * plugins_changed (hooksVersion bumps) auto-refresh while open.
 * Per-hook 启停 goes through x.ai/hooks/action enable/disable
 * (managed-policy pinned hooks are refused by the agent).
 */
export function ExtensionsModal() {
  const open = useChatStore((s) => s.extensionsOpen)
  const tab = useChatStore((s) => s.extensionsTab)
  const close = useChatStore((s) => s.closeExtensions)
  const hooksVersion = useChatStore((s) => s.hooksVersion)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [data, setData] = useState<ExtensionsPayload>()
  const [hooksMeta, setHooksMeta] = useState<{
    projectTrusted?: boolean
    loadErrors?: string[]
  }>()
  const [hookToggleError, setHookToggleError] = useState<string>()
  const [reloadBusy, setReloadBusy] = useState(false)
  const [reloadError, setReloadError] = useState<string>()
  const [hookBusyName, setHookBusyName] = useState<string>()
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  // ── agent 侧 skills（x.ai/skills/list — 带实时 enabled 状态）──────
  const [agentSkills, setAgentSkills] = useState<AgentSkill[]>([])
  const [agentSkillsError, setAgentSkillsError] = useState<string>()
  const [skillBusyName, setSkillBusyName] = useState<string>()
  const [agentSkillError, setAgentSkillError] = useState<string>()
  // ── workflows 目录（x.ai/workflows/list — 会话级注册表，独立 seq）──
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>()
  const [workflowsError, setWorkflowsError] = useState<string>()
  const [workflowsLoading, setWorkflowsLoading] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const reqSeq = useRef(0)
  const skillReqSeq = useRef(0)
  const workflowsReqSeq = useRef(0)

  const fetchData = useCallback(async () => {
    const seq = ++reqSeq.current
    setLoading(true)
    setError(undefined)
    try {
      // hooks 走 agent 实时注册表（/api/hooks/list → x.ai/hooks/list，
      // 与 TUI /hooks 面板同源）；本地磁盘扫描（/api/extensions）作为
      // agent 不可达时的回退，并继续提供 plugins/skills。
      const [live, ext] = await Promise.allSettled([
        transport.hooksList(),
        transport.extensions(),
      ])
      const hooks =
        live.status === 'fulfilled'
          ? live.value.hooks
          : ext.status === 'fulfilled'
            ? ext.value.hooks
            : []
      const meta =
        live.status === 'fulfilled'
          ? {
              ...(live.value.projectTrusted !== undefined
                ? { projectTrusted: live.value.projectTrusted }
                : {}),
              ...(live.value.loadErrors ? { loadErrors: live.value.loadErrors } : {}),
            }
          : undefined
      if (live.status === 'rejected' && ext.status === 'rejected') {
        throw new Error(live.reason instanceof Error ? live.reason.message : String(live.reason))
      }
      // A newer open / hooksVersion bump superseded this one.
      if (seq === reqSeq.current) {
        setData({
          hooks,
          plugins: ext.status === 'fulfilled' ? ext.value.plugins : [],
          skills: ext.status === 'fulfilled' ? ext.value.skills : [],
        })
        setHooksMeta(meta)
      }
    } catch (e) {
      if (seq === reqSeq.current) {
        setData(undefined)
        setHooksMeta(undefined)
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }, [])

  /** x.ai/skills/list — agent 侧 skill 注册表（独立 seq，与本地扫描并行）。 */
  const fetchAgentSkills = useCallback(async () => {
    const seq = ++skillReqSeq.current
    setAgentSkillsError(undefined)
    try {
      const skills = await transport.skillsList({ cwd: useChatStore.getState().cwd })
      if (seq === skillReqSeq.current) setAgentSkills(skills)
    } catch (e) {
      if (seq === skillReqSeq.current) {
        setAgentSkillsError(e instanceof Error ? e.message : String(e))
      }
    }
  }, [])

  /** x.ai/skills/toggle — 只对 agent 侧条目可用；成功后本地翻转。 */
  const toggleAgentSkill = async (s: AgentSkill) => {
    setSkillBusyName(s.name)
    setAgentSkillError(undefined)
    try {
      const enabled = s.enabled === false
      await transport.skillsToggle({
        name: s.name,
        enabled,
        cwd: useChatStore.getState().cwd,
      })
      setAgentSkills((prev) =>
        prev.map((x) => (x.name === s.name ? { ...x, enabled } : x)),
      )
      useChatStore.setState({ statusText: `已${enabled ? '启用' : '禁用'} skill ${s.name}` })
    } catch (e) {
      setAgentSkillError(`${s.name}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSkillBusyName(undefined)
    }
  }

  /** x.ai/workflows/list — 已安装 workflow 目录（A 步取证：返回
   *  `{workflows: [...]}`，字段 name/description/source + 可选
   *  when_to_use/path；shell gate 关闭时为空数组）。 */
  const fetchWorkflows = useCallback(async () => {
    const seq = ++workflowsReqSeq.current
    setWorkflowsLoading(true)
    setWorkflowsError(undefined)
    try {
      const st = useChatStore.getState()
      const payload = await transport.workflowsList({
        sessionId: st.sessionId ?? undefined,
      })
      // 防御：ext result 已由 unwrapExtResult 解包；结构不符按失败处理。
      const list = payload?.workflows
      if (!Array.isArray(list)) throw new Error('workflows 返回结构异常')
      // 顺手喂 /workflow 参数候选的模块缓存（suggestArgs 是同步的）。
      setCachedWorkflows(list)
      if (seq === workflowsReqSeq.current) setWorkflows(list)
    } catch (e) {
      if (seq === workflowsReqSeq.current) {
        setWorkflows(undefined)
        setWorkflowsError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (seq === workflowsReqSeq.current) setWorkflowsLoading(false)
    }
  }, [])

  /** x.ai/hooks/action reload — 让 agent 热重载 ~/.grok/hooks（无需重启）。
   *  成功后 agent 广播 hooks_changed（hooksVersion bump 自动 refetch），
   *  这里再显式拉一次做双保险。 */
  const reloadHooks = async () => {
    setReloadBusy(true)
    setReloadError(undefined)
    try {
      await transport.hooksAction({ action: { type: 'reload' } })
      useChatStore.setState({ statusText: 'Hooks reloaded.' })
      await fetchData()
    } catch (e) {
      setReloadError(e instanceof Error ? e.message : String(e))
    } finally {
      setReloadBusy(false)
    }
  }

  /** x.ai/hooks/action enable/disable — 单条 hook 启停（写 ~/.grok/
   *  disabled-hooks））。pinned（托管策略）hook 由 agent 拒绝，错误
   * 显示在行内提示。 */
  const toggleHook = async (h: HookRow) => {
    const off = h.disabled === true || h.enabled === false
    setHookBusyName(h.name)
    setHookToggleError(undefined)
    try {
      await transport.hooksAction({
        action: { type: off ? 'enable' : 'disable', hook_name: h.name },
      })
      useChatStore.setState({ statusText: `${off ? '已启用' : '已停用'} hook ${h.name}` })
      await fetchData()
    } catch (e) {
      setHookToggleError(`${off ? '启用' : '停用'}失败（${h.name}）: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setHookBusyName(undefined)
    }
  }

  // Fetch on open AND on every hooks_changed / plugins_changed bump while
  // open (hooksVersion) — a single effect covers both triggers.
  useEffect(() => {
    if (!open) return
    void fetchData()
    void fetchAgentSkills()
    void fetchWorkflows()
  }, [open, hooksVersion, fetchData, fetchAgentSkills, fetchWorkflows])

  useEffect(() => {
    if (!open) return
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
      className="fixed inset-0 z-50 flex items-start justify-center gn-modal-dim p-4"
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
        className="mt-8 w-full max-w-[560px] gn-modal-panel"
      >
        <header className="gn-modal-header">
          <span className="text-[13px] font-bold text-gn-fg">extensions</span>
          <button
            type="button"
            onClick={close}
            className="ml-auto rounded px-2 py-0.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          >
            esc
          </button>
        </header>

        {/* Tab bar — 窄屏可横向滚动，避免 tab 溢出弹窗 */}
        <div className="gn-no-scrollbar flex gap-1 overflow-x-auto border-b border-gn-prompt-border px-2 pt-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                useChatStore.getState().openExtensions(t.id)
                setHookToggleError(undefined)
              }}
              className={`shrink-0 whitespace-nowrap rounded px-3 py-1.5 text-[12px] ${
 tab === t.id
                  ? 'bg-gn-bg-highlight text-gn-fg'
                  : 'text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Status filter — TUI StatusFilter (All / Enabled / Disabled).
            Workflows/Marketplace 除外：TUI 这两 tab 恒为 StatusFilter::All。
            hooks tab 专属：重载按钮右对齐（ml-auto）与过滤条同行。 */}
        {tab !== 'marketplace' && tab !== 'workflows' && (
          <div className="flex items-center gap-1 border-b border-gn-prompt-border/50 px-3 py-1.5">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setStatusFilter(f.id)}
                className={`rounded px-2 py-0.5 text-[10.5px] ${ statusFilter === f.id ? 'bg-gn-bg-highlight text-gn-fg' : 'text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg' }`}
                aria-pressed={statusFilter === f.id}
              >
                {f.label}
              </button>
            ))}
            {tab === 'hooks' ? (
              <span className="ml-auto flex min-w-0 items-center gap-2">
                {reloadError ? (
                  <span className="min-w-0 truncate text-[11px] text-gn-error">{reloadError}</span>
                ) : null}
                <button
                  type="button"
                  onClick={() => void reloadHooks()}
                  disabled={reloadBusy}
                  className="shrink-0 rounded px-2 py-0.5 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-50"
                  title="x.ai/hooks/action reload — 重新扫描 ~/.grok/hooks，无需重启"
                >
                  {reloadBusy ? '重载中…' : '重载 hooks（热加载）'}
                </button>
              </span>
            ) : null}
          </div>
        )}

        <div className="max-h-[52vh] overflow-y-auto">
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
                className="mt-2 rounded px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
              >
                重试
              </button>
            </div>
          ) : tab === 'hooks' ? (
            <HooksTab
              data={data}
              hooksMeta={hooksMeta}
              filter={statusFilter}
              hint={hookToggleError}
              busyName={hookBusyName}
              onToggle={toggleHook}
            />
          ) : tab === 'plugins' ? (
            <PluginsTab data={data} filter={statusFilter} />
          ) : tab === 'skills' ? (
            <SkillsTab
              data={data}
              filter={statusFilter}
              agentSkills={agentSkills}
              agentSkillsError={agentSkillsError}
              agentSkillError={agentSkillError}
              skillBusyName={skillBusyName}
              onToggleSkill={(s) => void toggleAgentSkill(s)}
            />
          ) : tab === 'workflows' ? (
            <WorkflowsTab
              loading={workflowsLoading}
              error={workflowsError}
              workflows={workflows}
              onRetry={() => void fetchWorkflows()}
            />
          ) : (
            <MarketplaceTab />
          )}
        </div>
      </div>
    </div>
  )
}

// ── tabs ───────────────────────────────────────────────────────────────

/** A hook row, possibly with a source / source_dir (web payload lacks it today). */
type HookRow = ExtensionHook & { source?: string; source_dir?: string }

function HookItem({
  h,
  busy,
  onToggle,
}: {
  h: HookRow
  busy?: boolean
  onToggle: (h: HookRow) => void
}) {
  const badge =
    h.pinned === true ? '[policy]' : h.disabled === true || h.enabled === false ? '[disabled]' : null
  const isOff = h.disabled === true || h.enabled === false
  return (
    <div
      className={`flex items-start gap-2.5 border-b border-gn-prompt-border/50 px-4 py-2 ${
 h.disabled ? 'opacity-50' : ''
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-mono text-[12.5px] text-gn-fg">{hookRowLabel(h)}</span>
          {badge ? (
            <span className="shrink-0 rounded border border-gn-prompt-border px-1 text-[9px] leading-[14px] text-gn-muted">
              {badge}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-gn-muted" title={h.command ?? h.url}>
          {hookCommandText(h)}
        </div>
        {h.event && h.name !== hookRowLabel(h) ? (
          <div className="mt-0.5 truncate text-[11px] text-gn-gutter" title={h.name}>
            {h.name}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onToggle(h)}
        disabled={busy || h.pinned === true}
        className="shrink-0 rounded px-2 py-0.5 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-50"
        title={h.pinned === true ? '托管策略强制，不可停用' : `x.ai/hooks/action ${isOff ? 'enable' : 'disable'}`}
      >
        {busy ? '…' : isOff ? '启用' : '停用'}
      </button>
    </div>
  )
}

function HooksTab({
  data,
  hooksMeta,
  filter,
  hint,
  busyName,
  onToggle,
}: {
  data?: ExtensionsPayload
  hooksMeta?: { projectTrusted?: boolean; loadErrors?: string[] }
  filter: StatusFilter
  hint?: string
  busyName?: string
  onToggle: (h: HookRow) => void
}) {
  const all = (data?.hooks ?? []) as HookRow[]
  // StatusFilter 按 enabled 语义过滤（TUI：enabled = !disabled）；状态
  // 未知的条目在任何过滤下都可见。
  const known = all.map((h) => ({
    ...h,
    enabled: h.enabled ?? (h.disabled === undefined ? undefined : !h.disabled),
  }))
  const filtered = filterByStatus(known, filter)
  // TUI：按来源分组（Project/Global/Claude/Plugin/Custom），组内按行
  // label（on:event /matcher）A-Z。
  const groups = groupHooksForDisplay(filtered)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  return (
    <>
      {hint ? (
        <div className="mx-4 mt-2 rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1.5 text-[11px] text-gn-warning">
          {hint}
        </div>
      ) : null}
      {hooksMeta?.loadErrors?.length ? (
        <div className="mx-4 mt-2 rounded border border-gn-warning/60 bg-gn-bg-dark px-2 py-1.5 text-[11px] text-gn-warning">
          {hooksMeta.loadErrors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      ) : null}
      {filtered.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
          {all.length === 0 ? '未加载 hooks' : '没有匹配当前过滤的 hooks'}
        </div>
      ) : groups.length ? (
        groups.map((g) => (
          <div key={g.label}>
            <GroupHeader
              label={g.label}
              count={g.items.length}
              collapsed={collapsed.has(g.label)}
              onToggle={() => toggle(g.label)}
            />
            {!collapsed.has(g.label) &&
              g.items.map((h) => (
                <HookItem
                  key={h.name}
                  h={h}
                  busy={busyName === h.name}
                  onToggle={onToggle}
                />
              ))}
          </div>
        ))
      ) : null}
    </>
  )
}

function PluginItem({ p }: { p: ExtensionPlugin }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-gn-prompt-border/50 px-4 py-2">
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
  )
}

function PluginsTab({ data, filter }: { data?: ExtensionsPayload; filter: StatusFilter }) {
  const all = data?.plugins ?? []
  // Group by source (TUI plugin origin groups); within group A-Z.
  const filtered = filterByStatus(all, filter)
  const groups = groupBySourceKey(filtered, (p) => p.source)
  const flat = [...filtered].sort((a, b) => cmpStrCi(a.name, b.name))
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  return (
    <>
      {filtered.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
          {all.length === 0 ? '未安装插件' : '没有匹配当前过滤的插件'}
        </div>
      ) : groups ? (
        groups.map((g) => (
          <div key={g.key}>
            <GroupHeader
              label={g.label}
              count={g.items.length}
              collapsed={collapsed.has(g.key)}
              onToggle={() => toggle(g.key)}
            />
            {!collapsed.has(g.key) && g.items.map((p) => <PluginItem key={p.name} p={p} />)}
          </div>
        ))
      ) : (
        flat.map((p) => <PluginItem key={p.name} p={p} />)
      )}
    </>
  )
}

/** 合并后的 skill 行：本地扫描（GET /api/extensions）+ agent 注册表
 *  （x.ai/skills/list）。同名条目 agent 侧覆盖（带实时 enabled 状态）。 */
type SkillRow = ExtensionSkill & {
  /** True when this row's enabled state comes from the agent registry. */
  fromAgent: boolean
}

function SkillItem({
  s,
  busy,
  onToggle,
}: {
  s: SkillRow
  busy?: string
  onToggle?: (s: SkillRow) => void
}) {
  return (
    <div
      className="flex items-start gap-2.5 border-b border-gn-prompt-border/50 px-4 py-2"
      title={s.path ? `SKILL.md: ${s.path}` : undefined}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
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
          {s.fromAgent && (
            <span
              className="shrink-0 rounded border border-gn-cyan/60 px-1 text-[9px] leading-[14px] text-gn-cyan"
              title="来自 agent 注册表（x.ai/skills/list）— 可实时启停"
            >
              agent
            </span>
          )}
          {s.enabled !== undefined && (
            <span
              className={`shrink-0 rounded border px-1 text-[9px] leading-[14px] ${
 s.enabled
                  ? 'border-gn-green/60 text-gn-green'
                  : 'border-gn-prompt-border text-gn-muted'
              }`}
            >
              {s.enabled ? 'enabled' : 'disabled'}
            </span>
          )}
        </div>
        {s.path ? (
          <div className="mt-0.5 truncate font-mono text-[11px] text-gn-gutter" title={`SKILL.md: ${s.path}`}>
            {s.path}
          </div>
        ) : null}
      </div>
      {s.fromAgent && onToggle && (
        <button
          type="button"
          disabled={busy != null}
          onClick={() => onToggle(s)}
          className={`shrink-0 rounded px-2 py-0.5 text-[11px] disabled:opacity-50 ${
 s.enabled === false
              ? 'bg-gn-bg-highlight text-gn-fg'
              : 'text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg'
          }`}
          title="x.ai/skills/toggle — 启用/禁用该 skill（agent 注册表）"
        >
          {busy === s.name ? '…' : s.enabled === false ? '启用' : '禁用'}
        </button>
      )}
    </div>
  )
}

function SkillsTab({
  data,
  filter,
  agentSkills,
  agentSkillsError,
  agentSkillError,
  skillBusyName,
  onToggleSkill,
}: {
  data?: ExtensionsPayload
  filter: StatusFilter
  agentSkills: AgentSkill[]
  agentSkillsError?: string
  agentSkillError?: string
  skillBusyName?: string
  onToggleSkill: (s: SkillRow) => void
}) {
  // 合并：本地扫描为底，agent 注册表按 name 覆盖（实时 enabled 状态）。
  const merged = useMemo<SkillRow[]>(() => {
    const map = new Map<string, SkillRow>()
    for (const s of data?.skills ?? []) map.set(s.name, { ...s, fromAgent: false })
    for (const s of agentSkills) {
      map.set(s.name, {
        name: s.name,
        scope: s.scope,
        enabled: s.enabled,
        fromAgent: true,
      })
    }
    return [...map.values()]
  }, [data, agentSkills])
  // Scope order Project → User → Plugin → Bundled → Server → Config
  // (TUI skill_group); missing levels are skipped.
  const filtered = filterByStatus(merged, filter)
  const groups = groupSkills(filtered)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  return (
    <>
      {agentSkillsError && (
        <div className="mx-4 mt-2 rounded border border-gn-diff-del-bg px-2 py-1.5 text-[11px] text-gn-red">
          agent skills 加载失败: {agentSkillsError}（仍显示本地扫描结果）
        </div>
      )}
      {agentSkillError && (
        <div className="mx-4 mt-2 rounded border border-gn-diff-del-bg px-2 py-1.5 text-[11px] text-gn-red">
          {agentSkillError}
        </div>
      )}
      {filtered.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
          {merged.length === 0 ? '未安装 skills' : '没有匹配当前过滤的 skills'}
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.key}>
            <GroupHeader
              label={g.label}
              count={g.items.length}
              collapsed={collapsed.has(g.key)}
              onToggle={() => toggle(g.key)}
            />
            {!collapsed.has(g.key) &&
              g.items.map((s) => (
                <SkillItem
                  key={s.name}
                  s={s}
                  busy={skillBusyName}
                  onToggle={s.fromAgent ? onToggleSkill : undefined}
                />
              ))}
          </div>
        ))
      )}
    </>
  )
}

/** 一条 workflow 目录行 — TUI workflows_picker_rows：name（+source 徽标）、
 *  描述、when to use / path 字段行。 */
function WorkflowItem({ w }: { w: WorkflowInfo }) {
  return (
    <div className="flex items-start gap-2.5 border-b border-gn-prompt-border/50 px-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="truncate font-mono text-[12.5px] text-gn-fg">{w.name}</span>
          {w.source ? (
            <span className="shrink-0 rounded border border-gn-prompt-border px-1 text-[9px] leading-[14px] text-gn-gutter">
              {w.source}
            </span>
          ) : null}
        </div>
        {w.description ? (
          <div className="mt-0.5 text-[11px] leading-snug text-gn-muted">{w.description}</div>
        ) : null}
        {w.when_to_use ? (
          <div className="mt-0.5 text-[11px] text-gn-gutter">when to use · {w.when_to_use}</div>
        ) : null}
        {w.path ? (
          <div className="mt-0.5 truncate font-mono text-[11px] text-gn-gutter" title={w.path}>
            {w.path}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Workflows tab — 目录浏览（只读）。加载/失败/空态三态，A–Z 平铺
 *  （TUI build_workflows_picker_rows：flat list，无分组、无过滤）。 */
function WorkflowsTab({
  loading,
  error,
  workflows,
  onRetry,
}: {
  loading: boolean
  error?: string
  workflows?: WorkflowInfo[]
  onRetry: () => void
}) {
  if (loading && workflows === undefined) {
    return (
      <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
        加载 workflows…
      </div>
    )
  }
  if (error) {
    return (
      <div className="px-4 py-5 text-center">
        <div className="text-[12px] text-gn-red">{error}</div>
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
        >
          重试
        </button>
      </div>
    )
  }
  if (!workflows || workflows.length === 0) {
    // TUI WORKFLOWS_EMPTY_PLACEHOLDER 的中文对应（gate 关闭时同样为空）。
    return (
      <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
        暂无已安装的 workflows — 可以让 agent 帮你创建一个
      </div>
    )
  }
  const rows = [...workflows].sort((a, b) => cmpStrCi(a.name, b.name))
  return (
    <>
      {rows.map((w) => (
        <WorkflowItem key={w.name} w={w} />
      ))}
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
