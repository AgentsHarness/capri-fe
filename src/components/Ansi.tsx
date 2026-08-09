import { useMemo } from 'react'
import Convert from 'ansi-to-html'

/**
 * Shared ANSI/VT → styled-text renderer for terminal/command output.
 *
 * Wraps `ansi-to-html` (the battle-tested ANSI→HTML converter) so every
 * command-output surface (scrollback `!` / `run` results, the block viewer,
 * the terminal panel) renders colors / bold / underline the same way instead
 * of hand-rolling highlight logic or stripping the codes to plain text.
 *
 * `escapeXML` is on so raw `<`, `>`, `&` in the output can never inject
 * markup (XSS-safe); only the library's own `color:…` spans are added.
 * `newline: false` keeps `\n` literal — the surrounding container is
 * `whitespace-pre-wrap`, so line breaks render as-is.
 *
 * ansi-to-html only knows CSI (`ESC[…`) sequences — it does NOT handle OSC
 * (`ESC]…BEL|ESC\` — window title / icon name / cwd / hyperlinks, emitted
 * by shells like zsh/oh-my-zsh on every prompt). Its catch-all eats the
 * ESC byte and leaks the payload as literal text (`]2;~/ccwork/acp-fe` …).
 * We pre-strip everything it cannot render (OSC/DCS/APC/PM, charset
 * designations, single-char ESC commands, and CSI that does NOT end in `m`
 * — cursor moves / erases / private modes carry no color info), while
 * KEEPING SGR `…m` color sequences for the converter.
 */
const ansi = new Convert({ fg: '#d4d4d4', bg: 'transparent', escapeXML: true })

// Escape-text `\xNN` (no raw control bytes — V8's RegExp silently drops
// raw ESC/BEL embedded in pattern strings).
const PRE_STRIP = new RegExp(
  `\\x1b\\][^\\x1b\\x07]*(?:\\x07|\\x1b\\\\)?` + // OSC: ESC] payload (BEL|ESC\) — optional terminator (truncated chunks)
    `|\\x1b[P_^][^\\x1b\\x07]*(?:\\x07|\\x1b\\\\)?` + // DCS / APC / PM
    `|\\x1b\\[[0-9;:?>=]*[^0-9;:?>=m]` + // CSI NOT ending in m (cursor/erase/private `?25l`…)
    `|\\x1b[()][0-9A-Za-z]` + // charset designation
    `|\\x1b[78=EDHMZc]`, // single-char ESC commands (save/restore cursor, keypad, …)
  'g',
)

export function Ansi({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => ansi.toHtml(text.replace(PRE_STRIP, '')), [text])
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />
}
