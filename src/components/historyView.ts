import { create } from 'zustand'

/**
 * 会话列表展示形态（浏览器本地偏好，不经 hub）：
 * - workspace — 按工作区（cwd）分组，当前默认形态
 * - marked    — 只显示用户标记过的会话：置顶 / 待办（不含已完成）
 */

const VIEW_KEY = 'acpfe.historyView'

export type HistoryListMode = 'workspace' | 'marked'

export type HistoryViewPrefs = {
  mode: HistoryListMode
}

function load(): HistoryViewPrefs {
  try {
    const raw = window.localStorage.getItem(VIEW_KEY)
    if (!raw) return { mode: 'workspace' }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const mode: HistoryListMode =
      parsed.mode === 'marked' ? 'marked' : 'workspace'
    return { mode }
  } catch {
    return { mode: 'workspace' }
  }
}

function persist(prefs: HistoryViewPrefs): void {
  try {
    window.localStorage.setItem(VIEW_KEY, JSON.stringify(prefs))
  } catch {
    /* persistence is best-effort */
  }
}

export const useHistoryView = create<
  HistoryViewPrefs & {
    setMode: (mode: HistoryListMode) => void
  }
>(() => {
  const initial = load()
  return {
    ...initial,
    setMode: (mode) => {
      persist({ mode })
      useHistoryView.setState({ mode })
    },
  }
})
