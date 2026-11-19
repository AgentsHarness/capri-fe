import { useRef, useState } from 'react'
import {
  Activity,
  Boxes,
  ChevronDown,
  ChevronUp,
  EllipsisVertical,
  Eye,
  GitBranch,
  History,
  LogOut,
  Palette,
  Plus,
  Puzzle,
  Settings,
  ShieldQuestion,
} from 'lucide-react'
import { useChatStore } from '../../store/chat'
import { useAnchoredPanel } from '../../hooks/useAnchoredPanel'
import { ThemeOptions, ThemePicker } from './ThemePicker'
import { chromeBtnClass } from '../../theme/layout'
import { SessionHistoryList } from '../session/SessionHistoryList'
import { SessionListHeader } from '../session/SessionListHeader'
import { SessionSearchBox } from '../session/SessionSearchBox'
import type { HostInfo } from '../../api/types'
import { transport } from '../../api/client'
import {
  hostSignal,
  hostSignalLabel,
  hostState,
  hostStateLabel,
  otherHostsSignal,
  type HostSignal,
  type HostState,
} from '../../lib/hostState'
import { pickLayerError } from '../../lib/layerErr'
import { LayerErrNotice } from './LayerErrNotice'
import { SubscribersPanel } from '../panels/host/SubscribersPanel'
import {
  AddHostModal,
  DeleteHostModal,
  HostActionsMenu,
  RenameHostModal,
  RestartAgentModal,
} from '../panels/host/HostActions'

/**
 * Hub 模式下列表行的通路标记（transport.activeRouteFor 的三态文案）：
 * - 直连 —— 本机近路可用，API/SSE 不绕 hub；
 * - 待验证 —— 探到了本机候选，但还差这台自己的钥匙，此刻仍走中继；
 * - 中继 —— 只有 hub 一条路（同机之外的一切机器，或用户显式选了中继）。
 * 没有近路候选（不能直连本机）的行不显示通道——只有中继一条路可走，
 * 标了也是噪声；对应 host 的操作菜单里「通路」区块也一并隐去。
 */
function hostRouteLabel(state: 'direct' | 'pending' | 'relay'): '直连' | '待验证' | '中继' {
  return state === 'direct' ? '直连' : state === 'pending' ? '待验证' : '中继'
}

/** 菜单打开位置边缘夹取：菜单宽 208px（w-52）、高 ~200px，贴着视口边缘。 */
function clampMenuPos(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(4, Math.min(x, window.innerWidth - 212)),
    y: Math.max(4, Math.min(y, window.innerHeight - 136)),
  }
}

/** Host 列表行的实时状态点配色（离线/旧 hub 无状态字段 → 沿用绿/灰）。 */
function hostDotClass(h: HostInfo): string {
  switch (hostState(h)) {
    case 'thinking':
      return 'bg-gn-blue animate-pulse'
    case 'pending':
      return 'bg-gn-orange'
    case 'booting':
      return 'bg-gn-yellow'
    case 'idle':
      return 'bg-gn-green'
    default:
      return h.online ? 'bg-gn-green' : 'bg-gn-muted'
  }
}

const HOST_STATE_TEXT_CLASS: Record<HostState, string> = {
  thinking: 'text-gn-cyan',
  pending: 'text-gn-orange',
  booting: 'text-gn-yellow',
  idle: 'text-gn-green1',
}

/** 顶栏 host 名称前的两个点：左 = 其他 Host 聚合，右 = 当前 Host。 */
const HOST_SIGNAL_DOT_CLASS: Record<HostSignal, string> = {
  error: 'bg-gn-red',
  warning: 'bg-gn-warning',
  busy: 'bg-gn-blue animate-pulse',
  idle: 'bg-gn-green',
  offline: 'bg-gn-muted',
}

/**
 * Minimal top chrome — closer to TUI status (gray on bg_base) than a fat web header.
 * Host switcher pre-wired for multi-host; git branch + session actions
 * (fork / rename / recap) live off the x.ai extension surface.
 */
