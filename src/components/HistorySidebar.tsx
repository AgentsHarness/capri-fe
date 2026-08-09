import { useEffect } from 'react'
import { useChatStore } from '../store/chat'
import { SessionHistoryList } from './SessionHistoryList'

/**
 * Desktop (lg+) history sidebar — persistent, grouped by workspace
 * (cwd). The list itself is the shared {@link SessionHistoryList}, the
 * same one the mobile top-bar history dropdown renders, so both ends
 * stay in sync (分组 / 折叠 / 加载更多 / 重命名 / 删除 / 上下文进度条).
 *
 * Top "new" button lands in the EMPTY state (no session yet) — the
 * empty-state picker lets the user choose a workspace (or just type,
 * which auto-creates with the host default dir).
 *
 * The list is fetched on mount (and kept fresh by the host's
 * sessions_changed notifications). The aside is always mounted — hidden
 * below lg — so the mount refresh also serves the mobile dropdown.
 */
export function HistorySidebar() {
  const refreshSessions = useChatStore((s) => s.refreshSessions)
  const refreshWorkspaces = useChatStore((s) => s.refreshWorkspaces)
  const resetToEmpty = useChatStore((s) => s.resetToEmpty)

  useEffect(() => {
    void refreshSessions()
    void refreshWorkspaces()
  }, [refreshSessions, refreshWorkspaces])

  return (
    <aside className="hidden w-72 shrink-0 flex-col bg-gn-bg-base lg:flex">
      <div className="flex items-center gap-2 border-b border-gn-prompt-border px-3 py-2">
        <span className="text-[10.5px] font-medium uppercase tracking-wide text-gn-gutter">
          会话
        </span>
        <button
          type="button"
          onClick={() => resetToEmpty()}
          className="ml-auto min-h-8 rounded border border-transparent px-2 py-0.5 text-[12px] text-gn-cyan hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg"
          title="新建会话：先进入空状态，选择工作目录后开始"
        >
          new
        </button>
      </div>
      <div className="gn-no-scrollbar flex-1 overflow-y-auto">
        <SessionHistoryList />
      </div>
    </aside>
  )
}
