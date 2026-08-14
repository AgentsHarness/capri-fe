import type { ScrollEntry } from '../../api/types'
import {
  USER_COLLAPSED_MAX_LINES,
  collapseUserText,
} from '../../scrollback/userText'
import { Glyphs, SPINNER_FRAMES } from '../../theme/glyphs'
import { IconGlyph } from '../IconGlyph'
import { PromptTime } from './PromptTime'

export function StickyPrompt({
  pinnedUser,
  pinnedStore,
  historyLoadingMore,
  stickyNearTop,
  wsBarH,
  spinnerFrame,
  stickyBandElRef,
  lastPushYRef,
  onJump,
}: {
  pinnedUser: ScrollEntry | null
  pinnedStore: boolean
  historyLoadingMore: boolean
  stickyNearTop: boolean
  wsBarH: number
  spinnerFrame: number
  stickyBandElRef: { current: HTMLDivElement | null }
  lastPushYRef: { current: number }
  onJump: (id: string) => void
}) {
  return (
    <div
      className="pointer-events-none sticky z-10 h-0 overflow-visible"
      style={{ top: wsBarH }}
      aria-hidden={pinnedUser?.kind !== 'user' && !historyLoadingMore}
    >
      {(pinnedUser?.kind === 'user' || historyLoadingMore) && (
        <div
          ref={(el) => {
            stickyBandElRef.current = el
            if (el && lastPushYRef.current) {
              el.style.transform = `translateY(${lastPushYRef.current}px)`
            }
          }}
          data-sticky-prompt=""
          className="pointer-events-auto absolute inset-x-0 top-0 font-ui text-[13.5px] leading-[1.35] text-gn-fg select-none"
          style={{
            backgroundColor: 'var(--color-gn-bg-highlight)',
          }}
        >
          {pinnedUser?.kind === 'user' && (
            <button
              type="button"
              onClick={(ev) => {
                ev.stopPropagation()
                onJump(pinnedUser.id)
              }}
              className="group relative flex w-full min-w-0 cursor-pointer items-start gap-1.5 px-2.5 py-[11px] text-left transition-colors hover:brightness-110"
              title="点击跳转到此消息开头"
            >
              <span
                className="mt-[1.5px] shrink-0"
                style={{
                  color: (pinnedUser as { isShell?: boolean }).isShell
                    ? 'var(--color-gn-cyan)'
                    : 'var(--color-gn-accent-user)',
                }}
              >
                <IconGlyph
                  glyph={
                    (pinnedUser as { isShell?: boolean }).isShell
                      ? '$'
                      : pinnedUser.isCron
                        ? Glyphs.cronPrompt
                        : Glyphs.promptArrow
                  }
                  color={
                    (pinnedUser as { isShell?: boolean }).isShell
                      ? 'var(--color-gn-cyan)'
                      : 'var(--color-gn-accent-user)'
                  }
                />
              </span>
              <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                {/* store 回退：提示这条 prompt 在可见列表上方。 */}
                {pinnedStore ? `${Glyphs.ellipsis} ` : ''}
                {collapseUserText(pinnedUser.text, USER_COLLAPSED_MAX_LINES).text}
              </div>
              <PromptTime ts={pinnedUser.ts} className="top-[14.5px]" />
            </button>
          )}
          {/* 上滑加载上一轮：就地显示加载中（不依赖顶部按钮是否在视口内）。
              仅在无钉选用户消息时显示——sticky 钉着用户消息时不得把
              消息显示成「正在加载上一轮」（加载态由顶部按钮承担）。 */}
          {historyLoadingMore && pinnedUser?.kind !== 'user' && stickyNearTop && (
            <div className="flex items-center gap-1.5 px-2.5 py-[11px] text-[11.5px] text-gn-muted">
              <span className="text-[13px] leading-none">
                {SPINNER_FRAMES[spinnerFrame]}
              </span>
              <span>加载上一轮…</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