export function TopBar({
  onOpenMcp,
  onOpenGit,
  mcpOpen,
  gitOpen,
  onLogout,
  onEnterGuest,
}: {
  onOpenMcp?: () => void
  onOpenGit?: () => void
  /** MCP / git 面板是否打开（顶栏按钮选中态；点击已打开的按钮关闭）。 */
  mcpOpen?: boolean
  gitOpen?: boolean
  /** 退出登录：只清 hub 那把（各台 host 的近路钥匙保留）。无密钥时不显示。 */
  onLogout?: () => void
  /**
   * 切换到访客模式（左上角 host 列表里，退出登录上方）。本地没有存过访客
   * 令牌时由调用方弹门禁要求输入。纯 local 模式没有 hub 承载白名单，不显示。
   */
  onEnterGuest?: () => void
}) {
  const hostName = useChatStore((s) => s.hostName)
  const hostId = useChatStore((s) => s.hostId)
  const hosts = useChatStore((s) => s.hosts)
  const feSubscribers = useChatStore((s) => s.feSubscribers)
  const mode = useChatStore((s) => s.mode)
  const selectedHostId = useChatStore((s) => s.selectedHostId)
  const switchHost = useChatStore((s) => s.switchHost)
  const setHostRoute = useChatStore((s) => s.setHostRoute)
  const conn = useChatStore((s) => s.conn)
  const layerErrors = useChatStore((s) => s.layerErrors)
  const resetToEmpty = useChatStore((s) => s.resetToEmpty)
  const historyOpen = useChatStore((s) => s.historyOpen)
  const openHistory = useChatStore((s) => s.openHistory)
  const closeHistory = useChatStore((s) => s.closeHistory)
  const openExtensions = useChatStore((s) => s.openExtensions)
  const closeExtensions = useChatStore((s) => s.closeExtensions)
  const extensionsOpen = useChatStore((s) => s.extensionsOpen)
  const openSettings = useChatStore((s) => s.openSettings)
  const closeSettings = useChatStore((s) => s.closeSettings)
  const settingsOpen = useChatStore((s) => s.settingsOpen)
  const openUsage = useChatStore((s) => s.openUsage)
  const closeUsage = useChatStore((s) => s.closeUsage)
  const usageOpen = useChatStore((s) => s.usageOpen)
  const sidebarCollapsed = useChatStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useChatStore((s) => s.toggleSidebar)

  const [openHosts, setOpenHosts] = useState(false)
  // 订阅者详情面板（顶栏数字点开）。hub 模式才有数据；关掉 host 下拉等
  // 其他浮层不影响它，它是独立的模态。
  const [subscribersOpen, setSubscribersOpen] = useState(false)
  // Mobile (lg:hidden) "更多" menu — the secondary action buttons fold
  // into one ⋮ trigger; clicking expands them vertically.
  const [moreOpen, setMoreOpen] = useState(false)
  // 窄屏时顶栏控件会换行，锚点可能落到屏幕左侧；两个下拉都按实测锚点夹取，
  // 避免 fixed/absolute 面板整体跑出视口。
  const historyAnchorRef = useRef<HTMLDivElement>(null)
  const moreAnchorRef = useRef<HTMLDivElement>(null)
  const historyPanel = useAnchoredPanel({
    open: historyOpen,
    anchorRef: historyAnchorRef,
    maxWidth: 320,
    vwFraction: 0.84,
  })
  const morePanel = useAnchoredPanel({
    open: moreOpen,
    anchorRef: moreAnchorRef,
    maxWidth: 256,
    vwFraction: 0.9,
  })
  // history 下拉的会话搜索（与桌面侧边栏同一套 SessionSearchBox：按钮
  // 展开 → 命中接管列表；打开命中或收起下拉后归位）。
  const [historySearchOpen, setHistorySearchOpen] = useState(false)
  const [historySearchActive, setHistorySearchActive] = useState(false)
  // 收起下拉同时归位搜索：下次打开回到紧凑列表态。
  const closeMobileHistory = () => {
    closeHistory()
    setHistorySearchOpen(false)
    setHistorySearchActive(false)
  }
  // The theme row expands inline (accordion) inside the 更多 menu.
  const [themeExpanded, setThemeExpanded] = useState(false)
  // 单个 host 的操作菜单（右键 / 行内 ⋮ 打开，fixed 坐标）。
  const [menuHost, setMenuHost] = useState<{ host: HostInfo; pos: { x: number; y: number } } | null>(null)
  // 添加 Host（配对码）模态框。
  const [addHostOpen, setAddHostOpen] = useState(false)
  // 修改名称 / 删除 / 重启确认的目标 host。
  const [renameTarget, setRenameTarget] = useState<HostInfo | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<HostInfo | null>(null)
  const [restartTarget, setRestartTarget] = useState<HostInfo | null>(null)
  // 当前选中的 host（右键左上角开关直接对当前 host 弹菜单）。
  const currentHost =
    hosts.find((h) => h.hostId === selectedHostId) ??
    (hosts.length ? hosts[0] : null)
  const layerErr = pickLayerError(layerErrors)
  // 名称前的两个状态点：左点汇总其他 Host（正忙优先 > 在线 > 离线），
  // 右点只看当前 Host。分层错误/警告覆盖在右点上，优先级高于正忙；
  // 注册表还没有当前 Host 时按连接状态兜底。
  const otherHosts = hosts.filter((h) => h.hostId !== currentHost?.hostId)
  const othersSignal = otherHostsSignal(hosts, currentHost?.hostId)
  const currentSignal: HostSignal =
    layerErr?.err.level === 'error' || conn === 'error'
      ? 'error'
      : layerErr
        ? 'warning'
        : currentHost
          ? hostSignal(currentHost)
          : conn === 'busy'
            ? 'busy'
            : conn === 'ready'
              ? 'idle'
              : 'offline'
  // 只有一台 Host 时左点没有意义：只画当前 Host 一个点。
  const hostSignalsTitle =
    otherHosts.length > 0
      ? `其他 Host：${hostSignalLabel(othersSignal)} · 当前 Host：${hostSignalLabel(currentSignal)}`
      : `当前 Host：${hostSignalLabel(currentSignal)}`
  // 退出登录：hub 模式下它在 host 下拉里（「添加 Host」下面，两端共用）。
  // 纯 local 模式左上角是静态 Localhost 标签、没有 host 下拉，退出留在
  // 右上角（桌面）/ ⋮ 菜单（移动端），否则无处可点。
  const logoutInChrome = mode === 'local' && !!onLogout && !!transport.getAccessToken()

  // Host label reflects connection health: abnormal → "connecting" / "error".
  // 分层错误（hub/host 层）不改写这里的文案：host 名字保持原样，错误/警告
  // 由名称前的状态点与右侧 LayerErrNotice 指示——错误既不挤掉 host 名字，
  // 也不另占一整条。
  const hostLabel = layerErr
    ? hostName || 'Local Host'
    : conn === 'connecting'
      ? 'connecting'
      : conn === 'error' || conn === 'offline'
        ? 'error'
        : hostName || 'Local Host'
  const hostLabelColor = layerErr
    ? ''
    : conn === 'connecting'
      ? 'text-gn-muted'
      : conn === 'error' || conn === 'offline'
        ? 'text-gn-red'
        : ''
  // relative z-40 so host/history/more dropdowns stack above WorkspaceBar
  // (sticky z-30) and scrollback sticky prompts (z-10). Without a stacking
  // context on this chrome, absolute z-40 children still lose to later
  // siblings and chat text "shows through" the history panel.
  return (
    <header className="relative z-40 w-full min-w-0 max-w-[100vw] select-none border-b border-gn-prompt-border bg-gn-bg-base touch-pan-x overscroll-none">
      {/* Main row: host switcher + subscribers + actions. 固定单行、宽度
          不超过视口：窄屏时由 host 名称截断让位，new/history/更多 永不
          换行。层错误 / 警告在窄屏（< lg）独占第二行，桌面才回到行内。 */}
      <div
        className={`flex w-full min-w-0 shrink-0 items-center gap-2 px-3 py-[6px] sm:px-4 text-[12px] text-gn-muted ${
          layerErr ? 'flex-wrap lg:flex-nowrap' : 'flex-nowrap'
        }`}
      >
        {/* Desktop-only sidebar collapse toggle — sits left of the host switcher. */}
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? '展开会话侧边栏' : '折叠会话侧边栏'}
          title={sidebarCollapsed ? '展开会话侧边栏' : '折叠会话侧边栏'}
          className="hidden min-h-8 items-center rounded px-1.5 hover:bg-gn-bg-highlight hover:text-gn-fg lg:inline-flex"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            className="shrink-0"
            aria-hidden
          >
            <rect x="1.2" y="2.2" width="11.6" height="9.6" rx="1" />
            <line x1="5" y1="2.2" x2="5" y2="11.8" />
            <path d="M2.4 5h1.4M2.4 8h1.4" />
          </svg>
        </button>
        <div className="relative min-w-0 shrink">
          {mode === 'local' ? (
            // 本地模式：锁定本机 —— 静态 Localhost 标签，不可点击、无下拉。
            <div
              className="flex min-h-8 max-w-[40vw] items-center gap-1.5 truncate rounded px-2 py-0.5 sm:max-w-xs"
              title="本地模式（仅本机 capri-host，无 host 切换）"
            >
              <span className="min-w-0 truncate text-gn-fg">Localhost</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setOpenHosts((v) => !v)}
              onContextMenu={(e) => {
                // 网页端：右键当前 host 直接弹操作菜单（修改 / 删除）。
                e.preventDefault()
                if (currentHost) {
                  setMenuHost({ host: currentHost, pos: clampMenuPos(e.clientX, e.clientY) })
                } else {
                  setOpenHosts(true)
                }
              }}
              className={`flex max-w-[40vw] sm:max-w-xs items-center gap-1.5 truncate rounded px-2 py-0.5 hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8 ${hostLabelColor}`}
              title={
                conn === 'connecting' || conn === 'error' || conn === 'offline'
                  ? `连接状态: ${conn}${hostName ? ` · ${hostName}` : ''} · ${hostSignalsTitle}`
                  : `${hostName || 'Local Host'}（右键可管理 Host） · ${hostSignalsTitle}`
              }
            >
              <span className="mr-0.5 flex shrink-0 items-center gap-1" aria-hidden>
                {otherHosts.length > 0 && (
                  <span
                    data-host-dot="others"
                    className={`h-1.5 w-1.5 rounded-full ${HOST_SIGNAL_DOT_CLASS[othersSignal]}`}
                  />
                )}
                <span
                  data-host-dot="current"
                  className={`h-1.5 w-1.5 rounded-full ${HOST_SIGNAL_DOT_CLASS[currentSignal]}`}
                />
              </span>
              <span className="min-w-0 truncate">{hostLabel}</span>
              <ChevronDown
                size={12}
                strokeWidth={2}
                className="shrink-0 text-gn-gutter"
                aria-hidden
              />
            </button>
          )}
          {openHosts && (
            <>
              <button
                type="button"
                className="fixed inset-0 z-30 cursor-default"
                aria-label="close"
                onClick={() => {
                  setOpenHosts(false)
                  setMenuHost(null)
                }}
              />
              <div className="absolute left-0 top-full z-40 mt-1 w-64 max-w-[90vw] gn-menu">
                <div className="px-3 pb-1 pt-1.5 text-[10px] uppercase tracking-wider text-gn-gutter">
                  hosts
                </div>
                {(hosts.length
                  ? hosts
                  : [{ hostId: hostId || 'local', hostName: hostName || 'Local Host', online: true }]
                ).map((h) => {
                  const current = h.hostId === selectedHostId
                  // 空列表时的合成行只是渲染占位，没有实时数据；别把它标成「空闲」。
                  const state = hosts.length ? hostState(h) : undefined
                  const stateLabel = hostStateLabel(state)
                  // 每次渲染读 transport：discoverLocalHost / refreshHosts 后
                  // hosts 更新会带动重绘，通路标记随之刷新。近路是按 hostId 逐台
                  // 验证的（同机可能有多台 host，也可能一台都没有）。
                  const localRoute = transport.getLocalRoute(h.hostId)
                  // 不能直连本机的（无近路候选）不显示通道：行内标记与悬停
                  // 提示都省掉——反正只有 Hub 中继一条路，标了也是噪声。
                  const hasCandidate = transport.hasLocalCandidate(h.hostId)
                  const routeState = transport.activeRouteFor(h.hostId)
                  const route = hostRouteLabel(routeState)
                  const routeHint =
                    routeState === 'direct'
                      ? `API/SSE 直连 ${localRoute?.base || '本机'}`
                      : routeState === 'pending'
                        ? '已探到本机这台，等它的钥匙（现在走 Hub 中继）'
                        : '经 Hub 中继'
                  return (
                    <div
                      key={h.hostId}
                      className="group/host relative"
                      onContextMenu={(e) => {
                        // 网页端：右键任意 host 行弹操作菜单。
                        e.preventDefault()
                        setMenuHost({ host: h, pos: clampMenuPos(e.clientX, e.clientY) })
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setMenuHost(null)
                          setOpenHosts(false)
                          void switchHost(h.hostId)
                        }}
                        className={`flex w-full items-center gap-2 px-3 py-2 pr-9 text-left text-[12px] hover:bg-gn-bg-highlight ${current ? 'bg-gn-bg-highlight' : ''}`}
                        title={
                          h.online
                            ? stateLabel
                              ? `切换到 ${h.hostName}（${stateLabel}${hasCandidate ? ` · ${routeHint}` : ''}，右键可管理）`
                              : hasCandidate
                                ? `切换到 ${h.hostName}（${routeHint}，右键可管理）`
                                : `切换到 ${h.hostName}（右键可管理）`
                            : `${h.hostName}（离线${hasCandidate ? ` · ${routeHint}` : ''}）`
                        }
                      >
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${hostDotClass(h)}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-gn-fg">
                            {h.hostName}
                            {current && <span className="ml-1.5 text-[10px] text-gn-cyan">当前</span>}
                            {hasCandidate && (
                              <span
                                className={`ml-1.5 text-[10px] ${
 route === '直连'
                                    ? 'text-gn-green'
                                    : route === '待验证'
                                      ? 'text-gn-yellow'
                                      : 'text-gn-gutter'
                                }`}
                              >
                                {route}
                              </span>
                            )}
                          </div>
                          <div className="truncate font-mono text-[10px] text-gn-muted">
                            {h.hostId}
                            {stateLabel && (
                              <span className={`ml-1.5 ${state ? HOST_STATE_TEXT_CLASS[state] : ''}`}>
                                {stateLabel}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                      {/* 行内 ⋮ 菜单图标：移动端（无右键）的主要入口，桌面端悬停可见。 */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          const r = e.currentTarget.getBoundingClientRect()
                          setMenuHost(
                            menuHost?.host.hostId === h.hostId
                              ? null
                              : { host: h, pos: clampMenuPos(r.right - 208, r.bottom + 2) },
                          )
                        }}
                        aria-label={`${h.hostName} 操作`}
                        title="修改 / 删除"
                        className={`absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-gn-gutter hover:bg-gn-bg-highlight hover:text-gn-fg lg:opacity-0 lg:group-hover/host:opacity-100 ${menuHost?.host.hostId === h.hostId ? 'lg:opacity-100' : ''}`}
                      >
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          aria-hidden
                        >
                          <circle cx="3.2" cy="8" r="1.4" />
                          <circle cx="8" cy="8" r="1.4" />
                          <circle cx="12.8" cy="8" r="1.4" />
                        </svg>
                      </button>
                    </div>
                  )
                })}
                <div className="border-t border-gn-prompt-border">
                  <button
                    type="button"
                    onClick={() => {
                      setOpenHosts(false)
                      setAddHostOpen(true)
                    }}
                    className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                    title="获取新配对码，在另一台机器上接入 hub"
                  >
                    <Plus size={13} strokeWidth={2} aria-hidden />
                    添加 Host
                  </button>
                  {/* 切换到访客模式：只读分享视图。纯 local 没有 hub 承载
                      白名单，不给入口；管理员未登录时也没有可切的身份。 */}
                  {onEnterGuest && transport.getAccessToken() && (
                    <button
                      type="button"
                      onClick={() => {
                        setOpenHosts(false)
                        onEnterGuest()
                      }}
                      className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                      title="切换到访客模式（只读分享视图；本地没有存过访客令牌时会要求输入）"
                    >
                      <ShieldQuestion size={13} strokeWidth={2} aria-hidden />
                      切换到访客模式
                    </button>
                  )}
                  {onLogout && transport.getAccessToken() && (
                    <button
                      type="button"
                      onClick={() => {
                        setOpenHosts(false)
                        onLogout()
                      }}
                      className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                      title="退出登录（清掉本机保存的 Hub 密钥；各台 Host 的近路钥匙保留）"
                    >
                      <LogOut size={13} strokeWidth={2} aria-hidden />
                      退出登录
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
          {/* 单个 host 的操作菜单：右键（网页）/ ⋮ 图标（移动端）打开。 */}
          {menuHost && (
            <HostActionsMenu
              host={menuHost.host}
              pos={menuHost.pos}
              onClose={() => setMenuHost(null)}
              onRename={(h) => {
                setMenuHost(null)
                setRenameTarget(h)
              }}
              onDelete={(h) => {
                setMenuHost(null)
                setDeleteTarget(h)
              }}
              onRestart={(h) => {
                setMenuHost(null)
                setRestartTarget(h)
              }}
              routeState={transport.activeRouteFor(menuHost.host.hostId)}
              onRoute={(h, choice) => void setHostRoute(h.hostId, choice)}
              // 重启作用于当前选中 host 的 agent（transport 按选中
              // host 路由）；非当前 host 行不显示重启项，避免误解。
              canRestart={menuHost.host.hostId === selectedHostId}
            />
          )}
          {renameTarget && (
            <RenameHostModal host={renameTarget} onClose={() => setRenameTarget(null)} />
          )}
          {deleteTarget && (
            <DeleteHostModal host={deleteTarget} onClose={() => setDeleteTarget(null)} />
          )}
          {restartTarget && (
            <RestartAgentModal host={restartTarget} onClose={() => setRestartTarget(null)} />
          )}
          {addHostOpen && <AddHostModal onClose={() => setAddHostOpen(false)} />}
        </div>

        {/* Hub 在线 FE 订阅数：紧跟 host 块右侧。数字来自 hub 的 hello /
            subscribers_changed（/ws/fe 连接总数，含本页）；访客的 hello
            不带该字段，因此不渲染，避免显示一个假的 0。人物图标把裸数字读成「在线订阅者」，
            与左右两侧的纯按钮区分开。点开 = 订阅者详情（地址 / 设备 /
            哪把令牌 / 正在看哪个会话），数据来自 GET /api/subscribers。 */}
        {mode === 'hub' && feSubscribers != null && (
          <button
            type="button"
            onClick={() => setSubscribersOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={subscribersOpen}
            className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] leading-none tabular-nums text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
            title={`Hub 当前 ${feSubscribers} 个 FE 在线订阅（含本页）`}
            aria-label={`Hub 在线 FE 订阅数 ${feSubscribers}，点击查看详情`}
          >
            <Eye size={12} strokeWidth={2} className="shrink-0 text-gn-gutter" aria-hidden />
            {feSubscribers}
          </button>
        )}
        {subscribersOpen && <SubscribersPanel onClose={() => setSubscribersOpen(false)} />}

        {/* hub / host 层错误 / 警告：窄屏单独占第二行（整行放宽，消息可
            换行）；lg 起回到订阅数右侧的行内提示。 */}
        {layerErr && (
          <LayerErrNotice
            key={`${layerErr.layer}:${layerErr.err.at}`}
            layer={layerErr.layer}
            err={layerErr.err}
            className="order-last w-full pb-1 lg:order-none lg:w-auto lg:max-w-[26rem] lg:pb-0"
          />
        )}

        <div className="min-w-0 flex-1" />

        {/* Desktop-only inline actions — on mobile they fold into the ⋮ menu below. */}
        <div className="hidden shrink-0 items-center gap-2 lg:flex">
          <ThemePicker />
          {onOpenMcp && (
            <button
              type="button"
              onClick={onOpenMcp}
              aria-pressed={!!mcpOpen}
              className={chromeBtnClass(!!mcpOpen)}
              title="MCP 服务器状态"
            >
              <Boxes size={13} strokeWidth={2} aria-hidden />
              mcp
            </button>
          )}
          {onOpenGit && (
            <button
              type="button"
              onClick={onOpenGit}
              aria-pressed={!!gitOpen}
              className={chromeBtnClass(!!gitOpen)}
              title="Git 面板 — 工作区状态 / diff / 提交"
            >
              <GitBranch size={13} strokeWidth={2} aria-hidden />
              git
            </button>
          )}
          <button
            type="button"
            onClick={() => (extensionsOpen ? closeExtensions() : openExtensions('hooks'))}
            aria-pressed={extensionsOpen}
            className={chromeBtnClass(extensionsOpen)}
            title="扩展（/hooks /plugins /skills /marketplace）"
          >
            <Puzzle size={13} strokeWidth={2} aria-hidden />
            ext
          </button>
          <button
            type="button"
            onClick={() => (usageOpen ? closeUsage() : openUsage())}
            aria-pressed={usageOpen}
            className={chromeBtnClass(usageOpen)}
            title="usage — token 用量聚合（按模型/时间窗口）+ billing credits"
          >
            <Activity size={13} strokeWidth={2} aria-hidden />
            usage
          </button>
          <button
            type="button"
            onClick={() => (settingsOpen ? closeSettings() : openSettings())}
            aria-pressed={settingsOpen}
            className={chromeBtnClass(settingsOpen)}
            title="设置（F2）"
          >
            <Settings size={13} strokeWidth={2} aria-hidden />
            settings
          </button>
          {logoutInChrome && (
            <button
              type="button"
              onClick={onLogout}
              className={chromeBtnClass()}
              title="退出登录（清掉本机保存的 Hub 密钥；各台 Host 的近路钥匙保留）"
            >
              <LogOut size={13} strokeWidth={2} aria-hidden />
              退出
            </button>
          )}
        </div>
        {/* Mobile-only new — sits left of history (no ⋮ dive needed).
            Desktop relies on the sidebar "会话 new" header button. */}
        <div className="shrink-0 lg:hidden">
          <button
            type="button"
            onClick={() => resetToEmpty()}
            className={chromeBtnClass()}
            title="新建会话（先进入空状态选择工作目录）"
          >
            <Plus size={13} strokeWidth={2} aria-hidden />
            new
          </button>
        </div>
        {/* Mobile-only history trigger — desktop history lives in the persistent left sidebar. */}
        <div ref={historyAnchorRef} className="relative shrink-0 lg:hidden">
          <button
            type="button"
            onClick={() => (historyOpen ? closeMobileHistory() : void openHistory())}
            className={chromeBtnClass(historyOpen)}
            aria-pressed={historyOpen}
            title="加载历史会话"
          >
            <History size={13} strokeWidth={2} aria-hidden />
            history
          </button>
          {historyOpen && (
            <>
              <button
                type="button"
                className="fixed inset-0 z-30 cursor-default"
                aria-label="close"
                onClick={closeMobileHistory}
              />
              {/* Mobile dropdown — renders the SAME workspace-grouped list as
                  the desktop sidebar (SessionHistoryList), so the two ends
                  stay in sync (分组 / 折叠 / 加载更多 / 重命名 / 删除)，
                  plus the same「会话 + 刷新 + 搜索」header
                  (SessionListHeader). Session search mirrors the desktop
                  sidebar: button → SessionSearchBox replaces the grouped
                  list while a query is active; opening a hit also closes
                  the dropdown.
                  Placed from the measured trigger rect and clamped to the
                  viewport: on a narrow phone the top-bar controls wrap and
                  the history button can land near the LEFT edge, where a
                  plain right-0 anchor pushed most of the panel off-screen.
                  Header is outside the scroll area (flex-col) so the list's
                  sticky group headers stick below it instead of sliding
                  underneath. */}
              {historyPanel && (
              <div
                className="fixed z-40 flex max-h-[70vh] flex-col overflow-hidden gn-menu isolate"
                style={{
                  left: historyPanel.left,
                  top: historyPanel.top,
                  width: historyPanel.width,
                  backgroundColor: 'var(--color-gn-bg-base)',
                }}
              >
                {/* py-1.5（非 py-2）：给 labeled 大按钮留高度的同时，
                    头部总高保持 37px 不变。 */}
                <div className="flex min-h-[37px] shrink-0 items-center gap-2 border-b border-gn-prompt-border px-3 py-1.5">
                  <SessionListHeader
                    alignRight
                    labeled
                    searchOpen={historySearchOpen}
                    onToggleSearch={() => setHistorySearchOpen((v) => !v)}
                  />
                </div>
                {historySearchOpen && (
                  <SessionSearchBox
                    onActive={setHistorySearchActive}
                    onRequestClose={() => {
                      // 打开命中后：搜索归位，下拉一并收起（会话已切换）。
                      setHistorySearchOpen(false)
                      setHistorySearchActive(false)
                      closeHistory()
                    }}
                  />
                )}
                {/* 与桌面侧栏同一个列表：关原生锚定，重排位置交给
                    SessionHistoryList 的 useScrollAnchor（取消待办不挪视口）。 */}
                <div
                  className="gn-no-scrollbar min-h-0 overflow-y-auto touch-pan-y overscroll-contain"
                  style={{ overflowAnchor: 'none' }}
                >
                  {historySearchOpen && historySearchActive ? null : <SessionHistoryList />}
                </div>
              </div>
              )}
            </>
          )}
        </div>

        {/* Mobile-only "更多" — the secondary action buttons fold into one ⋮
            trigger; clicking expands them vertically under the button. */}
        <div ref={moreAnchorRef} className="relative shrink-0 lg:hidden">
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            aria-label="更多操作"
            title="更多操作：theme / mcp / git / ext / settings"
            className={chromeBtnClass(moreOpen)}
          >
            <EllipsisVertical size={13} strokeWidth={2} aria-hidden />
          </button>
          {moreOpen && (
            <>
              <button
                type="button"
                className="fixed inset-0 z-30 cursor-default"
                aria-label="close"
                onClick={() => setMoreOpen(false)}
              />
              {morePanel && (
              <div
                className="fixed z-40 max-h-[70vh] overflow-y-auto gn-menu touch-pan-y overscroll-contain"
                style={{ left: morePanel.left, top: morePanel.top, width: morePanel.width }}
              >
                <div className="px-3 pb-1 pt-1.5 text-[10px] uppercase tracking-wider text-gn-gutter">
                  more
                </div>
                {/* theme — inline accordion, same options as the desktop picker. */}
                <button
                  type="button"
                  onClick={() => setThemeExpanded((v) => !v)}
                  className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  title={themeExpanded ? '收起主题选项' : '展开主题选项'}
                >
                  <Palette size={14} strokeWidth={2} aria-hidden />
                  <span className="min-w-0 flex-1">theme</span>
                  <span className="shrink-0 text-gn-gutter" aria-hidden>
                    {themeExpanded ? (
                      <ChevronUp size={13} strokeWidth={2} />
                    ) : (
                      <ChevronDown size={13} strokeWidth={2} />
                    )}
                  </span>
                </button>
                {themeExpanded && (
                  <div className="border-t border-gn-prompt-border/60">
                    <ThemeOptions
                      onSelect={() => {
                        setMoreOpen(false)
                        setThemeExpanded(false)
                      }}
                    />
                  </div>
                )}
                {onOpenMcp && (
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false)
                      onOpenMcp()
                    }}
                    className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                    title="MCP 服务器状态"
                  >
                    <Boxes size={14} strokeWidth={2} aria-hidden />
                    mcp
                  </button>
                )}
                {onOpenGit && (
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false)
                      onOpenGit()
                    }}
                    className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                    title="Git 面板 — 工作区状态 / diff / 提交"
                  >
                    <GitBranch size={14} strokeWidth={2} aria-hidden />
                    git
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false)
                    openExtensions('hooks')
                  }}
                  className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  title="扩展（/hooks /plugins /skills /marketplace）"
                >
                  <Puzzle size={14} strokeWidth={2} aria-hidden />
                  ext
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false)
                    openUsage()
                  }}
                  className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  title="usage — token 用量聚合（按模型/时间窗口）+ billing credits"
                >
                  <Activity size={14} strokeWidth={2} aria-hidden />
                  usage
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false)
                    openSettings()
                  }}
                  className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  title="设置（F2）"
                >
                  <Settings size={14} strokeWidth={2} aria-hidden />
                  settings
                </button>
                {logoutInChrome && (
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false)
                      onLogout?.()
                    }}
                    className="flex w-full min-h-9 items-center gap-2 px-3 py-2 text-left text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                    title="退出登录（清掉本机保存的 Hub 密钥；各台 Host 的近路钥匙保留）"
                  >
                    <LogOut size={14} strokeWidth={2} aria-hidden />
                    退出登录
                  </button>
                )}
              </div>
              )}
            </>
          )}
        </div>
      </div>
    </header>
  )
}
