import { useCallback, useEffect, useState } from 'react'
import { useChatStore } from './store/chat'
import { initUiNotifications } from './store/notifications'
import { useThemeStore } from './store/theme'
import { transport } from './api/localTransport'
import { AccessTokenGate } from './components/AccessTokenGate'
import { TopBar } from './components/TopBar'
import { ErrorBanner } from './components/ErrorBanner'
import { HistorySidebar } from './components/HistorySidebar'
import { Scrollback } from './components/Scrollback'
import { Composer } from './components/Composer'
import { ApprovalStrip } from './components/ApprovalStrip'
import { PlanApproval } from './components/PlanApproval'
import { CancelPanel } from './components/CancelPanel'
import { QuestionModal } from './components/QuestionModal'
import { DiffReviewModal } from './components/DiffReviewModal'
import { MemoryModal } from './components/MemoryModal'
import { McpPanel } from './components/McpPanel'
import { ExtensionsModal } from './components/ExtensionsModal'
import { SettingsModal } from './components/SettingsModal'
import { GitPanel } from './components/GitPanel'
import { BlockViewer } from './components/BlockViewer'
import { SessionInfoModal } from './components/SessionInfoModal'
import { ContextModal } from './components/ContextModal'
import { UsageModal } from './components/UsageModal'
import { RewindPicker } from './components/RewindPicker'
import { WorkflowPanel } from './components/WorkflowPanel'
import { ToastStack } from './components/ToastStack'
import { registerMcpPanelOpener } from './commands/registry'
import { useScrollbackKeys } from './hooks/useScrollbackKeys'

type AccessPhase = 'checking' | 'gate' | 'ready'

/**
 * Agent-view layout (TUI):
 *   [status bar]
 *   [scrollback …………]  ← j/k select · ←/→ fold · Enter view
 *   [turn status line?] ← busy only (TUI turn_status between scrollback and prompt)
 *   [permission strip?] / [plan approval?]
 *   [prompt + info line]
 *   [block viewer modal?] / [question modal?] / [mcp panel?]
 */
export default function App() {
  const initTheme = useThemeStore((s) => s.init)
  const [phase, setPhase] = useState<AccessPhase>('checking')
  const [gateError, setGateError] = useState<string>()
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => initTheme(), [initTheme])

  // Probe hub access before mounting the main shell. Mode detection first:
  // base 指向 acp-host 直连 → 模式由 host 配置决定（HUB_URL → hub）；否则
  // 视为 hub（部署版前端连 hub 的场景）。Local mode returns ok immediately;
  // hub with FE_TOKEN shows the gate.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { mode, hubUrl, localHostId } = await transport.detectMode()
      transport.setConnectionMode(mode, hubUrl)
      // 内嵌前端直连 acp-host 时记录本机 hostId：hub 模式下选中本机，
      // API 请求直连本地，不绕 hub 中继。
      transport.setLocalHostId(localHostId ?? null)
      const r = await transport.probeAccess()
      if (cancelled) return
      if (r === 'need_token') {
        setGateError(
          transport.getAccessToken()
            ? '密钥无效或已过期，请重新输入'
            : undefined,
        )
        setPhase('gate')
        return
      }
      // ok or network error → enter app (ErrorBanner covers offline)
      setPhase('ready')
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleTokenSubmit = useCallback(async (token: string) => {
    setSubmitting(true)
    setGateError(undefined)
    try {
      transport.setAccessToken(token)
      const r = await transport.probeAccess()
      if (r === 'ok') {
        setPhase('ready')
        return
      }
      if (r === 'need_token') {
        setGateError('密钥无效，请检查后重试')
        return
      }
      setGateError('无法连接 Hub，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }, [])

  if (phase === 'checking') {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-gn-bg-base text-[13px] text-gn-muted font-ui">
        连接中…
      </div>
    )
  }

  if (phase === 'gate') {
    return (
      <AccessTokenGate
        error={gateError}
        submitting={submitting}
        onSubmit={handleTokenSubmit}
      />
    )
  }

  return <AppShell />
}

function AppShell() {
  const init = useChatStore((s) => s.init)
  const [mcpOpen, setMcpOpen] = useState(false)
  const [gitOpen, setGitOpen] = useState(false)
  useScrollbackKeys()

  useEffect(() => init(), [init])
  // [ui.notifications] rails: approval_required / task_complete events +
  // document.title composition (title.*, progress_bar).
  useEffect(() => {
    initUiNotifications()
  }, [])
  // /mcps opens the MCP panel — the opener lives in App (local state).
  useEffect(() => {
    registerMcpPanelOpener(() => setMcpOpen(true))
    return () => registerMcpPanelOpener(null)
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col bg-gn-bg-base text-gn-fg font-ui transition-colors duration-150">
      <TopBar onOpenMcp={() => setMcpOpen(true)} onOpenGit={() => setGitOpen(true)} />
      {/* Host errors / connection warnings — always visible, dismissible. */}
      <ErrorBanner />
      <div className="flex min-h-0 flex-1">
        {/* Persistent desktop history sidebar; mobile history lives in the TopBar dropdown. */}
        <HistorySidebar />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Workspace + git — sticky scrollback header (TUI status-bar left). */}
          <Scrollback onOpenMcp={() => setMcpOpen(true)} />
          {/* Composer + strips stay in flow at the bottom of main — no
              overlay, so no bottom padding hacks. The composer wrapper is
              intentionally not a scroll container (its floating panels —
              slash menu / queue / question card — must not be clipped). */}
          <ApprovalStrip />
          <PlanApproval />
          <CancelPanel />
          <Composer />
        </main>
      </div>
      <BlockViewer />
      <QuestionModal />
      <DiffReviewModal />
      <MemoryModal />
      <McpPanel open={mcpOpen} onClose={() => setMcpOpen(false)} />
      <ExtensionsModal />
      <SettingsModal />
      <GitPanel open={gitOpen} onClose={() => setGitOpen(false)} />
      <SessionInfoModal />
      <ContextModal />
      <UsageModal />
      <RewindPicker />
      <WorkflowPanel />
      <ToastStack />
    </div>
  )
}
