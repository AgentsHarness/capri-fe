import type { ReactNode, RefObject } from 'react'
import { ImagePlus, X } from 'lucide-react'
import { Glyphs } from '../../theme/glyphs'
import { useChatStore } from '../../store/chat'
import { COMPOSER_BODY_PAD_LEFT_PX, IMAGE_THUMB_CLASS } from '../../theme/layout'
import { IconGlyph } from '../ui/IconGlyph'
import { SlashMenu } from './SlashMenu'
import { FilePickerMenu } from './FilePickerMenu'
import { PromptHistoryMenu } from './PromptHistoryMenu'
import { chipOccurrenceAtCaret, pruneChips } from './pasteChips'
import type { HistoryItem } from './promptHistory'
import type { ComposerDraft } from './useComposerDraft'
import type { useSlashMenu } from './useSlashMenu'
import type { useAtPicker } from './useAtPicker'

type SlashState = ReturnType<typeof useSlashMenu>
type AtPickerState = ReturnType<typeof useAtPicker>

type ComposerPromptProps = {
  guest: boolean
  isTouch: boolean
  promptFocused: boolean
  borderColor: string
  captionColor: string
  prefixColor: string
  stashOn: boolean
  composerChromeRef: RefObject<HTMLDivElement | null>
  taRef: RefObject<HTMLTextAreaElement | null>
  imgPickRef: RefObject<HTMLInputElement | null>
  draft: ComposerDraft
  slash: SlashState
  at: AtPickerState
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  detectAtToken: (text: string, caret: number) => void
  histOpen: boolean
  histItems: HistoryItem[]
  histSel: number
  setHistSel: (sel: number) => void
  setHistOpen: (open: boolean) => void
  recallHistory: (item: HistoryItem) => void
  children?: ReactNode
}

