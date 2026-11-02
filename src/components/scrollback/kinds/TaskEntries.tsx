import { useState } from 'react'
import type { ScrollEntry } from '../../../api/types'
import { subagentMeta } from '../../../format'
import { InlineAction } from '../../ui/InlineAction'
import { KillTaskAction } from '../../ui/KillTaskAction'
import { Bullet, EntryShell } from '../EntryShell'
import type { EntryChrome } from '../chrome'

export function SubagentEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'subagent' }>
  chrome: EntryChrome
}) {
  const { shell, bullet, openViewer, cancelSubagent, readonly = false } = chrome
  /**
   * 取消请求在飞：`[cancel]` 转圈并禁用。成功时行由 agent 的
   * subagent_finished 事件收口，这里的转圈在请求返回后落下。
   */
  const [cancelling, setCancelling] = useState(false)
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
        {(e.persona || e.role || e.model || e.reasoningEffort) && (
          // wire 标识符理论上可超长：min-w-0 truncate 与标题同规则，
          // 不把行撑出内容列（截断细节 hover/查看器可见）。
          <span className="min-w-0 truncate text-[11px] text-gn-gutter">
            {subagentMeta(e.persona, e.role, e.model, e.reasoningEffort)}
          </span>
        )}
        {e.detail && (
          <span className="text-[11px] text-gn-gutter truncate">{e.detail}</span>
        )}
        {e.running && e.subagentId && !readonly && (
          <InlineAction
            label="cancel"
            busyLabel="cancel"
            busy={cancelling}
            title="x.ai/subagent/cancel"
            className="ml-auto"
            onRun={() => {
              if (cancelling) return
              setCancelling(true)
              const pending = cancelSubagent(e.subagentId!)
              if (pending && typeof pending.then === 'function') {
                void pending.then(
                  () => setCancelling(false),
                  () => setCancelling(false),
                )
                return
              }
              setCancelling(false)
            }}
          />
        )}
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
  const { shell, bullet, openViewer, killTask, readonly = false } = chrome
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
        {e.running && e.taskId && !readonly && (
          <KillTaskAction
            className="ml-auto"
            onKill={(notifyAgent) => killTask(e.taskId!, { notifyAgent })}
          />
        )}
      </div>
    </EntryShell>
  )
}
