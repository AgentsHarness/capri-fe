/**
 * UserPromptBlock 文本折叠（TUI user_prompt.rs wrap_prompt_lines 同款）。
 * 主 scrollback 与子代理弹窗的 sticky prompt header 共用——独立成模块，
 * 避免组件文件导出非组件函数破坏 fast-refresh（react/only-export-components）。
 */
import { Glyphs } from '../theme/glyphs'

/** UserPromptBlock COLLAPSED_MAX_LINES. */
export const USER_COLLAPSED_MAX_LINES = 3

/** Conservative content width for foldability estimate (TUI MIN_CONTENT_WIDTH). */
export const USER_MIN_CONTENT_WIDTH = 60

/**
 * Estimate visual line count for a user prompt (wrap-aware, matches TUI
 * UserPromptBlock::is_foldable).
 */
export function userVisualLines(text: string): number {
  let visual = 0
  const lines = text.split('\n')
  for (const line of lines) {
    const w = line.length
    visual += w === 0 ? 1 : Math.ceil(w / USER_MIN_CONTENT_WIDTH)
  }
  return visual || 1
}

/** TUI UserPromptBlock::is_foldable. */
export function userIsFoldable(text: string): boolean {
  return userVisualLines(text) > USER_COLLAPSED_MAX_LINES
}

/**
 * Collapse user text to at most max visual lines, appending " …" when truncated
 * (UserPromptBlock::wrap_prompt_lines with max_lines).
 */
export function collapseUserText(
  text: string,
  maxLines: number,
): { text: string; truncated: boolean } {
  const logical = text.split('\n')
  const out: string[] = []
  let visual = 0
  for (let i = 0; i < logical.length; i++) {
    const line = logical[i]
    const w = line.length
    const need = w === 0 ? 1 : Math.ceil(w / USER_MIN_CONTENT_WIDTH)
    if (visual + need > maxLines) {
      const remaining = maxLines - visual
      if (remaining <= 0) {
        // Mark last line with ellipsis
        if (out.length > 0) {
          const last = out[out.length - 1]
          out[out.length - 1] = last.replace(/\s*$/, '') + ' ' + Glyphs.ellipsis
        } else {
          out.push(Glyphs.ellipsis)
        }
        return { text: out.join('\n'), truncated: true }
      }
      // Fit head of this line into remaining visual rows, leave room for " …"
      const chars = remaining * USER_MIN_CONTENT_WIDTH
      const head = line.slice(0, Math.max(1, chars - 2)).replace(/\s+$/, '')
      out.push(head + ' ' + Glyphs.ellipsis)
      return { text: out.join('\n'), truncated: true }
    }
    out.push(line)
    visual += need
  }
  return { text: out.join('\n'), truncated: false }
}
