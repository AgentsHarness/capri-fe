import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../store/chat'
import {
  transport,
  type ExtensionsPayload,
  type ExtensionHook,
  type ExtensionPlugin,
  type ExtensionSkill,
} from '../api/client'
import type { AgentSkill } from '../api/types'
import { Glyphs } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'

const TABS = [
  { id: 'hooks', label: 'hooks' },
  { id: 'plugins', label: 'plugins' },
  { id: 'skills', label: 'skills' },
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
      className="sticky top-0 z-10 flex w-full cursor-pointer items-center gap-1.5 border-b border-gn-prompt-border/60 bg-gn-bg-base px-3 py-1 text-left hover:bg-gn-bg-highlight"
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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  // ── agent 侧 skills（x.ai/skills/list — 带实时 enabled 状态）──────
  const [agentSkills, setAgentSkills] = useState<AgentSkill[]>([])
  const [agentSkillsError, setAgentSkillsError] = useState<string>()
  const [skillBusyName, setSkillBusyName] = useState<string>()
  const [agentSkillError, setAgentSkillError] = useState<string>()
  const panelRef = useRef<HTMLDivElement>(null)
  const reqSeq = useRef(0)
  const skillReqSeq = useRef(0)

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

  // Fetch on open AND on every hooks_changed / plugins_changed bump while
  // open (hooksVersion) — a single effect covers both triggers.
  useEffect(() => {
    if (!open) return
    void fetchData()
    void fetchAgentSkills()
  }, [open, hooksVersion, fetchData, fetchAgentSkills])

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

        {/* Status filter — TUI StatusFilter (All / Enabled / Disabled). */}
        {tab !== 'marketplace' && (
          <div className="flex items-center gap-1 border-b border-gn-prompt-border/50 px-3 py-1.5">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setStatusFilter(f.id)}
                className={`rounded px-2 py-0.5 text-[10.5px] ${
                  statusFilter === f.id
                    ? 'bg-gn-bg-highlight text-gn-fg'
                    : 'text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg'
                }`}
                aria-pressed={statusFilter === f.id}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}

        <div className="max-h-[52vh] overflow-y-auto pb-1">
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
            <HooksTab data={data} filter={statusFilter} hint={hookHint} onToggleClick={() => setHookHint('启停 hooks 需在 TUI/配置中修改，当前为只读')} />
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

function HookItem({ h, onToggleClick }: { h: HookRow; onToggleClick: () => void }) {
  return (
    <div className="flex items-start gap-2.5 border-b border-gn-prompt-border/50 px-4 py-2">
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
  )
}

function HooksTab({
  data,
  filter,
  hint,
  onToggleClick,
}: {
  data?: ExtensionsPayload
  filter: StatusFilter
  hint?: string
  onToggleClick: () => void
}) {
  const all = (data?.hooks ?? []) as HookRow[]
  // Group by source / source_dir when the payload carries it; the current
  // web payload does not, so this stays a flat A-Z list (防御性).
  const filtered = filterByStatus(all, filter)
  const groups = groupBySourceKey(filtered, (h) => h.source ?? h.source_dir)
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
      {hint ? (
        <div className="mx-4 mt-2 rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1.5 text-[11px] text-gn-warning">
          {hint}
        </div>
      ) : null}
      {filtered.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
          {all.length === 0 ? '未加载 hooks' : '没有匹配当前过滤的 hooks'}
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
            {!collapsed.has(g.key) &&
              g.items.map((h) => <HookItem key={h.name} h={h} onToggleClick={onToggleClick} />)}
          </div>
        ))
      ) : (
        flat.map((h) => <HookItem key={h.name} h={h} onToggleClick={onToggleClick} />)
      )}
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
          className={`shrink-0 rounded border px-2 py-0.5 text-[11px] disabled:opacity-50 ${
            s.enabled === false
              ? 'border-gn-prompt-border-active bg-gn-bg-highlight text-gn-fg'
              : 'border-gn-prompt-border text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg'
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
