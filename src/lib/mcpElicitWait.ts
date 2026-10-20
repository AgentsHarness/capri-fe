/**
 * URL-mode elicitation stays on screen after Accept: the JSON-RPC answer
 * has already gone out, and `x.ai/mcp/elicit_complete` is what dismisses
 * the "waiting" stage (TUI begin_url_waiting).
 */

export type UrlWait = {
  elicitationId: string
  serverName: string
  url: string
  message: string
}

let wait: UrlWait | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const fn of listeners) fn()
}

export function urlWaitSnapshot(): UrlWait | null {
  return wait
}

export function subscribeUrlWait(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function beginUrlWait(next: UrlWait) {
  wait = next
  emit()
}

export function clearUrlWait() {
  if (!wait) return
  wait = null
  emit()
}

/** Drop the waiting card when the complete notice matches id and, if both sides named a server, the server. */
export function dismissUrlWait(elicitationId: string, serverName?: string) {
  if (!wait || wait.elicitationId !== elicitationId) return
  if (serverName && wait.serverName && serverName !== wait.serverName) return
  clearUrlWait()
}
