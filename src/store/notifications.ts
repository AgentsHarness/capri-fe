import { useChatStore } from './chat'
import { ensureUiSettings, notificationsSettings, onUiSettingsReady } from './settings'
import { shouldNotify, systemNotify } from './notifyConfig'
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from '../theme/glyphs'

/**
 * FE-side replica of the TUI notification + title rails:
 *
 *  - events approval_required / task_complete fire system notifications
 *    (turn_complete stays in chat.ts noteSessionCompleted, gated by the
 *    same config).
 *  - document.title composition mirrors [ui.notifications.title.*] and
 *    [ui.notifications.progress_bar] (the web analog of the TUI's OSC
 *    tab title / progress bar).
 *
 * All gated by [ui.notifications] condition/events from config.toml.
 */

let inited = false
/** Last approval request we already notified about (dedup per request). */
let notifiedApprovalReq: string | undefined
/** bg_task entry ids that were running on the previous snapshot. */
let runningTasks = new Set<string>()

export function initUiNotifications(): void {
  if (inited) return
  inited = true
  void ensureUiSettings()
  startTitleManager()

  // ── approval_required: a permission request just appeared ─────────
  useChatStore.subscribe((s, prev) => {
    if (s.pending.length === 0 || prev.pending.length > 0) return
    const req = s.pending[0]
    if (!req || req.requestId === notifiedApprovalReq) return
    if (!shouldNotify('approval_required')) return
    notifiedApprovalReq = req.requestId
    const method = req.method ?? 'permission'
    const opts = (req.params?.options as
      | { name?: string; label?: string }[]
      | undefined)
    const body =
      opts
        ?.slice(0, 2)
        .map((o) => o.name || o.label || '')
        .filter(Boolean)
        .join(' / ') || method
    // Defer the set: we're inside the store's own subscribe dispatch.
    queueMicrotask(() => {
      const st = useChatStore.getState()
      if (!systemNotify('Grok 需要审批', body)) {
        st.pushToast(`🔔 需要审批：${method}`)
      }
    })
  })

  // ── task_complete: a background task left the running set ─────────
  useChatStore.subscribe((s) => {
    const now = new Set<string>()
    for (const e of s.entries) {
      if (e.kind === 'bg_task' && (e.status === 'started' || e.running)) {
        now.add(e.id)
      }
    }
    for (const id of runningTasks) {
      if (now.has(id)) continue
      const entry = s.entries.find((e) => e.id === id)
      if (!entry || entry.kind !== 'bg_task') continue
      const done = entry.status === 'completed' || entry.status === 'failed'
      if (!done || !shouldNotify('task_complete')) continue
      const failed = entry.status === 'failed'
      const title = entry.title || entry.command || `Task ${id.slice(0, 8)}`
      queueMicrotask(() => {
        const st = useChatStore.getState()
        if (!systemNotify(failed ? '后台任务失败' : '后台任务完成', title)) {
          st.pushToast(`🔔 后台任务${failed ? '失败' : '完成'}：${title}`)
        }
      })
    }
    runningTasks = now
  })
}

// ── document.title (title.* items + progress_bar) ─────────────────────
// TUI: the tab title reflects agent state (action-required / spinner /
// activity / session-name / cwd / model / turn-timer / grok), and the
// progress bar animates while a turn runs. Web analog: compose
// document.title from the configured items; while busy, prepend a
// spinner frame (progress_bar).

const DEFAULT_TITLE_ITEMS = [
  'action-required',
  'spinner',
  'activity',
  'session-name',
  'grok',
]

function startTitleManager(): void {
  const base = document.title || 'Grok'
  let frame = 0
  let timer: ReturnType<typeof window.setInterval> | null = null
  let last: string | null = null

  const stop = () => {
    if (timer != null) {
      window.clearInterval(timer)
      timer = null
    }
  }

  const render = () => {
    const st = useChatStore.getState()
    const notif = notificationsSettings()
    const progressBar = notif.progress_bar !== false
    const titleCfg =
      notif.title && typeof notif.title === 'object'
        ? (notif.title as Record<string, unknown>)
        : {}
    if (titleCfg.enabled === false) {
      if (document.title !== base) document.title = base
      return
    }
    const items: string[] = Array.isArray(titleCfg.items)
      ? titleCfg.items.filter((i): i is string => typeof i === 'string')
      : DEFAULT_TITLE_ITEMS
    const busy = st.conn === 'busy'
    const has = (it: string) => items.includes(it)
    const parts: string[] = []
    if (has('action-required') && st.pending.length > 0) {
      parts.push(`⚠ ${st.pending[0]?.method ?? '需要审批'}`)
    }
    if (has('spinner') && busy && progressBar) {
      parts.push(SPINNER_FRAMES[frame % SPINNER_FRAMES.length])
    }
    if (has('activity') && st.statusText && st.statusText !== '就绪') {
      parts.push(st.statusText)
    }
    if (has('session-name') && st.sessionTitle) {
      parts.push(st.sessionTitle)
    }
    if (has('cwd') && st.cwd) {
      const name = st.cwd.split('/').filter(Boolean).pop() || st.cwd
      parts.push(name)
    }
    if (has('model') && st.modelName) {
      parts.push(st.modelName)
    }
    if (has('grok')) parts.push('grok')
    const next = parts.length > 0 ? parts.join(' · ') : base
    if (next !== last) {
      document.title = next
      last = next
    }
  }

  useChatStore.subscribe((s, prev) => {
    const busyNow = s.conn === 'busy'
    const busyPrev = prev.conn === 'busy'
    if (busyNow && !busyPrev) {
      // Animate the spinner frame while a turn runs.
      if (timer == null) {
        timer = window.setInterval(() => {
          frame++
          render()
        }, SPINNER_INTERVAL_MS)
      }
    } else if (!busyNow && busyPrev) {
      stop()
    }
    render()
  })
  render()
  onUiSettingsReady(render)
}
