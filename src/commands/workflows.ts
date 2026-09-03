/**
 * Module-wide cache of installed workflows (x.ai/workflows/list). Feeds the
 * `/workflow` argument dropdown: `suggestArgs` — like the merged command
 * list — must stay synchronous, so the RPC result rides this cache and the
 * menu refreshes it when the args phase opens (same shape as skills.ts).
 */
import type { WorkflowInfo } from '../api/types'

let cached: WorkflowInfo[] = []

export function cachedWorkflows(): WorkflowInfo[] {
  return cached
}

export function setCachedWorkflows(list: WorkflowInfo[]): void {
  cached = list
}