/** Composer 输入框 chrome：浮层菜单、图片 chips、textarea 与粘贴预览。 */
export function ComposerPrompt({
  guest,
  isTouch,
  promptFocused,
  borderColor,
  captionColor,
  prefixColor,
  stashOn,
  composerChromeRef,
  taRef,
  imgPickRef,
  draft,
  slash,
  at,
  onKeyDown,
  onPaste,
  detectAtToken,
  histOpen,
  histItems,
  histSel,
  setHistSel,
  setHistOpen,
  recallHistory,
  children,
}: ComposerPromptProps) {
  const {
    text,
    setText,
    chips,
    setChips,
    focused,
    setFocused,
    imageChips,
    insertImageChips,
    expandChipAt,
    partiallyOverlapsChip,
    clampCaret,
    setCaretPos,
    shellMode,
    setShellMode,
    setPendingCaret,
    preview,
    previewLines,
  } = draft
  const {
    slashOpen,
    slashSelClamped,
    slashPhase,
    slashMatches,
    slashArgMatches,
    slashArgCommand,
    slashRowCount,
    slashLiteral,
    setSlashSel,
    slashEnter,
  } = slash
  const {
    atOpen,
    atQuery,
    fileSearch,
    atSel,
    setAtSel,
    pickAtMatch,
  } = at
  return (
        <div
          ref={composerChromeRef}
          className="relative rounded-[6px] border pt-[4px] pb-[4px] font-ui transition-colors"
          style={{ borderColor }}
          data-prompt-focused={promptFocused ? '1' : '0'}
          onMouseDown={(e) => {
            // Clicking chrome focuses the textarea on desktop (don't steal from buttons; skip on touch devices).
            if (guest || isTouch || (e.target as HTMLElement).closest('button, a')) return
            taRef.current?.focus()
          }}
        >
          {/* Prompt history recall panel (TUI ↑ on empty input) — 交互与
              斜杠/文件浮层对齐：行样式、位置计数、选中行随动、Enter/Tab 填入。
              列表顺序与 TUI 一致（最旧在顶、最新在底，histItems 已反转）。 */}
          {histOpen && histItems.length > 0 && (
            <PromptHistoryMenu
              history={histItems}
              selected={histSel}
              onHover={setHistSel}
              onPick={recallHistory}
            />
          )}
          {/* TUI slash menu — floats above the composer while the input
              starts with "/" (two phases: 命令 → 参数；↑/↓ + Enter/Tab pick). */}
          {slashOpen && (
            <SlashMenu
              input={text}
              selected={slashSelClamped}
              phase={slashPhase}
              matches={slashMatches}
              argMatches={slashArgMatches}
              argCommand={slashArgCommand}
              rowCount={slashRowCount}
              onHover={setSlashSel}
              onPick={(i) => {
                setSlashSel(i)
                slashEnter(i)
              }}
              onLiteral={() => {
                // Prepend the escape: `/xyz` → `\/xyz`, caret back at the
                // end, menu closes (the line no longer starts with "/").
                setText(`\\${text}`)
                setPendingCaret(text.length + 1)
                taRef.current?.focus()
              }}
            />
          )}
          {/* TUI @ file picker — floats above the composer while an `@`
              token is being typed (fuzzy file search; Enter/Tab inserts
              `@path ` over the token). Mutually exclusive with the slash
              menu (token detection is skipped while it's open). */}
          {atOpen && !slashOpen && (
            <FilePickerMenu
              query={atQuery}
              matches={fileSearch?.matches ?? []}
              done={fileSearch?.done ?? true}
              total={fileSearch?.total}
              selected={Math.min(atSel, Math.max(0, (fileSearch?.matches.length ?? 1) - 1))}
              onHover={setAtSel}
              onPick={pickAtMatch}
            />
          )}
          {/* Image chips — always-expanded thumbnails above the textarea
              (paste/drop lands here directly; X removes the image).
              pt clears the chrome's 4px top padding plus the remove button's
              -top-1.5 overflow so neither rides the border. */}
          {stashOn && (
            // TUI top-border caption: "Stashed" sits in the rule, right-aligned,
            // and the base fill blanks the border on either side of the word.
            <div
              className="pointer-events-none absolute -top-[6px] right-2 max-w-[75%] truncate px-1 text-[11px] leading-none"
              style={{ background: 'var(--color-gn-bg-base)', color: captionColor }}
              data-testid="prompt-stash"
            >
              Stashed
            </div>
          )}
          {imageChips.length > 0 && (
            <div className="flex flex-wrap items-start gap-2 px-3 pt-2.5 pb-1">
              {imageChips.map((c) => (
                <div key={c.id} className="group relative">
                  <img
                    src={`data:${c.image!.mimeType};base64,${c.image!.data}`}
                    alt={c.image!.name}
                    className={IMAGE_THUMB_CLASS}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setChips((cs) => cs.filter((x) => x.id !== c.id))
                    }
                    className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-gn-bg-dark text-gn-gray shadow transition-colors hover:text-gn-red"
                    title="移除图片"
                  >
                    <X size={10} strokeWidth={2.5} aria-hidden />
                  </button>
                  <div
                    className="w-20 truncate text-[9.5px] leading-tight text-gn-muted"
                    title={c.image!.name}
                  >
                    {c.image!.name}
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* ── Body: ❯ textarea ──
              The prompt frame has a 1px border, so the body inset must be
              ICON_COL_INSET - 1 for the ❯ box to land exactly on the
              scrollback icon track (matches the turn-status spinner). */}
          <div
            className="flex min-w-0 items-start gap-1.5 py-1 pr-3"
            style={{
              paddingLeft: COMPOSER_BODY_PAD_LEFT_PX - 1,
              // Unfocused dim (blend_area 0.66 toward bg) for content only
              opacity: promptFocused ? 1 : 0.72,
            }}
          >
              <span
                className="mt-[2px] shrink-0"
                style={{
                  color: shellMode
                    ? 'var(--color-gn-cyan)'
                    : prefixColor,
                }}
              >
                {shellMode ? (
                  // TUI shell prompt: `! ` prefix (cyan) — Enter sends the
                  // command to the agent as a prompt (`$ ` user row).
                  <span className="inline-flex w-[1.25em] items-center justify-center font-bold leading-none">
                    {'! '}
                  </span>
                ) : (
                  <IconGlyph glyph={Glyphs.promptArrow} color={prefixColor} />
                )}
              </span>
              <textarea
                id="composer-input"
                ref={taRef}
                rows={1}
                value={text}
                // 访客只读：禁用输入（disabled 连键盘事件都不派发），下面
                // 的处理器再各留一道守卫，避免以后把 disabled 换回 readOnly
                // 时粘贴/拖拽绕过受控值。
                disabled={guest}
                onChange={(e) => {
                  if (guest) return
                  const v = e.target.value
                  // TUI shell mode: typing `!` into an empty buffer enters
                  // shell mode — the `!` lives in the prefix, not the buffer.
                  if (!shellMode && v === '!' && text === '') {
                    setShellMode(true)
                    setHistOpen(false)
                    return
                  }
                  setText(v)
                  // Typing closes the recall panel (TUI buffer edit).
                  if (histOpen) setHistOpen(false)
                  // Slash filter changed → selection back to the top row.
                  setSlashSel(0)
                  // Keep chips in sync with the editable label text.
                  setChips((cs) => pruneChips(v, cs))
                  // @ token under the (post-edit) caret arms/closes the
                  // file picker — runs after every buffer edit.
                  detectAtToken(v, e.target.selectionStart ?? v.length)
                }}
                onFocus={() => {
                  if (guest) return
                  setFocused(true)
                  useChatStore.getState().setFocus('prompt')
                }}
                onBlur={() => setFocused(false)}
                onKeyDown={onKeyDown}
                onBeforeInput={(e) => {
                  if (guest) return
                  // IME / drag-drop inserts into a chip label are swallowed.
                  const el = taRef.current
                  if (!el) return
                  if (partiallyOverlapsChip(el.selectionStart, el.selectionEnd)) {
                    e.preventDefault()
                  }
                }}
                onPaste={(e) => {
                  if (guest) {
                    e.preventDefault()
                    return
                  }
                  onPaste(e)
                }}
                onDragOver={(e) => {
                  // Allow the drop so the browser doesn't navigate to the
                  // file (image drop → chip below).
                  e.preventDefault()
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (guest) return
                  const files = Array.from(e.dataTransfer.files).filter((f) =>
                    f.type.startsWith('image/'),
                  )
                  if (files.length === 0) {
                    // Non-image files: browsers cannot expose local paths
                    // (web limitation) — ignore rather than insert a
                    // broken reference. TUI takes a path here.
                    return
                  }
                  void insertImageChips(files)
                }}
                onSelect={() => {
                  // Mirror the live caret (selectionchange) for the preview.
                  const t = taRef.current
                  if (t) {
                    setCaretPos(t.selectionStart)
                    // Caret moves re-check the @ token (moving out of one
                    // closes the picker; moving within re-queries).
                    detectAtToken(text, t.selectionStart)
                  }
                }}
                onKeyUp={() => {
                  const t = taRef.current
                  if (t) setCaretPos(t.selectionStart)
                }}
                onMouseUp={() => {
                  // Click inside a chip label snaps to its nearest edge.
                  clampCaret('nearest')
                  const t = taRef.current
                  if (t) setCaretPos(t.selectionStart)
                }}
                onDoubleClick={(e) => {
                  // TUI: double-click expands a paste chip (from either position).
                  const t = taRef.current
                  if (!t) return
                  const at = chipOccurrenceAtCaret(text, chips, t.selectionStart)
                  if (at) {
                    e.preventDefault()
                    expandChipAt(at)
                  }
                }}
                title={
                  guest
                    ? '访客模式为只读，无法输入'
                    : chips.length > 0
                      ? 'enter / double-click / paste-again on a chip to expand'
                      : undefined
                }
                placeholder={
                  guest
                    ? '访客模式'
                    : shellMode
                      ? '发送命令给 agent（! 前缀）'
                      : // 占位提示只看真实焦点（focused），不看 store 的
                        // focusMode：后者默认就是 'prompt' 且失焦不清，
                        // 用它判断会导致「Build anything」几乎永远不显示。
                        focused
                        ? ''
                        : 'Build anything'
                }
                spellCheck={false}
                className="gn-no-scrollbar min-h-[20px] flex-1 resize-none bg-transparent font-ui text-[13.5px] leading-[1.55] text-gn-fg outline-none placeholder:text-gn-gray disabled:cursor-not-allowed touch-pan-y"
              />
              {slashLiteral && (
                // 转义生效的即时回执：这行不会被当命令执行，Enter 原样发出。
                <span className="mt-[3px] shrink-0 self-start rounded border border-gn-prompt-border-active px-1 font-mono text-[10px] leading-[14px] text-gn-muted">
                  原文发送
                </span>
              )}
              {/* 触控端选图入口：移动端系统剪贴板基本不携带图片数据
                  （粘贴拿不到 file），手机相册/相机只能靠文件选择器进入。
                  桌面端不渲染——那里粘贴与拖拽都直接可用。 */}
              {isTouch && !guest && (
                <button
                  type="button"
                  onClick={() => imgPickRef.current?.click()}
                  className="mt-[1px] flex h-6 w-6 shrink-0 items-center justify-center rounded text-gn-gray transition-colors hover:bg-gn-bg-highlight hover:text-gn-cyan"
                  aria-label="选择图片"
                  title="从相册或相机选择图片"
                >
                  <ImagePlus size={16} aria-hidden />
                </button>
              )}
            </div>

          {/* 选图入口的文件输入：同 QueueEditModal 的读文件路径
              （fileToDataUrl → insertImageChips）。清空 value 让同一张图
              可以被重复选择。 */}
          {isTouch && !guest && (
            <input
              ref={imgPickRef}
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                // accept 只是选择器的过滤建议（部分系统选择器会放行任意
                // 文件），这里再按 MIME 收一道。
                const files = Array.from(e.target.files ?? []).filter((f) =>
                  f.type.startsWith('image/'),
                )
                e.target.value = ''
                if (files.length > 0) void insertImageChips(files)
              }}
            />
          )}

          {children}
          {/* Paste preview overlay (TUI render_preview_overlay) — floats
              above the prompt frame while the caret is on/after a text
              chip: first/last 3 lines with a ⋮ separator + expand hint.
              Image chips are always expanded, so no preview is needed. */}
          {preview &&
            previewLines && (
              <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 w-[75%] -translate-x-1/2 gn-popover">
                <div className="gn-no-scrollbar max-h-44 overflow-y-auto py-0.5">
                  {previewLines.map((line, i) => (
                    <div
                      key={i}
                      className={`truncate px-2 font-mono text-[11.5px] leading-[1.5] ${
 line.startsWith('⋮ (')
                          ? 'text-gn-gray-dim'
                          : 'text-gn-fg'
                      }`}
                    >
                      {line || ' '}
                    </div>
                  ))}
                </div>
                <div className="border-t border-gn-prompt-border/60 px-2 py-[3px] text-[10px] text-gn-muted">
                  {preview.onChip ? 'enter' : 'paste again'} or double-click to
                  expand
                </div>
              </div>
            )}

        </div>
  )
}
