import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { transport } from '../api/client'
import { useChatStore } from '../store/chat'
import type { AgentRow, PersonaRow } from '../api/rpc/agents'
import { pushToast } from '../store/toast'

/**
 * /agents and /personas — the TUI agents modal, two tabs.
 *
 * Rows carry no controls: clicking one opens a detail dialog, and that row's
 * actions live in the dialog footer (set default, enable/disable, delete a
 * persona). Set-default and enable/disable apply to built-in agents too,
 * matching the TUI's `s` and `t`. Bundled personas have no on-disk file to
 * remove, so their dialog offers no delete. Personas can be created and
 * deleted when they live in the user or project directory; deletion always
 * asks for confirmation. Setting the default, toggling, and deleting write
 * config.toml / the personas directory and apply to new sessions.
 */

export type AgentsTab = 'agents' | 'personas'

let opener: ((tab: AgentsTab) => void) | null = null
export function registerAgentsOpener(fn: (tab: AgentsTab) => void) {
  opener = fn
}
export function openAgentsModal(tab: AgentsTab) {
  opener?.(tab)
}

const SCOPE_LABEL: Record<string, string> = {
  builtin: '内置',
  user: '用户',
  project: '项目',
  bundled: '打包',
}

export function AgentsModal() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<AgentsTab>('agents')
  const cwd = useChatStore((s) => s.cwd)
  // A detail dialog owns Esc while it is up, so the tab panes report whether
  // one is open. A ref: this only gates the handler below, no repaint.
  const detailOpen = useRef(false)
  const setDetailOpen = useCallback((next: boolean) => {
    detailOpen.current = next
  }, [])

  useEffect(() => {
    registerAgentsOpener((next) => {
      setTab(next)
      setOpen(true)
    })
    return () => registerAgentsOpener(() => {})
  }, [])

  useEffect(() => {
    if (!open) {
      detailOpen.current = false
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 详情弹窗自带 Esc 监听（更晚注册、随后触发），这一下让给它。
      if (detailOpen.current) return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto gn-modal-dim p-2 sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false)
      }}
    >
      <div
        role="dialog"
        aria-label="Agent 与人格"
        className="my-auto flex max-h-[80vh] w-full max-w-xl flex-col gn-modal-panel"
        data-testid="agents-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="gn-modal-header">
          <TabButton current={tab} id="agents" onPick={setTab} label="Agents" />
          <TabButton current={tab} id="personas" onPick={setTab} label="Personas" />
          <button
            type="button"
            className="ml-auto rounded p-1 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
            onClick={() => setOpen(false)}
            aria-label="关闭弹窗"
            title="关闭 (Esc)"
          >
            <X size={14} aria-hidden />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {tab === 'agents' ? (
            <AgentsPane cwd={cwd} onDetailOpenChange={setDetailOpen} />
          ) : (
            <PersonasPane cwd={cwd} onDetailOpenChange={setDetailOpen} />
          )}
        </div>
      </div>
    </div>
  )
}

function TabButton({
  current,
  id,
  label,
  onPick,
}: {
  current: AgentsTab
  id: AgentsTab
  label: string
  onPick: (t: AgentsTab) => void
}) {
  return (
    <button
      type="button"
      className={
        current === id
          ? 'text-[13px] font-bold text-gn-fg'
          : 'text-[13px] text-gn-muted hover:text-gn-fg'
      }
      onClick={() => onPick(id)}
    >
      {label}
    </button>
  )
}

/**
 * 详情弹窗：压在 agents 弹窗之上（z-[60]，同 QuickAddModelsModal 的嵌套层）。
 * Esc 与点遮罩都只关自己，下面的列表原样留着。
 */
