import { useCallback, useEffect, useState } from 'react'
import { Repeat } from 'lucide-react'
import type { ScheduledTask } from '../../api/types'
import { formatScheduleInterval, formatScheduledFire } from '../../format'
import { useChatStore } from '../../store/chat'
import { InlineAction } from '../ui/InlineAction'
import { ScheduledTaskDetailModal } from './ScheduledTaskDetailModal'

/**
 * 调度任务行 — 与运行中任务同一条扁平列表，靠行首类别 `Loop` 区分。
 *
 * 视觉约定：
 *  - 行首 Repeat 图标 + `Loop` 类别，prompt 占主列；
 *  - 右侧元数据 `排期 · 下次触发` 用留白分隔，不加竖线；
 *  - 删除是低频危险动作，静止时与正文同级、hover 才亮红。
 *
 * `ScheduledTasksView` 是纯展示层（不读 store），供状态画廊 / 截图复用。
 */
export function ScheduledTasksView({
  tasks,
  readonly = false,
  onOpen,
  onDelete,
}: {
  tasks: ScheduledTask[]
  /** 访客（只读）：不渲染删除动作。 */
  readonly?: boolean
  /** 点任务主体打开详情弹窗。 */
  onOpen?: (task: ScheduledTask) => void
  onDelete?: (taskId: string) => void
}) {
  if (tasks.length === 0) return null
  return (
    <>
      {tasks.map((t) => {
        const interval = formatScheduleInterval(t.interval)
        const fire = t.nextFireAt ? formatScheduledFire(t.nextFireAt) : ''
        return (
          <div
            key={`sched-${t.taskId}`}
            className="flex min-h-[25px] items-center gap-1.5 py-0 text-[12px] leading-none hover:bg-gn-bg-highlight"
          >
            <button
              type="button"
              onClick={() => onOpen?.(t)}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 self-stretch text-left"
              title={t.prompt || t.taskId}
              aria-label={`查看调度任务详情：${t.prompt || t.taskId}`}
            >
              <Repeat size={11} className="shrink-0 text-gn-plan" aria-hidden />
              <span className="shrink-0 font-medium text-gn-plan">Loop</span>
              <span className="text-gn-gutter">·</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-gn-fg">
                {t.prompt || t.taskId.slice(0, 8)}
              </span>
              {(interval || fire) && (
                <span className="ml-1 inline-flex shrink-0 items-center gap-1 font-mono text-[10px] leading-none text-gn-muted">
                  {interval && (
                    <span
                      className="max-w-[18vw] truncate"
                      title={`排期 ${t.interval}`}
                    >
                      {interval}
                    </span>
                  )}
                  {interval && fire && (
                    <span className="text-gn-gutter">·</span>
                  )}
                  {fire && (
                    <span
                      className="shrink-0 tabular-nums"
                      title={`下次触发 ${t.nextFireAt}`}
                    >
                      下次 {fire}
                    </span>
                  )}
                </span>
              )}
            </button>
            {!readonly && onDelete && (
              <InlineAction
                label="删除"
                tone="dangerQuiet"
                title="删除调度任务"
                onRun={() => onDelete(t.taskId)}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

/** 读 store 的区块入口（`RunningTasksBar` 使用）。 */
export function ScheduledTasksSection({
  readonly = false,
}: {
  readonly?: boolean
}) {
  const tasks = useChatStore((s) => s.scheduledTasks)
  const deleteScheduledTask = useChatStore((s) => s.deleteScheduledTask)
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const openTask = openTaskId
    ? (tasks.find((t) => t.taskId === openTaskId) ?? null)
    : null
  const closeTask = useCallback(() => setOpenTaskId(null), [])

  // 任务被删除（本地 optimistic / 外部事件）后，弹窗跟着消失。
  useEffect(() => {
    if (openTaskId && !tasks.some((t) => t.taskId === openTaskId)) {
      setOpenTaskId(null)
    }
  }, [tasks, openTaskId])

  return (
    <>
      <ScheduledTasksView
        tasks={tasks}
        readonly={readonly}
        onOpen={(task) => setOpenTaskId(task.taskId)}
        onDelete={(taskId) => void deleteScheduledTask(taskId)}
      />
      <ScheduledTaskDetailModal
        task={openTask}
        readonly={readonly}
        onClose={closeTask}
        onDelete={(taskId) => void deleteScheduledTask(taskId)}
      />
    </>
  )
}
