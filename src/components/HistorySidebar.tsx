import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { useChatStore } from '../store/chat'
import { SessionHistoryList } from './SessionHistoryList'
import { SessionListHeader } from './SessionListHeader'
import { SessionSearchBox } from './SessionSearchBox'

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
 * The session search lives behind the header search button (click to
 * expand; runs a server full-text session search via agent
 * `x.ai/session/search`); while a query is active it replaces the grouped
 * list with the flat hit list (see {@link SessionSearchBox}).
 *
 * The list is fetched on mount (and kept fresh by the host's
 * sessions_changed notifications). The aside is always mounted — hidden
 * below lg — so the mount refresh also serves the mobile dropdown.
 */
export function HistorySidebar() {
  const refreshSessions = useChatStore((s) => s.refreshSessions)
  const refreshWorkspaces = useChatStore((s) => s.refreshWorkspaces)
  const resetToEmpty = useChatStore((s) => s.resetToEmpty)
  const sidebarCollapsed = useChatStore((s) => s.sidebarCollapsed)
  // 搜索按钮化：默认收起，点头部搜索按钮才挂载搜索框；命中打开后由
  // onRequestClose 收起。列表仅在「展开且查询生效」时让位给命中列表。
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchActive, setSearchActive] = useState(false)

  useEffect(() => {
    void refreshSessions()
    void refreshWorkspaces()
  }, [refreshSessions, refreshWorkspaces])

  return (
    <aside
      className={`hidden shrink-0 flex-col overflow-hidden bg-gn-bg-base transition-[width] duration-200 ease-out lg:flex ${
 sidebarCollapsed ? 'w-0 border-r-0' : 'w-72 border-r border-gn-prompt-border/60'
      }`}
    >
      {/* No border under the header — the group headers carry their own
          border-b, and removing this line lets the top edge sit flush with
          the borderless WorkspaceBar. py-2 + compact button matches the
          (taller) WorkspaceBar row height so the "会话 new" header lines up. */}
      <div className="flex min-h-[37px] h-[37px] items-center gap-2 border-b border-gn-prompt-border px-3 py-0">
        <SessionListHeader
          searchOpen={searchOpen}
          onToggleSearch={() => setSearchOpen((v) => !v)}
        />
        <button
          type="button"
          onClick={() => resetToEmpty()}
          className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-[12px] leading-none text-gn-cyan hover:bg-gn-bg-highlight hover:text-gn-fg"
          title="新建会话：先进入空状态，选择工作目录后开始"
        >
          <Plus size={12} strokeWidth={2.5} />
          new
        </button>
      </div>
      {searchOpen && (
        <SessionSearchBox
          onActive={setSearchActive}
          onRequestClose={() => setSearchOpen(false)}
        />
      )}
      <div className="gn-no-scrollbar flex-1 overflow-y-auto">
        {searchOpen && searchActive ? null : <SessionHistoryList />}
      </div>
    </aside>
  )
}