function DetailDialog({
  title,
  scope,
  testId,
  onClose,
  footer,
  children,
}: {
  title: string
  scope: string
  testId: string
  onClose: () => void
  footer?: React.ReactNode
  children: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto gn-modal-dim p-2 sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        className="my-auto flex max-h-[80vh] w-full max-w-xl flex-col gn-modal-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="gn-modal-header">
          <span className="truncate font-mono text-[13px] font-bold text-gn-fg">{title}</span>
          <span className="shrink-0 text-[11px] text-gn-muted">{scope}</span>
          <button
            type="button"
            className="ml-auto shrink-0 rounded p-1 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
            onClick={onClose}
            aria-label="关闭详情"
            title="关闭 (Esc)"
          >
            <X size={14} aria-hidden />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">{children}</div>
        {footer ? (
          <footer className="gn-modal-footer flex flex-wrap items-center gap-3">{footer}</footer>
        ) : null}
      </div>
    </div>
  )
}

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1">
      <span className="w-16 shrink-0 pt-px text-[11px] text-gn-muted">{label}</span>
      <span className="min-w-0 flex-1 break-words text-[12px] leading-snug text-gn-fg2">
        {children}
      </span>
    </div>
  )
}

/** 详情字段来自列表接口，FE 与 host 各自发版：旧 host 没有的数组别炸在这里。 */
function list(v: string[] | undefined): string[] {
  return Array.isArray(v) ? v : []
}

/** 正文块：TUI 展开里的 Prompt extension / Instructions 用同一副骨架。 */
function DetailBody({ label, note, children }: { label: string; note?: string; children: string }) {
  return (
    <div className="mt-2">
      <div className="text-[11px] text-gn-muted">
        {label}
        {note ? `（${note}）` : ''}
      </div>
      <pre className="mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded border border-gn-prompt-border/70 bg-gn-bg-dark px-2 py-1.5 text-[12px] leading-snug text-gn-fg2">
        {children}
      </pre>
    </div>
  )
}

function AgentsPane({
  cwd,
  onDetailOpenChange,
}: {
  cwd?: string
  onDetailOpenChange: (open: boolean) => void
}) {
  const [rows, setRows] = useState<AgentRow[]>([])
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string>()
  const [selected, setSelected] = useState<AgentRow | null>(null)
  const load = useCallback(async () => {
    try {
      const res = await transport.agentsList(cwd)
      setRows(res.agents)
      setError(undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [cwd])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => () => onDetailOpenChange(false), [onDetailOpenChange])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q))
  }, [rows, query])

  const closeDetail = () => {
    setSelected(null)
    onDetailOpenChange(false)
  }
  const openDetail = (row: AgentRow) => {
    setSelected(row)
    onDetailOpenChange(true)
  }

  const setDefault = async (row: AgentRow) => {
    try {
      await transport.agentsSetDefault(row.isDefault ? '' : row.name)
      pushToast(row.isDefault ? '已取消默认，新会话回到 grok-build' : `新会话将使用 ${row.name}`)
      await load()
      closeDetail()
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e))
    }
  }
  const toggle = async (row: AgentRow) => {
    try {
      await transport.agentsToggle(row.name, !row.enabled)
      pushToast(`${row.enabled ? '已停用' : '已启用'} ${row.name}，对新会话生效`)
      await load()
      closeDetail()
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索"
        className="rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 text-[13px] text-gn-fg outline-none placeholder:text-gn-gray"
      />
      <p className="text-[11px] text-gn-muted">点开条目看定义；默认和启停只影响之后新建的会话。</p>
      {error ? <p className="text-[12px] text-gn-red">{error}</p> : null}
      {shown.map((row) => (
        <button
          key={`${row.scope}:${row.name}`}
          type="button"
          className="rounded border border-gn-prompt-border/70 bg-gn-bg-dark px-2.5 py-1.5 text-left hover:border-gn-prompt-border"
          onClick={() => openDetail(row)}
        >
          <span className="flex items-baseline gap-2">
            <span className="text-[13px]">{row.name}</span>
            <span className="text-[11px] text-gn-muted">{SCOPE_LABEL[row.scope] ?? row.scope}</span>
            {row.isDefault ? <span className="text-[11px] text-gn-cyan">默认</span> : null}
            {!row.enabled ? <span className="text-[11px] text-gn-red">已停用</span> : null}
          </span>
          {row.description ? (
            <span className="block text-[12px] text-gn-muted">{row.description}</span>
          ) : null}
        </button>
      ))}
      {selected ? (
        <DetailDialog
          title={`agent: ${selected.name}`}
          scope={SCOPE_LABEL[selected.scope] ?? selected.scope}
          testId="agent-detail"
          onClose={closeDetail}
          footer={
            // 两种操作都写 config.toml（[agent] name / [subagents.toggle]），
            // 内置行也一样：TUI 里 t 与 s 对内置 agent 同样生效。
            <>
              <button
                type="button"
                className="text-[12px] text-gn-cyan hover:text-gn-fg"
                onClick={() => void setDefault(selected)}
              >
                {selected.isDefault ? '取消默认' : '设为默认'}
              </button>
              <button
                type="button"
                className="text-[12px] text-gn-fg2 hover:text-gn-fg"
                onClick={() => void toggle(selected)}
              >
                {selected.enabled ? '停用' : '启用'}
              </button>
            </>
          }
        >
          {selected.description ? (
            <p className="pb-1 text-[12px] text-gn-fg2">{selected.description}</p>
          ) : null}
          <DetailField label="模型">{selected.model || '-'}</DetailField>
          <DetailField label="提示模式">{selected.promptMode || '-'}</DetailField>
          <DetailField label="工具">
            {selected.builtin
              ? '编在 agent 里，host 读不到这份表'
              : selected.toolsDeclared === true
                ? list(selected.tools).length > 0
                  ? `${list(selected.tools).length} 项：${list(selected.tools).join('、')}`
                  : '（无）'
                : selected.toolsDeclared === false
                  ? '未声明，继承默认工具集'
                  : // 旧 host 这一行只有名字和描述，缺 toolsDeclared 时不做判断。
                    '-'}
          </DetailField>
          {list(selected.disallowedTools).length > 0 ? (
            <DetailField label="禁用工具">{list(selected.disallowedTools).join('、')}</DetailField>
          ) : null}
          {list(selected.skills).length > 0 ? (
            <DetailField label="技能">{list(selected.skills).join('、')}</DetailField>
          ) : null}
          {selected.effort ? <DetailField label="强度">{selected.effort}</DetailField> : null}
          {selected.isolation ? <DetailField label="隔离">{selected.isolation}</DetailField> : null}
          {selected.path ? (
            <DetailField label="来源">
              <span className="break-all font-mono text-[11px]">{selected.path}</span>
            </DetailField>
          ) : null}
          {selected.promptBody ? (
            <DetailBody label="提示正文" note={selected.promptTruncated ? '已截断' : undefined}>
              {selected.promptBody}
            </DetailBody>
          ) : (
            <DetailField label="提示正文">（无）</DetailField>
          )}
        </DetailDialog>
      ) : null}
    </div>
  )
}

