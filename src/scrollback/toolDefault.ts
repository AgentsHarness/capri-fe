/**
 * 密度档下工具行的默认显示形态（纯逻辑）。
 *
 * 这是「新块」与密度搭配的唯一默认值来源：创建工具行、密度切换重排、预览
 * 资格判定都读这里，避免三处各写一套门槛。
 *
 * - detailed：编辑/命令行内展开（TUI Truncated，带 diff / 输出），探查类
 *   收成一行；探查类仍参与分组。
 * - compact-shells（diff focus）：编辑展示 diff，命令与探查类收成一行。
 * - compact-ungrouped / compact-grouped / compact-all-grouped：所有工具默认
 *   收成一行。
 *
 * 直连 bash（`!` 命令）不受密度影响，恒为 expanded，由调用方单独处理。
 */
import type { ToolCallDensity } from '../api/transport'
import { isEditToolKind, toolFamily } from '../theme/toolFamily'
import type { ToolDisplayMode } from './entryState'

export function toolDefaultDisplay(
  kindName: string | undefined,
  density: ToolCallDensity,
): ToolDisplayMode {
  if (density === 'detailed') {
    if (isEditToolKind(kindName) || toolFamily(kindName) === 'execute') {
      return 'truncated'
    }
    return 'collapsed'
  }
  if (density === 'compact-shells' && isEditToolKind(kindName)) {
    return 'truncated'
  }
  return 'collapsed'
}
