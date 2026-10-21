/**
 * Tool accent families — mirrors TUI BlockContent::accent per tool subtype
 * (read/search/list_dir never; edit optional; execute always; rest standard).
 */

export type ToolFamily =
  | 'execute' // always rail; success=green; collapsed dim ❙
  | 'never' // Read / Search / ListDir — no rail ever
  | 'edit' // default no rail (appearance.edit.accent unset)
  | 'standard' // Other / Web* / MCP / etc — rail only when expanded or running

/** Classify ACP tool `kind` into an accent family. */
export function toolFamily(kindName?: string): ToolFamily {
  const k = (kindName || 'other').toLowerCase().replace(/[\s-]+/g, '_')

  if (
    k === 'execute' ||
    k === 'bash' ||
    k === 'shell' ||
    k === 'run' ||
    k === 'command' ||
    k === 'terminal'
  ) {
    return 'execute'
  }

  if (k === 'read' || k === 'file' || k === 'read_file' || k === 'read_text_file') {
    return 'never'
  }

  if (
    k === 'search' ||
    k === 'grep' ||
    k === 'glob' ||
    k === 'find' ||
    k === 'search_files'
  ) {
    return 'never'
  }

  if (k === 'list_dir' || k === 'listdir' || k === 'ls' || k === 'list') {
    return 'never'
  }

  if (
    k === 'edit' ||
    k === 'write' ||
    k === 'create' ||
    k === 'delete' ||
    k === 'move' ||
    k === 'rename' ||
    k === 'apply_patch' ||
    k === 'str_replace' ||
    k === 'write_file'
  ) {
    return 'edit'
  }

  return 'standard'
}

/** Edit-family kinds (edit / write / create / …) — collapsed_edit_blocks. */
export function isEditToolKind(kindName?: string): boolean {
  return toolFamily(kindName) === 'edit'
}

/**
 * 编辑族里「新建文件」的子类（write / create …）。行头与聚合头用
 * `Creating` / `Created` 区分于就地修改的 `Edit` / `Edited`。
 */
export function isCreateToolKind(kindName?: string): boolean {
  const k = (kindName || '').toLowerCase().replace(/[\s-]+/g, '_')
  return (
    k === 'write' ||
    k === 'create' ||
    k === 'write_file' ||
    k === 'create_file' ||
    k === 'new_file'
  )
}
