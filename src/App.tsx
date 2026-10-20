import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatStore } from './store/chat'
import { initUiNotifications } from './store/notifications'
import { useThemeStore } from './store/theme'
import { transport } from './api/client'
import { AccessTokenGate } from './components/shell/AccessTokenGate'
import { TopBar } from './components/shell/TopBar'
import { HistorySidebar } from './components/session/HistorySidebar'
import { Scrollback } from './components/scrollback/Scrollback'
import { Composer } from './components/composer/Composer'
import { SessionStatsBar } from './components/session/SessionStatsBar'
import { ApprovalStrip } from './components/approvals/ApprovalStrip'
import { PlanApproval } from './components/approvals/PlanApproval'
import { CancelPanel } from './components/approvals/CancelPanel'
import { QuestionModal } from './components/approvals/QuestionModal'
import { McpElicitCard } from './components/approvals/McpElicitCard'
import { FolderTrustCard } from './components/approvals/FolderTrustCard'
import { DiffReviewModal } from './components/approvals/DiffReviewModal'
import { MemoryModal } from './components/panels/MemoryModal'
import { AgentsModal } from './components/panels/AgentsModal'
import { McpPanel } from './components/panels/McpPanel'
import { ExtensionsModal } from './components/panels/ExtensionsModal'
import { SettingsModal } from './components/panels/SettingsModal'
import { GitPanel } from './components/panels/GitPanel'
import { BlockViewer } from './components/shell/BlockViewer'
import { SessionInfoModal } from './components/session/SessionInfoModal'
import { ContextModal } from './components/session/ContextModal'
import { SessionUsageModal } from './components/session/SessionUsageModal'
import { PlanViewerModal } from './components/approvals/PlanViewerModal'
import { UsageModal } from './components/session/UsageModal'
import { RewindPicker } from './components/session/RewindPicker'
import { ContentSearchModal } from './components/session/ContentSearchModal'
import { WorkflowPanel } from './components/panels/WorkflowPanel'
import { HostKeyModal } from './components/panels/HostKeyModal'
import { ToastStack } from './components/ui/ToastStack'
import { HostSettingsPage } from './components/panels/HostSettingsPage'
import { GuestTopBar } from './components/shell/GuestTopBar'
import { ShareGuestHost } from './components/panels/ShareGuestModal'
import { registerMcpPanelOpener } from './commands/registry'
import { useScrollbackKeys } from './hooks/useScrollbackKeys'

type AccessPhase = 'checking' | 'gate' | 'unreachable' | 'ready'

/**
 * 分享链接启动时的角色探测：
 * - admin   —— 管理员的 hub / 本机钥匙；
 * - guest   —— 访客令牌（只读壳 + 会话白名单）；
 * - unknown —— hub 太旧或探测失败：按 admin 处理（老行为不变）。
 */
type AccessRole = 'admin' | 'guest'

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
 * 角色探测：hub 的 access-role。返回访客身份（null = 管理员 / 探测失败）。
 *
 * 只回答「出示的这把是谁」——不写 store，身份的进场由调用方走
 * `enterGuestSession`（它要连带复位会话视图）。
 *
 * 放在 boot 的 ready 之前：访客要渲染的是只读壳，不该先闪一下完整界面。
 * 探测失败按管理员处理（默认行为不变），hub 太旧返回 404 时 rpc 层已经
 * 回落成 admin。
 */
