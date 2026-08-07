import { useCallback, useEffect, useState } from 'react'
import { useChatStore } from '../store/chat'
import { Glyphs } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'

/**
 * Cancel-turn panel — web counterpart of the TUI CancelTurnPanel.
 *
 * Opens on Esc / [stop] while a turn is running (instead of cancelling
 * immediately). While open it is a blocking card that owns the keyboard:
 *
 *   1–4             confirm that option directly
 *   ↑/↓ or j/k      move the selection
 *   Tab/Shift+Tab   walk the options, wrapping
 *   Enter           confirm the focused option
 *   Esc             option 4 — keep everything running (never a dead end)
 *
 * Options (TUI semantics, deduplicated so all four are distinct):
 *   1 取消当前回合          — cancel(); background tasks / subagents /
 *                            the send queue keep running
 *   2 取消回合并停止后台任务  — cancel() + killTask × running bg_tasks
 *                            (incl. restored top-strip tasks) +
 *                            cancelSubagent × running subagents
 *   3 取消回合并清空发送队列  — cancel() + clear the composer queue
 *   4 继续运行              — close the panel, nothing is cancelled
 *
 * The permission card takes keyboard priority while a request is pending
 * (TUI: permission prompt > cancel-turn panel > question card).
 */
const CANCEL_OPTIONS = [
  { label: '取消当前回合', desc: '后台任务、子代理与发送队列继续运行' },
  { label: '取消回合并停止全部后台任务', desc: '对每个运行中的后台任务 killTask，子代理 cancelSubagent' },
  { label: '取消回合并清空发送队列', desc: '仅清空本端已排队的后续提示词' },
  { label: '继续运行', desc: '关闭面板，不取消任何内容' },
] as const

export function CancelPanel() {
  const open = useChatStore((s) => s.cancelPanelOpen)
  const closeCancelPanel = useChatStore((s) => s.closeCancelPanel)
  const cancelTurn = useChatStore((s) => s.cancelTurn)
  const [sel, setSel] = useState(0)

  // Selection resets whenever the panel (re)opens.
  useEffect(() => {
    setSel(0)
  }, [open])

  const pick = useCallback(
    (i: number) => {
      if (i === 0) void cancelTurn({})
      else if (i === 1) void cancelTurn({ stopTasks: true })
      else if (i === 2) void cancelTurn({ clearQueue: true })
      else closeCancelPanel()
    },
    [closeCancelPanel, cancelTurn],
  )

  // Keyboard ownership while open: capture + stopImmediatePropagation so
  // nothing behind the panel (scrollback keys, composer, question modal)
  // sees a key. Every unmodified key is swallowed — blocking card.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      const st = useChatStore.getState()
      // Fullscreen block viewer owns keys while open.
      if (st.viewerEntryId || st.viewerTask) return
      // Permission card has keyboard priority (TUI ordering).
      if (st.pending.length > 0) return
      // Browser chords (Cmd/Ctrl/Alt) pass through untouched.
      if (e.metaKey || e.altKey) return
      if (e.ctrlKey) {
        e.stopImmediatePropagation()
        return
      }
      e.preventDefault()
      e.stopImmediatePropagation()
      switch (e.key) {
        case 'ArrowUp':
        case 'k':
          setSel((s) => Math.max(0, s - 1))
          break
        case 'ArrowDown':
        case 'j':
          setSel((s) => Math.min(CANCEL_OPTIONS.length - 1, s + 1))
          break
        case 'Tab': {
          const dir = e.shiftKey ? -1 : 1
          setSel(
            (s) => (s + dir + CANCEL_OPTIONS.length) % CANCEL_OPTIONS.length,
          )
          break
        }
        case 'Enter':
          pick(sel)
          break
        case 'Escape':
          // TUI: Esc = keep everything running (option 4).
          closeCancelPanel()
          break
        default:
          if (/^[1-4]$/.test(e.key)) pick(Number(e.key) - 1)
          break // swallow — blocking card
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, sel, pick, closeCancelPanel])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-label="取消回合"
    >
      <div className="w-full max-w-[480px] rounded border border-gn-prompt-border-active bg-gn-bg-base shadow-2xl">
        <header className="flex items-center gap-2 rounded-t border-b border-gn-prompt-border bg-gn-bg-dark px-4 py-2.5">
          <span className="text-gn-yellow" aria-hidden>
            <IconGlyph glyph={Glyphs.diamondFilled} color="currentColor" />
          </span>
          <span className="text-[13px] font-bold text-gn-fg">取消回合</span>
          <span className="ml-auto text-[11px] text-gn-muted">
            esc 继续运行
          </span>
        </header>

        <div className="flex flex-col gap-1.5 px-4 py-4">
          {CANCEL_OPTIONS.map((opt, i) => (
            <button
              key={i}
              type="button"
              onMouseEnter={() => setSel(i)}
              onClick={() => pick(i)}
              className={`flex min-h-10 items-start gap-2.5 rounded border px-3 py-2 text-left transition-colors ${
                i === sel
                  ? 'border-gn-yellow/60 bg-gn-bg-highlight text-gn-fg'
                  : 'border-gn-prompt-border text-gn-fg2 hover:bg-gn-bg-highlight'
              }`}
            >
              <span
                className={`mt-[1px] shrink-0 font-mono text-[11px] ${
                  i === sel ? 'text-gn-yellow' : 'text-gn-gutter'
                }`}
                aria-hidden
              >
                {i + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-[12.5px]">{opt.label}</span>
                <span className="block text-[11px] text-gn-muted">
                  {opt.desc}
                </span>
              </span>
            </button>
          ))}
        </div>

        <footer className="border-t border-gn-prompt-border px-4 py-2.5 text-[11px] text-gn-muted">
          1-4 / ↑↓ 选择 · Enter 确认 · Esc 继续运行
        </footer>
      </div>
    </div>
  )
}
