import { useEffect, useRef, useState } from 'react'
import { Check, Copy, GitFork } from 'lucide-react'
import type { ScrollEntry } from '../../../api/types'
import { useChatStore } from '../../../store/chat'
import { mergeLiveText } from '../../../scrollback/liveText'
import { Markdown } from '../../Markdown'
import { EntryShell } from '../EntryShell'
import { InlineImages } from '../InlineImages'
import { PromptTime } from '../PromptTime'
import type { EntryChrome } from '../chrome'

/** 「已复制」反馈展示时长。 */
const COPY_FEEDBACK_MS = 1500

/** 渲染后的 markdown 块级结构检测：settle 未完成时 innerHTML 是纯文本，
 *  不带 text/html 项（富文本粘贴会得到无格式内容）。 */
const BLOCK_HTML_RE = /<(?:p|h[1-6]|pre|ul|ol|table|blockquote)\b/i

/** 剪贴板不可用（非安全上下文）/写入失败时的文本回退（同 Mermaid 复制）。 */
async function fallbackWriteText(text: string): Promise<void> {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
  } catch {
    /* ignore */
  } finally {
    document.body.removeChild(ta)
  }
}

export function AssistantEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'assistant' }>
  chrome: EntryChrome
}) {
  const { shell, liveText, onHeaderDblClick, openViewer, inMini } = chrome
  // liveText = liveStream delta/suffix for this entry only (not a full
  // replacement). Additive merge works for both store shapes:
  // entry.text '' + live full stream, or base + later chunks in liveStream.
  const displayText = mergeLiveText(e.text, liveText)
  // Prefer liveText presence for settle-on-flush; also keep plain-text
  // path while e.streaming (e.g. mid-tool after live cleared into entry).
  const streamActive = liveText != null || !!e.streaming

  // 渲染后的 markdown 容器：复制时取 innerHTML 作为 text/html 副本。
  const mdBoxRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (copyTimer.current != null) window.clearTimeout(copyTimer.current)
    },
    [],
  )
  const [forking, setForking] = useState(false)

  /** 复制：text/plain 带 markdown 原文，text/html 带渲染后内容——
   *  富文本编辑器粘贴得格式化结果，纯文本处粘贴得原文本。 */
  const copyMessage = async () => {
    if (copied) return
    const text = displayText
    try {
      const hasHtml =
        typeof ClipboardItem !== 'undefined' &&
        typeof navigator.clipboard?.write === 'function'
      if (hasHtml && mdBoxRef.current) {
        // 去除交互元素（mermaid 的操作按钮等），只留内容结构。
        const clone = mdBoxRef.current.cloneNode(true) as HTMLElement
        clone.querySelectorAll('button, script, style').forEach((n) => n.remove())
        const html = clone.innerHTML
        if (BLOCK_HTML_RE.test(html)) {
          await navigator.clipboard.write([
            new ClipboardItem({
              'text/html': new Blob([html], { type: 'text/html' }),
              'text/plain': new Blob([text], { type: 'text/plain' }),
            }),
          ])
          setCopied(true)
          copyTimer.current = window.setTimeout(
            () => setCopied(false),
            COPY_FEEDBACK_MS,
          )
          return
        }
      }
      // 无格式化结构 / 环境不支持多格式写入：退化为纯文本复制。
      await (navigator.clipboard?.writeText
        ? navigator.clipboard.writeText(text)
        : fallbackWriteText(text))
      setCopied(true)
      copyTimer.current = window.setTimeout(
        () => setCopied(false),
        COPY_FEEDBACK_MS,
      )
    } catch {
      await fallbackWriteText(text)
      setCopied(true)
      copyTimer.current = window.setTimeout(
        () => setCopied(false),
        COPY_FEEDBACK_MS,
      )
    }
  }

  /** Fork：派生当前会话副本（与 /fork 同一动作；宿主不支持按消息截断，
   *  副本含会话全部历史，消息按钮只是把入口放到了回复下方）。 */
  const forkMessage = () => {
    if (forking) return
    setForking(true)
    void useChatStore.getState().forkSession().finally(() => setForking(false))
  }

  const rowBtn =
    'inline-flex h-6 items-center gap-1 rounded border border-transparent px-1.5 text-[11px] transition-colors'
  const hasContent = displayText.trim() !== '' || (e.images?.length ?? 0) > 0
  // 操作行只跟选中态走：点选任意 assistant 消息即显示，取消选中即隐藏；
  // 流式期间不显示；迷你 scrollback 只留复制（fork 作用于主会话，
  // 弹窗内不提供）。
  const showActions = !streamActive && hasContent && shell.selected
  return (
    <EntryShell {...shell}>
      {/* Reserve the short-form time's width (TUI ts_reserved=10 cols; sm:
          only — the time itself is hidden on mobile) so text never runs
          under it; the hover expansion still overlays content by design. */}
      <div
        className="group relative min-w-0 sm:pr-9"
        title="dblclick / enter · view"
        onDoubleClick={(ev) => {
          ev.stopPropagation()
          ev.preventDefault()
          onHeaderDblClick()
        }}
      >
        <div ref={mdBoxRef} className="min-w-0">
          <Markdown source={displayText} streaming={streamActive} />
        </div>
        {/* Agent-embedded images render below the text. */}
        {e.images?.length ? (
          <div className="mt-1.5">
            <InlineImages
              images={e.images}
              size="assistant"
              onOpen={() => openViewer(e.id)}
            />
          </div>
        ) : null}
        {/* 消息操作行：默认仅每轮最后一条 assistant 常显（中间消息选中
            才显）；流式期间不显示；迷你 scrollback 只留复制（fork 作用于
            主会话，弹窗内不提供）。点击/双击不落到行选中/查看器。 */}
        {showActions && (
          <div
            className="mt-1.5 flex flex-wrap items-center gap-1"
            onClick={(ev) => ev.stopPropagation()}
            onDoubleClick={(ev) => {
              ev.stopPropagation()
              ev.preventDefault()
            }}
          >
            <button
              type="button"
              onClick={() => void copyMessage()}
              disabled={copied}
              title="复制消息（原文 + 格式化后）"
              className={`${rowBtn} ${
                copied
                  ? 'cursor-default text-gn-teal'
                  : 'text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg'
              }`}
            >
              {copied ? (
                <Check size={11} strokeWidth={2.5} aria-hidden />
              ) : (
                <Copy size={11} strokeWidth={2} aria-hidden />
              )}
              {copied ? '已复制' : '复制'}
            </button>
            {!inMini && (
              <button
                type="button"
                onClick={forkMessage}
                disabled={forking}
                title="派生当前会话副本（/fork）"
                className={`${rowBtn} text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <GitFork size={11} strokeWidth={2} aria-hidden />
                {forking ? 'Fork 中…' : 'Fork'}
              </button>
            )}
          </div>
        )}
        {/* TUI right-aligned message time; tool/thought blocks get none.
            Hidden on mobile (sm: = desktop), unlike user prompt times. */}
        <PromptTime ts={e.ts} className="top-[3.5px] hidden sm:inline" />
      </div>
    </EntryShell>
  )
}
