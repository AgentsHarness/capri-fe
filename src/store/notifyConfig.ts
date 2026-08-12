import { notificationsSettings } from './settings'

/**
 * [ui.notifications] config parsing — the FE's replica of the TUI
 * notification rail (xai-grok-shell/src/ui/notifications.rs). Read-only:
 * the host serves config.toml; this module just interprets it.
 *
 *   method    → web Notification API (no protocol choice; "none" disables)
 *   condition → "unfocused" (default) | "always" | "never"
 *   events    → turn_complete / approval_required / session_ready /
 *               task_complete / agent_error (default turn_complete +
 *               approval_required)
 */

export type NotifEvent =
  | 'turn_complete'
  | 'approval_required'
  | 'session_ready'
  | 'task_complete'
  | 'agent_error'

const ALL_EVENTS: NotifEvent[] = [
  'turn_complete',
  'approval_required',
  'session_ready',
  'task_complete',
  'agent_error',
]
const DEFAULT_EVENTS: NotifEvent[] = ['turn_complete', 'approval_required']

function eventList(): NotifEvent[] {
  const cfg = notificationsSettings()
  if (Array.isArray(cfg.events)) {
    const known = cfg.events.filter(
      (e): e is NotifEvent =>
        typeof e === 'string' && (ALL_EVENTS as string[]).includes(e),
    )
    if (known.length > 0) return known
  }
  return DEFAULT_EVENTS
}

function condition(): 'unfocused' | 'always' | 'never' {
  const c = notificationsSettings().condition
  return c === 'always' || c === 'never' ? c : 'unfocused'
}

/** Is the terminal/tab currently in the user's focus? (TUI "unfocused"
 *  means the terminal lost focus; web analog = tab hidden.) */
export function tabUnfocused(): boolean {
  return document.hidden || !document.hasFocus()
}

/** Whether an event should fire a notification right now. */
export function shouldNotify(ev: NotifEvent): boolean {
  const cond = condition()
  if (cond === 'never') return false
  if (!eventList().includes(ev)) return false
  if (cond === 'always') return true
  return tabUnfocused()
}

/** Fire a system notification; false when unavailable / not permitted
 *  (caller falls back to an in-page toast). */
export function systemNotify(title: string, body: string): boolean {
  if (
    typeof Notification === 'undefined' ||
    Notification.permission !== 'granted'
  ) {
    return false
  }
  try {
    new Notification(title, { body })
    return true
  } catch {
    return false
  }
}
