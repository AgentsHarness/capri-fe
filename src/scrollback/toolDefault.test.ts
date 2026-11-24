// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { toolDefaultDisplay } from './toolDefault'

describe('toolDefaultDisplay', () => {
  it('detailed：编辑/命令行内展开，探查类折叠', () => {
    expect(toolDefaultDisplay('edit', 'detailed')).toBe('truncated')
    expect(toolDefaultDisplay('write', 'detailed')).toBe('truncated')
    expect(toolDefaultDisplay('execute', 'detailed')).toBe('truncated')
    for (const kindName of ['read', 'search', 'list_dir', 'mcp']) {
      expect(toolDefaultDisplay(kindName, 'detailed')).toBe('collapsed')
    }
  })

  it('diff focus：编辑行内截断，命令与探查类折叠', () => {
    expect(toolDefaultDisplay('edit', 'compact-shells')).toBe('truncated')
    expect(toolDefaultDisplay('write', 'compact-shells')).toBe('truncated')
    expect(toolDefaultDisplay('execute', 'compact-shells')).toBe('collapsed')
    expect(toolDefaultDisplay('read', 'compact-shells')).toBe('collapsed')
  })

  it('balanced 起：所有工具默认折叠', () => {
    for (const density of [
      'compact-ungrouped',
      'compact-grouped',
      'compact-all-grouped',
    ] as const) {
      for (const kindName of ['read', 'edit', 'execute', 'mcp']) {
        expect(toolDefaultDisplay(kindName, density)).toBe('collapsed')
      }
    }
  })
})
