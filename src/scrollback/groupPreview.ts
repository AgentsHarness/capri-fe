/**
 * 新块预览的渲染补丁（纯逻辑）。
 *
 * 默认折叠的新工具块在停留窗口内先按行内截断正文显示（TUI Truncated），
 * 到点后撤销补丁、收回一行。补丁只影响渲染，不写回 store 的折叠状态：
 * 分组判定仍按条目原始的 collapsed 形态，否则预览中的块会变成 open 成员，
 * 永远不进组。
 *
 * 资格（是否在停留窗口内）由 scrollback/groupHold.ts 的 `previewToolIds`
 * 统一判定；这里只负责「能不能套补丁」：用户手动钉过的、已经展开的块不
 * 覆盖。默认展开的块在资格层就被排除了。
 */
import type { ScrollEntry } from '../api/types'
import { toolDisplayMode } from './entryState'

/** 新块预览的行内补丁（TUI Truncated，非全量正文）。 */
const TOOL_PREVIEW_PATCH: Partial<ScrollEntry> = {
  displayMode: 'truncated',
  expanded: true,
}

/**
 * 渲染补丁：只有「还没被用户手动折过、当前是折叠态」的预览候选才展开。
 * 返回值复用同一对象，保证 EntryView 的 memo 比较不会因每次渲染换引用
 * 而失效。
 */
export function groupPreviewPatch(
  e: ScrollEntry,
  preview: boolean,
): Partial<ScrollEntry> | undefined {
  if (!preview) return undefined
  if (e.kind === 'tool') {
    if (e.foldPinned || toolDisplayMode(e) !== 'collapsed') return undefined
    return TOOL_PREVIEW_PATCH
  }
  return undefined
}
