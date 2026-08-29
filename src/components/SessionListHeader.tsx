import { useEffect, useRef, useState } from 'react'
import { Check, FolderTree, ListChecks, RefreshCw, Search } from 'lucide-react'
import { useChatStore } from '../store/chat'
import { SPINNER_FRAMES } from '../theme/glyphs'
import { useSessionSpinner } from '../hooks/sessionState'
import { useHistoryView, type HistoryListMode } from '../store/historyView'

/**
 * 会话列表头部：「会话」标题 + 展示形态切换 + 刷新按钮。
 *
 * - 形态切换：工作区（按 cwd 分组）/ 标记（仅置顶·待办）
 * - 刷新按钮三态：点击 → 字符动画转圈（跟随 workspaceLoading）→
 *   成功显示 ✓ 约 1.2s → 恢复。仅用户主动点击才占用按钮；启动 /
 *   自动刷新仍由列表中央 overlay 表达（见 SessionHistoryList），
 *   头部不出现被动加载指示。
 *
 * 桌面持久侧边栏（~288px）与移动端顶栏 history 下拉共用；桌面保持
 * 紧凑图标控件，移动端下拉传 labeled 换成「图标 + 文字」大热区按钮。
 */
export function SessionListHeader({
  alignRight = false,
  labeled = false,
  searchOpen = false,
  onToggleSearch,
}: {
  alignRight?: boolean
  /** 移动端下拉传 true：按钮带文字加大热区，标题/形态切换文字统一
   *  11px；桌面侧边栏保持紧凑图标。 */
  labeled?: boolean
  /** 搜索展开态高亮（配 onToggleSearch 才渲染搜索按钮）。 */
  searchOpen?: boolean
  /** 提供时在刷新按钮右侧渲染搜索开关（桌面侧边栏与移动端下拉都传）。 */
  onToggleSearch?: () => void
}) {
  const refreshSessions = useChatStore((s) => s.refreshSessions)
  const refreshWorkspaces = useChatStore((s) => s.refreshWorkspaces)
  const workspaceLoading = useChatStore((s) => s.workspaceLoading)

  const mode = useHistoryView((s) => s.mode)
  const setMode = useHistoryView((s) => s.setMode)

  // 刷新按钮状态机：idle → refreshing（用户点击后，跟随 workspaceLoading
  // 归 false）→ ok（✓ 短暂显示）→ idle。userRefreshRef 标记本次加载是否
  // 由用户点击发起：自动刷新期间保持 idle，不占按钮。
  const [refreshState, setRefreshState] = useState<'idle' | 'refreshing' | 'ok'>('idle')
  const userRefreshRef = useRef(false)
  const okTimerRef = useRef<number | null>(null)
  useEffect(() => {
    if (workspaceLoading) {
      if (userRefreshRef.current) setRefreshState('refreshing')
    } else if (userRefreshRef.current) {
      userRefreshRef.current = false
      setRefreshState('ok')
      if (okTimerRef.current != null) window.clearTimeout(okTimerRef.current)
      okTimerRef.current = window.setTimeout(() => setRefreshState('idle'), 1200)
    }
  }, [workspaceLoading])
  // 卸载时清掉 ✓ 回落定时器。
  useEffect(
    () => () => {
      if (okTimerRef.current != null) window.clearTimeout(okTimerRef.current)
    },
    [],
  )

  const doRefresh = () => {
    userRefreshRef.current = true
    // refreshWorkspaces 同步置 workspaceLoading=true，effect 随即把按钮
    // 切到转圈；这里不直接 setState，避免在已加载中点击时闪烁。
    void refreshSessions()
    void refreshWorkspaces()
  }
  const spinnerFrame = useSessionSpinner(refreshState === 'refreshing')

  return (
    <>
      <span
        className={`shrink-0 font-medium uppercase tracking-wide text-gn-gutter ${
          labeled ? 'text-[11px]' : 'text-[10.5px]'
        }`}
      >
        会话
      </span>

      {/* 展示形态：工作区 | 标记（图标 + 短文案，适配窄侧栏）；labeled
          模式文字与右侧按钮统一 11px。 */}
      <div
        className="inline-flex shrink-0 items-center rounded border border-gn-prompt-border/70 p-px"
        role="group"
        aria-label="会话列表展示形态"
      >
        <ModeTab
          active={mode === 'workspace'}
          onClick={() => setMode('workspace')}
          title="按工作区（目录）分组显示全部会话"
          mode="workspace"
          labeled={labeled}
        >
          <FolderTree size={11} strokeWidth={2.5} aria-hidden />
          目录
        </ModeTab>
        <ModeTab
          active={mode === 'marked'}
          onClick={() => setMode('marked')}
          title="只显示置顶与待办的会话"
          mode="marked"
          labeled={labeled}
        >
          <ListChecks size={11} strokeWidth={2.5} aria-hidden />
          标记
        </ModeTab>
      </div>

      {/* 刷新 + 搜索按钮组：刷新 idle 常驻可点；点击后转圈直到刷新完成，
          成功显示 ✓ 约 1.2s 后恢复。搜索按钮（可选）在刷新右侧，点击
          展开/收起搜索框。ml-auto（alignRight）：移动端下拉头部里控件
          单独贴右。labeled：移动端下拉用「图标 + 文字」加触控热区，
          桌面侧边栏保持 19px 纯图标紧凑样式。 */}
      <span
        className={`inline-flex shrink-0 items-center gap-0.5 ${
          alignRight ? 'ml-auto' : ''
        }`}
      >
        {refreshState === 'ok' ? (
          <span
            className={`inline-flex items-center justify-center text-gn-green ${
              labeled
                ? 'min-h-6 gap-1 rounded px-2 text-[11px] leading-none'
                : 'h-[19px] w-[19px]'
            }`}
            title="刷新完成"
            aria-label="刷新完成"
          >
            <Check size={labeled ? 13 : 12} strokeWidth={3} />
            {labeled && '已刷新'}
          </span>
        ) : (
          <button
            type="button"
            onClick={doRefresh}
            disabled={refreshState === 'refreshing'}
            className={`inline-flex items-center rounded text-gn-gutter transition-colors hover:bg-gn-bg-highlight hover:text-gn-cyan disabled:cursor-default ${
              labeled
                ? 'min-h-6 gap-1 px-2 text-[11px] leading-none'
                : 'h-[19px] w-[19px] justify-center'
            }`}
            title={refreshState === 'refreshing' ? '正在刷新会话列表' : '刷新会话列表'}
            aria-label={refreshState === 'refreshing' ? '正在刷新会话列表' : '刷新会话列表'}
            aria-live="polite"
          >
            {refreshState === 'refreshing' ? (
              <span className="text-[11px] leading-none text-gn-muted" aria-hidden>
                {SPINNER_FRAMES[spinnerFrame]}
              </span>
            ) : (
              <RefreshCw size={labeled ? 13 : 11} strokeWidth={2.5} />
            )}
            {labeled && '刷新'}
          </button>
        )}
        {onToggleSearch && (
          <button
            type="button"
            onClick={onToggleSearch}
            aria-pressed={searchOpen}
            aria-label={searchOpen ? '关闭会话搜索' : '搜索历史会话'}
            title={searchOpen ? '关闭会话搜索' : '搜索历史会话'}
            className={`inline-flex items-center rounded transition-colors ${
              labeled
                ? 'min-h-6 gap-1 px-2 text-[11px] leading-none'
                : 'h-[19px] w-[19px] justify-center'
            } ${
              searchOpen
                ? 'bg-gn-bg-highlight text-gn-cyan'
                : 'text-gn-gutter hover:bg-gn-bg-highlight hover:text-gn-cyan'
            }`}
          >
            <Search size={labeled ? 13 : 11} strokeWidth={2.5} />
            {labeled && (searchOpen ? '收起' : '搜索')}
          </button>
        )}
      </span>
    </>
  )
}

function ModeTab({
  active,
  onClick,
  title,
  mode,
  labeled,
  children,
}: {
  active: boolean
  onClick: () => void
  title: string
  mode: HistoryListMode
  labeled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      aria-label={mode === 'workspace' ? '目录视图' : '标记视图'}
      className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 leading-none transition-colors ${
        labeled ? 'text-[11px]' : 'text-[10px]'
      } ${
        active
          ? 'bg-gn-bg-highlight text-gn-cyan'
          : 'text-gn-gutter hover:text-gn-fg'
      }`}
    >
      {children}
    </button>
  )
}
