import type { ScrollEntry, ToolCall } from '../../api/types'
import type { ChatState } from './types'
import { nonBlankStr, wireTaskId } from './util'

/**
 * Tool call IDs suppressed from scrollback (TUI suppressed_tools +
 * bg_deferred_tools). Cleared when the transcript is reset.
 */
export const suppressedToolIds = new Set<string>()

export function clearSuppressedTools() {
  suppressedToolIds.clear()
}

export function extractTarget(tc: ToolCall): string {
  const ri = toolRawInput(tc)
  if (!ri) return tc.title || ''
  const s =
    (ri.path as string) ||
    (ri.filePath as string) ||
    (ri.command as string) ||
    (ri.query as string) ||
    (ri.url as string) ||
    (ri.pattern as string) ||
    tc.title ||
    ''
  return String(s)
}

/** ACP ToolCall raw_input (camelCase or snake_case wire). */
export function toolRawInput(tc: ToolCall): Record<string, unknown> | undefined {
  const ri = tc.rawInput ?? (tc as { raw_input?: unknown }).raw_input
  return ri && typeof ri === 'object' && !Array.isArray(ri)
    ? (ri as Record<string, unknown>)
    : undefined
}

export function toolTitle(tc: ToolCall): string {
  return typeof tc.title === 'string' ? tc.title : ''
}

export function toolVariant(tc: ToolCall): string | undefined {
  const v = toolRawInput(tc)?.variant
  return typeof v === 'string' ? v : undefined
}

export function isExecuteToolFunctionName(s: string): boolean {
  switch (s.toLowerCase()) {
    case 'run_terminal_command':
    case 'run_terminal_cmd':
    case 'bash':
    case 'shell':
    case 'execute':
    case 'run_command':
    case 'terminal':
      return true
    default:
      return false
  }
}

/**
 * TUI is_bg_plumbing_tool — get/kill/wait task tools dump stdout into the
 * model; UI already has the bg_task row + dblclick viewer.
 *
 * Wire note: the *final* completed update often rewrites title to
 * `"npm run dev (taskId)"` and clears rawInput, leaving only
 * `rawOutput: { type: "TaskOutput", Result: {…} }`. Match that shape too
 * or the log reappears as "Ran other".
 */
export function isBgPlumbingTool(tc: ToolCall): boolean {
  const title = toolTitle(tc)
  if (
    title === 'get_command_or_subagent_output' ||
    title === 'kill_command_or_subagent' ||
    title === 'wait_commands_or_subagents' ||
    title === 'get_task_output' ||
    title === 'kill_task' ||
    title === 'wait_tasks' ||
    title === 'get_task_or_subagent_output' ||
    title === 'kill_task_or_subagent' ||
    title === 'wait_tasks_or_subagents' ||
    title === 'AwaitShell' ||
    title === 'Await'
  ) {
    return true
  }
  if (
    title.startsWith('Await:') ||
    title.startsWith('Sleep ') ||
    title.startsWith('Wait tasks:') ||
    title.startsWith('Kill task:') ||
    // Display titles stamped on tool_call_update
    title.startsWith('Get task output') ||
    title.startsWith('Get command output') ||
    title.startsWith('Wait tasks') ||
    title.startsWith('Kill task')
  ) {
    return true
  }
  const variant = toolVariant(tc)
  if (
    variant === 'TaskOutput' ||
    variant === 'KillTask' ||
    variant === 'WaitTasks'
  ) {
    return true
  }
  // Final completed update: rawInput cleared, TaskOutput only in rawOutput.
  const ro = toolRawOutput(tc)
  if (ro && typeof ro === 'object' && !Array.isArray(ro)) {
    const t = (ro as { type?: unknown }).type
    if (t === 'TaskOutput' || t === 'KillTask' || t === 'WaitTasks') return true
  }
  return false
}

