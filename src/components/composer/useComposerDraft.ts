import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type RefObject,
} from 'react'
import {
  chipId,
  chipOccurrenceAt,
  contentLines,
  fileToDataUrl,
  normalizeCr,
  pasteChipLabel,
  utf8Len,
  CHIP_DISPLAY_BYTES,
  CHIP_MIN_LINES,
  type PasteChip,
} from './pasteChips'
import { buildComposerBlocks } from '../../lib/composerBlocks'
import { useChatStore } from '../../store/chat'

type ComposerDraftOptions = {
  taRef: RefObject<HTMLTextAreaElement | null>
  guest: boolean
  isTouch: boolean
}

/**
 * Composer 草稿状态：文本、paste chips、光标位置，以及粘贴 / 图片插入 /
 * chip 原子编辑与粘贴预览浮层所需的全部纯交互逻辑。
 */
export type ComposerDraft = ReturnType<typeof useComposerDraft>

export function useComposerDraft({ taRef, guest, isTouch }: ComposerDraftOptions) {
  const focusMode = useChatStore((s) => s.focusMode)
  const [text, setText] = useState('')
  const [chips, setChips] = useState<PasteChip[]>([])
  const [focused, setFocused] = useState(false)
  // Pending caret position to restore after a programmatic text edit —
  // state (not a ref) so the restore effect runs on the post-edit render.
  const [pendingCaret, setPendingCaret] = useState<number | null>(null)
  // Live caret position — textarea selection changes don't re-render, so
  // onSelect/keyup/mouseup mirror it here for the paste preview overlay.
  const [caretPos, setCaretPos] = useState(0)
  const [shellMode, setShellMode] = useState(false)
  /** Counter for clipboard images without a filename (TUI `[Image #N]`). */
  const unnamedImgRef = useRef(0)

  /**
   * Add pasted/dropped files as always-expanded image chips — the
   * thumbnail row above the textarea, no `[Image: …]` label in the
   * buffer. The label only names the chip (alt text / history); the
   * queued row renders its images from the wire blocks instead.
   */
  const insertImageChips = async (files: File[]) => {
    const newChips: PasteChip[] = []
    for (const f of files) {
      try {
        const { data, mimeType } = await fileToDataUrl(f)
        const name = f.name.trim() || String(++unnamedImgRef.current)
        newChips.push({
          id: chipId(),
          label: `[Image: ${name}]`,
          content: '',
          image: { data, mimeType, name, size: f.size },
        })
      } catch {
        // Unreadable file — skip (rare).
      }
    }
    if (newChips.length === 0) return
    setChips((cs) => [...cs, ...newChips])
  }


  /** Inline a chip's stashed content at its label range (TUI expand_element).
   *  Image chips never carry a label in the buffer — they are always
   *  expanded as thumbnails and removed with the X button instead. */
  const expandChipAt = (at: { chip: PasteChip; start: number; end: number }) => {
    setText((t) => t.slice(0, at.start) + at.chip.content + t.slice(at.end))
    setChips((cs) => cs.filter((c) => c.id !== at.chip.id))
    setPendingCaret(at.start + at.chip.content.length)
  }


  /**
   * True when [start,end) touches a chip label without fully covering it —
   * an edit that would corrupt the label. A selection fully covering a chip
   * is fine: the whole element goes (TUI expands selections to element
   * boundaries, so partial selections are widened, never half-edited).
   */
  const partiallyOverlapsChip = (start: number, end: number) =>
    chips.some((c) => {
      if (c.image) return false // image chips are not text-anchored
      let from = 0
      for (;;) {
        const i = text.indexOf(c.label, from)
        if (i === -1) return false
        const e2 = i + c.label.length
        if (start < e2 && end > i && !(start <= i && end >= e2)) return true
        from = e2
      }
    })


  /**
   * TUI handle_paste port: short pastes fall through to the native inline
   * insert; at/above the chip threshold the text is replaced by an atomic
   * `[Pasted: …]` label and the content is stashed until expand/submit.
   * Pasting a chip's exact content again with the cursor right after it
   * expands it instead of duplicating (repaste-to-expand).
   */
  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    // Image paste: clipboard items with image/* types (screenshots,
    // copied images) become always-expanded thumbnails above the
    // textarea — no `[Image: …]` label enters the buffer. When images
    // are present they win over any coexisting text (browser copies
    // often carry both).
    const imageFiles: File[] = []
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) imageFiles.push(f)
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault()
      void insertImageChips(imageFiles)
      return
    }
    const raw = e.clipboardData.getData('text')
    if (!raw) return // empty / image paste → native no-op
    const cleaned = normalizeCr(raw)
    const el = taRef.current
    if (!el) return
    const start = el.selectionStart
    const end = el.selectionEnd
    if (start === end) {
      const at = chipOccurrenceAt(text, chips, start, 'end')
      if (at && cleaned === at.chip.content) {
        e.preventDefault()
        expandChipAt(at)
        return
      }
    }
    if (
      contentLines(cleaned) < CHIP_MIN_LINES &&
      utf8Len(cleaned) <= CHIP_DISPLAY_BYTES
    ) {
      return // short paste → native inline insert
    }
    e.preventDefault()
    const label = pasteChipLabel(cleaned)
    setText((t) => t.slice(0, start) + label + t.slice(end))
    setChips((cs) => [...cs, { id: chipId(), label, content: cleaned }])
    setPendingCaret(start + label.length)
  }


  /**
   * Push the caret out of any chip interior (TUI: chips are atomic blocks,
   * the caret never renders inside them — it sits on the start or end edge).
   * Directional moves clamp toward the edge they came from; clicks clamp to
   * the nearest edge.
   */
  const clampCaret = (dir: 'start' | 'end' | 'nearest') => {
    const el = taRef.current
    if (!el || el.selectionStart !== el.selectionEnd) return
    const inside = chipOccurrenceAt(text, chips, el.selectionStart, 'inside')
    if (!inside) return
    const pos = el.selectionStart
    const target =
      dir === 'start'
        ? inside.start
        : dir === 'end'
          ? inside.end
          : pos - inside.start <= inside.end - pos
            ? inside.start
            : inside.end
    el.setSelectionRange(target, target)
    setCaretPos(target)
  }


  // 访客只读：输入框永远不呈现聚焦态（store 的 focusMode 默认就是
  // 'prompt'，不能让它把访客的边框点亮）。
  const promptFocused = guest
    ? false
    : isTouch
      ? focused
      : focused || focusMode === 'prompt'

  /**
   * Paste preview overlay (TUI render_preview_overlay + paste_preview_hint):
   * show the stashed content while the caret is on (start edge) or right
   * after (end edge) a chip, prompt focused. On-chip wins over adjacent.
   */
  const preview = useMemo(() => {
    if (!promptFocused || chips.length === 0) return null
    for (const chip of chips) {
      if (chip.image) continue // image chips are always expanded, never in text
      let from = 0
      for (;;) {
        const start = text.indexOf(chip.label, from)
        if (start === -1) break
        if (caretPos === start) return { chip, onChip: true }
        from = start + chip.label.length
      }
    }
    for (const chip of chips) {
      if (chip.image) continue
      let from = 0
      for (;;) {
        const start = text.indexOf(chip.label, from)
        if (start === -1) break
        if (caretPos === start + chip.label.length) {
          return { chip, onChip: false }
        }
        from = start + chip.label.length
      }
    }
    return null
  }, [text, chips, caretPos, promptFocused])

  // Preview content: first/last 3 lines with a dots separator when longer
  // (PreviewConfig.preview_lines = 3).
  const previewLines = useMemo(() => {
    if (!preview) return null
    const lines = preview.chip.content.split('\n')
    if (lines.length <= 6) return lines
    return [
      ...lines.slice(0, 3),
      `⋮ (${lines.length - 6} more lines)`,
      ...lines.slice(-3),
    ]
  }, [preview])


  // 输入框随内容增高，最高到半个视口（TUI PromptViewConfig
  // max_prompt_height 半视口增长）；超出部分在输入框内部滚动
  // （gn-no-scrollbar 隐藏滚动条，光标由原生 textarea 保持可见）。
  // 失焦不折叠（collapse_unfocused 保持移除），清空后回落单行。
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    const remeasure = () => {
      // Reset height first so scrollHeight reports the full content.
      el.style.height = 'auto'
      const max = Math.floor(window.innerHeight / 2)
      el.style.height = `${Math.min(el.scrollHeight, max)}px`
    }
    remeasure()
    window.addEventListener('resize', remeasure)
    return () => window.removeEventListener('resize', remeasure)
  }, [text, chips, taRef])

  // Restore the caret after a programmatic text edit (chip insert/expand).
  // Runs once per pending request (deps on pendingCaret) — the request is
  // set in the same batch as the text edit, so the textarea is up to date.
  useEffect(() => {
    const el = taRef.current
    if (!el || pendingCaret == null) return
    el.selectionStart = el.selectionEnd = pendingCaret
    setCaretPos(pendingCaret)
    setPendingCaret(null)
  }, [pendingCaret, taRef])


  /** Always-expanded image chips → thumbnail row above the textarea. */
  const imageChips = useMemo(() => chips.filter((c) => c.image), [chips])

  return {
    text,
    setText,
    chips,
    setChips,
    focused,
    setFocused,
    pendingCaret,
    setPendingCaret,
    caretPos,
    setCaretPos,
    shellMode,
    setShellMode,
    promptFocused,
    imageChips,
    buildBlocks: buildComposerBlocks,
    insertImageChips,
    expandChipAt,
    partiallyOverlapsChip,
    onPaste,
    clampCaret,
    preview,
    previewLines,
  }
}
