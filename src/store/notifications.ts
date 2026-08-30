import { useChatStore } from './chat'
import { transport } from '../api/client'
import { pushToast } from './toast'
import { ensureUiSettings, notificationsSettings, onUiSettingsReady } from './settings'
import { shouldNotify, systemNotify } from './notifyConfig'

/**
 * FE-side replica of the TUI notification + title rails:
 *
 *  - events approval_required / task_complete fire system notifications
 *    (turn_complete stays in chat.ts noteSessionCompleted, gated by the
 *    same config).
 *  - document.title is a fixed state badge + "Agents Harness" suffix,
 *    derived from the session-list states (same buckets as the sidebar):
 *    [N 待处理] / [N 思考中] / [N 已完成] / [空闲] — highest-priority
 *    non-empty state only, so the title stays stable instead of
 *    animating on every turn event.
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
  // hub 模式下、host 选定之前的 settings 预取只会被 setHost 的 abort 风暴
  // 取消（实测每次加载两次 ERR_ABORTED）。selectHost 之后一定会以新 host
  // 为准重读并触发 onUiSettingsReady，所以这里只在 local 模式或已有 host
  // 时预热。
  if (
    transport.getConnectionMode() !== 'hub' ||
    useChatStore.getState().selectedHostId
  ) {
    void ensureUiSettings()
  }
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
      if (!systemNotify('Grok 需要审批', body)) {
        pushToast(`🔔 需要审批：${method}`)
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
        if (!systemNotify(failed ? '后台任务失败' : '后台任务完成', title)) {
          pushToast(`🔔 后台任务${failed ? '失败' : '完成'}：${title}`)
        }
      })
    }
    runningTasks = now
  })
}

// ── document.title（统一状态标题）────────────────────────────────────
// 固定格式：`[状态] Agents Harness`，状态只取优先级最高的一个：
//   待处理（会话 awaiting：审批/提问挂起）> 思考中（会话 active +
//   后台任务运行中 + 本端 busy 兜底）> 已完成（别的会话跑完待查看，
//   即侧边栏 ✓ 对勾）> 空闲（全零）。
// 不再有 spinner / statusText / 会话名等逐事件变化的拼接，标题只在
// 状态档位切换时更新，[ui.notifications.title.enabled=false] 时回退
// 到页面原始标题。

const TITLE_SUFFIX = 'Agents Harness'

function startTitleManager(): void {
  const base = document.title || 'Grok'
  let last: string | null = null

  const render = () => {
    const st = useChatStore.getState()
    const notif = notificationsSettings()
    const titleCfg =
      notif.title && typeof notif.title === 'object'
        ? (notif.title as Record<string, unknown>)
        : {}
    if (titleCfg.enabled === false) {
      if (document.title !== base) document.title = base
      return
    }
    // 与侧边栏 sessionGroupKey 同口径统计会话列表状态。
    let pending = 0
    let thinking = 0
    for (const s of st.sessions) {
      const stt = s.status
      if (stt?.state === 'awaiting' || stt?.awaitingInput === true) {
        pending++
      } else if (stt?.state === 'active') {
        thinking++
      } else if ((s.bgRunning ?? 0) > 0) {
        // 后台任务运行中的会话也计入"思考中"（侧边栏 bg 组）。
        thinking++
      }
    }
    // 当前会话的回合在跑但列表尚未同步成 active → 兜底计入思考中。
    if (st.conn === 'busy') {
      const selfActive = st.sessions.some(
        (s) =>
          s.sessionId === st.sessionId &&
          (s.status?.state === 'active' || s.status?.busy === true),
      )
      if (!selfActive) thinking++
    }
    const completed = Object.keys(st.completedNotices).length

    const prefix =
      pending > 0
        ? `[${pending} 待处理]`
        : thinking > 0
          ? `[${thinking} 思考中]`
          : completed > 0
            ? `[${completed} 已完成]`
            : '[空闲]'
    const next = `${prefix} ${TITLE_SUFFIX}`
    if (next !== last) {
      document.title = next
      last = next
    }
  }

  useChatStore.subscribe(() => render())
  render()
  onUiSettingsReady(render)
}