/** ACP ToolCall raw_output (camelCase or snake_case wire). */
export function toolRawOutput(tc: ToolCall): unknown {
  return tc.rawOutput ?? (tc as { raw_output?: unknown }).raw_output
}

/** TUI is_bg_tool — execute with is_background; BgTask block owns the row. */
export function isBgExecuteTool(tc: ToolCall): boolean {
  const kind = String(tc.kind || '').toLowerCase()
  const title = toolTitle(tc)
  const looksLikeExecute = kind === 'execute' || isExecuteToolFunctionName(title)
  if (!looksLikeExecute) return false
  const ri = toolRawInput(tc)
  if (!ri) return false
  const bg = ri.is_background ?? ri.background ?? ri.isBackground
  return bg === true
}

/** TUI is_task_tool — subagent spawn (SubagentBlock owns the row). */
export function isTaskSpawnTool(tc: ToolCall): boolean {
  const title = toolTitle(tc)
  if (title === 'task' || title === 'Task' || title === 'spawn_subagent') return true
  const v = toolVariant(tc)
  return v === 'Task' || v === 'SpawnSubagent' || v === 'spawn_subagent'
}

export function isTodoTool(tc: ToolCall): boolean {
  const title = toolTitle(tc)
  if (title === 'todo_write' || title === 'TodoWrite' || title === 'Updating plan')
    return true
  const v = toolVariant(tc)
  return v === 'TodoWrite' || v === 'todo_write' || v === 'UpdateTodos'
}

export function isGoalTool(tc: ToolCall): boolean {
  const title = toolTitle(tc)
  if (title === 'update_goal' || title.startsWith('Goal:')) return true
  const v = toolVariant(tc)
  return v === 'UpdateGoal' || v === 'WorkflowSignal'
}

export function isSchedulerTool(tc: ToolCall): boolean {
  const title = toolTitle(tc)
  if (title.startsWith('scheduler_')) return true
  const v = toolVariant(tc)
  return !!v && v.startsWith('Scheduler')
}

export function isWorkflowTool(tc: ToolCall): boolean {
  const title = toolTitle(tc)
  const v = toolVariant(tc)
  const isWorkflow = title === 'workflow' || v === 'Workflow'
  if (!isWorkflow) return false
  const ri = toolRawInput(tc)
  const validateOnly =
    title.startsWith('Validating workflow') || ri?.validate_only === true
  return !validateOnly
}

/**
 * TUI handle_tool_call suppress list + bg-deferred execute.
 * Logs for background tasks must not appear as "Ran other" tool rows —
 * they live in the bg_task entry (double-click / Enter → BlockViewer).
 */
export function shouldSuppressToolFromScrollback(tc: ToolCall): boolean {
  return (
    isBgPlumbingTool(tc) ||
    isBgExecuteTool(tc) ||
    isTaskSpawnTool(tc) ||
    isTodoTool(tc) ||
    isGoalTool(tc) ||
    isSchedulerTool(tc) ||
    isWorkflowTool(tc)
  )
}

/** toolCallId from camelCase or snake_case wire. */
export function toolCallIdOf(tc: ToolCall): string | undefined {
  const id =
    tc.toolCallId ??
    (tc as { tool_call_id?: unknown }).tool_call_id ??
    (tc as { id?: unknown }).id
  return typeof id === 'string' && id ? id : undefined
}

/**
 * Agent 扩展 tool-call 分类（tool_call `_meta["x.ai/tool"].kind`，
 * 1.0.9+ 起新增 `active_agent_message` 等，版本号之外的前向值都容忍）。
 * 官方顶层 `kind` 对这些调用恒为 `other`，扩展分类只用于动词渲染。
 */
export function xaiToolKind(tc: ToolCall): string | undefined {
  const meta = tc._meta as Record<string, unknown> | undefined
  const xai = meta?.['x.ai/tool']
  if (!xai || typeof xai !== 'object' || Array.isArray(xai)) return undefined
  const k = (xai as Record<string, unknown>).kind
  return typeof k === 'string' && k ? k : undefined
}

