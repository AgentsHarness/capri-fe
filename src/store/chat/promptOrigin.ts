/**
 * TUI `app/acp_handler/prompt_origin.rs` — pid prefixes that mark a
 * server-initiated auto-wake turn (`task-completed-…`, `subagent-completed-…`,
 * `workflow-completed-…`, `parent-message-…`, `notifications-…`).
 *
 * Wake turns run non-adopted (no `PromptResponse`, no viewer finalize), so
 * their stop-hook batches never fold into the live turn's stash. Narrower
 * than "any synthetic pid": `/loop` (`scheduler-fired-…`) and goal/plan
 * resumes are not wakes.
 */
export function isWakePrompt(promptId: string): boolean {
  return (
    promptId.startsWith('task-completed-') ||
    promptId.startsWith('subagent-completed-') ||
    promptId.startsWith('workflow-completed-') ||
    promptId.startsWith('parent-message-') ||
    promptId.startsWith('notifications-')
  )
}
