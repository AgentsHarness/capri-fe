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
 * 单个码位的显示宽度估算（TUI 折行按 unicode 显示宽度计，`line.length`
 * 会把 CJK/全角/Emoji 系统性低估一半）。East Asian Wide/Fullwidth 与常见
 * Emoji 区段记 2 列，其余记 1 列——手写区间判断，不引依赖；宽度歧义
 * （Ambiguous，如 ☀ ◆ 等符号）按 1 计，宁可少算宽度（少折一行）也不把
 * 窄符号按宽算。
 */
function charWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首～汉字/假名/Yi（含 CJK 标点）
    (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo Extended-A
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul 音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
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

/** 一行文本的显示列宽（按码位累加，宽字符记 2）。 */
function lineWidth(line: string): number {
  let w = 0
  for (const ch of line) w += charWidth(ch.codePointAt(0) ?? 0)
  return w
}

/** 截断到 maxCols 显示列宽内的前缀（宽字符整体不切半）。 */
function sliceToWidth(line: string, maxCols: number): string {
  let w = 0
  let end = 0
  for (const ch of line) {
    const cw = charWidth(ch.codePointAt(0) ?? 0)
    if (w + cw > maxCols) break
    w += cw
    end += ch.length
  }
  return line.slice(0, end)
}

/**
 * Estimate visual line count for a user prompt (wrap-aware, matches TUI
 * UserPromptBlock::is_foldable).
 */
export function userVisualLines(text: string): number {
  let visual = 0
  const lines = text.split('\n')
  for (const line of lines) {
    const w = lineWidth(line)
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
    const w = lineWidth(line)
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
      // （按显示列宽截，宽字符整体不切半；' …' 留 2 列。）
      const cols = remaining * USER_MIN_CONTENT_WIDTH
      const head = sliceToWidth(line, Math.max(1, cols - 2)).replace(/\s+$/, '')
      out.push(head + ' ' + Glyphs.ellipsis)
      return { text: out.join('\n'), truncated: true }
    }
    out.push(line)
    visual += need
  }
  return { text: out.join('\n'), truncated: false }
}
