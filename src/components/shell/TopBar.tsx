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
} from 'lucide-react'
import { useChatStore } from '../../store/chat'
import { useAnchoredPanel } from '../../hooks/useAnchoredPanel'
import { useMinWidth } from '../../hooks/useMinWidth'
import { ThemeOptions, ThemePicker } from './ThemePicker'
import { chromeBtnClass } from '../../theme/layout'
import { SessionHistoryList } from '../session/SessionHistoryList'
import { SessionListHeader } from '../session/SessionListHeader'
import { SessionSearchBox } from '../session/SessionSearchBox'
import { transport } from '../../api/client'
import { pickLayerError } from '../../lib/layerErr'
import { LayerErrNotice } from './LayerErrNotice'
import { SubscribersPanel } from '../panels/host/SubscribersPanel'
import { TopBarHostSwitcher } from './TopBarHostSwitcher'

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
  const feSubscribers = useChatStore((s) => s.feSubscribers)
  const mode = useChatStore((s) => s.mode)
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
  // 层错误提示在窄屏独立成行、lg 起回到主行内联。用与 Tailwind lg 相同的
  // 1024px 断点只在两个位置间挂载一份提示，避免重复的 role=alert。
  const isDesktop = useMinWidth(1024)
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
  const layerErr = pickLayerError(layerErrors)
  // 退出登录：hub 模式下它在 host 下拉里（「添加 Host」下面，两端共用）。
  // 纯 local 模式左上角是静态 Localhost 标签、没有 host 下拉，退出留在
  // 右上角（桌面）/ ⋮ 菜单（移动端），否则无处可点。
  const logoutInChrome = mode === 'local' && !!onLogout && !!transport.getAccessToken()

  // relative z-40 so host/history/more dropdowns stack above WorkspaceBar
  // (sticky z-30) and scrollback sticky prompts (z-10). Without a stacking
  // context on this chrome, absolute z-40 children still lose to later
  // siblings and chat text "shows through" the history panel.
  return (
    <header className="relative z-40 w-full min-w-0 max-w-[100vw] select-none border-b border-gn-prompt-border bg-gn-bg-base touch-pan-x overscroll-none">
      {/* Main row: host switcher + subscribers + actions. 始终单行、宽度
          不超过视口：窄屏时由 host 名称截断让位，new/history/更多 永不
          换行。层错误 / 警告在窄屏（< lg）由下方独立块占第二行，lg 起
          才回到本行内联。 */}
      <div className="flex w-full min-w-0 shrink-0 flex-nowrap items-center gap-2 px-3 py-[6px] sm:px-4 text-[12px] text-gn-muted">
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
        <TopBarHostSwitcher onEnterGuest={onEnterGuest} onLogout={onLogout} />

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

        {/* hub / host 层错误 / 警告：lg 起贴在订阅数右侧的行内提示；
            窄屏由 header 末尾的独立块渲染为第二行。 */}
        {layerErr && isDesktop && (
          <LayerErrNotice
            key={`${layerErr.layer}:${layerErr.err.at}`}
            layer={layerErr.layer}
            err={layerErr.err}
            className="min-w-0 max-w-[26rem]"
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
      {/* 窄屏层错误 / 警告：主行始终 nowrap，提示单独占第二行。 */}
      {layerErr && !isDesktop && (
        <div className="px-3 pb-1 sm:px-4">
          <LayerErrNotice
            key={`${layerErr.layer}:${layerErr.err.at}`}
            layer={layerErr.layer}
            err={layerErr.err}
            className="w-full"
          />
        </div>
      )}
    </header>
  )
}
