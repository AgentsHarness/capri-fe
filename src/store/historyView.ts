import { loadJSON, saveJSON } from '../lib/storage'
import { create } from 'zustand'
import { KEY } from '../lib/keys'

/**
 * 会话列表展示形态（浏览器本地偏好，不经 hub）：
 * - workspace — 按工作区（cwd）分组，当前默认形态
 * - marked    — 分类视图：思考中（非空闲会话）+ 置顶 / 待办标记
 *
 * 排序形态 `orderMode` 与视图形态正交，同属这一份本地偏好：
 * - frozen（默认）— 列表顺序锚定在「首次见到该会话」或「显式刷新」那一刻
 *   的活动时间，后台会话继续跑也不重排（锚点见 historyOrder.ts）
 * - active — 历史行为：按实时状态优先级 + 活动时间每次刷新都重排
 */

const VIEW_KEY = KEY.historyView

export type HistoryListMode = 'workspace' | 'marked'
export type HistoryOrderMode = 'frozen' | 'active'

export type HistoryViewPrefs = {
  mode: HistoryListMode
  orderMode: HistoryOrderMode
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
  const orderMode: HistoryOrderMode =
    parsed && typeof parsed === 'object' && parsed.orderMode === 'active'
      ? 'active'
      : 'frozen'
  return { mode, orderMode }
}

function persist(prefs: HistoryViewPrefs): void {
  saveJSON(VIEW_KEY, prefs)
}

export const useHistoryView = create<
  HistoryViewPrefs & {
    setMode: (mode: HistoryListMode) => void
    setOrderMode: (orderMode: HistoryOrderMode) => void
  }
>(() => {
  const initial = load()
  return {
    ...initial,
    setMode: (mode) => {
      const next = { ...load(), mode }
      persist(next)
      useHistoryView.setState({ mode })
    },
    setOrderMode: (orderMode) => {
      const next = { ...load(), orderMode }
      persist(next)
      useHistoryView.setState({ orderMode })
    },
  }
})

// 多 Tab 本地同步：监听 storage 事件让视图模式（workspace / marked）与
// 排序形态（frozen / active）即时同步
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === VIEW_KEY && e.newValue) {
      const { mode, orderMode } = load()
      if (mode !== useHistoryView.getState().mode) {
        useHistoryView.setState({ mode })
      }
      if (orderMode !== useHistoryView.getState().orderMode) {
        useHistoryView.setState({ orderMode })
      }
    }
  })
}
