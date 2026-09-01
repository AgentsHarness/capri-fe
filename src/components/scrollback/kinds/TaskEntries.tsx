import type { ScrollEntry } from '../../../api/types'
import { subagentMeta } from '../../../format'
import { InlineAction } from '../../InlineAction'
import { Bullet, EntryShell } from '../EntryShell'
import { ViewButton } from '../ViewButton'
import type { EntryChrome } from '../chrome'

export function SubagentEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'subagent' }>
  chrome: EntryChrome
}) {
  const { shell, bullet, openViewer, cancelSubagent } = chrome
  // 整行单击直接弹全文查看器（原「先选中再点查看」的展开流程取消）。
  const rowShell = { ...shell, onSelect: () => openViewer(e.id) }
  const label =
    e.status === 'started'
      ? 'Agent'
      : e.status === 'completed'
        ? 'Agent done'
        : e.status === 'cancelled'
          ? 'Agent cancelled'
          : 'Agent failed'
  return (
    <EntryShell {...rowShell}>
      <div
        className={`flex items-center gap-1.5 ${shell.dense ? 'py-0' : 'py-[2px]'} text-[13px] leading-[1.35]`}
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
          // wire 标识符理论上可超长：min-w-0 truncate 与标题同规则，
          // 不把行撑出内容列（截断细节 hover/查看器可见）。
          <span className="min-w-0 truncate text-[11px] text-gn-gutter">
            {subagentMeta(e.persona, e.role, e.model)}
          </span>
        )}
        {e.detail && (
          <span className="text-[11px] text-gn-gutter truncate">{e.detail}</span>
        )}
        {e.running && e.subagentId && (
          <InlineAction
            label="cancel"
            title="x.ai/subagent/cancel"
            className="ml-auto"
            onRun={() => void cancelSubagent(e.subagentId!)}
          />
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
  const { shell, bullet, openViewer } = chrome
  const showView = shell.selected
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
        <ViewButton
          visible={showView}
          onOpen={() => openViewer(e.id)}
          className="ml-auto"
        />
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
  const { shell, bullet, openViewer, killTask } = chrome
  // 整行单击直接弹全文查看器（与 Agent 行同一形态，不需要先选中再点查看）。
  const rowShell = { ...shell, onSelect: () => openViewer(e.id) }
  // TUI: "Task started: {description|command}" — bold "Task", name is primary.
  // 整行单击 / Enter → block viewer with live stdout (TUI OpenBlockViewer).
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
    <EntryShell {...rowShell}>
      <div
        className={`flex items-center gap-1.5 ${shell.dense ? 'py-0' : 'py-[2px]'} text-[13px] leading-[1.35]`}
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
          <InlineAction
            label="kill"
            title="x.ai/task/kill"
            className="ml-auto"
            onRun={() => void killTask(e.taskId!)}
          />
        )}
      </div>
    </EntryShell>
  )
}
