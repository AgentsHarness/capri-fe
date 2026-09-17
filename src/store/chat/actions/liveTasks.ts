import { transport } from '../../../api/client'
import type { ChatState, SetState } from '../types'
import { captureAsyncScope, isAsyncScopeCurrent } from '../globals'
import { topTaskFrom } from '../tasks'
import { foldRunningSubagents, parseRunningSubagents } from '../subagentRegistry'

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

  /**
   * 把 agent 的「在跑子代理」注册表（x.ai/subagent/list_running）折进视图。
   *
   * 与 syncLiveTasks 同源的缺口：`subagent_spawned` 只在它自己那一轮被回放
   * 到时才建行，而首屏只回放最后 1 轮——在更早轮次派出、现在还在跑的子代理
   * 切换会话后就从顶部消失了（TUI 不会：它 session/load 后按注册表重建面板）。
   *
   * 只做「补行」不做「收口」：收口由 subagent_finished 负责（与 bg_task 的
   * task_completed 同款）。注册表为空同样不据缺失结算——一次解析异常 /
   * 会话未聚焦都会给空表，用它收口会把真在跑的行误判成完成。
   *
   * `mode` 决定结果何时落地：
   *  - 'apply'（默认，live 轮询 / 普通刷新）：拉到即折进当前视图；
   *  - 'defer'（会话重建链路）：只取数不落地，交给回放收口后由
   *    applyRunningSubagents 折进——loadHistory 会整体替换 entries，
   *    提前落地会被回放覆盖掉。
   *
   * 返回本会话的注册表行（未按会话过滤前为空则空数组），供轮询门控与
   * defer 调用方使用；失败返回空数组。
   */
  syncLiveSubagents: async (sessionId, mode) => {
    const scope = captureAsyncScope(get)
    try {
      const targetSessionId = sessionId ?? get().sessionId
      if (!targetSessionId) return []
      const raw = await transport.subagentListRunning({ sessionId: targetSessionId })
      if (!isAsyncScopeCurrent(get, scope)) return []
      const all = parseRunningSubagents(raw)
      // 归属过滤：agent 按 parent_session_id 过滤，但旧 agent / 直连可能
      // 不过滤——带归属且不是本会话的行一律丢弃（同 syncLiveTasks）。
      const rows = all.filter(
        (r) =>
          !r.parentSessionId ||
          !targetSessionId ||
          r.parentSessionId === targetSessionId,
      )
      if (rows.length > 0 && mode !== 'defer') {
        const patch = foldRunningSubagents(get, rows, Date.now())
        if (patch) set(patch)
      }
      return rows
    } catch {
      // 离线 / 旧 host 无该端点 — 保持回放结果。
      return []
    }
  },

  /** 把已取到的注册表结果折进视图（defer 模式的收口点；见 syncLiveSubagents）。 */
  applyRunningSubagents: (rows) => {
    if (rows.length === 0) return
    const patch = foldRunningSubagents(get, rows, Date.now())
    if (patch) set(patch)
  },
  } satisfies Partial<ChatState>
}
