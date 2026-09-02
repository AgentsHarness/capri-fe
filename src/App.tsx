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
import { FolderTrustCard } from './components/FolderTrustCard'
import { DiffReviewModal } from './components/DiffReviewModal'
import { MemoryModal } from './components/MemoryModal'
import { McpPanel } from './components/McpPanel'
import { ExtensionsModal } from './components/ExtensionsModal'
import { SettingsModal } from './components/SettingsModal'
import { GitPanel } from './components/GitPanel'
import { BlockViewer } from './components/BlockViewer'
import { SessionInfoModal } from './components/SessionInfoModal'
import { ContextModal } from './components/ContextModal'
import { PlanViewerModal } from './components/PlanViewerModal'
import { UsageModal } from './components/UsageModal'
import { RewindPicker } from './components/RewindPicker'
import { ContentSearchModal } from './components/ContentSearchModal'
import { WorkflowPanel } from './components/WorkflowPanel'
import { HostKeyModal } from './components/HostKeyModal'
import { ToastStack } from './components/ToastStack'
import { registerMcpPanelOpener } from './commands/registry'
import { useScrollbackKeys } from './hooks/useScrollbackKeys'

type AccessPhase = 'checking' | 'gate' | 'unreachable' | 'ready'

/**
 * detectMode 去重缓存：React StrictMode 双挂载会让两个 effect 并发
 * 探测——先完成的 setConnectionMode 会 abortInflight 打断另一个探测的
 * /api/hosts，后者误判并覆盖 hub 模式（置顶/待办同步
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
 * 开机代际：StrictMode 的 setup→cleanup→setup 会让上一轮 boot 在 await 之后
 * 继续跑，而它接下来就是 setConnectionMode → abortInflight，会打断**新一轮
 * 挂载**正在飞的 probeAccess（后者被 catch 成 'error'，本该弹出的密钥门禁就
 * 被跳过了，之后每个请求都 401）。每轮 boot 只在自己的代际仍是最新时往下走。
 */
let bootGen = 0

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
  /** 纯 local 门禁的机器名（来自免鉴权的 /api/hosts，别在文案里甩裸 hostId）。 */
  const [localHostName, setLocalHostName] = useState<string>()

  useEffect(() => initTheme(), [initTheme])

  // 开机三步，顺序要紧：① 认模式（只看免鉴权的 /api/hosts）② 过 hub 门
  // （**只问 hub 那把**）③ 门后才去探本机近路。近路探测放在门禁之前会把
  // 「这台要不要第二把钥匙」提前摊到用户脸上，也正是要避免的那条回头路。
  const boot = useCallback(async () => {
    const myGen = ++bootGen
    setPhase('checking')
    const { mode, hubUrl, localHostId, localHostName: name, authRequired } =
      await detectModeOnce()
    if (myGen !== bootGen) return
    setLocalHostName(name)
    // 模式不可知（网络失败）：不改连接模式、不动任何密钥槽，只报「连不上、
    // 可重试」。曾经这里盲判 local，连带把刚输入的 hub 凭据当残留抹掉。
    if (!mode) {
      setPhase('unreachable')
      return
    }
    transport.setConnectionMode(mode, hubUrl)
    // 内嵌前端直连 capri-host 时记录本机 hostId + 它要不要钥匙：hub 模式下
    // 选中本机即可直连本地，局域网 IP 打开内嵌页也认得出自己、升得了 hub。
    transport.setLocalHostId(localHostId ?? null, authRequired === true)
    const r = await transport.probeAccess()
    if (myGen !== bootGen) return
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
    // 门已经过了（hub 或本机），才去找近路：默认直连本机，探不过再问一把。
    if (mode === 'hub') void transport.discoverLocalHost()
  }, [])

  useEffect(() => {
    void boot()
  }, [boot])

  // hub 那把被拒（服务端换了 FE_TOKEN / 密钥被轮换）：transport 已清掉 hub
  // 槽，这里只负责把人带回门禁。各台 host 的近路钥匙与通路选择保持原样。
  useEffect(() => {
    if (phase !== 'ready') return
    return transport.onHubAuthInvalid(() => {
      setGateError('Hub 密钥已变更或失效，请重新输入')
      setPhase('gate')
    })
  }, [phase])

  const handleTokenSubmit = useCallback(async (token: string) => {
    setSubmitting(true)
    setGateError(undefined)
    try {
      transport.setAccessToken(token)
      // Token 就绪后重新判定连接模式，拿回权威结果并刷新去重缓存，
      // 后续挂载不再用旧值。
      const next = await transport.detectMode()
      modeDetectPromise = Promise.resolve(next)
      setLocalHostName(next.localHostName)
      if (!next.mode) {
        setGateError('连不上服务，请稍后重试')
        return
      }
      transport.setConnectionMode(next.mode, next.hubUrl)
      transport.setLocalHostId(next.localHostId ?? null, next.authRequired === true)
      const r = await transport.probeAccess()
      if (r === 'ok') {
        setPhase('ready')
        if (next.mode === 'hub') void transport.discoverLocalHost()
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

  if (phase === 'unreachable') {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 bg-gn-bg-base px-4 text-center font-ui">
        <p className="text-[13px] text-gn-fg">无法连接到服务</p>
        {/* 整段一行到底：中文段落换行会在 JSX 里被折成空格，读起来像漏字。 */}
        <p className="max-w-sm text-[12px] leading-relaxed text-gn-muted">
          页面未能确认当前应连接本机（Host）还是 Hub，已保存的访问密钥保持不变。请检查网络，或确认服务已启动后重试。
        </p>
        <button
          type="button"
          onClick={() => {
            modeDetectPromise = null
            void boot()
          }}
          className="rounded-md border border-gn-prompt-border px-3 py-1.5 text-[12px] text-gn-fg hover:bg-gn-bg-highlight"
        >
          重试
        </button>
      </div>
    )
  }

  if (phase === 'gate') {
    return (
      <AccessTokenGate
        error={gateError}
        submitting={submitting}
        // 纯 local（Host 没配 HUB_URL）时门后没有 Hub，问的是这台机器自己的
        // 钥匙——文案别再提 Hub。模式在 setConnectionMode 时已定。
        local={transport.getConnectionMode() === 'local'}
        hostName={localHostName}
        onSubmit={handleTokenSubmit}
      />
    )
  }

  return (
    <AppShell
      onLogout={() => {
        transport.logout()
        setGateError(undefined)
        setPhase('gate')
      }}
    />
  )
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
      <FolderTrustCard />
      <DiffReviewModal />
      <MemoryModal />
      <McpPanel open={mcpOpen} onClose={() => setMcpOpen(false)} />
      <ExtensionsModal />
      <SettingsModal />
      <GitPanel open={gitOpen} onClose={() => setGitOpen(false)} />
      <SessionInfoModal />
      <ContextModal />
      <PlanViewerModal />
      <UsageModal />
      <RewindPicker />
      <ContentSearchModal />
      <WorkflowPanel />
      <ToastStack />
      {/* 本机近路的第二把钥匙：只在 hub 登录后、选中了本机 host 且那台确实
          要钥匙时弹出（见 components/HostKeyModal.tsx）。 */}
      <HostKeyModal />
    </div>
  )
}
