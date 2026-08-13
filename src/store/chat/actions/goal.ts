import { transport } from '../../../api/localTransport'
import type { ChatState, SetState } from '../types'
import { sendControlPrompt } from '../control'

export function goalActions(set: SetState, get: () => ChatState) {
  return {
  goalSet: async (objective, tokenBudget) => {
    const o = objective.trim()
    if (!o) {
      set({ statusText: '目标设定失败: 缺少目标描述' })
      return
    }
    // Tolerate a trailing --budget in the objective for direct callers.
    let budget = tokenBudget
    const budgetMatch = o.match(/--budget\s+([\d.]+[kKmM]?)/i)
    const clean = budgetMatch ? o.slice(0, budgetMatch.index).trim() : o
    if (budgetMatch && budget == null) {
      const n = Number(budgetMatch[1])
      if (!Number.isNaN(n)) budget = Math.round(n)
    }
    try {
      const data = await transport.goalSet(clean, budget, get().sessionId)
      if (data.goal) set({ goalState: data.goal, goalReceivedAt: Date.now() })
      set({ statusText: '目标已设定，开始执行' })
    } catch (e) {
      set({ statusText: `目标设定失败: ${e instanceof Error ? e.message : e}` })
    }
  },
  goalStatus: async () => {
    try {
      const data = await transport.goalStatus(get().sessionId)
      if (data.goal) {
        set({ goalState: data.goal, goalReceivedAt: Date.now() })
        set({ statusText: `目标状态: ${String(data.goal.status)}` })
      } else {
        set({ statusText: '暂无目标状态（当前没有进行中的目标）' })
      }
    } catch (e) {
      set({ statusText: `目标状态查询失败: ${e instanceof Error ? e.message : e}` })
    }
  },
  goalPause: async () => {
    try {
      const data = await transport.goalPause(get().sessionId)
      if (data.goal) set({ goalState: data.goal, goalReceivedAt: Date.now() })
      set({ statusText: '目标已暂停' })
    } catch (e) {
      set({ statusText: `目标暂停失败: ${e instanceof Error ? e.message : e}` })
    }
  },
  goalResume: async () => {
    try {
      const data = await transport.goalResume(get().sessionId)
      if (data.goal) set({ goalState: data.goal, goalReceivedAt: Date.now() })
      set({ statusText: '目标已恢复' })
    } catch (e) {
      set({ statusText: `目标恢复失败: ${e instanceof Error ? e.message : e}` })
    }
  },
  goalClear: async () => {
    try {
      const data = await transport.goalClear(get().sessionId)
      if (data.goal) set({ goalState: data.goal, goalReceivedAt: Date.now() })
      set({ statusText: '目标已清除' })
    } catch (e) {
      set({ statusText: `目标清除失败: ${e instanceof Error ? e.message : e}` })
    }
  },

  /**
   * Workflow pause/resume/stop — same protocol gap as goals: no wire
   * method exists for workflow control, so the instruction goes through
   * the prompt path. Before sending, the row is optimistically updated
   * to the target status with a pendingControl marker; the next
   * workflow_updated for this run corrects both (the event is
   * authoritative).
   */
  workflowControl: (runId, action) => {
    const st = get()
    const run = st.workflowRuns[runId]
    if (!run) return
    const verb = action === 'pause' ? '暂停' : action === 'resume' ? '恢复' : '停止'
    const targetStatus =
      action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'cancelled'
    set({
      workflowRuns: {
        ...st.workflowRuns,
        [runId]: { ...run, status: targetStatus, pendingControl: action },
      },
    })
    sendControlPrompt(
      get,
      set,
      `请${verb}工作流 ${run.name}（用 workflow 工具的 ${action}）`,
      `工作流「${run.name}」${verb}指令已发送（等待 workflow_updated 校正）`,
    )
  },

  /**
   * "Save script" — local-only: copies the run's script payload (when
   * the workflow_updated event carried one) to the clipboard and reports
   * a summary on the status line. No wire round-trip; runs without a
   * script payload just report it as unavailable.
   */
  saveWorkflowScript: async (runId) => {
    const run = get().workflowRuns[runId]
    if (!run) return
    const script = run.script ?? ''
    if (!script.trim()) {
      set({
        statusText: `工作流「${run.name}」脚本不可用（workflow_updated 未携带 script 字段）`,
      })
      return
    }
    try {
      await navigator.clipboard.writeText(script)
      set({
        statusText: `已复制「${run.name}」脚本到剪贴板（${script.length} 字符）`,
      })
    } catch (e) {
      set({
        statusText: `复制失败: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
  },
  } satisfies Partial<ChatState>
}
