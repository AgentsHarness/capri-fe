import { RefreshCw } from 'lucide-react'
import { useChatStore } from '../store/chat'
import { SPINNER_FRAMES } from '../theme/glyphs'
import { useSessionSpinner } from './sessionState'

/**
 * 会话列表头部：「会话」标题 + 刷新指示/按钮。
 *
 * - 列表非空且正在拉取（workspaceLoading）：标题右侧显示字符加载动画
 *   （braille spinner，与全站 busy 同节拍）。
 * - 空闲：同一位置是刷新按钮，点击进入加载态（refreshSessions +
 *   refreshWorkspaces，与挂载时一致）。
 * - 列表为空且加载中：头部不重复显示，由 SessionHistoryList 中央加载态
 *   接管（与 scrollback 一致）。
 *
 * 桌面持久侧边栏（HistorySidebar）与移动端顶栏 history 下拉共用，
 * 保证两端刷新入口一致。alignRight（移动端）：刷新控件单独右对齐。
 */
export function SessionListHeader({ alignRight = false }: { alignRight?: boolean }) {
  const refreshSessions = useChatStore((s) => s.refreshSessions)
  const refreshWorkspaces = useChatStore((s) => s.refreshWorkspaces)
  const workspaceLoading = useChatStore((s) => s.workspaceLoading)
  // 刷新期间旧数据不清空：workspaces/sessions 仍是加载前的列表，
  // 非空即"本来不是空"→ 头部字符动画。
  const hasContent = useChatStore(
    (s) => s.workspaces.length > 0 || s.sessions.length > 0,
  )
  const refreshing = workspaceLoading && hasContent
  const spinnerFrame = useSessionSpinner(refreshing)

  const doRefresh = () => {
    void refreshSessions()
    void refreshWorkspaces()
  }

  return (
    <>
      <span className="text-[10.5px] font-medium uppercase tracking-wide text-gn-gutter">
        会话
      </span>
      {/* 刷新指示：非空列表刷新中显示字符动画；空闲时同一位置是刷新
          按钮，点击进入加载态。空列表加载中由列表中央提示接管。
          ml-auto（alignRight）：移动端下拉头部里控件单独贴右。 */}
      <span
        className={`inline-flex h-[19px] w-[19px] shrink-0 items-center justify-center ${
          alignRight ? 'ml-auto' : ''
        }`}
      >
        {refreshing ? (
          <span
            className="text-[12px] leading-none text-gn-muted"
            title="正在刷新会话列表"
            aria-label="正在刷新会话列表"
            aria-live="polite"
          >
            {SPINNER_FRAMES[spinnerFrame]}
          </span>
        ) : (
          <button
            type="button"
            onClick={doRefresh}
            className="inline-flex h-[19px] w-[19px] items-center justify-center rounded text-gn-gutter transition-colors hover:bg-gn-bg-highlight hover:text-gn-cyan"
            title="刷新会话列表"
            aria-label="刷新会话列表"
          >
            <RefreshCw size={11} strokeWidth={2.5} />
          </button>
        )}
      </span>
    </>
  )
}
