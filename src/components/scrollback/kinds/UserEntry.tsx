import { RotateCw } from 'lucide-react'
import { useState } from 'react'
import type { ScrollEntry } from '../../../api/types'
import {
  USER_COLLAPSED_MAX_LINES,
  collapseUserText,
  userIsFoldable,
} from '../../../scrollback/userText'
import { entryExpanded } from '../../../scrollback/entryState'
import { Glyphs } from '../../../theme/glyphs'
import { Bullet, EntryShell } from '../EntryShell'
import { InlineImages } from '../InlineImages'
import { UserSteerTime } from '../PromptTime'
import { ViewButton } from '../ViewButton'
import { AnimatedCollapse } from '../../ui/AnimatedCollapse'
import { InlineAction } from '../../ui/InlineAction'
import { useChatStore } from '../../../store/chat'
import type { EntryChrome } from '../chrome'

export function UserEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'user' }>
  chrome: EntryChrome
}) {
  const { shell, toggleUser, openViewer, readonly = false } = chrome
  // 未送达重试：错误行在时间线末尾，而用户回头找的是自己那条 prompt，
  // 所以按钮也挂在这里。沿用原 promptId，host 侧同号去重，重发不会跑
  // 出第二个回合。
  const resend = useChatStore((s) => s.resendUndeliveredPrompt)
  const [resending, setResending] = useState(false)
  const onResend = () => {
    if (resending) return
    setResending(true)
    try {
      resend()
    } finally {
      setResending(false)
    }
  }
  // UserPromptBlock: full-width bg_light band, accent_user ❯ prefix
  // (RotateCw 图标 for is_cron scheduled /loop fires), continuation indent,
  // optional collapse to 3 visual lines + " …".
  const foldable = userIsFoldable(e.text)
  const expanded = entryExpanded(e)
  const showView = foldable && expanded
  const { text: body, truncated } = expanded
    ? { text: e.text, truncated: false }
    : collapseUserText(e.text, USER_COLLAPSED_MAX_LINES)
  // Selected prompts step up slightly (TUI selected → silver / stronger band)
  const band = shell.selected
    ? 'color-mix(in srgb, var(--color-gn-bg-highlight) 70%, var(--color-gn-bg-hover))'
    : 'var(--color-gn-bg-highlight)'
  const lines = body.split('\n')
  // TUI: is_bash → "$ " (command color), is_cron → RotateCw 图标, else prompt_arrow.
  // Shell-mode submissions carry the isShell marker from the store's send().
  const isShell = e.isShell === true
  const isInterjection = e.isInterjection === true
  const prefixGlyph = isShell ? '$' : Glyphs.promptArrow
  const prefixColor = isShell
    ? 'var(--color-gn-cyan)'
    : isInterjection
      ? 'var(--color-gn-warning)'
      : 'var(--color-gn-accent-user)'
  return (
    <EntryShell {...shell} bandBg={band}>
      <div className="relative">
      <button
        type="button"
        onClick={(ev) => {
          ev.stopPropagation()
          shell.onSelect()
          if (foldable) toggleUser(e.id)
        }}
        className="group relative flex w-full min-w-0 select-text items-start gap-1.5 py-[11px] text-left font-ui text-[13.5px] leading-[1.35]"
        title={
          isShell
            ? 'shell command · click fold · 查看 / enter view'
            : e.isCron
              ? 'scheduled task · click fold · 查看 / enter view'
              : isInterjection
                ? '引导 (steer) · click fold · 查看 / enter view'
                : foldable
                  ? 'click fold · 查看 / enter view'
                  : '查看 / enter view'
        }
      >
        {/* Same icon column as tool/thought bullets so ❯ / cron 图标 / ◆ / › line up.
            Icon box is 1.2em@13px = 15.6px; first text line is 13.5px×1.35 ≈ 18.2px.
            mt-[1.5px] centers prefix on the first line (items-start keeps multiline top-aligned). */}
        <Bullet
          color={prefixColor}
          glyph={prefixGlyph}
          icon={e.isCron ? <RotateCw size={13} strokeWidth={2} /> : undefined}
          className={`mt-[1.5px] ${isShell ? 'font-mono' : ''}`}
        />
        <div className="min-w-0 flex-1 text-gn-fg">
          <AnimatedCollapse open>
            {lines.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-words">
                {/* Icon sits in a sibling column (flex gap); continuations already
                    share the first line's text start — no extra indent (TUI uses
                    prefix-width spaces only when prefix is inline on each line). */}
                {line || (i < lines.length - 1 ? '\u00A0' : '')}
              </div>
            ))}
            {truncated && foldable && (
              <span className="sr-only"> (collapsed, expand with →)</span>
            )}
          </AnimatedCollapse>
        </div>
        <UserSteerTime ts={e.ts} steer={isInterjection} className="top-[14.5px]" />
      </button>
      {/* 重试按钮必须是外层 <button> 的兄弟：嵌在按钮里是非法嵌套，浏览器
          会重排 DOM 把两者拆开。放在行下方左对齐正文列——右上角是时间戳，
          右下角是 ViewButton，两个角落都已占用。 */}
      {e.undelivered && !readonly && (
        <div className="pb-1.5 pl-[22px]">
          <InlineAction
            label="重试"
            busyLabel="重试"
            busy={resending}
            title="Host 当时已离线，这条消息没有送达。重新发送（沿用原 promptId，已受理时不会重复执行）"
            onRun={onResend}
          />
        </div>
      )}
      <ViewButton
        visible={showView}
        compact
        onOpen={() => openViewer(e.id)}
        className="absolute right-1 bottom-2 z-[1]"
      />
      </div>
      {/* User-sent images (echoed back / attached): thumbnails under the
          prompt text, aligned with the text column (icon col + gap). */}
      {e.images?.length ? (
        <div className="pb-2 pl-[22px]">
          <InlineImages
            images={e.images}
            size="user"
            onOpen={() => openViewer(e.id)}
          />
        </div>
      ) : null}
    </EntryShell>
  )
}
