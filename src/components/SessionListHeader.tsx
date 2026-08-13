import { useEffect, useRef, useState } from 'react'
import { Check, FolderTree, ListChecks, RefreshCw } from 'lucide-react'
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
 * 桌面持久侧边栏（~288px）与移动端顶栏 history 下拉共用；控件保持紧凑。
 */
export function SessionListHeader({ alignRight = false }: { alignRight?: boolean }) {
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
      <span className="shrink-0 text-[10.5px] font-medium uppercase tracking-wide text-gn-gutter">
        会话
      </span>

      {/* 展示形态：工作区 | 标记（图标 + 短文案，适配窄侧栏） */}
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
        >
          <FolderTree size={11} strokeWidth={2.5} aria-hidden />
          目录
        </ModeTab>
        <ModeTab
          active={mode === 'marked'}
          onClick={() => setMode('marked')}
          title="只显示置顶与待办的会话"
          mode="marked"
        >
          <ListChecks size={11} strokeWidth={2.5} aria-hidden />
          标记
        </ModeTab>
      </div>

      {/* 刷新按钮：idle 常驻可点；点击后转圈直到刷新完成，成功显示 ✓
          约 1.2s 后恢复。ml-auto（alignRight）：移动端下拉头部里控件
          单独贴右。 */}
      <span
        className={`inline-flex h-[19px] w-[19px] shrink-0 items-center justify-center ${
          alignRight ? 'ml-auto' : ''
        }`}
      >
        {refreshState === 'ok' ? (
          <span
            className="inline-flex h-[19px] w-[19px] items-center justify-center text-gn-green"
            title="刷新完成"
            aria-label="刷新完成"
          >
            <Check size={12} strokeWidth={3} />
          </span>
        ) : (
          <button
            type="button"
            onClick={doRefresh}
            disabled={refreshState === 'refreshing'}
            className="inline-flex h-[19px] w-[19px] items-center justify-center rounded text-gn-gutter transition-colors hover:bg-gn-bg-highlight hover:text-gn-cyan disabled:cursor-default"
            title={refreshState === 'refreshing' ? '正在刷新会话列表' : '刷新会话列表'}
            aria-label={refreshState === 'refreshing' ? '正在刷新会话列表' : '刷新会话列表'}
            aria-live="polite"
          >
            {refreshState === 'refreshing' ? (
              <span className="text-[11px] leading-none text-gn-muted">
                {SPINNER_FRAMES[spinnerFrame]}
              </span>
            ) : (
              <RefreshCw size={11} strokeWidth={2.5} />
            )}
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
  children,
}: {
  active: boolean
  onClick: () => void
  title: string
  mode: HistoryListMode
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      aria-label={mode === 'workspace' ? '目录视图' : '标记视图'}
      className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] leading-none transition-colors ${
        active
          ? 'bg-gn-bg-highlight text-gn-cyan'
          : 'text-gn-gutter hover:text-gn-fg'
      }`}
    >
      {children}
    </button>
  )
}
