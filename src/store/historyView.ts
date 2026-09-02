import { loadJSON, saveJSON } from '../lib/storage'
import { create } from 'zustand'
import { KEY } from '../lib/keys'

/**
 * 会话列表展示形态（浏览器本地偏好，不经 hub）：
 * - workspace — 按工作区（cwd）分组，当前默认形态
 * - marked    — 分类视图：思考中（非空闲会话）+ 置顶 / 待办标记
 */

const VIEW_KEY = KEY.historyView

export type HistoryListMode = 'workspace' | 'marked'

export type HistoryViewPrefs = {
  mode: HistoryListMode
}

function load(): HistoryViewPrefs {
  const parsed = loadJSON<Record<string, unknown>>(VIEW_KEY, {})
  // loadJSON 只兜 JSON 语法损坏;值若是合法 JSON 的原始类型
  // （如字面 "null"）会原样穿透,这里补一道类型闸,脏数据一律
  // 回退默认形态,不能让它把 `parsed.mode` 访问变成 TypeError。
  const mode: HistoryListMode =
    parsed && typeof parsed === 'object' && parsed.mode === 'marked'
      ? 'marked'
      : 'workspace'
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
