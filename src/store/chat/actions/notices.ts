import { shouldNotify } from '../../notifyConfig'
import { dismissToast, pushToast } from '../../toast'
import type { ChatState, SetState } from '../types'
import {
  NOTICE_DEDUP_WINDOW_MS,
} from '../globals'

export function noticeActions(set: SetState, get: () => ChatState) {
  return {
  clearCompletedNotice: (sessionId) => {
    if (!sessionId) return
    const cur = get().completedNotices
    if (!(sessionId in cur)) return
    const next = { ...cur }
    delete next[sessionId]
    set({ completedNotices: next })
  },

  noteSessionCompleted: (sessionId) => {
    const s = get()
    if (!sessionId || sessionId === s.sessionId) return
    const now = Date.now()
    const last = s.completedNotices[sessionId]
    const next = { ...s.completedNotices, [sessionId]: now }
    // 上限：超 100 个会话时清最旧 50（字符串对象键按插入序迭代），
    // 防止长时间运行后 completedNotices 无上限增长。
    const keys = Object.keys(next)
    if (keys.length > 100) {
      for (const k of keys.slice(0, 50)) delete next[k]
    }
    set({ completedNotices: next })
    if (last && now - last < NOTICE_DEDUP_WINDOW_MS) return
    // TUI [ui.notifications] gate: condition/events decide whether the
    // completion surfaces (default "unfocused" — while the tab is visible
    // the sidebar ✓ is the feedback; no system notif / toast at all).
    if (!shouldNotify('turn_complete')) return
    const live = s.sessions.find((x) => x.sessionId === sessionId)
    const title = live?.title || sessionId.slice(0, 12)
    const text = `「${title}」已完成`
    const toastId = `done_${sessionId}_${now}`
    // 系统通知（页面切走/最小化也能看到）；成功则不重复弹页面 toast。
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification(`会话完成：${title}`, { body: '点击左侧会话列表查看' })
        return
      } catch {
        /* some browsers throw on construction — fall through to toast */
      }
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      // 首次遇到完成事件时请求一次授权。授予后系统通知已发出 — 撤掉
      // 刚入队的页面 toast，避免双重提醒；期间用户已打开该会话时通知
      // 作废，toast 一并撤掉。
      void Notification.requestPermission().then((p) => {
        if (!get().completedNotices[sessionId]) {
          dismissToast(toastId)
          return
        }
        if (p !== 'granted') return
        try {
          new Notification(`会话完成：${title}`, { body: '点击左侧会话列表查看' })
          dismissToast(toastId)
        } catch {
          /* 构造失败 — 保留页面 toast 作为兜底 */
        }
      })
    }
    pushToast(text, toastId)
  },

  } satisfies Partial<ChatState>
}
