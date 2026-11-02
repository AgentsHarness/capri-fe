/**
 * Display-width estimates shared by tool-path painting (`scrollback/toolPaths`)
 * and user-prompt folding (`scrollback/userText`) — a hand-rolled approximation
 * of `unicode_width` (no dependency).
 *
 * Controls / zero-width format characters / combining marks count 0, East
 * Asian Wide/Fullwidth blocks and emoji count 2, everything else 1. Ambiguous
 * symbols (☀ ◆ …) stay 1: underestimating keeps text one column narrow rather
 * than wrapping a narrow glyph as wide.
 */

/** Width of one code point. */
export function codePointWidth(cp: number): number {
  // C0/C1 controls and zero-width format characters.
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 0
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff) return 0
  // Combining marks (Mn/Me blocks commonly seen in paths and names).
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x20d0 && cp <= 0x20f0) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) {
    return 0
  }
  // East Asian Wide/Fullwidth + emoji blocks.
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首～汉字/假名/Yi（含 CJK 标点）
    (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo Extended-A
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul 音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII / 半角片假名
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号（￥（）等）
    (cp >= 0x1f300 && cp <= 0x1f64f) || // Emoji：符号/表情
    (cp >= 0x1f680 && cp <= 0x1f6ff) || // Emoji：交通/设备
    (cp >= 0x1f900 && cp <= 0x1f9ff) || // Emoji：补充符号
    (cp >= 0x1fa70 && cp <= 0x1faff) || // Emoji：符号扩展-A
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B～F
  ) {
    return 2
  }
  return 1
}

/** Width of a single-code-point string (TUI `UnicodeWidthChar::width`). */
export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0)
  if (cp == null) return 0
  return codePointWidth(cp)
}

/** Width of a whole string, summed by code point (TUI `UnicodeWidthStr::width`). */
export function strWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch)
  return w
}
