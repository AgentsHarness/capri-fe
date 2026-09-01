/** ── TUI paste-chip port (PromptWidget::handle_paste) ──────────────────
 * Pastes at/above the chip threshold become an atomic `[Pasted: N lines]`
 * element instead of inline text; the full content is stashed and only
 * materialized on expand (enter / double-click / paste-again) or submit.
 */
export const CHIP_MIN_LINES = 4 // TUI: 4, or 2 in compact mode (web has none)
export const CHIP_DISPLAY_BYTES = 10_000

/**
 * Paste chip = text paste chip; image chip = pasted/dropped image shown
 * as an always-expanded thumbnail above the textarea. Text chips share
 * the atomic-label mechanics (prune / caret clamp / whole-chip delete /
 * Enter expand); image chips are NOT text-anchored — no `[Image: …]`
 * label ever enters the buffer, their label is a display fallback only
 * (queue row text), and their data leaves as image ContentBlocks on
 * submit.
 */
export type PasteChip = {
  id: string
  label: string
  content: string
  /** Image chip: data goes out as an image block; no label in the buffer. */
  image?: { data: string; mimeType: string; name: string; size: number }
}

/** ── Image chips (paste / drop) ────────────────────────────────────── */
export function fileToDataUrl(
  file: File,
): Promise<{ data: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => {
      const url = typeof fr.result === 'string' ? fr.result : ''
      const comma = url.indexOf(',')
      if (comma === -1) {
        reject(new Error('unreadable image'))
        return
      }
      // "data:<mime>;base64,<payload>" → mime (payload keeps NO data: prefix,
      // matching the ContentBlock image contract).
      const mimeType = url.slice(5, comma).split(';')[0] || file.type || 'image/png'
      resolve({ data: url.slice(comma + 1), mimeType })
    }
    fr.onerror = () => reject(fr.error ?? new Error('image read failed'))
    fr.readAsDataURL(file)
  })
}

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

/** Bare \r → \n, leaving \r\n pairs intact (PromptWidget::normalize_cr). */
export function normalizeCr(text: string): string {
  return text.replace(/\r(?!\n)/g, '\n')
}

/** Content line count — Rust str::lines(): a trailing \n adds no line. */
export function contentLines(text: string): number {
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

export function utf8Len(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Chip label: `[Pasted: N lines]`, or byte size for >10 KB pastes. */
export function pasteChipLabel(cleaned: string): string {
  const bytes = utf8Len(cleaned)
  if (bytes > CHIP_DISPLAY_BYTES) {
    const size =
      bytes >= 1_000_000
        ? `${(bytes / 1_000_000).toFixed(1)} MB`
        : bytes >= 1000
          ? `${Math.floor(bytes / 1000)} KB`
          : `${bytes} bytes`
    return `[Pasted: ${size}]`
  }
  const n = contentLines(cleaned)
  return `[Pasted: ${n} line${n === 1 ? '' : 's'}]`
}

/** Text range of the chip occurrence containing `pos` (or ending at it).
 *  Image chips are not text-anchored and can never match. */
export function chipOccurrenceAt(
  text: string,
  chips: PasteChip[],
  pos: number,
  mode: 'inside' | 'end',
): { chip: PasteChip; start: number; end: number } | null {
  for (const chip of chips) {
    if (chip.image) continue
    let from = 0
    for (;;) {
      const start = text.indexOf(chip.label, from)
      if (start === -1) break
      const end = start + chip.label.length
      if (mode === 'inside' ? pos >= start && pos < end : pos === end) {
        return { chip, start, end }
      }
      from = end
    }
  }
  return null
}

/**
 * Chip occurrence the caret is on (start edge), inside, or right after
 * (end edge) — TUI paste_element_for_preview + double-click expansion.
 */
export function chipOccurrenceAtCaret(
  text: string,
  chips: PasteChip[],
  pos: number,
): { chip: PasteChip; start: number; end: number } | null {
  for (const chip of chips) {
    if (chip.image) continue
    let from = 0
    for (;;) {
      const start = text.indexOf(chip.label, from)
      if (start === -1) break
      const end = start + chip.label.length
      if (pos >= start && pos <= end) return { chip, start, end }
      from = end
    }
  }
  return null
}

/** Expand every text chip into its stashed content (submit path).
 *  Image chips never occupy text (no `[Image: …]` label in the buffer)
 *  — their data travels as ContentBlocks, so they are skipped here. */
export function expandChips(text: string, chips: PasteChip[]): string {
  let out = text
  for (const chip of chips) {
    if (chip.image) continue
    const idx = out.indexOf(chip.label)
    if (idx !== -1) {
      out = out.slice(0, idx) + chip.content + out.slice(idx + chip.label.length)
    }
  }
  return out
}

/**
 * Drop text chips whose label no longer appears in the text (user edits).
 * Occurrences are paired to chips in insertion order so a paste-then-edit
 * never leaves a stale chip that hijacks a later identical label. Image
 * chips are not text-anchored — they always survive edits and are
 * removed via the thumbnail row's X button.
 */
export function pruneChips(text: string, chips: PasteChip[]): PasteChip[] {
  const kept: PasteChip[] = []
  let pos = 0
  for (const chip of chips) {
    if (chip.image) {
      kept.push(chip)
      continue
    }
    const idx = text.indexOf(chip.label, pos)
    if (idx === -1) continue
    kept.push(chip)
    pos = idx + chip.label.length
  }
  return kept
}

export function chipId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `chip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
