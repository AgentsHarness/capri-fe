import type { ScrollEntry } from '../../../api/types'
import { subagentMeta } from '../../../format'
import { Bullet, EntryShell } from '../EntryShell'
import type { EntryChrome } from '../chrome'

export function SubagentEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'subagent' }>
  chrome: EntryChrome
}) {
  const { shell, bullet, onHeaderDblClick, cancelSubagent } = chrome
  const label =
    e.status === 'started'
      ? 'Agent'
      : e.status === 'completed'
        ? 'Agent done'
        : e.status === 'cancelled'
          ? 'Agent cancelled'
          : 'Agent failed'
  return (
    <EntryShell {...shell}>
      <div
        className={`flex items-center gap-1.5 ${shell.dense ? 'py-0' : 'py-[2px]'} text-[13px] leading-[1.35]`}
        title="dblclick / enter · view subagent"
        onDoubleClick={(ev) => {
          ev.stopPropagation()
          ev.preventDefault()
          onHeaderDblClick()
        }}
      >
        <Bullet color={bullet.color} animated={bullet.animated} />
        <span
          className="shrink-0 whitespace-nowrap font-bold"
          style={{ color: bullet.color }}
        >
          {label}
        </span>
        <span className="min-w-0 truncate font-mono text-[12.5px] text-gn-muted">
          {e.title}
        </span>
        {(e.persona || e.role || e.model) && (
          <span className="shrink-0 text-[11px] text-gn-gutter">
            {subagentMeta(e.persona, e.role, e.model)}
          </span>
        )}
        {e.detail && (
          <span className="text-[11px] text-gn-gutter truncate">{e.detail}</span>
        )}
        {e.running && e.subagentId && (
          <button
            type="button"
            onClick={(ev) => {
              ev.stopPropagation()
              void cancelSubagent(e.subagentId!)
            }}
            className="ml-auto shrink-0 rounded border border-gn-red/40 px-1.5 py-0.5 text-[10.5px] text-gn-red hover:bg-gn-diff-del-bg"
            title="x.ai/subagent/cancel"
          >
            cancel
          </button>
        )}
      </div>
    </EntryShell>
  )
}

export function WorkflowEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'workflow' }>
  chrome: EntryChrome
}) {
  const { shell, bullet, onHeaderDblClick } = chrome
  const label =
    e.status === 'running'
      ? 'Workflow'
      : e.status === 'done'
        ? 'Workflow done'
        : e.status === 'failed'
          ? 'Workflow failed'
          : e.status === 'paused'
            ? 'Workflow paused'
            : 'Workflow cancelled'
  return (
    <EntryShell {...shell}>
      <div
        className={`flex items-center gap-1.5 ${shell.dense ? 'py-0' : 'py-[2px]'} text-[13px] leading-[1.35]`}
        title="dblclick / enter · view workflow"
        onDoubleClick={(ev) => {
          ev.stopPropagation()
          ev.preventDefault()
          onHeaderDblClick()
        }}
      >
        <Bullet color={bullet.color} animated={bullet.animated} />
        <span
          className="shrink-0 whitespace-nowrap font-bold"
          style={{ color: bullet.color }}
        >
          {label}
        </span>
        <span className="min-w-0 truncate font-mono text-[12.5px] text-gn-muted">
          {e.title}
        </span>
      </div>
    </EntryShell>
  )
}

export function BgTaskEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'bg_task' }>
  chrome: EntryChrome
}) {
  const { shell, bullet, onHeaderDblClick, killTask } = chrome
  // TUI: "Task started: {description|command}" — bold "Task", name is primary.
  // Double-click / Enter → block viewer with live stdout (TUI OpenBlockViewer).
  // Dense-aware inner padding: dense rows pack at 0 gap like tool rows
  // (EntryShell dense spacing), so consecutive task rows don't leave an
  // uneven 4px seam (visible in history pairs: started + completed).
  const verb =
    e.status === 'started'
      ? 'started'
      : e.status === 'completed'
        ? 'completed'
        : 'failed'
  return (
    <EntryShell {...shell}>
      <div
        className={`flex cursor-pointer items-center gap-1.5 ${shell.dense ? 'py-0' : 'py-[2px]'} text-[13px] leading-[1.35]`}
        title="dblclick / enter · view stdout"
        onDoubleClick={(ev) => {
          ev.stopPropagation()
          ev.preventDefault()
          onHeaderDblClick()
        }}
      >
        <Bullet color={bullet.color} animated={bullet.animated} />
        <span
          className="shrink-0 whitespace-nowrap font-bold"
          style={{ color: bullet.color }}
        >
          Task
        </span>
        <span className="shrink-0 whitespace-nowrap text-gn-muted">{verb}:</span>
        <span className="min-w-0 truncate font-mono text-[12.5px] text-gn-fg">
          {e.title}
        </span>
        {e.detail && (
          <span className="text-[11px] text-gn-gutter truncate" title={e.detail}>
            {e.detail}
          </span>
        )}
        {e.running && e.taskId && (
          <button
            type="button"
            onClick={(ev) => {
              ev.stopPropagation()
              void killTask(e.taskId!)
            }}
            className="ml-auto shrink-0 rounded border border-gn-red/40 px-1.5 py-0.5 text-[10.5px] text-gn-red hover:bg-gn-diff-del-bg"
            title="x.ai/task/kill"
          >
            kill
          </button>
        )}
      </div>
    </EntryShell>
  )
}
