import type { ScrollEntry } from '../../api/types'
import {
  USER_COLLAPSED_MAX_LINES,
  collapseUserText,
} from '../../scrollback/userText'
import { Glyphs } from '../../theme/glyphs'
import { IconGlyph } from '../IconGlyph'
import { PromptTime } from './PromptTime'

export function StickyPrompt({
  pinnedUser,
  pinnedStore,
  wsBarH,
  stickyBandElRef,
  lastPushYRef,
  onJump,
}: {
  pinnedUser: ScrollEntry | null
  pinnedStore: boolean
  wsBarH: number
  stickyBandElRef: { current: HTMLDivElement | null }
  lastPushYRef: { current: number }
  onJump: (id: string) => void
}) {
  return (
    <div
      className="pointer-events-none sticky z-10 h-0 overflow-visible"
      style={{ top: wsBarH }}
      aria-hidden={pinnedUser?.kind !== 'user'}
    >
      {pinnedUser?.kind === 'user' && (
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
                color: pinnedUser.isShell
                  ? 'var(--color-gn-cyan)'
                  : pinnedUser.isInterjection
                    ? 'var(--color-gn-warning)'
                    : 'var(--color-gn-accent-user)',
              }}
            >
              <IconGlyph
                glyph={
                  pinnedUser.isShell
                    ? '$'
                    : pinnedUser.isCron
                      ? Glyphs.cronPrompt
                      : Glyphs.promptArrow
                }
                color={
                  pinnedUser.isShell
                    ? 'var(--color-gn-cyan)'
                    : pinnedUser.isInterjection
                      ? 'var(--color-gn-warning)'
                      : 'var(--color-gn-accent-user)'
                }
              />
            </span>
            <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
              {/* store 回退：提示这条 prompt 在可见列表上方。 */}
              {pinnedStore ? `${Glyphs.ellipsis} ` : ''}
              {pinnedUser.isInterjection && (
                <span
                  className="mr-1.5 inline-block rounded px-1 py-0.5 text-[11px] font-medium leading-none select-none"
                  style={{
                    backgroundColor: 'color-mix(in srgb, var(--color-gn-warning) 18%, transparent)',
                    color: 'var(--color-gn-warning)',
                  }}
                >
                  引导
                </span>
              )}
              {collapseUserText(pinnedUser.text, USER_COLLAPSED_MAX_LINES).text}
            </div>
            <PromptTime ts={pinnedUser.ts} className="top-[14.5px]" />
          </button>
        </div>
      )}
    </div>
  )
}
