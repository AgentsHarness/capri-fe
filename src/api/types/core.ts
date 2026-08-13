export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: string; [k: string]: unknown }



/** Per-session todo status (hub-persisted UI prefs; absence = no record). */
export type TodoStatus = 'todo' | 'completed'

/**
 * The FE's durable UI preferences for host conversations: pinned
 * workspaces (cwd paths), pinned sessions, and per-session todo status.
 * Persisted by the hub (GET/PUT /api/prefs, one shared doc in
 * prefs.json); localStorage mirrors it as the offline cache. Keys are
 * sessionId/cwd only — session ids are host-assigned UUIDs, so a doc is
 * effectively per host conversation without an explicit hostId scope.
 */


/**
 * The FE's durable UI preferences for host conversations: pinned
 * workspaces (cwd paths), pinned sessions, and per-session todo status.
 * Persisted by the hub (GET/PUT /api/prefs, one shared doc in
 * prefs.json); localStorage mirrors it as the offline cache. Keys are
 * sessionId/cwd only — session ids are host-assigned UUIDs, so a doc is
 * effectively per host conversation without an explicit hostId scope.
 */
export type HubPrefsDoc = {
  pinnedWorkspaces?: string[]
  pinnedSessions?: string[]
  todos?: Record<string, TodoStatus>
}



/** One completion toast (ToastStack) — session finished while away. */
export type Toast = {
  id: string
  text: string
}