async function detectGuestRole(): Promise<import('./api/types').GuestIdentity | null> {
  try {
    const role = await transport.accessRole()
    return role.role === 'guest' ? role : null
  } catch {
    return null
  }
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
  /** 角色：guest 走只读壳；admin 走原来的完整界面。 */
  const [role, setRole] = useState<AccessRole>('admin')
  /** 切访客时本地没存过访客令牌（或存的那把已失效）：弹访客令牌门禁。 */
  const [guestGate, setGuestGate] = useState(false)
  const [guestGateError, setGuestGateError] = useState<string>()

  const [currentPath, setCurrentPath] = useState(() => window.location.pathname)

  useEffect(() => {
    const handlePopState = () => setCurrentPath(window.location.pathname)
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => initTheme(), [initTheme])

  // 开机三步，顺序要紧：① 认模式（只看免鉴权的 /api/hosts）② 过 hub 门
  // （**只问 hub 那把**）③ 门后才去探本机近路。近路探测放在门禁之前会把
  // 「这台要不要第二把钥匙」提前摊到用户脸上，也正是要避免的那条回头路。
  const boot = useCallback(async () => {
    const myGen = ++bootGen
    setPhase('checking')
    // 分享链接（#g=<token>）先于一切：把 fragment 里的访客令牌采纳进访客
    // 槽并清掉地址栏的 fragment。
    transport.adoptSharedToken()
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
    // 这次用哪一格做门禁：管理员优先；分享链接已抢先置成 guest。管理员槽
    // 为空、访客槽有货时用访客槽——只存过访客令牌的浏览器刷新后直接回访客
    // 视图，而不是被管理员门禁挡住。
    transport.chooseStartupCredential()
    let r = await transport.probeAccess()
    if (myGen !== bootGen) return
    // 访客槽那把没通过（多半是分享链接已失效）：清掉它再用管理员槽试一次。
    // 本来就登录过管理员的用户刷新一个过期链接，不该被挡在门外。
    if (r === 'need_token' && transport.getCredentialSource() === 'guest') {
      transport.dropGuestCredential()
      if (transport.hasAdminToken()) {
        transport.chooseStartupCredential()
        r = await transport.probeAccess()
        if (myGen !== bootGen) return
      }
    }
    if (r === 'need_token') {
      setGateError(
        transport.getAccessToken()
          ? '密钥无效或已过期，请重新输入'
          : undefined,
      )
      setPhase('gate')
      return
    }
    // 角色探测只在 hub 模式有意义（local 没有白名单承载）。放在进入主
    // 界面之前：访客要渲染的是只读壳，不该先闪一下完整界面。
    let guestIdentity: import('./api/types').GuestIdentity | null = null
    if (mode === 'hub') {
      guestIdentity = await detectGuestRole()
      if (myGen !== bootGen) return
    }
    const guest = guestIdentity != null
    setRole(guest ? 'guest' : 'admin')
    // 访客身份进场：enterGuestSession 会写 transport 的访客身份并复位会话
    // 视图（上一身份的内容不能留在新壳里）。
    if (guest && guestIdentity) {
      useChatStore.getState().enterGuestSession(guestIdentity)
    } else {
      // hub 说这把不是访客令牌（或是分享链接里贴错的管理员密钥 / 探测失败）：
      // 把出示的那把归到管理员槽，别让访客槽占着门禁位置。
      transport.settleAdminCredential()
    }
    // ok or network error → enter app (top-bar host notice covers offline)
    setPhase('ready')
    // 门已经过了（hub 或本机），才去找近路：默认直连本机，探不过再问一把。
    // 访客不探：白名单只在 hub 上，本机直连等于绕过它。
    if (mode === 'hub' && !guest) void transport.discoverLocalHost()
  }, [])

  useEffect(() => {
    void boot()
  }, [boot])

  // 门禁那把被拒（服务端换了 FE_TOKEN / 密钥被轮换 / 访客令牌被吊销）。
  // transport 已经清掉对应的槽；这里负责把人带回正确的位置：访客被拒回
  // 管理员界面（管理员那把没被动过），管理员被拒回门禁。
  useEffect(() => {
    if (phase !== 'ready') return
    return transport.onHubAuthInvalid(() => {
      if (role === 'guest') {
        useChatStore.getState().exitGuestSession()
        setRole('admin')
        if (transport.hasAdminToken()) {
          modeDetectPromise = null
          void boot()
        } else {
          setGateError('访客令牌已失效，请重新登录')
          setPhase('gate')
        }
        return
      }
      setGateError('Hub 密钥已变更或失效，请重新输入')
      setPhase('gate')
    })
  }, [phase, role, boot])

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
        const identity = next.mode === 'hub' ? await detectGuestRole() : null
        setRole(identity ? 'guest' : 'admin')
        if (identity) {
          useChatStore.getState().enterGuestSession(identity)
        } else {
          // hub 说这不是访客令牌（或是分享链接里贴错的管理员密钥 / 探测失败）：
          // 把出示的那把归到管理员槽，别让访客槽占着门禁位置。
          transport.settleAdminCredential()
        }
        setPhase('ready')
        if (next.mode === 'hub' && !identity) void transport.discoverLocalHost()
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

  /**
   * 顶栏 host 列表里的「切换到访客模式」。
   *
   * - 存过访客令牌：拿它向 hub 复核，成功就换壳；令牌失效（被吊销 / 过期）
   *   则弹门禁要一把新的。管理员登录全程保留，取消就留在原界面。
   * - 没存过：弹门禁，用户输入后再验。
   */
  const handleEnterGuest = useCallback(async () => {
    const r = await transport.enterGuestMode()
    if (r === 'ok') {
      const identity = transport.getGuestIdentity()
      if (identity) {
        useChatStore.getState().enterGuestSession(identity)
        setRole('guest')
      }
      return
    }
    setGuestGateError(
      r === 'invalid'
        ? '存下的访客令牌已失效，请重新输入'
        : r === 'error'
          ? '无法验证访客令牌，请检查网络后重试'
          : undefined,
    )
    setGuestGate(true)
  }, [])

  /** 访客门禁提交：验过才换壳，失败留在门禁里改。 */
  const handleGuestTokenSubmit = useCallback(async (token: string) => {
    setSubmitting(true)
    setGuestGateError(undefined)
    try {
      const identity = await transport.tryGuestToken(token)
      if (!identity) {
        setGuestGateError('这把不是有效的访客令牌，请核对后重试')
        return
      }
      useChatStore.getState().enterGuestSession(identity)
      setGuestGate(false)
      setRole('guest')
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
          className="rounded-md px-3 py-1.5 text-[12px] text-gn-fg hover:bg-gn-bg-highlight"
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

  if (currentPath === '/settings') {
    return <HostSettingsPage />
  }

  if (role === 'guest') {
    return (
      <GuestShell
        onExit={() => {
          // 退出访客：切回管理员令牌槽（那把从来没被顶掉）。管理员槽还在
          // 就直接重跑启动链回主界面，否则回门禁。
          useChatStore.getState().exitGuestSession()
          modeDetectPromise = null
          setRole('admin')
          if (transport.hasAdminToken()) {
            void boot()
          } else {
            setGateError(undefined)
            setPhase('gate')
          }
        }}
      />
    )
  }

  return (
    <>
      <AppShell
        onLogout={() => {
          transport.logout()
          setGateError(undefined)
          setPhase('gate')
        }}
        onEnterGuest={() => void handleEnterGuest()}
      />
      {/* 切访客时本地没存过访客令牌（或存的那把已失效）：全屏问一把。
          盖在管理员壳之上（不卸载它），取消就原样回去，管理员会话不受影响。 */}
      {guestGate && (
        <div className="fixed inset-0 z-[70] bg-gn-bg-base">
          <AccessTokenGate
            guest
            submitting={submitting}
            error={guestGateError}
            onSubmit={handleGuestTokenSubmit}
            onCancel={() => {
              setGuestGate(false)
              setGuestGateError(undefined)
            }}
          />
        </div>
      )}
    </>
  )
}

/**
 * 访客壳：只读视图。
 *
 * 挂载：顶栏（静态 host + 会话 + 令牌状态 + hub/host 层错误）、WorkspaceBar、
 * Scrollback、只读 Composer、会话统计条、BlockViewer、ToastStack。其余面板
 * 一律不挂——没有侧栏、没有审批/问题卡（访客不可能成为审批人）、没有
 * 设置/MCP/Git。
 */
export function GuestShell({ onExit }: { onExit: () => void }) {
  const init = useChatStore((s) => s.init)
  const guestSessions = useChatStore((s) => s.guestSessions)
  const sessionId = useChatStore((s) => s.sessionId)
  const switchGuestSession = useChatStore((s) => s.switchGuestSession)
  const historyLoading = useChatStore((s) => s.historyLoading)
  const historyLoadedAt = useChatStore((s) => s.historyLoadedAt)
  const historyLoadError = useChatStore((s) => s.historyLoadError)
  const entryCount = useChatStore((s) => s.entries.length)
  // 滚动区导航/折叠/查看器保留；Esc→取消、Ctrl+C→取消、双击 Esc→rewind
  // 由 useScrollbackKeys 的 guest 分支关闭。
  useScrollbackKeys({ guest: true })
  useEffect(() => init(), [init])

  // 默认会话加载：白名单第一条（transport.setGuestMode 已把 host 夹到它）。
  //
  // 这里的重试不是冗余：StrictMode 的 setup→cleanup→setup 会在第一次
  // loadHistory 的 fetch 途中 disconnect()，被 abort 的那次不会自己复位
  // historyLoading；没有 admin 那条 host `hello` 兜底，访客视图就会停在
  // 加载态。条件是「没有历史、没有在加载、没有失败」→ 再拉一次，最多两次。
  const attempts = useRef({ key: '', n: 0 })
  useEffect(() => {
    if (guestSessions.length === 0) return
    if (historyLoading || historyLoadError) return
    if (historyLoadedAt || entryCount > 0) return
    const target = guestSessions.find((s) => s.sessionId === sessionId) ?? guestSessions[0]
    if (!target) return
    // 重试预算按会话重置：切换会话后允许新一轮重试。
    const key = `${target.hostId}:${target.sessionId}`
    if (attempts.current.key !== key) attempts.current = { key, n: 0 }
    if (attempts.current.n >= 2) return
    attempts.current.n += 1
    void switchGuestSession(target)
  }, [
    guestSessions,
    sessionId,
    historyLoading,
    historyLoadedAt,
    historyLoadError,
    entryCount,
    switchGuestSession,
  ])

  return (
    <div className="flex h-full h-[100dvh] min-h-0 flex-col overflow-hidden overscroll-none bg-gn-bg-base text-gn-fg font-ui transition-colors duration-150">
      <GuestTopBar onExit={onExit} />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Scrollback guest />
        {/* 访客的状态行长在 Composer 里（guest 只读态）：会话在跑还是在等
            管理员应答，由那一行承担，不再另挂一条。 */}
        {/* Composer 保留可见（访客看得到输入区与模型/模式读数），但以
            guest 只读态挂载：输入框禁用，菜单与发送入口都不渲染。 */}
        <Composer guest />
        {/* /api/session-stats 在访客白名单里（只读聚合），统计条与管理员壳
            同款挂载；无数据时它自己留底距占位。 */}
        <SessionStatsBar />
      </main>
      <BlockViewer />
      <ToastStack />
    </div>
  )
}

function AppShell({
  onLogout,
  onEnterGuest,
}: {
  onLogout: () => void
  /** 左上角 host 列表里「切换到访客模式」。 */
  onEnterGuest: () => void
}) {
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
    <div className="flex h-full h-[100dvh] min-h-0 flex-col overflow-hidden overscroll-none bg-gn-bg-base text-gn-fg font-ui transition-colors duration-150">
      <TopBar
        onOpenMcp={() => setMcpOpen((v) => !v)}
        onOpenGit={() => setGitOpen((v) => !v)}
        mcpOpen={mcpOpen}
        gitOpen={gitOpen}
        onLogout={onLogout}
        onEnterGuest={onEnterGuest}
      />
      <div className="flex min-h-0 flex-1">
        {/* Persistent desktop history sidebar; mobile history lives in the TopBar dropdown. */}
        <HistorySidebar />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {/* Workspace + git — sticky scrollback header (TUI status-bar left). */}
          <Scrollback onOpenMcp={() => setMcpOpen(true)} />
          {/* Composer + strips stay in flow at the bottom of main — no
              overlay, so no bottom padding hacks. The composer wrapper is
              intentionally not a scroll container (its floating panels —
              slash menu / queue / question card — must not be clipped). */}
          <ApprovalStrip />
          <PlanApproval />
          <CancelPanel />
          <McpElicitCard />
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
      <AgentsModal />
      <McpPanel open={mcpOpen} onClose={() => setMcpOpen(false)} />
      <ExtensionsModal />
      <SettingsModal />
      <GitPanel open={gitOpen} onClose={() => setGitOpen(false)} />
      <SessionInfoModal />
      <ContextModal />
      <SessionUsageModal />
      <PlanViewerModal />
      <UsageModal />
      <RewindPicker />
      <ContentSearchModal />
      <WorkflowPanel />
      <ToastStack />
      {/* 本机近路的第二把钥匙：只在 hub 登录后、选中了本机 host 且那台确实
          要钥匙时弹出（见 components/HostKeyModal.tsx）。 */}
      <HostKeyModal />
      {/* 右键「分享只读链接」的单例宿主（访客壳不挂）。 */}
      <ShareGuestHost />
    </div>
  )
}
