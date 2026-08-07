import { useEffect, useState } from 'react'
import { useChatStore } from './store/chat'
import { useThemeStore } from './store/theme'
import { TopBar, WorkspaceBar } from './components/TopBar'
import { ErrorBanner } from './components/ErrorBanner'
import { HistorySidebar } from './components/HistorySidebar'
import { Scrollback } from './components/Scrollback'
import { Composer } from './components/Composer'
import { ApprovalStrip } from './components/ApprovalStrip'
import { PlanApproval } from './components/PlanApproval'
import { QuestionModal } from './components/QuestionModal'
import { McpPanel } from './components/McpPanel'
import { ExtensionsModal } from './components/ExtensionsModal'
import { SettingsModal } from './components/SettingsModal'
import { BlockViewer } from './components/BlockViewer'
import { SessionInfoModal } from './components/SessionInfoModal'
import { RewindPicker } from './components/RewindPicker'
import { registerMcpPanelOpener } from './commands/registry'
import { useScrollbackKeys } from './hooks/useScrollbackKeys'

/**
 * Agent-view layout (TUI):
 *   [status bar]
 *   [scrollback …………]  ← j/k select · ←/→ fold · Enter view
 *   [permission strip?] / [plan approval?]
 *   [prompt + info line]
 *   [block viewer modal?] / [question modal?] / [mcp panel?]
 */
export default function App() {
  const init = useChatStore((s) => s.init)
  const initTheme = useThemeStore((s) => s.init)
  const [mcpOpen, setMcpOpen] = useState(false)
  useScrollbackKeys()

  useEffect(() => init(), [init])
  useEffect(() => initTheme(), [initTheme])
  // /mcps opens the MCP panel — the opener lives in App (local state).
  useEffect(() => {
    registerMcpPanelOpener(() => setMcpOpen(true))
    return () => registerMcpPanelOpener(null)
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col bg-gn-bg-base text-gn-fg font-ui transition-colors duration-150">
      <TopBar onOpenMcp={() => setMcpOpen(true)} />
      {/* Host errors / connection warnings — always visible, dismissible. */}
      <ErrorBanner />
      <div className="flex min-h-0 flex-1">
        {/* Persistent desktop history sidebar; mobile history lives in the TopBar dropdown. */}
        <HistorySidebar />
        <main className="flex min-h-0 flex-1 flex-col">
          {/* Workspace + git — scrollback top-left (TUI status-bar left). */}
          <WorkspaceBar />
          <Scrollback />
          <ApprovalStrip />
          <PlanApproval />
          <Composer />
        </main>
      </div>
      <BlockViewer />
      <QuestionModal />
      <McpPanel open={mcpOpen} onClose={() => setMcpOpen(false)} />
      <ExtensionsModal />
      <SettingsModal />
      <SessionInfoModal />
      <RewindPicker />
    </div>
  )
}
