import { useEffect, useState } from 'react'
import { useChatStore } from './store/chat'
import { useThemeStore } from './store/theme'
import { TopBar } from './components/TopBar'
import { Scrollback } from './components/Scrollback'
import { Composer } from './components/Composer'
import { ApprovalStrip } from './components/ApprovalStrip'
import { PlanApproval } from './components/PlanApproval'
import { QuestionModal } from './components/QuestionModal'
import { McpPanel } from './components/McpPanel'
import { BlockViewer } from './components/BlockViewer'
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-gn-bg-base text-gn-fg font-ui transition-colors duration-150">
      <TopBar onOpenMcp={() => setMcpOpen(true)} />
      <main className="flex min-h-0 flex-1 flex-col">
        <Scrollback />
        <ApprovalStrip />
        <PlanApproval />
        <Composer />
      </main>
      <BlockViewer />
      <QuestionModal />
      <McpPanel open={mcpOpen} onClose={() => setMcpOpen(false)} />
    </div>
  )
}
