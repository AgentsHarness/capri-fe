import { loadJSON, saveJSON } from '../lib/storage'
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
  const parsed = loadJSON<Record<string, unknown>>(VIEW_KEY, {})
  const mode: HistoryListMode =
    parsed.mode === 'marked' ? 'marked' : 'workspace'
  return { mode }
}

function persist(prefs: HistoryViewPrefs): void {
  saveJSON(VIEW_KEY, prefs)
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