/**
 * tool_call 行的分类名：扩展分类（x.ai/tool.kind）优先于官方顶层 kind
 * ——`active_agent_message` 的顶层 kind 恒为 `other`，取官方值会把新
 * 调用渲染成泛型 "Ran"。更新路径的 merged 对象同款优先序。
 */
export function toolKindName(tc: ToolCall, fallback: string | undefined): string {
  return xaiToolKind(tc) || (tc.kind as string) || fallback || 'other'
}

/**
 * When a suppressed get_task_output completes, fold its Result.output into
 * the matching bg_task entry so dblclick viewer has the log without a
 * separate "Ran other" row.
 */
export function absorbTaskOutputIntoBgTask(
  get: () => ChatState,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set: (partial: any) => void,
  tc: ToolCall,
): void {
  const ro = toolRawOutput(tc)
  if (!ro || typeof ro !== 'object' || Array.isArray(ro)) return
  const obj = ro as Record<string, unknown>
  if (obj.type !== 'TaskOutput') return
  const result = (obj.Result ?? obj.result) as Record<string, unknown> | undefined
  if (!result || typeof result !== 'object') return
  const taskId = wireTaskId(result.task_id, result.taskId)
  if (!taskId) return
  const output =
    typeof result.output === 'string'
      ? result.output
      : typeof result.stdout === 'string'
        ? result.stdout
        : undefined
  if (output == null) return
  const entryId = get().bgTaskIndex[taskId]
  if (!entryId) return
  const cmd =
    nonBlankStr(result.command) ?? nonBlankStr(result.display_command)
  set({
    entries: get().entries.map((e) => {
      if (e.id !== entryId || e.kind !== 'bg_task') return e
      const nextOut =
        output.length >= (e.output?.length ?? 0) ? output : e.output
      return {
        ...e,
        output: nextOut,
        command: cmd || e.command,
      }
    }),
  })
}

/** Bash rawOutput payload from execute tool streaming. */
export function bashRawOutput(tc: ToolCall): Record<string, unknown> | null {
  const ro = toolRawOutput(tc)
  if (!ro || typeof ro !== 'object' || Array.isArray(ro)) return null
  const obj = ro as Record<string, unknown>
  const t = obj.type
  if (t === 'Bash' || t === 'bash') return obj
  return null
}

/**
 * History page-boundary orphan: streaming Bash tool_call_update with no
 * matching tool_call in the loaded page (and thus no is_background flag).
 * On "start acpfe" the last 100 envelopes are almost all of these — FE used
 * to invent "Ran other" rows and dump host/vite logs into scrollback.
 */
export function isOrphanBashStreamUpdate(tc: ToolCall): boolean {
  const bash = bashRawOutput(tc)
  if (!bash) return false
  // Full tool_call with is_background is handled by isBgExecuteTool.
  if (isBgExecuteTool(tc)) return true
  const title = toolTitle(tc)
  const kind = tc.kind
  // Typical orphan shape: no title, no kind, status in_progress, Bash body.
  if (!title && (kind == null || kind === '' || String(kind).toLowerCase() === 'other')) {
    return true
  }
  // Truncated long-running stream (background servers).
  if (bash.truncated === true || bash.truncated === 'True') return true
  return false
}

/** Pull human-readable stdout from a Bash rawOutput object. */
export function bashOutputText(bash: Record<string, unknown>): string | undefined {
  if (typeof bash.output_for_prompt === 'string' && bash.output_for_prompt) {
    return bash.output_for_prompt
  }
  if (typeof bash.outputForPrompt === 'string' && bash.outputForPrompt) {
    return bash.outputForPrompt
  }
  if (typeof bash.output === 'string' && bash.output && bash.output !== '[]') {
    return bash.output
  }
  return undefined
}

