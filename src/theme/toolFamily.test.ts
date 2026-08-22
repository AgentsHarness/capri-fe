import { describe, expect, it } from 'vitest'
import { isEditToolKind, isFlashEligible, toolFamily } from './toolFamily'

describe('toolFamily', () => {
  it('execute 系', () => {
    for (const k of ['execute', 'bash', 'shell', 'run', 'command', 'terminal', 'Execute']) {
      expect(toolFamily(k)).toBe('execute')
    }
  })

  it('read 系 → never', () => {
    for (const k of ['read', 'file', 'read_file', 'read_text_file', 'Read']) {
      expect(toolFamily(k)).toBe('never')
    }
  })

  it('search 系 → never', () => {
    for (const k of ['search', 'grep', 'glob', 'find', 'search_files', 'Search']) {
      expect(toolFamily(k)).toBe('never')
    }
  })

  it('list 系 → never', () => {
    for (const k of ['list_dir', 'listdir', 'ls', 'list', 'ListDir']) {
      expect(toolFamily(k)).toBe('never')
    }
  })

  it('edit 系 → edit', () => {
    for (const k of ['edit', 'write', 'create', 'delete', 'move', 'rename', 'apply_patch', 'str_replace', 'write_file']) {
      expect(toolFamily(k)).toBe('edit')
    }
  })

  it('其余 → standard；undefined 兜底', () => {
    expect(toolFamily('mcp')).toBe('standard')
    expect(toolFamily('web_search')).toBe('standard')
    expect(toolFamily('custom')).toBe('standard')
    expect(toolFamily(undefined)).toBe('standard')
  })
})

describe('isEditToolKind / isFlashEligible', () => {
  it('edit 家族判定', () => {
    expect(isEditToolKind('edit')).toBe(true)
    expect(isEditToolKind('write_file')).toBe(true)
    expect(isEditToolKind('read')).toBe(false)
    expect(isEditToolKind(undefined)).toBe(false)
  })

  it('tool / thought 可闪', () => {
    expect(isFlashEligible('tool')).toBe(true)
    expect(isFlashEligible('thought')).toBe(true)
    expect(isFlashEligible('user')).toBe(false)
  })
})