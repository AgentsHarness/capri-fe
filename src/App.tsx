import { useCallback, useEffect, useState } from 'react'
import { useChatStore } from './store/chat'
import { initUiNotifications } from './store/notifications'
import { useThemeStore } from './store/theme'
import { transport } from './api/client'
import { AccessTokenGate } from './components/AccessTokenGate'
import { TopBar } from './components/TopBar'
import { ErrorBanner } from './components/ErrorBanner'
import { HistorySidebar } from './components/HistorySidebar'
import { Scrollback } from './components/Scrollback'
import { Composer } from './components/Composer'
import { SessionStatsBar } from './components/SessionStatsBar'
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
 * detectMode 去重缓存：React StrictMode 双挂载会让两个 effect 并发
 * 探测——先完成的 setConnectionMode 会 abortInflight 打断另一个探测的
 * /api/status，后者误判 local 并覆盖 hub 模式（置顶/待办同步
 * syncPrefsFromHub 因此被跳过，见 historyPins.ts）。共享同一 promise
 * 让两次挂载拿到同一份结果。token 提交（handleTokenSubmit）强制重跑
 * 并刷新缓存。
 */
let modeDetectPromise: ReturnType<typeof transport.detectMode> | null = null
function detectModeOnce(): ReturnType<typeof transport.detectMode> {
  modeDetectPromise ??= transport.detectMode()
  return modeDetectPromise
}

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

  // Runtime auth invalidation: when a request carrying a token is rejected
  // with 401 after the app is past the gate (FE_TOKEN was changed in config
  // and the process reloaded it, or the token was rotated server-side), the
  // transport fires onAuthInvalid. We clear the stored token and fall back to
  // the gate so the user can re-enter the new one — every device self-heals
  // on its next failed request instead of staying wedged on a stale token.
  useEffect(() => {
    if (phase !== 'ready') return
    return transport.onAuthInvalid(() => {
      transport.logout()
      setGateError('密钥已变更或失效，请重新输入')
      setPhase('gate')
    })
  }, [phase])

  // Probe hub access before mounting the main shell. Mode detection first:
  // base 指向 capri-host 直连 → 模式由 host 配置决定（HUB_URL → hub）；否则
  // 视为 hub（部署版前端连 hub 的场景）。Local mode returns ok immediately;
  // hub with FE_TOKEN shows the gate.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { mode, hubUrl, localHostId } = await detectModeOnce()
      // 必须在动 transport 之前就退出：setConnectionMode 内部会
      // abortInflight()，被取消的挂载（StrictMode setup→cleanup→setup）
      // 若继续跑下去，会打断**新一轮挂载**正在飞的 probeAccess
      // （/api/hosts），后者被 catch 成 'error' → 下面「网络错误也进主
      // 界面」的分支直接跳过密钥门禁，之后每个请求都 401。
      if (cancelled) return
      transport.setConnectionMode(mode, hubUrl)
      // 内嵌前端直连 capri-host 时记录本机 hostId：hub 模式下选中本机，
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
      // Token 就绪后重新判定连接模式：首次（无 token）探测时
      // /api/status 会被 host 的鉴权挡下（401），配了 HUB_URL 的 host
      // 会被盲判成 local 模式——重跑一次 detectMode 拿回正确模式。
      const { mode, hubUrl, localHostId } = await transport.detectMode()
      // token 就绪后的权威探测结果刷新缓存，后续挂载不再用旧值。
      modeDetectPromise = Promise.resolve({ mode, hubUrl, localHostId })
      transport.setConnectionMode(mode, hubUrl)
      transport.setLocalHostId(localHostId ?? null)
      const r = await transport.probeAccess()
      if (r === 'ok') {
        setPhase('ready')
        return
      }
      if (r === 'need_token') {
        setGateError('密钥无效，请检查后重试')
        return
      }
      // hub 模式探测远端 hub 失败（内网/localhost 打开了配了 HUB_URL 的
      // host，但远端 hub 不可达 / token 不匹配）。回退到本机直连：页面
      // 就托管在 host 上，本机直连永远可达，不应当因为远端 hub 不可达
      // 就把用户卡在密钥门禁里。hub 能力保留——host 切换面板里仍可选
      // hub 看全部 host，只是默认用本机。
      if (mode === 'hub') {
        transport.setConnectionMode('local', '')
        const localHostId2 = localHostId ?? null
        transport.setLocalHostId(localHostId2)
        const r2 = await transport.probeAccess()
        if (r2 === 'ok') {
          setPhase('ready')
          return
        }
        if (r2 === 'need_token') {
          setGateError('密钥无效，请检查后重试')
          return
        }
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

  return <AppShell onLogout={() => { transport.logout(); setGateError(undefined); setPhase('gate') }} />
}

function AppShell({ onLogout }: { onLogout: () => void }) {
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
      <TopBar onOpenMcp={() => setMcpOpen(true)} onOpenGit={() => setGitOpen(true)} onLogout={onLogout} />
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
          {/* 会话统计条：独立组件，位于 composer 下方（host 聚合数据，
              仅展示；空会话时零高度不占布局）。 */}
          <SessionStatsBar />
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
