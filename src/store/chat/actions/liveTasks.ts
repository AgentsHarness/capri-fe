import { transport } from '../../../api/client'
import type { ChatState, SetState } from '../types'
import { captureAsyncScope, isAsyncScopeCurrent } from '../globals'
import { topTaskFrom } from '../tasks'

export function liveTaskActions(set: SetState, get: () => ChatState) {
  return {
  refreshTaskOutput: async (taskId, sessionId, cwd) => {
    if (!taskId) return
    const scope = captureAsyncScope(get, sessionId, cwd)
    try {
      const snap = await transport.taskOutput(
        taskId,
        sessionId || cwd ? { sessionId, cwd } : undefined,
      )
      if (!isAsyncScopeCurrent(get, scope)) return
      // 快照必须在 await 之后取：用请求前的旧 entries 整体回写，会把等待
      // 期间新追加的行（agent 正在流式输出）直接顶掉。
      const s = get()
      const entryId = s.bgTaskIndex[taskId]
      // Live row target: update the scrollback entry (viewer renders it).
      if (entryId) {
        set({
          entries: s.entries.map((e) => {
            if (e.id !== entryId || e.kind !== 'bg_task') return e
            // Prefer the longer buffer so a partial list response never
            // clobbers monitor_event-accumulated output.
            const nextOut =
              snap.output != null && snap.output.length >= (e.output?.length ?? 0)
                ? snap.output
                : e.output
            return {
              ...e,
              output: nextOut,
              command: snap.command || e.command,
              outputFile: snap.outputFile || e.outputFile,
              ...(snap.completed && e.running
                ? {
                    running: false,
                    status: 'completed' as const,
                    finishedAt: Date.now(),
                  }
                : {}),
            }
          }),
        })
      }
      // Task-view target: no entry exists (top strip / history replay) —
      // update the open viewer's task state so the log flows in.
      const vt = get().viewerTask
      if (vt && vt.taskId === taskId) {
        const nextOut =
          snap.output != null && snap.output.length >= (vt.output?.length ?? 0)
            ? snap.output
            : vt.output
        set({
          viewerTask: {
            ...vt,
            command: snap.command || vt.command,
            outputFile: snap.outputFile || vt.outputFile,
            output: nextOut,
            running: snap.running ?? (snap.completed ? false : vt.running),
            completed: snap.completed ?? vt.completed,
            failed: snap.failed ?? vt.failed,
          },
        })
      }
    } catch {
      // 404 / offline — viewer still shows whatever we already accumulated.
    }
  },

  /**
   * Fold the agent's live task registry into the view. `sessionId` names the
   * session whose registry to read — the resume path is racing session/load,
   * and an unscoped query answers for whichever session is active, which
   * would put another session's tasks in this strip.
   */
  syncLiveTasks: async (sessionId) => {
    const scope = captureAsyncScope(get)
    try {
      const targetSessionId = sessionId ?? get().sessionId
      const tasks = await transport.listTasks(targetSessionId)
      if (!isAsyncScopeCurrent(get, scope)) return
      // Empty list is not authoritative (parse race / session still
      // focusing). Never use absence to settle running rows — that caused
      // a flash: history shows ⠋N, then sync marks everything completed.
      if (tasks.length === 0) return

      const s = get()
      let entries = s.entries
      let bgTaskIndex = { ...s.bgTaskIndex }
      let topTasks = s.topTasks
      let changed = false

      // Filter tasks for this session when session attribution is present.
      const sessionTasks = tasks.filter(
        (t) => !t.sessionId || !targetSessionId || t.sessionId === targetSessionId,
      )

      // Upsert only: keep live scrollback rows fresh; route registry-known
      // running tasks with no scrollback row to the TOP STRIP — the strip is
      // the single place for the running state (replay skips started rows, so
      // no scrollback row exists for them). The registry is the strip's ONLY
      // source: a task listed here is one this agent process can kill. Do NOT
      // complete tasks merely because they are missing from this response —
      // wait for task_completed SSE.
      for (const snap of sessionTasks) {
        const existingId = bgTaskIndex[snap.taskId]
        const title =
          snap.description ||
          snap.command ||
          `Task ${snap.taskId.slice(0, 8)}`

        // Genuine running background task: must be a background task (not foreground command)
        // and must not have completed or failed.
        // Foreground commands run in milliseconds and finish on their own —
        // they must NEVER be placed into the top task strip.
        const isRunningBg =
          !snap.completed && snap.running !== false && snap.isBackgrounded !== false

        // A top-strip task the agent's registry knows: it STAYS in the strip
        // while running — no strip→scrollback move (the running state only
        // lives at the top). Completed entries or tasks no longer running
        // just drop from the strip; the completion settles the rows.
        if (topTasks.some((t) => t.taskId === snap.taskId)) {
          if (!isRunningBg) {
            topTasks = topTasks.filter((t) => t.taskId !== snap.taskId)
            changed = true
          }
          continue
        }
        if (!existingId) {
          // History never saw task_backgrounded (page boundary / dropped
          // SSE during historyLoading). A still-running background task goes to the
          // TOP STRIP, not an invented scrollback row; fully completed
          // ghosts and foreground commands are skipped.
          if (!isRunningBg) continue
          // 与 background_tasks 快照共用同一套字段推导（tasks.ts），
          // 两个写者不会给同一任务换标题 / 丢 outputFile。
          const row = topTaskFrom({
            taskId: snap.taskId,
            description: snap.description,
            command: snap.command,
            outputFile: snap.outputFile,
            // 注册表快照无 kind 字段：monitor 只能按遗留前缀识别
            // （与 handleTaskBackgrounded 同款判定）。
            isMonitor: snap.command?.startsWith('[monitor] ') ? true : undefined,
          })
          if (row) {
            topTasks = [...topTasks, row]
            changed = true
          }
          continue
        }
        entries = entries.map((e) => {
          if (e.id !== existingId || e.kind !== 'bg_task') return e
          const nextOut =
            snap.output != null && snap.output.length >= (e.output?.length ?? 0)
              ? snap.output
              : e.output
          if ((snap.completed === true || snap.running === false) && e.running) {
            changed = true
            return {
              ...e,
              title: e.title || title,
              status: snap.failed ? ('failed' as const) : ('completed' as const),
              running: false,
              finishedAt: e.finishedAt ?? Date.now(),
              output: nextOut,
              command: snap.command || e.command,
              outputFile: snap.outputFile || e.outputFile,
            }
          }
          if (
            nextOut !== e.output ||
            (snap.command && snap.command !== e.command) ||
            (snap.outputFile && snap.outputFile !== e.outputFile)
          ) {
            changed = true
            return {
              ...e,
              title: e.title || title,
              output: nextOut,
              command: snap.command || e.command,
              outputFile: snap.outputFile || e.outputFile,
            }
          }
          return e
        })
      }

      if (changed) set({ entries, bgTaskIndex, topTasks })
    } catch {
      // Offline / no session — leave history-only view.
    }
  },
  } satisfies Partial<ChatState>
}
