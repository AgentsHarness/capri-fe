import { useRef, useState } from 'react'
import { useChatStore } from '../../store/chat'
import { useScrollbarGutter } from '../../hooks/useScrollbarGutter'
import { Glyphs } from '../../theme/glyphs'
import { IconGlyph } from '../ui/IconGlyph'
import {
  COLUMN_PAD_X_CLASS,
  COMPOSER_BODY_PAD_LEFT_PX,
  CONTENT_COLUMN_CLASS,
} from '../../theme/layout'

/**
 * 弹窗底部 composer：与主页面 prompt 同一套 chrome——圆角 1px 边框
 * （未聚焦 prompt-border、聚焦 prompt-border-active）、❯ 落在与时间线
 * 相同的图标轨（CONTENT_COLUMN + COMPOSER_BODY_PAD_LEFT）、失焦正文
 * 整体减光 0.72（主 prompt 的 blend_area 同款）。子代理已结束时整块
 * 再减一档亮度表示不可用，边框不另换色。
 *
 * 当前无渲染点（见 SubagentView 里的说明），整块保留以备重接。
 * 保留就要付出未使用告警：noUnusedLocals 下 tsc -b 会报 TS6133，
 * 故导出一次（同文件内的自引用不消解该检查）。
 */
export function SubagentComposer({
  agentAddress,
  disabled,
}: {
  agentAddress: string
  disabled?: boolean
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // 与主 composer 同法：右留出滚动条槽宽度，输入框列才与上方时间线对齐
  // （时间线滚动容器用 scrollbar-gutter: stable 预留了同样的槽）。
  const gutterPx = useScrollbarGutter()
  const sendSubagentMessage = useChatStore((s) => s.sendSubagentMessage)

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const trimmed = text.trim()
      if (!trimmed || sending || !agentAddress) return
      setSending(true)
      sendSubagentMessage(agentAddress, trimmed)
        .then(() => {
          setText('')
        })
        .finally(() => {
          setSending(false)
        })
    }
  }

  const borderColor = focused
    ? 'var(--color-gn-prompt-border-active)'
    : 'var(--color-gn-prompt-border)'
  const prefixColor = focused
    ? 'var(--color-gn-accent-user)'
    : 'var(--color-gn-gray-dim)'

  return (
    <div
      className={`safe-pb shrink-0 bg-gn-bg-base pt-1 touch-pan-x overscroll-none ${
 disabled ? 'opacity-60' : ''
      }`}
      style={gutterPx ? { paddingRight: `${gutterPx}px` } : undefined}
    >
      <div className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS}`}>
        <div
          className="relative rounded-[6px] border pt-[4px] pb-[4px] font-ui transition-colors"
          style={{ borderColor }}
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest('button')) return
            inputRef.current?.focus()
          }}
        >
          <div
            className="flex min-w-0 items-start gap-1.5 py-1 pr-3"
            style={{
              paddingLeft: COMPOSER_BODY_PAD_LEFT_PX - 1,
              // 失焦减光 0.72（主 prompt 的 blend_area 同款）；禁用态由
              // 外层整块减光承担，避免两层叠加过暗。
              opacity: disabled || focused ? 1 : 0.72,
            }}
          >
            <span className="mt-[2px] shrink-0">
              <IconGlyph glyph={Glyphs.promptArrow} color={prefixColor} />
            </span>
            <input
              ref={inputRef}
              type="text"
              className="gn-no-scrollbar min-h-[20px] min-w-0 flex-1 bg-transparent font-ui text-[13.5px] leading-[1.55] text-gn-fg outline-none placeholder:text-gn-gray disabled:cursor-default"
              placeholder={disabled ? '子代理已结束' : '向子代理发送消息… (Enter 发送)'}
              value={text}
              disabled={disabled || sending || !agentAddress}
              onChange={(e) => setText(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={handleKeyDown}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