function PersonasPane({
  cwd,
  onDetailOpenChange,
}: {
  cwd?: string
  onDetailOpenChange: (open: boolean) => void
}) {
  const [rows, setRows] = useState<PersonaRow[]>([])
  const [selected, setSelected] = useState<PersonaRow | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [scope, setScope] = useState<'user' | 'project'>('user')
  const [confirm, setConfirm] = useState(false)
  const load = useCallback(async () => {
    try {
      setRows(await transport.personasList(cwd))
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e))
    }
  }, [cwd])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => () => onDetailOpenChange(false), [onDetailOpenChange])

  const closeDetail = () => {
    setSelected(null)
    setConfirm(false)
    onDetailOpenChange(false)
  }
  const openDetail = (row: PersonaRow) => {
    setSelected(row)
    setConfirm(false)
    onDetailOpenChange(true)
  }

  const create = async () => {
    try {
      await transport.personasCreate({ name, description, instructions, scope, cwd })
      setCreating(false)
      setName('')
      setDescription('')
      setInstructions('')
      pushToast('已创建人格')
      await load()
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e))
    }
  }
  const remove = async (row: PersonaRow) => {
    if (!row.path) return
    try {
      await transport.personasDelete(row.path)
      pushToast(`已删除 ${row.name}`)
      await load()
      closeDetail()
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e))
    }
  }

  if (creating) {
    return (
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <Field label="名称" value={name} onChange={setName} />
        <Field label="描述" value={description} onChange={setDescription} />
        <label className="flex flex-col gap-1 text-[12px]">
          指令
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={4}
            className="rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 text-[13px] text-gn-fg outline-none placeholder:text-gn-gray"
          />
        </label>
        <label className="flex items-center gap-2 text-[12px]">
          位置
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value === 'project' ? 'project' : 'user')}
            className="rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 text-gn-fg"
          >
            <option value="user">用户 (~/.grok/personas)</option>
            <option value="project">项目 (.grok/personas)</option>
          </select>
        </label>
        <div className="flex gap-2">
          <button
            type="submit"
            className="min-h-8 rounded bg-gn-bg-highlight px-3 py-1 text-[12.5px] font-semibold text-gn-fg hover:bg-gn-bg-hover"
          >
            创建
          </button>
          <button type="button" className="min-h-8 rounded px-2.5 py-1 text-[12px] text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg" onClick={() => setCreating(false)}>
            取消
          </button>
        </div>
      </form>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <button type="button" className="self-start text-[12px] text-gn-cyan hover:text-gn-fg" onClick={() => setCreating(true)}>
        新建人格
      </button>
      {rows.map((row) => (
        <button
          key={`${row.scope}:${row.name}`}
          type="button"
          className="rounded border border-gn-prompt-border/70 bg-gn-bg-dark px-2.5 py-1.5 text-left hover:border-gn-prompt-border"
          onClick={() => openDetail(row)}
        >
          <span className="text-[13px]">{row.name}</span>
          <span className="ml-2 text-[11px] text-gn-muted">{SCOPE_LABEL[row.scope] ?? row.scope}</span>
          {row.description ? (
            <span className="block text-[12px] text-gn-muted">{row.description}</span>
          ) : null}
        </button>
      ))}
      {rows.length === 0 ? <p className="text-[12px] text-gn-muted">还没有人格。</p> : null}
      {selected ? (
        <DetailDialog
          title={`persona: ${selected.name}`}
          scope={SCOPE_LABEL[selected.scope] ?? selected.scope}
          testId="persona-detail"
          onClose={closeDetail}
          footer={
            // 打包进来的人格只读：删不了就不摆删除入口，确认框只属于真能删的那些。
            selected.deletable ? (
              confirm ? (
                <>
                  <span className="text-[12px] text-gn-fg2">确认删除？</span>
                  <button
                    type="button"
                    className="text-[12px] text-gn-red"
                    onClick={() => void remove(selected)}
                  >
                    删除
                  </button>
                  <button
                    type="button"
                    className="text-[12px] text-gn-fg2 hover:text-gn-fg"
                    onClick={() => setConfirm(false)}
                  >
                    取消
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="text-[12px] text-gn-red"
                  onClick={() => setConfirm(true)}
                >
                  删除
                </button>
              )
            ) : null
          }
        >
          {selected.description ? (
            <p className="pb-1 text-[12px] text-gn-fg2">{selected.description}</p>
          ) : null}
          <DetailField label="模型">{selected.model || '-'}</DetailField>
          <DetailField label="强度">{selected.reasoningEffort || '-'}</DetailField>
          <DetailField label="隔离">{selected.defaultIsolation || '-'}</DetailField>
          {selected.instructions ? (
            <DetailBody label="指令正文">{selected.instructions}</DetailBody>
          ) : (
            <DetailField label="指令正文">（空）</DetailField>
          )}
          {selected.instructionsFile ? (
            <DetailField label="指令文件">
              <span className="break-all font-mono text-[11px]">{selected.instructionsFile}</span>
            </DetailField>
          ) : null}
          <PersonaIOSection label="输入" items={selected.inputs} />
          <PersonaIOSection label="输出" items={selected.outputs} />
          {selected.path ? (
            <DetailField label="来源">
              <span className="break-all font-mono text-[11px]">{selected.path}</span>
            </DetailField>
          ) : null}
        </DetailDialog>
      ) : null}
    </div>
  )
}

function PersonaIOSection({ label, items }: { label: string; items: PersonaRow['inputs'] }) {
  const list0 = Array.isArray(items) ? items : []
  if (list0.length === 0) return null
  return (
    <div className="mt-2">
      <div className="text-[11px] font-bold text-gn-fg">{label}</div>
      {list0.map((io) => (
        <div key={io.name} className="mt-1">
          <div className="text-[12px] text-gn-fg">
            {`• ${io.name} (${io.type}${io.required ? ', required' : ''})`}
          </div>
          {io.description ? (
            <p className="pl-4 text-[12px] text-gn-muted">{io.description}</p>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-[12px]">
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 text-[13px] text-gn-fg outline-none placeholder:text-gn-gray"
      />
    </label>
  )
}