/**
 * Content fingerprint used to attribute an update that carries no
 * toolCallId. Completion updates omit rawInput entirely, so the only
 * discriminators on the wire are the Bash rawOutput.command and the
 * write/edit diff path; earlier rename updates carry rawInput instead.
 */
export function anonToolKey(tc: ToolCall): string | undefined {
  const cmd =
    nonBlankStr(bashRawOutput(tc)?.command) ??
    nonBlankStr(toolRawInput(tc)?.command)
  if (cmd) return `cmd:${cmd}`
  const ri = toolRawInput(tc)
  const path =
    nonBlankStr(ri?.path) ??
    nonBlankStr(ri?.filePath) ??
    nonBlankStr(ri?.file_path) ??
    diffContentPath(tc)
  return path ? `path:${path}` : undefined
}

function diffContentPath(tc: ToolCall): string | undefined {
  const content = (tc as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  for (const c of content) {
    if (!c || typeof c !== 'object') continue
    if ((c as { type?: unknown }).type !== 'diff') continue
    const p = nonBlankStr((c as { path?: unknown }).path)
    if (p) return p
  }
  return undefined
}

/**
 * Routing target for a tool_call_update whose toolCallId is empty. Some
 * OpenAI/responses-compatible endpoints hand back function calls with no
 * call_id, and the agent relays that blank key verbatim, so nothing can be
 * looked up in toolIndex — the row sat at "Running" until the turn-end
 * settle (minutes for a long agentic turn). Claim the oldest unclaimed
 * anonymous row instead; `exact` says whether the content fingerprint
 * identified it, which is what makes merging raw safe.
 */
export function findAnonToolTarget(
  entries: ScrollEntry[],
  tc: ToolCall,
): { entryId: string; exact: boolean } | undefined {
  const candidates = entries.filter(
    (e) =>
      e.kind === 'tool' &&
      !e.toolCallId &&
      (e.status === 'pending' || e.status === 'in_progress'),
  )
  const first = candidates[0]
  if (!first) return undefined
  const key = anonToolKey(tc)
  if (key) {
    for (const e of candidates) {
      if (e.kind === 'tool' && e.raw && anonToolKey(e.raw) === key) {
        return { entryId: e.id, exact: true }
      }
    }
  }
  return { entryId: first.id, exact: false }
}

/**
 * Fold orphan Bash stream output into a bg_task row matched by command.
 * Does nothing when no matching task exists yet (timeline / live list will
 * create the row; later streams can attach once the index is populated).
 */
export function absorbBashOutputIntoBgTask(
  get: () => ChatState,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set: (partial: any) => void,
  tc: ToolCall,
): void {
  const bash = bashRawOutput(tc)
  if (!bash) return
  const cmd =
    nonBlankStr(bash.command) ??
    nonBlankStr(toolRawInput(tc)?.command)
  const output = bashOutputText(bash)
  if (!cmd && !output) return

  // Prefer exact command match; fall back to suffix / includes.
  const entries = get().entries
  let entryId: string | undefined
  if (cmd) {
    const exact = entries.find(
      (e) => e.kind === 'bg_task' && e.command === cmd,
    )
    if (exact) entryId = exact.id
    if (!entryId) {
      const loose = entries.find(
        (e) =>
          e.kind === 'bg_task' &&
          !!e.command &&
          (e.command.endsWith(cmd) ||
            cmd.endsWith(e.command) ||
            e.command.includes(cmd) ||
            cmd.includes(e.command)),
      )
      if (loose) entryId = loose.id
    }
  }
  if (!entryId) return
  if (output == null) return
  set({
    entries: get().entries.map((e) => {
      if (e.id !== entryId || e.kind !== 'bg_task') return e
      const nextOut =
        output.length >= (e.output?.length ?? 0) ? output : e.output
      return {
        ...e,
        output: nextOut,
        command: cmd || e.command,
      }
    }),
  })
}
