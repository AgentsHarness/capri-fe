import { transport } from '../../../api/client'
import type { ChatState, SetState } from '../types'
import { captureAsyncScope, isAsyncScopeCurrent } from '../globals'

export function liveTaskActions(set: SetState, get: () => ChatState) {
  return {
  refreshTaskOutput: async (taskId, sessionId, cwd) => {
    if (!taskId) return
    const s = get()
    const scope = captureAsyncScope(get, sessionId, cwd)
    const entryId = s.bgTaskIndex[taskId]
    try {
      const snap = await transport.taskOutput(
        taskId,
        sessionId || cwd ? { sessionId, cwd } : undefined,
      )
      if (!isAsyncScopeCurrent(get, scope)) return
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

  syncLiveTasks: async () => {
    const scope = captureAsyncScope(get)
    try {
      const tasks = await transport.listTasks()
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

      // Upsert only: keep live scrollback rows fresh; route RESTORED
      // running tasks to the TOP STRIP — the strip is the single place
      // for the running state (replay skips started rows, so no
      // scrollback row exists for them). Do NOT complete tasks merely
      // because they are missing from this response — wait for
      // task_completed SSE.
      for (const snap of tasks) {
        const existingId = bgTaskIndex[snap.taskId]
        const title =
          snap.description ||
          snap.command ||
          `Task ${snap.taskId.slice(0, 8)}`
        // A top-strip (restored) task the agent's registry knows: it
        // STAYS in the strip while running — no strip→scrollback move
        // (the running state only lives at the top). Completed entries
        // just drop from the strip; the completion settles the rows.
        if (topTasks.some((t) => t.taskId === snap.taskId)) {
          if (snap.completed === true) {
            topTasks = topTasks.filter((t) => t.taskId !== snap.taskId)
            changed = true
          }
          continue
        }
        if (!existingId) {
          // History never saw task_backgrounded (page boundary / dropped
          // SSE during historyLoading). A still-running task goes to the
          // TOP STRIP, not an invented scrollback row; fully completed
          // ghosts are skipped (the list may retain finished tasks).
          if (snap.completed) continue
          topTasks = [
            ...topTasks,
            {
              taskId: snap.taskId,
              title,
              command: snap.command,
              restored: true,
              outputFile: snap.outputFile,
            },
          ]
          changed = true
          continue
        }
        entries = entries.map((e) => {
          if (e.id !== existingId || e.kind !== 'bg_task') return e
          const nextOut =
            snap.output != null && snap.output.length >= (e.output?.length ?? 0)
              ? snap.output
              : e.output
          if (snap.completed === true && e.running) {
            changed = true
            return {
              ...e,
              title: e.title || title,
              status: 'completed' as const,
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
